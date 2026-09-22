# Task: settle

Read `AGENTS.md` and `README.md` first. They are the contract for this repo.

## Scope
`contracts/test/` — tests only, no source edits

Write Foundry tests against the eight bugs in `AGENTS.md`, prioritising 3, 4 and 8:
- slashing accounting strands no funds (fuzz the ledger invariant)
- marginal bid: over-allocation is insolvency, under-allocation strands tokens — test both directions at the boundary
- `price * quantity` truncation must never favour the bidder in aggregate
- reentrancy on claim and refund
- dust-commit spam cannot push settlement past the block gas limit

## Rules
- Work ONLY in the paths listed above. Do not touch the 13 numbered .md files.
- If something is unspecified, make it a constructor parameter and name it in your final message. Do not guess.
- When done: run `forge build` (and `forge test` if you added tests), then summarise what you changed in 5 lines.
