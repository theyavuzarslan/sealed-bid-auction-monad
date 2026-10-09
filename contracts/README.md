## Test profiles

| Command (from `contracts/`) | What runs | Time |
| --- | --- | --- |
| `forge test` | Unit, fuzz (512 runs) and the invariant suite (32 runs × depth 128). Scale, fork and symbolic tests are skipped. | ~16 s after compiling |
| `forge test --network monad --hardfork monad:MonadTen` (or `FOUNDRY_PROFILE=monad`) | The same under Monad's gas schedule and execution rules. | ~15 s |
| `FOUNDRY_PROFILE=deep forge test` | Fuzz at 10,000 runs, invariants at 500 runs × depth 256. | ~9 min |
| `FOUNDRY_PROFILE=scale forge test --match-contract ScaleMockTest` | 1,000 bidders over 289 price levels, mocks; prints a gas table. | ~3 s |
| `FOUNDRY_PROFILE=scale forge test --match-contract ScaleForkTest --fork-url https://rpc1.monad.xyz` | Same flow on a Monad mainnet fork with the real Uniswap v3 adapter and GoPlus locker; 200 bidders by default, `SCALE_FORK_BIDDERS=1000` for 1,000. | ~4 min (200), ~18 min (1,000) |
| `forge test --match-path 'test/fork/*' --fork-url https://rpc1.monad.xyz` | Adapter fork tests. | — |

- `test/Scale.t.sol` checks every allocation and payment against a reference computed from the raw bids and reconciles MON and tokens to the wei. Recorded output: `reports/scale-mock-1000.txt`, `reports/scale-fork-1000.txt`.
- `test/invariant/` drives random interleavings of every engine action over up to four concurrent rounds; the invariants are listed in `AuctionEngine.invariant.t.sol`.
- Static analysis (Slither, Aderyn, `forge lint`) and its triage: `STATIC-ANALYSIS.md`, raw output in `reports/`.
- Symbolic proofs (`test/symbolic/`, `forge test --symbolic`): propositions and results in `PROPERTIES.md`.
- Mutation testing of the money path (`tools/mutation/`): `reports/mutation-summary.md`.
- Everything together, with numbers: [`../SECURITY.md`](../SECURITY.md).

## Foundry

**Foundry is a blazing fast, portable and modular toolkit for Ethereum application development written in Rust.**

Foundry consists of:

- **Forge**: Ethereum testing framework (like Truffle, Hardhat and DappTools).
- **Cast**: Swiss army knife for interacting with EVM smart contracts, sending transactions and getting chain data.
- **Anvil**: Local Ethereum node, akin to Ganache, Hardhat Network.
- **Chisel**: Fast, utilitarian, and verbose solidity REPL.

## Documentation

https://book.getfoundry.sh/

## Usage

### Build

```shell
$ forge build
```

### Test

```shell
$ forge test
```

### Format

```shell
$ forge fmt
```

### Gas Snapshots

```shell
$ forge snapshot
```

### Anvil

```shell
$ anvil
```

### Deploy

```shell
$ forge script script/Counter.s.sol:CounterScript --rpc-url <your_rpc_url> --private-key <your_private_key>
```

### Cast

```shell
$ cast <subcommand>
```

### Help

```shell
$ forge --help
$ anvil --help
$ cast --help
```
