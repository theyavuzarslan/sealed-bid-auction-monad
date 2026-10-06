# Static analysis — Slither and Aderyn on `contracts/src`

Run on 6 Oct 2026 against `master` at `b8e2835` (no changes to `src/`). Scope: everything under `contracts/src` except `src/vendor/` (OpenZeppelin). `lib/` (forge-std), `test/` and `script/` are excluded.

| Tool | Version | Detectors | Findings | Raw report |
| --- | --- | --- | --- | --- |
| Slither | 0.11.6 (solc 0.8.28 via `forge build`) | 102 | 63 (2 High-impact checks, 4 Medium, 3 Low, 1 Informational) | `reports/slither.txt`, `reports/slither-checklist.md`, `reports/slither-summary.json` |
| Aderyn | 0.6.8 | 88 | 4 High, 11 Low (issue types) | `reports/aderyn.md` |

The full Slither JSON (2 MB) is not kept; `slither-summary.json` keeps every finding's check, impact, confidence, location and description.

## For the main session: what needs a decision

**No true positive on the launch engine's money path.** Every High and Medium from both tools is a false positive or an accepted design choice (triage below). Two items deserve a decision; neither came out as a tool "High".

1. **O1 — a bidder that cannot receive MON can never be settled (manual, found while triaging Slither's reentrancy/`sendValue` output). Low.** Refunds are pushed (`SafeTransferLib.sendValue`) on every path: `claim`, `claimRefund` and `claimTokens` all call `_refund` first. A contract bidder whose `receive` reverts therefore stays unsettled forever. Its own deposit and tokens are stuck (its loss), but so are (a) the creator's share of its payment, since `collected` only grows on refund, and (b) `sweepDust`, which waits for `claims == reveals`; dust tokens stay in the engine. Other bidders and other rounds are unaffected, and MON accounting stays exact (the deposit sits in `roundBalance`). Cost to the griefer is its whole deposit. PoC that pins the current behaviour: `test/Observations.t.sol::test_O1_MonRejectingWinner_BlocksItsPaymentAndDustSweep`. Possible fixes, if wanted: on a failed send, credit a pull balance (`withdrawRefund`) instead of reverting, or let `sweepDust`/`collected` stop waiting for a bidder after a deadline. `ExitAuction` also pushes its MON refunds, but there the exit and the refund are claimed independently, so only the bidder's own deposit is affected.
2. **`ExitAuction._exit` requires `vault.redeem(...) == previewRedeem(...)` (Slither `incorrect-equality`, `src/exit/ExitAuction.sol#242`). Accepted today, a liveness bug if generalised.** ERC-4626 lets `redeem` return *more* than `previewRedeem` in the same transaction. The constructor takes the project's own `DemoVault` (OpenZeppelin ERC-4626, where the two are equal), so it holds today. If the exit auction is ever pointed at another vault, use `got >= assets` and decide where the surplus goes. Use case 2 only.

## Slither triage (63)

TP = true positive, FP = false positive, Acc = accepted (real pattern, intended).

| # | Check | Impact | Location | Verdict | Why |
| --- | --- | --- | --- | --- | --- |
| 0 | incorrect-exp | High | `adapters/UniV3PriceMath.sol#45` | FP | `inv = (3 * d) ^ 2` is the Newton seed of Remco Bloemen's mulDiv (identical to Uniswap FullMath); XOR is intended. Fuzzed in `UniswapV3Adapter.t.sol`. |
| 1 | reentrancy-balance | High | `AuctionEngine.openRound` #194–196 | FP | The balance delta *is* the fee-on-transfer check. All state-changing engine functions share one `nonReentrant` lock, so a token callback cannot re-enter. A token lying in `balanceOf` only affects its own round, whose token outflow is capped by `_tokensOut`. |
| 2, 3, 5 | reentrancy-balance | High | `AuctionEngine._seedOne` #367–374 | FP | Adapters are fixed at deployment; `seedLP` holds the lock; `receive()` accepts MON only from an adapter while `_seeding`. `tokUsed`/`monUsed` are measured deltas meant to catch an overspending adapter. A creator token misreporting balances can only raise its own `unsoldOwed`, still capped by `_tokensOut`. |
| 4 | reentrancy-balance | High | `UniswapV3Adapter.seed` #149–152 | FP | Same fee-on-transfer check; the adapter is `nonReentrant`. |
| 6–8, 10, 11, 13–15 | divide-before-multiply | Medium | `UniV3PriceMath.mulDiv` | FP | Part of the 512-bit mulDiv algorithm (division by the power of two `twos`, then the modular inverse). |
| 9 | divide-before-multiply | Medium | `UniswapV3Adapter._mintFullRange` #219 | FP | `(MAX_TICK / spacing) * spacing` rounds the full-range tick to the spacing on purpose. |
| 12 | divide-before-multiply | Medium | `AuctionEngine._lpTargets` #332 | Acc | `lpMon = floor(soldLB·P/1e18)·bps/BPS` rounds the LP's MON down by at most a few wei. It never overspends: `_seed` debits it from `roundBalance` with a checked subtraction. |
| 16 | incorrect-equality | Medium | `ExitAuction._exit` #242 | Acc | `got == assets` holds for `DemoVault`; see item 2 above. |
| 17 | incorrect-equality | Medium | `UniformClearing.findHint` #164 | FP | `hint == NONE` compares against the end-of-list sentinel. |
| 18, 19 | incorrect-equality | Medium | `UniswapV3Adapter.seed` #152, `AuctionEngine.openRound` #196 | FP | Exact balance delta is the intended fee-on-transfer rejection. |
| 20 | incorrect-equality | Medium | `ExitAuction._exit` #237 | FP | `exitsClaimed == reveals` compares two counters. |
| 21 | uninitialized-local | Medium | `UniswapV3Adapter._preparePool` `current` | FP | Zero means "no pool or uninitialised", handled on the next line. |
| 22–24 | uninitialized-local | Medium | `AuctionEngine._seed` `tokensUsed`, `monUsed`; `_validate` `sum` | FP | Accumulators that start at zero. |
| 25, 27 | unused-return | Medium | `UniswapV3Adapter._preparePool` `slot0()` | Acc | Only `sqrtPriceX96` is needed. |
| 26 | unused-return | Medium | `UniswapV3Adapter._preparePool` `swap` | Acc | The repricing swap's amounts do not matter: the price is re-read and checked against the tolerance, and the callback caps the input at 1 wei. |
| 28 | unused-return | Medium | `UniswapV3Adapter._mintFullRange` `mint` | Acc | The engine measures what was used by balance deltas and checks NFT ownership; the adapter refunds by balance. |
| 29–36 | calls-loop | Low | `AuctionEngine._seedOne` (via `_seed`), `_validate` | Acc | Loops are bounded by `MAX_SPLITS = 4` over allow-listed adapters. A revert blocks only that round's `seedLP`, which has the `abandonLP` escape after `lpGracePeriod`. |
| 37, 38 | reentrancy-benign | Low | `UniswapV3Adapter._preparePool`, `seed` | FP | The write after the call resets the `_repricingPool` callback guard, under `nonReentrant`. |
| 39–61 | timestamp | Low | 23 functions (windows, vesting, grace period) | Acc | Windows are hours long and vesting runs for days, so timestamp drift of a few seconds cannot change an outcome. Time-based windows are the design. |
| 62 | assembly | Info | `UniV3PriceMath.mulDiv` | Acc | 512-bit multiply needs `mulmod`; fuzzed. |

## Aderyn triage (4 High, 11 Low issue types)

| ID | Issue | Instances | Verdict | Why |
| --- | --- | --- | --- | --- |
| H-1 | ETH transferred without address checks | `abandonLP`, `burnUnrevealed`, `ExitAuction.claim`, `claimRefund` | FP | Recipients are the constant `0x…dEaD` or the bidder whose own commitment is being settled. Anyone may trigger, funds never go to the caller (AUDIT.md second review, L1). |
| H-2 | Incorrect use of caret operator | `UniV3PriceMath.sol#45` | FP | Same as Slither #0. |
| H-3 | State change after external call | `DemoVault#55`, `ExitAuction#108, 129, 130, 132, 185` | FP | Constructor/setup or view calls to the configured vault (`asset`, `idleAssets`, `previewMint`, `convertToShares`, `convertToAssets`); `openExitRound` and `settle` are `nonReentrant`. |
| H-4 | Unsafe casting | `DepositLedger#67` `uint128(refund)` | FP | `refund < deposit ≤ type(uint96).max`; same for `paid`. |
| L-1 | Costly operations inside loop | `AuctionEngine#188`, `UniformClearing#107` | Acc / FP | Split push is bounded by 4. The settle loop keeps its state in locals and writes storage only on the iteration that finishes. |
| L-2 | Large numeric literal | 7 | Acc | Style. |
| L-3 | Literal instead of constant | 26 | Acc | Style. |
| L-4 | Local variable shadows state variable | `ExitAuction` config struct fields | FP | Struct members named like the state variables they configure. |
| L-5 | Modifier invoked only once | `UniswapV3Adapter.nonReentrant` | Acc | Style. |
| L-6 | PUSH0 opcode | 12 | Acc | Monad supports Shanghai opcodes; the engine is live on mainnet. |
| L-7 | Loop contains `require` | 2 | Acc | Bounded loops where a revert is the intended outcome. |
| L-8 | Uninitialized local variable | loop counters | FP | `for (uint256 i; ...)`. |
| L-9 | Unsafe ERC20 operation | `AuctionEngine#378` | FP | ERC-721 `approve` of the position NFT to the locker, right after ownership is checked. |
| L-10 | Unspecific pragma | 9 files | Acc | `^0.8.24`; builds are pinned to 0.8.28 by `foundry.toml`. |
| L-11 | Unused state variable | `UniswapV3Adapter.REPRICE_GAS` | FP | Used as `{gas: REPRICE_GAS}` in `_preparePool`. |

## Reproduce

```bash
# Slither (in a venv; Homebrew Python refuses `pip install --user`, PEP 668)
python3 -m venv /tmp/slither-venv && /tmp/slither-venv/bin/pip install slither-analyzer
cd contracts
PATH=$HOME/.foundry/bin:/tmp/slither-venv/bin:$PATH slither . \
  --filter-paths 'lib/|test/|script/|src/vendor/' --exclude-dependencies --checklist
# Note: crytic-compile runs `forge clean` first.

# Aderyn
npm i -g @cyfrin/aderyn
cd contracts && aderyn . -s src -x src/vendor -o reports/aderyn.md
```
