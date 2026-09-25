# 07 — Tech Stack

Layer-by-layer technology choices, the reason for each, and the alternative passed on.

Status: draft

| Layer | Choice | Why | Alternative passed on |
| --- | --- | --- | --- |
| Chain | Monad | Sub-second finality makes two-transaction commit-reveal cost pennies; hackathon target; nad.fun is the incumbent to contrast against [src: Monad Sealed-Bid Auction Engine.md] | Arbitrum One — portable, but Fair Launch niche already occupied by Uniswap CCA + HuddlePad [src: https://www.coinrank.io/crypto/uniswap-cca-is-rewriting-arbitrum-native-token-launches/]; Ethereum L1 — two-tx flow "economically absurd" [src: Monad Sealed-Bid Auction Engine.md] |
| Clearing math | **Decided 22 Sep (decision 22):** Zama-style uniform-price clearing — price + amount, pro-rata at the clearing price, refunds [src: https://docs.zama.org/auction/how-it-works]. Implemented as an internal contract of the engine, not a separately deployed core | Fixed-quantity fills; no reveal-order tie advantage; an internal contract cannot be called around the engine (removes the AUDIT C1–C3 class) | Gnosis EasyAuction fork — audited, but sums budgets and breaks ties by reveal order |
| Sealing | Commit-reveal with `keccak256(price, amount, salt, msg.sender)` | Only sealing primitive that exists on Monad today [src: Monad Sealed-Bid Auction Engine.md] | BTX encrypted mempool — a Category Labs research scheme, no deployment mention [src: https://eprint.iacr.org/2026/754]; FHE / MPC / enclave / ZK — non-goals [src: Monad Sealed-Bid Auction Engine.md] |
| Collateral | Uniform capped deposit (a16z OverCollateralizedAuction pattern) | A bid-proportional deposit leaks the bid [src: Monad Sealed-Bid Auction Engine.md] | CREATE2 vaults + state proofs — not a three-week build [src: Monad Sealed-Bid Auction Engine.md] |
| Reveal enforcement | Slashing of non-revealers | Makes reveal refusal costly rather than free [src: Monad Sealed-Bid Auction Engine.md] | No penalty — losers would never reveal |
| Contract language | Solidity | Monad is EVM; the team's existing code is Solidity | Vyper — no advantage for this build |
| Contract tooling | Foundry 1.8.3, solc 0.8.28, via-IR; fuzz and Monad-fork tests [src: contracts/foundry.toml] | Fork tests against real Uniswap v3 and GoPlus on Monad; differential fuzzing of the clearing | Hardhat |
| Frontend | "Even": static HTML, CSS and ES modules, no build step, no framework; design system in [DESIGN.md](DESIGN.md), product record in [PRODUCT.md](PRODUCT.md) [src: web/] | Serves from any static host; hand-rolled ABI coder and keccak keep the money path small and testable (`web/selftest.mjs`, `web/e2e.mjs`) | React/Vite — a build step and a dependency tree for three screens |
| Wallet | Any injected EIP-1193 wallet (`window.ethereum`); reads fall back to the network's RPC [src: web/js/wallet.js, web/js/net.js] | No SDK dependency | wagmi/viem — needs a bundler |
| Indexer | Node built-ins only: decodes the engine's 13 events and serves a read-only JSON API; also produces the fee report [src: indexer/README.md] | No database or framework to run at a hackathon | The Graph / Ponder — hosted setup time |
| DEX for LP seed | Multiple, through one adapter interface [src: user, 22 Sep]. Built: Uniswap v3. PancakeSwap v3: not built (decision 23) | Creator chooses venues; Uniswap v3 has verified Monad addresses [src: https://developers.uniswap.org/docs/protocols/v3/deployments/v3-monad-deployments] | Kuru — order book, no lockable LP position; Uniswap v4 — deferred, hooks add review surface |
| LP lock | GoPlus `UniV3LPLocker` `0x24A9eB23De8E6f59BDB981B03E847F0f3ABbFa0d` [src: https://docs.gopluslabs.io/page/goplus-safetoken-locker] | Verified on Monad [src: on-chain, Monad RPC, 22 Sep]; locks v3 position NFTs; creator keeps trading fees as `collector` | Burning the LP — free, but loses fee income and a verifiable lock |
| Demo harness | Custom sniper bot + bonding curve baseline + vault-run simulator [src: Monad Sealed-Bid Auction Engine.md] | The head-to-head is the pitch for the Culture track | — |
| Security check | `/agentguard scan` on our own contracts; report in README [src: Monad Sealed-Bid Auction Engine.md] | Covers reentrancy, unlimited approval, signature replay, hidden transfers, access control — five of the eight bugs | Paid audit — no time |

## Code-authorship rule

| Vibe code freely | Hand-write and review line by line [src: Monad Sealed-Bid Auction Engine.md] |
| --- | --- |
| Frontend, wallet connection, dashboard | Commit hash construction |
| Countdown UI, indexer, event decoding | Clearing loop (forked, then read) |
| Bot-vs-auction demo harness | Settlement accounting |
| Deploy scripts, test fixtures | Deposit slashing |
| README, pitch deck | LP seed step |

Rationale: LLM assistance multiplies throughput 3–5x on the left column and ~1x (less after review time) on the right [src: Monad Sealed-Bid Auction Engine.md].

## Licensing note

The original EasyAuction fork was LGPL-3.0 (copyleft). With Zama-style clearing replacing it (decision 22), no EasyAuction code remains, so that obligation goes too. Our files currently carry LGPL headers; changing them is our call.

Related files: [03-architecture.md](03-architecture.md) · [10-decisions.md](10-decisions.md) · [11-roadmap.md](11-roadmap.md) · [12-open-questions.md](12-open-questions.md)
