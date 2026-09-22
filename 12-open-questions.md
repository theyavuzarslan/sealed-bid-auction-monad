# 12 — Open Questions

Unanswered questions, contradictions between sources, risks, and assumptions this documentation currently rests on.

Status: draft

## Contradictions between sources

| # | Topic | Source A | Source B | Resolution needed |
| --- | --- | --- | --- | --- |
| C1 | Build on BTX encrypted mempool? | Your note: "as monad stated they have new encrypted mempool btx, it is better if we can build using it." | PRD: "It does not exist on Monad and cannot be called from a contract in October" [src: Monad Sealed-Bid Auction Engine.md]. The ePrint is a scheme with a benchmark and "no mention of deployment" [src: https://eprint.iacr.org/2026/754]. Cadence post: benefits arrive "when fully implemented and released on Monad" [src: https://monad.xyz/blog/cadence-multiple-concurrent-proposers]. Live mempool docs contain no encryption [src: https://docs.monad.xyz/monad-arch/consensus/local-mempool]. | Docs currently follow the PRD: commit-reveal now, BTX as a swappable future sealing layer. Confirm you accept this, or point to a BTX testnet/API if one exists. |
| C2 | Monad block time / finality figures | PRD: ~800 ms finality, 500 ms blocks [src: Monad Sealed-Bid Auction Engine.md] | Cadence: 100 ms blocks, ~219 ms finality — planned, not live [src: https://monad.xyz/blog/cadence-multiple-concurrent-proposers] | Cite the live numbers in the write-up and Cadence as "coming". Verify the live numbers against current Monad docs. |
| C3 | "Day 14" gate for use case 2 | PRD: ships "if use case 1 is complete by day 14" [src: Monad Sealed-Bid Auction Engine.md] | Build window started 1 Sep [src: https://monad.xyz/developers/hackathons/metropolis]; PRD dated 22 Sep | Roadmap assumes day 14 from 22 Sep = 6 Oct. Confirm. |
| C4 | Multiple submissions allowed? | PRD conditions use case 2 on it [src: Monad Sealed-Bid Auction Engine.md] | Metropolis page: "no explicit rules prohibiting multiple track submissions" found [src: https://monad.xyz/developers/hackathons/metropolis] | Check hackathon.monad.xyz rules or ask organizers. |
| C5 | Meaning of `price` in commit/reveal | `05-data-model.md`: "Limit price as uint96 fraction" | Code: `AuctionEngine._placeOrder` uses it as `buyAmount`, the number of auctioning tokens wanted; the limit price is `quantity / price` [src: sba-agents/fork/contracts/src/AuctionEngine.sol]. The frontend asks for a raw "Price" [src: sba-agents/ui/web/js/screens/round.js]. | **Resolved 22 Sep:** `price` = max price per token, plus a separate token `amount` (decision 22). Contract and UI must change together. |
| C6 | Model used by the `settle` pane | `RUNBOOK.md` / `run.sh`: `openai/gpt-5.6-sol` | Actual: `opencode-go/deepseek-v4-pro` [src: sba-agents/settle/opencode.json] | Delete the `opencode.json` files before rerunning panes if the planned models matter. |

## Unanswered product questions

| # | Question | Where it blocks |
| --- | --- | --- |
| Q1 | ~~Where does slashed collateral go?~~ **Resolved 22 Sep:** burned (decision 30). | — |
| Q2 | ~~One commitment per address per round, or many?~~ **Resolved in code:** one. `SealingLayer` requires `commitmentsPerBidder == 1` [src: contracts/src/SealingLayer.sol]. | — |
| Q3 | ~~How is minimum bid size enforced?~~ **Resolved in code:** rejected at reveal. The reveal reverts, the bidder stays unrevealed and is slashable [src: contracts/src/SealingLayer.sol]. Confirm this is the intended penalty. | — |
| Q4 | ~~Which DEX, LP lock and duration?~~ **Resolved 22 Sep:** DEX adapters (Uniswap v3 first), GoPlus `UniV3LPLocker`; Degen permanent, Raise creator-chosen (decisions 23–28). | — |
| Q5 | ~~Sandwich mitigation for the LP seed (bug #7)?~~ **Resolved 22 Sep:** each pool starts at the clearing price; claims stay closed until the LP is seeded, so no auctioned token exists outside the contract before the pool does; a pre-existing pool at a deviating price makes `seedLP` revert (decision 27, `tasks/lp.md`). Repricing an empty pre-existing pool with a dust swap is P1. | — |
| Q6 | ~~Which vault; exit capacity; keeper?~~ **Resolved 22 Sep:** our own demo ERC-4626 over WMON; capacity = idle buffer capped per round; permissionless `openExitRound()` (decision 31). | — |
| Q7 | ~~Raise vesting and allowlist format?~~ **Resolved 22 Sep:** OpenZeppelin Merkle allowlist; in-engine TGE + cliff + linear vesting (decision 32). | — |
| Q8 | ~~Salt backup UX?~~ **Resolved 22 Sep:** encrypted on-chain note keyed by a wallet signature, plus localStorage and a backup file (decision 33). | — |
| Q9 | ~~Bidding token?~~ **Resolved 22 Sep:** native MON only; `openRound` requires `biddingToken == address(0)` (AUDIT H3, `tasks/fix-core.md`). | — |
| Q10 | ~~Demo baseline?~~ **Resolved 22 Sep:** a local bonding curve (already built as `LocalBondingCurve.sol` in `agent/demo`), with the auction pane driven by the real engine on local anvil (AUDIT M3). | — |
| Q11 | ~~Toolchain?~~ **Resolved in code:** Foundry 1.8.3 for contracts; plain HTML/ES modules with vendored js-sha3 for the frontend; Node for the indexer [src: contracts/foundry.toml, sba-agents/ui/web, sba-agents/scripts/indexer]. Wallet library still TODO. | 07-tech-stack.md |
| Q12 | ~~Does `/agentguard scan` exist as a runnable tool?~~ **Resolved:** installed at `~/.hermes/plugins/agentguard` + `~/.hermes/skills/agentguard`. Still to confirm: exact invocation and where `web3-patterns.md` lives inside it. | Roadmap Block D |
| Q13 | ~~GoPlus locker address and ABI on Monad?~~ **Resolved:** `UniV3LPLocker` `0x24A9eB23De8E6f59BDB981B03E847F0f3ABbFa0d`, `TokenLocker` `0xF17A08A7d41F53B24AD07Eb322CBBdA2ebdeC04b` [src: https://docs.gopluslabs.io/page/goplus-safetoken-locker]. Both have code on Monad; lock functions confirmed in bytecode [src: on-chain, Monad RPC, 22 Sep]. | — |
| Q14 | ~~Replace the EasyAuction clearing with Zama-style clearing?~~ **Resolved 22 Sep: yes** (decision 22). | — |
| Q15 | ~~Who picks the DEX split?~~ **Resolved 22 Sep:** the creator (decision 26). | — |
| Q16 | ~~Where do unsold tokens go?~~ **Resolved 22 Sep:** Degen → burn; Raise → back to the creator (decision 29). Options kept below for the record. | — |

### Q16 options — what happens and whom it favours

| Option | What happens | Favours | Cost |
| --- | --- | --- | --- |
| Return to creator | Creator receives the unsold tokens | Creator | An overhang the creator can dump later; buyers carry that risk |
| Return to creator, locked | Same, inside a GoPlus `TokenLocker` lock | Creator long term; buyers protected | A flat MON fee per lock — 2,000 MON for `TOKEN` locks per GoPlus docs; could not verify on-chain |
| Burn | Sent to a dead address | Every buyer: their share of total supply rises | Creator loses them; irreversible |
| Single-sided liquidity above the clearing price, locked | Sold only if the price rises; the MON from those sales stays in the locked pool | Pool depth and traders | Acts as a sell wall that slows early price rises |
| Bonus to winners, pro-rata | Winners receive extra tokens | Winners | Effectively lowers everyone's price below the clearing price; muddies the one-price story |

## Arbitrum questions

| # | Question |
| --- | --- |
| A1 | Is Gnosis EasyAuction actually deployed on Arbitrum One? Not confirmed in sources; verify on Arbiscan before citing. |
| A2 | Does the Timeboost express lane's 200 ms head start let a bidder reliably buy the last-reveal position? If so, reveal windows on Arbitrum need a design change. |
| A3 | Actual commit + reveal + claim cost on Arbitrum including L1 data fees. |

## Risks

| # | Risk | Mitigation in plan |
| --- | --- | --- |
| R1 | Two-transaction flow loses impulse buyers (LBP precedent) [src: Monad Sealed-Bid Auction Engine.md] | Degen preset with minute-scale windows; prepared answer for judges |
| R2 | Slashing accounting strands funds (bug #3) | Ledger invariant + fuzz tests |
| R3 | Judges test the LP seed sandwich (bug #7) | Mitigation TBD (Q5); at minimum disclose |
| R4 | `uint96` amount fields cap a single round's size | Document; acceptable for hackathon |
| R5 | LGPL copyleft surprises a later commercial partner | Disclose now; decide later [src: Monad Sealed-Bid Auction Engine.md] |
| R6 | Exit-Priority not finished by gate | Falls back to Vault preset inside one submission |
| R7 | Overclaiming privacy | Claims-to-avoid table enforced in UI and write-up |
| R8 | **`ClearingCore` is publicly callable**: anyone can settle early (slashing every bidder), lock any bidder's deposit, or inject unfunded bids. Proven by PoC. | `onlyEngine` guard + engine deploys its core; validated. AUDIT.md C1–C3. |
| R9 | Winners pay but receive no tokens; no creator proceeds path | Implement the token leg once the DEX is chosen. AUDIT.md H1. |
| R10 | Demo auction pane is a JS simulation, not the contract | Point it at `AuctionEngine` on local anvil. AUDIT.md M3. |

| R11 | Zama-style clearing is new hand-written money-path code (decision 22) | Keep it to one loop and one pro-rata division; fuzz against a brute-force reference; no synthetic-price branches |
| R12 | EasyAuction ties at the clearing price go to earlier revealers (AUDIT.md M6) | Removed by decision 22's pro-rata rule |

## Assumptions

- Monad testnet is stable enough for the demo recording.
- Anyone can trigger settlement and LP seeding, so no keeper is needed for Fair Launch.
- Post-clear transparency of revealed bids is acceptable to creators.
- The Culture-track judges weigh the head-to-head demo more than contract review [src: Monad Sealed-Bid Auction Engine.md].

Related files: [02-problem.md](02-problem.md) · [03-architecture.md](03-architecture.md) · [06-api.md](06-api.md) · [10-decisions.md](10-decisions.md) · [11-roadmap.md](11-roadmap.md)
