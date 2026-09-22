// Event indexer for the sealed-bid auction engine on Monad.
//
// Decodes RoundOpened, Committed, Revealed, Cleared, Claimed, Slashed and
// LPSeeded (06-api.md) out of the engine contract's raw logs and appends
// each decoded record as one JSON line in `indexer/out.jsonl`.
//
// Ownership: the sealing layer, clearing core, deposit ledger and LP
// seeder each emit their own events, so the engine address boundary is
// coarse — the indexer follows one address (ENGINE_ADDRESS). If the
// contracts separate emitters, add per-event from-address filtering here.
//
// Zero runtime dependencies: JSON-RPC via fetch, ABI value decoding by
// hand. Only the seven provisional signatures from events.mjs — re-verify
// there before trusting decoded field order.
//
// Usage:
//   ENGINE_ADDRESS=0x... RPC_URL=https://... INDEXER_MAIN=1 node indexer.mjs
//   (or: npm start inside indexer/)
// Optional: FROM_BLOCK (default 0), OUT_FILE (default indexer/out.jsonl),
// INTERVAL (poll seconds, default 2).

import fs from "node:fs";
import events from "./events.mjs";

// Values come from env only inside start(); imports stay side-effect free
// (see indexer.test.mjs).
let RPC, ENGINE;

function start() {
  RPC = process.env.RPC_URL;
  ENGINE = process.env.ENGINE_ADDRESS;
  if (!RPC || !ENGINE) {
    console.error("set ENGINE_ADDRESS and RPC_URL");
    process.exit(1);
  }
  run();
}

const FROM_BLOCK = BigInt(process.env.FROM_BLOCK || "0");
const OUT_FILE = process.env.OUT_FILE || "indexer/out.jsonl";
const INTERVAL = Number(process.env.INTERVAL || 2);
const CHUNK = 50n; // blocks per eth_getLogs call; keep small for live tailing

let rpcId = 0;
async function rpc(method, params) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  const body = await res.json();
  if (body.error) throw new Error(`rpc ${method}: ${JSON.stringify(body.error)}`);
  return body.result;
}

// ABI static-word decoder for the provisional tables in events.mjs.
// Every field occupies one 32-byte word; dynamic types are not handled
// because none of the seven events use them. Values are returned as hex
// words without interpretation — roundIds, addresses, byte32 hashes all
// round-trip losslessly and the meaning differs per event anyway.
export function decodeData(words, fieldNames) {
  if (fieldNames.length !== words.length) {
    throw new Error(
      `layout mismatch: ${fieldNames.length} fields but ${words.length} data words`,
    );
  }
  const out = {};
  fieldNames.forEach((name, i) => {
    out[name] = words[i].toLowerCase();
  });
  return out;
}

export const sigFor = (topic0) => events[topic0.toLowerCase()];

async function fetchLogs(from, to) {
  const topics = Object.keys(events);
  return rpc("eth_getLogs", [
    {
      address: ENGINE,
      fromBlock: "0x" + from.toString(16),
      toBlock: "0x" + to.toString(16),
      topics: [topics],
    },
  ]);
}

export function decodeLog(log) {
  const topic0 = log.topics[0];
  const sig = sigFor(topic0);
  if (!sig) return null; // not one of ours
  const words =
    log.data === "0x" ? [] : (log.data.slice(2).match(/.{64}/g) || []).map((w) => "0x" + w);
  const fields = decodeData(words, sig.fields);
  return {
    event: sig.name,
    blockNumber: log.blockNumber,
    txHash: log.transactionHash,
    logIndex: log.logIndex,
    round: fields.roundId,
    ...fields,
  };
}

function append(records) {
  fs.appendFileSync(OUT_FILE, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

function tickNames(decoded) {
  decoded.forEach((d) => console.log(`  ${d.event} @ block ${d.blockNumber}`));
}

let cursor = FROM_BLOCK;

async function tick() {
  const head = BigInt(await rpc("eth_blockNumber", []));
  while (cursor <= head) {
    const to = cursor + CHUNK > head ? head : cursor + CHUNK;
    const logs = await fetchLogs(cursor, to);
    const decoded = logs.map(decodeLog).filter(Boolean);
    if (decoded.length) {
      append(decoded);
      console.log(`blocks ${cursor}\u2013${to}:`);
      tickNames(decoded);
    }
    cursor = to + 1n;
  }
}

function run() {
  console.log(`indexer: engine=${ENGINE} rpc=${RPC}`);
  console.log(`output -> ${OUT_FILE}`);
  if (process.env.INDEXER_ONCE === "1") {
    // one catch-up pass then exit; used by e2e tests and CI
    void tick()
      .catch((e) => console.error(e.message))
      .finally(() => process.exit(0));
    return;
  }
  void tick().catch((e) => console.error(e.message)); // first poll now
  setInterval(() => tick().catch((e) => console.error(e.message)), INTERVAL * 1000);
}

if (process.env.INDEXER_MAIN === "1") start();
