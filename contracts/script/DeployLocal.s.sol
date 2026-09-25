// SPDX-License-Identifier: LGPL-3.0
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {AuctionEngine} from "../src/AuctionEngine.sol";
import {TokenFactory} from "../src/launch/TokenFactory.sol";
import {MockToken, MockPositionManager, MockAdapter, MockLocker} from "../test/mocks/Mocks.sol";

/// @notice Local stack for anvil: mock token, mock DEX adapter and mock locker, plus the real engine.
///         Used by the frontend, the demo and the indexer during development.
/// Run:  anvil  then  forge script script/DeployLocal.s.sol --rpc-url http://127.0.0.1:8545 --broadcast
contract DeployLocal is Script {
    // anvil's first default account
    uint256 constant ANVIL_KEY = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;

    function run() external {
        uint256 key = vm.envOr("DEPLOYER_PRIVATE_KEY", ANVIL_KEY);
        address deployer = vm.addr(key);
        vm.startBroadcast(key);
        MockToken token = new MockToken();
        MockPositionManager npm = new MockPositionManager();
        MockAdapter adapter = new MockAdapter(npm);
        MockLocker locker = new MockLocker();
        address[] memory adapters = new address[](1);
        adapters[0] = address(adapter);
        AuctionEngine engine = new AuctionEngine(address(locker), adapters, 4102444800, 1 days);
        token.mint(deployer, 100_000_000e18);
        TokenFactory factory = new TokenFactory(); // last, so the addresses above keep their nonces
        vm.stopBroadcast();

        string memory json = vm.serializeAddress("local", "auctionEngine", address(engine));
        json = vm.serializeAddress("local", "token", address(token));
        json = vm.serializeAddress("local", "adapter", address(adapter));
        json = vm.serializeAddress("local", "positionManager", address(npm));
        json = vm.serializeAddress("local", "locker", address(locker));
        json = vm.serializeAddress("local", "tokenFactory", address(factory));
        vm.writeJson(json, "deployments/local.json");
        console2.log("AuctionEngine", address(engine));
        console2.log("Token", address(token));
    }
}
