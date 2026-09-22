// Unit tests: keccak, ABI decoding of every engine event, derived views, HTTP API. No RPC needed.
// Run:  node --test indexer.test.mjs   (or npm test)

import test from "node:test";
import assert from "node:assert/strict";
import { keccak256 } from "./keccak.mjs";
import { decodeLog, decodeParams, encodeStaticCall, eventRegistry, jsonReplacer } from "./abi.mjs";
import { buildRegistry, EXPECTED_EVENTS, loadAbi } from "./events.mjs";
import { Store } from "./store.mjs";
import { createServer } from "./server.mjs";
import { parseGasPrice, parseProbe, report, formatMon } from "./fee-report.mjs";

// ─── encoding helpers for hand-built logs ─────────────────────────────
const u = (n) => (BigInt(n) < 0n ? (1n << 256n) + BigInt(n) : BigInt(n)).toString(16).padStart(64, "0");
const ad = (x) => x.slice(2).toLowerCase().padStart(64, "0");
const dyn = (hex) => {
  const b = hex.slice(2);
  return u(b.length / 2) + b.padEnd(Math.ceil(b.length / 64) * 64, "0");
};
const utf8hex = (s) => "0x" + Buffer.from(s, "utf8").toString("hex");

const abi = loadAbi();
const registry = buildRegistry(abi);
const topicOf = (name) => Object.entries(registry).find(([, e]) => e.name === name)[0];

const ALICE = "0x00000000000000000000000000000000000a11ce";
const BOB = "0x0000000000000000000000000000000000000b0b";
const EVE = "0x0000000000000000000000000000000000000e7e";
const CREATOR = "0x000000000000000000000000000000000c0ffee0";
const TOKEN = "0x0000000000000000000000000000000000070c3e";
const ADAPTER = "0x00000000000000000000000000000000000ada97";
const NPM = "0x0000000000000000000000000000000000000411";
const DEAD = "0x000000000000000000000000000000000000dead";

let logIndex = 0;
function log(name, topics, data, block = 10, tx = "0x" + "aa".repeat(32)) {
  return {
    address: "0x" + "11".repeat(20),
    topics: ["0x" + topicOf(name).slice(2), ...topics.map((t) => "0x" + t)],
    data: "0x" + data,
    blockNumber: "0x" + block.toString(16),
    transactionHash: tx,
    logIndex: "0x" + (logIndex++).toString(16),
  };
}

// ─── keccak / registry ────────────────────────────────────────────────

