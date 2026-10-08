// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {ExitAuction} from "../src/exit/ExitAuction.sol";
import {DemoVault} from "../src/exit/DemoVault.sol";
import {IERC20} from "../src/vendor/openzeppelin/token/ERC20/IERC20.sol";

/// @notice Deploy a reference permissioned vault with sealed-bid exits to Monad mainnet:
///         DemoVault (ERC-4626 over real WMON) + ExitAuction with an allowlist root, wired together.
/// @dev A REFERENCE VAULT WITH A SIMULATED STRATEGY, not a yield product. DemoVault keeps every WMON in
///      the contract; `strategyAssets` only marks part of it as deployed, so the idle buffer (and the exit
///      capacity per round) is whatever the strategist leaves unmarked (10-decisions.md #31). The allowlist
///      is a Merkle root of addresses (MerkleProofLib, OpenZeppelin StandardMerkleTree compatible): it
///      decides who may bid, nothing more. It is not identity verification. The root is immutable, so a
///      new LP set means a new ExitAuction (and a new vault, since `setExitAuction` is one-time).
///
/// Signer: a Foundry keystore (`--account <name>`), or DEPLOYER_PRIVATE_KEY if set. The broadcaster must
/// deploy both contracts: `setExitAuction` is restricted to the vault's deployer.
///
/// Env:
///   ALLOWLIST_ROOT   required, bytes32 Merkle root of the LP addresses. Zero is refused: that is the open
///                    Vault preset, not the institutional one.
///   STRATEGIST       default: the broadcaster. Moves the simulated strategy mark.
///   COMMIT_SECONDS   default 3600      REVEAL_SECONDS   default 3600
///   DEPOSIT_WEI      default 1 MON, the uniform per-commit deposit (refunded in full once settled)
///   TICK_BPS         default 5 (0.05% discount grid)
///   MIN_EXIT_SHARES  default 1,000 WMON of shares = 1000e21. Shares have 21 decimals
///                    (DemoVault decimals offset 3): 1 WMON = 1e21 shares at the starting price.
///   MAX_EXIT_SHARES  default 1,000,000 WMON of shares = 1_000_000e21, per round
///   GAP_BLOCKS       default 5, blocks between a settlement and the next open
///
/// Dry run (no broadcast; writes deployments/143-exit.json with simulated addresses, do not commit it):
///   ALLOWLIST_ROOT=0x… forge script script/DeployExitMainnet.s.sol --fork-url https://rpc2.monad.xyz \
///     --sender <deployer>
/// Deploy:
///   ALLOWLIST_ROOT=0x… forge script script/DeployExitMainnet.s.sol --rpc-url https://rpc.monad.xyz \
///     --account deployer --broadcast
contract DeployExitMainnet is Script {
    /// WMON on Monad mainnet (chain 143), as used by AuctionEngine's pools (SUBMISSION.md, Deployment).
    address constant WMON = 0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A;

    function run() external returns (DemoVault vault, ExitAuction auction) {
        require(block.chainid == 143, "not Monad mainnet");
        require(WMON.code.length != 0, "WMON has no code");
        bytes32 root = vm.envBytes32("ALLOWLIST_ROOT");
        require(root != bytes32(0), "ALLOWLIST_ROOT is zero (open preset)");
        uint256 key = vm.envOr("DEPLOYER_PRIVATE_KEY", uint256(0));
        ExitAuction.Config memory c = ExitAuction.Config({
            commitDuration: uint64(vm.envOr("COMMIT_SECONDS", uint256(3600))),
            revealDuration: uint64(vm.envOr("REVEAL_SECONDS", uint256(3600))),
            depositAmount: uint96(vm.envOr("DEPOSIT_WEI", uint256(1 ether))),
            tickBps: uint16(vm.envOr("TICK_BPS", uint256(5))),
            minExitShares: uint96(vm.envOr("MIN_EXIT_SHARES", uint256(1_000e21))),
            maxExitSharesPerRound: uint128(vm.envOr("MAX_EXIT_SHARES", uint256(1_000_000e21))),
            roundGapBlocks: uint64(vm.envOr("GAP_BLOCKS", uint256(5))),
            allowlistRoot: root
        });

        if (key != 0) vm.startBroadcast(key);
        else vm.startBroadcast();
        (, address sender,) = vm.readCallers();
        address strategist = vm.envOr("STRATEGIST", sender);
        vault = new DemoVault(IERC20(WMON), strategist);
        auction = new ExitAuction(vault, c);
        vault.setExitAuction(address(auction));
        vm.stopBroadcast();

        require(vault.exitAuction() == address(auction), "not wired");
        require(auction.allowlistRoot() == root, "root");
        console2.log("DemoVault", address(vault));
        console2.log("ExitAuction", address(auction));
        console2.log("strategist", strategist);
        string memory json = vm.serializeAddress("exit", "wmon", WMON);
        json = vm.serializeAddress("exit", "vault", address(vault));
        json = vm.serializeAddress("exit", "exitAuction", address(auction));
        json = vm.serializeAddress("exit", "strategist", strategist);
        json = vm.serializeBytes32("exit", "allowlistRoot", root);
        vm.writeJson(json, string.concat("deployments/", vm.toString(block.chainid), "-exit.json"));
    }
}
