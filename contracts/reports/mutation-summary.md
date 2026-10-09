# Mutation testing of the money path (v2, 9 Oct 2026)

A mutant is a one-token change to the contract (`>=` becomes `>`, `-` becomes `+`, a `require` becomes `require(true)`, …). If the test suite still passes, the suite cannot tell the mutant from the real code: either the change is equivalent (it cannot alter behaviour) or there is a gap in the tests. This pass ran every mutant of the five money-path files against the suite, classified every survivor, wrote tests for the real gaps, and re-ran the survivors.

## Results

| File | Mutants (valid) | Killed before | Score before | Killed after | Score after | Surviving | Of which equivalent or unreachable |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `src/DepositLedger.sol` | 85 | 76 | 89.4% | 80 | 94.1% | 5 | 5 |
| `src/SealingLayer.sol` | 76 | 70 | 92.1% | 72 | 94.7% | 4 | 4 |
| `src/UniformClearing.sol` | 238 | 166 | 69.7% | 201 | 84.5% | 37 | 37 |
| `src/AuctionEngine.sol` | 832 (+2 invalid) | 646 | 77.6% | 759 | 91.2% | 73 | 73 |
| `src/exit/ExitAuction.sol` | 350 (+5 invalid) | 277 | 79.1% | 316 | 90.3% | 34 | 34 |
| **Total** | **1,581** | **1,235** | **78.1%** | **1,428** | **90.3%** | **153** | **153** |

Score = killed / valid mutants. "Invalid" mutants do not compile and are excluded. After this pass **every surviving mutant is classified as equivalent or unreachable**, with a one-line reason each, in `reports/mutation-<File>.txt` (which also lists every mutant and the test that killed each one added in this pass). No surviving mutant points at a bug in `src/`.

Where the 153 survivors come from:

- **Unsigned comparisons with zero or with `type(uint256).max`** (`!= 0` vs `> 0`, `== 0` vs `<= 0`, `x != NONE` vs `x < NONE`), loop bounds (`i < n` vs `i != n`) and two-value enums: identical by construction. This is most of them.
- **Zero-amount guards**: the guarded transfer or debit of 0 changes nothing (`if (lpMon != 0) _debit(...)`).
- **Gas-only differences**: the reveal hint in `_insertLevel`. A rejected hint makes the insert walk from the head of the book; the resulting book is identical, only the gas differs (`testFuzz_RevealWithHint_AnyHintSameBook` checks the book).
- **Dead stores**: `qtyAtPrice`, `countAtPrice`, `qtyAbove` in the undersubscribed branch of `_settleStep` are read only when the book is oversubscribed.
- **Defence in depth that no path reaches**: the `_tokensOut` cap in the engine, the `over-allocated` and `share accounting` checks in the exit auction. The invariant suite and the conservation fuzz tests show the guarded condition never occurs.
- **Equivalent in practice**, stated with their bound: `_vestedAmount` with `t % start` instead of `t - start` (identical for every timestamp before 2083); the exit auction's dust release with `sold % allocated` (identical whenever allocated > sold/2, and pro-rata dust is smaller than the number of bids at the clearing price); two exit-auction comparisons that need a falling share price, which `DemoVault` cannot have.

## What the survivors found, and the tests added

The first run showed real gaps, all in the tests, none in the contracts:

