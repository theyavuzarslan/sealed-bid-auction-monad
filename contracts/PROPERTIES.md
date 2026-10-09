# Correctness propositions for the money path

Method, after Category Labs (who formally verify the Monad client in Rocq): write each correctness claim as a precise proposition first, then search for a counterexample with a solver. A proposition that survives the search is proved for its stated domain; a counterexample is either a bug in the code or a hole in the proposition, and the write-up says which.

The search uses Foundry's built-in symbolic engine (`forge test --symbolic`, forge 1.8.3, solver z3 5.1.0 via Homebrew) over the real contracts compiled with the deployment settings (solc 0.8.34, via-IR). Inputs are symbolic within the stated domain, so a "proved" result covers every value in it, not a sample.

Notation: a bid is `(price, amount)`, both `uint96`, `price` in MON wei per 1e18 token units. `P` is the clearing price, `S` the supply (`sellAmount`), `alloc(b)` the tokens bid `b` receives, `paid(b)` the MON it pays, `D` the uniform deposit. `ceil(x / d)` is the integer ceiling.

## Propositions

### Clearing (`src/UniformClearing.sol`), through a thin harness

Harness: `test/symbolic/ClearingProofs.t.sol`. `SymClearing is UniformClearing` exposes `_initBook`, `_addBid`, `_settleStep`, `_allocation`, `_soldLowerBound` without changing them. Domain: 2 or 3 bids, every `price` and `amount` any `uint96` with `amount > 0`, `S` any non-zero `uint96`, ties and equal prices allowed.

| # | Proposition |
| --- | --- |
| P1 | After settlement, `Σ alloc(b) ≤ S`, in the exact-cover case (`cum + q == S`, everyone at `P` fills in full) and the oversubscribed case (pro-rata at `P`). |
| P1b | After settlement, `Σ alloc(b) ≥ soldLowerBound`, the floor the engine uses to size the LP. So the LP never takes tokens that winners are owed. |
| P2 | For every bid, `alloc(b) ≤ b.amount`. |
| P6a | With at least one bid booked, `P` equals one of the bid prices, and `min price ≤ P ≤ max price`. |
| P8 | For every bid: `b.price > P ⇒ alloc(b) = b.amount`, and `b.price < P ⇒ alloc(b) = 0`. |
| P8b | If the book is not oversubscribed, every bid with `b.price ≥ P` fills in full. |
| P8c | Demand strictly above `P` is below `S`: no higher price could have sold the supply, so `P` is the lowest price at which the book clears. |
| P9 | Settling one level per call (`_settleStep(id, 1)` repeated) gives the same `P`, oversubscription flag and `sold` as settling in one call. |

### Engine (`src/AuctionEngine.sol`, `src/SealingLayer.sol`, `src/DepositLedger.sol`), through the deployed engine

Harness: `test/symbolic/EngineProofs.t.sol`. `setUp` is concrete: mocks, the engine, and one Degen round (deposit 10 MON, tick and reserve 0.001 MON, minimum bid 0.01 MON, supply 1,000 tokens). Only the bids are symbolic. Every bid goes through the real `commit` (the test computes `keccak256(abi.encode(price, amount, salt, sender))` over the symbolic bid) and the real `reveal`; every payment through the real `settle`, `claimRefund` and `withdrawOwed`. Nothing on the money path is stubbed. Reference values are computed in the test with independent formulas: the engine rounds up with `(x − 1) / d + 1`, the test with `(x + d − 1) / d`.

