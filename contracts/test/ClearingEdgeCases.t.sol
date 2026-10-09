// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ClearingHarness} from "./UniformClearing.t.sol";

/// @notice Clearing edge cases added after the mutation run (reports/mutation-summary.md). Each test kills
///         mutants of `UniformClearing.sol` that the earlier suite let survive: the exact-cover boundary at
///         the clearing price, the empty book, `findHint`'s return value, and the input checks the engine
///         never lets through.
contract ClearingEdgeCasesTest is Test {
    uint256 constant NONE = type(uint256).max;
    ClearingHarness h;

    function setUp() public {
        h = new ClearingHarness();
    }

    /// Demand above a level is exactly the supply and a lower level exists: P is the exact-cover level, the
    /// book is not oversubscribed, everyone at P fills in full and the lower bid gets nothing (bug #4).
    function test_ExactCover_WithLowerLevel_ClearsAtTheCoveringLevel() public {
        h.init(1, 1000);
        h.add(1, 50, 600, NONE);
        h.add(1, 40, 400, NONE);
        h.add(1, 30, 500, NONE);
        assertTrue(h.step(1, 10));
        (, uint256 p, uint256 sold, uint256 lb, bool over,,) = h.clearingOf(1);
        assertEq(p, 40, "P is the level where demand first reaches the supply");
        assertFalse(over, "exact cover is not oversubscribed");
        assertEq(sold, 1000);
        assertEq(lb, 1000);
        assertEq(h.alloc(1, 50, 600), 600);
        assertEq(h.alloc(1, 40, 400), 400);
        assertEq(h.alloc(1, 30, 500), 0);
    }

    /// An empty book settles with P = 0, nothing sold, not oversubscribed.
    function test_EmptyBook_SettlesAtZero() public {
        h.init(1, 1000);
        assertTrue(h.step(1, 1));
        (bool settled, uint256 p, uint256 sold, uint256 lb, bool over, uint256 total, uint64 levels) = h.clearingOf(1);
        assertTrue(settled);
        assertEq(p, 0);
        assertEq(sold, 0);
        assertEq(lb, 0);
        assertFalse(over);
        assertEq(total, 0);
        assertEq(levels, 0);
        assertEq(h.alloc(1, 10, 5), 0, "nothing is allocated from an empty book");
    }

    /// More bids at P than units for sale: the lower bound on allocations floors at zero instead of
    /// underflowing.
    function test_LowerBound_MoreBidsAtPriceThanUnits() public {
        h.init(1, 1);
        h.add(1, 10, 5, NONE);
        h.add(1, 10, 5, NONE);
        assertTrue(h.step(1, 10));
        assertEq(h.lowerBound(1), 0);
        assertEq(h.alloc(1, 10, 5), 0, "5 x 1 / 10 rounds down to 0");
    }

    /// findHint returns the lowest existing level strictly above the price, or NONE.
    function test_FindHint_ReturnsLowestLevelAbove() public {
        h.init(1, 1000);
        assertEq(h.findHint(1, 10), NONE, "empty book");
        h.add(1, 50, 1, NONE);
        h.add(1, 40, 1, NONE);
        h.add(1, 30, 1, NONE);
        assertEq(h.findHint(1, 60), NONE, "above the head");
        assertEq(h.findHint(1, 50), NONE, "equal to the head");
        assertEq(h.findHint(1, 45), 50);
        assertEq(h.findHint(1, 40), 50);
        assertEq(h.findHint(1, 35), 40);
        assertEq(h.findHint(1, 30), 40);
        assertEq(h.findHint(1, 25), 30);
        assertEq(h.findHint(1, 0), 30);
    }

    /// The input checks the engine never reaches (it validates first) still hold on their own.
    function test_InputChecks() public {
        vm.expectRevert("zero supply");
        h.init(1, 0);
        h.init(1, 100);
        vm.expectRevert("book exists");
        h.init(1, 100);
        vm.expectRevert("bad price");
        h.add(1, NONE, 1, NONE);
        vm.expectRevert("zero amount");
        h.add(1, 10, 0, NONE);
        vm.expectRevert("book closed");
        h.add(2, 10, 1, NONE);
        vm.expectRevert("zero steps");
        h.step(1, 0);
        h.add(1, 10, 1, NONE);
        assertFalse(h.step(1, 1), "one level visited, demand below supply, end not reached yet");
        vm.expectRevert("book closed");
        h.add(1, 10, 1, NONE);
    }
}
