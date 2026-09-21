# 06 — API

The contract interface of the engine and any HTTP/indexer API.

Status: draft

## HTTP / indexer API

TODO: not found in source. No backend endpoints exist yet. If the indexer exposes an API, document it here as method / path / request / response / status codes.

## Contract interface (proposed)

There is no contract code yet. The table below is the function surface implied by the PRD phases [src: Monad Sealed-Bid Auction Engine.md] and EasyAuction's public functions [src: https://github.com/Gnosis-Auction/auction-contracts]. Names are proposals until code exists. "Reverts" plays the role of status codes.

### Sealing layer

| Function | Caller | Inputs | Effects | Reverts |
| --- | --- | --- | --- | --- |
| `openRound(params)` | Creator / exit adapter | preset, tokens, sellAmount, minBidSize, depositAmount, commitEnd, revealEnd, allowlistRoot, autoLP | Locks supply, creates Round | missing minBidSize; sellAmount ≥ 2^96; supply not transferred |
| `commit(roundId, hash)` payable | Bidder | `hash = keccak256(price, quantity, salt, msg.sender)`; value = depositAmount [src: Monad Sealed-Bid Auction Engine.md] | Stores Commitment, escrows deposit | wrong deposit; window closed; not on allowlist (Raise) |
| `reveal(roundId, price, quantity, salt)` | Bidder | preimage | Verifies hash with `msg.sender`, places order in clearing core, marks revealed | hash mismatch; window closed; quantity < minBidSize |

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
| `Revealed` | roundId, bidder, price, quantity |
| `Cleared` | roundId, clearingPrice, filledVolume |
| `Claimed` | roundId, bidder, filled, refunded |
| `Slashed` | roundId, bidder, amount |
| `LPSeeded` | roundId, pool, tokenAmount, proceedsAmount, lockedUntil |

## Hash preimage encoding

```solidity
bytes32 h = keccak256(abi.encode(price, quantity, salt, msg.sender));
```

All four inputs are load-bearing: no salt → brute-forceable; no `msg.sender` → replayable / reveal-front-runnable [src: Monad Sealed-Bid Auction Engine.md]. TODO: confirm `abi.encode` vs `abi.encodePacked` in code (use `abi.encode` to avoid ambiguity).

Related files: [03-architecture.md](03-architecture.md) · [04-flows.md](04-flows.md) · [05-data-model.md](05-data-model.md) · [12-open-questions.md](12-open-questions.md)
