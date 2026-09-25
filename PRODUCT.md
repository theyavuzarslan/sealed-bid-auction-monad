# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

- **Primary — bidders from the Monad community.** Memecoin buyers who today lose launches to bots on bonding curves. On a launch they commit a sealed bid with a uniform MON deposit, come back to reveal it inside the reveal window, and then claim: a refund of the unused deposit as soon as the round settles, and their tokens once the pool is seeded. They are often on a phone, often mid-hype, and they must not lose the deposit by missing the reveal. (Owner, 23 Sep.)
- **Secondary — token creators.** They open a round (Degen or Raise preset), lock supply, choose the LP share and DEX split, and later withdraw proceeds.
- **Also — hackathon judges** (Monad Metropolis, submission 13 Oct 2026, judged 14–27 Oct). They evaluate innovation, technical execution and track fit, largely from the pitch, the demo and the write-up.

## Product Purpose

Even is a sealed-bid token launch on Monad where everyone who wins pays the same clearing price. It replaces the first-come-first-served race of bonding curves, where bots buy the first blocks and the community buys the top. Success: a community launch where the sniper bot gets exactly the price everyone else gets, and the pool is seeded at that price and locked.

The site does two jobs equally (owner, 23 Sep): a pitch that makes judges and the community understand the idea in seconds, and a working app to launch and bid on Monad.

## Positioning

- **Timing buys nothing.** Bids are sealed by commit-reveal, and winners pay one uniform clearing price, so arriving first confers no price advantage. Measured on real transactions (`demo/results.json`): on a bonding curve the bot averages 0.138 MON per token against the crowd's 0.275; in the auction everyone, the bot included, pays 0.220.
- **One-transaction pipeline after the auction:** the proceeds and remaining supply seed a Uniswap v3 pool at the clearing price, locked in GoPlus SafeToken Locker. No token exists outside the contract before the pool does.
- Neighbours: nad.fun (Monad's dominant bonding-curve launchpad), Flap, Token Mill, Printr on Monad; Uniswap's Continuous Clearing Auction on other chains (uniform price, but bids fully visible).

## Operating Context

- Monad mainnet (chain 143) and a local anvil stack for development and the demo. Wallet-based; bids and deposits in native MON.
- A round has fixed windows: commit (deposit locked, bid hidden), reveal (bid opened; missing it burns the deposit), then settle, seed LP, claim. Anyone can press settle, seed, burn-unrevealed and abandon; funds always go to their owner.
- Bid recovery: the bid is encrypted into the commit transaction with a key from a wallet signature, plus a local copy and a backup file, so a bidder can reveal from any device.
- The hackathon: judges see a demo video, a short write-up and the code. The two-pane head-to-head (`demo/`) is the pitch.

## Capabilities and Constraints

- Contract surface is fixed by `contracts/src/AuctionEngine.sol` (ABI `contracts/abi/AuctionEngine.json`): openRound, commit (with allowlist proof and recovery note), reveal / revealWithHint, burnUnrevealed, settle, seedLP, abandonLP, claim / claimRefund / claimTokens, claimVested, withdrawProceeds, disposeUnsold, sweepDust; views getRound, clearingOf, quote, findHint.
- Presets: **Degen** (open, LP required, permanent lock, unsold supply burned) and **Raise** (optional Merkle allowlist, optional vesting, LP lock of at least 30 days, unsold supply returned).
- A bid is a max price per token plus a token amount; the bid's max spend must be below the uniform deposit; the minimum applies at the reserve price. Winners pay the clearing price; bids exactly at it share pro-rata.
- Frontend: static HTML, CSS and ES modules in `web/`. No build step, no npm packages; small vendored libraries only.
- **Mandatory wording** (`AGENTS.md`): say "snipe-resistant: submission timing no longer determines price", never "no sniping", "MEV-proof" or "bot-proof". Privacy comes from commit-reveal; never claim an encrypted mempool. Post-clear transparency of bids is intentional.
- Commitment count and timing are public by design; revealed prices are never shown before clearing.
- Undecided: Monad mainnet deployment addresses; the MON/USD source for fee display.

## Brand Commitments

- **Name: Even** — proposed by Claude at the owner's request on 23 Sep ("nobody gets a head start; everyone pays the same price"); no Monad project using it was found. Renameable.
- **The site must look native to Monad and its ecosystem** (owner's binding constraint, 23 Sep): Monad's own brand and the look of ecosystem projects such as nad.fun, Kuru, Magma and aPriori.
- Voice for claims: precise and honest over hype (`03-architecture.md` threat model; the claims-to-avoid table).

## Evidence on Hand

- `demo/results.json`: the head-to-head numbers above, from 73 real transactions on anvil.
- Contracts tested: 102 unit/fuzz tests (11 of them check the PRD's promises directly), 10,000-run fuzzing of clearing and accounting, 19 fork tests against real Uniswap v3 and the real GoPlus locker on Monad mainnet; two independent audits with every finding resolved or documented (`AUDIT.md`).
- GoPlus UniV3LPLocker on Monad `0x24A9eB23De8E6f59BDB981B03E847F0f3ABbFa0d`, verified on-chain.
- Bidder journey gas: 358–492k (≈0.037–0.050 MON at 102 gwei, 23 Sep).
- **Absent — must not be fabricated:** users, launches, volume, TVL, testimonials, partnerships, endorsements from Monad or GoPlus, a mainnet deployment, MON/USD figures.

## Product Principles

1. **Fairness is shown, not claimed.** Every fairness statement is backed by the mechanism on screen or by measured numbers.
2. **Never lose a deposit to a missed step.** The reveal deadline, recovery, and refund are the most protected moments of the flow.
3. **Honest limits beat clean slogans.** Say exactly what is and is not private; follow the claims-to-avoid table.
4. **Anyone can move a round forward.** Settle, seed, burn and abandon are public actions the UI offers to whoever is there.
5. **Community over mechanism in the pitch; mechanism on demand.** Lead with "nobody gets a head start"; keep the depth for those who want it.
