# 07 — Tech Stack

Layer-by-layer technology choices, the reason for each, and the alternative passed on.

Status: draft

| Layer | Choice | Why | Alternative passed on |
| --- | --- | --- | --- |
| Chain | Monad | Sub-second finality makes two-transaction commit-reveal cost pennies; hackathon target; nad.fun is the incumbent to contrast against [src: Monad Sealed-Bid Auction Engine.md] | Arbitrum One — portable, but Fair Launch niche already occupied by Uniswap CCA + HuddlePad [src: https://www.coinrank.io/crypto/uniswap-cca-is-rewriting-arbitrum-native-token-launches/]; Ethereum L1 — two-tx flow "economically absurd" [src: Monad Sealed-Bid Auction Engine.md] |
| Clearing math | Fork of Gnosis EasyAuction (LGPL-3.0, audited by Adam Kolar and G0 Group, Feb–Mar 2021) | Audited off-by-one-at-the-marginal-bid logic, partial fills, multi-tx settlement, min bid size [src: Monad Sealed-Bid Auction Engine.md] | Regenerating the clearing loop with an LLM — the marginal-bid bug is the main reason not to [src: Monad Sealed-Bid Auction Engine.md] |
| Sealing | Commit-reveal with `keccak256(price, quantity, salt, msg.sender)` | Only sealing primitive that exists on Monad today [src: Monad Sealed-Bid Auction Engine.md] | BTX encrypted mempool — a Category Labs research scheme, no deployment mention [src: https://eprint.iacr.org/2026/754]; FHE / MPC / enclave / ZK — non-goals [src: Monad Sealed-Bid Auction Engine.md] |
| Collateral | Uniform capped deposit (a16z OverCollateralizedAuction pattern) | A bid-proportional deposit leaks the bid [src: Monad Sealed-Bid Auction Engine.md] | CREATE2 vaults + state proofs — not a three-week build [src: Monad Sealed-Bid Auction Engine.md] |
| Reveal enforcement | Slashing of non-revealers | Makes reveal refusal costly rather than free [src: Monad Sealed-Bid Auction Engine.md] | No penalty — losers would never reveal |
| Contract language | Solidity | EasyAuction is Solidity; Monad is EVM | Vyper / Stylus — would forfeit the fork |
| Contract tooling | TODO: not found in source (Foundry likely, given fork + fuzz needs) | — | Hardhat |
| Frontend | TODO: not found in source | Vibe-coded freely per PRD [src: Monad Sealed-Bid Auction Engine.md] | — |
| Wallet | TODO: not found in source | — | — |
| Indexer | TODO: not found in source; event decoding is vibe-code territory [src: Monad Sealed-Bid Auction Engine.md] | — | — |
| DEX for LP seed | TODO: not found in source | Must support pool creation + LP lock atomically at settle | — |
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

EasyAuction is LGPL-3.0 (copyleft). Fine for a hackathon with disclosure; decide before commercializing [src: Monad Sealed-Bid Auction Engine.md].

Related files: [03-architecture.md](03-architecture.md) · [10-decisions.md](10-decisions.md) · [11-roadmap.md](11-roadmap.md) · [12-open-questions.md](12-open-questions.md)
