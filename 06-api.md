# 06 — API

The contract interface of the engine and any HTTP/indexer API.

Status: draft

## HTTP / indexer API

The indexer (`indexer/`, Node built-ins only) serves a read-only JSON API on `127.0.0.1:8787` by default (`HOST`/`PORT`). Full request/response shapes: [indexer/README.md](indexer/README.md) [src: indexer/README.md].

All endpoints are `GET`, return `application/json` and send `access-control-allow-origin: *`; unknown paths, rounds or bidders get `404 {"error": …}`, other methods `405`, failures `500 {"error": …}`. Amounts are decimal strings in wei.

| Path | Returns |
| --- | --- |
| `/health` | Liveness and the indexed block |
| `/rounds` | All rounds |
| `/rounds/:id` | Round summary |
| `/rounds/:id/commitments` | Commitment count over time |
| `/rounds/:id/reveals` | Reveals |
| `/rounds/:id/demand` | Demand curve after reveals |
| `/rounds/:id/clearing` | Clearing result |
| `/rounds/:id/lp` | LP seeding and locks |
| `/rounds/:id/bidders` | Every bidder's journey |
| `/rounds/:id/bidders/:address` | One bidder's journey |
| `/rounds/:id/events` | Raw decoded events |

The web app does not depend on the indexer; it reads the engine directly through the wallet or the network's RPC.

## Contract interface — implemented (23 Sep)

Source of truth: `contracts/src/AuctionEngine.sol` with `SealingLayer.sol`, `DepositLedger.sol` and `UniformClearing.sol` [src: contracts/src]. ABI: `contracts/abi/AuctionEngine.json`. All state-changing functions share one reentrancy lock. Revert strings play the role of status codes.

### Lifecycle

| Function | Caller | When | Effect | Main reverts |
| --- | --- | --- | --- | --- |
| `openRound(OpenParams)` | Creator | — | Validates the preset, pulls `sellAmount + sellAmount × lpShareBps / 10000` tokens, opens the book | `degen needs LP`, `adapter not allowed`, `splits must sum to 100%`, `reserve off grid`, `fee-on-transfer token`, `bad windows` |
| `commit(roundId, hash, proof, note)` payable | Bidder | before `commitEnd` | Stores the hash, locks exactly `depositAmount`, emits `note` without storing it | `wrong deposit`, `not on allowlist`, `already committed`, `note too long`, `commit window closed` |
| `reveal(roundId, price, amount, salt)` / `revealWithHint(…, hint)` | Bidder | `commitEnd` to `revealEnd` | Checks the hash with `msg.sender`, validates the bid, adds it to the book | `hash mismatch`, `price off grid or below reserve`, `below minimum bid`, `bid exceeds deposit` |
| `burnUnrevealed(roundId)` | Anyone | after `revealEnd` | Burns `(commits − reveals) × deposit` | `nothing to burn` |
| `settle(roundId, maxSteps)` | Anyone | after `revealEnd` | Walks up to `maxSteps` price levels; returns `true` once the clearing price is fixed | `reveal window open`, `not settleable` |
| `seedLP(roundId)` | Anyone | once settled | Seeds every DEX split at the clearing price, locks each position with GoPlus, opens token claims | `not settled`, `LP already done`, `adapter overspent`, `position not received`, adapter reverts |
| `abandonLP(roundId)` | Anyone | `lpGracePeriod` after settlement, LP not done | Gives up on seeding: burns the LP's MON share and opens token claims (decision 25, audit H1) | `not settled`, `LP already done`, `grace period not over` |
| `disposeUnsold(roundId)` | Anyone | after LP done or abandoned | Burns (Degen) or returns to the creator (Raise) the unsold supply; retryable | `nothing to dispose` |
| `claimRefund(roundId, bidder)` | Anyone, for a bidder | once settled | Pays `deposit − paid` to the bidder; independent of the token (audit M2) | `not settled`, `not revealed` |
| `claimTokens(roundId, bidder)` | Anyone, for a bidder | claims open | Tokens won (or the TGE share on a vesting Raise) | `claims not open`, `tokens already claimed` |
| `claim(roundId)` | Revealed bidder | once settled | Refund, then tokens if claims are open | `nothing to claim` |
| `claimVested(roundId)` | Raise winner | after claim | Releases tokens vested since the last call | `no vesting`, `nothing vested` |
| `withdrawProceeds(roundId)` | Creator | after the LP is done | Pays payments collected so far minus MON that went to the LP | `not creator`, `LP not done`, `nothing to withdraw` |
| `sweepDust(roundId)` | Anyone | every revealed bidder has taken their refund | Disposes of pro-rata rounding dust like unsold supply | `not sweepable`, `refunds outstanding` |

