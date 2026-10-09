// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "../../src/vendor/openzeppelin/token/ERC20/IERC20.sol";
import {DemoVault} from "../../src/exit/DemoVault.sol";
import {ExitAuction} from "../../src/exit/ExitAuction.sol";
import {MockWMON} from "../mocks/MockWMON.sol";

/// Symbolic proof for the exit auction's window bounds (PROPERTIES.md W2).
///
/// Run: forge test --symbolic --match-contract ExitProofs --symbolic-timeout 600
contract ExitProofs is Test {
    DemoVault vault;

    function setUp() public {
        vm.warp(1_800_000_000);
        MockWMON wmon = new MockWMON();
        vault = new DemoVault(IERC20(address(wmon)), address(0x5747));
    }

    /// W2: the constructor accepts the two durations if and only if each is between 5 minutes and
    /// 30 days (every other parameter valid). The upper bound keeps the stored round ends far inside
    /// uint64.
    function prove_W2_ExitWindowsIff(uint64 commitDuration, uint64 revealDuration) public {
        (bool ok,) = address(this).call(abi.encodeCall(this.deploy, (commitDuration, revealDuration)));
        bool expected = commitDuration >= 5 minutes && commitDuration <= 30 days && revealDuration >= 5 minutes
            && revealDuration <= 30 days;
        assert(ok == expected);
    }

    /// Deploys an exit auction with the given windows and otherwise valid terms; reverts if the
    /// constructor does.
    function deploy(uint64 commitDuration, uint64 revealDuration) external returns (address) {
        ExitAuction.Config memory c = ExitAuction.Config({
            commitDuration: commitDuration,
            revealDuration: revealDuration,
            depositAmount: 1 ether,
            tickBps: 50,
            minExitShares: 1e18,
            maxExitSharesPerRound: type(uint128).max,
            roundGapBlocks: 10,
            allowlistRoot: bytes32(0)
        });
        return address(new ExitAuction(vault, c));
    }
}
