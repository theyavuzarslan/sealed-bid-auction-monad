// SPDX-License-Identifier: LGPL-3.0
pragma solidity ^0.8.24;

import {console2} from "forge-std/Script.sol";
import {DeployExit} from "./DeployExit.s.sol";
import {ExitAuction} from "../src/exit/ExitAuction.sol";
import {DemoVault} from "../src/exit/DemoVault.sol";
import {MockWMON} from "../test/mocks/MockWMON.sol";

/// @notice Bank-run harness for Screen 5 (08-ui-notes.md), run as phases against anvil by
///         `demo/exit/run.sh`, which moves anvil's clock between phases. Every number written to
///         `deployments/exit-demo/` is read from chain state.
/// @dev Scenario (demo values, not protocol defaults): 8 holders want out, 4 stay. The vault holds 90%
///      in the illiquid strategy; between rounds the strategy unwinds `REFILL` WMON into the idle
///      buffer. Each round every exiter still holding shares bids all of them, at a discount that grows
///      with the round (panic) plus a per-holder urgency.
contract ExitDemo is DeployExit {
    string constant MNEMONIC = "test test test test test test test test test test test junk";
    string constant DIR = "deployments/exit-demo/";
    uint256 constant EXITERS = 8;
    uint256 constant STAYERS = 4;
    uint256 constant EXITER_DEPOSIT = 10_000 ether;
    uint256 constant STAYER_DEPOSIT = 15_000 ether;
    uint256 constant STRATEGY_BPS = 9_000;
    uint256 constant REFILL = 10_000 ether;
    uint256 constant ONE_SHARE = 1e21; // shares have 21 decimals

    // ─── Actors ─────────────────────────────────────────────────────────

    function _key(uint256 i) internal pure returns (uint256) {
        return vm.deriveKey(MNEMONIC, uint32(i));
    }

    /// Account 0 deploys and runs the strategy; 1..8 are exiters H1..H8; 9..12 are stayers S1..S4.
    function _exiterKey(uint256 i) internal pure returns (uint256) {
        return _key(1 + i);
    }

    function _stayerKey(uint256 i) internal pure returns (uint256) {
        return _key(1 + EXITERS + i);
    }

    function _stack() internal view returns (MockWMON wmon, DemoVault vault, ExitAuction auction) {
        string memory j = vm.readFile(OUT);
        wmon = MockWMON(payable(vm.parseJsonAddress(j, ".wmon")));
        vault = DemoVault(vm.parseJsonAddress(j, ".vault"));
        auction = ExitAuction(vm.parseJsonAddress(j, ".exitAuction"));
    }

    /// Discount in bps that exiter `i` (0-based) bids in round `k` (1-based), on the 5 bps grid.
    function _discount(uint256 i, uint256 k) internal pure returns (uint96) {
        uint256 d = 20 + 25 * (k - 1) + 15 * (k - 1) * (k - 1) + 10 * (i + 1);
        if (d > 9_000) d = 9_000;
        return uint96(d - d % 5);
    }

    function _salt(uint256 i, uint256 k) internal pure returns (bytes32) {
        return keccak256(abi.encode("exit-demo", i, k));
    }

    // ─── Phases ─────────────────────────────────────────────────────────

    function bootstrap() external {
        (MockWMON wmon, DemoVault vault,) = _deployExit(_key(0), defaultConfig());
        for (uint256 i; i < EXITERS + STAYERS; ++i) {
            uint256 key = i < EXITERS ? _exiterKey(i) : _stayerKey(i - EXITERS);
            uint256 amount = i < EXITERS ? EXITER_DEPOSIT : STAYER_DEPOSIT;
            vm.startBroadcast(key);
            wmon.deposit{value: amount}();
            wmon.approve(address(vault), amount);
            vault.deposit(amount, vm.addr(key));
            vm.stopBroadcast();
        }
        vm.startBroadcast(_key(0));
        vault.moveToStrategy(vault.totalAssets() * STRATEGY_BPS / 10_000);
        vm.stopBroadcast();
        vm.createDir(DIR, true);
    }

    function open(uint256 k) external {
        (, DemoVault vault, ExitAuction auction) = _stack();
        vm.startBroadcast(_key(0));
        if (k > 1) {
            uint256 s = vault.strategyAssets();
            vault.moveToIdle(s < REFILL ? s : REFILL);
        }
        uint256 r = auction.openExitRound();
        vm.stopBroadcast();
        require(r == k, "round id");
        uint256 deposit = auction.depositAmount();
        uint256 commits;
        for (uint256 i; i < EXITERS; ++i) {
            uint256 key = _exiterKey(i);
            uint256 s = vault.balanceOf(vm.addr(key));
            if (s < auction.minExitShares()) continue;
            bytes32 h = keccak256(abi.encode(_discount(i, k), uint96(s), _salt(i, k), vm.addr(key)));
            vm.startBroadcast(key);
            auction.commit{value: deposit}(k, h, new bytes32[](0), "");
            vm.stopBroadcast();
            commits++;
        }
        ExitAuction.ExitRound memory x = auction.getRound(k);
        string memory json = string.concat(
            "{",
            _n("round", k),
            _s("idle", vault.idleAssets()),
            _s("strategy", vault.strategyAssets()),
            _s("capacityShares", x.capacity),
            _s("capacityAssets", vault.convertToAssets(x.capacity)),
            _s("sharePrice", vault.convertToAssets(ONE_SHARE)),
            _n("commits", commits),
            _nLast("openedBlock", x.openedBlock),
            "}"
        );
        vm.writeFile(string.concat(DIR, "round-", vm.toString(k), "-open.json"), json);
    }

    function reveal(uint256 k) external {
        (, DemoVault vault, ExitAuction auction) = _stack();
        for (uint256 i; i < EXITERS; ++i) {
            uint256 key = _exiterKey(i);
            address who = vm.addr(key);
            (bytes32 h,) = auction.commitments(k, who);
            if (h == bytes32(0)) continue;
            uint96 s = uint96(vault.balanceOf(who));
            vm.startBroadcast(key);
            vault.approve(address(auction), s);
            auction.reveal(k, _discount(i, k), s, _salt(i, k));
            vm.stopBroadcast();
        }
    }

    function settle(uint256 k) external {
        (,, ExitAuction auction) = _stack();
        vm.startBroadcast(_key(0));
        require(auction.settle(k, 1_000), "settle incomplete");
        vm.stopBroadcast();
    }

    /// Records every bidder's quote from the settled chain state, then claims for each of them.
    function claim(uint256 k) external {
        (,, ExitAuction auction) = _stack();
        (, uint256 p, uint256 sold,, bool over,,) = auction.clearingOf(k);
        string memory bids;
        for (uint256 i; i < EXITERS; ++i) {
            uint256 key = _exiterKey(i);
            address who = vm.addr(key);
            (, bool revealed) = auction.commitments(k, who);
            if (!revealed) continue;
            (uint96 d, uint96 s) = auction.bids(k, who);
            (uint256 alloc, uint256 back,, uint256 payout,) = auction.quote(k, who);
            string memory b = string.concat(
                "{",
                _q("holder", string.concat("H", vm.toString(i + 1))),
                _n("discountBps", d),
                _s("shares", s),
                _s("allocated", alloc),
                _s("sharesReturned", back),
                _sLast("payout", payout),
                "}"
            );
            bids = bytes(bids).length == 0 ? b : string.concat(bids, ",", b);
            vm.startBroadcast(key);
            auction.claim(k);
            vm.stopBroadcast();
        }
        string memory json = string.concat(
            "{",
            _n("clearingDiscountBps", p),
            _s("sold", sold),
            "\"oversubscribed\":",
            over ? "true," : "false,",
            _s("settleAssets", auction.getRound(k).settleAssets),
            "\"bids\":[",
            bids,
            "]}"
        );
        vm.writeFile(string.concat(DIR, "round-", vm.toString(k), "-claims.json"), json);
    }

    /// Post-claim state of round `k`, read from chain.
    function snapshot(uint256 k) external {
        (MockWMON wmon, DemoVault vault, ExitAuction auction) = _stack();
        ExitAuction.ExitRound memory x = auction.getRound(k);
        uint256 stayersValue;
        for (uint256 i; i < STAYERS; ++i) {
            stayersValue += vault.convertToAssets(vault.balanceOf(vm.addr(_stayerKey(i))));
        }
        uint256 exitersPaid;
        uint256 exitersShares;
        for (uint256 i; i < EXITERS; ++i) {
            address who = vm.addr(_exiterKey(i));
            exitersPaid += wmon.balanceOf(who);
            exitersShares += vault.balanceOf(who);
        }
        string memory json = string.concat(
            "{",
            _s("sharePrice", vault.convertToAssets(ONE_SHARE)),
            _s("totalAssets", vault.totalAssets()),
            _s("totalSupply", vault.totalSupply()),
            _s("idle", vault.idleAssets()),
            _s("strategy", vault.strategyAssets()),
            _s("paidOut", x.paidOut),
            _s("donated", x.donated),
            _s("redeemedShares", x.allocatedTotal),
            _s("stayersValue", stayersValue),
            _s("exitersPaidTotal", exitersPaid),
            _s("exitersSharesLeft", exitersShares),
            _s("exitersValueLeft", vault.convertToAssets(exitersShares)),
            _s("auctionShares", vault.balanceOf(address(auction))),
            _s("auctionWmon", wmon.balanceOf(address(auction))),
            _sLast("auctionMon", address(auction).balance),
            "}"
        );
        vm.writeFile(string.concat(DIR, "round-", vm.toString(k), "-after.json"), json);
    }

    /// Assembles `results.json` from the phase files of rounds 1..n.
    function report(uint256 n) external {
        (, DemoVault vault, ExitAuction auction) = _stack();
        string memory holders;
        for (uint256 i; i < EXITERS + STAYERS; ++i) {
            bool exiter = i < EXITERS;
            address who = vm.addr(exiter ? _exiterKey(i) : _stayerKey(i - EXITERS));
            string memory h = string.concat(
                "{",
                _q("label", string.concat(exiter ? "H" : "S", vm.toString(exiter ? i + 1 : i - EXITERS + 1))),
                _q("address", vm.toString(who)),
                _q("role", exiter ? "exit" : "stay"),
                _sLast("deposit", exiter ? EXITER_DEPOSIT : STAYER_DEPOSIT),
                "}"
            );
            holders = i == 0 ? h : string.concat(holders, ",", h);
        }
        string memory rounds;
        for (uint256 k = 1; k <= n; ++k) {
            string memory base = string.concat(DIR, "round-", vm.toString(k));
            string memory r = string.concat(
                "{\"open\":",
                vm.readFile(string.concat(base, "-open.json")),
                ",\"clear\":",
                vm.readFile(string.concat(base, "-claims.json")),
                ",\"after\":",
                vm.readFile(string.concat(base, "-after.json")),
                "}"
            );
            rounds = k == 1 ? r : string.concat(rounds, ",", r);
        }
        string memory json = string.concat(
            "{\"meta\":{",
            _q("source", "ExitAuction + DemoVault on anvil, read from chain by contracts/script/ExitDemo.s.sol"),
            _q("chainId", vm.toString(block.chainid)),
            _q("vault", vm.toString(address(vault))),
            _q("exitAuction", vm.toString(address(auction))),
            _n("tickBps", auction.tickBps()),
            _n("roundGapBlocks", auction.roundGapBlocks()),
            _s("maxExitSharesPerRound", auction.maxExitSharesPerRound()),
            _s("refillPerRound", REFILL),
            _n("strategyBps", STRATEGY_BPS),
            _s("startSharePrice", 1 ether),
            "\"holders\":[",
            holders,
            "]},\"rounds\":[",
            rounds,
            "]}"
        );
        vm.writeFile(string.concat(DIR, "results.json"), json);
        console2.log("rounds", n);
    }

    // ─── JSON helpers (values as strings where they can exceed 2^53) ───

    function _s(string memory k, uint256 v) internal pure returns (string memory) {
        return string.concat("\"", k, "\":\"", vm.toString(v), "\",");
    }

    function _sLast(string memory k, uint256 v) internal pure returns (string memory) {
        return string.concat("\"", k, "\":\"", vm.toString(v), "\"");
    }

    function _n(string memory k, uint256 v) internal pure returns (string memory) {
        return string.concat("\"", k, "\":", vm.toString(v), ",");
    }

    function _nLast(string memory k, uint256 v) internal pure returns (string memory) {
        return string.concat("\"", k, "\":", vm.toString(v));
    }

    function _q(string memory k, string memory v) internal pure returns (string memory) {
        return string.concat("\"", k, "\":\"", v, "\",");
    }
}
