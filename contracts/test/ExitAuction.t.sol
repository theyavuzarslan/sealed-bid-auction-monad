// SPDX-License-Identifier: LGPL-3.0
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ExitAuction} from "../src/exit/ExitAuction.sol";
import {DemoVault} from "../src/exit/DemoVault.sol";
import {IERC20} from "../src/vendor/openzeppelin/token/ERC20/IERC20.sol";
import {Math} from "../src/vendor/openzeppelin/utils/math/Math.sol";
import {MockWMON} from "./mocks/MockWMON.sol";
import {MerkleProofLib} from "../src/lib/MerkleProofLib.sol";

contract ReentrantExiter {
    ExitAuction public auction;
    uint256 public roundId;
    bool public attempted;
    bool public blocked;

    constructor(ExitAuction a) {
        auction = a;
    }

    function commit(uint256 r, bytes32 h, uint256 deposit) external {
        roundId = r;
        auction.commit{value: deposit}(r, h, new bytes32[](0), "");
    }

    function approveAndReveal(uint96 d, uint96 s, bytes32 salt) external {
        auction.vault().approve(address(auction), s);
        auction.reveal(roundId, d, s, salt);
    }

    function claim() external {
        auction.claim(roundId);
    }

    receive() external payable {
        if (!attempted) {
            attempted = true;
            try auction.claim(roundId) {}
            catch Error(string memory why) {
                blocked = keccak256(bytes(why)) == keccak256("reentrancy");
            }
        }
    }
}

/// A bidder contract whose MON refund can never be delivered.
contract MonRejecter {
    ExitAuction public auction;
    uint256 public roundId;

    constructor(ExitAuction a) {
        auction = a;
    }

    function commit(uint256 r, bytes32 h, uint256 deposit) external {
        roundId = r;
        auction.commit{value: deposit}(r, h, new bytes32[](0), "");
    }

    function approveAndReveal(uint96 d, uint96 s, bytes32 salt) external {
        auction.vault().approve(address(auction), s);
        auction.reveal(roundId, d, s, salt);
    }

    function claim() external {
        auction.claim(roundId);
    }

    receive() external payable {
        revert("no MON");
    }
}

abstract contract ExitBase is Test {
    address constant BURN = 0x000000000000000000000000000000000000dEaD;
    uint256 constant BPS = 10_000;

    uint64 constant COMMIT = 1 hours;
    uint64 constant REVEAL = 1 hours;
    uint96 constant DEPOSIT = 1 ether;
    uint16 constant TICK = 5; // bps
    uint96 constant MIN_EXIT = 1e21; // 1 WMON of shares at the starting price (shares have 21 decimals)
    uint64 constant GAP = 10; // blocks

    MockWMON wmon;
    DemoVault vault;
    ExitAuction auction;
    address strategist = makeAddr("strategist");
    bytes32 allowRoot; // zero: open to every holder

    function _deploy(uint128 maxPerRound) internal {
        vm.warp(1_800_000_000);
        vm.roll(1_000);
        wmon = new MockWMON();
        vault = new DemoVault(IERC20(address(wmon)), strategist);
        auction = new ExitAuction(
            vault,
            ExitAuction.Config({
                commitDuration: COMMIT,
                revealDuration: REVEAL,
                depositAmount: DEPOSIT,
                tickBps: TICK,
                minExitShares: MIN_EXIT,
                maxExitSharesPerRound: maxPerRound,
                roundGapBlocks: GAP,
                allowlistRoot: allowRoot
            })
        );
        vault.setExitAuction(address(auction));
    }

    /// Wrap `assets` MON and deposit into the vault. Returns the shares minted.
    function _join(address who, uint256 assets) internal returns (uint256 shares) {
        vm.deal(who, who.balance + assets + 10 ether);
        vm.startPrank(who);
        wmon.deposit{value: assets}();
        wmon.approve(address(vault), assets);
        shares = vault.deposit(assets, who);
        vm.stopPrank();
    }

    function _toStrategy(uint256 assets) internal {
        vm.prank(strategist);
        vault.moveToStrategy(assets);
    }

    function _salt(address who) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(who)));
    }

    function _commit(uint256 r, address who, uint96 discount, uint96 shares) internal {
        vm.prank(who);
        auction.commit{value: DEPOSIT}(
            r, keccak256(abi.encode(discount, shares, _salt(who), who)), new bytes32[](0), ""
        );
    }

    function _reveal(uint256 r, address who, uint96 discount, uint96 shares) internal {
        vm.startPrank(who);
        vault.approve(address(auction), shares);
        auction.reveal(r, discount, shares, _salt(who));
        vm.stopPrank();
    }

    function _toReveal(uint256 r) internal {
        vm.warp(auction.getRound(r).commitEnd);
    }

    function _toSettle(uint256 r) internal {
        vm.warp(auction.getRound(r).revealEnd);
    }

    function _settle(uint256 r) internal {
        _toSettle(r);
        assertTrue(auction.settle(r, 10_000));
    }

    function _claim(uint256 r, address who) internal {
        vm.prank(who);
        auction.claim(r);
    }

    function _clearing(uint256 r) internal view returns (uint256 p, uint256 sold, bool over) {
        (, p, sold,, over,,) = auction.clearingOf(r);
    }

    /// Value of the winners' allocation at the settlement share price, as the contract computes it.
    function _atSettle(uint256 r, uint256 alloc) internal view returns (uint256) {
        (, uint256 sold,) = _clearing(r);
        return Math.mulDiv(alloc, auction.getRound(r).settleAssets, sold);
    }
}

