# Task: core

Read `AGENTS.md` and `README.md` first. They are the contract for this repo.

## Scope
`contracts/src/SealingLayer.sol`, `contracts/src/DepositLedger.sol`

Implement commit/reveal and the deposit ledger per `04-flows.md` (Flows 2–3) and `06-api.md`.

- Preimage is exactly `keccak256(abi.encode(price, quantity, salt, msg.sender))`. All four fields.
- Deposits are a uniform capped amount, identical for every bidder. Reject any other value.
- Ledger invariant, assert it in tests: `locked == appliedToFill + refunded + slashed`.
- Slash destination is a constructor parameter. Do not pick one.
- This is money-path code. Small diffs, no cleverness, no unchecked blocks.

## Rules
- Work ONLY in the paths listed above. Do not touch the 13 numbered .md files.
- If something is unspecified, make it a constructor parameter and name it in your final message. Do not guess.
- When done: run `forge build` (and `forge test` if you added tests), then summarise what you changed in 5 lines.
