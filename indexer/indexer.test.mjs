// Smoke test for the indexer decoders, no RPC needed.
// Sample logs are hand-assembled per the signatures in events.mjs
// which mirror 06-api.md's Events (proposed) table.
//
// Run:  node indexer/indexer.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { decodeData, decodeLog } from "./indexer.mjs";
import events from "./events.mjs";

// 32-byte word helpers
const w = (n) => n.toString(16).padStart(64, "0");
const addr = (a) => a.toLowerCase().replace(/^0x/, "").padStart(64, "0");
const bytes32 = (h) => h.toLowerCase().padStart(64, "0").slice(-64);

test("every field count matches one word per field (static types only)", () => {
  for (const [topic, ev] of Object.entries(events)) {
    assert.match(topic, /^0x[0-9a-f]{64}$/, `${ev.name} topic0 malformed`);
    assert.ok(ev.signature.startsWith(ev.name), `${ev.name} signature mismatch`);
    assert.equal(ev.fields.length, ev.signature.split(",").length, ev.name);
  }
});

test("decodeData maps one word per field, lowercased", () => {
  const words = ["0x" + w(11n), "0x" + w(22n)];
  const out = decodeData(words, ["roundId", "price"]);
  assert.equal(out.roundId, "0x" + w(11n));
  assert.equal(out.price, "0x" + w(22n));
});

test("Committed decodes roundId, bidder, hash from data", () => {
  const committedTopic = Object.entries(events).find(([, e]) => e.name === "Committed")[0];
  const rec = decodeLog({
    topics: [committedTopic],
    data: "0x" + w(3n) + addr("0x" + "c".repeat(19) + "01") + bytes32("0xab"),
  });
  assert.equal(rec.event, "Committed");
  assert.equal(BigInt(rec.roundId), 3n);
  assert.equal(rec.round, rec.roundId);
  assert.equal(BigInt(rec.bidder), BigInt("0x" + "c".repeat(19) + "01"));
  assert.notDeepEqual(rec.hash, undefined);
  assert.match(rec.hash, /^0x/);
});

test("Cleared decodes multi-word numbers losslessly", () => {
  const clearedTopic = Object.entries(events).find(([, e]) => e.name === "Cleared")[0];
  const rec = decodeLog({
    topics: [clearedTopic],
    data: "0x" + w(1n) + w(123456789n) + w(987654321n),
  });
  assert.equal(rec.event, "Cleared");
  assert.equal(BigInt(rec.clearingPrice), 123456789n);
  assert.equal(BigInt(rec.filledVolume), 987654321n);
});

test("unknown topic0 returns null (no crash on foreign events)", () => {
  assert.equal(decodeLog({ topics: ["0x" + "1".repeat(64)], data: "0x" }), null);
});
