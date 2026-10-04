# Even — sealed-bid fair launches on Monad

**The problem:** on a bonding curve, arrival order sets the price, so bots buy the first blocks and the community buys the top.

**The result**, from our replayed head-to-head (same token, same 13 players, 73 real transactions against the real contracts on a local chain) [src: demo/results.json]:

| | Bonding curve | Even |
| --- | --- | --- |
| Bot's average price | 0.138 MON | 0.220 MON |
| Crowd's average price | 0.275 MON | 0.220 MON |
| Bot's share of supply | 54.5% (blocks 1–3) | 25% |
| Players who got nothing | 8 of 12 | 1 of 12 (bid below the clearing price, refunded in full) |

**Who it is for:** memecoin communities on Monad that want their launch to go to their own buyers, and the creators who launch for them [src: PRODUCT.md].

**Live:** https://even-monad.vercel.app (the pitch, the replay and the app; the engine is not on a public network yet, see [Deployment](#deployment)). Code: this repository.

---

The judge-facing write-up for the Monad Metropolis submission (Social, Attention & Culture track). Mechanism, evidence, cost and limits follow.

Status: draft

## In one line

Your community shouldn't lose its own launch to three bots in the first block. On Even everyone bids sealed, every winner pays the same clearing price, and the pool opens at that price with its liquidity locked [src: 01-overview.md].

Snipe-resistant: submission timing no longer determines price. The bot still takes part; it just pays what everyone pays.

### Across 500 random launches

The same comparison, repeated on 500 random launches: 8–24 buyers each with a random budget (8–40 MON) and price limit (0.15–0.60 MON per token), and one sniper bot (40–120 MON). Every launch is played twice with the same people. On the curve the bot buys in the first three blocks and buyers arrive in random order, each buying while the price is under their limit. On Even everyone bids sealed, the bot at a high price, on the real `AuctionEngine` [src: demo/script/FairnessStats.s.sol, demo/fairness.json].

| Over 500 launches | Bonding curve | Even |
| --- | --- | --- |
| Bot's share of the supply (median, p10–p90) | 59% (39–72%) | 18% (11–26%) |
| Buyers willing to pay the fair price who got nothing | 60% | 0% |
| Launches where the last third to arrive got nothing | 80% | 0% |
| Highest ÷ lowest price paid by buyers (median, p10–p90) | 1.79× (1.46–2.32×) | 1× (every winner pays the clearing price, to 121 wei of rounding) |
| Launches where the bot paid less than the crowd | 100% | 0% |

On this curve the crowd's average price is exactly twice the bot's whenever the curve sells out (a property of its constant-product shape and sale size: 1.74–2.00× across the runs), so that ratio is not reported as a finding. Reproduce: `cd demo && LAUNCHES=500 forge script script/FairnessStats.s.sol && node tools/fairness-summary.mjs`.

## How it works

```mermaid
flowchart LR
  C["Commit<br/>hash(price, amount, salt, sender)<br/>+ the same deposit for everyone"] --> R["Reveal<br/>open the hash;<br/>unrevealed deposits are burned"]
  R --> S["Settle<br/>stack bids from the top price down<br/>until they cover the supply"]
  S --> L["Seed LP<br/>pool opens at the clearing price,<br/>position locked with GoPlus"]
  L --> K["Collect<br/>tokens + refund of deposit − paid"]
```

