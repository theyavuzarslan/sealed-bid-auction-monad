# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository state

Pre-code. The only file is `Monad Sealed-Bid Auction Engine.md`, the PRD for a Monad Metropolis hackathon submission (due 13 Oct 2026). There is no build, lint, or test tooling yet, so none is documented here. Add commands to this file when the toolchain is chosen.

The parent `/Users/0xatakan/CLAUDE.md` is the open-slide authoring guide. It applies to `slides/<id>/` decks only, not to this project.

## What is being built

One sealed-bid, uniform-clearing-price batch auction engine, shipped as two configured products (not two codebases):

- **Use case 1 (primary, Social/Attention/Culture track):** memecoin fair launch. Auction proceeds and remaining supply auto-seed a DEX pool with locked LP. The ICO/raise idea is a *preset* of this (long window, allowlist, vesting), not a separate submission.
- **Use case 2 (conditional, Onchain Finance track):** vault exit-priority auction, replacing FIFO redemption queues. It ships as its own submission only if use case 1 is complete by day 14 and multiple submissions are allowed. Otherwise it is a second preset inside one submission.

## Architecture

Per-round pipeline: **Commit → Reveal → Clear → Settle** (plus **Slash** for non-revealers, and **Seed LP** for use case 1).

- **Commit:** `keccak256(price, quantity, salt, msg.sender)` plus a *uniform* capped collateral deposit (a16z OverCollateralizedAuction pattern). The deposit must not scale with the bid, or it leaks the bid.
- **Clear/settle:** fork of Gnosis EasyAuction (LGPL-3.0, copyleft). Keep its logic unchanged, including partial fill at the marginal bid, the minimum bid size parameter, and multi-transaction settlement.
- **Hand-written, not forked:** the commit-reveal layer, deposit slashing, and LP auto-seed.

EasyAuction constraints that carry over: total bidding-token volume < 2^96, prices representable as uint96 fractions, and the minimum bid size is mandatory (it is the defense against gas-DoS from dust commits).

## Working rules from the PRD

- **Code-review boundary:** LLM-generated code is fine for frontend, indexer, demo harness, deploy scripts, fixtures, and docs. Anything between "bidder sends money" and "bidder gets tokens or refund" must be hand-written and reviewed line by line: commit hash construction, the clearing loop, settlement accounting, deposit slashing, LP seed.
- **Bugs to guard against on money paths:**
  1. Commit missing the salt.
  2. Commit not bound to `msg.sender`.
  3. Slashing accounting on non-reveal.
  4. Off-by-one at the marginal bid.
  5. Reentrancy on refund and claim.
  6. Gas DoS via dust commit spam.
  7. Sandwichable LP seed.
  8. `price × quantity` precision favoring the bidder.
- **No encrypted mempool.** Monad does not have one, and a contract cannot call BTX. Privacy comes from commit-reveal alone. Do not add it as a dependency. Treat it only as positioning ("when BTX lands, commit-reveal collapses to one transaction").
- **Claim wording:** say "snipe-resistant: submission timing no longer determines price", never "no sniping". Say "privacy via commit-reveal", not via an encrypted mempool. Post-clear transparency of bids is intentional.
- **Non-goals:** KYC, RWA, FHE/MPC/enclave/ZK, cross-chain, perpetual privacy of losing bids.
- **Budget target:** the full bidder journey (commit + reveal + claim) costs under $0.01 in network fees.
- **Pre-submission:** run `/agentguard scan` on the contracts and put the clean report in the README.