| # | Proposition |
| --- | --- |
| P3 | For every revealed bidder, `alloc(b) ≤ b.amount`, `paid(b) ≤ ceil(b.price × b.amount / 1e18)` (never more than their own bid would cost) and `paid(b) < D`. |
| P4 | For every revealed bidder, after `claimRefund` (called by a third party): `paid + refunded = D`, the bidder's MON balance rose by exactly `refunded`, the round's balance fell by exactly `refunded`, nothing is owed to an EOA, and a second `claimRefund` reverts. |
| P4b | With two bidders settled, the round's balance and the engine's MON balance both equal `paid(A) + paid(B)`, to the wei. |
| P5 | `paid(b) = ceil(alloc(b) × P / 1e18)`; split into `paid × 1e18 ≥ alloc × P` (never below the exact value) and `(paid − 1) × 1e18 < alloc × P` (less than one wei above it). |
| P6 | With two valid bids revealed, `P mod tick = 0` and `P ≥ reservePrice`. |
| P6b | `reveal` succeeds if and only if the bid is valid: `price mod tick = 0`, `price ≥ reservePrice`, `ceil(price × amount / 1e18) < D`, and `ceil(reservePrice × amount / 1e18) ≥ minBidSize`. |
| P7 | Three committers, each of whom may or may not reveal (all 8 combinations). After the reveal window, for every unrevealed committer `claim`, `claimRefund` and `claimTokens` revert and their balance is unchanged; `burnUnrevealed` succeeds exactly when someone did not reveal, sends exactly `(commits − reveals) × D` to `0x…dEaD`, nothing to its caller, and the engine's balance falls by exactly that; a second `burnUnrevealed` reverts. |
| O1 (v2) | A bidder contract that rejects MON, with a valid bid, settled by a third party: the failed push credits exactly its refund to `refundsOwed[bidder]` and to `totalOwed`; the round's balance falls by the refund while the engine's MON does not move, so engine MON = `roundBalance + totalOwed`. |
| O2 (v2) | Then `withdrawOwed(to)`: to the rejecting address itself it reverts and changes nothing; to an address that takes MON it pays exactly the owed refund, once, and zeroes `refundsOwed` and `totalOwed`; a second call reverts, and nobody else can withdraw it. |
| W1 (v2) | `openRound` accepts the windows if and only if `commitEnd ≥ now + 5 minutes` and `revealEnd ≥ commitEnd + 5 minutes` (every other term valid; every `uint64` pair). |

### Exit auction (`src/exit/ExitAuction.sol`)

| # | Proposition |
| --- | --- |
| W2 (v2) | The constructor accepts the two window durations if and only if each is in [5 minutes, 30 days] (every other parameter valid; every `uint64` pair). |

## Results

z3 does not decide most queries that multiply or divide two symbolic 256-bit values (the pro-rata share `amount × (S − qtyAbove) / qtyAtPrice`, and `price × amount / 1e18` with both symbolic) within the limit. Where the full domain timed out, the proposition was also run with one side of the product fixed, which keeps the search linear and still covers every value of the other side; the domain is part of the result. Each test ran on its own with `--symbolic-timeout 300` and a 900 s wall-clock cap. Raw output: `reports/symbolic.txt`.

| # | Domain | Result |
| --- | --- | --- |
| P1, P1b, P2 | 2 and 3 bids, uint96 | **Timeout** (900 s) |
| P1, P1b, P2 | 2 and 3 bids, amounts and supply uint16 | **Timeout** |
| P1, P1b, P2 | 2 bids, amounts and supply uint8 | Inconclusive: candidate counterexample did not replay |
| P6a | 3 bids, uint96; also with uint8 prices | Inconclusive: candidate counterexample did not replay |
| P8 | 3 bids, uint96 | **Proved** (460 paths, 33 s) |
| P8b | 3 bids, uint96 | **Proved** (520 paths, 48 s) |
| P8c | 3 bids, uint96; also with uint8 prices | Inconclusive: candidate counterexample did not replay |
| P9 | 3 bids, uint96 | Path limit at the default 1,024 paths; with `--symbolic-max-paths 16384`: inconclusive, candidate counterexample did not replay (1,345 paths, 127 s) |
| P3, P4, P5 | one bidder, every uint96 price, 100 tokens | **Proved** (66 paths, 35 s) |
| P3, P4, P5 | one bidder, every uint96 amount at 0.005 MON or at the reserve price; full domain | **Timeout** |
| P5 (two inequalities) | one bidder, every uint96 price, 100 tokens | **Proved** (42 paths, 10 s) |
| P5 (two inequalities) | fixed price or full domain | **Timeout** |
| P3, P4, P5, P4b | two bidders: full domain, or 600 tokens each and every uint96 price pair | **Timeout** |
| P6 | two bidders, full domain | **Timeout** |
| P6 | 600 tokens each, every uint96 price pair | Inconclusive: candidate counterexample did not replay |
| P6b | every uint96 amount at 0.005 MON | **Proved** (24 paths, 184 s) |
| P6b | full domain; every uint96 price at 100 tokens | Inconclusive: candidate counterexample did not replay |
| P7 | all 8 reveal patterns | **Proved** (87 paths, under 1 s) |
| O1, O2 | every uint96 price, 100 tokens | **Proved** (414 paths, 42 s) |
| O1, O2 | full domain | **Timeout** |
| W1 | every uint64 pair | **Proved** (10 paths, under 1 s) |
| W2 | every uint64 pair | Not run: the symbolic engine stops on a constructor with symbolic arguments ("symbolic memory read"). Covered instead by `test_W2_ExactBoundaries` (every combination of 5 min − 1, 5 min, 30 days, 30 days + 1) and two fuzz tests of the "if and only if" (`test/SecurityPass.t.sol`). |

