// SPDX-License-Identifier: LGPL-3.0
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/AuctionEngine.sol";
import "../src/ClearingCore.sol";

/// @notice Integration tests for the full lifecycle per 03-architecture.md data path
///         and 04-flows.md Flows 2-4: commit with deposit, reveal, clearing, claim
///         and refund/slash, plus the ledger invariant across the whole lifecycle.
///
///         Round config (all values chosen to satisfy both layers' checks):
///         sellAmount 1000, reserve minBuy 100, minBidSize 11 (> core floor 10, so
///         core minimum 10 admits every quantity >= 11), uniform deposit 200
///         (> minBidSize per commit's round-deposit check, <= depositCap 1000).
///         Order mapping: reveal(price, quantity) -> order(buyAmount=price,
///         sellAmount=quantity); reserve check price*100 < quantity*1000.
contract AuctionEngineTest is Test {
    ClearingCore core;
    AuctionEngine engine;

    address payable slashDest = payable(address(0x51A5));
    address payable fillDest = payable(address(0xF111));
    address stranger = address(0x57A9);
    address alice = address(0xA11CE);
    address bob = address(0xB0B);
    address carol = address(0xCA401);
    address dave = address(0xDAFE);

    uint96 constant SELL = 1000;
    uint96 constant MINBID = 11;
    uint256 constant DEPOSIT = 200;

    function setUp() public {
        vm.warp(1000);
        core = new ClearingCore(10, 0, address(0));
        engine = new AuctionEngine(
            address(core), slashDest, fillDest, 1000, false, 1, 100, 0, true
        );
        address[] memory bidders = new address[](4);
        bidders[0] = alice;
        bidders[1] = bob;
        bidders[2] = carol;
        bidders[3] = dave;
        for (uint256 i; i < bidders.length; ++i) vm.deal(bidders[i], 1000);
    }

    function _openRound() internal returns (uint256) {
        return engine.openRound(
            AuctionEngine.Preset.Degen,
            address(0xA9C7),
            address(0xB1D6),
            SELL,
            MINBID,
            DEPOSIT,
            1100,
            1200,
            bytes32(0),
            false
        );
    }

    function _commit(uint256 roundId, address bidder, uint96 price, uint96 qty, bytes32 salt) internal {
        bytes32 h = keccak256(abi.encode(price, qty, salt, bidder));
        vm.prank(bidder);
        engine.commit{value: DEPOSIT}(roundId, h);
    }

    function _reveal(uint256 roundId, address bidder, uint96 price, uint96 qty, bytes32 salt) internal {
        vm.prank(bidder);
        engine.reveal(roundId, price, qty, salt);
    }

    function _assertInvariant(uint256 roundId, address bidder) internal view {
        (uint256 locked, uint256 applied, uint256 refunded, uint256 slashed) = engine.deposits(roundId, bidder);
        assertEq(locked, applied + refunded + slashed, "ledger invariant broken");
    }

    // ─── 1. Full happy path, one bidder ──────────────────────────────────
    function test_HappyPathSingleBidder() public {
        uint256 r = _openRound();

        _commit(r, alice, 600, 100, bytes32(uint256(1)));

        vm.warp(1100);
        vm.expectRevert("reveal window open");
        vm.prank(stranger);
        engine.settle(r);

        _reveal(r, alice, 600, 100, bytes32(uint256(1)));

        vm.warp(1200);
        vm.prank(stranger);
        engine.settle(r);

        vm.expectRevert("not revealed");
        vm.prank(bob);
        engine.claim(r);

        vm.prank(alice);
        engine.claim(r);

        // One bid of (600,100) against sell 1000/reserve 100 clears the whole
        // supply at the reserve price: entitlement 1000, fill cost 100.
        assertEq(engine.fillEntitlement(r, alice), 1000, "single bidder takes supply at reserve");
        (uint256 locked, uint256 applied, uint256 refunded, uint256 slashed) = engine.deposits(r, alice);
        assertEq(locked, 200);
        assertEq(applied, 100);
        assertEq(refunded, 100);
        assertEq(slashed, 0);
        _assertInvariant(r, alice);
        assertEq(fillDest.balance, 100, "fill proceeds to fill destination");
        assertEq(alice.balance, 1000 - 200 + 100, "bidder net of fill");
        assertEq(address(engine).balance, 0, "no funds stranded");

        vm.expectRevert("nothing to claim");
        vm.prank(alice);
        engine.claim(r);
    }

    // ─── 2. Partial fill at the marginal bid ─────────────────────────────
    function test_PartialFillMarginalClaimAndRefund() public {
        uint256 r = _openRound();
        _commit(r, alice, 600, 100, bytes32(uint256(1)));
        _commit(r, bob, 600, 100, bytes32(uint256(2)));

        vm.warp(1100);
        _reveal(r, alice, 600, 100, bytes32(uint256(1)));
        _reveal(r, bob, 600, 100, bytes32(uint256(2)));

        vm.warp(1200);
        engine.settle(r);
        (uint96 num, uint96 den, uint96 vol) = core.getClearingPrice(engine.coreRoundIds(r));
        assertEq(num, 600);
        assertEq(den, 100);
        // uncovered = 200 - 1000*100/600 = 34, so the marginal order fills 66.
        assertEq(vol, 66, "marginal partial fill off");

        vm.prank(alice);
        engine.claim(r);
        vm.prank(bob);
        engine.claim(r);

        // Alice (first at the tied price) fully fills: 100*600/100 = 600.
        assertEq(engine.fillEntitlement(r, alice), 600);
        // Bob (marginal) partially fills: 66*600/100 = 396; refund 34 of bid.
        assertEq(engine.fillEntitlement(r, bob), 396);
        assertEq(engine.fillEntitlement(r, alice) + engine.fillEntitlement(r, bob), 996, "over-allocated");
        assertTrue(engine.fillEntitlement(r, alice) + engine.fillEntitlement(r, bob) <= SELL, "insolvent");

        (, uint256 appliedA,,) = engine.deposits(r, alice);
        (, uint256 appliedB,,) = engine.deposits(r, bob);
        assertEq(appliedA, 100, "winner pays full bid");
        assertEq(appliedB, 66, "marginal pays filled portion");
        assertEq(bob.balance, 1000 - 200 + (200 - 66), "marginal refund");
        _assertInvariant(r, alice);
        _assertInvariant(r, bob);
        assertEq(fillDest.balance, 166);
        assertEq(address(engine).balance, 0, "no funds stranded");
    }

    // ─── 3. Slash on failed reveal ───────────────────────────────────────
    function test_SlashOnFailedReveal() public {
        uint256 r = _openRound();
        _commit(r, alice, 600, 100, bytes32(uint256(1)));
        _commit(r, bob, 600, 100, bytes32(uint256(2)));

        vm.warp(1100);
        // Alice never reveals (salt lost client-side per Flow 2 failure case).
        _reveal(r, bob, 600, 100, bytes32(uint256(2)));

        address[] memory targets = new address[](1);
        targets[0] = alice;
        vm.warp(1199);
        vm.expectRevert("not slashable");
        engine.slashUnrevealed(r, targets);

        vm.warp(1200);
        engine.settle(r);
        engine.slashUnrevealed(r, targets);

        (uint256 locked, uint256 applied, uint256 refunded, uint256 slashed) = engine.deposits(r, alice);
        assertEq(locked, 200);
        assertEq(applied, 0);
        assertEq(refunded, 0);
        assertEq(slashed, 200, "non-revealer fully slashed");
        _assertInvariant(r, alice);
        assertEq(slashDest.balance, 200);

        // The revealed bidder is unaffected and claims normally.
        vm.prank(bob);
        engine.claim(r);
        _assertInvariant(r, bob);
        assertEq(engine.fillEntitlement(r, bob), 1000);

        vm.expectRevert("already settled");
        engine.slashUnrevealed(r, targets);
    }

    // ─── 4. Ledger invariant across the whole lifecycle ──────────────────
    function test_LedgerInvariantAcrossLifecycle() public {
        uint256 r = _openRound();
        // Alice and Bob tie at buy/sell 9 (alice reveals first -> first in book),
        // Carol pays less per unit (100/950 < 100/900) and loses; Dave never reveals.
        _commit(r, alice, 900, 100, bytes32(uint256(1)));
        _commit(r, bob, 900, 100, bytes32(uint256(2)));
        _commit(r, carol, 950, 100, bytes32(uint256(3)));
        _commit(r, dave, 900, 100, bytes32(uint256(4)));

        vm.warp(1100);
        _reveal(r, alice, 900, 100, bytes32(uint256(1)));
        _reveal(r, bob, 900, 100, bytes32(uint256(2)));
        _reveal(r, carol, 950, 100, bytes32(uint256(3)));

        vm.warp(1200);
        // Multi-transaction settlement: one precalculation step (sums alice's 100;
        // 100*900 < 1000*100 so not past the crossing point), then settle.
        engine.precalculate(r, 1);
        engine.settle(r);

        vm.prank(alice);
        engine.claim(r);
        vm.prank(bob);
        engine.claim(r);
        vm.prank(carol);
        engine.claim(r);
        address[] memory targets = new address[](1);
        targets[0] = dave;
        engine.slashUnrevealed(r, targets);

        // Crossing at Bob: uncovered = 200 - 1000*100/900 = 89, marginal fills 11.
        assertEq(engine.fillEntitlement(r, alice), 900, "winner full fill");
        assertEq(engine.fillEntitlement(r, bob), 99, "marginal partial fill");
        assertEq(engine.fillEntitlement(r, carol), 0, "loser no fill");

        (, uint256 appliedA,,) = engine.deposits(r, alice);
        (, uint256 appliedB,,) = engine.deposits(r, bob);
        (, uint256 appliedC,,) = engine.deposits(r, carol);
        assertEq(appliedA, 100);
        assertEq(appliedB, 11);
        assertEq(appliedC, 0);

        _assertInvariant(r, alice);
        _assertInvariant(r, bob);
        _assertInvariant(r, carol);
        _assertInvariant(r, dave);

        // Global conservation: 4x200 locked == applied + refunded + slashed.
        uint256 lockedSum;
        uint256 settledSum;
        address[] memory all = new address[](4);
        all[0] = alice;
        all[1] = bob;
        all[2] = carol;
        all[3] = dave;
        for (uint256 i; i < all.length; ++i) {
            (uint256 l, uint256 a, uint256 rf, uint256 s) = engine.deposits(r, all[i]);
            lockedSum += l;
            settledSum += a + rf + s;
        }
        assertEq(lockedSum, 800);
        assertEq(settledSum, lockedSum, "global ledger invariant broken");
        assertEq(fillDest.balance, 111, "proceeds = fills");
        assertEq(slashDest.balance, 200, "slash to slash destination");
        assertEq(address(engine).balance, 0, "no funds stranded");
    }

    // ─── Round-opening guards (Flow 1 failure cases) ─────────────────────
    function test_OpenRoundGuards() public {
        vm.expectRevert("missing minBidSize");
        engine.openRound(
            AuctionEngine.Preset.Degen, address(0), address(0), SELL, 0, DEPOSIT, 1100, 1200, bytes32(0), false
        );
        vm.expectRevert("deposit must exceed minBid");
        engine.openRound(
            AuctionEngine.Preset.Degen, address(0), address(0), SELL, MINBID, MINBID, 1100, 1200, bytes32(0), false
        );
        vm.expectRevert("bad windows");
        engine.openRound(
            AuctionEngine.Preset.Degen, address(0), address(0), SELL, MINBID, DEPOSIT, 1200, 1200, bytes32(0), false
        );
        vm.expectRevert("minBidSize below core floor");
        engine.openRound(
            AuctionEngine.Preset.Degen, address(0), address(0), SELL, 10, DEPOSIT, 1100, 1200, bytes32(0), false
        );
    }
}
