# Indexer

Event indexer and read-only JSON API for `AuctionEngine`. No dependencies: Node >= 18 built-ins only
(`fetch` for JSON-RPC, `node:http` for the API). Event layouts and topic hashes come from
`contracts/abi/AuctionEngine.json` at start-up; the contract is the source of truth.

State lives in memory and is rebuilt from `FROM_BLOCK` on every start.

## Run

```bash
# local: anvil + contracts/script/DeployLocal.s.sol (writes contracts/deployments/local.json)
node indexer.mjs

# any chain
RPC_URL=https://rpc.monad.xyz ENGINE_ADDRESS=0x... FROM_BLOCK=<deploy block> node indexer.mjs
```

| Env | Default | |
| --- | --- | --- |
| `RPC_URL` | `http://127.0.0.1:8545` | JSON-RPC endpoint |
| `ENGINE_ADDRESS` | `auctionEngine` in `DEPLOYMENT` | engine to follow |
| `DEPLOYMENT` | `../contracts/deployments/local.json` | used only when `ENGINE_ADDRESS` is unset |
| `FROM_BLOCK` | `0` | first block to scan |
| `CHUNK` | `100` | blocks per `eth_getLogs` call |
| `CONFIRMATIONS` | `0` | blocks behind head to stay |
| `INTERVAL_MS` | `2000` | poll interval |
| `HOST` / `PORT` | `127.0.0.1` / `8787` | API listen address |
| `ABI_PATH` | `../contracts/abi/AuctionEngine.json` | ABI to decode with |

## Tests

```bash
npm test          # unit: keccak, decoding of all 13 events, views, HTTP API, fee report
npm run test:e2e  # anvil + DeployLocal + real txs: a full Degen round (both claim paths, a
                  # non-revealer), a Raise round with vesting, an abandoned-LP round; needs Foundry
```

## Events decoded

`RoundOpened`, `Committed` (with `note`), `Revealed`, `UnrevealedBurned`, `Cleared`, `LPSeeded`,
`LPAbandoned`, `ClaimsOpened`, `UnsoldDisposed`, `Claimed` (emitted at the refund step),
`TokensClaimed`, `VestedClaimed`, `ProceedsWithdrawn`. On `RoundOpened`
the indexer also reads the round's fixed terms with `getRound` (`eth_call`). For each event it records
the emitting transaction's `gasUsed`, gas limit and `effectiveGasPrice`.

## API

All endpoints are `GET`, return `application/json`, and send `access-control-allow-origin: *`.
Errors: `404 {"error": ...}` for an unknown path, a round not indexed, or a bidder with no commitment
in that round; `405` for any method other than GET/HEAD/OPTIONS; `500 {"error": ...}` on failure.

Conventions: integers (amounts, prices, gas, fees, ids) are **decimal strings**. Token and MON amounts
are in wei (1e-18). `price` is MON wei per 1e18 token units, as in the contract. Addresses are
lowercase. `blockNumber` and `timestamp` (unix seconds) are numbers. Wherever a record comes from an
event, it carries `blockNumber`, `timestamp` and `txHash`, abbreviated below as `…meta`.

### `GET /health`
```json
{ "ok": true, "engine": "0x…", "chainId": 31337, "indexedToBlock": 120,
  "head": { "blockNumber": 120, "timestamp": 1790000000 } }
```

### `GET /rounds`
`{ "rounds": [ <round summary>, … ] }`, ordered by round id.

### `GET /rounds/:id` — round summary
```json
{ "roundId": "1", "phase": "commit | reveal | awaiting-settlement | cleared | claims-open | open",
  "creator": "0x…", "token": "0x…", "preset": "Degen | Raise", "allowlistURI": "",
  "opened": { …meta },
  "config": { "sellAmount", "tokenReserve", "depositAmount", "minBidSize", "tickSize", "reservePrice",
              "commitEnd", "revealEnd", "lpShareBps", "tgeBps", "cliff", "vestDuration", "lockDuration",
              "lockFeeTier", "allowlistRoot" },
  "commitCount": 5, "revealCount": 4, "refundCount": 4, "tokensClaimedCount": 4,
  "clearing": { <see /clearing> } | null,
  "lpSeeded": true, "lpAbandoned": false, "claimsOpen": true,
  "unrevealedBurned": { "count": "1", "amount": "…", …meta } | null,
  "proceedsWithdrawn": "…" }
```
`phase` comes from events, or from `config` windows and the indexed head's timestamp before clearing.

### `GET /rounds/:id/commitments` — commitment count over time
Public by design: it is the one demand signal a round has during the commit window.
```json
{ "roundId": "1", "total": 5,
  "series": [ { "blockNumber": 12, "timestamp": 1790000100, "added": 2, "count": 2 }, … ] }
```
One point per block with commits; `count` is cumulative.

### `GET /rounds/:id/reveals`
```json
{ "roundId": "1", "commitCount": 5, "revealCount": 4, "unrevealedCount": 1,
  "series": [ { "blockNumber", "timestamp", "added", "count" }, … ] }
```

