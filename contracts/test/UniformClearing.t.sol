// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {UniformClearing} from "../src/UniformClearing.sol";

contract ClearingHarness is UniformClearing {
    function init(uint256 id, uint128 supply) external {
        _initBook(id, supply);
    }

    function add(uint256 id, uint256 price, uint128 amount, uint256 hint) external {
        _addBid(id, price, amount, hint);
    }

    function step(uint256 id, uint256 n) external returns (bool) {
        return _settleStep(id, n);
    }

    function alloc(uint256 id, uint256 price, uint256 amount) external view returns (uint256) {
        return _allocation(id, price, amount);
    }

    function lowerBound(uint256 id) external view returns (uint256) {
        return _soldLowerBound(id);
    }

    function levelPrices(uint256 id) external view returns (uint256[] memory out) {
        out = new uint256[](_books[id].levelCount);
        uint256 cur = _books[id].head;
        for (uint256 i; cur != NONE; ++i) {
            out[i] = cur;
            cur = _levels[id][cur].next;
        }
    }
}

contract UniformClearingTest is Test {
    uint256 constant NONE = type(uint256).max;
    uint256 constant GRID = 8; // few distinct prices, so ties at the clearing price are common

    ClearingHarness h;

    function setUp() public {
        h = new ClearingHarness();
    }

    // ─── Worked examples ────────────────────────────────────────────────

    /// Zama's documented example shape: highest first, the crossing level sets P, ties share pro-rata.
    function test_Example_OversubscribedTieIsProRata() public {
        h.init(1, 1000);
        h.add(1, 50, 400, NONE); // Alice
        h.add(1, 40, 400, NONE); // Bob
        h.add(1, 30, 300, NONE); // Carol
        h.add(1, 30, 300, NONE); // Dave, same price and size as Carol
        h.add(1, 20, 999, NONE); // below the clearing price
        assertTrue(h.step(1, 100));
        (bool settled, uint256 p, uint256 sold,, bool over,,) = h.clearingOf(1);
        assertTrue(settled);
        assertEq(p, 30);
        assertEq(sold, 1000);
        assertTrue(over);
        assertEq(h.alloc(1, 50, 400), 400);
        assertEq(h.alloc(1, 40, 400), 400);
        assertEq(h.alloc(1, 30, 300), 100); // 200 left, shared 300:300
        assertEq(h.alloc(1, 20, 999), 0);
    }

    function test_Example_Undersubscribed_AllFill_PriceIsLowestBid() public {
        h.init(1, 1000);
        h.add(1, 50, 100, NONE);
        h.add(1, 10, 200, NONE);
        assertTrue(h.step(1, 100));
        (, uint256 p, uint256 sold,, bool over,,) = h.clearingOf(1);
        assertEq(p, 10);
        assertEq(sold, 300);
        assertFalse(over);
        assertEq(h.alloc(1, 50, 100), 100);
        assertEq(h.alloc(1, 10, 200), 200);
    }

    function test_Example_ExactlyCovered_NoProRata() public {
        h.init(1, 500);
        h.add(1, 20, 300, NONE);
        h.add(1, 10, 200, NONE);
        assertTrue(h.step(1, 100));
        (, uint256 p, uint256 sold,, bool over,,) = h.clearingOf(1);
        assertEq(p, 10);
        assertEq(sold, 500);
        assertFalse(over);
        assertEq(h.alloc(1, 10, 200), 200);
        assertEq(h.lowerBound(1), 500);
    }

    function test_Example_EmptyBook() public {
        h.init(1, 500);
        assertTrue(h.step(1, 1));
        (bool settled,, uint256 sold,,,,) = h.clearingOf(1);
        assertTrue(settled);
        assertEq(sold, 0);
    }

    function test_Example_SingleBidLargerThanSupply() public {
        h.init(1, 100);
        h.add(1, 7, 1000, NONE);
        assertTrue(h.step(1, 1));
        assertEq(h.alloc(1, 7, 1000), 100);
    }

    function test_Example_ZeroPriceLevelWorks() public {
        // The exit auction uses discount 0 as a legal price; 0 must not collide with the list sentinel.
        h.init(1, 100);
        h.add(1, 0, 60, NONE);
        h.add(1, 5, 30, NONE);
        assertTrue(h.step(1, 10));
        (, uint256 p, uint256 sold,,,,) = h.clearingOf(1);
        assertEq(p, 0);
        assertEq(sold, 90);
    }

    function test_CannotAddAfterSettlementStarts() public {
        h.init(1, 100);
        h.add(1, 5, 10, NONE);
        h.step(1, 1);
        vm.expectRevert("book closed");
        h.add(1, 6, 10, NONE);
    }

    // ─── Differential fuzz against a brute-force reference ─────────────

    struct B {
        uint256 price;
        uint256 amount;
    }

    function testFuzz_MatchesReference(uint256 seed) public {
        uint256 n = 1 + seed % 40;
        B[] memory bids = new B[](n);
        uint256 total;
        for (uint256 i; i < n; ++i) {
            uint256 r = uint256(keccak256(abi.encode(seed, i)));
            bids[i] = B({price: (r % GRID) * 1e15, amount: 1 + (r >> 64) % 1e21});
            total += bids[i].amount;
        }
        uint128 supply = uint128(1 + uint256(keccak256(abi.encode(seed, "s"))) % (total * 3 / 2 + 1));
        h.init(1, supply);

        for (uint256 i; i < n; ++i) {
            // Mix of no hint, valid hints and garbage hints: none may corrupt the ordering.
            uint256 r = uint256(keccak256(abi.encode(seed, i, "h")));
            uint256 hint = r % 3 == 0 ? NONE : r % 3 == 1 ? h.findHint(1, bids[i].price) : (r >> 8) % (GRID * 1e15 + 7);
            h.add(1, bids[i].price, uint128(bids[i].amount), hint);
        }
        _assertStrictlyDescending(h.levelPrices(1));

        uint256 steps = 1 + (seed >> 128) % 4;
        for (uint256 guard; !h.step(1, steps); ++guard) {
            require(guard < 100, "settle loop");
        }

        (uint256 refP, bool refOver, uint256 refAbove, uint256 refAtP) = _reference(bids, supply);
        (, uint256 p,,, bool over,,) = h.clearingOf(1);
        assertEq(p, refP, "clearing price");
        assertEq(over, refOver, "oversubscribed");

        uint256 sumAlloc;
        for (uint256 i; i < n; ++i) {
            uint256 a = h.alloc(1, bids[i].price, bids[i].amount);
            uint256 expected = bids[i].price > refP
                ? bids[i].amount
                : bids[i].price < refP ? 0 : refOver ? bids[i].amount * (supply - refAbove) / refAtP : bids[i].amount;
            assertEq(a, expected, "allocation");
            assertLe(a, bids[i].amount);
            sumAlloc += a;
        }
        assertLe(sumAlloc, supply, "over-allocated");
        assertGe(sumAlloc, h.lowerBound(1), "lower bound too high");
    }

    /// Two bids at the clearing price with equal amounts always get equal allocations (AUDIT M6).
    function testFuzz_EqualBidsAtClearingPriceGetEqualShares(uint128 supply, uint96 a, uint96 other) public {
        supply = uint128(bound(supply, 2, 1e24));
        a = uint96(bound(a, 1, 1e24));
        other = uint96(bound(other, 1, supply - 1));
        h.init(1, supply);
        h.add(1, 9, other, NONE); // above
        h.add(1, 5, a, NONE); // first at P
        h.add(1, 5, a, NONE); // second at P, identical
        h.step(1, 10);
        (, uint256 p,,,,,) = h.clearingOf(1);
        if (p == 5) assertEq(h.alloc(1, 5, a), h.alloc(1, 5, a));
        uint256 total = h.alloc(1, 9, other) + 2 * h.alloc(1, 5, a);
        assertLe(total, supply);
    }

    // ─── Reference ─────────────────────────────────────────────────────

    function _reference(B[] memory bids, uint256 supply)
        private
        pure
        returns (uint256 price, bool over, uint256 above, uint256 atP)
    {
        uint256 cum;
        uint256 lowest = type(uint256).max;
        for (uint256 g = GRID; g > 0; --g) {
            uint256 level = (g - 1) * 1e15;
            uint256 q;
            for (uint256 i; i < bids.length; ++i) {
                if (bids[i].price == level) q += bids[i].amount;
            }
            if (q == 0) continue;
            lowest = level;
            if (cum + q >= supply) {
                return (level, cum + q > supply, cum, q);
            }
            cum += q;
        }
        // Demand never reached the supply: everything fills at the lowest bid price.
        uint256 qLow;
        for (uint256 i; i < bids.length; ++i) {
            if (bids[i].price == lowest) qLow += bids[i].amount;
        }
        return (lowest, false, cum - qLow, qLow);
    }

    function _assertStrictlyDescending(uint256[] memory prices) private pure {
        for (uint256 i = 1; i < prices.length; ++i) {
            require(prices[i - 1] > prices[i], "levels out of order");
        }
    }
}
