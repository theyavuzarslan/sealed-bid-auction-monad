// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {ExitAuction} from "engine/exit/ExitAuction.sol";
import {DemoVault} from "engine/exit/DemoVault.sol";
import {IERC20} from "engine/vendor/openzeppelin/token/ERC20/IERC20.sol";
import {MerkleProofLib} from "engine/lib/MerkleProofLib.sol";
import {MockWMON} from "engine-mocks/MockWMON.sol";

/// @title InstitutionalExit — one sealed exit round for a permissioned "Treasury Yield Vault"
/// @notice The institutional scenario on demo/exit/ (Institutional vault tab). Real ExitAuction + DemoVault
///         from ../contracts/src, with an allowlist root of the vault's nine LPs, run as transactions on
///         anvil in three phases; demo/exit/run-institutional.sh moves anvil's clock between them:
///
///           bootstrap  deploy, nine LPs deposit, strategist marks most of the vault as deployed, open
///                      the round, seven LPs commit sealed bids with their Merkle proofs; an outsider's
///                      commit is tried in simulation only (never broadcast) and its revert recorded
///           reveal     the seven bidders reveal (shares move into escrow)
///           settle     settle, record every quote, claim for every bidder, read the chain, write
///                      .scenario/inst/institutional.json, including the FIFO model on the same buffer
///
///         The vault is DemoVault: an ERC-4626 over WMON whose strategy is simulated (10-decisions.md #31).
///         "Treasury Yield Vault" is the scenario's label, not a product. Every value below is a scenario
///         input, not a protocol default; the FIFO side is a model, not on-chain.
contract InstitutionalExit is Script {
    string constant MNEMONIC = "test test test test test test test test test test test junk";
    string constant DIR = "./.scenario/inst/";
    string constant STACK = "./.scenario/inst/stack.json";
    uint256 constant LPS = 9;
    uint256 constant OUTSIDER = 10; // anvil account index; not on the allowlist
    uint256 constant BUFFER = 185_000 ether; // idle WMON at open: ~35% of the 530,000 WMON that wants out
    uint256 constant ONE_SHARE = 1e21; // shares have 21 decimals (DemoVault decimals offset 3)

    struct LP {
        string label;
        string kind;
        uint256 holding; // WMON deposited
        uint256 exitWant; // WMON of shares it wants out now; 0 = stays
        uint96 discountBps; // sealed bid (auction)
        uint256 fifoOrder; // arrival position in the FIFO model, 1 = first; 0 = not in the queue
        string fifoWhy;
    }

    function _lps() internal pure returns (LP[LPS] memory l) {
        l[0] = LP("Fund A", "Large fund", 400_000 ether, 250_000 ether, 75, 3, "files a 250k request; it is visible in the queue");
        l[1] = LP("Desk B", "Trading desk", 120_000 ether, 120_000 ether, 50, 2, "sees Fund A's request and moves ahead of it");
        l[2] = LP("Desk C", "Treasury desk", 90_000 ether, 60_000 ether, 40, 4, "learns of the run an hour later");
        l[3] = LP("Desk D", "Market-making desk", 75_000 ether, 75_000 ether, 120, 1, "watches the queue with a bot and goes first");
        l[4] = LP("LP E", "Small LP", 12_000 ether, 12_000 ether, 150, 6, "reads about it the next morning");
        l[5] = LP("LP F", "Small LP", 8_000 ether, 8_000 ether, 25, 5, "reads about it the next morning");
        l[6] = LP("LP G", "Small LP", 5_000 ether, 5_000 ether, 100, 7, "is last to hear");
        l[7] = LP("Desk H", "Desk, staying", 150_000 ether, 0, 0, 0, "");
        l[8] = LP("LP I", "Small LP, staying", 40_000 ether, 0, 0, 0, "");
    }

    function config(bytes32 root) public pure returns (ExitAuction.Config memory) {
        return ExitAuction.Config({
            commitDuration: 600,
            revealDuration: 600,
            depositAmount: 1 ether, // the same MON deposit for a 5k LP and a 250k fund
            tickBps: 5,
            minExitShares: 1_000e21, // 1,000 WMON of shares at the starting price
            maxExitSharesPerRound: 1_000_000e21, // does not bind here; the idle buffer does
            roundGapBlocks: 5,
            allowlistRoot: root
        });
    }

    // ─── Actors and allowlist ───────────────────────────────────────────

    function _key(uint256 i) internal pure returns (uint256) {
        return vm.deriveKey(MNEMONIC, uint32(i));
    }

    /// LP `i` (0-based) is anvil account i + 1; account 0 deploys and is the strategist.
    function _lpKey(uint256 i) internal pure returns (uint256) {
        return _key(1 + i);
    }

    function _lpAddr(uint256 i) internal pure returns (address) {
        return vm.addr(_lpKey(i));
    }

    function _leaves() internal pure returns (bytes32[] memory leaves) {
        leaves = new bytes32[](LPS);
        for (uint256 i; i < LPS; ++i) {
            leaves[i] = MerkleProofLib.leafOf(_lpAddr(i));
        }
    }

    function _hashPair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encode(a, b)) : keccak256(abi.encode(b, a));
    }

    function _up(bytes32[] memory level) internal pure returns (bytes32[] memory next) {
        next = new bytes32[]((level.length + 1) / 2);
        for (uint256 i; i < next.length; ++i) {
            uint256 j = 2 * i;
            next[i] = j + 1 < level.length ? _hashPair(level[j], level[j + 1]) : level[j];
        }
    }

    /// Sorted-pair tree (MerkleProofLib / OpenZeppelin compatible); an odd node is promoted unchanged.
    function _root() internal pure returns (bytes32) {
        bytes32[] memory level = _leaves();
        while (level.length > 1) level = _up(level);
        return level[0];
    }

    function _proof(uint256 index) internal pure returns (bytes32[] memory proof) {
        bytes32[] memory level = _leaves();
        bytes32[] memory tmp = new bytes32[](8);
        uint256 n;
        uint256 idx = index;
        while (level.length > 1) {
            uint256 sib = idx ^ 1;
            if (sib < level.length) tmp[n++] = level[sib];
            level = _up(level);
            idx /= 2;
        }
        proof = new bytes32[](n);
        for (uint256 i; i < n; ++i) {
            proof[i] = tmp[i];
        }
    }

    function _salt(uint256 i) internal pure returns (bytes32) {
        return keccak256(abi.encode("institutional-exit", i));
    }

    function _bidShares(LP memory lp) internal pure returns (uint96) {
        return uint96(lp.exitWant * 1_000); // 1 WMON = 1e21 shares at the starting price
    }

    function _commitHash(uint256 i, LP memory lp) internal pure returns (bytes32) {
        return keccak256(abi.encode(lp.discountBps, _bidShares(lp), _salt(i), _lpAddr(i)));
    }

    function _stack() internal view returns (MockWMON wmon, DemoVault vault, ExitAuction auction) {
        string memory j = vm.readFile(STACK);
        wmon = MockWMON(payable(vm.parseJsonAddress(j, ".wmon")));
        vault = DemoVault(vm.parseJsonAddress(j, ".vault"));
        auction = ExitAuction(vm.parseJsonAddress(j, ".exitAuction"));
    }

    // ─── Phases ─────────────────────────────────────────────────────────

    function bootstrap() external {
        LP[LPS] memory l = _lps();
        bytes32 root = _root();
        address deployer = vm.addr(_key(0));

        vm.startBroadcast(_key(0));
        MockWMON wmon = new MockWMON();
        DemoVault vault = new DemoVault(IERC20(address(wmon)), deployer);
        ExitAuction auction = new ExitAuction(vault, config(root));
        vault.setExitAuction(address(auction));
        vm.stopBroadcast();

        vm.createDir(DIR, true);
        string memory s = vm.serializeAddress("stack", "wmon", address(wmon));
        s = vm.serializeAddress("stack", "vault", address(vault));
        s = vm.serializeAddress("stack", "exitAuction", address(auction));
        vm.writeJson(s, STACK);

        for (uint256 i; i < LPS; ++i) {
            vm.startBroadcast(_lpKey(i));
            wmon.deposit{value: l[i].holding}();
            wmon.approve(address(vault), l[i].holding);
            vault.deposit(l[i].holding, _lpAddr(i));
            vm.stopBroadcast();
        }

        vm.startBroadcast(_key(0));
        vault.moveToStrategy(vault.totalAssets() - BUFFER);
        require(auction.openExitRound() == 1, "round id");
        vm.stopBroadcast();

        uint256 deposit = auction.depositAmount();
        string memory commits;
        for (uint256 i; i < LPS; ++i) {
            if (l[i].exitWant == 0) continue;
            bytes32 h = _commitHash(i, l[i]);
            vm.startBroadcast(_lpKey(i));
            auction.commit{value: deposit}(1, h, _proof(i), "");
            vm.stopBroadcast();
            string memory c = string.concat("{", _q("lp", l[i].label), _q("hash", vm.toString(h)), _sLast("depositWei", deposit), "}");
            commits = bytes(commits).length == 0 ? c : string.concat(commits, ",", c);
        }

        // Allowlist check, in simulation only (not broadcast): an address outside the root tries to bid,
        // first with no proof, then with Fund A's valid proof (a proof is bound to its own address).
        address outsider = vm.addr(_key(OUTSIDER));
        string memory noProof = _tryCommit(auction, outsider, new bytes32[](0), deposit);
        string memory borrowed = _tryCommit(auction, outsider, _proof(0), deposit);

        ExitAuction.ExitRound memory x = auction.getRound(1);
        string memory json = string.concat(
            "{",
            _q("allowlistRoot", vm.toString(root)),
            _n("allowlistSize", LPS),
            _q("outsider", vm.toString(outsider)),
            _q("outsiderNoProof", noProof),
            _q("outsiderBorrowedProof", borrowed),
            _s("idle", vault.idleAssets()),
            _s("strategy", vault.strategyAssets()),
            _s("totalAssets", vault.totalAssets()),
            _s("capacityShares", x.capacity),
            _s("capacityAssets", vault.convertToAssets(x.capacity)),
            _s("sharePrice", vault.convertToAssets(ONE_SHARE)),
            _s("depositWei", deposit),
            _n("commitSeconds", auction.commitDuration()),
            _n("revealSeconds", auction.revealDuration()),
            "\"commits\":[",
            commits,
            "]}"
        );
        vm.writeFile(string.concat(DIR, "open.json"), json);
    }

    function _tryCommit(ExitAuction auction, address who, bytes32[] memory proof, uint256 deposit)
        internal
        returns (string memory)
    {
        bytes32 h = keccak256(abi.encode(uint96(100), uint96(10_000e21), bytes32("outsider"), who));
        vm.deal(who, deposit);
        vm.prank(who);
        try auction.commit{value: deposit}(1, h, proof, "") {
            return "accepted";
        } catch Error(string memory reason) {
            return string.concat("reverted: ", reason);
        } catch {
            return "reverted";
        }
    }

    function reveal() external {
        LP[LPS] memory l = _lps();
        (, DemoVault vault, ExitAuction auction) = _stack();
        for (uint256 i; i < LPS; ++i) {
            if (l[i].exitWant == 0) continue;
            uint96 shares = _bidShares(l[i]);
            vm.startBroadcast(_lpKey(i));
            vault.approve(address(auction), shares);
            auction.reveal(1, l[i].discountBps, shares, _salt(i));
            vm.stopBroadcast();
        }
    }

    function settle() external {
        LP[LPS] memory l = _lps();
        (MockWMON wmon, DemoVault vault, ExitAuction auction) = _stack();
        vm.startBroadcast(_key(0));
        require(auction.settle(1, 1_000), "settle incomplete");
        vm.stopBroadcast();

        (, uint256 p, uint256 sold,, bool over,,) = auction.clearingOf(1);
        uint256[LPS] memory alloc;
        uint256[LPS] memory payout;
        uint256[LPS] memory discountPaid;
        uint256 settleAssets = auction.getRound(1).settleAssets;
        for (uint256 i; i < LPS; ++i) {
            if (l[i].exitWant == 0) continue;
            (uint256 a,,, uint256 pay,) = auction.quote(1, _lpAddr(i));
            alloc[i] = a;
            payout[i] = pay;
            // What exiting cost this LP: its allocation's value at settlement minus what it was paid.
            // (The contract's per-claim `donation` is larger for later claimers: it also returns the
            // appreciation of still-escrowed shares, which winners do not collect; see ExitAuction.)
            if (a != 0) discountPaid[i] = a * settleAssets / sold - pay;
            vm.startBroadcast(_lpKey(i));
            auction.claim(1);
            vm.stopBroadcast();
        }
        string memory after_ = _after(l, wmon, vault, alloc, payout, discountPaid);
        string memory json = string.concat(
            "{",
            _n("clearingDiscountBps", p),
            _s("soldShares", sold),
            _s("soldAssets", auction.getRound(1).settleAssets),
            "\"oversubscribed\":",
            over ? "true," : "false,",
            _s("paidOut", auction.getRound(1).paidOut),
            _s("donated", auction.getRound(1).donated),
            _s("sharePriceAfter", vault.convertToAssets(ONE_SHARE)),
            _s("totalAssetsAfter", vault.totalAssets()),
            _s("idleAfter", vault.idleAssets()),
            _s("auctionShares", vault.balanceOf(address(auction))),
            _s("auctionWmon", wmon.balanceOf(address(auction))),
            _s("auctionMon", address(auction).balance),
            "\"lps\":[",
            after_,
            "]}"
        );
        vm.writeFile(string.concat(DIR, "settle.json"), json);
        _report(l, vault, auction);
    }

    function _after(
        LP[LPS] memory l,
        MockWMON wmon,
        DemoVault vault,
        uint256[LPS] memory alloc,
        uint256[LPS] memory payout,
        uint256[LPS] memory discountPaid
    ) internal view returns (string memory out) {
        for (uint256 i; i < LPS; ++i) {
            address who = _lpAddr(i);
            uint256 shares = vault.balanceOf(who);
            string memory r = string.concat(
                "{",
                _q("label", l[i].label),
                _q("kind", l[i].kind),
                _q("address", vm.toString(who)),
                _s("holding", l[i].holding),
                _s("exitWant", l[i].exitWant),
                _n("discountBps", l[i].discountBps),
                _s("bidShares", l[i].exitWant == 0 ? 0 : _bidShares(l[i])),
                _s("allocatedShares", alloc[i]),
                _s("payout", payout[i]),
                _s("discountPaid", discountPaid[i]), // value at settlement - payout
                _s("wmonReceived", wmon.balanceOf(who)),
                _s("sharesAfter", shares),
                _sLast("valueInVaultAfter", vault.convertToAssets(shares)),
                "}"
            );
            out = i == 0 ? r : string.concat(out, ",", r);
        }
    }

    /// FIFO model on the same buffer: requests paid at par in arrival order until the idle buffer runs out.
    function _fifo(LP[LPS] memory l, uint256 buffer) internal pure returns (string memory out) {
        uint256 left = buffer;
        for (uint256 pos = 1; pos <= LPS; ++pos) {
            for (uint256 i; i < LPS; ++i) {
                if (l[i].fifoOrder != pos) continue;
                uint256 paid = l[i].exitWant < left ? l[i].exitWant : left;
                left -= paid;
                string memory r = string.concat(
                    "{",
                    _q("label", l[i].label),
                    _n("position", pos),
                    _q("why", l[i].fifoWhy),
                    _s("requested", l[i].exitWant),
                    _s("paidAtPar", paid),
                    _sLast("stuck", l[i].exitWant - paid),
                    "}"
                );
                out = bytes(out).length == 0 ? r : string.concat(out, ",", r);
            }
        }
    }

    function _report(LP[LPS] memory l, DemoVault vault, ExitAuction auction) internal {
        string memory open_ = vm.readFile(string.concat(DIR, "open.json"));
        uint256 buffer = vm.parseUint(vm.parseJsonString(open_, ".idle"));
        uint256 demand;
        for (uint256 i; i < LPS; ++i) {
            demand += l[i].exitWant;
        }
        string memory json = string.concat(
            "{\"meta\":{",
            _q("scenario", "Treasury Yield Vault: permissioned vault, nine allowlisted LPs, one sealed exit round"),
            _q(
                "source",
                "ExitAuction + DemoVault on anvil, read from chain by demo/script/InstitutionalExit.s.sol; FIFO side is a model"
            ),
            _q("chainId", vm.toString(block.chainid)),
            _q("vault", vm.toString(address(vault))),
            _q("exitAuction", vm.toString(address(auction))),
            _n("tickBps", auction.tickBps()),
            _s("minExitShares", auction.minExitShares()),
            _s("exitDemand", demand),
            _sLast("buffer", buffer),
            "},\"open\":",
            open_,
            ",\"auction\":",
            vm.readFile(string.concat(DIR, "settle.json")),
            ",\"fifo\":{",
            _q("model", "Same vault and buffer; requests paid at par in arrival order; no discount, nothing accrues to stayers"),
            "\"queue\":[",
            _fifo(l, buffer),
            "]}}"
        );
        vm.writeFile(string.concat(DIR, "institutional.json"), json);
        console2.log("wrote", string.concat(DIR, "institutional.json"));
    }

    // ─── JSON helpers (big values as strings) ───────────────────────────

    function _s(string memory k, uint256 v) internal pure returns (string memory) {
        return string.concat("\"", k, "\":\"", vm.toString(v), "\",");
    }

    function _sLast(string memory k, uint256 v) internal pure returns (string memory) {
        return string.concat("\"", k, "\":\"", vm.toString(v), "\"");
    }

    function _n(string memory k, uint256 v) internal pure returns (string memory) {
        return string.concat("\"", k, "\":", vm.toString(v), ",");
    }

    function _q(string memory k, string memory v) internal pure returns (string memory) {
        return string.concat("\"", k, "\":\"", v, "\",");
    }
}
