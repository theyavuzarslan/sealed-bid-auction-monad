// End-to-end check against a fresh local anvil:   node web/e2e.mjs
// Needs Foundry (anvil, forge) on PATH or in ~/.foundry/bin. Uses port E2E_PORT (default 8546).
//
// Starts anvil, deploys with contracts/script/DeployLocal.s.sol, then drives rounds through the
// same modules the browser UI uses (web/js/bid.js, note.js, merkle.js, engine.js):
//   Degen: commit (with encrypted notes) → reveal (local bid, and one recovered from the on-chain
//          note) with hints → burnUnrevealed → settle in single steps → seedLP → quote → claim →
//          withdrawProceeds → sweepDust
//   Raise: Merkle allowlist accepted on-chain (and rejected for outsiders) → reveal → settle →
//          seedLP → claim with TGE share → claimVested after the vesting period
import { webDir } from "./node-env.mjs";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const bid = await import("./js/bid.js");
const note = await import("./js/note.js");
const merkle = await import("./js/merkle.js");
const { makeEngine, recoverBidFromNote, checkBidAgainstCommitment, revertReason, PRESET, NO_HINT } = await import("./js/engine.js");
const cfg = (await import("./config.js")).default;

const PORT = Number(process.env.E2E_PORT || 8546);
const RPC = `http://127.0.0.1:${PORT}`;
const env = { ...process.env, PATH: `${path.join(os.homedir(), ".foundry/bin")}:${process.env.PATH}` };
const contractsDir = path.join(webDir, "../contracts");

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const ok = actual === expected;
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      expected: ${expected}\n      actual:   ${actual}`}`);
  return ok;
}

let id = 0;
async function request(method, params = []) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }, (k, v) => typeof v === "bigint" ? "0x" + v.toString(16) : v),
  });
  const j = await res.json();
  if (j.error) throw Object.assign(new Error(j.error.message), { data: j.error.data, code: j.error.code });
  return j.result;
}

// Simulate first (to surface revert reasons), then send from an unlocked anvil account.
async function send(from, t) {
  const tx = { from, to: t.to, data: t.data, value: "0x" + BigInt(t.value ?? 0n).toString(16) };
  await request("eth_call", [tx, "latest"]);
  const hash = await request("eth_sendTransaction", [tx]);
  let rc = null;
  for (let i = 0; !rc; i++) {
    rc = await request("eth_getTransactionReceipt", [hash]);
    if (!rc) { if (i > 100) throw new Error(`no receipt for ${hash}`); await new Promise((r) => setTimeout(r, 20)); }
  }
  if (rc.status !== "0x1") throw new Error(`reverted: ${hash}`);
  return rc;
}
async function expectRevert(name, from, t, reason) {
  try {
    await request("eth_call", [{ from, to: t.to, data: t.data, value: "0x" + BigInt(t.value ?? 0n).toString(16) }, "latest"]);
    check(name, "no revert", reason);
  } catch (e) {
    check(name, revertReason(e), reason);
  }
}
const now = async () => BigInt((await request("eth_getBlockByNumber", ["latest", false])).timestamp);
const warpTo = async (ts) => {
  await request("evm_setNextBlockTimestamp", ["0x" + BigInt(ts).toString(16)]);
  await request("evm_mine", []);
};
const balance = async (a) => BigInt(await request("eth_getBalance", [a, "latest"]));
const signBackup = (who, chainId, engine, roundId) =>
  request("eth_signTypedData_v4", [who, JSON.stringify(note.backupTypedData({ chainId, engine, roundId }))]);
const E18 = 10n ** 18n;

