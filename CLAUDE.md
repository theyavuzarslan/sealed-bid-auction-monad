# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository state

Hackathon build for Monad Metropolis (submission 13 Oct 2026). The PRD is `Monad Sealed-Bid Auction Engine.md`; the 13 numbered docs plus `README.md` are the synthesized spec, `AUDIT.md` the security findings and their status. The parent `/Users/0xatakan/CLAUDE.md` is an open-slide guide and does not apply here.

Everything is built on `master` in this directory. The herdr multi-agent setup (`run.sh`, `setup.sh`, the `sba-agents/` worktrees, `agent/*` branches) is retired; the branches are kept only as history. `archive/master-stray` holds stray files found untracked on master.

Layout: `contracts/` (Foundry: engine, clearing, sealing, adapters, tests, scripts), `web/` (static ES-module frontend, no build step), `indexer/` (Node), `demo/` (separate Foundry project + static page), `tasks/` (implementation briefs).

## Commands

Foundry lives in `~/.foundry/bin`; add it to `PATH` if `forge` is missing. Run contract commands from `contracts/`.

```bash
forge build
forge test
forge test --match-test test_Degen_OversubscribedLifecycle -vvv
FOUNDRY_PROFILE=deep forge test --match-test testFuzz
forge script script/DeployLocal.s.sol --rpc-url http://127.0.0.1:8545 --broadcast
```

`DeployLocal` needs a running `anvil`; it deploys the engine with mocks and writes `contracts/deployments/local.json`. The demo is a separate Foundry project: `cd demo && forge test`.

## Code map

- `contracts/src/UniformClearing.sol` — generic clearing: a descending linked list of price levels; pro-rata at the clearing price; settlement resumable across transactions. Knows nothing about MON.
- `contracts/src/SealingLayer.sol` + `DepositLedger.sol` — commit/reveal, allowlist proof, note event, uniform deposits, O(1) burn of unrevealed deposits, per-round `roundBalance`.
- `contracts/src/AuctionEngine.sol` — the launch product: presets, payments and refunds, LP seeding through allow-listed adapters, GoPlus lock, unsold disposal, vesting, the grace escape.
- `contracts/test/mocks/Mocks.sol` — token, position manager, adapter and locker mocks, also used by `DeployLocal`.

## What is being built

One sealed-bid, uniform-clearing-price batch auction engine, shipped as two configured products (not two codebases):

- **Use case 1 (primary, Social/Attention/Culture track):** memecoin fair launch. Auction proceeds and remaining supply auto-seed a DEX pool with locked LP. The ICO/raise idea is a *preset* of this (long window, allowlist, vesting), not a separate submission.
- **Use case 2 (conditional, Onchain Finance track):** vault exit-priority auction, replacing FIFO redemption queues. It ships as its own submission only if use case 1 is complete by day 14 and multiple submissions are allowed. Otherwise it is a second preset inside one submission.

## Architecture

Per-round pipeline: **Commit → Reveal → Clear → Settle** (plus **Slash** for non-revealers, whose deposits are burned, and **Seed LP** for use case 1).

- **Commit:** `keccak256(price, amount, salt, msg.sender)` plus a *uniform* capped collateral deposit (a16z OverCollateralizedAuction pattern). The deposit must not scale with the bid, or it leaks the bid.
- **Clear/settle:** Zama-style uniform-price clearing (decision 22, 22 Sep), replacing the original EasyAuction fork. A bid is a price per token plus a token amount. Bids above the clearing price get their full amount, bids at it share pro-rata, everyone pays the clearing price and the overpayment is refunded. It is an internal contract inherited by the engine, so nothing can call clearing around the engine. Rounding rules are in `tasks/clearing.md`.
- **Seed LP:** sized from the result (`lpShareBps` of tokens sold and of MON raised, so the two sides already match the clearing price), seeded before any claim, and locked in the GoPlus `UniV3LPLocker` — permanent for Degen, creator-chosen for Raise. Unsold supply is burned (Degen) or returned to the creator (Raise). See `04-flows.md` Flow 8.
- **Everything on the money path is hand-written:** commit-reveal, clearing, the deposit ledger and slashing, LP seed.

Constraints: amounts are `uint96`, prices sit on a per-round tick grid, and the minimum bid size is mandatory (it is the defense against gas DoS from dust commits).

Implementation briefs for pending work live in `tasks/` (`fix-core`, `clearing`, `ui-bid`, `lp`, then `raise` and `exit`).

## Working rules from the PRD

- **Code-review boundary:** LLM-generated code is fine for frontend, indexer, demo harness, deploy scripts, fixtures, and docs. Anything between "bidder sends money" and "bidder gets tokens or refund" must be hand-written and reviewed line by line: commit hash construction, the clearing loop, settlement accounting, deposit slashing, LP seed.
- **Bugs to guard against on money paths:**
  1. Commit missing the salt.
  2. Commit not bound to `msg.sender`.
  3. Slashing accounting on non-reveal.
  4. Off-by-one at the clearing price (pro-rata rounds down, payments round up).
  5. Reentrancy on refund and claim.
  6. Gas DoS via dust commit spam.
  7. Sandwichable LP seed.
  8. `price × amount` precision favoring the bidder.
- **No encrypted mempool.** Monad does not have one, and a contract cannot call BTX. Privacy comes from commit-reveal alone. Do not add it as a dependency. Treat it only as positioning ("when BTX lands, commit-reveal collapses to one transaction").
- **Claim wording:** say "snipe-resistant: submission timing no longer determines price", never "no sniping". Say "privacy via commit-reveal", not via an encrypted mempool. Post-clear transparency of bids is intentional.
- **Non-goals:** KYC, RWA, FHE/MPC/enclave/ZK, cross-chain, perpetual privacy of losing bids.
- **Budget target:** the full bidder journey (commit + reveal + claim) costs under $0.01 in network fees.
- **Pre-submission:** run `/agentguard scan` on the contracts and put the clean report in the README.