### `GET /rounds/:id/demand` — demand curve after reveals
```json
{ "roundId": "1", "final": true, "supply": "1000000000000000000000", "revealCount": 4,
  "totalAmount": "1400000000000000000000", "clearingPrice": "3000000000000000" | null,
  "levels": [ { "price": "5000000000000000", "amount": "400…", "bids": 1, "cumulativeAmount": "400…" }, … ] }
```
Levels are distinct revealed prices, highest first; `cumulativeAmount` is the running total the
clearing walks. `final` is true once the reveal window is over or the round has cleared.

### `GET /rounds/:id/clearing`
```json
{ "roundId": "1",
  "clearing": { "clearingPrice": "…", "sold": "…", "oversubscribed": true, …meta } | null }
```

### `GET /rounds/:id/lp` — LP seeding and locks
```json
{ "roundId": "1",
  "seeds": [ { "adapter", "positionManager", "nftId", "tokenAmount", "monAmount", "lockId", …meta } ],
  "lockIds": [ "0" ],
  "totals": { "tokenAmount": "…", "monAmount": "…" },
  "abandoned": { "monBurned": "…", …meta } | null,
  "claimsOpened": { "lpSeeded": true, …meta } | null,
  "unsoldDisposed": [ { "to": "0x…dead", "amount": "…", "burned": true, …meta } ] }
```
`lockId` is the GoPlus `UniV3LPLocker` lock id. `abandoned` is set when `abandonLP` ran after the grace
period: the LP's MON share was burned and claims opened without an LP (`claimsOpened.lpSeeded` false).
`unsoldDisposed` lists `disposeUnsold` and `sweepDust` transfers, which are separate calls after seeding.

### `GET /rounds/:id/bidders` — all journeys
```json
{ "roundId": "1", "bidders": [ <journey>, … ],
  "gas": { "commit": { "count", "min", "max" }, "reveal": {…},
           "refund": {…}, "tokens": {…},      // separate claimRefund / claimTokens transactions
           "refundAndTokens": {…},             // one transaction doing both (claim, or claimTokens first)
           "completeJourney": {…} } }
```

### `GET /rounds/:id/bidders/:address` — one bidder's journey
```json
{ "roundId": "1", "bidder": "0x…",
  "status": "committed | revealed | refunded | claimed | unrevealed | burned",
  "commit": { "hash": "0x…", "note": "0x…", "noteBytes": 192, …cost },
  "reveal": { "price": "…", "amount": "…", …cost } | null,
  "refund": { "allocated": "…", "paid": "…", "refund": "…", …cost } | null,
  "tokens": { "amount": "…", "sameTxAsRefund": true, …cost } | null,
  "vested": [ { "amount": "…", …cost } ],
  "journey": { "complete": true, "transactions": 3, "gasUsed": "…", "gasLimit": "…", "fee": "…",
               "feeAtGasLimit": "…",
               "paidByBidder": { "transactions": 3, "fee": "…", "feeAtGasLimit": "…" } } }
```
The journey is commit → reveal → refund → tokens. `refund` comes from `Claimed`, `tokens` from
`TokensClaimed`. They are one transaction (`claim`, or `claimTokens` before any refund:
`sameTxAsRefund` true) or two (`claimRefund` once settled, then `claimTokens` once claims open).
Anyone may send `claimRefund`/`claimTokens` for a bidder, so each step records who sent it (`from`).

`…cost` is `…meta` plus `from`, `gasUsed`, `gasLimit`, `effectiveGasPrice`, `fee` (= gasUsed ×
price) and `feeAtGasLimit` (= gasLimit × price). **Monad charges the gas limit, not gas used**
(docs.monad.xyz, gas pricing), so on Monad `feeAtGasLimit` is what the bidder paid. `burned` means the
round's `UnrevealedBurned` has run and this bidder never revealed (deposit burned, decision 30);
`unrevealed` means the reveal window is over but the burn has not run yet; `refunded` means the MON came
back and tokens are still to be claimed. `journey` totals cover commit, reveal, refund and tokens, each
distinct transaction counted once, whoever sent it; `paidByBidder` counts only transactions the bidder
sent. `complete` is true once the bidder has revealed, been refunded and (if they won anything)
received tokens. `claimVested` is listed under `vested`, outside the journey totals.

### `GET /rounds/:id/events`
`{ "roundId": "1", "events": [ { "event": "Committed", …fields, …meta, "logIndex": 0 }, … ] }` in chain order.

## Fee report

`fee-report.mjs` prices the PRD's bidder journey (target < $0.01): commit + reveal + either `claim`
(refund and tokens in one transaction) or `claimRefund` + `claimTokens`. Gas comes from
`contracts/script/FeeProbe.s.sol`, which runs the same bid book once per path; no MON price is built in.

```bash
cd contracts && forge script script/FeeProbe.s.sol --isolate > /tmp/probe.txt
cd ../indexer && node fee-report.mjs --probe /tmp/probe.txt --rpc https://rpc.monad.xyz --mon-usd <price>
node fee-report.mjs --commit 78805 --reveal 163243 --claim 202851 --gas-price 102gwei
node fee-report.mjs --commit 78805 --reveal 163243 --refund 129285 --tokens 117277 --gas-price 102gwei
```
It prices the probe's `needed` gas (pre-refund, the floor of the gas limit) by default because Monad
bills the limit; `--basis used` prices receipt gas instead, `--buffer <pct>` adds wallet headroom.
Without `--mon-usd` it prints MON and the MON/USD price below which the worst journey stays under $0.01.
