# 10 — Decisions

Every product and engineering decision made so far, with rationale and the trade-off accepted.

Status: draft (items marked *settled* are fixed in the PRD)

| # | Decision | Rationale | Trade-off | Status |
| --- | --- | --- | --- | --- |
| 1 | One engine, two presets, two tracks — not two codebases [src: Monad Sealed-Bid Auction Engine.md] | Proves the engine is a primitive; halves contract surface | Second use case is only as good as the shared core | settled |
| 2 | Fair Launch is the primary submission in track 03 Social, Attention & Culture [src: Monad Sealed-Bid Auction Engine.md] | Strong DeFi teams crowd track 01; a rigorous mechanism is an execution outlier in track 03; the sniper demo reads to any judge | Track-fit is a write-up problem; culture judges won't read the clearing loop | settled |
| 3 | Exit-Priority Auction ships as a second submission only if multiple submissions are allowed and use case 1 is done by day 14; otherwise it is a preset [src: Monad Sealed-Bid Auction Engine.md] | Protects the primary; still demonstrates generality | Finance-track prize possibly forfeited | settled, gated |
| 4 | ICO/raise is a preset (Raise), not a submission [src: Monad Sealed-Bid Auction Engine.md] | "ICO platform" reads as 2017; no distinct audience; near-zero marginal work | None material | settled |
| 5 | Fork EasyAuction for clearing [src: Monad Sealed-Bid Auction Engine.md] | Audited marginal-bid logic, partial fills, multi-tx settlement | LGPL-3.0 copyleft; uint96 limits; must read the fork line by line | settled |
| 6 | Hand-write commit-reveal, slashing, LP seed [src: Monad Sealed-Bid Auction Engine.md] | No reference implementation; money path | Slower; these are the highest-risk lines | settled |
| 7 | Hash preimage is `(price, quantity, salt, msg.sender)` [src: Monad Sealed-Bid Auction Engine.md] | Salt defeats brute force; sender defeats replay and reveal front-running | Salt must be kept client-side; lost salt = slash | settled |
| 8 | Uniform capped deposit, not bid-proportional [src: Monad Sealed-Bid Auction Engine.md] | Proportional deposit leaks the bid (a16z) | More idle capital; bid size bounded by the cap | settled |
| 9 | Slash non-revealers [src: Monad Sealed-Bid Auction Engine.md] | Makes reveal refusal costly | Honest users who lose a salt are punished; slash destination TBD | settled (destination open) |
| 10 | Keep EasyAuction's minimum bid size mandatory [src: Monad Sealed-Bid Auction Engine.md] | Dust commit spam would make the auction unsettleable | Excludes very small bidders | settled |
| 11 | No encrypted mempool dependency; commit-reveal only [src: Monad Sealed-Bid Auction Engine.md] | BTX is a paper with no deployment [src: https://eprint.iacr.org/2026/754]; Cadence says "when fully implemented and released" [src: https://monad.xyz/blog/cadence-multiple-concurrent-proposers]; live docs show plaintext forwarding [src: https://docs.monad.xyz/monad-arch/consensus/local-mempool] | Two transactions instead of one; the user's wish to build on BTX is not met today — logged in [12-open-questions.md](12-open-questions.md) | settled for Oct; revisit |
| 12 | Use BTX as positioning: "when BTX lands, commit-reveal collapses into a single transaction" [src: Monad Sealed-Bid Auction Engine.md] | Honest, forward-compatible, aligns with what Monad is promoting | Requires the sealing layer to be swappable — design it as a module | settled |
| 13 | State the threat model as "the current and next few leaders" [src: Monad Sealed-Bid Auction Engine.md] | Matches the local-mempool docs (N=3 leaders); more credible than overclaiming | Weaker headline than "no MEV" | settled |
| 14 | Claim "snipe-resistant", never "no sniping" [src: Monad Sealed-Bid Auction Engine.md] | Last-reveal and timing leaks exist | Softer pitch | settled |
| 15 | Non-goals: KYC, RWA, FHE/MPC/enclave/ZK, cross-chain, perpetual privacy of losing bids [src: Monad Sealed-Bid Auction Engine.md] | Three-week build | The Alpos et al. ZK approach is out of scope [src: https://arxiv.org/html/2606.14939] | settled |
| 16 | Exit-Priority over liquidation or intent auctions [src: Monad Sealed-Bid Auction Engine.md] | Liquidation auctions get built several times per hackathon; FIFO redemption is where the race is destructive; no incumbent | Heavier vault integration | settled |
| 17 | Curator-mandate auction is the fallback for use case 2 [src: Monad Sealed-Bid Auction Engine.md] | Fits Monad's 10 Aug curator narrative; Morpho live | Weaker demo | settled as fallback |
| 18 | Build on Monad, not Arbitrum | Track fit; nad.fun is the incumbent to contrast; sub-cent fees | Arbitrum has a private sequencer mempool that would make the commit phase more private [src: https://docs.arbitrum.io/how-arbitrum-works/timeboost/gentle-introduction], but CCA + HuddlePad already occupy the launch niche there | draft |
| 19 | Keep contracts chain-agnostic (no Monad-specific precompiles) | Enables an Arbitrum deployment later at no redesign cost | Cannot exploit Monad-only features | draft |
| 20 | Run `/agentguard scan` and publish the report [src: Monad Sealed-Bid Auction Engine.md] | Covers five of the eight bugs; credibility line in the pitch | Not an audit | settled |
| 21 | Demo the head-to-head, not the contract [src: Monad Sealed-Bid Auction Engine.md] | Legible to any judge in twenty seconds | Contract quality still matters for the Grand Champion pick | settled |

Related files: [01-overview.md](01-overview.md) · [03-architecture.md](03-architecture.md) · [07-tech-stack.md](07-tech-stack.md) · [12-open-questions.md](12-open-questions.md)