### Views

| Function | Returns |
| --- | --- |
| `getRound(roundId)` | The whole `Round` struct: terms, lifecycle flags, accounting |
| `splitsOf(roundId)` | The DEX split |
| `clearingOf(roundId)` | `settled, clearingPrice, sold, soldLowerBound, oversubscribed, totalQty, levelCount` |
| `quote(roundId, bidder)` | `allocated, paid, refund` once settled |
| `findHint(roundId, price)` | The existing price level just above `price`, to pass to `revealWithHint` |
| `vestedOf(roundId, bidder)`, `creatorAvailable(roundId)`, `roundBalance(roundId)`, `ledgers(roundId)`, `accounts(roundId, bidder)`, `commitments(roundId, bidder)`, `bids(roundId, bidder)` | Accounting detail |

### Events

| Event | Fields |
| --- | --- |
| `RoundOpened` | roundId, creator, token, preset, allowlistURI |
| `Committed` | roundId, bidder, hash, note |
| `Revealed` | roundId, bidder, price, amount |
| `UnrevealedBurned` | roundId, count, amount |
| `Cleared` | roundId, clearingPrice, sold, oversubscribed |
| `LPSeeded` | roundId, adapter, positionManager, nftId, tokenAmount, monAmount, lockId |
| `LPAbandoned` | roundId, monBurned |
| `ClaimsOpened` | roundId, lpSeeded |
| `UnsoldDisposed` | roundId, to, amount |
| `Claimed` | roundId, bidder, allocated, paid, refund |
| `TokensClaimed` | roundId, bidder, amount |
| `VestedClaimed` | roundId, bidder, amount |
| `ProceedsWithdrawn` | roundId, amount |

### Also implemented
- `UniswapV3Adapter` (fork-tested against Uniswap v3 and the GoPlus locker on Monad mainnet, 19 tests).
- `ExitAuction` and `DemoVault` for Exit-Priority (decisions 31, 34). Its `Config` takes an optional `allowlistRoot` (zero = every holder may bid), fixed at deployment, per the PRD's Vault preset.

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

Superseded: unrevealed deposits are burned to `0x…dEaD` by `burnUnrevealed` (decision 30).

### LP seeder (Fair Launch)

| Function | Caller | Inputs | Effects | Reverts |
| --- | --- | --- | --- | --- |
| `seedLP(roundId)` | Inside settle | — | Creates pool with proceeds + remaining supply, locks LP [src: Monad Sealed-Bid Auction Engine.md] | autoLP false; already seeded |

Note bug #7: superseded. Pools start at the clearing price and no auctioned token exists outside the contract until seeding is done (Q5 resolved, decision 27).

### Exit adapter (Exit-Priority)

| Function | Caller | Inputs | Effects | Reverts |
| --- | --- | --- | --- | --- |
| `openExitRound()` | Keeper every N blocks | — | Opens a Vault-preset round with the period's exit capacity [src: Monad Sealed-Bid Auction Engine.md] | previous round not settled |
| `redeemFilled(roundId)` | Exiting holder | — | Redeems from vault at clearing discount | not settled |
| `accrueToStayers(roundId)` | Inside settle | — | Credits discount to remaining holders [src: Monad Sealed-Bid Auction Engine.md] | — |

## Hash preimage encoding

```solidity
bytes32 h = keccak256(abi.encode(price, amount, salt, msg.sender));
```

All four inputs are load-bearing: no salt → brute-forceable; no `msg.sender` → replayable / reveal-front-runnable [src: Monad Sealed-Bid Auction Engine.md]. Confirmed in code: `abi.encode`, in both `SealingLayer.reveal` and the frontend's `commitHash` in `web/js/bid.js`, which the page checks against a Foundry `cast` vector on every load [src: contracts/src/SealingLayer.sol, web/js/bid.js, web/js/main.js].

Related files: [03-architecture.md](03-architecture.md) · [04-flows.md](04-flows.md) · [05-data-model.md](05-data-model.md) · [12-open-questions.md](12-open-questions.md)
