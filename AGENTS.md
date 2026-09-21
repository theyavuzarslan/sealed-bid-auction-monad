# AGENTS.md — brief for every coding agent on this repo

Read this first. Then read `README.md`, which indexes 13 numbered docs that are the source of truth.

## What we are building

A sealed-bid, uniform-clearing-price batch auction on Monad, shipped as presets: **Fair Launch** (primary) and **Exit-Priority Auction** (conditional). Full spec in `01-overview.md`, `03-architecture.md`, `04-flows.md`, `06-api.md`.

## Hard rules

1. **Do not edit the 13 documentation files** (`README.md`, `01-`…`12-`). One author owns them. If you learn something that contradicts them, write it to `NOTES-<yourname>.md` instead and say so in your final message.
2. **Never invent an endpoint, field, or component.** If the docs do not specify it, implement the minimum and leave `// TODO: not specified` with the question.
3. **Terminology is fixed.** Use: round, sealing layer, clearing core, deposit ledger, LP seeder, exit adapter, commit window, reveal window, clearing price. Never introduce a second name for the same thing.
4. **Money-path boundary.** Anything between "bidder sends money" and "bidder gets tokens or a refund" is hand-written and human-reviewed: commit hash construction, clearing loop, settlement accounting, deposit slashing, LP seed. If your task is not in that list, you are on the vibe-code side — move fast. If it is, write small diffs and stop for review.

## The eight bugs — do not write these

Ranked by how likely an LLM is to write them here (`04-flows.md`, Flow 4):

1. Commit without a salt. The preimage is `(price, quantity, salt, msg.sender)` — all four.
2. Commit not bound to `msg.sender` → replay and reveal front-running.
3. Slashing accounting on non-reveal. Invariant: `locked == appliedToFill + refunded + slashed`.
4. Off-by-one at the marginal bid. Over-allocate → insolvent; under-allocate → tokens stuck.
5. Reentrancy on refund and claim.
6. Gas DoS via dust commit spam. Keep EasyAuction's minimum bid size; it is mandatory.
7. Sandwichable LP seed (first swap after seeding).
8. Precision on `price × quantity` truncating in the bidder's favor.

## Inherited constraints (EasyAuction fork, LGPL-3.0)

Total bidding-token volume < 2^96. Prices are uint96 fractions. Settlement may span multiple transactions. Keep the LGPL notice.

## Language rules for any user-facing string

| Never write | Write instead |
| --- | --- |
| "No sniping" | "Snipe-resistant: submission timing no longer determines price" |
| "Privacy via encrypted mempool" | "Privacy via commit-reveal" |
| "Losing bids are never revealed" | "Post-clear transparency is intentional" |

There is no encrypted mempool on Monad. BTX is a research paper. Do not reference it as a live dependency.

## Open items you may hit

Listed in `12-open-questions.md`. Do not resolve them by guessing — make them constructor parameters or config, and name them in your final message.