let anvil;
try {
  // ── Chain + deploy ──
  anvil = spawn("anvil", ["--port", String(PORT), "--silent"], { env, stdio: "ignore" });
  for (let i = 0; ; i++) {
    try { await request("eth_chainId"); break; } catch { if (i > 50) throw new Error("anvil did not start"); await new Promise((r) => setTimeout(r, 100)); }
  }
  const dep = spawnSync("forge", ["script", "script/DeployLocal.s.sol", "--rpc-url", RPC, "--broadcast"], { cwd: contractsDir, env, encoding: "utf8" });
  if (dep.status !== 0) throw new Error("DeployLocal failed:\n" + dep.stdout + dep.stderr);
  const local = JSON.parse(readFileSync(path.join(contractsDir, "deployments/local.json"), "utf8"));
  const chainId = Number(BigInt(await request("eth_chainId")));
  check("chain id matches config.networks.local", chainId, cfg.networks.local.chainId);
  for (const k of ["auctionEngine", "token", "adapter", "positionManager", "locker"]) {
    check(`deployments/local.json ${k} matches config default`, local[k].toLowerCase(), cfg.networks.local.deployment[k].toLowerCase());
  }

  const engine = makeEngine({ request, address: local.auctionEngine });
  const [creator, alice, bob, carol, dave, eve, frank, gina] = await request("eth_accounts");
  const token = local.token;

  // ═══ Round 1: Degen ═══════════════════════════════════════════════════════
  const t0 = await now();
  const degen = {
    preset: PRESET.Degen, token, sellAmount: 1000n * E18, depositAmount: E18, minBidSize: E18 / 100n,
    tickSize: 10n ** 14n, reservePrice: 10n ** 14n, commitEnd: t0 + 3600n, revealEnd: t0 + 7200n,
    allowlistRoot: "0x" + "00".repeat(32), allowlistURI: "", lpShareBps: 2000n,
    dexSplits: [{ adapter: local.adapter, bps: 10000n, fee: 3000n }],
    lockEnd: 0n, lockFeeTier: "DEFAULT", tgeBps: 0n, cliff: 0n, vestDuration: 0n,
  };
  const need = degen.sellAmount + degen.sellAmount * degen.lpShareBps / 10000n;
  await send(creator, engine.erc20.approveTx(token, engine.address, need));
  check("allowance covers sell amount + LP reserve", await engine.erc20.allowance(token, creator, engine.address), need);
  const openRc = await send(creator, engine.tx.openRound(degen));
  const opened = openRc.logs.map((l) => engine.iface.decodeLog(l)).find((l) => l?.event === "RoundOpened");
  const r1 = opened.args.roundId;
  const round1 = await engine.getRound(r1);
  check("getRound decodes creator/deposit/tick", `${round1.creator}/${round1.depositAmount}/${round1.tickSize}/${round1.lockFeeTier}`,
    `${creator.toLowerCase()}/${E18}/${10n ** 14n}/DEFAULT`);
  check("splitsOf decodes the default DEX split", JSON.stringify((await engine.splitsOf(r1)).map((s) => [s.adapter, String(s.bps), String(s.fee)])),
    JSON.stringify([[local.adapter.toLowerCase(), "10000", "3000"]]));

  // Bids: A 600 @ 5e14, B 500 @ 4e14, C 300 @ 4e14, D 400 @ 3e14; E commits and never reveals;
  // F seals a bid the UI would block (max spend ≥ deposit) to show the contract agrees.
  const plan = [
    { who: alice, price: 5n * 10n ** 14n, amount: 600n * E18 },
    { who: bob, price: 4n * 10n ** 14n, amount: 500n * E18 },
    { who: carol, price: 4n * 10n ** 14n, amount: 300n * E18 },
    { who: dave, price: 3n * 10n ** 14n, amount: 400n * E18 },
    { who: eve, price: 3n * 10n ** 14n, amount: 100n * E18 },
    { who: frank, price: 10n ** 15n, amount: 1000n * E18 },
  ];
  for (const p of plan.slice(0, 5)) check(`bidProblems empty for ${p.who.slice(0, 8)}`, bid.bidProblems(round1, p.price, p.amount).length, 0);
  check("bidProblems blocks frank (max spend == deposit)", bid.bidProblems(round1, plan[5].price, plan[5].amount).map((x) => x.code).join(), "AT_OR_ABOVE_DEPOSIT");

  // Determinism check, as the UI does on first use per wallet: sign twice, compare.
  const s1 = await signBackup(bob, chainId, engine.address, r1);
  const s2 = await signBackup(bob, chainId, engine.address, r1);
  check("anvil signer is deterministic (sign twice)", note.signaturesMatch(s1, s2), true);

  const sealed = new Map();
  for (const p of plan) {
    const salt = bid.generateSalt();
    const b = { price: p.price, amount: p.amount, salt };
    const hash = bid.commitHash(p.price, p.amount, salt, p.who);
    const key = await note.keyFromSignature(await signBackup(p.who, chainId, engine.address, r1));
    const n = await note.encryptNote(key, b, { chainId, engine: engine.address, roundId: r1, bidder: p.who });
    await send(p.who, engine.tx.commit(r1, hash, [], n, round1.depositAmount));
    sealed.set(p.who, { ...b, hash });
  }
  await expectRevert("commit with the wrong deposit reverts", gina, engine.tx.commit(r1, "0x" + "11".repeat(32), [], "0x", E18 - 1n), "wrong deposit");
  await expectRevert("second commit from one address reverts", alice, engine.tx.commit(r1, "0x" + "11".repeat(32), [], "0x", E18), "already committed");
  const led = await engine.ledgers(r1);
  check("commitment count (public by design)", led.commits, 6n);
  const cl = await engine.committedLogs(r1);
  check("Committed logs carry fixed-length notes", cl.every((l) => (l.args.note.length - 2) / 2 === note.NOTE_LEN), true);

  // Reveal window.
  await warpTo(degen.commitEnd);
  // Alice: bid from "localStorage" (kept in memory here), checked against the commitment first.
  const aliceBid = sealed.get(alice);
  check("local bid matches on-chain commitment", (await checkBidAgainstCommitment(engine, r1, alice, aliceBid)).ok, true);
  await send(alice, engine.tx.reveal(r1, aliceBid, await engine.findHint(r1, aliceBid.price)));
  // Bob: recovery from the wallet only — re-sign, fetch Committed, decrypt, compare hash, reveal.
  const bobRecovered = await recoverBidFromNote({ engine, chainId, roundId: r1, bidder: bob, signature: await signBackup(bob, chainId, engine.address, r1) });
  check("recovered bid (Bob) == sealed bid", `${bobRecovered.price}/${bobRecovered.amount}/${bobRecovered.salt}`,
    `${sealed.get(bob).price}/${sealed.get(bob).amount}/${sealed.get(bob).salt}`);
  let wrongKey = null;
  try { await recoverBidFromNote({ engine, chainId, roundId: r1, bidder: bob, signature: await signBackup(carol, chainId, engine.address, r1) }); } catch (e) { wrongKey = e.code; }
  check("another wallet's signature cannot recover Bob's bid", wrongKey, "DECRYPT_FAILED");
  const bobHint = await engine.findHint(r1, bobRecovered.price);
  check("findHint returns the level above (5e14)", bobHint, 5n * 10n ** 14n);
  await send(bob, engine.tx.reveal(r1, bobRecovered, bobHint));
  const carolBid = sealed.get(carol);
  await send(carol, engine.tx.reveal(r1, carolBid, await engine.findHint(r1, carolBid.price)));
  const daveBid = sealed.get(dave);
  const daveHint = await engine.findHint(r1, daveBid.price);
  check("findHint for the lowest level is 4e14", daveHint, 4n * 10n ** 14n);
  check("reveal with a hint uses revealWithHint", engine.tx.reveal(r1, daveBid, daveHint).data.slice(0, 10), engine.iface.encodeFunction("revealWithHint", [r1, 1n, 1n, "0x" + "00".repeat(32), 1n]).slice(0, 10));
  await send(dave, engine.tx.reveal(r1, daveBid, daveHint));
  await expectRevert("contract rejects the bid the UI blocks", frank, engine.tx.reveal(r1, sealed.get(frank), NO_HINT), "bid exceeds deposit");
  await expectRevert("settle before the reveal window ends reverts", gina, engine.tx.settle(r1, 10n), "reveal window open");

  // After reveal: burn the unrevealed (Eve, Frank), then settle one level per transaction.
  await warpTo(degen.revealEnd);
  const deadBefore = await balance("0x000000000000000000000000000000000000dEaD");
  await send(gina, engine.tx.burnUnrevealed(r1));
  check("burnUnrevealed burns 2 deposits", (await balance("0x000000000000000000000000000000000000dEaD")) - deadBefore, 2n * E18);
  let steps = 0;
  while (!(await engine.clearingOf(r1)).settled) {
    await send(gina, engine.tx.settle(r1, 1n));
    steps++;
    if (steps > 10) throw new Error("settle did not finish");
  }
  check("settle finished over multiple transactions", steps, 2);
  const clr = await engine.clearingOf(r1);
  check("clearing price", clr.clearingPrice, 4n * 10n ** 14n);
  check("oversubscribed", clr.oversubscribed, true);
  await expectRevert("claim before seedLP reverts", alice, engine.tx.claim(r1), "claims not open");

  const seedRc = await send(gina, engine.tx.seedLP(r1));
  const seedEvents = seedRc.logs.map((l) => engine.iface.decodeLog(l)).filter(Boolean);
  check("seedLP emits LPSeeded and ClaimsOpened", ["LPSeeded", "ClaimsOpened"].every((n) => seedEvents.some((e) => e.event === n)), true);
  // LP is sized from the sold lower bound (sold − bids at P) at P (decision 25), rounded down.
  const soldLB = clr.soldLowerBound;
  const lpMon = (soldLB * clr.clearingPrice / E18) * degen.lpShareBps / 10000n;
  check("LP MON = soldLowerBound × P × lpShare", seedEvents.find((e) => e.event === "LPSeeded").args.monAmount, lpMon);
  check("claims open after seedLP", (await engine.getRound(r1)).claimsOpen, true);

  const expected = {
    [alice]: [600n * E18, 24n * E18 / 100n],
    [bob]: [250n * E18, 10n * E18 / 100n],
    [carol]: [150n * E18, 6n * E18 / 100n],
    [dave]: [0n, 0n],
  };
  for (const [who, [alloc, paid]] of Object.entries(expected)) {
    const q = await engine.quote(r1, who);
    check(`quote ${who.slice(0, 8)} alloc/paid/refund`, `${q.allocated}/${q.paid}/${q.refund}`, `${alloc}/${paid}/${E18 - paid}`);
    const tokBefore = await engine.erc20.balanceOf(token, who);
    const rc = await send(who, engine.tx.claim(r1));
    const ev = rc.logs.map((l) => engine.iface.decodeLog(l)).find((e) => e?.event === "Claimed");
    check(`claim ${who.slice(0, 8)} succeeded; Claimed matches quote`, `${ev.args.allocated}/${ev.args.paid}/${ev.args.refund}`, `${q.allocated}/${q.paid}/${q.refund}`);
    check(`claim ${who.slice(0, 8)} delivered tokens`, (await engine.erc20.balanceOf(token, who)) - tokBefore, alloc);
  }
  await expectRevert("second claim reverts", alice, engine.tx.claim(r1), "already settled");
  const avail = await engine.creatorAvailable(r1);
  check("creator proceeds = collected − LP MON", avail, 40n * E18 / 100n - lpMon);
  await expectRevert("only the creator can withdraw", alice, engine.tx.withdrawProceeds(r1), "not creator");
  await send(creator, engine.tx.withdrawProceeds(r1));
  check("proceeds withdrawn", await engine.creatorAvailable(r1), 0n);
  await send(gina, engine.tx.sweepDust(r1));
  check("dust swept", (await engine.getRound(r1)).dustSwept, true);
  check("round 1 MON balance fully accounted", BigInt(await engine.call("roundBalance", [r1])), 0n);

  // ═══ Round 2: Raise with allowlist + LP with unlock date + vesting ═══════
  const members = [alice, bob, "0x" + "a1".repeat(20), "0x" + "b2".repeat(20), "0x" + "c3".repeat(20)];
  const tree = merkle.buildTree(merkle.parseAddressList(members.join("\n")).addresses);
  const t1 = await now();
  const raise = {
    preset: PRESET.Raise, token, sellAmount: 1000n * E18, depositAmount: E18, minBidSize: E18 / 100n,
    tickSize: 10n ** 14n, reservePrice: 10n ** 14n, commitEnd: t1 + 3600n, revealEnd: t1 + 7200n,
    allowlistRoot: merkle.rootOf(tree), allowlistURI: "http://localhost/allowlist.json", lpShareBps: 1000n,
    dexSplits: [{ adapter: local.adapter, bps: 10000n, fee: 3000n }],
    lockEnd: t1 + 86400n * 30n, lockFeeTier: "DEFAULT", tgeBps: 2500n, cliff: 0n, vestDuration: 86400n * 90n,
  };
  await send(creator, engine.erc20.approveTx(token, engine.address, raise.sellAmount + raise.sellAmount / 10n));
  const rc2 = await send(creator, engine.tx.openRound(raise));
  const r2 = rc2.logs.map((l) => engine.iface.decodeLog(l)).find((l) => l?.event === "RoundOpened").args.roundId;
  check("RoundOpened carries allowlistURI", (await engine.roundOpened(r2)).args.allowlistURI, raise.allowlistURI);

  const raiseBids = { [alice]: { price: 2n * 10n ** 14n, amount: 300n * E18 }, [bob]: { price: 10n ** 14n, amount: 200n * E18 } };
  for (const [who, b] of Object.entries(raiseBids)) {
    b.salt = bid.generateSalt();
    const proof = merkle.proofFor(tree, who);
    check(`JS proof verifies for ${who.slice(0, 8)}`, merkle.verifyProof(proof, raise.allowlistRoot, who), true);
    await send(who, engine.tx.commit(r2, bid.commitHash(b.price, b.amount, b.salt, who), proof, "0x", E18));
  }
  check("contract accepted both Merkle proofs", (await engine.ledgers(r2)).commits, 2n);
  check("outsider gets no proof from the tree", merkle.proofFor(tree, carol), null);
  await expectRevert("outsider with an empty proof cannot commit", carol, engine.tx.commit(r2, "0x" + "11".repeat(32), [], "0x", E18), "not on allowlist");
  await expectRevert("Alice's proof does not work for Carol", carol, engine.tx.commit(r2, "0x" + "11".repeat(32), merkle.proofFor(tree, alice), "0x", E18), "not on allowlist");

  await warpTo(raise.commitEnd);
  for (const [who, b] of Object.entries(raiseBids)) await send(who, engine.tx.reveal(r2, b, await engine.findHint(r2, b.price)));
  await warpTo(raise.revealEnd);
  await send(gina, engine.tx.settle(r2, 50n));
  const clr2 = await engine.clearingOf(r2);
  check("undersubscribed Raise clears at the lowest bid", `${clr2.settled}/${clr2.clearingPrice}/${clr2.sold}`, `true/${10n ** 14n}/${500n * E18}`);
  const creatorTokBefore = await engine.erc20.balanceOf(token, creator);
  await send(gina, engine.tx.seedLP(r2));
  check("Raise returns unsold supply to the creator", (await engine.erc20.balanceOf(token, creator)) - creatorTokBefore > 0n, true);
  const aliceTok0 = await engine.erc20.balanceOf(token, alice);
  await send(alice, engine.tx.claim(r2));
  check("Raise claim pays the TGE share (25%)", (await engine.erc20.balanceOf(token, alice)) - aliceTok0, 75n * E18);
  await warpTo((await engine.getRound(r2)).settledAt + raise.vestDuration + 1n);
  const v = await engine.vestedOf(r2, alice);
  check("vestedOf after the vesting period", `${v[0]}/${v[1]}`, `${300n * E18}/${75n * E18}`);
  await send(alice, engine.tx.claimVested(r2));
  check("claimVested releases the rest", (await engine.erc20.balanceOf(token, alice)) - aliceTok0, 300n * E18);
} catch (e) {
  fail++;
  console.log("FAIL  e2e aborted:", e.message, e.data ? `(${revertReason(e)})` : "");
} finally {
  anvil?.kill();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
