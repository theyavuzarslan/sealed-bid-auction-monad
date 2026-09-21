# 02 — Problem

The problem we solve, who has it, what exists today (on Monad and on Arbitrum), and where our edge is.

Status: draft

## The problem

First-come-first-served allocation turns scarce access into a latency race, and in both target markets the race destroys value rather than merely redistributing it [src: Monad Sealed-Bid Auction Engine.md].

### Token launches

- Bonding-curve launchpads price by arrival order, so later buyers are structurally disadvantaged while sniper bots front-run ordinary participants [src: Monad Sealed-Bid Auction Engine.md].
- On nad.fun, Monad's dominant launchpad, a token graduates at roughly 225,000 MON with about 80% of supply sold — all allocated by who transacted first [src: Monad Sealed-Bid Auction Engine.md].
- Creators hand-assemble sale → price discovery → LP seeding → locks, and each seam is a rug vector [src: Monad Sealed-Bid Auction Engine.md].

### Vault redemptions

- Every redemption queue in DeFi is FIFO or cooldown-gated. Ethereum's exit queue is strict FIFO; mETH bolts on a two-speed system; the only priority mechanisms are compliance-driven under ERC-3643 [src: Monad Sealed-Bid Auction Engine.md].
- Under FIFO, being early is strictly better than being late for everyone, always. That is the coordination failure that causes runs. Queue waits lengthen, market makers price holding cost in, the LST depegs, and the deviation triggers liquidations [src: Monad Sealed-Bid Auction Engine.md].

## Who has it

| Persona | Pain | Product |
| --- | --- | --- |
| Memecoin creator | Wants the community to get supply, not three bots; must hand-build the launch pipeline | Fair Launch |
| Ordinary buyer | Buys the top because bots took the first blocks | Fair Launch |
| Vault / LST holder who needs liquidity now | Must race the queue, or wait 24–72 h cooldowns [src: Monad Sealed-Bid Auction Engine.md] | Exit-Priority Auction |
| Vault holder who stays | Bears the cost of others' exits with no compensation | Exit-Priority Auction |

## Existing solutions

### On Monad and generally

| Approach | Failure mode [src: Monad Sealed-Bid Auction Engine.md] |
| --- | --- |
| Bonding curve (nad.fun) | Prices by arrival order; sniper-dominated |
| Fixed-price sale | Misprices |
| Dutch auction | Rewards low-latency professionals |
| One-shot sealed auction | Enables last-minute sniping |
| LBPs (Balancer, Fjord) | Provably fairer, never displaced the simple curve — users will not wait or learn a second model |
| FIFO / cooldown exit queues | Cause the run they exist to contain |

### On Arbitrum (requested check)

| Product | What it is | Sealed bids? | Relevance |
| --- | --- | --- | --- |
| Uniswap Continuous Clearing Auction (CCA) on Arbitrum One | Creator commits supply, sets duration and floor; bids are budget + max price; every block clears at one uniform price and the clearing price ratchets up as a new floor; outcome auto-seeds a Uniswap v4 pool [src: https://www.coinrank.io/crypto/uniswap-cca-is-rewriting-arbitrum-native-token-launches/] | No — "every bid, block, and allocation visible onchain" [src: https://www.bitget.com/news/detail/12560605172062] | Closest existing product to Fair Launch. Uniform clearing + auto-liquidity already shipped there. |
| HuddlePad | Arbitrum-native launchpad built on CCA [src: https://huddlepad.xyz/] | No (inherits CCA) | Proof that the launch-auction niche is occupied on Arbitrum. |
| Timeboost express lane auction | Per-round (60 s) sealed-bid second-price auction for a 200 ms sequencing advantage; bids collected offchain by an "autonomous auctioneer" that then calls the auction contract [src: https://docs.arbitrum.io/how-arbitrum-works/timeboost/gentle-introduction] | Yes, but offchain auctioneer | Infrastructure, not a launch or exit product. Shows Arbitrum itself uses sealed bids for priority. |
| Gnosis EasyAuction on Arbitrum | Not confirmed deployed on Arbitrum One in the sources searched; CoW Swap (a different Gnosis-lineage product) is on Arbitrum [src: https://github.com/Gnosis-Auction/auction-contracts] | — | TODO: verify on Arbiscan before claiming anything. |
| Exit-priority / redemption auction | Nothing found on Arbitrum in the sources searched | — | Use case 2 has no incumbent on Arbitrum either. |

Conclusion for Arbitrum: the engine is portable (see [03-architecture.md](03-architecture.md)), but the Fair Launch slot on Arbitrum is already occupied by CCA + HuddlePad. The differentiator there would be *sealed* bids versus CCA's fully transparent bids, which is a narrower pitch than on Monad, where nad.fun's bonding curve is the incumbent.

## Our edge

1. **Blind bidding with one price.** No bidder sees another's price before clearing, and every clearing bid pays the same [src: Monad Sealed-Bid Auction Engine.md]. CCA on Arbitrum is uniform-price but fully transparent.
2. **Reveal refusal is priced in.** Uniform overcollateralized deposits plus slashing make declining to reveal costly, without the deposit leaking bid size [src: Monad Sealed-Bid Auction Engine.md].
3. **One-click launch pipeline.** Auction → distribution → locked-LP pool, atomically [src: Monad Sealed-Bid Auction Engine.md].
4. **Cheap enough to be two transactions.** Full bidder journey under $0.01 in fees on Monad [src: Monad Sealed-Bid Auction Engine.md].
5. **A primitive, not a one-off.** The same clearing core runs launches and exit auctions [src: Monad Sealed-Bid Auction Engine.md].
6. **Track fit by contrast.** Every strong DeFi team files into Finance; a rigorous auction mechanism in the Culture track is a technical-execution outlier and the sniper head-to-head reads to any judge [src: Monad Sealed-Bid Auction Engine.md].

## Known weakness

Memecoin buying is impulse and FOMO; our flow is commit → wait → reveal → wait → clear against nad.fun's one click. Expect the question and have the LBP precedent answer ready [src: Monad Sealed-Bid Auction Engine.md].

Related files: [01-overview.md](01-overview.md) · [03-architecture.md](03-architecture.md) · [09-resources.md](09-resources.md) · [10-decisions.md](10-decisions.md) · [12-open-questions.md](12-open-questions.md)
