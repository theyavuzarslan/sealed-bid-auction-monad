// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {EngineBase} from "./AuctionEngine.t.sol";
import {AuctionEngine} from "../src/AuctionEngine.sol";

/// A bidder contract that commits and reveals normally but rejects every MON transfer.
contract MonRejectingBidder {
    AuctionEngine immutable engine;

    constructor(AuctionEngine e) payable {
        engine = e;
    }

    function commit(uint256 r, bytes32 h, uint256 deposit) external {
        engine.commit{value: deposit}(r, h, new bytes32[](0), "");
    }

    function reveal(uint256 r, uint96 p, uint96 a, bytes32 s) external {
        engine.reveal(r, p, a, s);
    }

    receive() external payable {
        revert("no MON");
    }
}

/// @notice Behaviour found while triaging static-analysis output (STATIC-ANALYSIS.md, "Manual
///         observations"). These tests pin the *current* behaviour so the main session can decide
///         whether to change it; they are not regressions of a fix.
contract ObservationsTest is EngineBase {
    /// O1: refunds are pushed, so a winner that cannot receive MON can never be settled. Its own refund
    /// and tokens are stuck (its loss), but so are the creator's share of its payment and the dust sweep,
    /// because `sweepDust` waits for `claims == reveals`. Other bidders are unaffected.
    function test_O1_MonRejectingWinner_BlocksItsPaymentAndDustSweep() public {
        uint256 r = _open(_params(AuctionEngine.Preset.Degen));
        MonRejectingBidder griefer = new MonRejectingBidder(engine);
        vm.deal(address(griefer), DEPOSIT);

        uint96 gp = 0.003 ether;
        uint96 ga = 300e18;
        bytes32 salt = keccak256("griefer");
        griefer.commit(r, keccak256(abi.encode(gp, ga, salt, address(griefer))), DEPOSIT);
        _commit(r, alice, 0.005 ether, 400e18);
        _commit(r, bob, 0.004 ether, 400e18);
        _commit(r, carol, 0.003 ether, 300e18);
        _toReveal(r);
        griefer.reveal(r, gp, ga, salt);
        _reveal(r, alice, 0.005 ether, 400e18);
        _reveal(r, bob, 0.004 ether, 400e18);
        _reveal(r, carol, 0.003 ether, 300e18);
        _toSettle(r);
        assertTrue(engine.settle(r, 100));
        engine.seedLP(r);

        _claim(r, alice);
        _claim(r, bob);
        _claim(r, carol);
        (uint256 alloc, uint256 paid,) = engine.quote(r, address(griefer));
        assertGt(alloc, 0, "griefer is a winner");

        // Nobody can settle the griefer's account: every path pushes its refund first.
        vm.expectRevert("send failed");
        engine.claimRefund(r, address(griefer));
        vm.expectRevert("send failed");
        engine.claimTokens(r, address(griefer));

        // The creator's share of the griefer's payment is never collected, and dust is never swept.
        uint256 available = engine.creatorAvailable(r);
        AuctionEngine.Round memory rd = engine.getRound(r);
        assertEq(paid, 0.3 ether, "griefer owes 100 tokens x 0.003");
        assertEq(rd.collected, 2.7 ether, "only Alice, Bob and Carol's payments are collected");
        vm.prank(creator);
        engine.withdrawProceeds(r);
        assertEq(creator.balance, 1000 ether + available);
        vm.expectRevert("refunds outstanding");
        engine.sweepDust(r);
        // The griefer's whole deposit stays in the round, accounted for but unreachable.
        assertEq(engine.roundBalance(r), DEPOSIT);
    }
}
