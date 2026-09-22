// SPDX-License-Identifier: LGPL-3.0
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ExitAuction} from "../src/exit/ExitAuction.sol";
import {DemoVault} from "../src/exit/DemoVault.sol";
import {IERC20} from "../src/vendor/openzeppelin/token/ERC20/IERC20.sol";
import {MockWMON} from "./mocks/MockWMON.sol";

contract DemoVaultTest is Test {
    MockWMON wmon;
    DemoVault vault;
    address strategist = makeAddr("strategist");
    address attacker = makeAddr("attacker");
    address victim = makeAddr("victim");

    function setUp() public {
        wmon = new MockWMON();
        vault = new DemoVault(IERC20(address(wmon)), strategist);
    }

    function _wrap(address who, uint256 amount) internal {
        vm.deal(who, amount);
        vm.prank(who);
        wmon.deposit{value: amount}();
    }

    function _deposit(address who, uint256 amount) internal returns (uint256 shares) {
        _wrap(who, amount);
        vm.startPrank(who);
        wmon.approve(address(vault), amount);
        shares = vault.deposit(amount, who);
        vm.stopPrank();
    }

    function _auction() internal returns (ExitAuction) {
        return new ExitAuction(
            vault,
            ExitAuction.Config({
                commitDuration: 1 hours,
                revealDuration: 1 hours,
                depositAmount: 1 ether,
                tickBps: 5,
                minExitShares: 1e21,
                maxExitSharesPerRound: type(uint128).max,
                roundGapBlocks: 1
            })
        );
    }

    // ─── Idle buffer and strategy ───────────────────────────────────────

    function test_TotalAssetsCountsIdleAndStrategy() public {
        _deposit(victim, 1_000 ether);
        vm.prank(strategist);
        vault.moveToStrategy(700 ether);
        assertEq(vault.idleAssets(), 300 ether);
        assertEq(vault.strategyAssets(), 700 ether);
        assertEq(vault.totalAssets(), 1_000 ether);
        vm.prank(strategist);
        vault.moveToIdle(200 ether);
        assertEq(vault.idleAssets(), 500 ether);
        assertEq(vault.totalAssets(), 1_000 ether);
        // Moving the mark never changes the share price.
        assertEq(vault.convertToAssets(vault.balanceOf(victim)), 1_000 ether);
    }

    function test_OnlyStrategistMovesAssets() public {
        _deposit(victim, 1_000 ether);
        vm.expectRevert("not strategist");
        vault.moveToStrategy(1);
        vm.expectRevert("not strategist");
        vault.moveToIdle(1);
        vm.startPrank(strategist);
        vm.expectRevert("idle reserved for exits");
        vault.moveToStrategy(1_000 ether + 1);
        vm.expectRevert(); // underflow: nothing in the strategy
        vault.moveToIdle(1);
        vm.stopPrank();
    }

    function test_SetExitAuction_OnceByDeployer_MustPointBack() public {
        ExitAuction a = _auction();
        vm.prank(attacker);
        vm.expectRevert("not deployer");
        vault.setExitAuction(address(a));

        DemoVault other = new DemoVault(IERC20(address(wmon)), strategist);
        vm.expectRevert("exit auction for another vault");
        other.setExitAuction(address(a));

        vault.setExitAuction(address(a));
        vm.expectRevert("already set");
        vault.setExitAuction(address(a));
    }

    function test_NobodyRedeemsBeforeTheExitAuctionIsSet() public {
        uint256 s = _deposit(victim, 1_000 ether);
        assertEq(vault.maxRedeem(victim), 0);
        assertEq(vault.maxWithdraw(victim), 0);
        vm.prank(victim);
        vm.expectRevert();
        vault.redeem(s, victim, victim);
    }

    // ─── Inflation attack ───────────────────────────────────────────────

    /// The classic first-depositor attack: deposit 1 wei, donate a lot, let the victim's deposit round
    /// down. With 3 decimals of virtual shares the attacker loses about 1000x what the victim loses,
    /// so the attack never pays.
    function testFuzz_InflationAttackDoesNotPay(uint256 donation, uint256 deposit) public {
        donation = bound(donation, 0, 1e30);
        deposit = bound(deposit, 1, 1e30);

        uint256 aShares = _deposit(attacker, 1);
        _wrap(attacker, donation);
        vm.prank(attacker);
        wmon.transfer(address(vault), donation); // donation: no shares minted
        uint256 vShares = _deposit(victim, deposit);

        uint256 attackerCost = 1 + donation;
        uint256 attackerValue = vault.convertToAssets(aShares);
        uint256 victimValue = vault.convertToAssets(vShares);
        assertLe(attackerValue, attackerCost, "attacker never profits");

        uint256 attackerLoss = attackerCost - attackerValue;
        uint256 victimLoss = deposit > victimValue ? deposit - victimValue : 0;
        // The victim's loss is at most one share's worth, which is ~donation / 2000 here, while the
        // attacker forfeits about half the donation to the virtual shares.
        assertLe(victimLoss, donation / 1000 + 2, "victim loss bounded by donation / 1000");
        if (victimLoss > 2) assertGe(attackerLoss, victimLoss * 400, "attack costs far more than it takes");
    }

    /// The front-run the attack needs: a 10k WMON victim deposit after a 10k WMON donation.
    function test_InflationAttack_ConcreteCase() public {
        uint256 aShares = _deposit(attacker, 1);
        _wrap(attacker, 10_000 ether);
        vm.prank(attacker);
        wmon.transfer(address(vault), 10_000 ether);
        uint256 vShares = _deposit(victim, 10_000 ether);
        assertGt(vShares, 0, "victim is not rounded to zero shares");
        assertApproxEqRel(vault.convertToAssets(vShares), 10_000 ether, 1e15); // within 0.1%
        assertGt(10_000 ether - vault.convertToAssets(aShares), 4_990 ether); // attacker lost ~half the donation
    }
}
