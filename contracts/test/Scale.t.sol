// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";
import {AuctionEngine} from "../src/AuctionEngine.sol";
import {UniswapV3Adapter} from "../src/adapters/UniswapV3Adapter.sol";
import {MockToken, MockPositionManager, MockAdapter, MockLocker} from "./mocks/Mocks.sol";

/// @notice Scale evidence: one Degen round with hundreds or thousands of distinct bidders over ~300
///         price levels, settled in batches with the resumable `settle(roundId, maxSteps)`, then seeded,
///         claimed and swept. Every allocation and payment is checked against a reference computed
///         here from the raw bids (not against `quote()`, which shares the engine's code path), and
///         MON and tokens are reconciled to the wei.
///
///         Heavy, so skipped unless FOUNDRY_PROFILE=scale:
///           FOUNDRY_PROFILE=scale forge test --match-contract ScaleMockTest
///           FOUNDRY_PROFILE=scale forge test --match-contract ScaleForkTest --fork-url https://rpc1.monad.xyz
///         (SCALE_FORK_BIDDERS overrides the fork's bidder count, default 200.)
///
///         Gas is standard EVM gas as metered by forge: the call's execution gas from
///         `vm.lastFrameGas()` plus 21,000 intrinsic plus calldata (4/16 per zero/non-zero byte), before
///         refunds. Monad charges the gas limit and reprices cold state access, so treat these as
///         EVM-equivalent figures. USD uses the gas price and MON price quoted in SUBMISSION.md
///         (102 gwei, $0.0252, 24 Sep 2026).
abstract contract ScaleBase is Test {
    address constant BURN = 0x000000000000000000000000000000000000dEaD;
    uint256 constant LEVELS = 300; // price levels 1..300 ticks
    uint96 constant TICK = 0.001 ether;
    uint96 constant DEPOSIT = 31 ether; // > top price (0.3) × max amount (100 tokens)
    uint96 constant MIN_BID = 0.01 ether; // reserve (1 tick) × min amount (10 tokens)
    uint16 constant LP_BPS = 5000;
    uint256 constant LOCK_END = 4102444800;
    uint256 constant GRACE = 1 days;
    uint256 constant GAS_PRICE = 102 gwei;
    uint256 constant MON_USD_MICROS = 25_200; // $0.0252 per MON, in millionths of a dollar

    AuctionEngine engine;
    MockToken token;
    address adapterAddr;
    address creator = makeAddr("scale-creator");

    struct Bidder {
        address who;
        uint96 price;
        uint96 amount;
        bytes32 salt;
    }

    struct Ref {
        uint256 price;
        uint256 qtyAbove;
        uint256 qtyAt;
        bool over;
        uint256 levelsVisited; // settle loop iterations needed
        uint256 distinctLevels;
        uint256 winners;
        uint256 atPrice;
        uint256 losers;
    }

    struct Agg {
        uint256 n;
        uint256 min;
        uint256 max;
        uint256 sum;
    }

    struct Totals {
        uint256 paid;
        uint256 refunded;
        uint256 delivered;
        uint256 burnMonBefore;
        uint256 creatorMonBefore;
    }

    mapping(bytes32 => Agg) internal agg;
    bytes32[] internal aggKeys;
    uint256 internal findHintGasMax;

    function _scaleEnabled() internal view returns (bool) {
        return keccak256(bytes(vm.envOr("FOUNDRY_PROFILE", string("default")))) == keccak256("scale");
    }

    // ─── Bids ───────────────────────────────────────────────────────────

    function _bidders(uint256 n) internal pure returns (Bidder[] memory bs) {
        bs = new Bidder[](n);
        for (uint256 i; i < n; ++i) {
            uint256 h = uint256(keccak256(abi.encode("even.scale", i)));
            address who = address(uint160(uint256(keccak256(abi.encode("even.scale.bidder", i)))));
            uint96 price = uint96(TICK * (1 + h % LEVELS));
            // 10 to 100 tokens, with a fractional part so pro-rata and price × amount both round.
            uint96 amount = uint96(10e18 + (h >> 64) % 90e18);
            bs[i] = Bidder(who, price, amount, bytes32(h));
        }
    }

    /// Independent reference: P is the highest price at which cumulative demand from the top reaches
    /// the supply; if it never does, P is the lowest bid price and everything fills.
    function _reference(Bidder[] memory bs, uint256 supply) internal pure returns (Ref memory ref) {
        uint256[] memory qty = new uint256[](LEVELS + 1);
        for (uint256 i; i < bs.length; ++i) {
            qty[bs[i].price / TICK] += bs[i].amount;
        }
        uint256 cum;
        uint256 lowest;
        bool found;
        for (uint256 l = LEVELS; l > 0; --l) {
            if (qty[l] == 0) continue;
            ref.distinctLevels += 1;
            if (found) continue;
            ref.levelsVisited += 1;
            if (cum + qty[l] >= supply) {
                ref.price = l * TICK;
                ref.qtyAbove = cum;
                ref.qtyAt = qty[l];
                ref.over = cum + qty[l] > supply;
                found = true;
                continue;
            }
            cum += qty[l];
            lowest = l;
        }
        if (!found) {
            ref.levelsVisited += 1; // the iteration that reaches the end of the book
            ref.price = lowest * TICK;
            ref.qtyAt = qty[lowest];
            ref.qtyAbove = cum - qty[lowest];
        }
        for (uint256 i; i < bs.length; ++i) {
            if (bs[i].price > ref.price) ref.winners += 1;
            else if (bs[i].price == ref.price) ref.atPrice += 1;
            else ref.losers += 1;
        }
    }

    function _refAlloc(Ref memory ref, uint256 supply, Bidder memory b) internal pure returns (uint256) {
        if (b.price > ref.price) return b.amount;
        if (b.price < ref.price) return 0;
        if (!ref.over) return b.amount;
        return uint256(b.amount) * (supply - ref.qtyAbove) / ref.qtyAt;
    }

    function _mulDivUp(uint256 a, uint256 b, uint256 d) internal pure returns (uint256) {
        uint256 x = a * b;
        return x == 0 ? 0 : (x - 1) / d + 1;
    }

    // ─── Gas bookkeeping ────────────────────────────────────────────────

    function _txGas(bytes memory data) internal view returns (uint256 g) {
        g = vm.lastFrameGas().gasTotalUsed + 21_000;
        for (uint256 i; i < data.length; ++i) {
            g += data[i] == 0 ? 4 : 16;
        }
    }

    function _rec(string memory key, uint256 g) internal {
        Agg storage a = agg[keccak256(bytes(key))];
        if (a.n == 0) {
            aggKeys.push(keccak256(bytes(key)));
            a.min = g;
        }
        a.n += 1;
        a.sum += g;
        if (g < a.min) a.min = g;
        if (g > a.max) a.max = g;
    }

    function _row(string memory key) internal view {
        Agg storage a = agg[keccak256(bytes(key))];
        if (a.n == 0) return;
        console2.log(
            string.concat(
                _pad(key, 26),
                _padL(vm.toString(a.n), 6),
                _padL(vm.toString(a.min), 11),
                _padL(vm.toString(a.sum / a.n), 11),
                _padL(vm.toString(a.max), 11),
                _padL(vm.toString(a.sum), 13)
            )
        );
    }

    function _pad(string memory s, uint256 w) internal pure returns (string memory) {
        bytes memory b = bytes(s);
        if (b.length >= w) return s;
        bytes memory out = new bytes(w);
        for (uint256 i; i < w; ++i) {
            out[i] = i < b.length ? b[i] : bytes1(" ");
        }
        return string(out);
    }

    function _padL(string memory s, uint256 w) internal pure returns (string memory) {
        bytes memory b = bytes(s);
        if (b.length >= w) return string.concat(" ", s);
        bytes memory out = new bytes(w);
        for (uint256 i; i < w; ++i) {
            out[i] = i < w - b.length ? bytes1(" ") : b[i - (w - b.length)];
        }
        return string(out);
    }

    /// Cost in millionths of a dollar at the SUBMISSION.md gas and MON prices.
    function _usdMicros(uint256 gas) internal pure returns (uint256) {
        return gas * GAS_PRICE * MON_USD_MICROS / 1e18;
    }

    // ─── The round ──────────────────────────────────────────────────────

    function _open(uint128 supply) internal returns (uint256 r) {
        AuctionEngine.OpenParams memory p;
        p.preset = AuctionEngine.Preset.Degen;
        p.token = address(token);
        p.sellAmount = supply;
        p.depositAmount = DEPOSIT;
        p.minBidSize = MIN_BID;
        p.tickSize = TICK;
        p.reservePrice = TICK;
        p.commitEnd = uint64(block.timestamp + 1 hours);
        p.revealEnd = uint64(block.timestamp + 2 hours);
        p.lpShareBps = LP_BPS;
        p.dexSplits = new AuctionEngine.DexSplit[](1);
        p.dexSplits[0] = AuctionEngine.DexSplit({adapter: adapterAddr, bps: 10_000, fee: 3000});
        p.lockFeeTier = "DEFAULT";
        token.mint(creator, uint256(supply) * 2);
        vm.prank(creator);
        token.approve(address(engine), type(uint256).max);
        vm.prank(creator);
        r = engine.openRound(p);
    }

    function _run(uint256 n, uint128 supply, uint256 step) internal {
        Bidder[] memory bs = _bidders(n);
        uint256 r = _open(supply);
        AuctionEngine.Round memory rd = engine.getRound(r);

        _commitAll(r, bs);
        vm.warp(rd.commitEnd);
        _revealAll(r, bs);
        vm.warp(rd.revealEnd);

        Ref memory ref = _reference(bs, supply);
        uint256 calls = _settleAll(r, step);
        _checkClearing(r, ref, supply, calls, step);

        Totals memory t;
        t.burnMonBefore = BURN.balance;
        t.creatorMonBefore = creator.balance;

        engine.seedLP(r);
        _rec("seedLP", _txGas(abi.encodeCall(engine.seedLP, (r))));

        _claimAll(r, bs, ref, supply, t);

        vm.prank(creator);
        engine.withdrawProceeds(r);
        _rec("withdrawProceeds", _txGas(abi.encodeCall(engine.withdrawProceeds, (r))));
        engine.sweepDust(r);
        _rec("sweepDust", _txGas(abi.encodeCall(engine.sweepDust, (r))));

        _checkConservation(r, n, t);
        _print(n, ref, calls, step);
    }

    function _commitAll(uint256 r, Bidder[] memory bs) internal {
        bytes32[] memory proof = new bytes32[](0);
        for (uint256 i; i < bs.length; ++i) {
            Bidder memory b = bs[i];
            vm.deal(b.who, DEPOSIT);
            bytes32 h = keccak256(abi.encode(b.price, b.amount, b.salt, b.who));
            vm.prank(b.who);
            engine.commit{value: DEPOSIT}(r, h, proof, "");
            _rec("commit", _txGas(abi.encodeCall(engine.commit, (r, h, proof, ""))));
        }
    }

    /// Reveals in a fixed shuffled order. Each reveal is measured twice on the same state — once
    /// walking the book from the head, once with `findHint` — and the hinted one is kept.
    function _revealAll(uint256 r, Bidder[] memory bs) internal {
        uint256 n = bs.length;
        for (uint256 k; k < n; ++k) {
            Bidder memory b = bs[(k * 7919 + 13) % n];
            uint256 g0 = gasleft();
            uint256 hint = engine.findHint(r, b.price);
            uint256 hg = g0 - gasleft();
            if (hg > findHintGasMax) findHintGasMax = hg;

            uint256 snap = vm.snapshotState();
            vm.prank(b.who);
            engine.reveal(r, b.price, b.amount, b.salt);
            uint256 gNoHint = _txGas(abi.encodeCall(engine.reveal, (r, b.price, b.amount, b.salt)));
            vm.revertToStateAndDelete(snap); // also reverts this contract's storage, so record after
            _rec("reveal (no hint)", gNoHint);

            vm.prank(b.who);
            engine.revealWithHint(r, b.price, b.amount, b.salt, hint);
            _rec("revealWithHint", _txGas(abi.encodeCall(engine.revealWithHint, (r, b.price, b.amount, b.salt, hint))));
        }
    }

    function _settleAll(uint256 r, uint256 step) internal returns (uint256 calls) {
        bool done;
        while (!done) {
            done = engine.settle(r, step);
            _rec("settle (per call)", _txGas(abi.encodeCall(engine.settle, (r, step))));
            calls += 1;
            require(calls < 1000, "settle does not converge");
        }
    }

    function _checkClearing(uint256 r, Ref memory ref, uint256 supply, uint256 calls, uint256 step) internal view {
        (bool settled, uint256 price, uint256 sold,, bool over, uint256 totalQty, uint64 levelCount) =
            engine.clearingOf(r);
        assertTrue(settled, "settled");
        assertEq(price, ref.price, "clearing price vs reference");
        assertEq(over, ref.over, "oversubscribed vs reference");
        assertEq(levelCount, ref.distinctLevels, "level count");
        assertEq(sold, ref.over || ref.qtyAbove + ref.qtyAt >= supply ? supply : totalQty, "sold");
        assertEq(calls, (ref.levelsVisited + step - 1) / step, "settle calls");
        assertGe(price, TICK, "P >= reserve");
        assertEq(price % TICK, 0, "P on grid");
    }

    function _claimAll(uint256 r, Bidder[] memory bs, Ref memory ref, uint256 supply, Totals memory t) internal {
        uint256 n = bs.length;
        for (uint256 k; k < n; ++k) {
            Bidder memory b = bs[(k * 104_729 + 7) % n];
            uint256 alloc = _refAlloc(ref, supply, b);
            uint256 paid = _mulDivUp(alloc, ref.price, 1e18);
            uint256 mon0 = b.who.balance;
            uint256 tok0 = token.balanceOf(b.who);

            vm.prank(b.who);
            engine.claim(r);
            uint256 g = _txGas(abi.encodeCall(engine.claim, (r)));
            _rec("claim (all)", g);
            if (b.price > ref.price) _rec("claim (above P, full)", g);
            else if (b.price == ref.price) _rec("claim (at P, pro-rata)", g);
            else _rec("claim (below P, refund)", g);

            uint256 refund = b.who.balance - mon0;
            uint256 got = token.balanceOf(b.who) - tok0;
            (uint128 aPaid, uint128 aRefunded, bool aSettled) = engine.accounts(r, b.who);
            assertTrue(aSettled, "settled account");
            assertEq(aPaid, paid, "paid == ceil(alloc x P / 1e18)");
            assertEq(aRefunded, uint256(DEPOSIT) - paid, "refund == deposit - paid");
            assertEq(refund, uint256(DEPOSIT) - paid, "refund received");
            assertEq(got, alloc, "tokens == reference allocation");
            assertLe(paid, _mulDivUp(alloc, b.price, 1e18), "never pays above own bid");
            if (b.price < ref.price) assertEq(paid, 0, "loser pays nothing");

            t.paid += paid;
            t.refunded += refund;
            t.delivered += got;

            // A second claim must fail and move nothing.
            vm.prank(b.who);
            vm.expectRevert("nothing to claim");
            engine.claim(r);
        }
    }

    function _checkConservation(uint256 r, uint256 n, Totals memory t) internal view {
        AuctionEngine.Round memory rd = engine.getRound(r);
        uint256 supplyIn = uint256(rd.sellAmount) + rd.tokenReserve;

        // MON: every deposit is either a payment or a refund; payments fund the pool and the creator.
        assertEq(t.paid + t.refunded, n * uint256(DEPOSIT), "payments + refunds == deposits");
        assertEq(rd.collected, t.paid, "collected == sum of payments");
        assertEq(BURN.balance, t.burnMonBefore, "no MON burned: everyone revealed");
        assertEq(rd.lpMonSpent + rd.withdrawn, t.paid, "payments == LP MON + creator proceeds");
        assertEq(creator.balance - t.creatorMonBefore, rd.withdrawn, "creator received proceeds");
        assertEq(engine.roundBalance(r), 0, "round balance drained");
        assertEq(address(engine).balance, 0, "engine holds no MON");

        // Tokens: delivered + LP + burned == everything pulled at open.
        assertEq(t.delivered, rd.allocatedTotal, "delivered == allocatedTotal");
        assertLe(rd.allocatedTotal, rd.sellAmount, "allocations <= sellAmount");
        assertEq(t.delivered + rd.lpTokensUsed + token.balanceOf(BURN), supplyIn, "token conservation");
        assertEq(rd.tokensOut, supplyIn, "tokensOut == supply pulled");
        assertEq(token.balanceOf(address(engine)), 0, "engine holds no tokens");
        (uint64 commits, uint64 reveals, uint64 claims,) = engine.ledgers(r);
        assertEq(commits, n);
        assertEq(reveals, n);
        assertEq(claims, n);
    }

    function _print(uint256 n, Ref memory ref, uint256 calls, uint256 step) internal view {
        console2.log("");
        console2.log(
            string.concat(
                "=== Scale: ", vm.toString(n), " bidders, ", vm.toString(ref.distinctLevels), " price levels ==="
            )
        );
        console2.log(
            string.concat(
                "P = ",
                vm.toString(ref.price / TICK),
                " ticks; winners above P ",
                vm.toString(ref.winners),
                ", at P ",
                vm.toString(ref.atPrice),
                ", below P ",
                vm.toString(ref.losers),
                "; oversubscribed ",
                ref.over ? "yes" : "no"
            )
        );
        console2.log(
            string.concat(
                "settle: ",
                vm.toString(ref.levelsVisited),
                " levels visited, ",
                vm.toString(calls),
                " calls of maxSteps=",
                vm.toString(step)
            )
        );
        console2.log("tx gas = execution + 21000 intrinsic + calldata; before refunds");
        console2.log(
            string.concat(
                _pad("operation", 26),
                _padL("n", 6),
                _padL("min", 11),
                _padL("mean", 11),
                _padL("max", 11),
                _padL("total", 13)
            )
        );
        _row("commit");
        _row("reveal (no hint)");
        _row("revealWithHint");
        _row("settle (per call)");
        _row("seedLP");
        _row("claim (all)");
        _row("claim (above P, full)");
        _row("claim (at P, pro-rata)");
        _row("claim (below P, refund)");
        _row("withdrawProceeds");
        _row("sweepDust");
        console2.log(string.concat("findHint (view, free via eth_call), max gas: ", vm.toString(findHintGasMax)));

        uint256 commitMean = agg[keccak256("commit")].sum / agg[keccak256("commit")].n;
        uint256 hintMean = agg[keccak256("revealWithHint")].sum / agg[keccak256("revealWithHint")].n;
        uint256 claimMean = agg[keccak256("claim (all)")].sum / agg[keccak256("claim (all)")].n;
        uint256 journey = commitMean + hintMean + claimMean;
        uint256 noHintMax = agg[keccak256("reveal (no hint)")].max;
        uint256 worst = agg[keccak256("commit")].max + noHintMax + agg[keccak256("claim (all)")].max;
        console2.log(
            string.concat(
                "bidder journey (mean commit + hinted reveal + claim): ",
                vm.toString(journey),
                " gas = $",
                _usd(_usdMicros(journey))
            )
        );
        console2.log(
            string.concat(
                "bidder journey worst case (max commit + unhinted reveal + claim): ",
                vm.toString(worst),
                " gas = $",
                _usd(_usdMicros(worst))
            )
        );
    }

    function _usd(uint256 micros) internal pure returns (string memory) {
        string memory frac = vm.toString(micros % 1e6);
        while (bytes(frac).length < 6) frac = string.concat("0", frac);
        return string.concat(vm.toString(micros / 1e6), ".", frac);
    }
}

