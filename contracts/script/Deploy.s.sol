// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {AuctionEngine} from "../src/AuctionEngine.sol";
import {TokenFactory} from "../src/launch/TokenFactory.sol";

/// @notice Deploy the engine and the launch-token factory to Monad.
/// Signer: a Foundry keystore (`--account <name>`), or DEPLOYER_PRIVATE_KEY if set.
/// Env: ADAPTERS (comma-separated DEX adapter addresses, required),
///      LOCKER (default: GoPlus UniV3LPLocker on Monad), PERMANENT_LOCK_END (default 2100-01-01),
///      LP_GRACE_SECONDS (default 1 day), TOKEN_FACTORY (reuse an existing factory instead of deploying
///      one; v2 reuses v1's, which is unchanged), OUT (deployments file name, default "<chainid>").
contract Deploy is Script {
    address constant GOPLUS_UNIV3_LOCKER = 0x24A9eB23De8E6f59BDB981B03E847F0f3ABbFa0d;

    function run() external returns (AuctionEngine engine) {
        uint256 key = vm.envOr("DEPLOYER_PRIVATE_KEY", uint256(0));
        address[] memory adapters = vm.envAddress("ADAPTERS", ",");
        address locker = vm.envOr("LOCKER", GOPLUS_UNIV3_LOCKER);
        uint256 lockEnd = vm.envOr("PERMANENT_LOCK_END", uint256(4102444800));
        uint256 grace = vm.envOr("LP_GRACE_SECONDS", uint256(1 days));

        if (key != 0) vm.startBroadcast(key);
        else vm.startBroadcast();
        engine = new AuctionEngine(locker, adapters, lockEnd, grace);
        address factory = vm.envOr("TOKEN_FACTORY", address(0));
        if (factory == address(0)) factory = address(new TokenFactory());
        vm.stopBroadcast();

        console2.log("AuctionEngine", address(engine));
        string memory json = vm.serializeAddress("deployed", "auctionEngine", address(engine));
        json = vm.serializeAddress("deployed", "locker", locker);
        json = vm.serializeAddress("deployed", "tokenFactory", factory);
        string memory out = vm.envOr("OUT", vm.toString(block.chainid));
        vm.writeJson(json, string.concat("deployments/", out, ".json"));
    }
}
