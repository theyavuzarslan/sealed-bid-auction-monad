// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {EngineBase} from "./AuctionEngine.t.sol";
import {AuctionEngine} from "../src/AuctionEngine.sol";

/// A bidder contract that commits and reveals normally but cannot take MON: it rejects it, or with
/// `burn` set it spends all forwarded gas trying.
contract MonRejectingBidder {
    AuctionEngine immutable engine;
    bool immutable burn;

    constructor(AuctionEngine e, bool burn_) payable {
        engine = e;
        burn = burn_;
    }

    function commit(uint256 r, bytes32 h, uint256 deposit) external {
        engine.commit{value: deposit}(r, h, new bytes32[](0), "");
    }

    function reveal(uint256 r, uint96 p, uint96 a, bytes32 s) external {
        engine.reveal(r, p, a, s);
    }

    function withdrawOwed(address to) external {
        engine.withdrawOwed(to);
    }

    receive() external payable {
        if (burn) {
            while (true) {}
        }
        revert("no MON");
    }
}

/// @notice O1 (STATIC-ANALYSIS.md, "Manual observations"), fixed in v2: a refund the bidder cannot
///         take becomes an owed balance instead of reverting, so one bidder can no longer block the
///         creator's proceeds or the dust sweep.
contract ObservationsTest is EngineBase {
    uint96 constant GP = 0.003 ether;
    uint96 constant GA = 300e18;
    bytes32 constant SALT = keccak256("griefer");

    function _roundWith(MonRejectingBidder griefer) internal returns (uint256 r) {
        r = _open(_params(AuctionEngine.Preset.Degen));
        vm.deal(address(griefer), DEPOSIT);
        griefer.commit(r, keccak256(abi.encode(GP, GA, SALT, address(griefer))), DEPOSIT);
        _commit(r, alice, 0.005 ether, 400e18);
        _commit(r, bob, 0.004 ether, 400e18);
        _commit(r, carol, 0.003 ether, 300e18);
        _toReveal(r);
        griefer.reveal(r, GP, GA, SALT);
        _reveal(r, alice, 0.005 ether, 400e18);
        _reveal(r, bob, 0.004 ether, 400e18);
        _reveal(r, carol, 0.003 ether, 300e18);
        _toSettle(r);
        assertTrue(engine.settle(r, 100));
        engine.seedLP(r);
        _claim(r, alice);
        _claim(r, bob);
        _claim(r, carol);
    }

    function _assertSettlesAndOwes(MonRejectingBidder griefer) internal {
        uint256 r = _roundWith(griefer);
        (uint256 alloc, uint256 paid,) = engine.quote(r, address(griefer));
        assertGt(alloc, 0, "griefer is a winner");
        assertEq(paid, 0.3 ether, "griefer owes 100 tokens x 0.003");

        // Anyone can settle the griefer: the refund push fails and becomes owed.
        engine.claimTokens(r, address(griefer));
        uint256 refund = DEPOSIT - paid;
        assertEq(engine.refundsOwed(address(griefer)), refund, "refund owed, not lost");
        assertEq(engine.totalOwed(), refund);
        assertEq(token.balanceOf(address(griefer)), alloc, "tokens delivered");

        // The creator collects the griefer's payment too, and the dust sweep is no longer blocked.
        AuctionEngine.Round memory rd = engine.getRound(r);
        assertEq(rd.collected, 3 ether, "every winner's payment is collected");
        vm.prank(creator);
        engine.withdrawProceeds(r);
        engine.sweepDust(r);

        // Engine MON = every round's balance + owed refunds.
        assertEq(address(engine).balance, engine.roundBalance(r) + engine.totalOwed());

        // The griefer collects to an address that can take MON; nobody else can.
        vm.prank(alice);
        vm.expectRevert("nothing owed");
        engine.withdrawOwed(alice);
        address payable to = payable(makeAddr("collector"));
        griefer.withdrawOwed(to);
        assertEq(to.balance, refund);
        assertEq(engine.refundsOwed(address(griefer)), 0);
        assertEq(engine.totalOwed(), 0);
        vm.expectRevert("nothing owed");
        griefer.withdrawOwed(to);
    }

    function test_O1_MonRejectingWinner_IsSettledAndOwed() public {
        _assertSettlesAndOwes(new MonRejectingBidder(engine, false));
    }

    /// A recipient that burns every unit of forwarded gas cannot make the push revert either.
    function test_O1_GasBurningWinner_IsSettledAndOwed() public {
        _assertSettlesAndOwes(new MonRejectingBidder(engine, true));
    }

    /// An ordinary bidder is still paid directly; nothing is owed.
    function test_O1_NormalRefund_IsPushed() public {
        uint256 r = _open(_params(AuctionEngine.Preset.Degen));
        _commit(r, alice, 0.005 ether, 400e18);
        _toReveal(r);
        _reveal(r, alice, 0.005 ether, 400e18);
        _toSettle(r);
        engine.settle(r, 100);
        engine.seedLP(r);
        uint256 before = alice.balance;
        _claim(r, alice);
        assertGt(alice.balance, before, "refund pushed");
        assertEq(engine.refundsOwed(alice), 0);
        assertEq(engine.totalOwed(), 0);
    }

    /// A round needs at least MIN_COMMIT_WINDOW to bid and MIN_REVEAL_WINDOW to reveal.
    function test_OpenRound_RejectsShortWindows() public {
        AuctionEngine.OpenParams memory p = _params(AuctionEngine.Preset.Degen);
        p.commitEnd = uint64(block.timestamp + engine.MIN_COMMIT_WINDOW() - 1);
        p.revealEnd = uint64(p.commitEnd + engine.MIN_REVEAL_WINDOW());
        vm.prank(creator);
        vm.expectRevert("commit window too short");
        engine.openRound(p);

        p = _params(AuctionEngine.Preset.Degen);
        p.revealEnd = uint64(p.commitEnd + engine.MIN_REVEAL_WINDOW() - 1);
        vm.prank(creator);
        vm.expectRevert("reveal window too short");
        engine.openRound(p);

        p = _params(AuctionEngine.Preset.Degen);
        p.commitEnd = uint64(block.timestamp + engine.MIN_COMMIT_WINDOW());
        p.revealEnd = uint64(p.commitEnd + engine.MIN_REVEAL_WINDOW());
        _open(p); // exactly the minimums is accepted
    }
}
