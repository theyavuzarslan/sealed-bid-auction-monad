# 11 — Roadmap

Task plan in time blocks from today (22 Sep 2026) to the 13 Oct submission, with priority and whether each item is required for the demo.

Status: draft

Dates: build window 1 Sep–13 Oct, judging 14–27 Oct, winners 3 Nov [src: https://monad.xyz/developers/hackathons/metropolis]. Three weeks remain. The PRD's "day 14" gate for use case 2 is ambiguous (day 14 of the build window was 14 Sep; day 14 from today is 6 Oct) — see [12-open-questions.md](12-open-questions.md). This plan uses **6 Oct** as the gate.

**Status at 22 Sep:** Block A contracts are written and green (commit/reveal, deposit ledger, clearing core, integration engine), but three critical access-control bugs block any deploy — see [AUDIT.md](AUDIT.md). The token leg, LP seed and real-engine demo (Blocks B–C) are not done. On 22 Sep the clearing design moved to Zama-style (decision 22); run order: `tasks/fix-core.md` → `tasks/clearing.md` + `tasks/ui-bid.md` → `tasks/lp.md`. Most agent work is still uncommitted in worktrees.

## Against the Metropolis criteria (4 Oct, 9 days left)

Metropolis publishes no weighted rubric. Everything below is what the official page says, checked against the raw HTML of https://monad.xyz/developers/hackathons/metropolis on 4 Oct; the official rules and the full bounty criteria sit behind the login at hackathon.monad.xyz and were not readable here.

| Published criterion | Where we stand | Gap |
| --- | --- | --- |
| "A working product with a public project profile: a demo, a short write-up, and a link to the code" | Working product on a local chain and on Vercel (https://even-monad.vercel.app); write-up in [SUBMISSION.md](SUBMISSION.md); video script written | Not on mainnet yet; no video; no project profile; repo is private |
| "Judges need to be able to verify what you built during the six weeks" | Full history in git from 22 Sep; 102 contract + 19 fork tests; PRD conformance matrix | Repo must be public or judges given access. Pre-window third-party code (`vendor/easyauction`, a reference copy never compiled) removed 4 Oct |
| "What you show on 13 Oct should have been built during the six weeks" | All contracts, web, indexer, demo written 22 Sep onwards | — |
| Social, Attention & Culture, "Best fit for: teams who have grown a community, not only built one" | No community or real users yet | **The biggest gap.** Evidence of real people using it: one real mainnet round with real bidders, its numbers in the write-up |
| Track examples ("markets on cultural outcomes", "how communities create and capture value") | Fair launches where a community buys its own token at one price | Write-up should lead with the community story, not the mechanism |
| Judged per track by founders and VCs (Monad co-founders, Galaxy, Electric Capital, Nansen …) | Write-up is thorough and technical | Lead with the problem and the head-to-head numbers; keep the mechanism for later sections |
| Sponsor bounties (titles only on the public page) | Possible fits: Mera (two Monad Foundation bounties, $2,500 each), Envio, Nansen, Privy/Dynamic | Read each bounty's criteria on the platform before claiming eligibility |

Other tracks for comparison: Onchain Finance & Trading is "best fit for teams who have shipped a trading, lending, or market-making product before"; Consumer Products & Payments for "product teams who care more about a user's first five minutes"; Trust, Identity & AI for "teams comfortable with cryptography, protocol design, or agent frameworks", with passkey-native accounts as an example idea.

### Plan for the last 9 days, in order

| # | Task | Owner | Blocks submission? |
| --- | --- | --- | --- |
| 1 | Code link judges can open (make the repo public, or add judge access) | User | Yes |
| 2 | Mainnet deploy, then one real round with real bidders; link it in SUBMISSION.md | User funds the burner; Claude runs the deploy | Yes, for credibility and the community criterion |
| 3 | Demo video and public project profile; write-up leads with problem and numbers | User records; Claude edits the write-up | Yes |
| 4 | ~~Mera passkey sign-in as an extra wallet option~~ **Done 4 Oct** (decision 36); real-device test pending | Claude, then user on a phone | No |
| 5 | Pitch deck, if the profile asks for one | Claude | No |

**Status at 24 Sep:** Blocks A–C are done, and the AgentGuard scan, threat model, BTX paragraph, two-transaction answer and fee measurement from Block D are done too (in [SUBMISSION.md](SUBMISSION.md)). The audit blockers are fixed ([AUDIT.md](AUDIT.md)). Left: the pitch deck, a public-network deploy, the demo video, and confirming whether multiple submissions are allowed. The tables below are the original plan, kept for the record.

Priority: P0 = submission fails without it · P1 = needed for a strong submission · P2 = nice to have.

## Block A — 22–25 Sep: foundations

| Task | Owner type | Priority | Required for demo? |
| --- | --- | --- | --- |
| Pick contract toolchain, set up repo, CI, Monad testnet deploy script | Vibe | P0 | Yes |
| ~~Fork EasyAuction; strip to clearing core~~ Done, then **superseded 22 Sep** by Zama-style clearing (decision 22) | Hand | — | — |
| Zama-style clearing inside the engine — `tasks/clearing.md` | Hand | P0 | Yes |
| Write sealing layer: `commit`, `reveal`, hash with salt + sender [src: Monad Sealed-Bid Auction Engine.md] | Hand | P0 | Yes |
| Write deposit ledger + `slashUnrevealed`; enforce `locked == fill + refund + slash` invariant | Hand | P0 | Yes |
| Unit tests: bugs #1, #2, #4, #6, #8 [src: Monad Sealed-Bid Auction Engine.md] | Vibe + Hand review | P0 | No |
| ~~Choose DEX + LP-lock target on Monad~~ **Done 22 Sep:** Uniswap v3 adapter (built) and PancakeSwap v3 (planned, not built), GoPlus SafeToken Locker | — | P0 | Yes |
| Confirm Metropolis multiple-submission rule on hackathon.monad.xyz | — | P1 | No |

## Block B — 26 Sep–1 Oct: Fair Launch end to end

| Task | Owner type | Priority | Required for demo? |
| --- | --- | --- | --- |
| LP seeder: pool creation + LP lock at settle; reentrancy guards on claim/refund (bug #5) | Hand | P0 | Yes |
| Sandwich mitigation for first swap after seed (bug #7) — TODO: pick approach | Hand | P1 | No |
| Preset config: Degen now; Raise allowlist + vesting via `tasks/raise.md` | Hand | P1 | Degen yes, Raise no |
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
| Exit adapter + demo vault — `tasks/exit.md` (only if gate passes) | Hand | P2 | Only for use case 2 demo |
| Vault-run simulator, two panes (Screen 5) (only if gate passes) | Vibe | P2 | Only for use case 2 demo |

## Block D — 7–11 Oct: hardening and write-up

| Task | Owner type | Priority | Required for demo? |
| --- | --- | --- | --- |
| `/agentguard scan` on contracts; fix findings; put report in README [src: Monad Sealed-Bid Auction Engine.md] | Vibe + Hand | P0 | No |
| Threat-model section in write-up: no encrypted mempool, leader-set adversary, leaks, claims-to-avoid table [src: Monad Sealed-Bid Auction Engine.md] | Vibe | P0 | No |
| BTX positioning paragraph (future single-transaction path) | Vibe | P1 | No |
| LGPL disclosure — only if any EasyAuction code remains after `tasks/clearing.md` | Vibe | P2 | No |
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
