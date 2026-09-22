// SPDX-License-Identifier: LGPL-3.0
pragma solidity ^0.8.24;

import {AuctionEngineTest} from "./AuctionEngine.t.sol";
import {AuctionEngine} from "../src/AuctionEngine.sol";
import {MockToken, MockPositionManager} from "./mocks/Mocks.sol";

/// Token with a pause switch, standing in for a creator-controlled memecoin (second review, M2).
contract PausableToken {
    address public owner = msg.sender;
    bool public paused;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 a) external {
        balanceOf[to] += a;
    }

    function setPaused(bool p) external {
        require(msg.sender == owner);
        paused = p;
    }

    function approve(address s, uint256 a) external returns (bool) {
        allowance[msg.sender][s] = a;
        return true;
    }

    function transfer(address to, uint256 a) external returns (bool) {
        _move(msg.sender, to, a);
        return true;
    }

    function transferFrom(address from, address to, uint256 a) external returns (bool) {
        uint256 al = allowance[from][msg.sender];
        if (al != type(uint256).max) allowance[from][msg.sender] = al - a;
        _move(from, to, a);
        return true;
    }

    function _move(address from, address to, uint256 a) private {
        require(!paused, "paused");
        balanceOf[from] -= a;
        balanceOf[to] += a;
    }
}

/// Full-range constant-product pool model whose empty pool anyone can initialise at any price
/// (the second review's model for H1). It honours the adapter contract: seed at `price` or revert.
contract CPMMAdapter {
    MockPositionManager public immutable npm;
    mapping(address => uint256) public initPrice;
    mapping(address => uint256) public rTok;
    mapping(address => uint256) public rMon;

    constructor(MockPositionManager npm_) {
        npm = npm_;
    }

    function supportsFee(uint24) external pure returns (bool) {
        return true;
    }

    function poolPrice(address token) public view returns (uint256) {
        if (rTok[token] != 0) return rMon[token] * 1e18 / rTok[token];
        return initPrice[token];
    }

    function initialize(address token, uint256 price) external {
        require(rTok[token] == 0, "has liquidity");
        initPrice[token] = price;
    }

    function seed(address token, uint256 tokenAmount, uint256 price, uint24, address recipient)
        external
        payable
        returns (address, uint256)
    {
        uint256 pp = poolPrice(token);
        if (pp == 0) pp = price;
        uint256 diff = pp > price ? pp - price : price - pp;
        require(diff * 100 <= price, "pool price deviates");
        uint256 tokUse = tokenAmount;
        uint256 monUse = tokenAmount * pp / 1e18;
        if (monUse > msg.value) {
            monUse = msg.value;
            tokUse = msg.value * 1e18 / pp;
        }
        MockToken(token).transferFrom(msg.sender, address(this), tokUse);
        rTok[token] += tokUse;
        rMon[token] += monUse;
        if (msg.value > monUse) {
            (bool ok,) = msg.sender.call{value: msg.value - monUse}("");
            require(ok);
        }
        return (address(npm), npm.mint(recipient));
    }

    function sell(address token, uint256 amountIn) external returns (uint256 out) {
        MockToken(token).transferFrom(msg.sender, address(this), amountIn);
        out = rMon[token] * amountIn / (rTok[token] + amountIn);
        rTok[token] += amountIn;
        rMon[token] -= out;
        (bool ok,) = msg.sender.call{value: out}("");
        require(ok);
    }

    /// Tries to push MON into the engine outside seeding.
    function poke(address engine) external payable {
        (bool ok,) = engine.call{value: msg.value}("");
        require(ok, "unexpected MON");
    }
}

