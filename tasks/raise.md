# Task: raise

Read `AGENTS.md` and `10-decisions.md` #29 and #32 first. Money-path work, **P1**: the Raise preset is not in the demo. Start after `tasks/lp.md` lands.

## Scope
Branch `agent/fork`: `contracts/src/AuctionEngine.sol`, `contracts/test/`. Frontend parts on `agent/ui`: `web/`.

## Allowlist (decision 32)
- The Merkle check itself lands in `tasks/fix-core.md` step 6. Here: `openRound` accepts an `allowlistURI` string (HTTPS or IPFS link to the tree dump) and emits it in `RoundOpened`. Do not store it.
- Creator screen: upload a CSV of addresses; build an OpenZeppelin `StandardMerkleTree` with leaf type `["address"]`; show the root and a downloadable tree JSON to host at the URI. Vendor the library the way `js-sha3` is vendored, or hand-write it; add no npm dependency to `web/`.
- Bidder screen: load the tree from `allowlistURI`, find the connected wallet's proof, and pass it to `commit`. If the wallet is not in the tree, say so before the bidder signs anything.

## Vesting (decision 32)
- `openRound` takes `tgeBps`, `cliff` and `vestDuration`. They must be zero for Degen. For Raise: `tgeBps ≤ 10000`, and `vestDuration == 0` requires `tgeBps == 10000`.
- `claim` on a Raise round pays `allocated × tgeBps / 10000` tokens now (rounded down) and records the schedule, starting at settlement time.
- `claimVested(roundId)` pays `vested(now) − alreadyPaid`, where `vested(t) = tge + (allocated − tge) × clamp((t − start − cliff) / vestDuration, 0, 1)`, rounded down.
- MON refunds are unaffected: the full refund is paid at `claim`.

## Raise LP and leftovers
- LP is optional (`autoLP`). When on, the lock owner is the creator and `endTime` is the creator's unlock date, which must be after settlement (decision 28).
- Unsold supply goes back to the creator (decision 29), through `_disposeUnsold` from `tasks/lp.md`.

## Tests (P0 within this task)
- Vested amount never exceeds `allocated`, never decreases, and equals `allocated` after `start + cliff + vestDuration`.
- Nothing vests before the cliff beyond the TGE amount.
- A bidder not in the allowlist cannot commit; one in it can; a proof for a different address fails.
- The sum of TGE payouts plus all vested payouts equals the sum of allocations, to within one unit per bidder.

When done: `forge build && forge test`, then list every changed function in 5 lines.
