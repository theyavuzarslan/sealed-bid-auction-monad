# Task: fix-core

Read `AGENTS.md`, `README.md` and `AUDIT.md` first. This is money-path work: small diffs, and stop for review after each numbered step.

## Scope
Branch `agent/fork`. Files: `contracts/src/AuctionEngine.sol`, `contracts/src/SealingLayer.sol`, `contracts/test/`.

Run this first. `tasks/clearing.md` builds on it and replaces `ClearingCore`, so don't patch `ClearingCore` here.

## Steps (P0)

1. **Move the test harness out of production source (AUDIT M1).** Delete `SealingLayerTest` and the `forge-std` import from `src/SealingLayer.sol`. Recreate it in `test/SealingLayer.t.sol` as a harness contract that inherits `SealingLayer`.
2. **Native MON only (AUDIT H3).** `openRound` requires `biddingToken == address(0)`.
3. **Token custody (AUDIT H1).** `openRound` pulls `sellAmount` plus the LP reserve (`sellAmount × lpShareBps / 10000`; 0 until `tasks/lp.md` lands) from the creator with `transferFrom`, and reverts if it can't. `claim` transfers the bidder's tokens instead of only recording `fillEntitlement`. Checks-effects-interactions; the reentrancy guard already exists.
4. **Rename `quantity` to `amount`** in `SealingLayer` and `AuctionEngine`, including the `Revealed` event. The preimage keeps its shape: `keccak256(abi.encode(price, amount, salt, msg.sender))`.
5. **Burn non-revealers' deposits (decision 30).** Delete `slashUnrevealed(bidders[])` and `slashDestination`. Track `commitCount` and `revealedCount` per round. Add `burnUnrevealed(roundId)`: callable by anyone after `revealEnd`; sends `(commitCount − revealedCount) × depositAmount − alreadyBurned` to `0x000000000000000000000000000000000000dEaD`. O(1): no loop. Rename the ledger field `slashed` to `burned`; the invariant becomes `locked == appliedToFill + refunded + burned`. Test that calling it twice burns nothing extra, and that a revealed bidder's deposit is never burned.
6. **New `commit` arguments (decisions 32–33).** `commit(roundId, hash, bytes32[] calldata proof, bytes calldata note)`.
   - `proof`: when the round's `allowlistRoot` is non-zero, verify `msg.sender` against it; leaf `keccak256(bytes.concat(keccak256(abi.encode(msg.sender))))`, OpenZeppelin `StandardMerkleTree` format. Hand-write the ~20-line verifier or vendor OpenZeppelin's `MerkleProof`; do not add other dependencies.
   - `note`: emit it in `Committed(roundId, bidder, hash, note)`. **Never write it to storage.** Cap its length (for example 256 bytes) so it cannot be used to bloat events.

When done: `forge build && forge test`, then list every changed function in 5 lines.
