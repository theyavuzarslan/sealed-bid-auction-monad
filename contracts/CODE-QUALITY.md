# Code quality — review of `contracts/src`

Reviewed on 9 Oct 2026 against `master` at `cd23e6a`. Scope: everything under `contracts/src` except `src/vendor/` (OpenZeppelin v5.1.0, kept as upstream released it). The contracts are live on Monad mainnet, so this pass has one hard rule: **behaviour stays byte-for-byte identical**. Every applied change is a comment, a rename of a non-ABI identifier, a named constant, or a move, and each one was checked against the compiler output (see [Verification](#verification)).

Changes that would alter bytecode, revert data, events or the ABI are listed as [proposals](#proposed-not-applied) only. They need a redeploy, which is the owner's decision.

## Standards used

| Source | What it contributes | Weight |
| --- | --- | --- |
| [Solidity style guide (0.8.28)](https://docs.soliditylang.org/en/v0.8.28/style-guide.html) | Layout order (types, state, events, errors, modifiers, functions); function order (constructor, receive, fallback, external, public, internal, private; views last within a group); `_` prefix for non-external members; 120-column lines. | Normative: the language's own guide. |
| [NatSpec format](https://docs.soliditylang.org/en/v0.8.28/natspec-format.html) | Tags and where they apply; "fully annotate all public interfaces"; one `@return` per value; `@inheritdoc`. | Normative. |
| [OpenZeppelin `GUIDELINES.md`](https://github.com/OpenZeppelin/openzeppelin-contracts/blob/master/GUIDELINES.md) | Events right after the state change they record; every `unchecked` block says why it cannot overflow; refactors do not change tests in the same change; custom errors named after the component. | De facto industry baseline. |
| [Trail of Bits, building-secure-contracts: development guidelines](https://secure-contracts.com/development-guidelines/guidelines.html) | Small functions with one purpose; shallow inheritance; events for every critical operation; NatSpec plus plain-English specs; avoid inline assembly unless needed. | Reputable security firm; security-oriented. |
| [Cyfrin `solskill`](https://github.com/Cyfrin/solskill) (listed on [ethereum.org](https://ethereum.org/developers/tools/cyfrin-solskill/)) | Custom errors `Contract__Error`; absolute named imports; strict pragmas for deployables, minimum **0.8.34** because 0.8.28–0.8.33 carry a transient-storage bug; `@custom:security-contact`; branching-tree tests and invariants. | Reputable auditor; opinionated. Used for the security items, not every stylistic rule. |
| [Solidity: transient storage clearing helper collision bug](https://soliditylang.org/blog/2026/02/18/transient-storage-clearing-helper-collision-bug/) | Exact trigger conditions of the 0.8.28–0.8.33 via-IR bug (see F10). | Normative (compiler team advisory). |
| `forge fmt` / `forge lint` (Foundry 1.8.3) | Formatting and lint rules enforced mechanically. | Tooling. |

**Monad.** The Monad docs give no coding standard. [Solidity resources](https://docs.monad.xyz/guides/evm-resources/solidity-resources) links general material (Solidity docs, Cyfrin Updraft, OpenZeppelin, Solady, Slither, Echidna); [Best practices](https://docs.monad.xyz/developer-essentials/best-practices) is about the RPC and frontend side (hardcode known gas limits, batch reads, track nonces, use an indexer). The Monad-specific facts that matter for contract code are in [Opcode pricing](https://docs.monad.xyz/developer-essentials/opcode-pricing), [Differences from Ethereum](https://docs.monad.xyz/developer-essentials/differences), [Gas pricing](https://docs.monad.xyz/developer-essentials/gas-pricing) and the [MIP-8 spec](https://mips.monad.xyz/MIPs/MIP-8) (Category Labs, Final): gas is billed on the gas **limit**; cold account access 10,100; storage is priced per 128-slot page (first touch 8,100, then 100; a new slot adds 17,000 state growth plus 2,800 per written page); no SSTORE refunds; memory is linear and capped at 8 MB; MIP-8 asks developers to avoid hardcoded gas assumptions around storage. No official Monad Foundation or Category Labs agent skill for writing contracts was found. Community skills exist ([monskills](https://github.com/therealharpaljadeja/monskills), "monad-wingman"); they are unofficial, cover scaffolding and deployment, and contain no contract-quality guidance, so they were not used.

## Verification

Every commit on this branch was checked the same way:

1. **Bytecode, ABI and storage layout.** Built with `FOUNDRY_CBOR_METADATA=false FOUNDRY_BYTECODE_HASH=none` (metadata off, everything else as in `foundry.toml`: solc 0.8.28, via-IR, 200 runs) and compared with the same build of `master` for `AuctionEngine`, `UniswapV3Adapter`, `TokenFactory`, `LaunchToken`, `ExitAuction` and `DemoVault`: creation bytecode, runtime bytecode, ABI and storage layout (labels, slots, offsets, types). **All 24 artefacts are identical after every commit.** Two clean builds of `master` were first confirmed identical, so the comparison is meaningful. The built `AuctionEngine` ABI also matches `contracts/abi/AuctionEngine.json`, which the frontend copies.
2. `forge fmt --check`: passes (it did not on `master`).
3. `forge lint`: exit 0; warnings 184 → 73 (vendor excluded, provably safe casts annotated). The remaining 60 in `src` are the classes already triaged as false positives or accepted in `STATIC-ANALYSIS.md` (timestamps, bounded loops, reentrancy-ordering under `nonReentrant`, intended strict equalities).
4. `forge test` and `forge test --network monad --hardfork monad:MonadTen`: **104 passed, 0 failed, 3 skipped** in both (same as `master`; the skipped suites are the two scale suites, which run only under `FOUNDRY_PROFILE=scale`, and the fork suite, which needs `--fork-url`). The invariant suite and `PrdConformance.t.sol` are unchanged.
5. Fork suite on Monad mainnet under Monad rules, `forge test --match-path 'test/fork/*' --fork-url https://rpc.monad.xyz --network monad --hardfork monad:MonadTen`: **19 passed**.

NatSpec coverage after the pass (ABI functions and events with a `@notice`/`@dev`): AuctionEngine 53/53, UniswapV3Adapter 10/10, TokenFactory 8/8, ExitAuction 42/42, DemoVault 40/42 (the two gaps are the inherited OpenZeppelin `Deposit`/`Withdraw` events).

## Findings

Status: **Fixed** on this branch (behaviour identical), **Accepted** (checked, no change needed), **Proposed** (needs a redeploy or a test/frontend change; not applied).

### Fixed

| # | Area | Finding | Change |
| --- | --- | --- | --- |
| F1 | Tooling | `forge fmt --check` failed on 16 files, 5 of them vendored OpenZeppelin. | `[fmt]` and `[lint]` now ignore `src/vendor/**`; everything else formatted (whitespace only). |
| F2 | NatSpec | Many external/public functions had no NatSpec (`reveal`, `openRound`, `getRound`, `splitsOf`, `vestedOf`, `creatorAvailable`, `clearingOf`, `findHint` returns, `TokenFactory.create`/`tokenCount`, `DemoVault` strategist and limit functions, `ExitAuction` claims and views, `IDexAdapter.seed`, `IUniV3LPLocker.lock`), and almost no public state variable or event was documented. | `@notice`/`@param`/`@return` on every external/public function, public state variable, constant and event of the non-vendored code; one `@return` per value on multi-return functions. |
| F3 | Storage structs | Fields of `Book`, `Level`, `Ledger`, `Account`, `Round` had no stated meaning or units (e.g. `Book.settling` vs `settled`, `Round.collected`, `tokensOut`). | Inline field comments. |
| F4 | Casts | 15 narrowing casts in `src` without a stated bound (`forge lint unsafe-typecast`). Each was checked: `tokenReserve ≤ sellAmount` (lpShareBps ≤ BPS validated first), `paid/refund < deposit ≤ uint96`, `release ≤ alloc ≤ uint96`, `vested ≤ total`, `capacity ≤ maxExitSharesPerRound`, timestamps and block numbers in 64 bits, `root < MAX_SQRT_RATIO < 2^160`, positive `int256` deltas. | A "casting is safe because…" comment and `forge-lint: disable-next-line(unsafe-typecast)` at each. |
| F5 | `unchecked` | `UniV3PriceMath.mulDiv` and `sqrt` had no justification (OpenZeppelin guideline). | One comment each on why overflow cannot occur or is intended. |
| F6 | Magic numbers | Raw ERC-20 selectors in `SafeTransferLib`; the literal `10_000` in the adapter constructor and `withinTolerance`. | Named constants `TRANSFER`, `TRANSFER_FROM`, `APPROVE`; `UniV3PriceMath.BPS`. |
| F7 | Interfaces | `UniswapV3Adapter` declared `IERC20Balance`, a copy of `ILiquidity.IERC20Minimal`. | Uses the shared interface. |
| F8 | Ordering | `receive`/`onERC721Received` sat at the bottom of `AuctionEngine`; the adapter's modifier came after its constructor and its external functions were interleaved with private helpers; `UniformClearing`'s external views were last; `SealingLayer` had a private function before internal ones. | Moved to style-guide order. `AuctionEngine` and `ExitAuction` keep their lifecycle sections (open → reveal → settle → LP → claim → views) on purpose: the guide's order is a recommendation, and the lifecycle order matches `04-flows.md` and is how auditors read the money path. |
| F9 | Hidden coupling | `SealingLayer.NO_HINT` and `UniformClearing.NONE` are the same sentinel flowing from one base contract to the other, equal only by convention. | Documented at both declarations. (Safe even if they diverged: an invalid hint falls back to walking from the head.) |
| F10 | Compiler bug exposure | `UniswapV3Adapter` uses `transient` state and is compiled with solc 0.8.28 via-IR, inside the range of the [transient-storage clearing-helper bug](https://soliditylang.org/blog/2026/02/18/transient-storage-clearing-helper-collision-bug/). The trigger is `delete` on a transient variable. **Checked: there is no `delete` anywhere in `src`**; the adapter resets `_entered` and `_repricingPool` by assigning zero, which the advisory states is unaffected. Not exploitable. | Comment in the adapter forbidding `delete` on its transient state while it compiles below 0.8.34. |
| F11 | Readability | `AuctionEngine.claim`'s `else require(!refunded, …)` branch encodes three cases implicitly; `DemoVault.maxWithdraw/maxRedeem`'s `owner == address(0)` clause only matters before wiring. | Comments spelling out the cases. |
| F12 | Lint noise | 96 of 184 lint warnings came from vendored OpenZeppelin. | Excluded via `[lint] ignore`. |

### Accepted (checked, no change)

| # | Finding | Why no change |
| --- | --- | --- |
| A1 | `REPRICE_GAS = 8_000_000` is a hardcoded gas figure, the kind MIP-8 warns about. | Re-measured today on a mainnet fork **under MonadTen rules**: repricing an empty fee-500 pool from `MIN_SQRT_RATIO` takes 5,100,056 gas for the whole seed, the same as the figure in the comment; the cap still has ~36% headroom. Tick-bitmap words are separate mapping keys (separate pages), so MIP-8 does not change this walk materially. Re-measure if Monad reprices storage again. |
| A2 | `forge lint` `reentrancy-events`/`reentrancy-no-eth` (8 + 4 sites): events emitted after external calls, e.g. `LPSeeded` after `locker.lock`, `ClaimsOpened` after `_seed`. | Every state-changing engine and exit function holds the shared `nonReentrant` lock, and several events carry values only the call returns (`nftId`, `lockId`). Moving emits would also change log order, which is observable. |
| A3 | `block-timestamp`, `calls-loop`, `require-revert-in-loop`, `divide-before-multiply`, `incorrect-strict-equality`, `arbitrary-send-eth`, `missing-zero-check` | Same verdicts as `STATIC-ANALYSIS.md` (windows are hours long; loops bounded by `MAX_SPLITS`; recipients are the bidder or `0x…dEaD`; zero checks are implied by `code.length != 0`). |
| A4 | Relative imports (Cyfrin prefers absolute `src/...` imports). | Purely cosmetic, and the vendored tree uses relative imports internally. |

### Proposed (not applied)

| # | Proposal | Effect | Redeploy? |
| --- | --- | --- | --- |
| P1 | **Custom errors** (`AuctionEngine__NotSettled()` etc., or `require(cond, Err())` on ≥ 0.8.26) instead of the ~130 string `require`s. Smaller bytecode, cheaper reverts, typed decoding. | Changes every revert's return data: ~120 `vm.expectRevert` sites in tests and `web/js/abicoder.js decodeRevert` / `engine.js` error mapping must change with it. | Yes |
| P2 | **Distinct revert reasons** where one string covers two conditions: `"not the pool"` (callback: no repricing in flight vs wrong pool), `"pool price deviates"` (tolerance check vs callback asked for more than 1 wei). Faster triage from a failed transaction. | Revert data change. | Yes (adapter) |
| P3 | **Pin the compiler** to an exact `pragma solidity 0.8.34;` for deployable contracts (floating `^` for libraries, interfaces, abstracts), and unify today's mix of `^0.8.24` and `^0.8.28`. Removes the F10 bug class instead of guarding against it. | New bytecode. | Yes |
| P4 | **One function for a bidder's outcome.** `_refund`, `_deliver` and `quote` each recompute `alloc` from the stored bid (and two of them `paid`). An internal `_outcome(roundId, bidder) returns (alloc, paid)` would make the three agree by construction. | Money path: by the PRD's code-review boundary it must be hand-written and reviewed line by line, so it is not done here. | Yes |
| P5 | **Events.** `ProceedsWithdrawn` lacks the (indexed) creator; `sweepDust` with zero dust sets `dustSwept` without any event. | ABI/topic change; indexer update. | Yes |
| P6 | **Shared constants.** `BPS` is declared in `AuctionEngine`, `ExitAuction` and `UniV3PriceMath`; `PRICE_SCALE` in the engine and the math library. A file-level `Constants.sol` would keep them in one place (the `public` getters stay). | No bytecode change expected, but touches three money-path files. | No |
| P7 | **`@custom:security-contact`** on each deployable contract (Cyfrin). | Comment only; needs a contact address chosen by the owner. | No |
| P8 | **Interfaces out of the adapter file.** `IUniswapV3FactoryLike`, `IUniswapV3PoolLike`, `INonfungiblePositionManagerLike`, `IWMON` → `src/interfaces/IUniswapV3.sol`. | The fork test imports `IWMON` from the adapter file; one import line changes. | No |
| P9 | **Test structure.** `test_CommitRules`, `test_RevealRules`, `test_OpenRules` each assert many unrelated reverts; splitting them into `test_RevertWhen_…` cases (Cyfrin branching-tree style) would name each rule in the failure output. Per OpenZeppelin's guideline, do it in its own change, not with a code refactor. | Tests only. | No |
| P10 | Already open in `STATIC-ANALYSIS.md`: **O1** (a bidder contract that rejects MON can never be settled, which also stalls `sweepDust`) and `ExitAuction`'s `redeem == previewRedeem` strict equality. Listed here so the redeploy backlog is in one place. | Behaviour change. | Yes |

## What a redeploy means for this branch

- **Merging this branch does not require a redeploy.** Every commit leaves runtime and creation bytecode identical with metadata stripped, and leaves the ABI and storage layout unchanged.
- **But the source text changed, so the metadata hash changed.** Production builds embed CBOR metadata (`bytecode_hash = ipfs` by default), which hashes the source including comments. A build of this branch therefore differs from the live contracts in the trailing metadata bytes, and the branch's sources will not exact-match the on-chain contracts for explorer or Sourcify verification. Before merging, tag the commit the live deployment was built from (the `contracts/deployments/143*.json` commit, `21b4fa3` or the exact build commit) so that verification can always be reproduced from the tag.
- **Everything marked "Redeploy: yes" above** (P1–P5, P10) changes bytecode, revert data or events. With the submission on 13 Oct and the engine already live, the recommendation is to batch them into one post-hackathon release together with P3 (solc 0.8.34), re-run Slither/Aderyn and the fork suite under MonadTen, and redeploy once.

## Commits on this branch

1. `contracts: forge fmt clean; vendored OpenZeppelin excluded from fmt and lint`
2. `contracts: complete NatSpec, document invariants and provably safe casts`
3. `contracts: name magic numbers, drop a duplicate interface`
4. `contracts: member order closer to the Solidity style guide`
5. `contracts: reattach two NatSpec blocks displaced by the reorder`
6. `contracts: CODE-QUALITY.md` (this file)
