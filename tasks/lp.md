# Task: lp

Read `AGENTS.md`, `AUDIT.md`, `04-flows.md` Flow 8, and `10-decisions.md` #23–28 first. Money-path work. Start after `tasks/clearing.md` lands: you need the clearing price P and `soldLowerBound`.

## Scope
`contracts/src/AuctionEngine.sol` (`seedLP`, `withdrawProceeds`, the claim gate), new `contracts/src/adapters/`, `contracts/test/`. Replace the abstract `LPSeeder.sol` from `agent/core` rather than extending it.

## Sizing — no leftovers by construction (decision 25)

- `lpTokens = soldLowerBound × lpShareBps / 10000`
- `lpMon = (soldLowerBound × P / 1e18) × lpShareBps / 10000`, rounded down
- Both sides come from the same sold amount at price P, so they are already in ratio P. Only rounding dust remains.
- `lpMon` is always covered: total payments ≥ `soldLowerBound × P / 1e18` ≥ `lpMon`. Test it.

## Proceeds accounting (decision 27)

- `seedLP(roundId)`: anyone, once settled, exactly once. Spends `lpMon` from this round's deposits, which are already in the engine. Never touch another round's MON: track a per-round balance.
- `claim`: reverts until `seeded`. Pays tokens plus a refund of `deposit − paid`; adds `paid` to `collected[roundId]`.
- `withdrawProceeds(roundId)`: creator only; pays `collected − lpMon − alreadyWithdrawn` when positive.
- Invariants to fuzz: per-round MON balance = unclaimed deposits + `collected` − `lpMon` − withdrawn − slashed ≥ 0. Per-round tokens deposited = claimed allocations + `lpTokens` + leftovers, exactly.

## DEX adapters (decisions 23, 26)

- Interface `IDexAdapter.seed(token, tokenAmount, monAmount, price) returns (address pool, uint256 nftId)`.
- `UniswapV3Adapter`, P0. Monad chain 143, verified on-chain: factory `0x204faca1764b154221e35c0d20abb3c525710498`, NonfungiblePositionManager `0x7197e214c0b767cfb76fb734ab638e2c192f4e53`, WMON `0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A`. Wrap MON; `createAndInitializePoolIfNecessary` at the `sqrtPriceX96` for P; full-range mint.
- Pre-existing pool: read `slot0`; revert if its price deviates from P by more than a constructor-set tolerance.
- `PancakeSwapV3Adapter`, P1: same interface. Addresses **not verified** — leave them as `// TODO: not specified` constructor params.
- Creator passes `[(adapter, bps)]` at `openRound`; bps must sum to 10000. Allow-list the adapters in the engine so a creator cannot pass an arbitrary contract that receives the proceeds.

## LP lock — GoPlus (decisions 24, 28)

- `UniV3LPLocker` at `0x24A9eB23De8E6f59BDB981B03E847F0f3ABbFa0d`, verified on Monad.
- `lock(INonfungiblePositionManager nftManager_, uint256 nftId_, address owner_, address collector_, uint256 endTime_, string feeName_) payable returns (uint256 lockId)`. Source: https://docs.gopluslabs.io/page/goplus-safetoken-locker
- Fee tiers, read on-chain: `DEFAULT` takes 0.40% of the position plus 1.60% of collected fees; `LVP` 0.64% / 0.80%; `LLP` 0.24% / 2.80%. No MON is sent (`msg.value = 0`).
- Degen (decision 28, settled): `owner_` = the engine. The engine has no function that calls `unlock`, so the lock is permanent. `collector_` = creator. Raise: `owner_` = creator, `endTime_` = the creator's unlock date.
- **Confirm with a fork test before relying on either:** how the locker takes the NFT (approve then lock, or `safeTransferFrom` with data), and the largest `endTime_` it accepts. Do not assume.

## Unsold supply (decision 29, settled)
- When a round is undersubscribed, unsold supply plus the unused LP reserve goes to one internal function `_disposeUnsold(roundId)`, called at the end of `seedLP`.
- **Degen:** transfer to `0x000000000000000000000000000000000000dEaD`. Not `address(0)`: many tokens revert on transfers to zero.
- **Raise:** transfer to the creator.
- Test both, including the fully subscribed case, where the amount is zero.

## Tests (P0)
- Fork test on Monad mainnet (`forge test --fork-url https://rpc.monad.xyz`): seed, lock, then check the pool price is within one tick of P and the lock exists in the locker.
- A pre-created pool at a bad price reverts.
- `claim` before seeding reverts.
- The two accounting invariants above, fuzzed.

When done: `forge build && forge test`, then list every changed function in 5 lines.