test("keccak256 matches known vectors", () => {
  assert.equal(keccak256(""), "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
  assert.equal(keccak256("abc"), "0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45");
  assert.equal(keccak256("Transfer(address,address,uint256)"), "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef");
  // multi-block input (rate is 136 bytes), cross-checked with `cast keccak`
  assert.equal(keccak256("a".repeat(300)), "0x5b7e0e47a96f32a88b4f14ca177982790807c40e1a105742ba0fc1babe1ef826");
});

test("registry holds exactly the 11 engine events, with topic0 pinned to `cast keccak`", () => {
  const golden = {
    RoundOpened: "0xc224542a71761c7ae92ac7ed9b95e048b8e5f2014e530d813a6bfaf449a595f6",
    Committed: "0x8daffcd94bd021b70deafcb36e489fb123de1c46c815e498394ee7d0253cbc38",
    Revealed: "0x670fdee14fc1ce4786a226c21882f5de6bcb4c96e9e72ed8cbdf75f2f5442f1d",
    UnrevealedBurned: "0xea9a8c876f6e7f0127519b81519cc0260e7d2f696199c32a46ab20e7068f96b1",
    Cleared: "0xd29f837bd6fcae3a2fdd105a99b593a744e242316d4a9fd6ed59ab730afa9aee",
    LPSeeded: "0xf94ab1c528736fc591a56689734220697a7f7ca53fa374f6fdde151b1cb5552f",
    ClaimsOpened: "0x56ae42249755e61b4409fd2a072c80b26f4a4dc6be8972eafddf9823776ced73",
    UnsoldDisposed: "0x4ee85809a1db2f7fd22ce6c1d417d8ddaaa4ac8e25e9f9362a2d2a1f6efef194",
    Claimed: "0x528937b330082d892a98d4e428ab2dcca7844b51d227a1c0ae67f0b5261acbd9",
    VestedClaimed: "0x91a4d47b34b2149c2bffac92455fd5cdd24cbcdb8fb3811990a2ec7da68bd4f5",
    ProceedsWithdrawn: "0xfb9162e0e6f61275329ea60e067830394da2cdb58c7408290b5fae09d6ba2f3c",
  };
  const names = Object.values(registry).map((e) => e.name).sort();
  assert.deepEqual(names, [...EXPECTED_EVENTS].sort());
  for (const [name, topic] of Object.entries(golden)) assert.equal(topicOf(name), topic, name);
});

test("buildRegistry fails loudly when the ABI lacks an expected event", () => {
  const trimmed = abi.filter((x) => !(x.type === "event" && x.name === "LPSeeded"));
  assert.throws(() => buildRegistry(trimmed), /missing events: LPSeeded/);
});

// ─── decoding every event ─────────────────────────────────────────────

test("RoundOpened: three indexed topics, enum and dynamic string in data", () => {
  const uri = "ipfs://allowlist-tree.json";
  const rec = decodeLog(registry, log("RoundOpened", [u(7), ad(CREATOR), ad(TOKEN)], u(1) + u(64) + dyn(utf8hex(uri))));
  assert.equal(rec.event, "RoundOpened");
  assert.deepEqual(rec.args, { roundId: 7n, creator: CREATOR, token: TOKEN, preset: 1n, allowlistURI: uri });
  assert.equal(rec.blockNumber, 10);
});

test("Committed: note is dynamic bytes, not a multiple of 32 long", () => {
  const note = "0x" + "ab".repeat(45);
  const hash = "0x" + "12".repeat(32);
  const rec = decodeLog(registry, log("Committed", [u(1), ad(ALICE)], hash.slice(2) + u(64) + dyn(note)));
  assert.deepEqual(rec.args, { roundId: 1n, bidder: ALICE, hash, note });
  const empty = decodeLog(registry, log("Committed", [u(1), ad(BOB)], hash.slice(2) + u(64) + u(0)));
  assert.equal(empty.args.note, "0x");
});

test("Revealed, Cleared, Claimed, VestedClaimed, ProceedsWithdrawn decode numbers losslessly", () => {
  const big = (1n << 96n) - 1n;
  let rec = decodeLog(registry, log("Revealed", [u(1), ad(ALICE)], u(5n * 10n ** 15n) + u(big)));
  assert.deepEqual(rec.args, { roundId: 1n, bidder: ALICE, price: 5n * 10n ** 15n, amount: big });
  rec = decodeLog(registry, log("Cleared", [u(1)], u(3n * 10n ** 15n) + u(1000n * 10n ** 18n) + u(1)));
  assert.deepEqual(rec.args, { roundId: 1n, clearingPrice: 3n * 10n ** 15n, sold: 1000n * 10n ** 18n, oversubscribed: true });
  rec = decodeLog(registry, log("Claimed", [u(1), ad(ALICE)], u(400n * 10n ** 18n) + u(12n * 10n ** 17n) + u(88n * 10n ** 17n)));
  assert.deepEqual(rec.args, { roundId: 1n, bidder: ALICE, allocated: 400n * 10n ** 18n, paid: 12n * 10n ** 17n, refund: 88n * 10n ** 17n });
  rec = decodeLog(registry, log("VestedClaimed", [u(2), ad(BOB)], u(75)));
  assert.deepEqual(rec.args, { roundId: 2n, bidder: BOB, amount: 75n });
  rec = decodeLog(registry, log("ProceedsWithdrawn", [u(2)], u(2n ** 255n)));
  assert.deepEqual(rec.args, { roundId: 2n, amount: 2n ** 255n });
});

test("UnrevealedBurned, LPSeeded, ClaimsOpened, UnsoldDisposed decode", () => {
  let rec = decodeLog(registry, log("UnrevealedBurned", [u(1)], u(1) + u(10n ** 19n)));
  assert.deepEqual(rec.args, { roundId: 1n, count: 1n, amount: 10n ** 19n });
  rec = decodeLog(registry, log("LPSeeded", [u(1), ad(ADAPTER)], ad(NPM) + u(1) + u(499) + u(1497) + u(0)));
  assert.deepEqual(rec.args, { roundId: 1n, adapter: ADAPTER, positionManager: NPM, nftId: 1n, tokenAmount: 499n, monAmount: 1497n, lockId: 0n });
  rec = decodeLog(registry, log("ClaimsOpened", [u(1)], u(0)));
  assert.deepEqual(rec.args, { roundId: 1n, lpSeeded: false });
  rec = decodeLog(registry, log("UnsoldDisposed", [u(1), ad(DEAD)], u(3)));
  assert.deepEqual(rec.args, { roundId: 1n, to: DEAD, amount: 3n });
});

test("foreign topics decode to null; a wrong topic count throws", () => {
  assert.equal(decodeLog(registry, { topics: ["0x" + "1".repeat(64)], data: "0x" }), null);
  assert.throws(() => decodeLog(registry, log("Claimed", [u(1)], u(1) + u(2) + u(3))), /expected 3 topics/);
});

test("decodeParams handles nested tuples with dynamic members and arrays", () => {
  const params = [{
    name: "r",
    type: "tuple",
    components: [
      { name: "a", type: "uint64" },
      { name: "s", type: "string" },
      { name: "ok", type: "bool" },
      { name: "splits", type: "tuple[]", components: [{ name: "adapter", type: "address" }, { name: "bps", type: "uint16" }] },
      { name: "neg", type: "int16" },
    ],
  }];
  // tuple is dynamic -> offset word, then its head: a, offset(s), ok, offset(splits), neg
  const head = u(9) + u(5 * 32) + u(1) + u(5 * 32 + 64) + u(-2);
  const s = dyn(utf8hex("DEFAULT"));
  const splits = u(2) + ad(ADAPTER) + u(6000) + ad(NPM) + u(4000);
  const out = decodeParams(params, "0x" + u(32) + head + s + splits);
  assert.deepEqual(out.r, {
    a: 9n, s: "DEFAULT", ok: true, neg: -2n,
    splits: [{ adapter: ADAPTER, bps: 6000n }, { adapter: NPM, bps: 4000n }],
  });
});

test("the real getRound output decodes (tuple with a string in the middle)", () => {
  const fn = abi.find((x) => x.name === "getRound");
  const comps = fn.outputs[0].components;
  const values = { creator: CREATOR, token: TOKEN, preset: 1n, sellAmount: 1000n, commitEnd: 111n, revealEnd: 222n, lockFeeTier: "LVP", claimsOpen: true };
  const headWords = [];
  let tail = "";
  const headLen = comps.length * 32;
  for (const c of comps) {
    if (c.type === "string") {
      headWords.push(u(headLen + tail.length / 2));
      tail += dyn(utf8hex(values[c.name]));
    } else if (c.type === "address") headWords.push(ad(values[c.name] ?? "0x" + "00".repeat(20)));
    else if (c.type === "bool") headWords.push(u(values[c.name] ? 1 : 0));
    else if (c.type === "bytes32") headWords.push(u(0));
    else headWords.push(u(values[c.name] ?? 0n));
  }
  const r = Object.values(decodeParams(fn.outputs, "0x" + u(32) + headWords.join("") + tail))[0];
  for (const [k, v] of Object.entries(values)) assert.deepEqual(r[k], v, k);
});

test("encodeStaticCall builds selector + words", () => {
  assert.equal(encodeStaticCall("getRound(uint256)", [3]), keccak256("getRound(uint256)").slice(0, 10) + u(3));
  assert.equal(Object.keys(eventRegistry([{ type: "event", name: "X", anonymous: true, inputs: [] }])).length, 0);
});

// ─── views ────────────────────────────────────────────────────────────

const E18 = 10n ** 18n;
const P = (milli) => BigInt(milli) * 10n ** 15n; // 0.00x MON per token
const txh = (n) => "0x" + n.toString(16).padStart(64, "0");

function scenarioStore() {
  const store = new Store();
  const put = (l, ts) => {
    const rec = decodeLog(registry, l);
    rec.blockTimestamp = ts;
    store.setTx(rec.txHash, { from: rec.args.bidder ?? CREATOR, status: 1, gasUsed: 50_000n, gasLimit: 60_000n, effectiveGasPrice: 100n * 10n ** 9n });
    store.ingest(rec);
  };
  let n = 1;
  const commitData = (note) => "12".repeat(32) + u(64) + dyn(note);
  put(log("RoundOpened", [u(1), ad(CREATOR), ad(TOKEN)], u(0) + u(64) + dyn("0x"), 1, txh(n++)), 100);
  store.setConfig(1, { sellAmount: 1000n * E18, commitEnd: 200n, revealEnd: 300n });
  put(log("Committed", [u(1), ad(ALICE)], commitData("0xbeef"), 2, txh(n++)), 110);
  put(log("Committed", [u(1), ad(BOB)], commitData("0x"), 2, txh(n++)), 110);
  put(log("Committed", [u(1), ad(EVE)], commitData("0x"), 4, txh(n++)), 130);
  store.setHead(4, 130);
  return { store, put, next: () => txh(n++) };
}

test("commitment count over time groups by block and is cumulative", () => {
  const { store } = scenarioStore();
  assert.deepEqual(store.commitments(1).series, [
    { blockNumber: 2, timestamp: 110, added: 2, count: 2 },
    { blockNumber: 4, timestamp: 130, added: 1, count: 3 },
  ]);
  assert.equal(store.summary(1).phase, "commit");
  assert.equal(store.demand(1).levels.length, 0);
});

test("full round: demand curve, clearing, LP, journeys, burn", () => {
  const { store, put, next } = scenarioStore();
  put(log("Revealed", [u(1), ad(ALICE)], u(P(5)) + u(600n * E18), 5, next()), 210);
  put(log("Revealed", [u(1), ad(BOB)], u(P(3)) + u(700n * E18), 6, next()), 220);
  store.setHead(6, 220);
  assert.equal(store.summary(1).phase, "reveal");
  assert.equal(store.journey(1, EVE).status, "committed");
  store.setHead(7, 300);
  assert.equal(store.journey(1, EVE).status, "unrevealed");

  put(log("Cleared", [u(1)], u(P(3)) + u(1000n * E18) + u(1), 8, next()), 310);
  put(log("LPSeeded", [u(1), ad(ADAPTER)], ad(NPM) + u(1) + u(499n * E18) + u(1497n * 10n ** 15n) + u(0), 9, next()), 320);
  put(log("ClaimsOpened", [u(1)], u(1), 9, txh(99)), 320);
  put(log("Claimed", [u(1), ad(ALICE)], u(600n * E18) + u(18n * 10n ** 17n) + u(82n * 10n ** 17n), 10, next()), 330);
  put(log("UnrevealedBurned", [u(1)], u(1) + u(10n * E18), 11, next()), 340);
  put(log("UnsoldDisposed", [u(1), ad(DEAD)], u(2), 12, next()), 350);
  store.setHead(12, 350);

  const d = store.demand(1);
  assert.equal(d.final, true);
  assert.deepEqual(d.levels.map((l) => [l.price, l.amount, l.bids, l.cumulativeAmount]), [
    [P(5), 600n * E18, 1, 600n * E18],
    [P(3), 700n * E18, 1, 1300n * E18],
  ]);
  assert.equal(d.supply, 1000n * E18);
  assert.equal(store.clearing(1).clearing.clearingPrice, P(3));
  assert.equal(store.clearing(1).clearing.oversubscribed, true);

  const lp = store.lp(1);
  assert.deepEqual(lp.lockIds, [0n]);
  assert.equal(lp.seeds[0].nftId, 1n);
  assert.equal(lp.claimsOpened.lpSeeded, true);
  assert.equal(lp.unsoldDisposed[0].burned, true);

  const alice = store.journey(1, ALICE);
  assert.equal(alice.status, "claimed");
  assert.equal(alice.commit.noteBytes, 2);
  assert.equal(alice.reveal.price, P(5));
  assert.equal(alice.claim.refund, 82n * 10n ** 17n);
  assert.equal(alice.journey.complete, true);
  assert.equal(alice.journey.gasUsed, 150_000n);
  assert.equal(alice.journey.fee, 150_000n * 100n * 10n ** 9n);
  assert.equal(alice.journey.feeAtGasLimit, 180_000n * 100n * 10n ** 9n);
  assert.equal(store.journey(1, BOB).status, "revealed");
  assert.equal(store.journey(1, EVE).status, "burned");
  assert.equal(store.journey(1, "0x" + "99".repeat(20)), null);

  const b = store.bidders(1);
  assert.equal(b.bidders.length, 3);
  assert.deepEqual(b.gas.completeJourney, { count: 1, min: 150_000n, max: 150_000n });
  const s = store.summary(1);
  assert.equal(s.phase, "claims-open");
  assert.deepEqual([s.commitCount, s.revealCount, s.claimCount], [3, 2, 1]);
  assert.equal(s.unrevealedBurned.amount, 10n * E18);
  assert.equal(store.reveals(1).unrevealedCount, 1);
  assert.equal(store.events(1).events.length, 12);
});

test("ingest is idempotent per (txHash, logIndex)", () => {
  const store = new Store();
  const l = log("Committed", [u(1), ad(ALICE)], "12".repeat(32) + u(64) + u(0));
  assert.equal(store.ingest(decodeLog(registry, l)), true);
  assert.equal(store.ingest(decodeLog(registry, l)), false);
  assert.equal(store.commitments(1).total, 1);
});

// ─── HTTP API ─────────────────────────────────────────────────────────

test("HTTP API serves the views as JSON with BigInts as strings", async () => {
  const { store } = scenarioStore();
  const fake = { store, engine: "0x" + "11".repeat(20), chainId: 31337, cursor: 5 };
  const server = createServer(fake).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const get = async (p) => {
      const res = await fetch(base + p);
      return { status: res.status, body: await res.json(), headers: res.headers };
    };
    let r = await get("/health");
    assert.equal(r.status, 200);
    assert.equal(r.body.indexedToBlock, 4);
    r = await get("/rounds");
    assert.equal(r.body.rounds[0].roundId, "1");
    assert.equal(r.headers.get("access-control-allow-origin"), "*");
    r = await get("/rounds/1");
    assert.equal(r.body.commitCount, 3);
    assert.equal(r.body.config.sellAmount, (1000n * E18).toString());
    r = await get("/rounds/1/commitments/");
    assert.equal(r.body.total, 3);
    for (const p of ["/reveals", "/demand", "/clearing", "/lp", "/bidders", "/events", `/bidders/${ALICE}`]) {
      assert.equal((await get("/rounds/1" + p)).status, 200, p);
    }
    r = await get(`/rounds/1/bidders/${ALICE.toUpperCase().replace("0X", "0x")}`);
    assert.equal(r.body.commit.gasUsed, "50000");
    assert.equal((await get("/rounds/1/bidders/0x" + "99".repeat(20))).status, 404);
    assert.equal((await get("/rounds/2")).status, 404);
    assert.equal((await get("/nope")).status, 404);
    assert.equal((await fetch(base + "/rounds", { method: "POST" })).status, 405);
  } finally {
    server.close();
  }
});

