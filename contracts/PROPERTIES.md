# Correctness propositions for the money path

Method, after Category Labs (who formally verify the Monad client in Rocq): write each correctness claim as a precise proposition first, then search for a counterexample with a solver. A proposition that survives the search is proved for its stated bounds; a counterexample is either a bug in the code or a hole in the proposition, and the write-up says which.

The search uses Foundry's built-in symbolic engine (`forge test --symbolic`, forge 1.8.3, solver z3 4.x via Homebrew) over the real contracts. Inputs are symbolic within the stated bounds, so a "proved" result covers every value in those bounds, not a sample. Loops are unrolled to the stated bound; the books have at most 3 price levels, so every loop finishes well inside it.

Notation: a bid is `(price, amount)`, both `uint96`, `price` in MON wei per 1e18 token units. `P` is the clearing price, `S` the supply (`sellAmount`), `alloc(b)` the tokens bid `b` receives, `paid(b)` the MON it pays, `D` the uniform deposit. `ceil(x / d)` is the integer ceiling.

## Propositions

### Clearing (`src/UniformClearing.sol`), proved over the real code through a thin harness

Harness: `test/symbolic/ClearingProofs.t.sol`, `SymClearing is UniformClearing` exposes `_initBook`, `_addBid`, `_settleStep`, `_allocation`, `_soldLowerBound` without changing them. Bounds: 2 or 3 bids, every `price` and `amount` any `uint96` with `amount > 0`, `S` any non-zero `uint96`, ties and equal prices allowed.

| # | Proposition |
| --- | --- |
| P1 | After settlement, `Σ alloc(b) ≤ S`. No more tokens are allocated than are for sale, in both the exact-cover case (`cum + q == S`, not oversubscribed, everyone at `P` fills in full) and the oversubscribed case (pro-rata at `P`). |
| P1b | After settlement, `Σ alloc(b) ≥ soldLowerBound`, the floor the engine uses to size the LP. So the LP never takes tokens that winners are owed. |
| P2 | For every bid, `alloc(b) ≤ b.amount`. |
| P6a | With at least one bid booked, `P` equals one of the bid prices, and `min price ≤ P ≤ max price`. |
| P8 | For every bid: `b.price > P ⇒ alloc(b) = b.amount`, and `b.price < P ⇒ alloc(b) = 0`. |
| P8b | If the book is not oversubscribed, every bid with `b.price ≥ P` fills in full. |
| P8c | Demand strictly above `P` is below `S`: no higher price could have sold the supply, so `P` is the lowest price at which the book clears and nobody is priced out needlessly. |
| P9 | Settling one level per transaction (`_settleStep(id, 1)` repeated) gives the same `P`, oversubscription flag and `sold` as settling in one call. |

### Engine (`src/AuctionEngine.sol`, `src/SealingLayer.sol`, `src/DepositLedger.sol`), proved through the deployed engine

Harness: `test/symbolic/EngineProofs.t.sol`. `setUp` is concrete: mocks, the engine, and one Degen round (deposit 10 MON, tick and reserve 0.001 MON, minimum bid 0.01 MON, supply 1,000 tokens). Only the bids are symbolic. Every bid goes through the real `commit` (the test computes `keccak256(abi.encode(price, amount, salt, sender))` over the symbolic bid) and the real `reveal`; every payment through the real `settle` and `claimRefund`. Nothing on the money path is stubbed. Reference values are computed in the test with independent formulas: the engine rounds up with `(x − 1) / d + 1`, the test with `(x + d − 1) / d`.

| # | Proposition |
| --- | --- |
| P3 | For every revealed bidder, `alloc(b) ≤ b.amount`, `paid(b) ≤ ceil(b.price × b.amount / 1e18)` (never more than their own bid would cost) and `paid(b) < D`. |
| P4 | For every revealed bidder, after `claimRefund` (called by a third party): `paid + refunded = D`, the bidder's MON balance rose by exactly `refunded`, and the round's balance fell by exactly `refunded`. A second `claimRefund` reverts. |
| P4b | With two bidders settled, the round's balance and the engine's MON balance both equal `paid(A) + paid(B)`, to the wei. |
| P5 | `paid(b) = ceil(alloc(b) × P / 1e18)`: `paid × 1e18 ≥ alloc × P` (rounds up, never below the exact value) and `(paid − 1) × 1e18 < alloc × P` (by less than one wei). |
| P6 | With two valid bids revealed, `P mod tick = 0` and `P ≥ reservePrice`. |
| P6b | `reveal` succeeds if and only if the bid is valid: `price mod tick = 0`, `price ≥ reservePrice`, `ceil(price × amount / 1e18) < D`, and `ceil(reservePrice × amount / 1e18) ≥ minBidSize`. |
| P7 | Three committers, each of whom may or may not reveal (all 8 combinations). After the reveal window, for every unrevealed committer `claim`, `claimRefund` and `claimTokens` revert and their balance is unchanged; `burnUnrevealed` succeeds exactly when someone did not reveal, sends exactly `(commits − reveals) × D` to `0x…dEaD`, nothing to its caller, and the engine's balance falls by exactly that; a second `burnUnrevealed` reverts. |

## What the proofs do not cover

- **Bounds.** Clearing: up to 3 bids (3 price levels). Engine: up to 2 symbolic bids in one round with fixed terms (P7: 3 fixed bids, symbolic reveal choices). Larger books are covered by the differential fuzz test against a brute-force reference (`UniformClearing.t.sol`, 40 bids, 10,000 runs under `FOUNDRY_PROFILE=deep`), the invariant suite, and the 1,000-bidder scale test, not by proof.
- **LP seeding, vesting, unsold disposal and creator proceeds** are not in the propositions. They are covered by the lifecycle conservation fuzz test, the invariant suite (`test/invariant/`) and the mainnet-fork tests.
- **Mocks.** The engine proofs use the mock token and adapter; the proofs do not reach `seedLP`.
- **Reentrancy** is not modelled symbolically; it is covered by unit tests (`test_Security_ReentrantClaimBlocked`) and the single `nonReentrant` lock on every state-changing entry point.

## Results

See the table in [`../SECURITY.md`](../SECURITY.md#symbolic-proofs) and the raw solver output in `reports/symbolic.txt`.

## Reproduce

```bash
brew install z3            # the solver forge's symbolic engine calls
cd contracts
forge test --symbolic --match-contract 'ClearingProofs|EngineProofs' --symbolic-loop 8 --symbolic-timeout 600
```

The proofs are named `prove_*` and are skipped by a plain `forge test`.
