// UI configuration. Anything the docs leave open is a value here, not a guess in code.
//
// `deployment` uses the shape of contracts/deployments/local.json, written by
//   cd contracts && forge script script/DeployLocal.s.sol --rpc-url http://127.0.0.1:8545 --broadcast
// On page load the UI also tries each `deploymentUrls` entry (relative to web/) and uses the first
// that loads, so serving the repo root (page at /web/) picks up a fresh local.json automatically.
// The Network panel on the home page accepts a pasted local.json as a per-browser override.
export default {
  // Local anvil when the page is served from this machine, Monad everywhere else (e.g. on Vercel).
  defaultNetwork: typeof location !== "undefined" && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname) ? "local" : "monad",
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
        tokenFactory: "0x0165878A594ca255338adfa4d48449f69242Eb8F", // deployer nonce 6
      },
    },
    monad: {
      label: "Monad",
      chainId: 143,
      // Public read RPC; writes still go through the wallet. rpc2 is used because it serves eth_getLogs over
      // 10,000 blocks per call (probed 8 Oct, CORS open); rpc1, rpc and rpc3 now cap it at 100 blocks.
      rpcUrl: "https://rpc2.monad.xyz",
      fromBlock: 111880616, // v2 AuctionEngine deploy block (9 Oct 2026); log scans start here
      logChunk: 10000, // blocks per eth_getLogs call; rpc2's limit. Use 100 for the other public RPCs
      deploymentUrls: [],
      deployment: {
        auctionEngine: "0x4Fd754Fa8EaE4E93349e5920B994ace64eaA8ae4", // v2, deployments/143.json; v1 is under legacy
        token: null, // no default token on mainnet: the creator enters theirs
        adapter: "0x71da6a936f1196881C236c62a084ddEB448772Ba", // UniswapV3Adapter, deployments/143-adapter.json
        positionManager: "0x7197E214c0b767cFB76Fb734ab638E2c192F4E53", // Uniswap v3 NonfungiblePositionManager
        locker: "0x24A9eB23De8E6f59BDB981B03E847F0f3ABbFa0d", // GoPlus UniV3LPLocker (decision 24)
        tokenFactory: "0x41F968CcA0a95d4289D356c24668b1c72e645DbF", // deployments/143.json
      },
      // Earlier engines whose rounds stay readable at #/<version>/round/<id>.
      legacy: {
        v1: { auctionEngine: "0x0Fa0E7Db5b2c2146D77E41579030A842492E2120", fromBlock: 110869947 }, // tag mainnet-v1; round 1, deployments/143-v1.json
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