test("jsonReplacer turns BigInt into decimal strings", () => {
  assert.equal(JSON.stringify({ a: 2n ** 200n }, jsonReplacer), `{"a":"${(2n ** 200n).toString()}"}`);
});

// ─── fee report ───────────────────────────────────────────────────────

test("fee-report: gas price parsing and MON formatting", () => {
  assert.equal(parseGasPrice("102gwei"), 102_000_000_000n);
  assert.equal(parseGasPrice("0.5 gwei"), 500_000_000n);
  assert.equal(parseGasPrice("7"), 7n);
  assert.throws(() => parseGasPrice("cheap"));
  assert.equal(formatMon(50_000_000_000_000_000n), "0.05");
  assert.equal(formatMon(10n ** 18n), "1.0");
  assert.equal(formatMon(1n), "0.000000000000000001");
});

test("fee-report: prices FEEPROBE journeys, skips incomplete ones in the verdict", () => {
  const text = [
    "noise",
    '  FEEPROBE {"label":"a","noteBytes":0,"commit":{"used":70000,"needed":73000},"reveal":{"used":100000,"needed":103000},"claim":{"used":170000,"needed":173000}}',
    '  FEEPROBE {"label":"b","noteBytes":0,"commit":{"used":76000,"needed":79000},"reveal":{"used":0,"needed":0},"claim":{"used":0,"needed":0}}',
  ].join("\n");
  const journeys = parseProbe(text);
  assert.equal(journeys.length, 2);
  const gasPrice = 100n * 10n ** 9n;
  let r = report({ journeys, gasPrice });
  assert.equal(r.rows[0].totalGas, 349_000n);
  assert.equal(r.rows[0].feeWei, 349_000n * gasPrice);
  assert.equal(r.rows[1].complete, false);
  assert.equal(r.worst.label, "a");
  assert.match(r.verdict, /cannot judge/);
  r = report({ journeys, gasPrice, monUsd: 0.1 });
  assert.match(r.verdict, /^PASS/); // 0.0349 MON * $0.1 = $0.00349
  r = report({ journeys, gasPrice, monUsd: 1 });
  assert.match(r.verdict, /^FAIL/);
  r = report({ journeys, gasPrice, basis: "used", bufferPct: 10 });
  assert.equal(r.rows[0].totalGas, 374_000n); // (70k+100k+170k) * 1.10
});
