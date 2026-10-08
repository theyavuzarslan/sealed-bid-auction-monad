# How Even differs from Zama and other launch mechanisms

Even, Zama's public auction and Uniswap's Continuous Clearing Auction (CCA) all use the same core economics: bidders state a price, the highest bids fill first, and every winner pays one clearing price. The differences are in what stays hidden, who you have to trust, what happens after the sale, and who can run one.

Sources are linked at the bottom. Where a number comes from a vendor's own post, it says so.

## Even vs Zama, side by side

| | **Even** | **Zama public auction (Jan 2026)** |
|---|---|---|
| What it is | A launchpad: anyone can launch any token, any number of times | One flagship sale of Zama's own token, also a showcase for its protocol |
| Chain | Monad mainnet | Ethereum mainnet, plus partner sales on KuCoin and CoinList |
| Hidden while bidding | **Price and size**, until bidding closes (commit-reveal) | **Size only**; the price of each bid was public |
| Hidden after the sale | Nothing: every bid is public once the round settles (by design) | Amounts stay confidential; refunds can stay confidential (ERC-7984) |
| Pricing | One clearing price; pro-rata at the margin | One clearing price; pro-rata at the margin |
| Who you trust for privacy | The contracts only | Zama's protocol: FHE coprocessors (majority result) and a 13-node threshold key committee running in AWS Nitro enclaves |
| Bidder steps | Commit, reveal, claim. A bid that is never revealed loses its deposit | Shield stablecoins, bid (as many bids as you like, cancellable), claim. No reveal step |
| Bid size | Capped by the round's uniform deposit (it hides size); splitting across wallets buys no better price | Uncapped |
| After the sale | Same flow seeds a Uniswap v3 pool at the clearing price and locks the LP in GoPlus (forever for Degen launches); claims open right after settlement | Tokens claimable 9 days later, fully unlocked; no liquidity provisioning described |
| Cost to a bidder | About 554k gas for the whole journey, about $0.002 on Monad | Ethereum gas plus FHE fees (paid in ZAMA and burned) |
| Scale so far | One live mainnet round (3 bidders); a 1,000-bidder settlement test on a mainnet fork | 11,103 bidders, 24,697 bids, $118.5M committed, $44M paid at $0.05 (Zama's figures) |

### What this means

- **Even hides more during the sale; Zama hides more after it.** In Zama's auction, everyone saw each bid's price, so the demand curve was visible while bidding. Even shows nothing but the number of bids until the close. After the close, Zama keeps amounts private and Even publishes every bid, which is what lets anyone check the clearing.
- **Even needs no one but the chain.** Zama's privacy rests on a key committee, enclave hardware and coprocessor operators. Even's rests on a hash and a deadline, which works on any EVM chain today and needs no extra network.
- **Zama's bidding is smoother.** No reveal step, cancellable bids, no deposit cap. Commit-reveal costs Even a second transaction and a liveness duty on the bidder. On Monad that second transaction costs a fraction of a cent, and the app reminds bidders to reveal.
- **Even finishes the launch.** Zama sold tokens; trading started elsewhere. Even's sale ends with a pool at the clearing price and locked liquidity, so the first trade happens at the price the bidders set, with no gap for a sniper to fill.
- **Even is a product anyone can use; Zama's sale was one event.** The comparison is mechanism to mechanism; Zama has not offered its auction as a launchpad.
- **Zama proved scale; Even has not yet.** Even's evidence is one live round, a 1,000-bidder test on a mainnet fork, and an invariant suite. Its sealing step is simple enough to run at any scale on Monad, but that remains to be shown with real users.

## Even vs the other mechanisms

| | Hidden while bidding | Price paid | Does arriving first help? | Pool after the sale | Trust |
|---|---|---|---|---|---|
| **Even** | Price and size | One price for all winners | No | Seeded at the clearing price, LP locked | Contracts only |
| **Zama auction** | Size | One price | No | Not described | FHE coprocessors + key committee |
| **Uniswap CCA** | Nothing; bids are public | One price per block; earlier bids catch earlier, cheaper blocks | Partly, by design | Uniswap v4 pool | Contracts only |
| **Bonding curve** (nad.fun, pump.fun) | Nothing | Rises with every buy | **Yes**: first buyers pay least | Migrates at a threshold | Contracts only |
| **Gnosis EasyAuction** | Nothing; public order book | One price | No, but last-second bidding is visible and common | None | Contracts only |
| **Descending-price pools** (Fjord LBP, Doppler) | Nothing | Falls over time; depends on when you buy | Timing matters | Built in | Contracts only |
| **Fixed-price sales** (Echo/Sonar, Legion, exchange launchpads) | n/a | Fixed | Allocation by lottery, KYC or merit | Varies | The platform |

In a 500-launch simulation on the real contracts, a bot took a median 59% of supply on a bonding curve and 18% on Even, and 60% of willing buyers got nothing on the curve against 0% on Even (see SUBMISSION.md).

## One-line answers for a pitch

- **Versus Zama:** "Zama hid bid sizes with an encryption network and a key committee. Even hides price and size with nothing but Monad contracts, then opens a locked pool at the price the crowd set."
- **Versus Uniswap CCA:** "CCA makes every bid public and prices block by block. Even keeps bids sealed and gives everyone one price."
- **Versus a bonding curve:** "On a curve, the first block wins. On Even, arriving first buys nothing: the bot can still play, it just pays what everyone pays."

## Questions judges are likely to ask

**Why not use FHE like Zama?**
FHE needs a coprocessor network and a key committee, and Monad has no FHE layer. Commit-reveal gets the property a launch needs, nobody sees a price before the close, with no extra trust and about a fifth of a cent in fees on Monad. If an encrypted mempool or Monad's Private Settlement design ships, the commit and reveal can collapse into one step; the clearing and pool logic stay the same.

**Commit-reveal is old. What is new?**
The combination and the chain. A uniform deposit hides bid size, a one-price clearing removes the timing race, and the same flow seeds and locks the pool at the clearing price. Monad makes the second transaction cheap enough (about $0.002 for a bidder's whole journey) that a two-step auction is practical for a memecoin launch, not just a large raise.

**What if someone never reveals?**
Their deposit is burned to 0x…dEaD, so committing many fake bids and revealing only the useful ones costs real money. Honest bidders get reminders, and an encrypted backup of each bid is emitted on-chain at commit, so a bidder who loses their device can still recover and reveal it. Time-locked auto-reveal is the top roadmap item.

**Can a whale split a bid across wallets?**
Yes, and it gains nothing on price: every winner pays the same clearing price. The deposit cap is a creator setting that spreads supply; it is not a sybil defence and Even does not claim it is.

**Bids are public after settlement. Isn't that a privacy failure?**
It is a choice. Publishing every bid after the close lets anyone recompute the clearing price and check the result. Zama keeps amounts private longer; Even keeps everything private during the part that matters for fairness, the bidding.

**Uniswap CCA is already live. Why Even?**
CCA is a strong mechanism for transparent, continuous price discovery. Even serves the case where transparency during bidding is the problem: when bids are visible, bots and whales react to them.

**Is it audited?**
Not by an external firm. Two internal reviews with a test per finding, unit, fuzz and invariant tests, a 1,000-bidder scale test, a full run under Monad's gas rules, and static analysis with every finding triaged. See SECURITY.md and AUDIT.md.

**Why Monad?**
Cheap, fast transactions make a two-step sealed auction affordable for small launches; Uniswap v3, WMON and the GoPlus locker are already live there; passkey sign-in through Mera removes the wallet hurdle; and Monad's privacy roadmap (Private Settlement, encrypted mempool research) is the natural next step for sealed bids.

## Sources

- Zama, [Announcing the Zama Public Auction](https://www.zama.org/post/announcing-the-zama-public-auction): single-price sealed-bid auction on Ethereum, public price and private quantity, unlimited cancellable bids, claims on 2 Feb, tokens fully unlocked.
- Zama, [$118M committed for the first encrypted ICO on Ethereum](https://www.zama.org/post/118m-committed-for-the-first-encrypted-ico-on-ethereum): 11,103 bidders, 24,697 bids, $0.05 clearing price, $44M paid, 880M tokens sold. The post's "218% oversubscribed" does not match its own demand and supply figures, so it is not quoted here.
- [Zama Protocol litepaper](https://docs.zama.org/protocol/zama-protocol-litepaper) and Zama's [genesis operators announcement](https://x.com/zama/status/1981031174018564135): FHE coprocessors with majority consensus, threshold MPC key management in AWS Nitro enclaves, 13 KMS nodes and 5 coprocessors at launch.
- Uniswap, [How Aztec raised $59M with 17,000 bidders using CCA](https://blog.uniswap.org/aztec-cca) and the [Liquidity Launchpad docs](https://developers.uniswap.org/docs/liquidity/liquidity-launchpad/overview).
- Monad, [Monad Private Settlement](https://monad.xyz/blog/monad-private-settlement) (a published design, not live).
- Even's own numbers: SUBMISSION.md (fees, 500-launch simulation, mainnet round 1) and contracts/reports (scale test under Monad rules).
