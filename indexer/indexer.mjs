// Event indexer for the AuctionEngine on Monad.
//
// Follows one engine address, decodes every event in events.mjs EXPECTED_EVENTS from the contract
// ABI, records what each bidder transaction cost (gas used, gas limit, effective gas price), and
// keeps everything in memory (store.mjs). server.mjs serves the derived views as JSON.
// State is rebuilt from FROM_BLOCK on every start; there is no database.
//
// Zero dependencies: JSON-RPC via fetch, ABI decoding in abi.mjs, HTTP via node:http.
//
// Usage (from indexer/):
//   node indexer.mjs                     # anvil + contracts/deployments/local.json
//   RPC_URL=https://... ENGINE_ADDRESS=0x... FROM_BLOCK=123 node indexer.mjs
// Env: RPC_URL (default http://127.0.0.1:8545), ENGINE_ADDRESS (default: read from DEPLOYMENT,
// default ../contracts/deployments/local.json), FROM_BLOCK (0), CHUNK (100 blocks per eth_getLogs),
// CONFIRMATIONS (0), INTERVAL_MS (2000), PORT (8787), HOST (127.0.0.1), ABI_PATH.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { decodeLog, decodeParams, encodeStaticCall } from "./abi.mjs";
import { buildRegistry, loadAbi } from "./events.mjs";
import { createRpc, toHex } from "./rpc.mjs";
import { Store } from "./store.mjs";
import { createServer } from "./server.mjs";

// Round fields that never change after openRound; the mutable ones are served by the event views.
const CONFIG_FIELDS = [
  "sellAmount", "tokenReserve", "depositAmount", "minBidSize", "tickSize", "reservePrice",
  "commitEnd", "revealEnd", "lpShareBps", "tgeBps", "cliff", "vestDuration", "lockDuration",
  "lockFeeTier", "allowlistRoot",
];

export class Indexer {
  constructor({ rpcUrl, rpc, engine, fromBlock = 0, chunk = 100, confirmations = 0, abi = loadAbi(), store = new Store(), log = () => {} }) {
    if (!engine) throw new Error("engine address required");
    this.rpc = rpc ?? createRpc(rpcUrl);
    this.engine = engine.toLowerCase();
    this.cursor = Number(fromBlock);
    this.chunk = Number(chunk);
    this.confirmations = Number(confirmations);
    this.abi = abi;
    this.registry = buildRegistry(abi);
    this.topics = Object.keys(this.registry);
    this.getRoundFn = abi.find((x) => x.type === "function" && x.name === "getRound");
    this.store = store;
    this.log = log;
    this.blockTimes = new Map();
    this.chainId = null;
  }

  /** Index every block up to the current head (minus confirmations). Safe to call repeatedly. */
  async syncOnce() {
    if (this.chainId == null) this.chainId = Number(BigInt(await this.rpc("eth_chainId")));
    const head = Number(BigInt(await this.rpc("eth_blockNumber"))) - this.confirmations;
    while (this.cursor <= head) {
      const to = Math.min(this.cursor + this.chunk - 1, head);
      const logs = await this.rpc("eth_getLogs", [
        { address: this.engine, fromBlock: toHex(this.cursor), toBlock: toHex(to), topics: [this.topics] },
      ]);
      await this.handle(logs);
      this.cursor = to + 1;
    }
    if (head >= 0) this.store.setHead(head, await this.blockTime(head));
    return head;
  }

  async handle(logs) {
    const decoded = logs
      .filter((l) => !l.removed)
      .map((l) => decodeLog(this.registry, l))
      .filter(Boolean)
      .sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
    for (const rec of decoded) {
      if (rec.blockTimestamp == null) rec.blockTimestamp = await this.blockTime(rec.blockNumber);
      if (!this.store.txs.has(rec.txHash)) this.store.setTx(rec.txHash, await this.txCost(rec.txHash));
      if (this.store.ingest(rec)) {
        this.log(`${rec.event} round=${rec.args.roundId} block=${rec.blockNumber}`);
        if (rec.event === "RoundOpened") this.store.setConfig(rec.args.roundId, await this.roundConfig(rec.args.roundId));
      }
    }
  }

  async blockTime(n) {
    if (!this.blockTimes.has(n)) {
      const b = await this.rpc("eth_getBlockByNumber", [toHex(n), false]);
      this.blockTimes.set(n, Number(BigInt(b.timestamp)));
    }
    return this.blockTimes.get(n);
  }

  async txCost(txHash) {
    const [receipt, tx] = await Promise.all([
      this.rpc("eth_getTransactionReceipt", [txHash]),
      this.rpc("eth_getTransactionByHash", [txHash]),
    ]);
    const price = receipt.effectiveGasPrice ?? tx.gasPrice;
    return {
      from: receipt.from.toLowerCase(),
      status: Number(BigInt(receipt.status)),
      gasUsed: BigInt(receipt.gasUsed),
      gasLimit: tx?.gas != null ? BigInt(tx.gas) : null,
      effectiveGasPrice: BigInt(price),
    };
  }

  async roundConfig(roundId) {
    const data = encodeStaticCall("getRound(uint256)", [roundId]);
    const ret = await this.rpc("eth_call", [{ to: this.engine, data }, "latest"]);
    const round = Object.values(decodeParams(this.getRoundFn.outputs, ret))[0];
    return Object.fromEntries(CONFIG_FIELDS.map((k) => [k, round[k]]));
  }
}

function engineFromDeployment() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const file = process.env.DEPLOYMENT || path.resolve(here, "../contracts/deployments/local.json");
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8")).auctionEngine ?? null;
}

async function main() {
  const rpcUrl = process.env.RPC_URL || "http://127.0.0.1:8545";
  const engine = process.env.ENGINE_ADDRESS || engineFromDeployment();
  if (!engine) {
    console.error("set ENGINE_ADDRESS (or deploy locally so contracts/deployments/local.json exists)");
    process.exit(1);
  }
  const indexer = new Indexer({
    rpcUrl,
    engine,
    fromBlock: process.env.FROM_BLOCK || 0,
    chunk: process.env.CHUNK || 100,
    confirmations: process.env.CONFIRMATIONS || 0,
    log: (m) => console.log(m),
  });
  const port = Number(process.env.PORT || 8787);
  const host = process.env.HOST || "127.0.0.1";
  createServer(indexer).listen(port, host, () => console.log(`indexer: engine=${engine} rpc=${rpcUrl} api=http://${host}:${port}`));
  const interval = Number(process.env.INTERVAL_MS || 2000);
  const loop = async () => {
    try {
      await indexer.syncOnce();
    } catch (e) {
      console.error(`sync failed: ${e.message}`);
    }
    setTimeout(loop, interval);
  };
  loop();
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