- **Commit.** `keccak256(abi.encode(price, amount, salt, msg.sender))` plus a uniform deposit. The deposit does not scale with the bid, so it leaks nothing about it [src: contracts/src/SealingLayer.sol].
- **Reveal.** A bid that is not revealed loses its deposit, burned to `0x…dEaD` in one O(1) call (decision 30).
- **Clear.** The price where cumulative demand first covers the supply is the clearing price. Bids above it fill in full, bids at it share the rest pro-rata (rounding down), and every winner pays the clearing price (rounding up); the overpayment is refunded [src: contracts/src/UniformClearing.sol, tasks/clearing.md]. Settlement is resumable across transactions, so a large book cannot be gas-bricked, and a mandatory minimum bid stops dust spam.
- **Seed LP.** A share of tokens sold and MON raised seeds Uniswap v3 at exactly the clearing price, before any auctioned token leaves the contract, so there is nothing to sandwich (bug #7, decision 27). The position NFT is locked in GoPlus `UniV3LPLocker`: permanently on the Degen preset, for a creator-chosen period on Raise. The creator collects trading fees.
- **Presets.** Degen (minutes, open, permanent lock, unsold supply burned) and Raise (allowlist, vesting, unsold supply returned). A creator can bring a token or make one on the spot with the token factory. A second product, the vault **exit-priority auction**, runs on the same clearing to replace FIFO redemption queues [src: contracts/src/exit/].

## What we built in the window

| Part | Where | Evidence |
| --- | --- | --- |
| Engine: sealing, deposit ledger, clearing, LP seeding, presets | `contracts/src/` | 102 contract tests pass, each run once, including 11 that check the PRD's promises one by one ([PRD-CONFORMANCE.md](PRD-CONFORMANCE.md)); the fuzz tests also run clean at 10,000 runs each (`FOUNDRY_PROFILE=deep`) |
| Uniswap v3 adapter + GoPlus lock | `contracts/src/adapters/` | 19 tests against real Uniswap v3 and the GoPlus locker on a Monad mainnet fork |
| Exit-priority auction + demo vault | `contracts/src/exit/`, `demo/exit/` | 29 of the 102 tests (exit auction, allowlist and vault); replayed vault-run demo page |
| Passkey sign-in | `web/js/passkey-wallet.js` | Face ID / Touch ID makes a standard Monad account with Mera (Category Labs): no extension, works on phones, phrase exportable to MetaMask. A full round (create token, open, commit, recover the bid from its note, reveal, settle, seed, claim) ran with a passkey-derived account on a local chain; there the Face ID step was replaced by a fixed test seed, so the passkey ceremony itself still needs a real-device test |
| Token factory | `contracts/src/launch/` | Make a fixed-supply token (no owner, no mint, no fees) and launch it from the same page, as on a launchpad; 4 tests, plus an end-to-end launch |
| Web app "Even" | `web/` | Launch in three steps and one button (token, sale, pool), bid with "spend up to" and "highest price" in one press; create token → commit → reveal → settle → seed → claim run end to end through the UI on a local chain; reveal reminders (calendar file, notification) and a shareable result card; 119 self-tests, 94 end-to-end tests and a 54,571-case grid test of the simple launch and bid forms |
| Indexer + fee report | `indexer/` | Decodes all 13 events, read-only JSON API |
| Head-to-head demo | `demo/` | 73 transactions against the real engine |
| Security | [AUDIT.md](AUDIT.md) | Two internal reviews, each finding with a proof-of-concept test, all fixed or documented; AgentGuard scan below |

## Measured cost

The whole bidder journey costs about a tenth of a cent. Gas from `contracts/script/FeeProbe.s.sol`, priced by `indexer/fee-report.mjs` at Monad mainnet's live gas price (102 gwei, `eth_gasPrice` on rpc.monad.xyz) and MON = $0.0252 (CoinGecko), 24 Sep 2026:

| Journey | Gas | Cost |
| --- | --- | --- |
| Win pro-rata: commit + reveal + claim | 442,934 | $0.0011 |
| Lose, refund only | 389,072 | $0.0010 |
| Worst complete journey (new top price level, refund and tokens claimed separately) | 558,301 | $0.0014 |

Target was under $0.01; the worst case is 7× below it. Monad charges the gas limit, so these use the gas a wallet must send, not the gas used.

## Honest limits

- **Privacy via commit-reveal.** There is no encrypted mempool on Monad today, so none is used. What stays public: the number of bids and when they arrived, the uniform deposit (which caps bid size), the price tick, and every bid once the round settles; that post-clear transparency is intentional.
- **The adversary is narrower than usual.** Monad forwards transactions only to the next few leaders, so the threat is the current and next few leaders, not every bot on the network [src: 03-architecture.md].
- **Last reveal is a position.** A bidder who reveals last sees the book first. Revealing late cannot change a committed bid, only whether to reveal it, and not revealing costs the deposit.
- **Passkey libraries load at runtime.** Mera, viem and scure come from jsDelivr at pinned versions when a visitor picks a passkey; jsDelivr's on-the-fly builds cannot carry an integrity hash, so a compromised CDN could read keys in that session. Serving them from the site itself removes this; not done yet. Passkey accounts also belong to the site's hostname: a different domain derives a different account (the exported phrase moves funds anywhere).
- **Two transactions against one click.** Memecoin buyers want one click, and LBPs show fairer launches alone do not win users. Our answer: the Degen preset runs in minutes, the bidder journey costs a tenth of a cent, and when Monad's BTX encrypted-mempool research ships, commit-reveal collapses into a single transaction without changing the clearing. The sealing layer is a separate module for exactly that swap (decision 12).

## Security scan (AgentGuard)

`agentguard scan contracts/src`, AgentGuard CLI 1.1.28, 24 Sep 2026: 4 findings, triaged below. The CLI reports only tags, so each file was scanned on its own to locate them. Its suppression file (`contracts/src/.agentguard-suppress.yaml`) is not read by this CLI version.

| Tag | File | Verdict |
| --- | --- | --- |
| HIDDEN_TRANSFER | `lib/SafeTransferLib.sol` (`sendValue`) | Intended. The single native-MON send on the money path (refunds, burns, creator proceeds), behind the reentrancy lock and per-round accounting. Reviewed twice in [AUDIT.md](AUDIT.md). |
| HIDDEN_TRANSFER | `vendor/openzeppelin/utils/Address.sol` | Vendored OpenZeppelin v5.1.0, unmodified; used by the demo vault only. |
| WALLET_DRAINING | `vendor/openzeppelin/token/ERC20/IERC20.sol` | Interface declaration of `approve`/`transferFrom`; no code. |
| WALLET_DRAINING | `vendor/openzeppelin/interfaces/IERC1363.sol` | Interface declaration; no code. |

Bidders never approve anything: bids are paid in native MON. The creator approves the sale tokens once, for `openRound`. The engine's own approvals are exact-amount and short-lived, all inside `seedLP`: the adapter pulls the LP tokens (reset to zero after), and the GoPlus locker takes the position NFT.

## Run it

```bash
anvil --order fifo
cd contracts && forge script script/DeployLocal.s.sol --rpc-url http://127.0.0.1:8545 --broadcast
cd .. && python3 -m http.server 8765
```

Open http://127.0.0.1:8765/web/. Replay the head-to-head with `demo/run.sh`; the vault demo with `demo/exit/run.sh`. Tests: `cd contracts && forge test`, `node web/selftest.mjs`, `node web/e2e.mjs`.

## Deployment

TODO: not deployed to a public network yet; engine and adapter addresses go here.

Both deploy scripts were simulated against a Monad mainnet fork on 24 Sep 2026 (the engine needs about 6.2M gas, at most about 1.3 MON at 202 gwei). To deploy, from `contracts/`, with a funded deployer imported once as a Foundry keystore (`cast wallet import deployer --interactive`), so no key sits in the shell:

```bash
forge script script/DeployAdapter.s.sol --rpc-url https://rpc.monad.xyz --account deployer --broadcast
```

```bash
ADAPTERS=<adapter address from deployments/143-adapter.json> forge script script/Deploy.s.sol --rpc-url https://rpc.monad.xyz --account deployer --broadcast
```

The engine address lands in `contracts/deployments/143.json`; put it in `web/config.js` under `monad.deployment.auctionEngine` and here.

**Alternative for a wallet that can only call contracts** (for example the OKX Agentic Wallet, which supports Monad but sends no contract-creation transaction): `forge script script/Create2Plan.s.sol --fork-url https://rpc.monad.xyz` writes three calls to the standard CREATE2 deployer (`0x4e59b44847b379578588920cA78FbF26c0B4956C`, live on Monad) and simulates them on a mainnet fork. The addresses are fixed in advance (salt `even-v1`, 5 Oct build): `UniswapV3Adapter` `0xf39aC5535BBC2d05DAB077F9bbA02fAc9003D87C`, `AuctionEngine` `0xA24b9038C1f517bc0be0FAe6374B6D7a4BC90312`, `TokenFactory` `0xD739cb0b65E48EE7443beEEA0950733C76dA4D4e`. Any code change changes them; rerun the plan before deploying.

**After deploying** (the site reads through `https://rpc1.monad.xyz`, which serves `eth_getLogs` over any range; `rpc.monad.xyz` caps it at 100 blocks, about 30 seconds of Monad):

1. In `web/config.js` under `monad.deployment`, set `auctionEngine`, `adapter`, `tokenFactory` and `positionManager` (`0x7197E214c0b767cFB76Fb734ab638E2c192F4E53`).
2. Set `monad.fromBlock` to the engine's deploy block, so log scans start there.
3. Push to `master`: Vercel redeploys `https://even-monad.vercel.app` automatically.
4. Open one small real round from the Host page, bid from two wallets, and settle, seed and claim it; put its round link here.

## Demo video (script, about 2 minutes)

1. **0:00–0:20 — the replay.** Landing page: the two-player cabinet plays. The bot wins the curve; Even calls a draw at 0.220. No narration beyond the captions.
2. **0:20–0:40 — the claim.** "Nobody gets a head start. Snipe-resistant: submission timing no longer determines price."
3. **0:40–1:20 — a bid.** Round page: insert coin (commit), the coin rack fills, the clock runs out, continue? (reveal), settle, results with the demand staircase and the one price.
4. **1:20–1:40 — the pool.** Seed LP, show the locked position and the refund landing.
5. **1:40–2:00 — the proof.** Tests, fork tests, fee table ($0.0014 worst case), and the honest-limits list.

Related files: [README.md](README.md) · [01-overview.md](01-overview.md) · [03-architecture.md](03-architecture.md) · [AUDIT.md](AUDIT.md) · [DESIGN.md](DESIGN.md) · [10-decisions.md](10-decisions.md)
