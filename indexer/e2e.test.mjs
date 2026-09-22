// End-to-end: anvil + DeployLocal + one full Degen round (+ a small Raise round for VestedClaimed),
// driven with real transactions, then the indexer and its HTTP API are checked against the chain.
//
// Needs Foundry (anvil, forge, cast) on PATH or in ~/.foundry/bin; skipped otherwise.
// Run:  node --test e2e.test.mjs   (or npm run test:e2e)
//
// Side effects: DeployLocal writes contracts/deployments/local.json; the test restores the previous
// file (or removes it) afterwards. forge also writes contracts/broadcast/ and cache/ (gitignored).

import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { keccak256, hexToBytes } from "./keccak.mjs";
import { createRpc, toHex } from "./rpc.mjs";
import { Indexer } from "./indexer.mjs";
import { createServer } from "./server.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const contractsDir = path.resolve(here, "../contracts");
const deploymentFile = path.join(contractsDir, "deployments/local.json");
const env = { ...process.env, PATH: `${path.join(os.homedir(), ".foundry/bin")}:${process.env.PATH}` };
const haveFoundry = ["anvil", "forge", "cast"].every((b) => spawnSync(b, ["--version"], { env }).status === 0);

const E18 = 10n ** 18n;
const E15 = 10n ** 15n;
const E17 = 10n ** 17n;
const BURN = "0x000000000000000000000000000000000000dead";
const OPEN_SIG =
  "openRound((uint8,address,uint128,uint96,uint96,uint96,uint96,uint64,uint64,bytes32,string,uint16,(address,uint16,uint24)[],uint64,string,uint16,uint64,uint64))";

const word = (v) => BigInt(v).toString(16).padStart(64, "0");
const calldata = (sig, ...args) => execFileSync("cast", ["calldata", sig, ...args.map(String)], { env }).toString().trim();
const commitHash = (price, amount, salt, bidder) =>
  keccak256(hexToBytes(word(price) + word(amount) + salt.slice(2) + bidder.slice(2).padStart(64, "0")));

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

