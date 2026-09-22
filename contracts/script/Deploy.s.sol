// SPDX-License-Identifier: LGPL-3.0
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {AuctionEngine} from "../src/AuctionEngine.sol";

/// @notice Deploy the engine to Monad.
/// Env: DEPLOYER_PRIVATE_KEY (required), ADAPTERS (comma-separated DEX adapter addresses, required),
///      LOCKER (default: GoPlus UniV3LPLocker on Monad), PERMANENT_LOCK_END (default 2100-01-01),
///      LP_GRACE_SECONDS (default 1 day).
contract Deploy is Script {
    address constant GOPLUS_UNIV3_LOCKER = 0x24A9eB23De8E6f59BDB981B03E847F0f3ABbFa0d;

    function run() external returns (AuctionEngine engine) {
        uint256 key = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address[] memory adapters = vm.envAddress("ADAPTERS", ",");
        address locker = vm.envOr("LOCKER", GOPLUS_UNIV3_LOCKER);
        uint256 lockEnd = vm.envOr("PERMANENT_LOCK_END", uint256(4102444800));
        uint256 grace = vm.envOr("LP_GRACE_SECONDS", uint256(1 days));

        vm.startBroadcast(key);
        engine = new AuctionEngine(locker, adapters, lockEnd, grace);
        vm.stopBroadcast();

        console2.log("AuctionEngine", address(engine));
        string memory json = vm.serializeAddress("deployed", "auctionEngine", address(engine));
        json = vm.serializeAddress("deployed", "locker", locker);
        vm.writeJson(json, string.concat("deployments/", vm.toString(block.chainid), ".json"));
    }
}
