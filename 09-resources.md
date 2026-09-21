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
| Gnosis EasyAuction contracts | https://github.com/Gnosis-Auction/auction-contracts | Clearing core to fork (LGPL-3.0, audited 2021) |
| a16z OverCollateralizedAuction | https://a16zcrypto.com/posts/article/hidden-in-plain-sight-a-sneaky-solidity-implementation-of-a-sealed-bid-auction | Uniform-deposit pattern; why deposit must not scale with bid |
| a16z — On the limits of encrypted mempools | https://a16zcrypto.com/posts/article/limits-encrypted-mempools | Speculative MEV / reveal refusal argument |
| Censorship-Resistant Sealed-Bid Auctions on Blockchains (Alpos, Heimbach, Nayak, Wadhwa, Jun 2026) | https://arxiv.org/html/2606.14939 | Academic alternative: timestamping committee + inclusion lists + ZK; not commit-reveal; useful for the "what we did not build" section |

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

## Tooling

| Title | Link | What it's for |
| --- | --- | --- |
| `/agentguard scan` | Installed locally: `~/.hermes/plugins/agentguard` and `~/.hermes/skills/agentguard` (hooks example at `~/.hermes/agentguard-hooks.example.yaml`) | Pre-submission self-scan; report goes in README |
| Muse Code CLI (Meta Muse Spark) | https://developer.meta.com/ai/models/muse-spark/ | Fifth agent for parallel build; 1M context, OpenAI-compatible API |
| Herdr agent multiplexer | https://github.com/harry81/herdr-team | Running four to five agents in parallel panes with git worktrees |

Related files: [02-problem.md](02-problem.md) · [03-architecture.md](03-architecture.md) · [10-decisions.md](10-decisions.md) · [12-open-questions.md](12-open-questions.md)
