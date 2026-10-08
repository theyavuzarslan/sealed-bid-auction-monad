# Contracts v2 (branch `contracts-v2`, not deployed)

The live Monad mainnet deployment is v1, tagged `mainnet-v1`. v2 fixes four items found in review. Every change is covered by tests; external function signatures and events of v1 are unchanged, and v2 only adds new ones.

| # | Change | Why | Files |
|---|---|---|---|
| 1 | **Minimum windows.** `MIN_COMMIT_WINDOW` and `MIN_REVEAL_WINDOW` are 5 minutes each. `openRound` reverts with "commit window too short" or "reveal window too short"; the `ExitAuction` constructor with "window too short" (replaces "bad windows" / "zero window"). | Without a floor, a creator could open a round with a reveal window of a few seconds; honest bidders would miss it and their deposits would be burned. Monad has ~300 ms blocks with one-second timestamps. | SealingLayer, AuctionEngine, ExitAuction; web/js/launch.js checks the same minimum before signing |
| 2 | **O1: refunds no longer revert.** A refund is pushed with a fixed 50,000-gas stipend and no copied return data. If the push fails, it is recorded in `refundsOwed[bidder]` and `totalOwed`, with a `RefundOwed` event. The bidder collects with `withdrawOwed(to)` to any address (`OwedWithdrawn` event). | A bidder contract that rejected MON, or burned gas on receive, could never be settled; that also blocked the creator's share of its payment and the dust sweep. Now the round settles either way. Engine MON = Σ `roundBalance` + `totalOwed`. | DepositLedger (`_pushRefund`, `withdrawOwed`), AuctionEngine and ExitAuction refunds |
| 3 | **ExitAuction redeem.** `require(got >= assets, "redeem short")` replaces `got == assets`; any surplus goes to the vault with the donation. | ERC-4626 only guarantees `previewRedeem ≤ redeem`; strict equality would block exits on vaults other than DemoVault. | ExitAuction |
| 4 | **Compiler.** `pragma solidity 0.8.34;` on every contract in `src` (vendored OpenZeppelin unchanged), `solc_version = "0.8.34"`. | 0.8.34 fixes the transient-storage clearing bug (v1 is not affected: it never uses `delete` on transient state). One exact compiler for every deployed contract. | src/*.sol, foundry.toml |

Tests: 108 passed, 0 failed (`forge test`), including new `test/Observations.t.sol` (a MON-rejecting winner and a gas-burning winner both settle, are owed, and withdraw; normal refunds are still pushed; short windows are refused) and `test_Constructor_RejectsShortWindows` / an updated `test_ExitIndependentOfRefund` in `test/ExitAuction.t.sol`. The full security pass (mutation testing, symbolic proofs, scale test, Monad rules) runs once v2 is final.

## Independent review (Codex, gpt-5.5, read-only)

Verdict: no significant issues. No reentrancy path through `_pushRefund`, `withdrawOwed` or the claim paths; no double-counted or twice-withdrawable MON across `roundBalance`, `totalOwed` and `refundsOwed`; the assembly call is correct; the exit-auction surplus goes to the vault. Its four low/info findings:

1. **Fixed.** An `ExitAuction` window near `uint64` max would wrap the stored round end. The constructor now also refuses windows over `MAX_EXIT_WINDOW` (30 days), "window too long"; tested.
2. **Accepted.** A bidder contract that burns the 50,000-gas stipend makes a third party who claims for it pay that gas (about 0.005 MON on Monad). Bounded, and it cannot block settlement.
3. **Documented.** A bidder contract that rejects MON must be able to call `withdrawOwed(to)` to collect; a contract with neither cannot recover its refund. Ordinary wallets and passkey accounts are unaffected.
4. **Fixed in the app.** "Settled" no longer implies "MON received": the round page reads `refundsOwed` and shows "Withdraw owed refund" when anything is owed.

Not in v2 (after the hackathon): time-locked auto-reveal (`revealFor`), custom errors, event tweaks (CODE-QUALITY.md P1, P2, P5).

Deploying v2 means a new engine address; round 1 stays on the v1 engine and stays visible on the explorer.
