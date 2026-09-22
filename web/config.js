// UI configuration. Anything the docs leave open is a value here, not a guess in code.
//
// `deployment` uses the shape of contracts/deployments/local.json, written by
//   cd contracts && forge script script/DeployLocal.s.sol --rpc-url http://127.0.0.1:8545 --broadcast
// On page load the UI also tries each `deploymentUrls` entry (relative to web/) and uses the first
// that loads, so serving the repo root (page at /web/) picks up a fresh local.json automatically.
// The Network panel on the home page accepts a pasted local.json as a per-browser override.
export default {
  defaultNetwork: "local",
  networks: {
    local: {
      label: "Local anvil",
      chainId: 31337,
      rpcUrl: "http://127.0.0.1:8545",
      fromBlock: 0,
      logChunk: null, // blocks per eth_getLogs call; null = one call
      deploymentUrls: ["deployments/local.json", "../contracts/deployments/local.json"],
      // What DeployLocal produces on a fresh anvil (deployer nonces 0–4); web/e2e.mjs checks this.
      deployment: {
        auctionEngine: "0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9",
        token: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
        adapter: "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0",
        positionManager: "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512",
        locker: "0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9",
      },
    },
    monad: {
      label: "Monad",
      chainId: 143,
      rpcUrl: null, // TODO: public read RPC; null = read through the connected wallet
      fromBlock: 0, // TODO: set to the engine's deploy block so log scans stay short
      logChunk: null, // TODO: set if the RPC caps eth_getLogs block ranges
      deploymentUrls: [],
      deployment: {
        auctionEngine: null, // TODO: after mainnet deploy
        token: null, // no default token on mainnet: the creator enters theirs
        adapter: null, // TODO: Uniswap v3 adapter address after deploy
        positionManager: null,
        locker: "0x24A9eB23De8E6f59BDB981B03E847F0f3ABbFa0d", // GoPlus UniV3LPLocker (decision 24)
      },
    },
  },

  pollMs: 4000,
  settleStepsPerTx: 100, // price levels per settle() call
  ipfsGateway: "https://ipfs.io/ipfs/", // resolves ipfs:// allowlist URIs
  monPriceUsd: null, // optional, for the fee line in USD; null = MON only

  // Creator form defaults (decision 32 for vesting; tasks brief for the DEX split).
  creatorDefaults: {
    dexFee: 3000,
    lockFeeTier: "DEFAULT",
    lockDays: "180", // Raise LP lock from seeding; the contract's minimum is 30 days
    lpSharePct: "20",
    tgePct: "25",
    cliffDays: "0",
    vestDays: "90",
  },
};
