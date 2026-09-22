// SPDX-License-Identifier: LGPL-3.0
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {SealingLayer} from "../src/SealingLayer.sol";
import {ClearingCore} from "../src/ClearingCore.sol";
import {DepositLedger} from "../src/DepositLedger.sol";
import {LPSeeder} from "../src/LPSeeder.sol";
import {ExitAdapter} from "../src/ExitAdapter.sol";

contract Deploy is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");

        vm.startBroadcast(deployerKey);
        SealingLayer sealingLayer = new SealingLayer();
        ClearingCore clearingCore = new ClearingCore();
        DepositLedger depositLedger = new DepositLedger();
        LPSeeder lpSeeder = new LPSeeder();
        ExitAdapter exitAdapter = new ExitAdapter();
        vm.stopBroadcast();

        // TODO: not specified — wiring between sealing layer, clearing core,
        // deposit ledger, LP seeder and exit adapter (grant/settable roles)
        // is undefined in 03-architecture.md / 06-api.md. Add once the
        // contracts expose their linkage functions.
        // TODO: not specified — constructor parameters for each contract
        // (e.g. slash destination in DepositLedger) are per-agent decisions;
        // update this script when core/fork land their parameters.

        // addresses go to a json file for the deploy log and the indexer env
        vm.serializeAddress("deployed", "sealingLayer", address(sealingLayer));
        vm.serializeAddress("deployed", "clearingCore", address(clearingCore));
        vm.serializeAddress("deployed", "depositLedger", address(depositLedger));
        vm.serializeAddress("deployed", "lpSeeder", address(lpSeeder));
        string memory json = vm.serializeAddress("deployed", "exitAdapter", address(exitAdapter));
        vm.createDir("deployments", true);
        vm.writeJson(json, "deployments/monad-testnet.json");
    }
}
