# 06 — API

The contract interface of the engine and any HTTP/indexer API.

Status: draft

## HTTP / indexer API

TODO: not found in source. No backend endpoints exist yet. If the indexer exposes an API, document it here as method / path / request / response / status codes.

## Contract interface — implemented (22 Sep)

What exists in code, on `agent/fork` [src: sba-agents/fork/contracts/src/AuctionEngine.sol]. It differs from the proposal below in three places: `price` is really `buyAmount` (tokens wanted), `claim` pays only the MON leg, and there is no `seedLP`. Security status: see [AUDIT.md](AUDIT.md) — `ClearingCore` must not be deployed as-is.

| Function | Caller | Notes |
| --- | --- | --- |
| `openRound(preset, auctioningToken, biddingToken, sellAmount, minBidSize, depositAmount, commitEnd, revealEnd, allowlistRoot, autoLP)` | Anyone | Takes no token custody (AUDIT.md H1); `allowlistRoot` and `autoLP` stored but not enforced |
| `commit(roundId, hash)` payable | Bidder | `msg.value` must equal the round's `depositAmount` |
| `reveal(roundId, price, quantity, salt)` | Bidder | Places `order(buyAmount = price, sellAmount = quantity)` in the core |
| `slashUnrevealed(roundId, bidders[])` | Anyone | After `revealEnd`; sends 100% of each deposit to `slashDestination` |
| `precalculate(roundId, iterationSteps)` | Anyone | Multi-transaction settlement, after `revealEnd` |
| `settle(roundId)` | Anyone | After `revealEnd`; emits `Cleared` |
| `claim(roundId)` | Revealed bidder | Sends the filled MON to `fillDestination`, refunds the rest; records `fillEntitlement` only |

