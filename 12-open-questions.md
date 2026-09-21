# 12 — Open Questions

Unanswered questions, contradictions between sources, risks, and assumptions this documentation currently rests on.

Status: draft

## Contradictions between sources

| # | Topic | Source A | Source B | Resolution needed |
| --- | --- | --- | --- | --- |
| C1 | Build on BTX encrypted mempool? | Your note: "as monad stated they have new encrypted mempool btx, it is better if we can build using it." | PRD: "It does not exist on Monad and cannot be called from a contract in October" [src: Monad Sealed-Bid Auction Engine.md]. The ePrint is a scheme with a benchmark and "no mention of deployment" [src: https://eprint.iacr.org/2026/754]. Cadence post: benefits arrive "when fully implemented and released on Monad" [src: https://monad.xyz/blog/cadence-multiple-concurrent-proposers]. Live mempool docs contain no encryption [src: https://docs.monad.xyz/monad-arch/consensus/local-mempool]. | Docs currently follow the PRD: commit-reveal now, BTX as a swappable future sealing layer. Confirm you accept this, or point to a BTX testnet/API if one exists. |
| C2 | Monad block time / finality figures | PRD: ~800 ms finality, 500 ms blocks [src: Monad Sealed-Bid Auction Engine.md] | Cadence: 100 ms blocks, ~219 ms finality — planned, not live [src: https://monad.xyz/blog/cadence-multiple-concurrent-proposers] | Cite the live numbers in the write-up and Cadence as "coming". Verify the live numbers against current Monad docs. |
| C3 | "Day 14" gate for use case 2 | PRD: ships "if use case 1 is complete by day 14" [src: Monad Sealed-Bid Auction Engine.md] | Build window started 1 Sep [src: https://monad.xyz/developers/hackathons/metropolis]; PRD dated 22 Sep | Roadmap assumes day 14 from 22 Sep = 6 Oct. Confirm. |
| C4 | Multiple submissions allowed? | PRD conditions use case 2 on it [src: Monad Sealed-Bid Auction Engine.md] | Metropolis page: "no explicit rules prohibiting multiple track submissions" found [src: https://monad.xyz/developers/hackathons/metropolis] | Check hackathon.monad.xyz rules or ask organizers. |

## Unanswered product questions

| # | Question | Where it blocks |
| --- | --- | --- |
| Q1 | Where does slashed collateral go — creator, stayers, burn, treasury? | Deposit ledger, `slashUnrevealed`, pitch fairness story |
| Q2 | One commitment per address per round, or many? | Sealing layer storage, gas-DoS analysis |
| Q3 | How is minimum bid size enforced when price/quantity are hidden at commit? Reject at reveal (bidder then slashed?) or treat as non-reveal? | Sealing layer, bug #6 |
| Q4 | Which DEX and LP-lock contract on Monad, and lock duration? | LP seeder, roadmap Block A |
| Q5 | Sandwich mitigation for the first swap after LP seed (bug #7)? Options not in source. | LP seeder |
| Q6 | Which vault and asset for Exit-Priority; how is exit capacity per round set; who runs the keeper? | Exit adapter |
| Q7 | Raise preset: vesting schedule shape and allowlist format? | Preset config |
| Q8 | Salt backup UX — download file, encrypted localStorage, or wallet-signed derivation? | Bidder UI |
| Q9 | Bidding token: MON, a stable, or creator's choice? | Round params, fee measurement |
| Q10 | Demo baseline: live nad.fun or a local bonding-curve fork? | Demo harness |
| Q11 | Contract toolchain, frontend stack, wallet library, indexer? | Tech stack (all TODO) |
| Q12 | ~~Does `/agentguard scan` exist as a runnable tool?~~ **Resolved:** installed at `~/.hermes/plugins/agentguard` + `~/.hermes/skills/agentguard`. Still to confirm: exact invocation and where `web3-patterns.md` lives inside it. | Roadmap Block D |

## Arbitrum questions

| # | Question |
| --- | --- |
| A1 | Is Gnosis EasyAuction actually deployed on Arbitrum One? Not confirmed in sources; verify on Arbiscan before citing. |
| A2 | Does the Timeboost express lane's 200 ms head start let a bidder reliably buy the last-reveal position? If so, reveal windows on Arbitrum need a design change. |
| A3 | Actual commit + reveal + claim cost on Arbitrum including L1 data fees. |

## Risks

| # | Risk | Mitigation in plan |
| --- | --- | --- |
| R1 | Two-transaction flow loses impulse buyers (LBP precedent) [src: Monad Sealed-Bid Auction Engine.md] | Degen preset with minute-scale windows; prepared answer for judges |
| R2 | Slashing accounting strands funds (bug #3) | Ledger invariant + fuzz tests |
| R3 | Judges test the LP seed sandwich (bug #7) | Mitigation TBD (Q5); at minimum disclose |
| R4 | EasyAuction uint96 limits hit by a large raise | Document; acceptable for hackathon |
| R5 | LGPL copyleft surprises a later commercial partner | Disclose now; decide later [src: Monad Sealed-Bid Auction Engine.md] |
| R6 | Exit-Priority not finished by gate | Falls back to Vault preset inside one submission |
| R7 | Overclaiming privacy | Claims-to-avoid table enforced in UI and write-up |

## Assumptions

- Monad testnet is stable enough for the demo recording.
- Anyone can trigger settlement (EasyAuction pattern), so no keeper is needed for Fair Launch.
- Post-clear transparency of revealed bids is acceptable to creators.
- The Culture-track judges weigh the head-to-head demo more than contract review [src: Monad Sealed-Bid Auction Engine.md].

Related files: [02-problem.md](02-problem.md) · [03-architecture.md](03-architecture.md) · [06-api.md](06-api.md) · [10-decisions.md](10-decisions.md) · [11-roadmap.md](11-roadmap.md)
