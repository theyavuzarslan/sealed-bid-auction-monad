# 09 — Resources

Every external link referenced by the project, grouped by category.

Status: draft

## Hackathon

| Title | Link | What it's for |
| --- | --- | --- |
| Metropolis — a Monad hackathon | https://monad.xyz/developers/hackathons/metropolis | Tracks, $30k per track, $25k Grand Champion, dates (build 1 Sep–13 Oct, judging 14–27 Oct, winners 3 Nov), submission requirements |
| Monad Hackathon platform | https://hackathon.monad.xyz/ | Submission portal; check multiple-submission rule here |

## Monad architecture

| Title | Link | What it's for |
| --- | --- | --- |
| Local mempool | https://docs.monad.xyz/monad-arch/consensus/local-mempool | Threat model: RPC forwards to next N=3 leaders; validators check balance and nonce; no encryption mentioned |
| Cadence: multiple concurrent proposers | https://monad.xyz/blog/cadence-multiple-concurrent-proposers | Planned consensus: 100 ms blocks, ~219 ms finality, "no proposer sees the others' contents in time to react"; BTX as complementary encrypted mempool; not live |
| BTX: Simple and Efficient Batch Threshold Encryption | https://eprint.iacr.org/2026/754 | Category Labs scheme (approved 21 Apr 2026); implementation benchmark, no deployment |
| BTX paper (Category Labs mirror) | https://category-labs.github.io/category-research/BTX-paper.pdf | Same paper |
| Monad announcement of BTX | https://x.com/monad/status/2045561919466053982 | Source of the "would keep transactions hidden" future-tense wording |
| Monad announcement of Cadence | https://x.com/monad/status/2074513177442767030 | Confirms Cadence + BTX framing |
| Vaults, Curators, and the Infrastructure Behind Fintech Earn Programs | https://www.monad.xyz/announcements | Monad's 10 Aug 2026 curator post; narrative fit for the curator-auction fallback [src: Monad Sealed-Bid Auction Engine.md] |

## Auction mechanism references

| Title | Link | What it's for |
| --- | --- | --- |
| Gnosis EasyAuction contracts | https://github.com/Gnosis-Auction/auction-contracts | Original clearing reference; replaced by Zama-style clearing on 22 Sep (decision 22) |
| a16z OverCollateralizedAuction | https://a16zcrypto.com/posts/article/hidden-in-plain-sight-a-sneaky-solidity-implementation-of-a-sealed-bid-auction | Uniform-deposit pattern; why deposit must not scale with bid |
| a16z — On the limits of encrypted mempools | https://a16zcrypto.com/posts/article/limits-encrypted-mempools | Speculative MEV / reveal refusal argument |
| Censorship-Resistant Sealed-Bid Auctions on Blockchains (Alpos, Heimbach, Nayak, Wadhwa, Jun 2026) | https://arxiv.org/html/2606.14939 | Academic alternative: timestamping committee + inclusion lists + ZK; not commit-reveal; useful for the "what we did not build" section |

## DEX and LP lock (Monad)

| Title | Link | What it's for |
| --- | --- | --- |
| Uniswap v3 Monad deployments | https://developers.uniswap.org/docs/protocols/v3/deployments/v3-monad-deployments | Factory, NonfungiblePositionManager, SwapRouter02, WMON addresses (chain 143) |
| GoPlus supported lockers | https://docs.gopluslabs.io/reference/supported-locker | Confirms SafeToken Locker on Monad |
| GoPlus SafeToken Locker app | https://lock.gopluslabs.io/ | Locker UI; lock detail pages |
| PancakeSwap V3 (Monad) | https://www.coingecko.com/en/exchanges/pancakeswap-v3-monad | Second adapter target |

## Competitive landscape

| Title | Link | What it's for |
| --- | --- | --- |
| nad.fun docs | https://nad-fun.gitbook.io/nad.fun | Monad's dominant bonding-curve launchpad; demo baseline |
| Uniswap Continuous Clearing Auction whitepaper | https://developers.uniswap.org/whitepaper_cca.pdf | Closest existing mechanism (transparent, per-block uniform clearing, auto v4 pool) |
| Uniswap CCA on Arbitrum One (news) | https://www.bitget.com/news/detail/12560605172062 | Confirms CCA live on Arbitrum; bids fully visible onchain |
| Uniswap CCA rewriting Arbitrum launches | https://www.coinrank.io/crypto/uniswap-cca-is-rewriting-arbitrum-native-token-launches/ | CCA mechanics and HuddlePad adoption |
| HuddlePad | https://huddlepad.xyz/ | Arbitrum-native CCA launchpad |
| Arbitrum Timeboost — gentle introduction | https://docs.arbitrum.io/how-arbitrum-works/timeboost/gentle-introduction | Sealed-bid second-price express-lane auction; private sequencer mempool; 200 ms delay |
| Arbitrum Timeboost FAQ | https://docs.arbitrum.io/how-arbitrum-works/timeboost/timeboost-faq | Auction parameters |

## Auction mechanics references

| Title | Link | What it's for |
| --- | --- | --- |
| Zama Public Auction — how it works | https://docs.zama.org/auction/how-it-works | Price + amount bids, pro-rata at the clearing price, refunds (decision 22) |
| Uniswap Liquidity Launchpad (CCA) whitepaper | https://developers.uniswap.org/whitepaper_cca.pdf | Budget + max price bids; LP seeded from a pre-committed share of proceeds (decision 25) |
| GoPlus SafeToken Locker integration guide | https://docs.gopluslabs.io/page/goplus-safetoken-locker | Locker addresses per chain, `lock` ABI, fee tiers |
| Liquidity locks: locked vs burned | https://www.barryguard.com/blog/understanding-liquidity-locks | pump.fun burns LP at graduation — the memecoin norm behind decision 28 |

## Tooling

| Title | Link | What it's for |
| --- | --- | --- |
| `/agentguard scan` | Installed locally: `~/.hermes/plugins/agentguard` and `~/.hermes/skills/agentguard` (hooks example at `~/.hermes/agentguard-hooks.example.yaml`) | Pre-submission self-scan; report goes in README |
| Muse Code CLI (Meta Muse Spark) | https://developer.meta.com/ai/models/muse-spark/ | Fifth agent for parallel build; 1M context, OpenAI-compatible API |
| Herdr agent multiplexer | https://github.com/harry81/herdr-team | Running four to five agents in parallel panes with git worktrees (retired 23 Sep; the build moved to one session with subagents) |
| Impeccable (Claude Code plugin) | Installed locally as a Claude Code plugin | Design process and detector used for the Even redesign; records in PRODUCT.md and DESIGN.md |

## Design references (Even redesign, 23 Sep)

| Title | Link | What it's for |
| --- | --- | --- |
| Monad | https://monad.xyz | Brand palette (#6E54FF, #A0055D, #200052, #FBFAF9), stepped pixel art, outlined numerals |
| nad.fun | https://nad.fun | Monad memecoin launchpad: dark field, purple accent |
| Kuru | https://kuru.io | Monad order-book DEX: dark UI, lime call to action |
| Magma | https://magmastaking.xyz | Monad liquid staking: navy and orange |

Related files: [02-problem.md](02-problem.md) · [03-architecture.md](03-architecture.md) · [10-decisions.md](10-decisions.md) · [12-open-questions.md](12-open-questions.md)
