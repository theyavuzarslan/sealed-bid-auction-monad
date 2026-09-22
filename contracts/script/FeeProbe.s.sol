// SPDX-License-Identifier: LGPL-3.0
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {Vm} from "forge-std/Vm.sol";
import {AuctionEngine} from "../src/AuctionEngine.sol";
import {MockToken, MockPositionManager, MockAdapter, MockLocker} from "../test/mocks/Mocks.sol";

/// @notice Fee probe: gas of each bidder step over a representative Degen round. PRD budget: the full
///         bidder journey costs under $0.01 in network fees. This script reports gas only;
///         `indexer/fee-report.mjs` turns gas into MON and USD for a given gas price and MON price.
///
///         The journey is commit -> reveal -> refund -> tokens, and the last two are either one
///         transaction or two. The probe runs the same bid book twice:
///           round A, path "claim":         claim(roundId) once claims open (refund + tokens in one tx)
///           round B, path "refund+tokens": claimRefund right after settlement, then claimTokens once
///                                          claims open; losing bids stop at the refund
///
/// Run (isolation is required: each call becomes its own transaction, with intrinsic and calldata gas):
///   forge script script/FeeProbe.s.sol --isolate                              # in-memory EVM, own mocks
///   forge script script/FeeProbe.s.sol --isolate --rpc-url http://127.0.0.1:8545  # fork of anvil; uses the
///                                                    engine from deployments/local.json if it has code there
/// Nothing is broadcast: the round needs the clock to move between windows, which only a simulation can do.
/// The indexer end-to-end test (indexer/e2e.test.mjs) measures the same steps from real anvil receipts.
///
/// Output: a table, plus one `FEEPROBE {json}` line per bidder and path for fee-report.mjs. Per step:
///   used   = receipt gasUsed (after the refund cap)
///   needed = gas consumed before refunds, the floor for the transaction's gas limit. Monad charges
///            gas limit x price, not gas used, so `needed` is the number to budget with.
contract FeeProbe is Script {
    struct Bidder {
        string label;
        uint96 price;
        uint96 amount;
        uint256 noteLen;
        bool reveals;
        bool useHint;
    }

    struct Cost {
        uint256 used;
        uint256 needed;
    }

    struct Journey {
        address who;
        bool wins;
        Cost commit;
        Cost reveal;
        Cost claim; // path "claim"
        Cost refund; // path "refund+tokens"
        Cost tokens; // path "refund+tokens", winners only
    }

    uint96 constant DEPOSIT = 10 ether;
    uint96 constant TICK = 0.001 ether; // MON wei per 1e18 token units
    uint128 constant SUPPLY = 1000e18;

    AuctionEngine engine;
    MockToken token;
    address adapter;
    address creator = address(0xC0FFEE);
    uint256 nextKey = 0xB1D000;

    function run() external {
        _setup();
        console2.log("Fee probe: gas per bidder step (used = receipt gasUsed; needed = pre-refund, gas-limit floor)");
        console2.log("engine", address(engine));
        _round(false);
        _round(true);
    }

    /// Demand: 700 tokens above 0.003, 500 at it -> clearing price 0.003, the 0.003 bids share 300 pro-rata,
    /// lower bids lose. Notes model decision #33's encrypted bid backup (~100-200 bytes, max 256). Every
    /// amount is at least minBidSize / reservePrice = 10 tokens, as the engine now requires.
    function _book() internal pure returns (Bidder[8] memory) {
        return [
            Bidder("full fill, new top level, 192B note", 0.005 ether, 400e18, 192, true, false),
            Bidder("full fill, new level, 192B note", 0.004 ether, 300e18, 192, true, false),
            Bidder("pro-rata at P, new level, 192B note", 0.003 ether, 200e18, 192, true, false),
            Bidder("pro-rata at P, existing level, no note", 0.003 ether, 200e18, 0, true, false),
            Bidder("pro-rata at P, 256B note (max)", 0.003 ether, 100e18, 256, true, false),
            Bidder("loses, refund only, 192B note", 0.002 ether, 300e18, 192, true, false),
            Bidder("loses, lowest level via revealWithHint", 0.001 ether, 100e18, 192, true, true),
            Bidder("never reveals (deposit burned)", 0.003 ether, 100e18, 192, false, false)
        ];
    }

    function _round(bool split) internal {
        uint256 r = _open();
        Bidder[8] memory bs = _book();
        Journey[8] memory js;

        for (uint256 i; i < bs.length; ++i) {
            js[i].who = vm.addr(nextKey++); // fresh addresses per round: no warm token balances
            vm.deal(js[i].who, 100 ether);
            bytes32 h = keccak256(abi.encode(bs[i].price, bs[i].amount, _salt(i), js[i].who));
            bytes memory note = _note(bs[i].noteLen);
            vm.prank(js[i].who);
            engine.commit{value: DEPOSIT}(r, h, new bytes32[](0), note);
            js[i].commit = _measure();
        }

        vm.warp(engine.getRound(r).commitEnd);
        for (uint256 i; i < bs.length; ++i) {
            if (!bs[i].reveals) continue;
            if (bs[i].useHint) {
                uint256 hint = engine.findHint(r, bs[i].price);
                vm.prank(js[i].who);
                engine.revealWithHint(r, bs[i].price, bs[i].amount, _salt(i), hint);
            } else {
                vm.prank(js[i].who);
                engine.reveal(r, bs[i].price, bs[i].amount, _salt(i));
            }
            js[i].reveal = _measure();
        }

        vm.warp(engine.getRound(r).revealEnd);
        engine.settle(r, 100);
        Cost memory settleC = _measure();

        if (split) {
            // Refunds are available as soon as the round is settled, before the LP exists.
            for (uint256 i; i < bs.length; ++i) {
                if (!bs[i].reveals) continue;
                vm.prank(js[i].who);
                engine.claimRefund(r, js[i].who);
                js[i].refund = _measure();
                (uint256 alloc,,) = engine.quote(r, js[i].who);
                js[i].wins = alloc != 0;
            }
        }
        engine.seedLP(r);
        Cost memory seedC = _measure();
        engine.burnUnrevealed(r);
        Cost memory burnC = _measure();
        engine.disposeUnsold(r);
        Cost memory disposeC = _measure();

        for (uint256 i; i < bs.length; ++i) {
            if (!bs[i].reveals) continue;
            if (split) {
                if (!js[i].wins) continue;
                vm.prank(js[i].who);
                engine.claimTokens(r, js[i].who);
                js[i].tokens = _measure();
            } else {
                vm.prank(js[i].who);
                engine.claim(r);
                js[i].claim = _measure();
            }
        }

        string memory path = split ? "refund+tokens" : "claim";
        console2.log(string.concat("Round ", vm.toString(r), ", path ", path, ":"));
        for (uint256 i; i < bs.length; ++i) {
            _print(bs[i], js[i], path);
        }
        console2.log(string.concat(
            "  round-level calls (paid by whoever pokes them): settle ", vm.toString(settleC.used), ", seedLP ",
            vm.toString(seedC.used), ", burnUnrevealed ", vm.toString(burnC.used), ", disposeUnsold ", vm.toString(disposeC.used)
        ));
    }

    function _print(Bidder memory b, Journey memory j, string memory path) internal pure {
        Cost memory c = _sum(_sum(_sum(_sum(j.commit, j.reveal), j.claim), j.refund), j.tokens);
        console2.log(string.concat(
            "    ", b.label, ": commit ", vm.toString(j.commit.used), " / reveal ", vm.toString(j.reveal.used),
            " / claim ", vm.toString(j.claim.used), " / refund ", vm.toString(j.refund.used), " / tokens ",
            vm.toString(j.tokens.used), " = ", vm.toString(c.used), " used, ", vm.toString(c.needed), " needed"
        ));
        console2.log(string.concat(
            "FEEPROBE {\"label\":\"", b.label, "\",\"path\":\"", path, "\",\"noteBytes\":", vm.toString(b.noteLen),
            ",\"commit\":", _json(j.commit), ",\"reveal\":", _json(j.reveal), ",\"claim\":", _json(j.claim),
            ",\"refund\":", _json(j.refund), ",\"tokens\":", _json(j.tokens), "}"
        ));
    }

    function _setup() internal {
        string memory path = "deployments/local.json";
        if (vm.exists(path)) {
            string memory json = vm.readFile(path);
            address e = vm.parseJsonAddress(json, ".auctionEngine");
            if (e.code.length != 0) {
                engine = AuctionEngine(payable(e));
                token = MockToken(vm.parseJsonAddress(json, ".token"));
                adapter = vm.parseJsonAddress(json, ".adapter");
                return;
            }
        }
        MockPositionManager npm = new MockPositionManager();
        adapter = address(new MockAdapter(npm));
        MockLocker locker = new MockLocker();
        address[] memory adapters = new address[](1);
        adapters[0] = adapter;
        engine = new AuctionEngine(address(locker), adapters, 4102444800, 1 days);
        token = new MockToken();
    }

    function _open() internal returns (uint256) {
        AuctionEngine.OpenParams memory p;
        p.preset = AuctionEngine.Preset.Degen;
        p.token = address(token);
        p.sellAmount = SUPPLY;
        p.depositAmount = DEPOSIT;
        p.minBidSize = 0.01 ether;
        p.tickSize = TICK;
        p.reservePrice = TICK;
        uint256 now_ = vm.getBlockTimestamp(); // not block.timestamp: via-IR may reuse it across vm.warp
        p.commitEnd = uint64(now_ + 1 hours);
        p.revealEnd = uint64(now_ + 2 hours);
        p.lpShareBps = 5000;
        p.dexSplits = new AuctionEngine.DexSplit[](1);
        p.dexSplits[0] = AuctionEngine.DexSplit({adapter: adapter, bps: 10_000, fee: 3000});
        p.lockFeeTier = "DEFAULT";
        token.mint(creator, 10_000e18);
        vm.prank(creator);
        token.approve(address(engine), type(uint256).max);
        vm.prank(creator);
        return engine.openRound(p);
    }

    /// Gas of the last top-level call, as its transaction receipt would report it.
    function _measure() internal view returns (Cost memory c) {
        Vm.Gas memory g = vm.lastCallGas();
        require(g.gasTotalUsed >= 21_000, "run with --isolate: gas must include the intrinsic cost");
        uint256 total = uint256(g.gasTotalUsed);
        if (g.gasStateUsed > 0) total += uint256(uint64(g.gasStateUsed));
        uint256 refund = g.gasRefunded > 0 ? uint256(uint64(g.gasRefunded)) : 0;
        if (refund > total / 5) refund = total / 5; // EIP-3529 cap
        c.used = total - refund;
        c.needed = total;
    }

    function _sum(Cost memory a, Cost memory b) internal pure returns (Cost memory) {
        return Cost(a.used + b.used, a.needed + b.needed);
    }

    function _salt(uint256 i) internal pure returns (bytes32) {
        return keccak256(abi.encode("fee-probe-salt", i));
    }

    /// Ciphertext-like note: nonzero bytes, since calldata prices zero bytes cheaper.
    function _note(uint256 len) internal pure returns (bytes memory b) {
        b = new bytes(len);
        for (uint256 i; i < len; ++i) b[i] = bytes1(uint8(i % 255) + 1);
    }

    function _json(Cost memory c) internal pure returns (string memory) {
        return string.concat("{\"used\":", vm.toString(c.used), ",\"needed\":", vm.toString(c.needed), "}");
    }
}
