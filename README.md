# Sealed-Bid Auction Engine on Monad

Documentation index for the Monad Metropolis hackathon submission (deadline 13 Oct 2026).

Status: draft

## Summary

- One sealed-bid, uniform-clearing-price batch auction engine on Monad, shipped as configured presets rather than separate codebases [src: Monad Sealed-Bid Auction Engine.md].
- Bidders commit a hash plus a uniform collateral deposit, reveal later, and everyone who clears pays the same price; non-revealers are slashed [src: Monad Sealed-Bid Auction Engine.md].
- Clearing is Zama-style: a bid is a price per token plus a token amount; winners pay the clearing price, bids at the clearing price share pro-rata, and overpayment is refunded [src: https://docs.zama.org/auction/how-it-works]. It replaced the original EasyAuction fork on 22 Sep (decision 22).
- Use case 1 (primary): memecoin **Fair Launch** for the Social, Attention & Culture track. Use case 2 (conditional): vault **Exit-Priority Auction** for the Onchain Finance & Trading track [src: Monad Sealed-Bid Auction Engine.md].
- Privacy comes from commit-reveal alone today; Monad's BTX encrypted mempool is a research scheme, not a live feature, and is treated as a future upgrade path (see [12-open-questions.md](12-open-questions.md)).

## Files

| File | What it contains |
| --- | --- |
| [01-overview.md](01-overview.md) | The product in one sentence, what it does, and what the demo shows. |
| [02-problem.md](02-problem.md) | The FIFO allocation problem, who has it, existing solutions (Monad and Arbitrum), and our edge. |
| [03-architecture.md](03-architecture.md) | Components, how they connect, architecture diagram, external services, Arbitrum portability. |
| [04-flows.md](04-flows.md) | Bidder, creator, clearing, exit-auction and demo flows, each with a sequence diagram and failure cases. |
| [05-data-model.md](05-data-model.md) | Entities (Auction, Commitment, Bid, Deposit, Fill, LP seed) with fields and relations. |
| [06-api.md](06-api.md) | Contract interface surface derived from the PRD phases; HTTP API marked TODO. |
| [07-tech-stack.md](07-tech-stack.md) | Layer-by-layer choices, why, and the alternative passed on. |
| [08-ui-notes.md](08-ui-notes.md) | Screen-by-screen notes for creator, bidder and demo dashboards; HTML snippets TODO. |
| [09-resources.md](09-resources.md) | All links grouped by category. |
| [10-decisions.md](10-decisions.md) | Decisions in decision / rationale / trade-off format. |
| [11-roadmap.md](11-roadmap.md) | Task table in time blocks from 22 Sep to 13 Oct with priority and demo-required flag. |
| [12-open-questions.md](12-open-questions.md) | Unanswered questions, source contradictions, risks, assumptions. |

Related files: all of the above.
