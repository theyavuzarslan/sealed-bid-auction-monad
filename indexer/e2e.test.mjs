// End-to-end test: run indexer.mjs (INDEXER_ONCE=1) against a fake
// JSON-RPC server serving one head block and one Committed log, then
// assert the JSONL file contains a decoded Committed record.
//
// Run:  node indexer/e2e.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import events from "./events.mjs";

const committedTopic = Object.entries(events).find(([, e]) => e.name === "Committed")[0];

test("indexer end-to-end: fake RPC -> JSONL contains Committed", () => {
  const sampleLog = {
    address: "0xdEaD000000000000000000000000000000000001",
    blockNumber: "0x5",
    transactionHash: "0x" + "f".repeat(64),
    logIndex: "0x1",
    topics: [committedTopic],
    data:
      "0x" +
      BigInt(3).toString(16).padStart(64, "0") +
      ("0x" + "c".repeat(19) + "01").slice(2).padStart(64, "0") +
      "ab".padStart(64, "0"),
  };

  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const { id, method } = JSON.parse(body);
      let result = null;
      if (method === "eth_blockNumber") result = "0x10";
      else if (method === "eth_getLogs") result = [sampleLog];
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
    });
  });

  server.listen(0, "127.0.0.1");
  const port = server.address().port;
  const out = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    `e2e-tmp-${process.pid}.jsonl`,
  );
  const env = {
    ...process.env,
    INDEXER_MAIN: "1",
    INDEXER_ONCE: "1",
    RPC_URL: `http://127.0.0.1:${port}`,
    ENGINE_ADDRESS: "0xdEaD000000000000000000000000000000000001",
    OUT_FILE: out,
  };
  const here = path.dirname(fileURLToPath(import.meta.url));
  const r = spawnSync(process.execPath, ["indexer.mjs"], { env, cwd: here, timeout: 10_000 });
  server.close();
  assert.equal(r.status, 0, `indexer exited ${r.status}: ${r.stderr}`);
  const lines = fs.readFileSync(out, "utf8").split("\n").filter(Boolean);
  assert.equal(lines.length, 1);
  const rec = JSON.parse(lines[0]);
  assert.equal(rec.event, "Committed");
  assert.equal(rec.blockNumber, "0x5");
  assert.equal(BigInt(rec.roundId), 3n);
  assert.match(rec.bidder, /01$/);
  assert.match(rec.txHash, /f{64}$/);
  fs.unlinkSync(out);
});
