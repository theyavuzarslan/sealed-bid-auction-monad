# Task: fork

Read `AGENTS.md` and `README.md` first. They are the contract for this repo.

## Scope
`vendor/easyauction/` (read) → `contracts/src/ClearingCore.sol` (write)

Port EasyAuction's clearing loop. You have the context window to hold the whole contract — use it.

- Keep the logic identical: price ordering, volume accumulation to the sell amount, the crossing bid sets the uniform price, partial fill at the marginal bid, multi-transaction settlement.
- Keep the mandatory minimum bid size. It is the gas-DoS defence, not an option.
- Keep the LGPL-3.0 header.
- Write down every place the marginal-bid arithmetic could be off by one, as comments. That is the single highest-risk line in this repo.

## Rules
- Work ONLY in the paths listed above. Do not touch the 13 numbered .md files.
- If something is unspecified, make it a constructor parameter and name it in your final message. Do not guess.
- When done: run `forge build` (and `forge test` if you added tests), then summarise what you changed in 5 lines.
