// SPDX-License-Identifier: LGPL-3.0
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {UniswapV3Adapter} from "../src/adapters/UniswapV3Adapter.sol";

/// @notice Deploy the Uniswap v3 DEX adapter to Monad. Pass its address to Deploy.s.sol as ADAPTERS.
/// Env: DEPLOYER_PRIVATE_KEY (required), TOLERANCE_BPS (default 100 = 1%),
///      UNIV3_FACTORY, UNIV3_POSITION_MANAGER, WMON (default: the Monad mainnet addresses below).
contract DeployAdapter is Script {
    // Monad mainnet (chain 143), verified on-chain.
    address constant UNIV3_FACTORY = 0x204FAca1764B154221e35c0d20aBb3c525710498;
    address constant UNIV3_POSITION_MANAGER = 0x7197E214c0b767cFB76Fb734ab638E2c192F4E53;
    address constant WMON = 0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A;

    function run() external returns (UniswapV3Adapter adapter) {
        uint256 key = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address factory = vm.envOr("UNIV3_FACTORY", UNIV3_FACTORY);
        address npm = vm.envOr("UNIV3_POSITION_MANAGER", UNIV3_POSITION_MANAGER);
        address wmon = vm.envOr("WMON", WMON);
        uint256 toleranceBps = vm.envOr("TOLERANCE_BPS", uint256(100));

        vm.startBroadcast(key);
        adapter = new UniswapV3Adapter(factory, npm, wmon, toleranceBps);
        vm.stopBroadcast();

        console2.log("UniswapV3Adapter", address(adapter));
        console2.log("toleranceBps", toleranceBps);
    }
}
