# Security

Even is a sealed-bid, uniform-price batch auction on Monad: bidders commit a hash and a uniform MON deposit, reveal after the commit window, and everyone who wins pays the same clearing price. This page lists what has been checked, how, with what result, and what has not. **The contracts have not had an external audit.**

## Scope

Everything between "a bidder sends MON" and "a bidder gets tokens or a refund" is in scope:

| File | Role |
| --- | --- |
| `contracts/src/DepositLedger.sol` | Uniform deposits, per-round `roundBalance`, burning unrevealed deposits, refund push with owed-refund fallback (v2) |
| `contracts/src/SealingLayer.sol` | Commit (`keccak256(abi.encode(price, amount, salt, msg.sender))`), reveal, allowlist proof, minimum windows (v2) |
| `contracts/src/UniformClearing.sol` | Price-level book, clearing price, pro-rata at the clearing price, resumable settlement |
| `contracts/src/AuctionEngine.sol` | The launch product: presets, payments and refunds, LP seeding and locking, unsold disposal, vesting, the LP grace escape |
| `contracts/src/exit/ExitAuction.sol` | Vault exit auction (use case 2) on the same three layers |

Also built and tested, but off the bidder money path: the Uniswap v3 adapter and price math (`src/adapters/`), `TokenFactory`, and `DemoVault`. Vendored OpenZeppelin v5.1.0 (`src/vendor/`) is unmodified and excluded from analysis.

**Deployments.**

