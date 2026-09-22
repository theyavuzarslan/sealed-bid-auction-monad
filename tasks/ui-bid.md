# Task: ui-bid

Read `AGENTS.md`, `08-ui-notes.md` and `10-decisions.md` #22 first. Ship together with `tasks/clearing.md`: both sides change the meaning of the committed fields.

## Scope
`web/` on branch `agent/ui`.

## Changes
- The bid form has two inputs: **Max price per token** (MON, decimal; snaps to the round's `tickSize`) and **Token amount** (decimal).
- Convert both to 18-decimal integers. `price` = MON wei per 1e18 token units; `amount` = token units.
- Show the **max spend** = `ceil(price × amount / 1e18)`, rounded **up** to match the contract. Block the commit if `maxSpend < minBidSize` or `maxSpend ≥ deposit`, and say which.
- Under the form, in these words: *"You pay the clearing price for every token you win and get the difference back. If many bids land exactly on the clearing price, they share what is left in proportion to size."*
- The preimage keeps its shape: `keccak256(abi.encode(price, amount, salt, msg.sender))`. Rename `quantity` to `amount` everywhere, including the stored bid and the reveal screen.
- After settlement: show the clearing price, your allocation, what you paid and your refund. If the LP is not yet seeded, show a **Seed liquidity** button (anyone can call `seedLP`) instead of Claim.
- Delete the "Raw uint96 value" hint.
- `selftest.mjs`: add cases for max-spend rounding up and for both blocking conditions.

## Bid recovery (decision 33)

- **Key:** sign EIP-712 typed data — domain `{name: "SealedBidAuction", version: "1", chainId, verifyingContract: engine}`, message `{roundId, purpose: "bid-backup"}`. Key = HKDF-SHA256 over `keccak256(signature)`.
- **Note:** AES-GCM (WebCrypto) over `(price, amount, salt)`, padded to a fixed length so every note is the same size. Pass it as `commit`'s `note`.
- **Determinism check**, first use per wallet: sign twice. If the signatures differ, turn on-chain recovery off for that wallet (send an empty `note`) and require the backup-file download before the commit button enables. Remember the result per wallet in localStorage.
- **Also** save the bid in localStorage and offer the backup file for every wallet.
- **Reveal:** use localStorage if present. Otherwise re-sign, fetch this bidder's `Committed` event, decrypt the note, then **recompute the hash and compare it with the stored commitment before sending the reveal.** If it doesn't match, say so and ask for the backup file.
- Plain copy on the commit screen: *"Your bid is sealed. Reveal it in the reveal window or your deposit is burned. You can reveal from any device with this wallet."* Drop the last sentence for wallets that failed the determinism check.
- `selftest.mjs`: encrypt/decrypt round trip; notes are all the same length; a tampered note fails to decrypt.

Wording rules in `AGENTS.md` still apply.