/// Regression tests for the second, independent review of the rewritten contracts.
/// Each started as a proof of concept that demonstrated the attack; each now asserts it fails.
contract AuditRegressions is AuctionEngineTest {
    function _ammRound() internal returns (CPMMAdapter amm, uint256 r) {
        amm = new CPMMAdapter(npm);
        address[] memory adapters = new address[](1);
        adapters[0] = address(amm);
        engine = new AuctionEngine(address(locker), adapters, LOCK_END, GRACE);
        vm.prank(creator);
        token.approve(address(engine), type(uint256).max);
        AuctionEngine.OpenParams memory p = _params(AuctionEngine.Preset.Degen);
        p.dexSplits[0].adapter = address(amm);
        r = _open(p);
        _standardBook(r);
        _toSettle(r);
        engine.settle(r, 10);
    }

    /// H1: a pool held at a bad price can no longer be used to drain the LP's MON.
    function test_H1_BlockedPool_AbandonBurns_NoUncheckedSeed() public {
        (CPMMAdapter amm, uint256 r) = _ammRound();
        vm.prank(creator);
        amm.initialize(address(token), 1000 ether); // the creator holds the pool at an absurd price
        vm.expectRevert("pool price deviates");
        engine.seedLP(r);
        vm.warp(block.timestamp + GRACE);
        engine.abandonLP(r);
        vm.expectRevert("LP already done");
        engine.seedLP(r);
        assertEq(amm.rMon(address(token)), 0, "no MON ever reaches the pool");

        _claim(r, alice);
        _claim(r, bob);
        _claim(r, carol);
        _claim(r, dave);
        _claim(r, eve);
        uint256 lpMon = engine.getRound(r).lpMonBurned;
        assertGt(lpMon, 1.4 ether);
        assertEq(BURN.balance, lpMon);
        uint256 before = creator.balance;
        vm.prank(creator);
        engine.withdrawProceeds(r);
        // The creator gets payments minus the LP share, exactly as if the LP had been seeded.
        assertEq(creator.balance - before, 3 ether - lpMon);
    }

    /// M1: if seeding never succeeds, nothing is stranded.
    function test_M1_SeedNeverSucceeds_NothingStranded() public {
        uint256 r = _open(_params(AuctionEngine.Preset.Degen));
        _standardBook(r);
        _toSettle(r);
        engine.settle(r, 10);
        adapter.setRevert(true);
        vm.warp(block.timestamp + GRACE);
        engine.abandonLP(r);
        _claim(r, alice);
        _claim(r, bob);
        _claim(r, carol);
        _claim(r, dave);
        _claim(r, eve);
        vm.prank(creator);
        engine.withdrawProceeds(r);
        engine.sweepDust(r);
        assertEq(address(engine).balance, 0);
        assertEq(token.balanceOf(address(engine)), 0);
    }

    /// M2: a paused token cannot hold refunds hostage.
    function test_M2_PausedToken_RefundsStillFlow() public {
        PausableToken pt = new PausableToken();
        pt.mint(creator, 10_000_000e18);
        vm.prank(creator);
        pt.approve(address(engine), type(uint256).max);
        AuctionEngine.OpenParams memory p = _params(AuctionEngine.Preset.Degen);
        p.token = address(pt);
        uint256 r = _open(p);
        _commit(r, alice, 0.005 ether, 400e18);
        _commit(r, eve, 0.005 ether, 100e18);
        _toReveal(r);
        _reveal(r, alice, 0.005 ether, 400e18);
        _reveal(r, eve, 0.005 ether, 100e18);
        _toSettle(r);
        engine.settle(r, 10);
        pt.setPaused(true);

        // Refunds are available right after settlement, before and regardless of the token.
        uint256 aliceBefore = alice.balance;
        engine.claimRefund(r, alice);
        assertEq(alice.balance - aliceBefore, uint256(DEPOSIT) - 2 ether); // 400 tokens at 0.005
        engine.claimRefund(r, eve);

        vm.expectRevert("paused");
        engine.seedLP(r);
        vm.warp(block.timestamp + GRACE);
        engine.abandonLP(r); // makes no token transfer, so the pause cannot block it
        vm.prank(alice);
        vm.expectRevert("transfer failed");
        engine.claimTokens(r, alice); // tokens wait for the creator to unpause; MON did not
        pt.setPaused(false);
        engine.claimTokens(r, alice);
        assertEq(pt.balanceOf(alice), 400e18);
    }

    /// L1: a winner who never claims no longer blocks the dust sweep or the creator's proceeds.
    function test_L1_AnyoneCanSettleANonClaimer() public {
        uint256 r = _open(_params(AuctionEngine.Preset.Degen));
        _standardBook(r);
        _toSettle(r);
        engine.settle(r, 10);
        engine.seedLP(r);
        _claim(r, alice);
        _claim(r, bob);
        _claim(r, carol);
        _claim(r, eve);
        vm.expectRevert("refunds outstanding");
        engine.sweepDust(r);
        uint256 daveBefore = dave.balance;
        vm.prank(makeAddr("anyone"));
        engine.claimTokens(r, dave); // funds go to Dave, whoever triggers it
        assertEq(token.balanceOf(dave), 100e18);
        assertEq(dave.balance - daveBefore, uint256(DEPOSIT) - 0.3 ether);
        engine.sweepDust(r);
        assertEq(engine.creatorAvailable(r), 3 ether - engine.getRound(r).lpMonSpent);
    }

    /// L2: parameters under which no valid bid exists are rejected at open.
    function test_L2_ImpossibleParametersRejected() public {
        AuctionEngine.OpenParams memory p = _params(AuctionEngine.Preset.Degen);
        p.tickSize = 2e18;
        p.reservePrice = 2e18;
        p.minBidSize = 1 ether + 1;
        p.depositAmount = 1 ether + 2;
        vm.prank(creator);
        vm.expectRevert("no valid bid possible");
        engine.openRound(p);
    }

    /// L3: a price level no longer costs almost nothing — the minimum applies at the reserve price.
    function test_L3_CheapHighPriceLevelsRejected() public {
        uint256 r = _open(_params(AuctionEngine.Preset.Degen));
        address s = makeAddr("spammer");
        vm.deal(s, DEPOSIT);
        uint96 price = uint96(1e28);
        vm.prank(s);
        engine.commit{value: DEPOSIT}(r, _hash(price, 1e6, bytes32(0), s), new bytes32[](0), "");
        _toReveal(r);
        vm.prank(s);
        vm.expectRevert("below minimum bid");
        engine.reveal(r, price, 1e6, bytes32(0));
    }

    /// Fee tier 100 (tick spacing 1) cannot be chosen: repricing it can exceed one transaction's gas.
    function test_FeeTierNotSupportedRejectedAtOpen() public {
        AuctionEngine.OpenParams memory p = _params(AuctionEngine.Preset.Degen);
        p.dexSplits[0].fee = 100;
        vm.prank(creator);
        vm.expectRevert("fee tier not supported");
        engine.openRound(p);
    }

    /// Raise LP locks must be meaningful and counted from seeding.
    function test_RaiseLockTooShortRejected() public {
        AuctionEngine.OpenParams memory p = _params(AuctionEngine.Preset.Raise);
        p.lockDuration = 1 hours;
        vm.prank(creator);
        vm.expectRevert("lock too short");
        engine.openRound(p);
    }

    /// Stray MON from an adapter outside seeding is rejected, so it can never sit unaccounted.
    function test_StrayAdapterMonRejected() public {
        (CPMMAdapter amm,) = _ammRound();
        vm.deal(address(this), 1 ether);
        vm.expectRevert("unexpected MON");
        amm.poke{value: 1 ether}(address(engine));
    }

    // ─── The second review's accounting fuzz, ported to the abandon path ─

    struct B {
        address who;
        uint96 price;
        uint96 amount;
        bool reveal;
    }

    function _mk(uint256 seed, uint256 tag, uint256 n) internal returns (B[] memory bs) {
        bs = new B[](n);
        for (uint256 i; i < n; ++i) {
            uint256 x = uint256(keccak256(abi.encode(seed, tag, i)));
            bs[i].who = address(uint160(0x100000 + tag * 1000 + i));
            vm.deal(bs[i].who, 100 ether);
            bs[i].price = uint96((1 + x % 6) * TICK);
            uint256 maxAmt = uint256(9.99 ether) * 1e18 / bs[i].price;
            uint256 minAmt = uint256(0.01 ether) * 1e18 / TICK + 1;
            bs[i].amount = uint96(minAmt + (x >> 16) % (maxAmt - minAmt));
            bs[i].reveal = (x >> 200) % 4 != 0;
        }
    }

    function _check() internal view {
        uint256 sum;
        for (uint256 r = 1; r <= engine.roundCount(); ++r) sum += engine.roundBalance(r);
        assertEq(address(engine).balance, sum, "engine MON != sum of round balances");
    }

    function testFuzz_Interleavings(uint256 seed) public {
        AuctionEngine.OpenParams memory p1 = _params(AuctionEngine.Preset.Degen);
        AuctionEngine.OpenParams memory p2 = _params(AuctionEngine.Preset.Raise);
        p2.vestDuration = 10 days;
        p2.tgeBps = uint16(seed % 10_000);
        p2.cliff = uint64(seed % 3 days);
        p1.lpShareBps = uint16(1 + seed % 10_000);
        p2.lpShareBps = uint16((seed >> 20) % 10_001);
        if (p2.lpShareBps == 0) {
            p2.dexSplits = new AuctionEngine.DexSplit[](0);
            p2.lockDuration = 0;
        }
        p1.sellAmount = uint128(1e18 + (seed >> 40) % 3000e18);
        p2.sellAmount = uint128(1e18 + (seed >> 80) % 3000e18);
        uint256 r1 = _open(p1);
        uint256 r2 = _open(p2);
        B[] memory a = _mk(seed, 1, 1 + seed % 9);
        B[] memory b = _mk(seed, 2, 1 + (seed >> 8) % 9);
        for (uint256 i; i < a.length; ++i) _commit(r1, a[i].who, a[i].price, a[i].amount);
        for (uint256 i; i < b.length; ++i) _commit(r2, b[i].who, b[i].price, b[i].amount);
        _toReveal(r1);
        for (uint256 i; i < a.length; ++i) if (a[i].reveal) _reveal(r1, a[i].who, a[i].price, a[i].amount);
        for (uint256 i; i < b.length; ++i) if (b[i].reveal) _reveal(r2, b[i].who, b[i].price, b[i].amount);
        _toSettle(r1);
        while (!engine.settle(r1, 1)) {}
        while (!engine.settle(r2, 3)) {}
        if (seed & 1 != 0) try engine.burnUnrevealed(r1) {} catch {}
        _check();

        // Half the bidders take refunds before the LP step.
        for (uint256 i; i < a.length; i += 2) if (a[i].reveal) engine.claimRefund(r1, a[i].who);
        for (uint256 i; i < b.length; i += 2) if (b[i].reveal) engine.claimRefund(r2, b[i].who);
        _check();

        bool blocked = (seed >> 3) & 1 != 0;
        adapter.setUseBps(5000 + (seed >> 100) % 5001);
        if (blocked) {
            adapter.setRevert(true);
            vm.warp(block.timestamp + GRACE);
            engine.abandonLP(r1);
            engine.abandonLP(r2);
        } else {
            engine.seedLP(r1);
            engine.seedLP(r2);
        }
        _check();
        for (uint256 i; i < a.length; ++i) {
            if (a[i].reveal) _claim(r1, a[i].who);
            if (engine.creatorAvailable(r1) != 0 && (seed >> (i + 120)) & 1 != 0) {
                vm.prank(creator);
                engine.withdrawProceeds(r1);
            }
            _check();
        }
        for (uint256 i; i < b.length; ++i) {
            if (b[i].reveal) _claim(r2, b[i].who);
            if (engine.creatorAvailable(r2) != 0 && (seed >> (i + 140)) & 1 != 0) {
                vm.prank(creator);
                engine.withdrawProceeds(r2);
            }
            _check();
        }
        try engine.burnUnrevealed(r1) {} catch {}
        try engine.burnUnrevealed(r2) {} catch {}
        vm.warp(block.timestamp + 30 days);
        for (uint256 i; i < b.length; ++i) {
            (uint256 v, uint256 rel) = engine.vestedOf(r2, b[i].who);
            if (v > rel) {
                vm.prank(b[i].who);
                engine.claimVested(r2);
            }
        }
        if (engine.creatorAvailable(r1) != 0) {
            vm.prank(creator);
            engine.withdrawProceeds(r1);
        }
        if (engine.creatorAvailable(r2) != 0) {
            vm.prank(creator);
            engine.withdrawProceeds(r2);
        }
        engine.sweepDust(r1);
        engine.sweepDust(r2);
        assertEq(address(engine).balance, 0, "MON left");
        assertEq(token.balanceOf(address(engine)), 0, "tokens left");
        for (uint256 i; i < a.length; ++i) {
            if (!a[i].reveal) continue;
            (uint256 al, uint256 pd,) = engine.quote(r1, a[i].who);
            assertEq(a[i].who.balance, 100 ether - pd);
            assertEq(token.balanceOf(a[i].who), al);
        }
    }
}