**No counterexample was found.** Every "inconclusive" result is a candidate input that the solver produced and forge then replayed concretely against the real code: in every case the assertion held. They come from the symbolic model, not from the contracts; the pattern (they appear with symbolic mapping keys, i.e. price levels, and with the pro-rata division) points at the solver's treatment of hashed storage slots and non-linear arithmetic. They are recorded as inconclusive, not as proved.

Read the table as: the clearing rules that need only comparisons and sums (P8, P8b) are proved over the full uint96 domain for 3 bids; the payment arithmetic (P3–P5) and the v2 owed-refund flow (O1, O2) are proved for a single bidder over every price; reveal validation (P6b) is proved over every amount; P7 and W1 are proved outright. The propositions without a proof here are covered by tests, not by proof:

- **P1, P1b, P2, P6a, P8c, P9, P6**: the differential fuzz test against a brute-force reference (`testFuzz_MatchesReference`, books of 1 to 40 bids, 10,000 runs under `FOUNDRY_PROFILE=deep`), the invariant suite (`invariant_ClearingAndAllocations` recomputes `P`, oversubscription and every allocation from the revealed bids after random interleavings), `test_SettleInSteps_SameResult`, and the clearing edge cases added in this pass (`test/ClearingEdgeCases.t.sol`).
- **P3–P5 for two or more bidders**: `invariant_SettledBiddersPaidExactly` (every settled bidder paid exactly `ceil(alloc × P / 1e18)`, never above their own bid, refunded the rest, received exactly their allocation) and the 1,000-bidder scale test, which reconciles every payment to the wei.

## What the proofs do not cover

- **Domains.** Clearing: up to 3 bids. Engine: one round with fixed terms; one or two symbolic bids; P7 with 3 fixed bids and symbolic reveal choices.
- **LP seeding, vesting, unsold disposal and creator proceeds** are not in the propositions. They are covered by the lifecycle conservation fuzz test, the invariant suite (`test/invariant/`), `test/EngineEdgeCases.t.sol` and the mainnet-fork tests.
- **Mocks.** The engine proofs use the mock token and adapter; they do not reach `seedLP`.
- **Reentrancy** is not modelled symbolically; it is covered by unit tests (`test_Security_ReentrantClaimBlocked`, `test_Claim_ReentrancyBlocked`) and the single `nonReentrant` lock on every state-changing entry point.

## Reproduce

```bash
brew install z3            # the solver forge's symbolic engine calls
cd contracts
# one test at a time (as recorded), for example:
forge test --symbolic --match-contract '^EngineProofs$' --match-test '^prove_P7_' --symbolic-timeout 300 -j 1
# or everything (long; several tests run to the timeout):
forge test --symbolic --match-path 'test/symbolic/*' --symbolic-timeout 300
```

Do not pass `--symbolic-loop`: with it set, forge 1.8.3 reported "all symbolic paths reverted" for the engine proofs that run past `settle`, although the same tests explore normally without it. The proofs are named `prove_*` and are skipped by a plain `forge test`.
