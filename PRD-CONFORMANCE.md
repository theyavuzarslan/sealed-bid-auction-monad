# PRD conformance

Every promise in the PRD (`Monad Sealed-Bid Auction Engine.md`), checked against the contracts and the tests that prove it. Checked 25 Sep 2026: 102 contract tests and 19 Monad-fork tests pass; the fuzz tests pass at 10,000 runs.

Status: settled

Legend: **Meets** = does what the PRD says. **Meets, differently** = reaches the PRD's goal by a mechanism the PRD did not specify, chosen in a numbered decision ([10-decisions.md](10-decisions.md)). **Limit** = a leak or cost the PRD itself names and accepts.

## Goals

| PRD clause | Status | Code | Proof |
| --- | --- | --- | --- |
| Blind bidding: no bidder sees another's price before clearing | Meets, within commit-reveal. During the commit window only the hash is on chain. Revealed bids are public during the reveal window, which is the PRD's own "last reveal" limit (below) | `SealingLayer.commit` stores the hash only; `bids` is written at reveal | `test_PRD_BlindBidding_OnlyTheHashIsOnChainBeforeReveal` |
| Uniform clearing price: everyone who clears pays the same price | Meets | `AuctionEngine.quote`/`_settleAccount`: paid = ⌈allocation × P⌉ | `test_PRD_UniformPrice_EveryWinnerPaysTheClearingPrice` (on real balances), `test_Degen_OversubscribedLifecycle` |
| Snipe resistance: submission timing no longer determines price | Meets. Same bids in any commit or reveal order give the same price, tokens and payment, ties at P included | `UniformClearing`: price levels, pro-rata at P, no order field | `test_PRD_SnipeResistance_OrderAndTimingDoNotMatter`, `testFuzz_PRD_SnipeResistance_AnyRevealOrder` (10,000 runs), `testFuzz_MatchesReference` |
| One-click flow: auction → distribution → pool with locked LP, atomically | Meets, differently (decision 27). Seeding is its own public call right after settlement, not the same transaction; no auctioned token can leave the engine before it, so bidders see one pipeline. If seeding is blocked, `abandonLP` after the grace period burns the LP's MON share and opens claims | `seedLP`, `abandonLP`, `claimTokens` requires `claimsOpen` | `test_PRD_Bug7_PoolFirst_AtTheClearingPrice_Locked`, `test_H1_BlockedPool_AbandonBurns_NoUncheckedSeed` |
| Cheap: bidder journey under $0.01 | Meets. Worst complete journey $0.0014 at Monad mainnet gas price, 24 Sep | — | `indexer/fee-report.mjs` over `script/FeeProbe.s.sol`; table in [SUBMISSION.md](SUBMISSION.md#measured-cost) |
| One engine: both use cases run the same clearing core | Meets (decision 34). `AuctionEngine` and `ExitAuction` both inherit `SealingLayer` and `UniformClearing` | `contracts/src/exit/ExitAuction.sol:32` | Both suites run on the shared modules |

## Mechanism

| PRD clause | Status | Code | Proof |
| --- | --- | --- | --- |
| Commit = `keccak256(price, quantity, salt, msg.sender)` | Meets (`quantity` is called `amount`) | `SealingLayer._reveal` | `test_PRD_Bug1_SaltIsPartOfTheCommitment`, `test_PRD_Bug2_CopiedCommitmentCannotBeReplayed`, `test_PRD_Bug2_RevealCannotBeFrontRun`; the web app checks its hash against a `cast` vector on every load |
| Uniform deposit, the same for every bidder and larger than the bid | Meets. Exact `msg.value`; a bid whose maximum spend reaches the deposit cannot be revealed | `SealingLayer.commit`, `AuctionEngine._onReveal` | `test_PRD_UniformDeposit_SameForEveryBid_AndLargerThanTheBid` |
| Non-revealers are slashed | Meets (decision 30): their deposits are burned to `0x…dEaD`, so nobody profits from them | `DepositLedger.burnUnrevealed` | `test_PRD_Bug3_NonRevealerLosesExactlyTheDeposit`, `test_BurnUnrevealed` |
| Clear: rank by price, accumulate to the sell amount, the crossing bid sets one price; at or above clear, the rest refunded | Meets | `UniformClearing._settleStep` | `test_Example_*`, `testFuzz_MatchesReference` |
| "Partial fill at the marginal bid" (EasyAuction) | Meets, differently (decision 22). All bids at the clearing price share what is left pro-rata, instead of one marginal bid taking a partial fill; this removes EasyAuction's reveal-order tie advantage | `UniformClearing._allocation` | `testFuzz_EqualBidsAtClearingPriceGetEqualShares`, `test_Example_OversubscribedTieIsProRata` |
| Undersubscribed round | Meets, differently (decision 22): every bid fills and the price is the lowest revealed bid, which is never below the reserve | `UniformClearing` | `test_Example_Undersubscribed_AllFill_PriceIsLowestBid`, `test_Degen_Undersubscribed_UnsoldBurned` |
| Configurable minimum bid size, required | Meets. Required at open, measured at the reserve price so every price level is worth at least the minimum | `AuctionEngine._validate`, `_onReveal` | `test_RevealRules`, `test_L3_CheapHighPriceLevelsRejected`, `test_L2_ImpossibleParametersRejected` |
| Multi-transaction settlement | Meets | `settle(roundId, maxSteps)` | `test_SettleInSteps_SameResult` |
| Volume under 2^96, prices as uint96 | Meets, and wider than required: each bid is uint96, sums are uint128/uint256, so the EasyAuction limit no longer applies | `UniformClearing` | Solidity 0.8 checked arithmetic |
| Clearing math forked from EasyAuction | Meets, differently (decision 22). Rewritten Zama-style after the first audit; no EasyAuction code remains | `UniformClearing.sol` | [AUDIT.md](AUDIT.md) |

## Use case 1: fair launch

| PRD clause | Status | Code | Proof |
| --- | --- | --- | --- |
| Proceeds plus remaining supply auto-seed a DEX pool with locked LP | Meets, differently (decisions 25, 26, 29). The creator sets `lpShareBps`: that share of MON raised plus the same share of tokens sold (from a reserve the creator locks at open) seeds the pool at exactly the clearing price, split across DEXs the creator picks. Unsold supply is burned (Degen) or returned (Raise), not added to the pool, because it would open the pool below the clearing price | `_lpTargets`, `_seed`, `_seedOne`, `disposeUnsold` | `test_LP_PartialUse_DustToCreatorAndUnsoldBurned`, 19 fork tests on real Uniswap v3 + GoPlus |
| Locked LP | Meets. GoPlus `UniV3LPLocker`: permanent for Degen (engine is the owner), creator-chosen and at least 30 days for Raise; the creator collects fees | `_seedOne` | `test_PRD_Bug7_PoolFirst_AtTheClearingPrice_Locked`, `test_Fork_Locker_TakesApprovedNFT_AnyFutureEndTime`, `test_RaiseLockTooShortRejected` |
| Preset Degen: short window, no allowlist, no vesting, auto-LP | Meets. Allowlist, vesting and a timed lock are rejected; LP is required. Window length is the creator's choice; the Host page defaults to 10-minute windows for Degen and one day for Raise | `_validate` | `test_OpenRules` |
| Preset Raise: long window, allowlist, vesting, optional LP | Meets | `_validate`, `claimVested` | `test_Raise_Allowlist`, `test_Raise_UnsoldReturnedAndVesting` |
| Creator can make the token on the spot (not in the PRD; closes the one-click gap with nad.fun) | Added 25 Sep | `src/launch/TokenFactory.sol`: fixed supply minted once to the caller; the caller, not the factory, opens the round | `TokenFactoryTest` (4), `web/e2e.mjs` factory launch |
| No insider price | Meets. The creator bids like anyone and pays the same price; nothing in the engine lets anyone buy outside the auction | — | `test_PRD_UniformPrice_EveryWinnerPaysTheClearingPrice` |

## Use case 2: vault exit priority

| PRD clause | Status | Code | Proof |
| --- | --- | --- | --- |
| Every N blocks, holders bid the discount they accept | Meets. Anyone opens the next round `roundGapBlocks` after the last settles | `ExitAuction.openExitRound` | `test_Open_RevertsWhileRoundUnsettled_AndBeforeNBlocks` |
| All clearing exits pay the same discount | Meets | `ExitAuction` on `UniformClearing` | `test_Oversubscribed_ProRataAtClearingDiscount`, `test_Undersubscribed_AllExit_AtLowestDiscount` |
| The discount recapitalizes the holders who stay | Meets | Discount is donated to the vault | `test_StayersGainEveryRound`, `testFuzz_Conservation` |
| Preset Vault: allowlist configurable | Meets, added 25 Sep: an optional Merkle root fixed at deployment; zero lets every holder bid | `ExitAuction.Config.allowlistRoot` | `test_Allowlist_OnlyListedHoldersBid` |
| No LP | Meets | — | — |

## The eight bugs

| # | PRD bug | Guard | Proof |
| --- | --- | --- | --- |
| 1 | Commit without a salt | Salt is in the preimage; the web app draws it from a CSPRNG | `test_PRD_Bug1_SaltIsPartOfTheCommitment` |
| 2 | Commit not bound to `msg.sender` | Sender is in the preimage | `test_PRD_Bug2_CopiedCommitmentCannotBeReplayed`, `test_PRD_Bug2_RevealCannotBeFrontRun` |
| 3 | Slashing accounting on non-reveal | O(1) burn of `(commits − reveals) × deposit`, per-round balance | `test_PRD_Bug3_NonRevealerLosesExactlyTheDeposit`, `testFuzz_LifecycleConservesEverything`, `testFuzz_Interleavings` |
| 4 | Off-by-one at the marginal bid | Pro-rata rounds down, the sold amount has a lower bound, dust is swept | `testFuzz_MatchesReference`, `testFuzz_RevealWithHint_AnyHintSameBook` (any reveal hint builds the same book), `testFuzz_EqualBidsAtClearingPriceGetEqualShares`, `test_Example_ExactlyCovered_NoProRata` |
| 5 | Reentrancy on refund and claim | One lock across every state-changing call | `test_Security_ReentrantClaimBlocked`, `test_Claim_ReentrancyBlocked` |
| 6 | Gas DoS via dust commits | Commits never touch the book; only revealed bids worth at least the minimum add levels; settlement resumes across transactions | `test_RevealRules`, `test_L3_CheapHighPriceLevelsRejected`, `test_SettleInSteps_SameResult` |
| 7 | Sandwichable LP seed | Pool seeded at the clearing price before any token leaves; strict adapter reprices a pre-made pool or refuses | `test_PRD_Bug7_PoolFirst_AtTheClearingPrice_Locked`, `test_Fork_Grief_*` (9 fork tests) |
| 8 | `price × amount` precision favoring the bidder | Payments round up, allocations round down | `testFuzz_PRD_Bug8_RoundingNeverFavorsTheBidder` (10,000 runs), `testFuzz_LifecycleConservesEverything` |

## Limits the PRD accepts

| PRD clause | How the build stands |
| --- | --- |
| Commitment count and timing leak | Public by design; the web app shows them |
| The uniform deposit caps bid size | Enforced: maximum spend must be below the deposit |
| Prices are in ticks | Per-round tick grid, public |
| Last reveal is an attack position | Real. A late revealer sees earlier reveals and may decline, at the cost of the whole deposit. Not revealing cannot change a committed bid. The same holds for a bidder who commits from several addresses and reveals only some: each unrevealed commit burns one deposit |
| No encrypted mempool | None used; privacy via commit-reveal ([SUBMISSION.md](SUBMISSION.md#honest-limits)) |

## Found and fixed during this check

- **Vault allowlist missing.** The PRD lists it as configurable; `ExitAuction` had none. Added as an optional deployment setting with a test. While adding it, the new test caught a shadowing mistake of mine (a return variable named like the new setting, which made the root read as zero); fixed before commit.
- **Preset windows.** The Host page defaulted every preset to 60-minute windows; it now follows the PRD's preset table (Degen 10 minutes, Raise one day) unless the creator has typed their own.
- **Test count overstated.** `AuditRegressions` inherited the engine suite, so 21 engine tests ran twice and the published count (105) was 21 too high. The shared setup now lives in `EngineBase`; each test runs once, and every published count says 96 plus 19 fork tests (102 after the token factory and hint tests were added the same day).

Related files: [SUBMISSION.md](SUBMISSION.md) · [10-decisions.md](10-decisions.md) · [AUDIT.md](AUDIT.md) · [12-open-questions.md](12-open-questions.md) · `contracts/test/PrdConformance.t.sol`