contract ExitAuctionTest is ExitBase {
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");
    address dave = makeAddr("dave");
    address stayer = makeAddr("stayer");

    uint256 constant EACH = 10_000 ether;

    function setUp() public {
        _deploy(type(uint128).max);
        address[5] memory people = [alice, bob, carol, dave, stayer];
        for (uint256 i; i < people.length; ++i) _join(people[i], EACH);
        _toStrategy(40_000 ether); // 50k TVL: 40k illiquid, 10k idle
    }

    function _sh(address who) internal view returns (uint96) {
        return uint96(vault.balanceOf(who));
    }

    /// Shares worth `assets` at the current price.
    function _worth(uint256 assets) internal view returns (uint96) {
        return uint96(vault.convertToShares(assets));
    }

    // ─── Open ────────────────────────────────────────────────────────────

    function test_Open_CapacityIsIdleBufferInShares() public {
        uint256 expected = vault.convertToShares(vault.idleAssets());
        uint256 r = auction.openExitRound();
        assertEq(r, 1);
        assertEq(auction.getRound(r).capacity, expected);
        assertEq(auction.reservedShares(), expected);
        assertLe(vault.convertToAssets(expected), vault.idleAssets()); // never more than the buffer
        assertApproxEqAbs(vault.convertToAssets(expected), 10_000 ether, 1);
    }

    function test_Open_CapacityCappedPerRound() public {
        _deploy(uint128(5_000e21));
        _join(alice, EACH);
        uint256 r = auction.openExitRound();
        assertEq(auction.getRound(r).capacity, 5_000e21);
    }

    function test_Open_RevertsWhenIdleBufferEmpty() public {
        _toStrategy(vault.idleAssets());
        vm.expectRevert("no exit capacity");
        auction.openExitRound();
    }

    function test_Open_RevertsWhileRoundUnsettled_AndBeforeNBlocks() public {
        uint256 r = auction.openExitRound();
        vm.expectRevert("previous round not settled");
        auction.openExitRound();

        _toSettle(r);
        vm.expectRevert("previous round not settled");
        auction.openExitRound();

        auction.settle(r, 10);
        uint256 settledAt = block.number;
        assertEq(auction.nextOpenBlock(), settledAt + GAP);
        vm.expectRevert("too soon");
        auction.openExitRound();
        vm.roll(settledAt + GAP - 1);
        vm.expectRevert("too soon");
        auction.openExitRound();
        vm.roll(settledAt + GAP);
        assertEq(auction.openExitRound(), 2); // empty round 1: capacity simply rolls over
    }

    // ─── Commit / reveal ────────────────────────────────────────────────

    function test_Reveal_ValidatesDiscountAndSize() public {
        uint256 r = auction.openExitRound();
        uint96 s = _worth(1_000 ether);
        _commit(r, alice, 7, s); // off the 5 bps grid
        _commit(r, bob, 10_000, s); // 100% is not a discount
        _commit(r, carol, 100, MIN_EXIT - 1);
        _toReveal(r);
        vm.startPrank(alice);
        vault.approve(address(auction), s);
        vm.expectRevert("discount off grid");
        auction.reveal(r, 7, s, _salt(alice));
        vm.stopPrank();
        vm.startPrank(bob);
        vault.approve(address(auction), s);
        vm.expectRevert("discount off grid");
        auction.reveal(r, 10_000, s, _salt(bob));
        vm.stopPrank();
        vm.startPrank(carol);
        vault.approve(address(auction), MIN_EXIT);
        vm.expectRevert("below minimum exit");
        auction.reveal(r, 100, MIN_EXIT - 1, _salt(carol));
        vm.stopPrank();
    }

    function test_Commit_WrongDepositAndRoundChecks() public {
        vm.expectRevert("unknown round");
        auction.commit{value: DEPOSIT}(1, bytes32(uint256(1)), new bytes32[](0), "");
        uint256 r = auction.openExitRound();
        vm.deal(address(this), 10 ether);
        vm.expectRevert("wrong deposit");
        auction.commit{value: DEPOSIT - 1}(r, bytes32(uint256(1)), new bytes32[](0), "");
    }

    function test_Reveal_PullsSharesIntoEscrow() public {
        uint256 r = auction.openExitRound();
        uint96 s = _worth(2_000 ether);
        uint256 before = vault.balanceOf(alice);
        _commit(r, alice, 100, s);
        _toReveal(r);
        _reveal(r, alice, 100, s);
        assertEq(vault.balanceOf(alice), before - s);
        assertEq(vault.balanceOf(address(auction)), s);
        assertEq(auction.getRound(r).escrowed, s);
    }

    function test_RevealWithoutShares_Reverts_DepositBurnable() public {
        uint256 r = auction.openExitRound();
        uint96 tooMany = _sh(alice) + 1;
        _commit(r, alice, 100, tooMany);
        _commit(r, bob, 100, _worth(1_000 ether));
        _toReveal(r);
        vm.startPrank(alice);
        vault.approve(address(auction), tooMany);
        vm.expectRevert("transferFrom failed");
        auction.reveal(r, 100, tooMany, _salt(alice));
        vm.stopPrank();
        _reveal(r, bob, 100, _worth(1_000 ether));

        // Alice's commitment stays unrevealed; after the window her deposit is burned.
        vm.expectRevert("reveal window open");
        auction.burnUnrevealed(r);
        _toSettle(r);
        uint256 burnBefore = BURN.balance;
        auction.burnUnrevealed(r);
        assertEq(BURN.balance - burnBefore, DEPOSIT);
        vm.expectRevert("not revealed");
        _claim(r, alice);

        auction.settle(r, 10);
        _claim(r, bob);
        assertEq(address(auction).balance, 0);
        assertEq(auction.roundBalance(r), 0);
    }

    // ─── Clearing and claims ────────────────────────────────────────────

    /// Capacity 10k. Alice 4k at 300, Bob 4k at 200 exit in full; Carol 3k and Dave 3k at 100 share the
    /// last 2k pro-rata; the stayer never bids. Everyone who exits pays P = 100 bps.
    function test_Oversubscribed_ProRataAtClearingDiscount() public {
        uint256 r = auction.openExitRound();
        uint256 cap = auction.getRound(r).capacity;
        uint96 four = _worth(4_000 ether);
        uint96 three = _worth(3_000 ether);
        _commit(r, alice, 300, four);
        _commit(r, bob, 200, four);
        _commit(r, carol, 100, three);
        _commit(r, dave, 100, three);
        _toReveal(r);
        _reveal(r, alice, 300, four);
        _reveal(r, bob, 200, four);
        _reveal(r, carol, 100, three);
        _reveal(r, dave, 100, three);
        _settle(r);

        (uint256 p, uint256 sold, bool over) = _clearing(r);
        assertEq(p, 100);
        assertEq(sold, cap);
        assertTrue(over);

        uint256 stayerShares = vault.balanceOf(stayer);
        uint256 stayerBefore = vault.convertToAssets(stayerShares);
        uint256 carolKeeps = vault.balanceOf(carol);

        address[4] memory who = [alice, bob, carol, dave];
        uint256[4] memory alloc;
        uint256[4] memory payout;
        uint256 sumAlloc;
        uint256 sumAtSettle;
        uint256 sumPayout;
        for (uint256 i; i < 4; ++i) {
            (alloc[i],,, payout[i],) = auction.quote(r, who[i]);
            uint256 ethBefore = who[i].balance;
            _claim(r, who[i]);
            assertEq(wmon.balanceOf(who[i]), payout[i], "payout");
            assertEq(who[i].balance - ethBefore, DEPOSIT, "full deposit back");
            // Winners receive the allocation's value at (1 - P), rounded down.
            assertEq(payout[i], _atSettle(r, alloc[i]) * (BPS - p) / BPS);
            sumAlloc += alloc[i];
            sumAtSettle += _atSettle(r, alloc[i]);
            sumPayout += payout[i];
        }
        // Above P: full; at P: pro-rata of what is left, rounded down.
        assertEq(alloc[0], four);
        assertEq(alloc[1], four);
        uint256 left = cap - 2 * uint256(four);
        assertEq(alloc[2], uint256(three) * left / (2 * uint256(three)));
        assertEq(alloc[3], alloc[2]);
        assertLe(sumAlloc, cap, "nobody exits above capacity");
        assertGe(sumAlloc + 2, cap);
        // Carol's unfilled shares came back.
        assertEq(vault.balanceOf(carol), carolKeeps + three - alloc[2]);
        // Roughly 1% of 10k WMON stayed in the vault.
        assertApproxEqRel(sumAtSettle - sumPayout, 100 ether, 1e15);

        // Stayers: the share price rises by the discount kept, over the remaining supply.
        uint256 stayerAfter = vault.convertToAssets(stayerShares);
        uint256 expectedGain = stayerShares * (sumAtSettle - sumPayout) / (vault.totalSupply() + 1e3);
        assertApproxEqAbs(stayerAfter - stayerBefore, expectedGain, 10);

        // Nothing left behind.
        _assertEmpty(r);
    }

    function test_Undersubscribed_AllExit_AtLowestDiscount() public {
        uint256 r = auction.openExitRound();
        uint96 a = _worth(1_000 ether);
        uint96 b = _worth(2_000 ether);
        uint256 aliceShares = vault.balanceOf(alice);
        _commit(r, alice, 250, a);
        _commit(r, bob, 50, b);
        _toReveal(r);
        _reveal(r, alice, 250, a);
        _reveal(r, bob, 50, b);
        _settle(r);
        (uint256 p, uint256 sold, bool over) = _clearing(r);
        assertEq(p, 50);
        assertEq(sold, uint256(a) + b);
        assertFalse(over);
        _claim(r, alice);
        _claim(r, bob);
        // Alice bid 250 but pays the clearing discount of 50.
        assertEq(wmon.balanceOf(alice), _atSettle(r, a) * (BPS - 50) / BPS);
        assertApproxEqAbs(wmon.balanceOf(alice), 995 ether, 1e6);
        assertEq(vault.balanceOf(alice), aliceShares - a); // everything bid was redeemed
        _assertEmpty(r);
    }

    function test_ZeroDiscountIsLegal() public {
        uint256 r = auction.openExitRound();
        uint96 a = _worth(1_000 ether);
        _commit(r, alice, 0, a);
        _toReveal(r);
        _reveal(r, alice, 0, a);
        _settle(r);
        (uint256 p,,) = _clearing(r);
        assertEq(p, 0);
        uint256 tvlBefore = vault.totalAssets();
        _claim(r, alice);
        assertEq(wmon.balanceOf(alice), _atSettle(r, a));
        assertApproxEqAbs(tvlBefore - vault.totalAssets(), 1_000 ether, 1e6);
        _assertEmpty(r);
    }

    function test_Loser_GetsAllSharesBack() public {
        uint256 r = auction.openExitRound();
        uint96 big = _worth(9_000 ether);
        uint96 small = _worth(3_000 ether);
        _commit(r, alice, 500, big);
        _commit(r, bob, 400, big); // takes the last 1k at P = 400
        _commit(r, carol, 100, small); // below P
        _toReveal(r);
        _reveal(r, alice, 500, big);
        _reveal(r, bob, 400, big);
        _reveal(r, carol, 100, small);
        _settle(r);
        (uint256 p,,) = _clearing(r);
        assertEq(p, 400);
        uint256 carolBefore = vault.balanceOf(carol);
        uint256 carolMon = carol.balance;
        _claim(r, carol);
        assertEq(vault.balanceOf(carol), carolBefore + small);
        assertEq(wmon.balanceOf(carol), 0);
        assertEq(carol.balance - carolMon, DEPOSIT);
        _claim(r, alice);
        _claim(r, bob);
        _assertEmpty(r);
    }

    function test_Claim_OnceOnly_AndOnlyWhenSettled() public {
        uint256 r = auction.openExitRound();
        uint96 a = _worth(1_000 ether);
        _commit(r, alice, 100, a);
        _toReveal(r);
        _reveal(r, alice, 100, a);
        vm.expectRevert("not settled");
        _claim(r, alice);
        _settle(r);
        vm.expectRevert("not revealed");
        _claim(r, bob);
        _claim(r, alice);
        vm.expectRevert("nothing to claim");
        _claim(r, alice);
        vm.expectRevert("exit already claimed");
        auction.claimExit(r, alice);
        vm.expectRevert("already settled");
        auction.claimRefund(r, alice);
    }

    /// Anyone can trigger either part; funds always go to the bidder. A bidder who never shows up
    /// cannot hold up the round's accounting.
    function test_AnyoneCanTriggerClaims_FundsGoToBidder() public {
        uint256 r = auction.openExitRound();
        uint96 a = _worth(1_000 ether);
        _commit(r, alice, 100, a);
        _toReveal(r);
        _reveal(r, alice, 100, a);
        _settle(r);
        (,,, uint256 payout,) = auction.quote(r, alice);
        uint256 monBefore = alice.balance;
        address keeper = makeAddr("keeper");
        vm.startPrank(keeper);
        auction.claimExit(r, alice);
        auction.claimRefund(r, alice);
        vm.stopPrank();
        assertEq(wmon.balanceOf(alice), payout);
        assertEq(alice.balance - monBefore, DEPOSIT);
        assertEq(wmon.balanceOf(keeper), 0);
        assertEq(keeper.balance, 0);
        assertEq(auction.pendingExitShares(), 0);
        _assertEmpty(r);
    }

    /// The MON refund never depends on the exit side: with redemption failing, the deposit still comes back.
    function test_RefundIndependentOfExit() public {
        uint256 r = auction.openExitRound();
        uint96 a = _worth(1_000 ether);
        _commit(r, alice, 100, a);
        _toReveal(r);
        _reveal(r, alice, 100, a);
        vm.expectRevert("not settled");
        auction.claimRefund(r, alice);
        _settle(r);

        vm.mockCallRevert(address(vault), abi.encodeWithSelector(vault.redeem.selector), "vault paused");
        vm.expectRevert("vault paused");
        _claim(r, alice);
        uint256 monBefore = alice.balance;
        auction.claimRefund(r, alice);
        assertEq(alice.balance - monBefore, DEPOSIT);
        assertEq(auction.roundBalance(r), 0);

        vm.clearMockedCalls();
        _claim(r, alice); // exit only: the refund is done
        assertGt(wmon.balanceOf(alice), 0);
        _assertEmpty(r);
    }

    /// And the exit never depends on the MON refund: a bidder that rejects MON still exits.
    function test_ExitIndependentOfRefund() public {
        MonRejecter bad = new MonRejecter(auction);
        vm.deal(address(bad), 10 ether);
        _join(address(this), 1_000 ether);
        uint96 s = uint96(vault.balanceOf(address(this)));
        vault.transfer(address(bad), s);
        uint256 r = auction.openExitRound();
        bad.commit(r, keccak256(abi.encode(uint96(100), s, bytes32("x"), address(bad))), DEPOSIT);
        _toReveal(r);
        bad.approveAndReveal(100, s, bytes32("x"));
        _settle(r);
        vm.expectRevert("send failed");
        bad.claim();
        auction.claimExit(r, address(bad));
        assertGt(wmon.balanceOf(address(bad)), 0);
        assertEq(auction.pendingExitShares(), 0);
        vm.expectRevert("send failed");
        auction.claimRefund(r, address(bad)); // stays claimable; nobody else can take it
        assertEq(auction.roundBalance(r), DEPOSIT);
    }

    /// Winners are paid on the settlement share price, so claim order cannot move money between them.
    function test_ClaimOrder_DoesNotChangePayouts() public {
        uint96 s = _worth(5_000 ether);
        uint256 snap = vm.snapshotState();
        uint256[2] memory first;
        uint256[2] memory second;
        for (uint256 pass; pass < 2; ++pass) {
            vm.revertToState(snap);
            uint256 r = auction.openExitRound();
            _commit(r, alice, 200, s);
            _commit(r, bob, 200, s);
            _toReveal(r);
            _reveal(r, alice, 200, s);
            _reveal(r, bob, 200, s);
            _settle(r);
            if (pass == 0) {
                _claim(r, alice);
                _claim(r, bob);
                first = [wmon.balanceOf(alice), wmon.balanceOf(bob)];
            } else {
                _claim(r, bob);
                _claim(r, alice);
                second = [wmon.balanceOf(alice), wmon.balanceOf(bob)];
            }
        }
        assertEq(first[0], second[0]);
        assertEq(first[1], second[1]);
    }

    function test_Claim_ReentrancyBlocked() public {
        ReentrantExiter bad = new ReentrantExiter(auction);
        vm.deal(address(bad), 10 ether);
        _join(address(this), 1_000 ether);
        uint96 s = uint96(vault.balanceOf(address(this)));
        vault.transfer(address(bad), s);
        uint256 r = auction.openExitRound();
        bad.commit(r, keccak256(abi.encode(uint96(100), s, bytes32("x"), address(bad))), DEPOSIT);
        _toReveal(r);
        bad.approveAndReveal(100, s, bytes32("x"));
        _settle(r);
        bad.claim();
        assertTrue(bad.attempted());
        assertTrue(bad.blocked());
        _assertEmpty(r);
    }

    // ─── Across rounds ──────────────────────────────────────────────────

    /// Three rounds, the strategy unwinding between them. After each round the stayer's value rises
    /// by the discount kept in the vault, spread over the remaining supply.
    function test_StayersGainEveryRound() public {
        address[4] memory exiters = [alice, bob, carol, dave];
        uint96[3] memory discounts = [uint96(50), 150, 400];
        uint256 stayerShares = vault.balanceOf(stayer);
        for (uint256 k; k < 3; ++k) {
            if (k != 0) {
                vm.roll(block.number + GAP);
                vm.prank(strategist);
                vault.moveToIdle(8_000 ether);
            }
            uint256 r = auction.openExitRound();
            uint256 cap = auction.getRound(r).capacity;
            for (uint256 i; i < 4; ++i) {
                uint96 s = uint96(Math.min(vault.balanceOf(exiters[i]), cap / 2));
                uint96 d = discounts[k] + uint96(i) * 10;
                _commit(r, exiters[i], d, s);
            }
            _toReveal(r);
            for (uint256 i; i < 4; ++i) {
                uint96 s = uint96(Math.min(vault.balanceOf(exiters[i]), cap / 2));
                _reveal(r, exiters[i], discounts[k] + uint96(i) * 10, s);
            }
            _settle(r);
            uint256 before = vault.convertToAssets(stayerShares);
            uint256 kept;
            for (uint256 i; i < 4; ++i) {
                (uint256 alloc,,, uint256 payout,) = auction.quote(r, exiters[i]);
                kept += _atSettle(r, alloc) - payout;
                _claim(r, exiters[i]);
            }
            uint256 gain = vault.convertToAssets(stayerShares) - before;
            assertGt(gain, 0);
            assertApproxEqAbs(gain, stayerShares * kept / (vault.totalSupply() + 1e3), 10);
            _assertEmpty(r);
        }
        // The stayer never bid, and is up by the discounts that exiting holders paid.
        assertGt(vault.convertToAssets(stayerShares), EACH);
    }

    /// A settled winner who has not claimed keeps their idle WMON reserved: the next round's capacity
    /// excludes it and the strategist cannot move it.
    function test_UnclaimedWinner_StaysPayable() public {
        uint256 r1 = auction.openExitRound();
        uint96 s = _worth(6_000 ether);
        _commit(r1, alice, 100, s);
        _toReveal(r1);
        _reveal(r1, alice, 100, s);
        vm.prank(strategist);
        vm.expectRevert("idle reserved for exits");
        vault.moveToStrategy(1 ether); // the whole buffer backs round 1's capacity
        _settle(r1);
        assertEq(auction.pendingExitShares(), s);

        // Only the unreserved ~4k of idle is free.
        uint256 free = vault.idleAssets() - vault.previewMint(s);
        vm.prank(strategist);
        vm.expectRevert("idle reserved for exits");
        vault.moveToStrategy(free + 1);

        vm.roll(block.number + GAP);
        uint256 r2 = auction.openExitRound();
        assertEq(auction.getRound(r2).capacity, vault.convertToShares(free));
        uint96 s2 = uint96(auction.getRound(r2).capacity);
        _commit(r2, bob, 100, s2);
        _toReveal(r2);
        _reveal(r2, bob, 100, s2);
        _settle(r2);

        // Both rounds pay in full, in either order.
        _claim(r2, bob);
        _claim(r1, alice);
        assertApproxEqRel(wmon.balanceOf(alice), 5_940 ether, 1e15);
        _assertEmpty(r1);
        _assertEmpty(r2);
        assertEq(auction.pendingExitShares(), 0);
        assertEq(vault.reservedAssets(), 0);
    }

    function test_OnlyTheExitAuctionCanRedeem() public {
        vm.startPrank(alice);
        uint256 s = vault.balanceOf(alice);
        assertEq(vault.maxRedeem(alice), 0);
        vm.expectRevert();
        vault.redeem(s, alice, alice);
        vm.expectRevert();
        vault.withdraw(1 ether, alice, alice);
        vm.stopPrank();
    }

    function _assertEmpty(uint256 r) internal view {
        ExitAuction.ExitRound memory x = auction.getRound(r);
        (uint64 commits, uint64 reveals, uint64 claims,) = auction.ledgers(r);
        if (claims != reveals || x.exitsClaimed != reveals) return;
        assertEq(x.escrowed, x.allocatedTotal + x.returnedTotal, "escrowed = redeemed + returned");
        assertEq(wmon.balanceOf(address(auction)), 0, "no WMON left");
        if (commits == reveals) assertEq(auction.roundBalance(r), 0, "no MON left");
        assertEq(x.assetsRedeemed, x.paidOut + x.donated, "assets = paid + donated");
    }
}

