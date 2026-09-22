# Task: exit

**Gated.** Start only if the 6 Oct gate in `11-roadmap.md` passes (Fair Launch complete). Read `AGENTS.md`, `04-flows.md` Flow 5, and `10-decisions.md` #30–31 first. Money-path work, P2.

## Scope
Branch `agent/core`. Its uncommitted `ExitAdapter.sol` was written for the old EasyAuction design: replace it rather than patch it. New `contracts/src/exit/`, `contracts/test/`.

## Architecture — one engine, two front doors
"One engine" means shared modules, not one contract. The launch product is `AuctionEngine`. The exit product is a second concrete contract, `ExitAuction`, built from the same pieces: `SealingLayer` + `DepositLedger` + `UniformClearing`. The clearing is reused **unchanged**: price = discount in bps, amount = shares, supply = exit capacity.

## Demo vault (decision 31)
- `DemoVault`: ERC-4626 over WMON (`0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A` on Monad; a mock WMON in tests).
- Vendor OpenZeppelin's `ERC4626` (MIT) into `contracts/src/vendor/`. Don't hand-write share math.
- An idle buffer (WMON held by the vault) and a simulated illiquid "strategy" bucket that the harness moves assets into and out of. `totalAssets` counts both.

## ExitAuction
- `openExitRound()`: anyone, once the previous round has settled and `N` blocks have passed (`N` is a constructor param). Capacity = `min(convertToShares(idle buffer), maxExitSharesPerRound)`, fixed now; revert if zero.
- `commit`: same as the launch — uniform MON deposit, hash, proof, note.
- `reveal(roundId, discountBps, shares, salt)`: verify the hash, then `transferFrom` the shares into escrow. Discount on a tick grid, `0 ≤ discountBps < 10000`.
- `settle`: `UniformClearing` as-is. The clearing discount P is the lowest winning discount; bids at P share pro-rata.
- `claim`, for winners: redeem `allocated` shares for assets A; send `A × (10000 − P) / 10000` (rounded down) to the holder; transfer the remainder **directly to the vault**. That is a donation: it raises the share price for everyone who stayed, and mints no shares. Unfilled shares and the MON deposit go back to the bidder.
- Non-revealers: `burnUnrevealed`, same as the launch (decision 30).

## Tests (P0 within this task)
- Holders who stay see their share price rise by exactly the donated amount (to within rounding) after every round.
- Winners receive `assets × (1 − P)`; nobody exits above capacity; losers get all their shares back.
- `openExitRound` reverts before `N` blocks, while a round is unsettled, and when the buffer is empty.
- A reveal without enough shares reverts, and that deposit is later burnable.

## Demo harness (vibe side, after the contracts)
Screen 5 in `08-ui-notes.md`: the same run simulated twice. The left pane shows a FIFO queue — it lengthens, the price depegs, latecomers get nothing. The right pane shows `ExitAuction` rounds clearing at a widening discount while the stayers' share price rises.

When done: `forge build && forge test`, then list every changed function in 5 lines.