**Pending changes (decided or proposed 22 Sep, not implemented):**
- `reveal(roundId, price, amount, salt)`. `price` = max MON wei per 1e18 token units, a multiple of `tickSize`; `amount` = tokens wanted. Preimage `keccak256(abi.encode(price, amount, salt, msg.sender))`.
- Clearing becomes Zama-style inside the engine (decision 22, decided 22 Sep): winners pay the clearing price P, get their full amount (pro-rata at P) and are refunded the rest.
- `openRound` gains `tickSize`, `reservePrice`, `lpShareBps`, `dexSplits`, and lock terms, and pulls `sellAmount + tokenReserve` tokens from the creator.
- New `seedLP(roundId)` (anyone, after settle) and `withdrawProceeds(roundId)` (creator). `claim` reverts until seeded (decision 27).
- `commit(roundId, hash, bytes32[] proof, bytes note)`: `proof` for allowlisted Raise rounds (empty otherwise); `note` is the encrypted bid backup, emitted and not stored (decisions 32–33).
- `burnUnrevealed(roundId)` replaces `slashUnrevealed(roundId, bidders[])` (decision 30).
- Raise: `claimVested(roundId)` (decision 32).
- Exit-Priority: `openExitRound()`; `reveal` pulls the shares; `claim` redeems winners at the clearing discount and returns the rest (decision 31).
- LP lock calls GoPlus `UniV3LPLocker.lock(INonfungiblePositionManager nftManager_, uint256 nftId_, address owner_, address collector_, uint256 endTime_, string feeName_) payable returns (uint256 lockId)` at `0x24A9eB23De8E6f59BDB981B03E847F0f3ABbFa0d` [src: https://docs.gopluslabs.io/page/goplus-safetoken-locker].

## Contract interface (original proposal, superseded)

The first proposal, kept for the record; the current and pending interfaces are above. The table below is the function surface implied by the PRD phases [src: Monad Sealed-Bid Auction Engine.md] and EasyAuction's public functions [src: https://github.com/Gnosis-Auction/auction-contracts]. Names are proposals until code exists. "Reverts" plays the role of status codes.

### Sealing layer

| Function | Caller | Inputs | Effects | Reverts |
| --- | --- | --- | --- | --- |
| `openRound(params)` | Creator / exit adapter | preset, tokens, sellAmount, minBidSize, depositAmount, commitEnd, revealEnd, allowlistRoot, autoLP | Locks supply, creates Round | missing minBidSize; sellAmount ≥ 2^96; supply not transferred |
| `commit(roundId, hash)` payable | Bidder | `hash = keccak256(price, amount, salt, msg.sender)`; value = depositAmount [src: Monad Sealed-Bid Auction Engine.md] | Stores Commitment, escrows deposit | wrong deposit; window closed; not on allowlist (Raise) |
| `reveal(roundId, price, amount, salt)` | Bidder | preimage | Verifies hash with `msg.sender`, places order in clearing core, marks revealed | hash mismatch; window closed; amount < minBidSize |

### Clearing core (EasyAuction-derived)

| Function | Caller | Inputs | Effects | Reverts |
| --- | --- | --- | --- | --- |
| `precalculateSellAmountSum(roundId, iterationSteps)` | Anyone | iteration budget | Advances the clearing loop across transactions [src: Monad Sealed-Bid Auction Engine.md] | reveal window still open |
| `settleAuction(roundId)` | Anyone | — | Finds the crossing bid, sets clearingPrice, marks Settled, triggers slashing and (Fair Launch) LP seed | already settled |
| `claim(roundId)` | Bidder | — | Pays fill or refund, releases deposit net of fill | not settled; nothing to claim |

### Deposit & slashing

| Function | Caller | Inputs | Effects | Reverts |
| --- | --- | --- | --- | --- |
| `slashUnrevealed(roundId, bidders[])` | Anyone (or inside settle) | list | Moves deposit of non-revealers to the slash destination [src: Monad Sealed-Bid Auction Engine.md] | bidder revealed; before revealEnd |

TODO: slash destination not found in source.

### LP seeder (Fair Launch)

| Function | Caller | Inputs | Effects | Reverts |
| --- | --- | --- | --- | --- |
| `seedLP(roundId)` | Inside settle | — | Creates pool with proceeds + remaining supply, locks LP [src: Monad Sealed-Bid Auction Engine.md] | autoLP false; already seeded |

Note bug #7: the first swap after seeding is sandwichable; mitigation TODO (see [12-open-questions.md](12-open-questions.md)).

### Exit adapter (Exit-Priority)

| Function | Caller | Inputs | Effects | Reverts |
| --- | --- | --- | --- | --- |
| `openExitRound()` | Keeper every N blocks | — | Opens a Vault-preset round with the period's exit capacity [src: Monad Sealed-Bid Auction Engine.md] | previous round not settled |
| `redeemFilled(roundId)` | Exiting holder | — | Redeems from vault at clearing discount | not settled |
| `accrueToStayers(roundId)` | Inside settle | — | Credits discount to remaining holders [src: Monad Sealed-Bid Auction Engine.md] | — |

## Events (proposed)

| Event | Fields |
| --- | --- |
| `RoundOpened` | roundId, preset, sellAmount, commitEnd, revealEnd |
| `Committed` | roundId, bidder, hash |
| `Revealed` | roundId, bidder, price, amount |
| `Cleared` | roundId, clearingPrice, filledVolume |
| `Claimed` | roundId, bidder, filled, refunded |
| `Slashed` | roundId, bidder, amount |
| `LPSeeded` | roundId, pool, tokenAmount, proceedsAmount, lockedUntil |

## Hash preimage encoding

```solidity
bytes32 h = keccak256(abi.encode(price, amount, salt, msg.sender));
```

All four inputs are load-bearing: no salt → brute-forceable; no `msg.sender` → replayable / reveal-front-runnable [src: Monad Sealed-Bid Auction Engine.md]. Confirmed in code: `abi.encode`, in both `SealingLayer.reveal` and the frontend's `commitHash.js` [src: contracts/src/SealingLayer.sol, sba-agents/ui/web/js/commitHash.js].

Related files: [03-architecture.md](03-architecture.md) · [04-flows.md](04-flows.md) · [05-data-model.md](05-data-model.md) · [12-open-questions.md](12-open-questions.md)