/// Random bid sets: shares and assets are conserved and nothing is left in the exit auction.
contract ExitAuctionFuzzTest is ExitBase {
    uint256 constant N = 6;
    address[N] bidders;

    function setUp() public {
        _deploy(type(uint128).max);
        for (uint256 i; i < N; ++i) {
            bidders[i] = address(uint160(0xB1D000 + i));
            _join(bidders[i], 10_000 ether);
        }
        _join(makeAddr("stayer"), 10_000 ether);
    }

    struct Pre {
        uint256 tvl;
        uint256 supply;
        uint256 sharesInAuction;
        uint256 monInAuction;
    }

    function testFuzz_Conservation(uint256 seed, uint256 idleBps) public {
        idleBps = bound(idleBps, 100, 10_000);
        _toStrategy(vault.totalAssets() * (10_000 - idleBps) / 10_000);
        uint256 r = auction.openExitRound();
        uint256 cap = auction.getRound(r).capacity;

        uint96[N] memory d;
        uint96[N] memory s;
        bool[N] memory reveals;
        for (uint256 i; i < N; ++i) {
            uint256 h = uint256(keccak256(abi.encode(seed, i)));
            d[i] = uint96((h % 40) * 250 % BPS); // coarse grid so ties at P are common
            if (h % 7 == 0) d[i] = uint96(((h >> 8) % (BPS / TICK)) * TICK);
            s[i] = uint96(bound(h >> 32, MIN_EXIT, vault.balanceOf(bidders[i])));
            reveals[i] = (h >> 128) % 5 != 0;
            _commit(r, bidders[i], d[i], s[i]);
        }
        _toReveal(r);
        uint256 escrowed;
        uint256 revealed;
        for (uint256 i; i < N; ++i) {
            if (!reveals[i]) continue;
            _reveal(r, bidders[i], d[i], s[i]);
            escrowed += s[i];
            revealed++;
        }
        _settle(r);
        (uint256 p, uint256 sold,) = _clearing(r);
        assertLe(sold, cap);
        assertEq(vault.balanceOf(address(auction)), escrowed);
        if (revealed != N) auction.burnUnrevealed(r);

        uint256 tvlBefore = vault.totalAssets();
        uint256 sumAlloc;
        uint256 sumPayout;
        for (uint256 i; i < N; ++i) {
            if (!reveals[i]) continue;
            (uint256 alloc, uint256 back,, uint256 payout,) = auction.quote(r, bidders[i]);
            uint256 sharesBefore = vault.balanceOf(bidders[i]);
            if (uint256(keccak256(abi.encode(seed, "keeper", i))) % 2 == 0) {
                _claim(r, bidders[i]);
            } else {
                auction.claimRefund(r, bidders[i]); // a keeper, in the other order
                auction.claimExit(r, bidders[i]);
            }
            assertEq(alloc + back, s[i]);
            assertEq(vault.balanceOf(bidders[i]) - sharesBefore, back, "unfilled shares back");
            assertEq(wmon.balanceOf(bidders[i]), payout, "payout");
            assertEq(payout, _atSettle(r, alloc) * (BPS - p) / BPS, "(1 - P) of value at settlement");
            if (d[i] > p) assertEq(alloc, s[i], "above P fills in full");
            if (d[i] < p) assertEq(alloc, 0, "below P gets nothing");
            sumAlloc += alloc;
            sumPayout += payout;
        }
        ExitAuction.ExitRound memory x = auction.getRound(r);
        assertLe(sumAlloc, cap, "never above capacity");
        assertLe(sumAlloc, sold);
        assertEq(x.escrowed, escrowed);
        assertEq(x.escrowed, x.allocatedTotal + x.returnedTotal, "escrowed = redeemed + returned");
        assertEq(vault.balanceOf(address(auction)), 0, "no shares left");
        assertEq(wmon.balanceOf(address(auction)), 0, "no WMON left");
        assertEq(address(auction).balance, 0, "no MON left");
        assertEq(auction.roundBalance(r), 0);
        assertEq(x.assetsRedeemed, x.paidOut + x.donated);
        assertEq(tvlBefore - vault.totalAssets(), sumPayout, "only payouts leave the vault");
        assertEq(auction.pendingExitShares(), 0);
        assertEq(auction.reservedShares(), 0);
    }
}

