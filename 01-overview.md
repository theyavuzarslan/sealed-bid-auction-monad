# 01 — Overview

What the Sealed-Bid Auction Engine is, what it does, and what we show on demo day.

Status: draft

## One sentence

A sealed-bid, uniform-price batch auction on Monad that replaces first-come-first-served allocation with blind bids that all clear at one price [src: Monad Sealed-Bid Auction Engine.md].

## What it does

- **Commit.** A bidder posts `keccak256(price, quantity, salt, msg.sender)` plus a uniform capped collateral deposit [src: Monad Sealed-Bid Auction Engine.md].
- **Reveal.** The bidder opens the commitment with price and salt. Non-revealers are slashed [src: Monad Sealed-Bid Auction Engine.md].
- **Clear.** Bids rank by price, volume accumulates to the sell amount, the crossing bid sets the uniform price. Bids at or above it fill; the rest refund [src: Monad Sealed-Bid Auction Engine.md].
- **Settle.** Fills, refunds, and slashes are paid out; for Fair Launch, proceeds plus remaining supply auto-seed a DEX pool with locked LP [src: Monad Sealed-Bid Auction Engine.md].

One engine, three presets [src: Monad Sealed-Bid Auction Engine.md]:

| Preset | Window | Allowlist | Vesting | Auto-LP |
| --- | --- | --- | --- | --- |
| Degen | Minutes | No | No | Yes |
| Raise (ICO) | Hours–days | Yes | Yes | Optional |
| Vault | Per round | Configurable | N/A | No |

## Two products, two tracks

| | Fair Launch (use case 1) | Exit-Priority Auction (use case 2) |
| --- | --- | --- |
| Track | 03 Social, Attention & Culture — primary [src: Monad Sealed-Bid Auction Engine.md] | 01 Onchain Finance & Trading — conditional [src: Monad Sealed-Bid Auction Engine.md] |
| What is sold | Token supply locked by a creator | Exit slots from a vault, bid as an accepted discount |
| Who pays | Bidders, all at the clearing price | Exiting holders, all at the clearing discount; the discount accrues to holders who stay |
| Ships if | Always | Metropolis allows multiple submissions **and** use case 1 is complete by day 14; otherwise it is a second preset inside one submission [src: Monad Sealed-Bid Auction Engine.md] |

Track names and the $30,000-per-track / $25,000 Grand Champion structure are from the Metropolis page [src: https://monad.xyz/developers/hackathons/metropolis].

## Why Monad

Sub-second finality (~800 ms, 500 ms blocks per the PRD) makes a two-transaction commit-reveal flow cost pennies and makes clearing every few seconds viable [src: Monad Sealed-Bid Auction Engine.md]. Monad's local-mempool design means only the next few leaders see pending transactions, which narrows the observer set for the commit phase [src: https://docs.monad.xyz/monad-arch/consensus/local-mempool]. Note: the Cadence announcement targets 100 ms blocks and ~219 ms finality "when fully implemented and released" — those numbers are planned, not live; see [12-open-questions.md](12-open-questions.md) [src: https://monad.xyz/blog/cadence-multiple-concurrent-proposers].

## What the demo shows

**Fair Launch demo (primary).** The same sniper bot, two launches side by side. On a bonding curve it takes the first blocks. On the auction it gets the clearing price like everyone else. Twenty seconds, no narration [src: Monad Sealed-Bid Auction Engine.md].

**Exit-Priority demo (conditional).** A simulated run on a vault in two panes. Under FIFO the queue lengthens, the token depegs, latecomers get nothing. Under the auction it clears at a widening discount, stays orderly, and the discount visibly accrues to remaining holders [src: Monad Sealed-Bid Auction Engine.md].

## Positioning line

Lead with the community, not the clearing price: *"your community shouldn't lose its own launch to three bots in the first block — everyone pays the same price, nobody gets a head start."* The mechanism is the proof, not the pitch [src: Monad Sealed-Bid Auction Engine.md].

Related files: [README.md](README.md) · [02-problem.md](02-problem.md) · [03-architecture.md](03-architecture.md) · [04-flows.md](04-flows.md) · [10-decisions.md](10-decisions.md) · [11-roadmap.md](11-roadmap.md)
