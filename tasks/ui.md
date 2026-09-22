# Task: ui

Read `AGENTS.md` and `README.md` first. They are the contract for this repo.

## Scope
`web/`

Build the bidder and creator screens from `08-ui-notes.md`. Screens 1, 2, 3.

- The salt is generated client-side and must survive a page reload. Offer a download-backup.
- Show commitment COUNT and timing (intentionally public). Never show revealed prices before clearing.
- Copy the wording table in `AGENTS.md` exactly. Writing "no sniping" anywhere is a bug.

## Rules
- Work ONLY in the paths listed above. Do not touch the 13 numbered .md files.
- If something is unspecified, make it a constructor parameter and name it in your final message. Do not guess.
- When done: run `forge build` (and `forge test` if you added tests), then summarise what you changed in 5 lines.