test("indexer end-to-end against anvil", { skip: !haveFoundry && "Foundry not installed", timeout: 300_000 }, async (t) => {
  const port = await freePort();
  const rpcUrl = `http://127.0.0.1:${port}`;
  const anvil = spawn("anvil", ["--port", String(port)], { env, stdio: "ignore" });
  const backup = fs.existsSync(deploymentFile) ? fs.readFileSync(deploymentFile) : null;
  t.after(() => {
    anvil.kill();
    if (backup) fs.writeFileSync(deploymentFile, backup);
    else fs.rmSync(deploymentFile, { force: true });
  });

  const rpc = createRpc(rpcUrl);
  for (let i = 0; ; i++) {
    try {
      await rpc("eth_chainId");
      break;
    } catch (e) {
      if (i > 100) throw e;
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  const deploy = spawnSync("forge", ["script", "script/DeployLocal.s.sol", "--rpc-url", rpcUrl, "--broadcast"], {
    cwd: contractsDir,
    env,
    encoding: "utf8",
  });
  assert.equal(deploy.status, 0, `DeployLocal failed:\n${deploy.stdout}\n${deploy.stderr}`);
  const dep = JSON.parse(fs.readFileSync(deploymentFile, "utf8"));
  const engine = dep.auctionEngine.toLowerCase();

  const accounts = (await rpc("eth_accounts")).map((a) => a.toLowerCase());
  const [creator, alice, bob, carol, dave, eve, frank] = accounts;
  const now = async () => Number(BigInt((await rpc("eth_getBlockByNumber", ["latest", false])).timestamp));
  const warp = async (seconds) => {
    await rpc("evm_increaseTime", [seconds]);
    await rpc("evm_mine", []);
  };

  // Every transaction sets its gas limit from eth_estimateGas, as a wallet would; on Monad that limit is what is charged.
  const sent = [];
  async function send(from, data, value = 0n, to = engine) {
    const tx = { from, to, data, value: toHex(value) };
    const gas = await rpc("eth_estimateGas", [tx]);
    const hash = await rpc("eth_sendTransaction", [{ ...tx, gas }]);
    let receipt = null;
    for (let i = 0; !receipt && i < 50; i++) {
      receipt = await rpc("eth_getTransactionReceipt", [hash]);
      if (!receipt) await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(receipt.status, "0x1", `tx ${data.slice(0, 10)} from ${from} reverted`);
    sent.push({ hash, gasUsed: BigInt(receipt.gasUsed), gasLimit: BigInt(gas) });
    return hash;
  }

  const indexer = new Indexer({ rpcUrl, engine, fromBlock: 0, chunk: 3 });

  // ─── Round 1: Degen ────────────────────────────────────────────────
  await send(creator, calldata("approve(address,uint256)", engine, (1n << 256n) - 1n), 0n, dep.token.toLowerCase());
  let t0 = await now();
  const r1 = {
    commitEnd: t0 + 600,
    revealEnd: t0 + 1200,
  };
  const degen = `(0,${dep.token},${1000n * E18},${10n * E18},${10n ** 16n},${E15},${E15},${r1.commitEnd},${r1.revealEnd},0x${"0".repeat(64)},"",5000,[(${dep.adapter},10000,3000)],0,DEFAULT,0,0,0)`;
  await send(creator, calldata(OPEN_SIG, degen));

  const bids = [
    { who: alice, price: 5n * E15, amount: 400n * E18, note: "0x" + "c7".repeat(192) },
    { who: bob, price: 4n * E15, amount: 400n * E18, note: "0x" },
    { who: carol, price: 3n * E15, amount: 300n * E18, note: "0x" },
    { who: dave, price: 3n * E15, amount: 300n * E18, note: "0x" },
    { who: eve, price: 2n * E15, amount: 500n * E18, note: "0x", neverReveals: true },
  ];
  const salt = (who) => "0x" + keccak256("salt:" + who).slice(2);
  for (const b of bids) {
    b.hash = commitHash(b.price, b.amount, salt(b.who), b.who);
    await send(b.who, calldata("commit(uint256,bytes32,bytes32[],bytes)", 1, b.hash, "[]", b.note), 10n * E18);
  }

  // Mid-round sync: commitments are public, demand is not yet.
  await indexer.syncOnce();
  let s = indexer.store;
  assert.equal(s.commitments(1).total, 5);
  assert.equal(s.commitments(1).series.at(-1).count, 5);
  assert.equal(s.summary(1).phase, "commit");
  assert.equal(s.demand(1).levels.length, 0);
  assert.equal(s.summary(1).config.sellAmount, 1000n * E18);
  assert.equal(s.summary(1).config.revealEnd, BigInt(r1.revealEnd));
  assert.equal(s.summary(1).preset, "Degen");

  await warp(600);
  for (const b of bids.filter((b) => !b.neverReveals)) {
    await send(b.who, calldata("reveal(uint256,uint96,uint96,bytes32)", 1, b.price, b.amount, salt(b.who)));
  }
  await warp(600);
  await send(frank, calldata("settle(uint256,uint256)", 1, 100));
  await send(frank, calldata("seedLP(uint256)", 1));
  for (const b of bids.filter((b) => !b.neverReveals)) await send(b.who, calldata("claim(uint256)", 1));
  await send(frank, calldata("burnUnrevealed(uint256)", 1));
  await send(creator, calldata("withdrawProceeds(uint256)", 1));

  // ─── Round 2: Raise with vesting, to exercise VestedClaimed ───────────
  t0 = await now();
  const raise = `(1,${dep.token},${100n * E18},${10n * E18},${10n ** 16n},${E15},${E15},${t0 + 600},${t0 + 1200},0x${"0".repeat(64)},"ipfs://allowlist-none",0,[],0,"",2500,0,1000)`;
  await send(creator, calldata(OPEN_SIG, raise));
  const fb = { price: 2n * E15, amount: 50n * E18 };
  await send(frank, calldata("commit(uint256,bytes32,bytes32[],bytes)", 2, commitHash(fb.price, fb.amount, salt(frank), frank), "[]", "0x"), 10n * E18);
  await warp(600);
  await send(frank, calldata("reveal(uint256,uint96,uint96,bytes32)", 2, fb.price, fb.amount, salt(frank)));
  await warp(600);
  await send(frank, calldata("settle(uint256,uint256)", 2, 100));
  await send(frank, calldata("seedLP(uint256)", 2));
  await send(frank, calldata("claim(uint256)", 2));
  await warp(1000);
  await send(frank, calldata("claimVested(uint256)", 2));

  // ─── Index and check the views ─────────────────────────────────────
  await indexer.syncOnce();
  s = indexer.store;
  const seenEvents = new Set([...s.events(1).events, ...s.events(2).events].map((e) => e.event));
  assert.deepEqual([...seenEvents].sort(), [
    "Claimed", "ClaimsOpened", "Cleared", "Committed", "LPSeeded", "ProceedsWithdrawn",
    "Revealed", "RoundOpened", "UnrevealedBurned", "UnsoldDisposed", "VestedClaimed",
  ]);

  const sum1 = s.summary(1);
  assert.equal(sum1.phase, "claims-open");
  assert.equal(sum1.creator, creator);
  assert.deepEqual([sum1.commitCount, sum1.revealCount, sum1.claimCount], [5, 4, 4]);
  assert.equal(s.reveals(1).unrevealedCount, 1);

  const demand = s.demand(1);
  assert.equal(demand.final, true);
  assert.deepEqual(
    demand.levels.map((l) => [l.price, l.amount, l.bids, l.cumulativeAmount]),
    [
      [5n * E15, 400n * E18, 1, 400n * E18],
      [4n * E15, 400n * E18, 1, 800n * E18],
      [3n * E15, 600n * E18, 2, 1400n * E18],
    ],
  );

  const c = s.clearing(1).clearing;
  assert.deepEqual([c.clearingPrice, c.sold, c.oversubscribed], [3n * E15, 1000n * E18, true]);

  // LP sized from the lower bound of tokens sold (two bids share at P, so 2 wei of rounding slack).
  const soldLB = 1000n * E18 - 2n;
  const lpTokens = (soldLB * 5000n) / 10000n;
  const lpMon = (((soldLB * 3n * E15) / E18) * 5000n) / 10000n;
  const lp = s.lp(1);
  assert.equal(lp.seeds.length, 1);
  assert.equal(lp.seeds[0].adapter, dep.adapter.toLowerCase());
  assert.equal(lp.seeds[0].positionManager, dep.positionManager.toLowerCase());
  assert.deepEqual([lp.seeds[0].tokenAmount, lp.seeds[0].monAmount, lp.seeds[0].nftId], [lpTokens, lpMon, 1n]);
  assert.deepEqual(lp.lockIds, [0n]);
  assert.equal(lp.claimsOpened.lpSeeded, true);
  assert.deepEqual(lp.unsoldDisposed.map((u) => [u.to, u.amount]), [[BURN, 500n * E18 - lpTokens]]);

  const expectClaims = { [alice]: [400n, 12n, 88n], [bob]: [400n, 12n, 88n], [carol]: [100n, 3n, 97n], [dave]: [100n, 3n, 97n] };
  for (const [who, [alloc, paid, refund]] of Object.entries(expectClaims)) {
    const j = s.journey(1, who);
    assert.equal(j.status, "claimed", who);
    assert.deepEqual([j.claim.allocated, j.claim.paid, j.claim.refund], [alloc * E18, paid * E17, refund * E17], who);
    assert.equal(j.journey.complete, true);
    for (const step of [j.commit, j.reveal, j.claim]) {
      assert.equal(step.from, who);
      assert.ok(step.gasUsed > 21000n);
      assert.ok(step.gasLimit >= step.gasUsed);
      assert.equal(step.fee, step.gasUsed * step.effectiveGasPrice);
      assert.equal(step.feeAtGasLimit, step.gasLimit * step.effectiveGasPrice);
      const tx = sent.find((x) => x.hash === step.txHash);
      assert.equal(step.gasUsed, tx.gasUsed);
      assert.equal(step.gasLimit, tx.gasLimit);
    }
  }
  const alice1 = s.journey(1, alice);
  assert.equal(alice1.commit.note, bids[0].note);
  assert.equal(alice1.commit.noteBytes, 192);
  assert.equal(alice1.commit.hash, bids[0].hash);
  assert.equal(alice1.reveal.price, 5n * E15);

  const eveJ = s.journey(1, eve);
  assert.equal(eveJ.status, "burned");
  assert.equal(eveJ.reveal, null);
  assert.deepEqual([sum1.unrevealedBurned.count, sum1.unrevealedBurned.amount], [1n, 10n * E18]);
  assert.equal(sum1.proceedsWithdrawn, 3n * E18 - lpMon);

  // Raise round: vesting and returned unsold supply.
  const sum2 = s.summary(2);
  assert.equal(sum2.preset, "Raise");
  assert.equal(sum2.allowlistURI, "ipfs://allowlist-none");
  assert.equal(s.lp(2).claimsOpened.lpSeeded, false);
  assert.deepEqual(s.lp(2).unsoldDisposed.map((u) => [u.to, u.amount]), [[creator, 50n * E18]]);
  const fj = s.journey(2, frank);
  assert.equal(fj.claim.allocated, 50n * E18);
  assert.deepEqual(fj.vested.map((v) => v.amount), [(50n * E18 * 7500n) / 10000n]);

  // ─── HTTP API over the same indexer ────────────────────────────────
  const server = createServer(indexer).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  t.after(() => server.close());
  const api = async (p) => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${p}`);
    assert.equal(res.status, 200, p);
    return res.json();
  };
  assert.equal((await api("/health")).chainId, 31337);
  assert.equal((await api("/rounds")).rounds.length, 2);
  assert.equal((await api("/rounds/1/demand")).levels[0].price, (5n * E15).toString());
  assert.equal((await api("/rounds/1/clearing")).clearing.clearingPrice, (3n * E15).toString());
  assert.deepEqual((await api("/rounds/1/lp")).lockIds, ["0"]);
  assert.equal((await api(`/rounds/1/bidders/${eve}`)).status, "burned");
  const bidders = await api("/rounds/1/bidders");
  assert.equal(bidders.bidders.length, 5);
  assert.equal(bidders.gas.completeJourney.count, 4);

  // Report what the bidder journey cost on anvil (gas is chain-independent; price is not).
  const rows = bidders.bidders.map((j) => ({
    bidder: j.bidder.slice(0, 8),
    status: j.status,
    commit: j.commit.gasUsed,
    reveal: j.reveal?.gasUsed ?? "-",
    claim: j.claim?.gasUsed ?? "-",
    journeyGasUsed: j.journey.gasUsed,
    journeyGasLimit: j.journey.gasLimit,
  }));
  t.diagnostic("anvil receipts, round 1 (gas limit = eth_estimateGas):\n" + rows.map((r) => JSON.stringify(r)).join("\n"));
});
