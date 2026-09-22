# Task: clearing

**Confirmed by the owner on 22 Sep** (Q14, decision 22). This replaces the EasyAuction fork. Run after `tasks/fix-core.md`.

Read `AGENTS.md`, `AUDIT.md`, `10-decisions.md` #22 and `04-flows.md` Flow 8 first. This is the core money path: small diffs, stop for review after each step.

## Scope
Branch `agent/fork`. New `contracts/src/UniformClearing.sol`; `contracts/src/AuctionEngine.sol`; `contracts/test/`. When done, delete `contracts/src/ClearingCore.sol` and its tests.

## The mechanism (Zama-style, uniform price)

Source: https://docs.zama.org/auction/how-it-works

- A bid is `(price, amount)`. `price` = max MON wei per 1e18 token units and must be a multiple of the round's `tickSize` and ≥ `reservePrice`. `amount` = token units wanted.
- Walk price levels from highest to lowest, adding up `amount`. The level where the running total first reaches the supply S sets the clearing price **P** — the lowest price at which a bid fills.
- Bids above P get their full `amount`. Bids at exactly P share what is left, `S − qtyAbove`, **pro-rata** by `amount`. Bids below P get nothing.
- If total demand is below S (undersubscribed), every bid fills in full and P is the lowest bid's price.
- Everyone pays P per token. Refund = deposit − payment.

## Structure — a price-level book, not a per-bid list

- `UniformClearing` is an **abstract contract inherited by `AuctionEngine`**, with only `internal` functions. No separately deployed core means no external entry points, so AUDIT C1–C3 cannot happen by construction.
- It is **generic**: it knows price levels, amounts, the supply, the clearing price and allocations — nothing about MON, payments or refunds. Payment and refund math lives in `AuctionEngine`. The Exit-Priority auction (`tasks/exit.md`) reuses `UniformClearing` unchanged with discount-as-price and shares-as-amount.
- Per round: a sorted, descending, linked list of distinct price levels; `levelQty[price]`; `levelCount[price]`.
- `reveal` adds the bid to its level and inserts the level if it is new. Accept an optional hint (an existing higher level) to skip the walk, and validate it.
- `settle(roundId, maxSteps)` walks levels and is resumable across transactions, like EasyAuction's precalculate. It stores the cursor and the running total. When it finishes, it records `P`, `qtyAbove`, `qtyAtPrice`, `countAtPrice`, and `soldLowerBound`.
- Settlement cost scales with the number of distinct price levels, not the number of bids. The tick grid bounds it. This improves bug #6.

## Arithmetic — exact rules

| Quantity | Formula | Rounding | Why |
| --- | --- | --- | --- |
| `maxSpend` at reveal | `price × amount / 1e18` | **up** | Deposit must cover the worst case; require `maxSpend ≥ minBidSize` and `maxSpend < deposit` |
| Pro-rata allocation at P | `amount × (S − qtyAbove) / qtyAtPrice` | **down** | Never allocate more than the supply |
| `paid` | `allocated × P / 1e18` | **up** | Rounding favours the contract, never the bidder (bug #8) |
| `refund` | `deposit − paid` | exact | `paid ≤ maxSpend < deposit` because `allocated ≤ amount` and `P ≤ price` |
| `soldLowerBound` | undersubscribed: total demand; oversubscribed: `S − countAtPrice`, saturating at zero | — | Floor dust is at most one unit per bidder at P; the LP is sized from this bound, so there is always enough MON |

Compute products in `uint256`; `uint96 × uint96` fits.

## Tests (P0)

1. **Differential fuzz.** Random bid sets on a random tick grid, compared against a brute-force reference written plainly in the test: sort all bids, find P, compute every allocation. Clearing price and every allocation must match exactly.
2. **Invariants, fuzzed:** `Σ allocated ≤ S`; `Σ allocated ≥ soldLowerBound`; `allocated ≤ amount`; `paid ≤ maxSpend < deposit`; bids above P get their full amount; bids below P get zero; two bids at P with equal amounts get equal allocations. Note that last one — it is AUDIT M6, the reveal-order advantage, fixed.
3. **Multi-transaction settle** gives the same result as a single call, for every `maxSteps`.
4. **The three AUDIT attacks are impossible:** settling before `revealEnd` reverts; nobody can claim someone else's bid; no bid enters the book without a commitment and a deposit.
5. **Edges:** no bids; one bid; everything at one price; demand exactly equal to supply; a single bid larger than the supply.

When done: `forge build && forge test`, then list every changed function in 5 lines.
