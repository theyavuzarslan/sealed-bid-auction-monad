# 11 — Roadmap

Task plan in time blocks from today (22 Sep 2026) to the 13 Oct submission, with priority and whether each item is required for the demo.

Status: draft

Dates: build window 1 Sep–13 Oct, judging 14–27 Oct, winners 3 Nov [src: https://monad.xyz/developers/hackathons/metropolis]. Three weeks remain. The PRD's "day 14" gate for use case 2 is ambiguous (day 14 of the build window was 14 Sep; day 14 from today is 6 Oct) — see [12-open-questions.md](12-open-questions.md). This plan uses **6 Oct** as the gate.

Priority: P0 = submission fails without it · P1 = needed for a strong submission · P2 = nice to have.

## Block A — 22–25 Sep: foundations

| Task | Owner type | Priority | Required for demo? |
| --- | --- | --- | --- |
| Pick contract toolchain, set up repo, CI, Monad testnet deploy script | Vibe | P0 | Yes |
| Fork EasyAuction; strip to clearing core; read the loop line by line [src: Monad Sealed-Bid Auction Engine.md] | Hand | P0 | Yes |
| Write sealing layer: `commit`, `reveal`, hash with salt + sender [src: Monad Sealed-Bid Auction Engine.md] | Hand | P0 | Yes |
| Write deposit ledger + `slashUnrevealed`; enforce `locked == fill + refund + slash` invariant | Hand | P0 | Yes |
| Unit tests: bugs #1, #2, #4, #6, #8 [src: Monad Sealed-Bid Auction Engine.md] | Vibe + Hand review | P0 | No |
| Choose DEX + LP-lock target on Monad | — | P0 | Yes |
| Confirm Metropolis multiple-submission rule on hackathon.monad.xyz | — | P1 | No |

## Block B — 26 Sep–1 Oct: Fair Launch end to end

| Task | Owner type | Priority | Required for demo? |
| --- | --- | --- | --- |
| LP seeder: pool creation + LP lock at settle; reentrancy guards on claim/refund (bug #5) | Hand | P0 | Yes |
| Sandwich mitigation for first swap after seed (bug #7) — TODO: pick approach | Hand | P1 | No |
| Preset config: Degen and Raise (allowlist root, vesting) | Vibe | P1 | Degen yes, Raise no |
| Bidder UI: round page, commit with salt storage, reveal, claim (Screens 2–3) | Vibe | P0 | Yes |
| Creator UI: open round (Screen 1) | Vibe | P1 | Yes |
| Indexer: decode events, commitment count, clearing price | Vibe | P1 | Yes |
| Measure commit + reveal + claim fee; target < $0.01 [src: Monad Sealed-Bid Auction Engine.md] | Vibe | P1 | Yes (shown on screen) |

## Block C — 2–6 Oct: demo harness and gate

| Task | Owner type | Priority | Required for demo? |
| --- | --- | --- | --- |
| Sniper bot + local bonding-curve baseline | Vibe | P0 | Yes |
| Head-to-head two-pane demo (Screen 4), 20-second cut [src: Monad Sealed-Bid Auction Engine.md] | Vibe | P0 | Yes |
| Fuzz/invariant tests on settlement accounting | Vibe + Hand review | P1 | No |
| **Gate (6 Oct):** Fair Launch complete? → decide Exit-Priority as submission vs preset [src: Monad Sealed-Bid Auction Engine.md] | — | P0 | — |
| Exit adapter + Vault preset (only if gate passes) | Hand | P2 | Only for use case 2 demo |
| Vault-run simulator, two panes (Screen 5) (only if gate passes) | Vibe | P2 | Only for use case 2 demo |

## Block D — 7–11 Oct: hardening and write-up

| Task | Owner type | Priority | Required for demo? |
| --- | --- | --- | --- |
| `/agentguard scan` on contracts; fix findings; put report in README [src: Monad Sealed-Bid Auction Engine.md] | Vibe + Hand | P0 | No |
| Threat-model section in write-up: no encrypted mempool, leader-set adversary, leaks, claims-to-avoid table [src: Monad Sealed-Bid Auction Engine.md] | Vibe | P0 | No |
| BTX positioning paragraph (future single-transaction path) | Vibe | P1 | No |
| LGPL disclosure for the EasyAuction fork | Vibe | P0 | No |
| Pitch deck; community-first positioning line [src: Monad Sealed-Bid Auction Engine.md] | Vibe | P0 | No |
| Prepare answer to "users won't wait two transactions" (LBP precedent) [src: Monad Sealed-Bid Auction Engine.md] | — | P1 | No |

## Block E — 12–13 Oct: submit

| Task | Owner type | Priority | Required for demo? |
| --- | --- | --- | --- |
| Record demo video; public project profile: demo, write-up, code link [src: https://monad.xyz/developers/hackathons/metropolis] | Vibe | P0 | Yes |
| Final testnet deploy, addresses in README | Vibe | P0 | Yes |
| Submit by 13 Oct | — | P0 | — |

## After the hackathon (not scheduled)

| Task | Priority |
| --- | --- |
| Arbitrum One deployment (engine is chain-agnostic; note Timeboost 200 ms express lane in reveal-window design) | P2 |
| Swap sealing layer to BTX when an encrypted mempool ships on Monad | P2 |
| Licensing decision on the LGPL fork before commercialization | P2 |
| Curator-mandate auction variant | P2 |

Related files: [01-overview.md](01-overview.md) · [04-flows.md](04-flows.md) · [07-tech-stack.md](07-tech-stack.md) · [10-decisions.md](10-decisions.md) · [12-open-questions.md](12-open-questions.md)