/// PRD preset table, Vault row: "Allowlist: Configurable". A root fixed at deployment limits who may
/// bid; holders off the list cannot commit, and a proof works only for its own address.
contract ExitAllowlistTest is ExitBase {
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");

    function setUp() public {
        bytes32 la = MerkleProofLib.leafOf(alice);
        bytes32 lb = MerkleProofLib.leafOf(bob);
        allowRoot = la < lb ? keccak256(abi.encode(la, lb)) : keccak256(abi.encode(lb, la));
        _deploy(type(uint128).max);
        _join(alice, 10_000 ether);
        _join(bob, 10_000 ether);
        _join(carol, 10_000 ether);
    }

    function test_Allowlist_OnlyListedHoldersBid() public {
        assertEq(auction.allowlistRoot(), allowRoot);
        uint256 r = auction.openExitRound();
        bytes32[] memory proofAlice = new bytes32[](1);
        proofAlice[0] = MerkleProofLib.leafOf(bob);
        bytes32[] memory proofBob = new bytes32[](1);
        proofBob[0] = MerkleProofLib.leafOf(alice);

        vm.prank(alice);
        auction.commit{value: DEPOSIT}(r, bytes32(uint256(1)), proofAlice, "");
        vm.prank(bob);
        auction.commit{value: DEPOSIT}(r, bytes32(uint256(2)), proofBob, "");

        vm.prank(carol);
        vm.expectRevert("not on allowlist");
        auction.commit{value: DEPOSIT}(r, bytes32(uint256(3)), proofAlice, "");
        vm.prank(carol);
        vm.expectRevert("not on allowlist");
        auction.commit{value: DEPOSIT}(r, bytes32(uint256(3)), new bytes32[](0), "");
    }
}
