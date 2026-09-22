# Task: scripts

Read `AGENTS.md` and `README.md` first. They are the contract for this repo.

## Scope
`contracts/script/`, `indexer/`

Deploy scripts for Monad testnet, plus an event indexer that decodes RoundOpened, Committed, Revealed, Cleared, Claimed, Slashed, LPSeeded (see `06-api.md`).

Also: a fee probe that measures commit + reveal + claim for one bidder and prints the total. The target is under $0.01.

## Rules
- Work ONLY in the paths listed above. Do not touch the 13 numbered .md files.
- If something is unspecified, make it a constructor parameter and name it in your final message. Do not guess.
- When done: run `forge build` (and `forge test` if you added tests), then summarise what you changed in 5 lines.