| Version | State | Addresses |
| --- | --- | --- |
| v1 (git tag `mainnet-v1`) | Deployed on Monad mainnet 6 Oct 2026; holds round 1 (readable at `#/v1/round/1`) | `AuctionEngine` [`0x0Fa0E7Db5b2c2146D77E41579030A842492E2120`](https://monadscan.com/address/0x0Fa0E7Db5b2c2146D77E41579030A842492E2120), `TokenFactory` [`0x41F968CcA0a95d4289D356c24668b1c72e645DbF`](https://monadscan.com/address/0x41F968CcA0a95d4289D356c24668b1c72e645DbF), `UniswapV3Adapter` [`0x71da6a936f1196881C236c62a084ddEB448772Ba`](https://monadscan.com/address/0x71da6a936f1196881C236c62a084ddEB448772Ba) (details in [SUBMISSION.md](SUBMISSION.md)) |
| **v2 (current)** | Live on Monad mainnet since 9 Oct 2026 (block 111880616); the app uses it | `AuctionEngine` [`0x4Fd754Fa8EaE4E93349e5920B994ace64eaA8ae4`](https://monadscan.com/address/0x4Fd754Fa8EaE4E93349e5920B994ace64eaA8ae4); reuses v1's `TokenFactory` and `UniswapV3Adapter`. Changes: [contracts/CHANGES-v2.md](contracts/CHANGES-v2.md) |

The results below are for **v2** unless marked otherwise. v2 fixes four review items in v1 (minimum windows, a refund to a contract that rejects MON could block a round's settlement, ERC-4626 `redeem` equality, compiler); none of them lets anyone take another party's funds in v1.

## Threat model

The PRD names eight bug classes for the money path. For each: where it is handled and what checks it.

| # | Bug class | How it is handled | Checked by |
| --- | --- | --- | --- |
| 1 | Commit missing the salt | The preimage is `abi.encode(price, amount, salt, msg.sender)` | Unit tests (`test_RevealRules`, wrong-salt reveals in the invariant handler); every symbolic engine proof commits the real hash |
| 2 | Commit not bound to `msg.sender` | `msg.sender` is in the preimage and the commitment is stored under `msg.sender` | Invariant handler reveals other bidders' bids and requires a revert; `test_Security_NobodyClaimsForSomeoneElse` |
| 3 | Slashing accounting on non-reveal | Unrevealed deposits are burned in aggregate, `(commits − reveals) × deposit`, only to `0x…dEaD`, idempotent | Symbolic proof P7 (all 8 reveal patterns of 3 committers); invariant `UnrevealedDepositsOnlyBurned` |
| 4 | Off-by-one at the clearing price | Pro-rata rounds down, payments round up (`ceil(alloc × P / 1e18)`) | Symbolic P8, P8b (proved, 3 bids) and P5 (proved for one bidder within bounds; P1, P2 timed out); differential fuzz against a brute-force reference; invariants `ClearingAndAllocations`, `SettledBiddersPaidExactly`; exact-cover boundary test |
| 5 | Reentrancy on refund and claim | One engine-wide `nonReentrant` lock; effects before every transfer; refunds pushed with a 50,000-gas stipend | `test_Security_ReentrantClaimBlocked`, `test_Claim_ReentrancyBlocked`; owed-refund proof O1/O2 |
| 6 | Gas DoS via dust commits | Mandatory minimum bid, measured at the reserve price; settlement cost scales with price levels, not bids, and is resumable | 1,000-bidder scale test under Monad gas rules (below) |
| 7 | Sandwichable LP seed | The pool is seeded only at the clearing price, before any token is delivered; a pool that cannot be seeded at that price is abandoned after a grace period and its MON burned | Mainnet-fork tests against real Uniswap v3 and the GoPlus locker (`test/fork/`); AUDIT.md second review H1 |
| 8 | `price × amount` precision favouring the bidder | Every bid-size check and payment rounds up against the bidder | Symbolic P3, P5, P6b (proved within stated bounds); PRD bug #8 fuzz test; invariant `SettledBiddersPaidExactly` |

Out of scope by design: privacy of losing bids after the round (bids are public once revealed), front-running protection beyond commit-reveal (Monad has no encrypted mempool), KYC.

## Results

Everything below was run on 9 Oct 2026 on branch `contracts-v2` with forge 1.8.3 and solc 0.8.34 (via-IR, the deployment settings). Raw output is in `contracts/reports/`.

### Reviews

| Review | Scope | Outcome |
| --- | --- | --- |
| First internal review (22 Sep), [AUDIT.md](AUDIT.md) | The agent-built first version | 3 critical (anyone could settle early, lock a bidder's deposit, or bid without depositing), all from one root cause; resolved by the rewrite, each with a regression test |
| Second internal review (23 Sep), adversarial, on a copy | The rewritten engine | No path that loses or double-spends MON or tokens. 1 High (LP's MON drainable after a "relaxed" re-seed), 2 Medium, 3 Low: all fixed; every proof of concept now asserts the attack fails (`test/AuditRegressions.t.sol`) |
| Static-analysis triage (6–9 Oct), [STATIC-ANALYSIS.md](contracts/STATIC-ANALYSIS.md) | v1 | One manual finding, O1: a bidder contract that rejects MON could block its round's creator proceeds and dust sweep. **Fixed in v2** (owed refunds) |
| Independent read-only review of v2 (Codex, gpt-5.5) | v2 diff | No significant issue. 4 low/info: 2 fixed (exit windows capped at 30 days; the app shows owed refunds), 1 accepted, 1 documented ([CHANGES-v2.md](contracts/CHANGES-v2.md)) |
| Second independent review of v2 (Codex, gpt-5.6-sol, high effort) | v2 diff since `mainnet-v1` | No critical, high or medium issue; reentrancy (including read-only), owed-refund isolation and every accounting path checked. 1 low fixed (ExitAuction now measures what the vault actually paid and records any surplus), 1 info documented (EIP-7702 wallets that refuse refunds must call `withdrawOwed`) |
| Vault exit pre-mainnet review (9 Oct) | `ExitAuction`, `DemoVault`, `DeployExitMainnet.s.sol`, plus a full two-round rehearsal of `script/live-exit.sh` on a Monad mainnet fork against real WMON | 1 medium **fixed**: with an allowlisted exit auction, anyone could deposit but only allowlisted holders can ever exit, so an outsider's deposit could never come out. `DemoVault` now takes deposits only for holders proven to be on the allowlist (`proveHolder`), with tests. 2 info documented (below). The Codex pass hit its usage limit before reporting and will be re-run |
| This pass | v2 money path | **No bug found in `src/`.** Gaps were in the tests: 193 mutants that survived the earlier suite are now killed by new tests, and two existing tests were found to stop silently after their first expected revert (below) |

### Tests

| Run | Command (from `contracts/`) | Result |
| --- | --- | --- |
| Unit, fuzz (512 runs), invariants (32 × 128) | `forge test` | 154 passed, 0 failed, 3 skipped (the scale and fork suites, which need their own profile or an RPC); 16 s |
| Same, under Monad execution rules | `forge test --network monad --hardfork monad:MonadTen` | 154 passed, 0 failed |
| Deep | `FOUNDRY_PROFILE=deep forge test` | 151 passed (before the 9 Oct vault fix); every fuzz test at 10,000 runs; invariants 500 runs × depth 256 = **128,000 calls, 0 reverts**; 548 s |
| Monad mainnet fork | `forge test --match-path 'test/fork/*' --fork-url https://rpc2.monad.xyz --network monad --hardfork monad:MonadTen` | 19 passed, against the real Uniswap v3 factory and position manager and the GoPlus `UniV3LPLocker` on Monad mainnet (repricing, griefed pools, split fee tiers, lock terms) |
| 1,000 bidders, Monad gas rules | `FOUNDRY_PROFILE=scale forge test --match-contract ScaleMockTest --network monad --hardfork monad:MonadTen -vv` | Pass: 1,000 bidders over 289 price levels; every allocation and payment checked against a reference computed from the raw bids; MON and tokens reconciled to the wei. Gas below |
| 1,000 bidders on a Monad mainnet fork (real Uniswap v3 and GoPlus) | `FOUNDRY_PROFILE=scale forge test --match-contract ScaleForkTest --fork-url <rpc>` | v1 result in `reports/scale-fork-1000.txt` (pass). Not re-run on v2: the public RPCs refused this load on 9 Oct (rpc2: HTTP 429 rate limit; rpc1: no historical state). v2's engine changes on this path (the window minimum at open, the refund push) are covered by the mock-based 1,000-bidder run above and the fork tests |

The fuzz tests include a differential test of the clearing against a brute-force reference (books of 1 to 40 bids), a lifecycle conservation test, PRD conformance tests for bug #8 (rounding never favours the bidder) and snipe resistance (any reveal order gives the same result), and exit-auction conservation and interleaving tests.

**Invariants** (`test/invariant/`): random interleavings of every engine action (open, commit, reveal, settle in random step sizes, seed or fail to seed the LP, abandon, claim / claimRefund / claimTokens by anyone, vesting, burn, proceeds, dust, disposal, and in v2 `withdrawOwed`) over up to four concurrent Degen and Raise rounds. Twelve bidders, two of which are contracts that cannot take MON: one reverts on receive, one burns all the gas it is given. The handler knows, for every call, whether it must succeed or fail, and checks both. Ten invariants hold throughout:

- engine MON = Σ `roundBalance` + `totalOwed` (v2);
- each bidder's `refundsOwed` = refunds credited to it − withdrawn, `totalOwed` = Σ `refundsOwed`, and only the two contract bidders are ever owed anything (v2);
- each round's balance = deposits − burned − refunds (pushed or owed) − LP MON − proceeds;
- engine tokens = Σ each round's unsent tokens, every token out accounted as delivery, LP or disposal;
- clearing price, oversubscription and every allocation equal a reference recomputed from the revealed bids; P on the tick grid and at or above the reserve; allocations ≤ supply;
- every settled bidder paid exactly `ceil(alloc × P / 1e18)`, never above their own bid, and received the rest of the deposit (pushed or owed) and exactly their allocation;
- refunds never exceed deposits; an unrevealed deposit only ever goes to `0x…dEaD`; nobody is paid twice; the ledger counts match history.

A canary run confirms the random walks reach the v2 paths: within the default campaign a refund push fails and is owed, and an owed refund is withdrawn (`reports/invariant-canary.txt`).

**Gas under Monad rules**, 1,000 bidders (`reports/scale-mock-1000-monad.txt`), per transaction including intrinsic gas:

| Operation | Mean | Max |
| --- | ---: | ---: |
| commit | 118,333 | 152,303 |
| reveal with hint | 174,735 | 218,671 |
| reveal without hint (walks the book) | 337,525 | 2,543,606 |
| claim | 244,082 | 295,627 |
| settle, 100 price levels per call | 708,255 | 954,007 |
| seedLP (mock adapter) | 621,562 | |

Bidder journey (commit + hinted reveal + claim): 537,150 gas on average, about $0.0014 at 102 gwei and $0.0252 per MON; worst case (unhinted reveal) 2,991,536 gas, about $0.0077. Both under the PRD's $0.01 target. Monad bills the gas **limit**, not the gas used, so these are the numbers a wallet should set limits from, with a margin.

### Mutation testing

Every mutant of the five money-path files (1,581 that compile) was run against the full suite; survivors were analysed, tests were added for real gaps, and survivors were re-run. Method and per-mutant results: [contracts/reports/mutation-summary.md](contracts/reports/mutation-summary.md).

| File | Mutants | Score before | Score after | Surviving (all equivalent or unreachable) |
| --- | ---: | ---: | ---: | ---: |
| `DepositLedger.sol` | 85 | 89.4% | 94.1% | 5 |
| `SealingLayer.sol` | 76 | 92.1% | 94.7% | 4 |
| `UniformClearing.sol` | 238 | 69.7% | 84.5% | 37 |
| `AuctionEngine.sol` | 832 | 77.6% | 91.2% | 73 |
| `exit/ExitAuction.sol` | 350 | 79.1% | 90.3% | 34 |
| **Total** | **1,581** | **78.1%** | **90.3%** | **153** |

Each of the 153 survivors has a stated reason (for example `!= 0` vs `> 0` on an unsigned value, a reveal hint that changes only gas, a dead store, a defensive check no path reaches). The largest gaps closed: most `openRound` rules had no test; LP seeding over several venues was never exercised; an **exact cover at the clearing price with a lower bid** (PRD bug #4's boundary) had no test; the exit auction's v2 rule `redeem >= previewRedeem` had no test with a vault that pays more.

**Test-suite defect found.** In forge 1.8, `new Contract(...)` in a test is deployed through `vm.deployCode`, and `vm.expectRevert` followed by such a `new` ends the test at that revert while reporting a pass, so the rest of the test never ran. Two existing tests were affected: the v2 exit-window test `test_Constructor_RejectsShortWindows` (its "reveal too short" and both "window too long" checks never executed) and the adapter's `test_Constructor_Checks` (second check). Both were rewritten with `try new … catch`, as were two new tests with the same pattern; the checks now run and pass.

### Symbolic proofs

Propositions written first, then a counterexample search with `forge test --symbolic` (z3) over the real contracts: [contracts/PROPERTIES.md](contracts/PROPERTIES.md).

| Proposition | Result |
| --- | --- |
| Above the clearing price fills in full, below gets nothing (P8); not oversubscribed ⇒ everyone at or above P fills (P8b) | **Proved**, 3 bids, every uint96 price and amount |
| Unrevealed deposits go only to `0x…dEaD`, exactly `(commits − reveals) × deposit`, once (P7) | **Proved**, all 8 reveal patterns of 3 committers |
| One bidder: pays `ceil(alloc × P / 1e18)`, never above their own bid and below the deposit, `paid + refund = deposit`, refund received once (P3, P4, P5) | **Proved** for every uint96 price at a fixed amount; timeout on the full domain |
| `reveal` accepts exactly the valid bids (P6b) | **Proved** for every uint96 amount at a fixed price; inconclusive on the full domain |
| v2: a failed refund push credits exactly the refund to `refundsOwed` and `totalOwed`; `withdrawOwed` pays exactly that, once, only to the owed bidder (O1, O2) | **Proved** for every uint96 price at a fixed amount; timeout on the full domain |
| v2: `openRound` accepts the windows iff both are at least 5 minutes (W1) | **Proved**, every uint64 pair |
| v2: exit windows accepted iff in [5 minutes, 30 days] (W2) | Not supported by the symbolic engine (constructor arguments); covered by exact-boundary and fuzz tests |
| Σ allocations ≤ supply, ≥ the LP's lower bound; no bid over-allocated (P1, P1b, P2) | Timeout (pro-rata division); covered by the differential fuzz test and the invariants |
| P is a bid price (P6a); demand above P is below supply (P8c); stepwise settlement = one-shot (P9); P on grid (P6) | Inconclusive: the solver's candidate counterexamples did not replay; covered by fuzz and invariants |

**No counterexample was found.** "Inconclusive" means the solver proposed an input and forge replayed it against the real code: the property held. Those results, and timeouts, are reported as such, not as proofs.

### Static analysis

| Tool | Result on v2 | Triage |
| --- | --- | --- |
| Slither 0.11.6 | 63 results (6 High-impact, 22 Medium, 33 Low, 2 Informational) | No true positive. Versus v1: the `ExitAuction` strict-equality finding is gone (fixed in v2); one new Informational (the `_pushRefund` assembly call) |
| Aderyn 0.6.8 | 4 High, 9 Low issue types | No true positive. New instance: `withdrawOwed(to)` sends ETH to a caller-chosen address, but only the caller's own owed refund |
| `forge lint` (all severities) | 249 diagnostics outside vendored OpenZeppelin, no error-level lint | No true positive; three new v2 items triaged |
| AgentGuard CLI 1.1.28 (`agentguard scan contracts/src`) | 4 findings, the same as on 24 Sep: `HIDDEN_TRANSFER` in `SafeTransferLib.sendValue` (intended) and in vendored OpenZeppelin `Address`; `WALLET_DRAINING` on the vendored `IERC20` and `IERC1363` interface declarations | Triaged in [SUBMISSION.md](SUBMISSION.md#security-scan-agentguard); raw output `reports/agentguard-v2.txt` |

Full triage: [contracts/STATIC-ANALYSIS.md](contracts/STATIC-ANALYSIS.md).

## Monad-specific considerations

- **Gas is billed on the gas limit.** A transaction pays `gas_limit × price`, whatever it uses. The gas table above is what limits should be set from; an over-estimated limit (some wallets set a very high one when estimation reverts) is paid in full. `settle(maxSteps)` lets a caller bound the work, and so the gas, of each settlement transaction.
- **10 MON reserve balance.** Monad enforces a 10 MON reserve on the sender's ending balance (with an exception for an "emptying" transaction). A commit, which sends the deposit, that would breach it can revert and still pays gas. This affects wallet UX, not contract safety: refunds, burns and proceeds are credits and are not affected.
- **~300 ms blocks, one-second timestamps.** Three or four blocks share a timestamp. Phases are half-open intervals on the timestamp (commit `< commitEnd`; reveal `[commitEnd, revealEnd)`; settle and burn `>= revealEnd`), so no second belongs to two phases; boundary tests pin this (`test_Reveal_WindowEndIsExclusive`). v2 requires windows of at least 5 minutes, so a creator cannot open a round too short for honest bidders to reveal in (their deposits would then be burned); exit windows are also capped at 30 days.
- **Contract size.** `AuctionEngine` is 21,928 bytes of runtime code, under Ethereum's 24,576-byte limit and far under Monad's 128 KB.
- **Pricing differences.** Cold storage and cold accounts cost more on Monad (MIP-8: each price level is its own storage page). An unhinted reveal walks the book and cost up to 2.54M gas at 289 levels under Monad rules, 3× the Ethereum figure; the app always passes a `findHint` hint (a stale or wrong hint is safe: it only costs gas).
- **No encrypted mempool.** Privacy comes from commit-reveal alone; bids become public once revealed. Snipe-resistant: submission timing no longer determines price.

## Known limitations

- **No external audit.** The reviews above are internal or AI-assisted.
- **Unrevealed deposits are burned.** A bidder who commits and does not reveal in time loses the whole deposit (sent to `0x…dEaD`, to nobody). The app keeps an encrypted backup of each bid (in the commit's `note` and locally), so it can be revealed from another device with the same wallet where the wallet signs deterministically, and offers a backup file otherwise (decision 33).
- **Bids are public after the round.** Commit-reveal hides bids only until the reveal window; after it, every revealed price and amount is on chain by design. The number and timing of commitments, and the deposit cap (which bounds bid size), are visible from the start.
- **A bidder contract that rejects MON** must call `withdrawOwed(to)` to collect its refund; a contract that can neither receive MON nor make that call cannot recover it. Ordinary wallets and passkey accounts are unaffected. A refund push forwards 50,000 gas; a smart-wallet receive hook that needs more is owed instead of paid, and withdraws the same way.
- **Proofs are bounded** (see the table), and the symbolic engine is a preview feature of forge 1.8.
- **LP seeding depends on external contracts** (Uniswap v3, the GoPlus locker) that are fixed at deployment and tested on a mainnet fork; if seeding stays blocked, `abandonLP` burns the LP's MON share after a grace period and token delivery opens.
- **The vault's strategist is trusted.** It can mark every idle WMON not reserved for a settled or open exit as deployed, which leaves the next exit round without capacity until it unmarks it. Nothing can leave the vault (the strategy is simulated), so this delays exits, it cannot take funds.
- **Anyone can open an exit round** once the previous one settled and `roundGapBlocks` passed. An open round reserves its capacity (the strategist cannot mark it as deployed) until it settles, at least the two 5-minute windows.
- v1 is the live deployment until v2 is deployed; the v2 fixes do not apply to v1 rounds.

## Reproduce

```bash
cd contracts
forge test                                                       # unit, fuzz, invariants
forge test --network monad --hardfork monad:MonadTen             # Monad execution rules
FOUNDRY_PROFILE=deep forge test                                  # 10,000 fuzz runs, 500 × 256 invariants
FOUNDRY_PROFILE=scale forge test --match-contract ScaleMockTest --network monad --hardfork monad:MonadTen -vv
forge test --match-path 'test/fork/*' --fork-url https://rpc2.monad.xyz --network monad --hardfork monad:MonadTen
forge test --symbolic --match-contract '^EngineProofs$' --match-test '^prove_P7_' --symbolic-timeout 300 -j 1   # one proof; see PROPERTIES.md
tools/mutation/run.sh /tmp/even-mutation 8                       # mutation testing (about an hour on 12 cores)
forge lint src --severity high med low info gas code-size
slither . --filter-paths 'lib/|test/|script/|src/vendor/' --exclude-dependencies   # in a copy: crytic-compile runs forge clean
agentguard scan src
```

## Reporting a vulnerability

Please report privately through GitHub's security advisories for this repository (Security → Report a vulnerability), not in a public issue. Include the affected contract and function, a description, and a proof of concept (a Foundry test is ideal).