| Gap | Mutants killed by the new tests | Test added |
| --- | ---: | --- |
| Most `openRound` rules and their boundaries were untested (a handful of the ~25 rules had a test) | 47 | `test/EngineEdgeCases.t.sol`: `test_OpenRules_Amounts`, `_LpAndSplits`, `_Presets`, `_TokenCreditingMoreIsRejected` |
| Engine constructor checks | 9 | `test_Constructor_EveryCheck` |
| LP seeding across several venues: the last venue's remainder was never exercised | 28 | `test_LP_TwoVenues_LastTakesTheRemainder` (two adapters, amounts that do not divide evenly) |
| LP sides that round to zero; a 100% LP share; adapter overspend; a position minted to another owner (below and above the engine's address); MON from an adapter after seeding; the abandonment flag | 14 | `test_LP_*`, `test_AbandonLP_RecordsAbandonment` |
| Access and one-shot guards: `withdrawProceeds` before the LP is done or by an address below the creator's; a second `sweepDust`; `quote` and `claimVested` without a reveal or vesting; unknown rounds; a zero-amount reveal | 15 | `EngineEdgeCases.t.sol` |
| **Exact cover at the clearing price** with a lower bid: `cum + q >= supply` vs `>` changes the clearing price, and no test had demand exactly equal to the supply above a lower level (PRD bug #4) | 1 | `test/ClearingEdgeCases.t.sol`: `test_ExactCover_WithLowerLevel_ClearsAtTheCoveringLevel` |
| `findHint`'s return value was never checked (a wrong hint is harmless, so nothing failed) | 22 | `test_FindHint_ReturnsLowestLevelAbove` |
| Empty book; more bids at the clearing price than units for sale; clearing input checks | 12 | `ClearingEdgeCases.t.sol` |
| Reveal window end is exclusive; a backup note of exactly the maximum length | 2 | `test/SecurityPass.t.sol` |
| Ledger checks unreachable through the engine (`paid < deposit`, a zero refund is a no-op) | 4 | `test/DepositLedger.t.sol` (harness over the real `DepositLedger`) |
| Exit window bounds (5 minutes to 30 days) at their exact boundaries | 9 | `test/SecurityPass.t.sol`: `test_W2_ExactBoundaries`, two fuzz tests; the repaired `test_Constructor_RejectsShortWindows` |
| Exit auction: refund or quote for an unrevealed bidder; stored windows and opening block; settle timing; other constructor checks; views before the first round; **v2 `redeem >= previewRedeem` with the surplus going to the vault** | 30 | `test/ExitEdgeCases.t.sol` (with `test/mocks/PayoutVault.sol`, a vault whose `redeem` pays more, twice, or less than its preview) |

**A test-suite defect found on the way.** In forge 1.8, `new Contract(...)` inside a test is deployed through `vm.deployCode` (dynamic test linking). `vm.expectRevert(...)` followed by such a `new` ends the test function at that revert, and the test passes: every statement after the first expected revert silently never runs. Four tests were affected: `ExitAuctionTest.test_Constructor_RejectsShortWindows` (its "reveal too short" and both new "window too long" checks never ran), `UniswapV3AdapterTest.test_Constructor_Checks` (second check), and two of the new tests. All were rewritten as `try new … catch Error(string memory why) { assertEq(why, …) }`, and the constructor checks now run (and kill their mutants).

## Method

**Why not `forge test --mutate` as is.** forge 1.8.3's built-in runner was tried first. On this project it recompiles the whole via-IR project, tests included, for every mutant: about 1.3 mutants per minute with four workers here, which puts `AuctionEngine.sol` alone at roughly 17 hours. The partial run on the `security-pass` branch also reported survivors that are killed when the same mutant is applied by hand (for example `unrevealed * deposit` → `unrevealed ^ deposit` in `burnUnrevealed`, killed by `test_BurnUnrevealed`). That report is kept as `reports/mutation-DepositLedger-v1-forge.raw.txt` (v1 sources) for reference.

**What ran instead** (`contracts/tools/mutation/`):

1. `genmut.py` generates mutants from the solc AST with forge's operator set: binary-operator replacement, `require` condition → `true` and → negated, assignment and initializer → literal, `!x` → `x`. One reduction: an arithmetic operator is replaced by the other four arithmetic operators (`+ - * / %`), not also by the bitwise, shift and power operators forge tries, which are almost always killed and dominate the count.
2. `mutdriver.py` takes one mutant at a time per worker (8 workers). It compiles the mutated source with the project's own settings (solc 0.8.34, via-IR, optimizer 200 runs), copies the rebuilt `src` artifacts into a fully compiled copy of the project whose sources are unchanged, and runs `forge test --fail-fast --fuzz-seed 0x5eed`. forge deploys `new AuctionEngine(...)` and the other `src` contracts in tests from those artifacts (dynamic test linking), so the tests run the mutated bytecode without recompiling the test files. Test files whose contracts inherit `src` contracts (the clearing and ledger harnesses) are recompiled with each mutant. A run that recompiles anything is discarded as an error (none was). Excluded from each run: the scale test (skipped outside the `scale` profile anyway), the Uniswap adapter unit tests (they do not touch these files), the fork and the symbolic tests.
3. Every mutant that survived the "before" suite was re-run against the suite with the new tests; each survivor after that was classified by hand.

Sanity checks: hand-applied mutants (`_mulDivUp(...) + 1` → `+ 2`, `roundBalance += amount` → `-= amount`) are killed through the driver, and the dynamic-linking swap was confirmed by tracing a test that failed only under the mutant.

Before-run wall time: 53 minutes for 1,588 mutants on 12 cores (mean 15 s per mutant per worker).

Reproduce (from `contracts/`): `tools/mutation/run.sh /tmp/even-mutation 8`, then compare `/tmp/even-mutation/<File>.jsonl` with the lists in `reports/mutation-<File>.txt`.
