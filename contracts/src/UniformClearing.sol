// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

/// @notice Zama-style uniform-price clearing over a book of price levels (10-decisions.md #22).
/// @dev Generic by design (10-decisions.md #34): it knows prices, amounts, a supply and allocations,
///      nothing about payments. Launches use price = MON per token and amount = tokens; the exit
///      auction uses price = discount in bps and amount = shares.
///
///      Rule: walk price levels from the highest down, summing amounts. The level where the running
///      total first reaches the supply sets the clearing price P, the lowest price at which a bid
///      fills. Bids above P fill in full, bids at P share what is left pro-rata (rounded down), bids
///      below P get nothing. If demand never reaches the supply, every bid fills in full and P is the
///      lowest bid price. Ties are resolved by size only, never by arrival order (AUDIT.md M6).
///
///      Settlement cost scales with the number of distinct levels above P, not the number of bids,
///      and can be split across transactions.
abstract contract UniformClearing {
    /// @dev End-of-list / "no level" sentinel. Never a valid price (`_addBid` rejects it).
    ///      `SealingLayer.NO_HINT` has the same value on purpose.
    uint256 internal constant NONE = type(uint256).max;

    /// @dev All bids at one price. Levels form a singly linked list in strictly descending price order.
    struct Level {
        uint128 qty; // total amount bid at this price; nonzero once the level exists
        uint64 count; // number of bids at this price
        uint256 next; // next lower price level, NONE at the end
    }

    /// @dev One auction's order book and, once settled, its result.
    struct Book {
        uint128 supply; // amount for sale
        bool initialized;
        bool settling; // the first settle step ran; the book takes no more bids
        bool settled; // the clearing price is fixed
        bool oversubscribed; // demand at and above P exceeds the supply: bids at P are pro-rated
        uint64 levelCount;
        uint64 countAtPrice; // bids at the clearing price
        uint256 head; // highest price level, NONE if empty
        uint256 cursor; // next level to visit while settling
        uint256 last; // lowest level visited so far, NONE if none
        uint256 cum; // total amount of all visited levels
        uint256 totalQty;
        uint256 clearingPrice;
        uint256 qtyAbove;
        uint256 qtyAtPrice;
        uint256 sold; // nominal amount sold: supply if demand reached it, else total demand
    }

    /// @dev Book of each auction id.
    mapping(uint256 => Book) internal _books;
    /// @dev Price levels of each auction id, keyed by price.
    mapping(uint256 => mapping(uint256 => Level)) internal _levels;

    /// @notice The existing level just above `price`, to pass as a reveal hint. NONE if there is none.
    /// @dev O(levels) view, meant for off-chain calls. The book can change before the reveal lands;
    ///      a stale hint only costs gas, it never reverts.
    /// @param id    The auction (round) id.
    /// @param price The price about to be revealed.
    /// @return hint The lowest existing level strictly above `price`, or NONE.
    function findHint(uint256 id, uint256 price) external view returns (uint256 hint) {
        hint = _books[id].head;
        if (hint == NONE || hint <= price) return NONE;
        uint256 nxt = _levels[id][hint].next;
        while (nxt != NONE && nxt > price) {
            hint = nxt;
            nxt = _levels[id][hint].next;
        }
    }

    /// @notice The clearing state of auction `id`.
    /// @param id The auction (round) id.
    /// @return settled        Whether the clearing price is fixed; the other values are final only then.
    /// @return clearingPrice  P, the lowest price at which a bid fills (0 if there were no bids).
    /// @return sold           Nominal amount sold: the supply if demand reached it, else total demand.
    /// @return soldLowerBound A floor on the sum of all allocations (pro-rata rounding loses under one
    ///                        unit per bid at P).
    /// @return oversubscribed Whether bids at P are pro-rated.
    /// @return totalQty       Total amount bid.
    /// @return levelCount     Number of distinct price levels.
    function clearingOf(uint256 id)
        external
        view
        returns (
            bool settled,
            uint256 clearingPrice,
            uint256 sold,
            uint256 soldLowerBound,
            bool oversubscribed,
            uint256 totalQty,
            uint64 levelCount
        )
    {
        Book storage b = _books[id];
        return (b.settled, b.clearingPrice, b.sold, _soldLowerBound(id), b.oversubscribed, b.totalQty, b.levelCount);
    }

    /// @dev Opens an empty book for `id` with `supply` for sale. Each id can be initialised once.
    function _initBook(uint256 id, uint128 supply) internal {
        require(supply != 0, "zero supply");
        Book storage b = _books[id];
        require(!b.initialized, "book exists");
        b.initialized = true;
        b.supply = supply;
        b.head = NONE;
        b.cursor = NONE;
        b.last = NONE;
    }

    /// @dev Adds a bid to an open book, creating its price level if needed. `hint` as in `_insertLevel`.
    function _addBid(uint256 id, uint256 price, uint128 amount, uint256 hint) internal {
        require(price != NONE, "bad price");
        require(amount != 0, "zero amount");
        Book storage b = _books[id];
        require(b.initialized && !b.settling, "book closed");
        Level storage lvl = _levels[id][price];
        if (lvl.qty == 0) {
            _insertLevel(b, id, price, hint);
            b.levelCount += 1;
        }
        lvl.qty += amount;
        lvl.count += 1;
        b.totalQty += amount;
    }

    /// @dev Keeps levels in strictly descending order. A hint is used only if it is an existing level
    ///      above `price`; an invalid hint falls back to walking from the head instead of reverting.
    function _insertLevel(Book storage b, uint256 id, uint256 price, uint256 hint) private {
        uint256 head = b.head;
        if (head == NONE || price > head) {
            _levels[id][price].next = head;
            b.head = price;
            return;
        }
        uint256 cur = head;
        if (hint != NONE && hint > price && _levels[id][hint].qty != 0) cur = hint;
        while (true) {
            uint256 nxt = _levels[id][cur].next;
            if (nxt == NONE || nxt < price) break;
            cur = nxt;
        }
        _levels[id][price].next = _levels[id][cur].next;
        _levels[id][cur].next = price;
    }

    /// @dev Walks up to `maxSteps` price levels from the highest down, keeping its position in storage
    ///      between calls. The first call closes the book to new bids.
    /// @return done True once the clearing price is fixed.
    function _settleStep(uint256 id, uint256 maxSteps) internal returns (bool done) {
        require(maxSteps != 0, "zero steps");
        Book storage b = _books[id];
        require(b.initialized && !b.settled, "not settleable");
        if (!b.settling) {
            b.settling = true;
            b.cursor = b.head;
        }
        uint256 cursor = b.cursor;
        uint256 cum = b.cum;
        uint256 last = b.last;
        uint256 supply = b.supply;
        for (uint256 i; i < maxSteps; ++i) {
            if (cursor == NONE) {
                // Demand never reached the supply: every bid fills; P is the lowest level.
                if (last != NONE) {
                    Level storage low = _levels[id][last];
                    b.clearingPrice = last;
                    b.qtyAtPrice = low.qty;
                    b.countAtPrice = low.count;
                    b.qtyAbove = cum - low.qty;
                }
                b.sold = cum;
                b.settled = true;
                return true;
            }
            Level storage lvl = _levels[id][cursor];
            uint256 q = lvl.qty;
            if (cum + q >= supply) {
                b.clearingPrice = cursor;
                b.qtyAbove = cum;
                b.qtyAtPrice = q;
                b.countAtPrice = lvl.count;
                b.oversubscribed = cum + q > supply;
                b.sold = supply;
                b.settled = true;
                return true;
            }
            cum += q;
            last = cursor;
            cursor = lvl.next;
        }
        b.cursor = cursor;
        b.cum = cum;
        b.last = last;
        return false;
    }

    /// @dev What a bid of `amount` at `price` receives once settled: all of it above P, nothing below P.
    ///      At P: all of it unless oversubscribed, else its pro-rata share of what the levels above P
    ///      left, rounded down (bug #4).
    function _allocation(uint256 id, uint256 price, uint256 amount) internal view returns (uint256) {
        Book storage b = _books[id];
        require(b.settled, "not settled");
        if (b.totalQty == 0) return 0;
        uint256 p = b.clearingPrice;
        if (price > p) return amount;
        if (price < p) return 0;
        if (!b.oversubscribed) return amount;
        return amount * (uint256(b.supply) - b.qtyAbove) / b.qtyAtPrice;
    }

    /// @dev A floor on the sum of all allocations: pro-rata rounding loses under one unit per bid at P.
    function _soldLowerBound(uint256 id) internal view returns (uint256) {
        Book storage b = _books[id];
        if (!b.oversubscribed) return b.sold;
        return b.sold > b.countAtPrice ? b.sold - b.countAtPrice : 0;
    }
}
