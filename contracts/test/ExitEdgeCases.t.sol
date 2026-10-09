// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "../src/vendor/openzeppelin/token/ERC20/IERC20.sol";
import {DemoVault} from "../src/exit/DemoVault.sol";
import {ExitAuction} from "../src/exit/ExitAuction.sol";
import {ExitBase} from "./ExitAuction.t.sol";
import {MockWMON} from "./mocks/MockWMON.sol";
import {PayoutVault} from "./mocks/PayoutVault.sol";

/// @notice Exit-auction edge cases added after the mutation run (reports/mutation-summary.md). Each test
///         kills mutants of `ExitAuction.sol` that the earlier suite let survive: constructor checks,
///         stored round windows, settle timing, refunds and quotes for unrevealed bidders, the dust
///         release, and the v2 rule `redeem >= previewRedeem` with the surplus going to the vault.
contract ExitEdgeCasesTest is ExitBase {
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");
    address stayer = makeAddr("stayer");
    PayoutVault pv;

    function setUp() public {
        vm.warp(1_800_000_000);
        vm.roll(1_000);
        wmon = new MockWMON();
        pv = new PayoutVault(IERC20(address(wmon)), strategist);
        vault = pv;
        auction = new ExitAuction(vault, _config());
        vault.setExitAuction(address(auction));
        _join(alice, 10_000 ether);
        _join(bob, 10_000 ether);
        _join(carol, 10_000 ether);
        _join(stayer, 10_000 ether);
        _toStrategy(30_000 ether); // 40k TVL, 10k idle
    }

    function test_Constructor_EveryCheck() public {
        ExitAuction.Config memory c = _config();
        try new ExitAuction(DemoVault(address(0xBEEF)), c) {
            revert("deployment should have reverted");
        } catch Error(string memory why) {
            assertEq(why, "vault has no code");
        }
        c.depositAmount = 0;
        try new ExitAuction(vault, c) {
            revert("deployment should have reverted");
        } catch Error(string memory why) {
            assertEq(why, "zero deposit");
        }
        c = _config();
        c.tickBps = 0;
        try new ExitAuction(vault, c) {
            revert("deployment should have reverted");
        } catch Error(string memory why) {
            assertEq(why, "bad tick");
        }
        c.tickBps = uint16(BPS);
        try new ExitAuction(vault, c) {
            revert("deployment should have reverted");
        } catch Error(string memory why) {
            assertEq(why, "bad tick");
        }
        c.tickBps = uint16(BPS + 1);
        try new ExitAuction(vault, c) {
            revert("deployment should have reverted");
        } catch Error(string memory why) {
            assertEq(why, "bad tick");
        }
        c = _config();
        c.minExitShares = 0;
        try new ExitAuction(vault, c) {
            revert("deployment should have reverted");
        } catch Error(string memory why) {
            assertEq(why, "zero minimum exit");
        }
        c = _config();
        c.maxExitSharesPerRound = 0;
        try new ExitAuction(vault, c) {
            revert("deployment should have reverted");
        } catch Error(string memory why) {
            assertEq(why, "zero max capacity");
        }
        c = _config();
        c.tickBps = uint16(BPS - 1);
        new ExitAuction(vault, c); // the largest tick is accepted
    }

    /// Before the first round, a round can open in the current block; nothing is reserved.
    function test_Views_BeforeTheFirstRound() public view {
        assertEq(auction.nextOpenBlock(), block.number);
        assertEq(auction.reservedShares(), 0);
    }

    /// Windows and the opening block are stored as now + duration and block.number.
    function test_Open_StoresWindowsAndBlock() public {
        vm.roll(1_234);
        uint256 r = auction.openExitRound();
        ExitAuction.ExitRound memory er = auction.getRound(r);
        assertEq(er.commitEnd, block.timestamp + COMMIT);
        assertEq(er.revealEnd, block.timestamp + COMMIT + REVEAL);
        assertEq(er.openedBlock, 1_234);
    }

    function test_Settle_UnknownRound_AndTiming() public {
        vm.expectRevert("unknown round");
        auction.settle(7, 1);
        uint256 r = auction.openExitRound();
        uint96 s = uint96(vault.convertToShares(1_000 ether));
        _commit(r, alice, 100, s);
        _toReveal(r);
        _reveal(r, alice, 100, s);
        vm.warp(auction.getRound(r).revealEnd - 1);
        vm.expectRevert("reveal window open");
        auction.settle(r, 10);
        vm.warp(auction.getRound(r).revealEnd + 1 days); // settling late is fine
        assertTrue(auction.settle(r, 10));
    }

    function test_Reveal_DiscountAboveFullAndMinimumExit() public {
        uint256 r = auction.openExitRound();
        uint96 tooBig = uint96(BPS + TICK);
        _commit(r, alice, tooBig, MIN_EXIT);
        _commit(r, bob, 100, MIN_EXIT);
        _toReveal(r);
        vm.startPrank(alice);
        vault.approve(address(auction), MIN_EXIT);
        vm.expectRevert("discount off grid");
        auction.reveal(r, tooBig, MIN_EXIT, _salt(alice));
        vm.stopPrank();
        _reveal(r, bob, 100, MIN_EXIT); // exactly the minimum exit is accepted
    }

    function test_UnrevealedBidder_NoRefundNoQuote() public {
        uint256 r = auction.openExitRound();
        uint96 s = uint96(vault.convertToShares(1_000 ether));
        _commit(r, alice, 100, s);
        _commit(r, bob, 100, s); // never reveals
        _toReveal(r);
        _reveal(r, alice, 100, s);
        _settle(r);
        vm.expectRevert("not revealed");
        auction.claimRefund(r, bob);
        vm.expectRevert("not revealed");
        auction.quote(r, bob);
        auction.burnUnrevealed(r);
        assertEq(BURN.balance, DEPOSIT);
    }

    /// Oversubscribed with pro-rata dust: once every revealed bid has exited, nothing stays reserved.
    function test_AllExited_NothingStaysReserved() public {
        uint256 r = auction.openExitRound();
        uint256 cap = auction.getRound(r).capacity;
        uint96 a = uint96(cap / 2 + 7);
        uint96 b = uint96(cap / 3 + 11);
        uint96 c = uint96(cap / 3 + 13);
        _commit(r, alice, 100, a);
        _commit(r, bob, 100, b);
        _commit(r, carol, 100, c);
        _toReveal(r);
        _reveal(r, alice, 100, a);
        _reveal(r, bob, 100, b);
        _reveal(r, carol, 100, c);
        _settle(r);
        (, uint256 sold, bool over) = _clearing(r);
        assertTrue(over);
        _claim(r, alice);
        _claim(r, bob);
        _claim(r, carol);
        assertLt(auction.getRound(r).allocatedTotal, sold, "pro-rata dust exists");
        assertEq(auction.pendingExitShares(), 0);
        assertEq(auction.reservedShares(), 0);
    }

    function _oneExit() internal returns (uint256 r, uint256 payout, uint256 donation) {
        r = auction.openExitRound();
        uint96 s = uint96(vault.convertToShares(1_000 ether));
        _commit(r, alice, 100, s);
        _toReveal(r);
        _reveal(r, alice, 100, s);
        _settle(r);
        (,,, payout, donation) = auction.quote(r, alice);
    }

    /// ERC-4626 lets redeem pay more than previewRedeem: the bidder still gets the quoted payout, the
    /// surplus goes to the vault with the donation, and the auction keeps nothing.
    function test_Redeem_SurplusGoesToTheVault() public {
        pv.setAdjust(1);
        (uint256 r, uint256 payout, uint256 donation) = _oneExit();
        uint256 vaultBefore = wmon.balanceOf(address(vault));
        _claim(r, alice);
        assertEq(wmon.balanceOf(alice), payout);
        assertEq(wmon.balanceOf(address(auction)), 0, "auction keeps nothing");
        assertGt(donation, 0);
        // The vault paid assets + 1 and got the donation and the 1-wei surplus back: it lost only the payout.
        assertEq(wmon.balanceOf(address(vault)), vaultBefore - payout);
    }

    function test_Redeem_DoublePayment_AllSurplusToTheVault() public {
        pv.setAdjust(type(int256).max);
        (uint256 r, uint256 payout,) = _oneExit();
        _claim(r, alice);
        assertEq(wmon.balanceOf(alice), payout);
        assertEq(wmon.balanceOf(address(auction)), 0, "auction keeps nothing");
    }

    function test_Redeem_ShortPaymentReverts() public {
        pv.setAdjust(-1);
        (uint256 r,,) = _oneExit();
        vm.prank(alice);
        vm.expectRevert("redeem short");
        auction.claimExit(r, alice);
    }
}
