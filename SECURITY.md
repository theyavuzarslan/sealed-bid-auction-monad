# Security

Even is a sealed-bid, uniform-price batch auction on Monad: bidders commit a hash and a uniform MON deposit, reveal after the commit window, and everyone who wins pays the same clearing price. This page lists what has been checked, how, with what result, and what has not. **The contracts have not had an external audit.**

## Scope

Everything between "a bidder sends MON" and "a bidder gets tokens or a refund" is in scope:

| File | Role |
| --- | --- |
| `contracts/src/DepositLedger.sol` | Uniform deposits, per-round `roundBalance`, burning unrevealed deposits, refund push with owed-refund fallback (v2) |
| `contracts/src/SealingLayer.sol` | Commit (`keccak256(abi.encode(price, amount, salt, msg.sender))`), reveal, allowlist proof, minimum windows (v2) |
| `contracts/src/UniformClearing.sol` | Price-level book, clearing price, pro-rata at the clearing price, resumable settlement |
| `contracts/src/AuctionEngine.sol` | The launch product: presets, payments and refunds, LP seeding and locking, unsold disposal, vesting, the LP grace escape |
| `contracts/src/exit/ExitAuction.sol` | Vault exit auction (use case 2) on the same three layers |

Also built and tested, but off the bidder money path: the Uniswap v3 adapter and price math (`src/adapters/`), `TokenFactory`, and `DemoVault`. Vendored OpenZeppelin v5.1.0 (`src/vendor/`) is unmodified and excluded from analysis.

**Deployments.**

| Version | State | Addresses |
| --- | --- | --- |
| v1 (git tag `mainnet-v1`) | Live on Monad mainnet (chain 143) since 6 Oct 2026 | `AuctionEngine` [`0x0Fa0E7Db5b2c2146D77E41579030A842492E2120`](https://monadscan.com/address/0x0Fa0E7Db5b2c2146D77E41579030A842492E2120), `TokenFactory` [`0x41F968CcA0a95d4289D356c24668b1c72e645DbF`](https://monadscan.com/address/0x41F968CcA0a95d4289D356c24668b1c72e645DbF), `UniswapV3Adapter` [`0x71da6a936f1196881C236c62a084ddEB448772Ba`](https://monadscan.com/address/0x71da6a936f1196881C236c62a084ddEB448772Ba) (details in [SUBMISSION.md](SUBMISSION.md)) |
| v2 (branch `contracts-v2`) | Pending deployment | New engine address once deployed; v1's round 1 stays on the v1 engine. Changes: [contracts/CHANGES-v2.md](contracts/CHANGES-v2.md) |

The results below are for **v2** unless marked otherwise. v2 fixes four review items in v1 (minimum windows, a refund to a contract that rejects MON could block a round's settlement, ERC-4626 `redeem` equality, compiler); none of them can move funds to an attacker in v1.

## Threat model

The PRD names eight bug classes for the money path. For each: where it is handled and what checks it.

| # | Bug class | How it is handled | Checked by |
| --- | --- | --- | --- |
| 1 | Commit missing the salt | The preimage is `abi.encode(price, amount, salt, msg.sender)` | Unit tests (`test_RevealRules`, wrong-salt reveals in the invariant handler); every symbolic engine proof commits the real hash |
| 2 | Commit not bound to `msg.sender` | `msg.sender` is in the preimage and the commitment is stored under `msg.sender` | Invariant handler reveals other bidders' bids and requires a revert; `test_Security_NobodyClaimsForSomeoneElse` |
| 3 | Slashing accounting on non-reveal | Unrevealed deposits are burned in aggregate, `(commits − reveals) × deposit`, only to `0x…dEaD`, idempotent | Symbolic proof P7 (all 8 reveal patterns of 3 committers); invariant `UnrevealedDepositsOnlyBurned` |
| 4 | Off-by-one at the clearing price | Pro-rata rounds down, payments round up (`ceil(alloc × P / 1e18)`) | Symbolic P1, P2, P5, P8; differential fuzz against a brute-force reference; invariants `ClearingAndAllocations`, `SettledBiddersPaidExactly` |
| 5 | Reentrancy on refund and claim | One engine-wide `nonReentrant` lock; effects before every transfer; refunds pushed with a 50,000-gas stipend | `test_Security_ReentrantClaimBlocked`, `test_Claim_ReentrancyBlocked`; owed-refund proof O1/O2 |
| 6 | Gas DoS via dust commits | Mandatory minimum bid, measured at the reserve price; settlement cost scales with price levels, not bids, and is resumable | 1,000-bidder scale test under Monad gas rules (below) |
| 7 | Sandwichable LP seed | The pool is seeded only at the clearing price, before any token is delivered; a pool that cannot be seeded at that price is abandoned after a grace period and its MON burned | Mainnet-fork tests against real Uniswap v3 and the GoPlus locker (`test/fork/`); AUDIT.md second review H1 |
| 8 | `price × amount` precision favouring the bidder | Every bid-size check and payment rounds up against the bidder | Symbolic P3, P5, P6b; invariant `SettledBiddersPaidExactly` |

Out of scope by design: privacy of losing bids after the round (bids are public once revealed), front-running protection beyond commit-reveal (Monad has no encrypted mempool), KYC.

RESULTS_PLACEHOLDER