/// 1,000 bidders against the mock adapter and locker.
contract ScaleMockTest is ScaleBase {
    function setUp() public {
        if (!_scaleEnabled()) {
            vm.skip(true);
            return;
        }
        vm.warp(1_800_000_000);
        token = new MockToken();
        MockPositionManager npm = new MockPositionManager();
        adapterAddr = address(new MockAdapter(npm));
        MockLocker locker = new MockLocker();
        address[] memory adapters = new address[](1);
        adapters[0] = adapterAddr;
        engine = new AuctionEngine(address(locker), adapters, LOCK_END, GRACE);
    }

    /// 1,000 bidders × 40 tokens of supply each: demand is ~55 tokens per bidder, so the walk covers
    /// roughly the top 73% of ~290 levels — 200+ levels, three settle calls of 100.
    function test_Scale_1000Bidders() public {
        _run(1000, 40_000e18, 100);
    }
}

/// The same flow on a Monad mainnet fork with the real Uniswap v3 adapter and GoPlus locker.
contract ScaleForkTest is ScaleBase {
    address constant FACTORY = 0x204FAca1764B154221e35c0d20aBb3c525710498;
    address constant NPM = 0x7197E214c0b767cFB76Fb734ab638E2c192F4E53;
    address constant WMON = 0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A;
    address constant LOCKER = 0x24A9eB23De8E6f59BDB981B03E847F0f3ABbFa0d;
    address constant TOKEN_AT = 0x1111111111111111111111111111111111111111;

    function setUp() public {
        if (!_scaleEnabled() || block.chainid != 143) {
            vm.skip(true);
            return;
        }
        adapterAddr = address(new UniswapV3Adapter(FACTORY, NPM, WMON, 100));
        address[] memory adapters = new address[](1);
        adapters[0] = adapterAddr;
        engine = new AuctionEngine(LOCKER, adapters, LOCK_END, GRACE);
        deployCodeTo("Mocks.sol:MockToken", TOKEN_AT);
        token = MockToken(TOKEN_AT);
    }

    function test_Scale_Fork() public {
        uint256 n = vm.envOr("SCALE_FORK_BIDDERS", uint256(200));
        console2.log(string.concat("Monad mainnet fork at block ", vm.toString(block.number)));
        _run(n, uint128(n * 40e18), 50);
    }
}
