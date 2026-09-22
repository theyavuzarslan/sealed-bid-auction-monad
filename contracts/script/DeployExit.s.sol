// SPDX-License-Identifier: LGPL-3.0
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {ExitAuction} from "../src/exit/ExitAuction.sol";
import {DemoVault} from "../src/exit/DemoVault.sol";
import {IERC20} from "../src/vendor/openzeppelin/token/ERC20/IERC20.sol";
import {MockWMON} from "../test/mocks/MockWMON.sol";

/// @notice Exit-Priority stack for anvil: mock WMON, DemoVault and ExitAuction, wired together.
///         The deployer is also the vault's strategist.
/// Run:  anvil  then  forge script script/DeployExit.s.sol --rpc-url http://127.0.0.1:8545 --broadcast
/// Config parameters are demo values, not protocol defaults (12-open-questions.md has none for exits).
contract DeployExit is Script {
    uint256 constant ANVIL_KEY = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;
    string constant OUT = "deployments/exit-local.json";

    function run() external {
        _deployExit(vm.envOr("DEPLOYER_PRIVATE_KEY", ANVIL_KEY), defaultConfig());
    }

    function defaultConfig() public pure returns (ExitAuction.Config memory) {
        return ExitAuction.Config({
            commitDuration: 600,
            revealDuration: 600,
            depositAmount: 0.01 ether,
            tickBps: 5,
            minExitShares: 1e21, // 1 WMON of shares at the starting price
            maxExitSharesPerRound: 12_000e21,
            roundGapBlocks: 5
        });
    }

    function _deployExit(uint256 key, ExitAuction.Config memory c)
        internal
        returns (MockWMON wmon, DemoVault vault, ExitAuction auction)
    {
        address deployer = vm.addr(key);
        vm.startBroadcast(key);
        wmon = new MockWMON();
        vault = new DemoVault(IERC20(address(wmon)), deployer);
        auction = new ExitAuction(vault, c);
        vault.setExitAuction(address(auction));
        vm.stopBroadcast();

        string memory json = vm.serializeAddress("exit", "wmon", address(wmon));
        json = vm.serializeAddress("exit", "vault", address(vault));
        json = vm.serializeAddress("exit", "exitAuction", address(auction));
        json = vm.serializeAddress("exit", "strategist", deployer);
        vm.writeJson(json, OUT);
        console2.log("WMON", address(wmon));
        console2.log("DemoVault", address(vault));
        console2.log("ExitAuction", address(auction));
    }
}
