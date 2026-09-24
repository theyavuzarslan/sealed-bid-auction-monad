# Sealed-Bid Auction Engine on Monad

Documentation index for the Monad Metropolis hackathon submission (deadline 13 Oct 2026). Judges: start with [SUBMISSION.md](SUBMISSION.md), the write-up.

Status: draft

## Summary

- One sealed-bid, uniform-clearing-price batch auction engine on Monad, shipped as configured presets rather than separate codebases [src: Monad Sealed-Bid Auction Engine.md].
- Bidders commit a hash plus a uniform collateral deposit, reveal later, and everyone who clears pays the same price; non-revealers are slashed [src: Monad Sealed-Bid Auction Engine.md].
- Clearing is Zama-style: a bid is a price per token plus a token amount; winners pay the clearing price, bids at the clearing price share pro-rata, and overpayment is refunded [src: https://docs.zama.org/auction/how-it-works]. It replaced the original EasyAuction fork on 22 Sep (decision 22).
- Use case 1 (primary): memecoin **Fair Launch** for the Social, Attention & Culture track. Use case 2 (conditional): vault **Exit-Priority Auction** for the Onchain Finance & Trading track [src: Monad Sealed-Bid Auction Engine.md].
- The web app is called **Even** ("Nobody gets a head start"): a two-player arcade cabinet in Monad's colours where the bonding curve is Player 1 and the sealed-bid round is Player 2. Code in `web/`, design system in [DESIGN.md](DESIGN.md), product record in [PRODUCT.md](PRODUCT.md).
- Privacy comes from commit-reveal alone today; Monad's BTX encrypted mempool is a research scheme, not a live feature, and is treated as a future upgrade path (see [12-open-questions.md](12-open-questions.md)).

## Security scan and fees

- **AgentGuard** (`agentguard scan contracts/src`, CLI 1.1.28, 24 Sep 2026): 4 findings, none a defect. One is the intended native-MON send helper on the money path (`lib/SafeTransferLib.sol`); three are in unmodified vendored OpenZeppelin files. Triage table: [SUBMISSION.md](SUBMISSION.md#security-scan-agentguard).
- **Fees:** the worst complete bidder journey costs 558,301 gas, $0.0014 on Monad mainnet at 102 gwei and MON $0.0252 (24 Sep 2026), against a $0.01 target. Table: [SUBMISSION.md](SUBMISSION.md#measured-cost).

## Files

| File | What it contains |
| --- | --- |
| [01-overview.md](01-overview.md) | The product in one sentence, what it does, and what the demo shows. |
| [02-problem.md](02-problem.md) | The FIFO allocation problem, who has it, existing solutions (Monad and Arbitrum), and our edge. |
| [03-architecture.md](03-architecture.md) | Components, how they connect, architecture diagram, external services, Arbitrum portability. |
| [04-flows.md](04-flows.md) | Bidder, creator, clearing, exit-auction and demo flows, each with a sequence diagram and failure cases. |
| [05-data-model.md](05-data-model.md) | Entities (Auction, Commitment, Bid, Deposit, Fill, LP seed) with fields and relations. |
| [06-api.md](06-api.md) | The engine's implemented contract interface, views and events, and the indexer's HTTP API. |
| [07-tech-stack.md](07-tech-stack.md) | Layer-by-layer choices, why, and the alternative passed on. |
| [08-ui-notes.md](08-ui-notes.md) | Screen-by-screen notes for creator, bidder and demo dashboards, each pointing to the file that builds it. |
| [09-resources.md](09-resources.md) | All links grouped by category. |
| [10-decisions.md](10-decisions.md) | Decisions in decision / rationale / trade-off format. |
| [11-roadmap.md](11-roadmap.md) | Task table in time blocks from 22 Sep to 13 Oct with priority and demo-required flag. |
| [12-open-questions.md](12-open-questions.md) | Unanswered questions, source contradictions, risks, assumptions. |

Also at the root: [DESIGN.md](DESIGN.md) (Even's design system), [PRODUCT.md](PRODUCT.md) (product record for design work), [AGENTS.md](AGENTS.md) (agent brief), [AUDIT.md](AUDIT.md) (two internal reviews and their fixes).

Related files: all of the above.
