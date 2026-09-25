// SPDX-License-Identifier: LGPL-3.0
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {AuctionEngine} from "../src/AuctionEngine.sol";
import {UniswapV3Adapter} from "../src/adapters/UniswapV3Adapter.sol";
import {TokenFactory} from "../src/launch/TokenFactory.sol";

/// @notice Deploy plan for wallets that can only call contracts (e.g. an agent wallet with no
///         contract-creation transaction): each deployment is a call to the deterministic CREATE2
///         deployer at 0x4e59…956C with `salt ‖ initcode`, so the addresses are known in advance.
///         None of the constructors read msg.sender, so deploying through the proxy is equivalent.
/// Run (no broadcast; writes deployments/<chainid>-create2-plan.json and simulates every call):
///   forge script script/Create2Plan.s.sol --fork-url https://rpc.monad.xyz
/// Env: SALT (default "even-v1"), ADAPTER_TOLERANCE_BPS (100), LOCKER, PERMANENT_LOCK_END, LP_GRACE_SECONDS.
contract Create2Plan is Script {
    address constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    // Monad mainnet (chain 143), verified on-chain.
    address constant UNIV3_FACTORY = 0x204FAca1764B154221e35c0d20aBb3c525710498;
    address constant UNIV3_POSITION_MANAGER = 0x7197E214c0b767cFB76Fb734ab638E2c192F4E53;
    address constant WMON = 0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A;
    address constant GOPLUS_UNIV3_LOCKER = 0x24A9eB23De8E6f59BDB981B03E847F0f3ABbFa0d;

    struct Step {
        string name;
        bytes data; // calldata for the CREATE2 deployer: salt ‖ initcode
        address predicted;
    }

    function run() external {
        bytes32 salt = keccak256(bytes(vm.envOr("SALT", string("even-v1"))));
        uint256 tolerance = vm.envOr("ADAPTER_TOLERANCE_BPS", uint256(100));
        address locker = vm.envOr("LOCKER", GOPLUS_UNIV3_LOCKER);
        uint256 lockEnd = vm.envOr("PERMANENT_LOCK_END", uint256(4102444800));
        uint256 grace = vm.envOr("LP_GRACE_SECONDS", uint256(1 days));

        Step[3] memory steps;
        bytes memory adapterInit = abi.encodePacked(
            type(UniswapV3Adapter).creationCode, abi.encode(UNIV3_FACTORY, UNIV3_POSITION_MANAGER, WMON, tolerance)
        );
        steps[0] = _step("UniswapV3Adapter", salt, adapterInit);
        address[] memory adapters = new address[](1);
        adapters[0] = steps[0].predicted;
        bytes memory engineInit =
            abi.encodePacked(type(AuctionEngine).creationCode, abi.encode(locker, adapters, lockEnd, grace));
        steps[1] = _step("AuctionEngine", salt, engineInit);
        steps[2] = _step("TokenFactory", salt, type(TokenFactory).creationCode);

        // Simulate every call on the current chain (a fork when run with --fork-url).
        require(CREATE2_DEPLOYER.code.length != 0, "no CREATE2 deployer on this chain");
        string memory json;
        for (uint256 i; i < steps.length; ++i) {
            if (steps[i].predicted.code.length == 0) {
                (bool ok,) = CREATE2_DEPLOYER.call(steps[i].data);
                require(ok, string.concat(steps[i].name, ": deploy call failed"));
            }
            require(steps[i].predicted.code.length != 0, string.concat(steps[i].name, ": nothing at predicted address"));
            string memory o = steps[i].name;
            vm.serializeAddress(o, "to", CREATE2_DEPLOYER);
            vm.serializeBytes(o, "data", steps[i].data);
            vm.serializeUint(o, "initcodeBytes", steps[i].data.length - 32);
            string memory item = vm.serializeAddress(o, "address", steps[i].predicted);
            json = vm.serializeString("plan", steps[i].name, item);
            console2.log(steps[i].name, steps[i].predicted, steps[i].data.length);
        }
        AuctionEngine engine = AuctionEngine(payable(steps[1].predicted));
        require(engine.isAdapter(steps[0].predicted), "engine does not allow the adapter");
        require(address(engine.locker()) == locker, "engine locker mismatch");
        vm.writeJson(json, string.concat("deployments/", vm.toString(block.chainid), "-create2-plan.json"));
    }

    function _step(string memory name, bytes32 salt, bytes memory initcode) private pure returns (Step memory s) {
        s.name = name;
        s.data = abi.encodePacked(salt, initcode);
        s.predicted = vm.computeCreate2Address(salt, keccak256(initcode), CREATE2_DEPLOYER);
    }
}
