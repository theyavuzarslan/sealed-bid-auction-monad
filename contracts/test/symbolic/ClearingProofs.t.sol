// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {UniformClearing} from "../../src/UniformClearing.sol";

/// Thin harness over the real clearing logic: nothing is re-implemented, every call goes to the
/// inherited internal functions of `UniformClearing`.
contract SymClearing is UniformClearing {
    function init(uint256 id, uint128 supply) external {
        _initBook(id, supply);
    }

    function add(uint256 id, uint256 price, uint128 amount) external {
        _addBid(id, price, amount, NONE);
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

    function result(uint256 id) external view returns (uint256 clearingPrice, bool oversubscribed, uint256 sold) {
        Book storage b = _books[id];
        return (b.clearingPrice, b.oversubscribed, b.sold);
    }
}

/// Symbolic proofs over the real clearing code (PROPERTIES.md P1, P1b, P2, P6a, P8, P8b, P9).
/// Bids are uint96 price × uint96 amount, as revealed through the engine; supply is any non-zero
/// uint96 (the engine's sellAmount is uint128, but a bid amount never exceeds uint96).
///
/// Run: forge test --symbolic --match-contract ClearingProofs --symbolic-loop 8 --symbolic-timeout 600
contract ClearingProofs is Test {
    uint256 constant ID = 1;
    SymClearing h;

    function setUp() public {
        h = new SymClearing();
    }

    // ─── Shared setup: book N bids, settle in one call ──────────────────

    function _book3(uint96 supply, uint96 p1, uint96 a1, uint96 p2, uint96 a2, uint96 p3, uint96 a3) internal {
        vm.assume(supply != 0 && a1 != 0 && a2 != 0 && a3 != 0);
        h.init(ID, supply);
        h.add(ID, p1, a1);
        h.add(ID, p2, a2);
        h.add(ID, p3, a3);
        assert(h.step(ID, 8)); // 3 levels at most: one call always settles
    }

    // ─── P1: allocations never exceed the supply ────────────────────────

    function prove_P1_SumOfAllocationsAtMostSupply_2Bids(uint96 supply, uint96 p1, uint96 a1, uint96 p2, uint96 a2)
        public
    {
        vm.assume(supply != 0 && a1 != 0 && a2 != 0);
        h.init(ID, supply);
        h.add(ID, p1, a1);
        h.add(ID, p2, a2);
        assert(h.step(ID, 8));
        uint256 sum = h.alloc(ID, p1, a1) + h.alloc(ID, p2, a2);
        assert(sum <= supply);
        assert(sum >= h.lowerBound(ID)); // P1b
    }

    function prove_P1_SumOfAllocationsAtMostSupply_3Bids(
        uint96 supply,
        uint96 p1,
        uint96 a1,
        uint96 p2,
        uint96 a2,
        uint96 p3,
        uint96 a3
    ) public {
        _book3(supply, p1, a1, p2, a2, p3, a3);
        uint256 sum = h.alloc(ID, p1, a1) + h.alloc(ID, p2, a2) + h.alloc(ID, p3, a3);
        assert(sum <= supply);
    }

    function prove_P1b_SumOfAllocationsAtLeastLowerBound_3Bids(
        uint96 supply,
        uint96 p1,
        uint96 a1,
        uint96 p2,
        uint96 a2,
        uint96 p3,
        uint96 a3
    ) public {
        _book3(supply, p1, a1, p2, a2, p3, a3);
        uint256 sum = h.alloc(ID, p1, a1) + h.alloc(ID, p2, a2) + h.alloc(ID, p3, a3);
        assert(sum >= h.lowerBound(ID));
    }

    // ─── P2: nobody is allocated more than they bid for ─────────────────

    function prove_P2_NoBidOverAllocated_2Bids(uint96 supply, uint96 p1, uint96 a1, uint96 p2, uint96 a2) public {
        vm.assume(supply != 0 && a1 != 0 && a2 != 0);
        h.init(ID, supply);
        h.add(ID, p1, a1);
        h.add(ID, p2, a2);
        assert(h.step(ID, 8));
        assert(h.alloc(ID, p1, a1) <= a1);
        assert(h.alloc(ID, p2, a2) <= a2);
    }

    function prove_P2_NoBidOverAllocated_3Bids(
        uint96 supply,
        uint96 p1,
        uint96 a1,
        uint96 p2,
        uint96 a2,
        uint96 p3,
        uint96 a3
    ) public {
        _book3(supply, p1, a1, p2, a2, p3, a3);
        assert(h.alloc(ID, p1, a1) <= a1);
        assert(h.alloc(ID, p2, a2) <= a2);
        assert(h.alloc(ID, p3, a3) <= a3);
    }

    // ─── P1, P1b, P2 at reduced width ───────────────────────────────────
    // The pro-rata share amount × (S − qtyAbove) / qtyAtPrice multiplies and divides symbolic values,
    // which z3 does not decide at 96 bits within the time limit. These variants keep every price a full
    // uint96 and bound amounts and the supply to uint16, so the same code paths (exact cover,
    // oversubscribed pro-rata, undersubscribed) are searched exhaustively over a smaller domain.

    function prove_P1_P1b_P2_Allocations_3Bids_Amounts16(
        uint16 supply,
        uint96 p1,
        uint16 a1,
        uint96 p2,
        uint16 a2,
        uint96 p3,
        uint16 a3
    ) public {
        _book3(supply, p1, a1, p2, a2, p3, a3);
        uint256 x1 = h.alloc(ID, p1, a1);
        uint256 x2 = h.alloc(ID, p2, a2);
        uint256 x3 = h.alloc(ID, p3, a3);
        assert(x1 <= a1 && x2 <= a2 && x3 <= a3); // P2
        assert(x1 + x2 + x3 <= supply); // P1
        assert(x1 + x2 + x3 >= h.lowerBound(ID)); // P1b
    }

    function prove_P1_P1b_P2_Allocations_2Bids_Amounts16(uint16 supply, uint96 p1, uint16 a1, uint96 p2, uint16 a2)
        public
    {
        vm.assume(supply != 0 && a1 != 0 && a2 != 0);
        h.init(ID, supply);
        h.add(ID, p1, a1);
        h.add(ID, p2, a2);
        assert(h.step(ID, 8));
        uint256 x1 = h.alloc(ID, p1, a1);
        uint256 x2 = h.alloc(ID, p2, a2);
        assert(x1 <= a1 && x2 <= a2);
        assert(x1 + x2 <= supply);
        assert(x1 + x2 >= h.lowerBound(ID));
    }

    /// The same three propositions with amounts and supply bounded to uint8.
    function prove_P1_P1b_P2_Allocations_2Bids_Amounts8(uint8 supply, uint96 p1, uint8 a1, uint96 p2, uint8 a2) public {
        vm.assume(supply != 0 && a1 != 0 && a2 != 0);
        h.init(ID, supply);
        h.add(ID, p1, a1);
        h.add(ID, p2, a2);
        assert(h.step(ID, 8));
        uint256 x1 = h.alloc(ID, p1, a1);
        uint256 x2 = h.alloc(ID, p2, a2);
        assert(x1 <= a1 && x2 <= a2);
        assert(x1 + x2 <= supply);
        assert(x1 + x2 >= h.lowerBound(ID));
    }

    // ─── P6a: the clearing price is one of the bid prices ───────────────

    function prove_P6a_ClearingPriceIsABidPrice_3Bids(
        uint96 supply,
        uint96 p1,
        uint96 a1,
        uint96 p2,
        uint96 a2,
        uint96 p3,
        uint96 a3
    ) public {
        _book3(supply, p1, a1, p2, a2, p3, a3);
        (uint256 p,,) = h.result(ID);
        assert(p == p1 || p == p2 || p == p3);
        // and it is at most the highest bid and at least the lowest
        assert(p <= _max3(p1, p2, p3));
        assert(p >= _min3(p1, p2, p3));
    }

    // ─── P8: above P fills in full, below P gets nothing ────────────────

    function prove_P8_AboveFullBelowNothing_3Bids(
        uint96 supply,
        uint96 p1,
        uint96 a1,
        uint96 p2,
        uint96 a2,
        uint96 p3,
        uint96 a3
    ) public {
        _book3(supply, p1, a1, p2, a2, p3, a3);
        (uint256 p,,) = h.result(ID);
        _checkP8(p, p1, a1);
        _checkP8(p, p2, a2);
        _checkP8(p, p3, a3);
    }

    /// P8b: if the book is not oversubscribed, every bid at P fills in full too.
    function prove_P8b_NotOversubscribedEveryoneFills_3Bids(
        uint96 supply,
        uint96 p1,
        uint96 a1,
        uint96 p2,
        uint96 a2,
        uint96 p3,
        uint96 a3
    ) public {
        _book3(supply, p1, a1, p2, a2, p3, a3);
        (uint256 p, bool over,) = h.result(ID);
        if (!over) {
            if (p1 >= p) assert(h.alloc(ID, p1, a1) == a1);
            if (p2 >= p) assert(h.alloc(ID, p2, a2) == a2);
            if (p3 >= p) assert(h.alloc(ID, p3, a3) == a3);
        }
    }

    /// P8c: P is the lowest price that clears. Demand strictly above P is below the supply, so no
    ///      higher price could have sold the supply (no bidder is priced out needlessly).
    function prove_P8c_DemandAbovePriceBelowSupply_3Bids(
        uint96 supply,
        uint96 p1,
        uint96 a1,
        uint96 p2,
        uint96 a2,
        uint96 p3,
        uint96 a3
    ) public {
        _book3(supply, p1, a1, p2, a2, p3, a3);
        (uint256 p,,) = h.result(ID);
        uint256 above = (p1 > p ? uint256(a1) : 0) + (p2 > p ? uint256(a2) : 0) + (p3 > p ? uint256(a3) : 0);
        assert(above < supply);
    }

    /// P6a and P8c with prices bounded to uint8 (amounts and supply stay uint96). The uint96-price runs
    /// return candidate counterexamples that do not replay; these narrow the price domain.
    function prove_P6a_ClearingPriceIsABidPrice_3Bids_Prices8(
        uint96 supply,
        uint8 p1,
        uint96 a1,
        uint8 p2,
        uint96 a2,
        uint8 p3,
        uint96 a3
    ) public {
        _book3(supply, p1, a1, p2, a2, p3, a3);
        (uint256 p,,) = h.result(ID);
        assert(p == p1 || p == p2 || p == p3);
        assert(p <= _max3(p1, p2, p3));
        assert(p >= _min3(p1, p2, p3));
    }

    function prove_P8c_DemandAbovePriceBelowSupply_3Bids_Prices8(
        uint96 supply,
        uint8 p1,
        uint96 a1,
        uint8 p2,
        uint96 a2,
        uint8 p3,
        uint96 a3
    ) public {
        _book3(supply, p1, a1, p2, a2, p3, a3);
        (uint256 p,,) = h.result(ID);
        uint256 above = (p1 > p ? uint256(a1) : 0) + (p2 > p ? uint256(a2) : 0) + (p3 > p ? uint256(a3) : 0);
        assert(above < supply);
    }

    // ─── P9: settling in steps gives the same result ────────────────────

    function prove_P9_SteppedSettlementSameResult_3Bids(
        uint96 supply,
        uint96 p1,
        uint96 a1,
        uint96 p2,
        uint96 a2,
        uint96 p3,
        uint96 a3
    ) public {
        vm.assume(supply != 0 && a1 != 0 && a2 != 0 && a3 != 0);
        SymClearing g = new SymClearing();
        h.init(ID, supply);
        g.init(ID, supply);
        h.add(ID, p1, a1);
        g.add(ID, p1, a1);
        h.add(ID, p2, a2);
        g.add(ID, p2, a2);
        h.add(ID, p3, a3);
        g.add(ID, p3, a3);
        assert(h.step(ID, 8));
        bool done;
        for (uint256 i; i < 4 && !done; ++i) {
            done = g.step(ID, 1);
        }
        assert(done);
        (uint256 hp, bool ho, uint256 hs) = h.result(ID);
        (uint256 gp, bool go, uint256 gs) = g.result(ID);
        assert(hp == gp && ho == go && hs == gs);
    }

    // ─── Helpers ────────────────────────────────────────────────────────

    /// Only bids off the clearing price: P8 says nothing about bids at P (that is P1/P2), and leaving
    /// them out keeps the pro-rata division, the one nonlinear step, out of this proof.
    function _checkP8(uint256 p, uint96 price, uint96 amount) internal view {
        if (price == p) return;
        uint256 a = h.alloc(ID, price, amount);
        if (price > p) assert(a == amount);
        if (price < p) assert(a == 0);
    }

    function _max3(uint256 a, uint256 b, uint256 c) internal pure returns (uint256 m) {
        m = a > b ? a : b;
        m = m > c ? m : c;
    }

    function _min3(uint256 a, uint256 b, uint256 c) internal pure returns (uint256 m) {
        m = a < b ? a : b;
        m = m < c ? m : c;
    }
}
