// End-to-end check against a fresh local anvil:   node web/e2e.mjs
// Needs Foundry (anvil, forge) on PATH or in ~/.foundry/bin. Uses port E2E_PORT (default 8546).
//
// Starts anvil, deploys with contracts/script/DeployLocal.s.sol, then drives rounds through the
// same modules the browser UI uses (bid.js, note.js, recovery.js, merkle.js, launch.js,
// round-model.js, engine.js):
//   Round 1, Degen: seal (wallet-signed note) → commit → reveal from the local copy and from the
//     on-chain note, always with findHint → burnUnrevealed → settle one level per tx → refund by a
//     third party before seeding → seedLP → claimTokens / claim → disposeUnsold → sweepDust →
//     withdrawProceeds; bids the UI blocks are shown to revert at reveal.
//   Round 2, Raise: launch.js params with allowlist + vesting + 30-day lock; Merkle proof accepted
//     on-chain and rejected for outsiders; claim with TGE share; claimVested; openRound reverts that
//     launch.js also flags.
//   Round 3, Degen: seeding blocked → abandonLP after the grace period → tokens delivered.
import { webDir } from "./node-env.mjs";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const bid = await import("./js/bid.js");
const note = await import("./js/note.js");
const merkle = await import("./js/merkle.js");
const recovery = await import("./js/recovery.js");
const launch = await import("./js/launch.js");
const rm = await import("./js/round-model.js");
const { makeEngine, revertReason, PRESET, ZERO32 } = await import("./js/engine.js");
const { makeInterface } = await import("./js/abicoder.js");
const cfg = (await import("./config.js")).default;

const PORT = Number(process.env.E2E_PORT || 8546);
const RPC = `http://127.0.0.1:${PORT}`;
const env = { ...process.env, PATH: `${path.join(os.homedir(), ".foundry/bin")}:${process.env.PATH}` };
const contractsDir = path.join(webDir, "../contracts");
const BURN = "0x000000000000000000000000000000000000dEaD";
const E18 = 10n ** 18n;

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
const txObj = (from, t) => ({ from, to: t.to, data: t.data, value: "0x" + BigInt(t.value ?? 0n).toString(16) });
// Simulate first (to surface revert reasons), then send from an unlocked anvil account.
async function send(from, t) {
  await request("eth_call", [txObj(from, t), "latest"]);
  const hash = await request("eth_sendTransaction", [txObj(from, t)]);
  for (let i = 0; ; i++) {
    const rc = await request("eth_getTransactionReceipt", [hash]);
    if (rc) { if (rc.status !== "0x1") throw new Error(`reverted: ${hash}`); return rc; }
    if (i > 200) throw new Error(`no receipt for ${hash}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}
async function expectRevert(name, from, t, reason) {
  try {
    await request("eth_call", [txObj(from, t), "latest"]);
    check(name, "no revert", reason);
  } catch (e) {
    check(name, revertReason(e), reason);
  }
}
const now = async () => BigInt((await request("eth_getBlockByNumber", ["latest", false])).timestamp);
const warpTo = async (ts) => { await request("evm_setNextBlockTimestamp", ["0x" + BigInt(ts).toString(16)]); await request("evm_mine", []); };
const balance = async (a) => BigInt(await request("eth_getBalance", [a, "latest"]));
const signerFor = (who) => (typed) => request("eth_signTypedData_v4", [who, JSON.stringify(typed)]);
const events = (engine, rc, name) => engine.decodeReceiptLogs(rc).filter((e) => e.event === name);

let anvil;
try {
  // ── chain + deploy ──
  anvil = spawn("anvil", ["--port", String(PORT), "--silent"], { env, stdio: "ignore" });
  for (let i = 0; ; i++) {
    try { await request("eth_chainId"); break; } catch { if (i > 50) throw new Error("anvil did not start"); await new Promise((r) => setTimeout(r, 100)); }
  }
  const dep = spawnSync("forge", ["script", "script/DeployLocal.s.sol", "--rpc-url", RPC, "--broadcast"], { cwd: contractsDir, env, encoding: "utf8" });
  if (dep.status !== 0) throw new Error("DeployLocal failed:\n" + dep.stdout + dep.stderr);
  const local = JSON.parse(readFileSync(path.join(contractsDir, "deployments/local.json"), "utf8"));
  const chainId = Number(BigInt(await request("eth_chainId")));
  check("chain id matches config.networks.local", chainId, cfg.networks.local.chainId);
  for (const k of ["auctionEngine", "token", "adapter", "positionManager", "locker", "tokenFactory"]) {
    check(`deployments/local.json ${k} matches config default`, local[k].toLowerCase(), cfg.networks.local.deployment[k].toLowerCase());
  }

  const engine = makeEngine({ request, address: local.auctionEngine });
  const [creator, alice, bob, carol, dave, eve, frank, gina, henry] = await request("eth_accounts");
  const token = local.token;
  const tokenInfo = { address: token, decimals: Number(await engine.erc20.decimals(token)) };
  const meta = { grace: await engine.lpGracePeriod() };
  const baseForm = {
    preset: "Degen", sell: "1000", deposit: "1", minBid: "0.01", tick: "0.0001", reserve: "0.0001", commitMinutes: "60",
    revealMinutes: "60", lpOn: true, lpSharePct: "20", splits: [{ adapter: local.adapter, pct: "100", fee: "3000" }],
    lockFeeTier: "DEFAULT", lockDays: "30", allowOn: false, tree: null, allowlistURI: "", vestOn: false, tgePct: "25", cliffDays: "0", vestDays: "90",
  };
  async function open(form) {
    const { params, problems, need } = launch.buildOpenParams(form, tokenInfo, Number(await now()));
    if (problems.length) throw new Error("launch.js rejected params: " + problems.join("; "));
    await send(creator, engine.erc20.approveTx(token, engine.address, need));
    const rc = await send(creator, engine.tx.openRound(params));
    return { id: events(engine, rc, "RoundOpened")[0].args.roundId, params };
  }
  async function sealAndCommit(roundId, round, who, price, amount, proof = []) {
    const ctx = { chainId, engine: engine.address, roundId, bidder: who };
    const sealed = await recovery.sealBid({ price, amount, ctx, signTypedData: signerFor(who) });
    await send(who, engine.tx.commit(roundId, sealed.hash, proof, sealed.note, round.depositAmount));
    return sealed;
  }

  // ═══ Round 1: Degen ═══════════════════════════════════════════════════════
  const { id: r1, params: p1 } = await open(baseForm);
  const round1 = await engine.getRound(r1);
  check("getRound decodes the new Round (lockDuration, lpAbandoned, unsoldOwed)",
    `${round1.creator}/${round1.depositAmount}/${round1.lockDuration}/${round1.lpAbandoned}/${round1.unsoldOwed}/${round1.lockFeeTier}`,
    `${creator.toLowerCase()}/${E18}/0/false/0/DEFAULT`);
  check("splitsOf decodes the default DEX split", JSON.stringify((await engine.splitsOf(r1)).map((s) => [s.adapter, String(s.bps), String(s.fee)])),
    JSON.stringify([[local.adapter.toLowerCase(), "10000", "3000"]]));

  // A 600 @ 5e14, B 500 @ 4e14, C 300 @ 4e14, D 400 @ 3e14; E commits and never reveals.
  // F (max spend == deposit) and H (worth less than minBid at the reserve) are bids the UI blocks.
  const plan = [
    { who: alice, price: 5n * 10n ** 14n, amount: 600n * E18 },
    { who: bob, price: 4n * 10n ** 14n, amount: 500n * E18 },
    { who: carol, price: 4n * 10n ** 14n, amount: 300n * E18 },
    { who: dave, price: 3n * 10n ** 14n, amount: 400n * E18 },
    { who: eve, price: 3n * 10n ** 14n, amount: 100n * E18 },
    { who: frank, price: 10n ** 15n, amount: 1000n * E18, blocked: "AT_OR_ABOVE_DEPOSIT", reason: "bid exceeds deposit" },
    { who: henry, price: 10n ** 15n, amount: 50n * E18, blocked: "BELOW_MIN_BID", reason: "below minimum bid" },
  ];
  for (const p of plan) {
    check(`bidProblems for ${p.who.slice(0, 8)}: ${p.blocked ?? "none"}`, bid.bidProblems(round1, p.price, p.amount).map((x) => x.code).join(), p.blocked ?? "");
  }
  const sealed = new Map();
  for (const p of plan) sealed.set(p.who, await sealAndCommit(r1, round1, p.who, p.price, p.amount));
  check("anvil signer is deterministic: notes are on", [...sealed.values()].every((s) => s.determinism === recovery.DETERMINISTIC && s.note !== "0x"), true);
  await expectRevert("commit with the wrong deposit reverts", gina, engine.tx.commit(r1, "0x" + "11".repeat(32), [], "0x", E18 - 1n), "wrong deposit");
  await expectRevert("second commit from one address reverts", alice, engine.tx.commit(r1, "0x" + "11".repeat(32), [], "0x", E18), "already committed");
  check("commitment count (public by design)", (await engine.ledgers(r1)).commits, 7n);
  check("Committed logs carry fixed-length notes", (await engine.committedLogs(r1)).every((l) => (l.args.note.length - 2) / 2 === note.NOTE_LEN), true);

  // Reveal window.
  await warpTo(p1.commitEnd);
  const aliceBid = sealed.get(alice);
  check("local bid matches on-chain commitment", (await recovery.checkBidAgainstCommitment(engine, r1, alice, aliceBid)).ok, true);
  const revealTx = await engine.buildReveal(r1, aliceBid);
  check("reveals always use revealWithHint", revealTx.data.slice(0, 10), engine.iface.encodeFunction("revealWithHint", [1n, 1n, 1n, ZERO32, 1n]).slice(0, 10));
  await send(alice, revealTx);
  // Bob: from the wallet only — re-sign, fetch Committed, decrypt, compare hash, reveal.
  const bobSig = await signerFor(bob)(note.backupTypedData({ chainId, engine: engine.address, roundId: r1 }));
  const bobRecovered = await recovery.recoverBidFromNote({ engine, chainId, roundId: r1, bidder: bob, signature: bobSig });
  check("recovered bid (Bob) == sealed bid", `${bobRecovered.price}/${bobRecovered.amount}/${bobRecovered.salt}`,
    `${sealed.get(bob).price}/${sealed.get(bob).amount}/${sealed.get(bob).salt}`);
  let wrongKey = null;
  const carolSig = await signerFor(carol)(note.backupTypedData({ chainId, engine: engine.address, roundId: r1 }));
  try { await recovery.recoverBidFromNote({ engine, chainId, roundId: r1, bidder: bob, signature: carolSig }); } catch (e) { wrongKey = e.code; }
  check("another wallet's signature cannot recover Bob's bid", wrongKey, "DECRYPT_FAILED");
  check("findHint returns the level above (5e14)", await engine.findHint(r1, bobRecovered.price), 5n * 10n ** 14n);
  await send(bob, await engine.buildReveal(r1, bobRecovered));
  await send(carol, await engine.buildReveal(r1, sealed.get(carol)));
  check("findHint for the lowest level is 4e14", await engine.findHint(r1, sealed.get(dave).price), 4n * 10n ** 14n);
  await send(dave, await engine.buildReveal(r1, sealed.get(dave)));
  for (const p of plan.filter((x) => x.blocked)) {
    await expectRevert(`contract rejects the bid the UI blocks (${p.blocked})`, p.who, await engine.buildReveal(r1, sealed.get(p.who)), p.reason);
  }
  await expectRevert("settle before the reveal window ends reverts", gina, engine.tx.settle(r1, 10n), "reveal window open");

  // After reveal: burn the unrevealed (E, F, H), settle one level per transaction.
  await warpTo(p1.revealEnd);
  let s1 = await rm.loadRoundState(engine, r1, null);
  check("round model offers burn + settle", rm.publicActions(s1, meta, Number(await now())).map((a) => a.id).join(), "burn,settle");
  const dead0 = await balance(BURN);
  await send(gina, engine.tx.burnUnrevealed(r1));
  check("burnUnrevealed burns 3 deposits", (await balance(BURN)) - dead0, 3n * E18);
  let steps = 0;
  while (!(await engine.clearingOf(r1)).settled) {
    await send(gina, engine.tx.settle(r1, 1n));
    if (++steps > 10) throw new Error("settle did not finish");
  }
  check("settle finished over multiple transactions", steps, 2);
  const clr = await engine.clearingOf(r1);
  check("clearing price 4e14, oversubscribed", `${clr.clearingPrice}/${clr.oversubscribed}`, `${4n * 10n ** 14n}/true`);

  const expected = {
    [alice]: [600n * E18, 24n * E18 / 100n],
    [bob]: [250n * E18, 10n * E18 / 100n],
    [carol]: [150n * E18, 6n * E18 / 100n],
    [dave]: [0n, 0n],
  };
  for (const [who, [alloc, paid]] of Object.entries(expected)) {
    const q = await engine.quote(r1, who);
    check(`quote ${who.slice(0, 8)} alloc/paid/refund`, `${q.allocated}/${q.paid}/${q.refund}`, `${alloc}/${paid}/${E18 - paid}`);
  }
  // Refunds before seeding, triggered by a third party; the MON goes to the bidder.
  s1 = await rm.loadRoundState(engine, r1, alice);
  check("round model offers Alice a refund before seeding", rm.bidderActions(s1, alice).map((a) => a.id).join(), "refund");
  const aliceMon0 = await balance(alice);
  const refundRc = await send(gina, engine.tx.claimRefund(r1, alice));
  check("claimRefund by a third party pays Alice exactly her refund", (await balance(alice)) - aliceMon0, E18 - expected[alice][1]);
  check("Claimed is emitted at the refund step", events(engine, refundRc, "Claimed")[0]?.args.refund, E18 - expected[alice][1]);
  await expectRevert("tokens wait for liquidity", gina, engine.tx.claimTokens(r1, alice), "claims not open");
  await expectRevert("abandonLP before the grace period reverts", gina, engine.tx.abandonLP(r1), "grace period not over");

  const seedRc = await send(gina, engine.tx.seedLP(r1));
  const lpEv = events(engine, seedRc, "LPSeeded")[0];
  const lpMon = (clr.soldLowerBound * clr.clearingPrice / E18) * p1.lpShareBps / 10000n;
  check("LP MON = soldLowerBound × P × lpShare", lpEv?.args.monAmount, lpMon);
  check("ClaimsOpened(lpSeeded=true)", events(engine, seedRc, "ClaimsOpened")[0]?.args.lpSeeded, true);

  // Tokens: to Alice by herself, to Bob by a third party (refund first), Carol and Dave with claim().
  const tokenOut = async (who, sender, t) => {
    const before = await engine.erc20.balanceOf(token, who);
    const rc = await send(sender, t);
    return { got: (await engine.erc20.balanceOf(token, who)) - before, rc };
  };
  let r = await tokenOut(alice, alice, engine.tx.claimTokens(r1, alice));
  check("claimTokens delivers Alice's allocation", r.got, 600n * E18);
  check("TokensClaimed event", events(engine, r.rc, "TokensClaimed")[0]?.args.amount, 600n * E18);
  const bobMon0 = await balance(bob);
  r = await tokenOut(bob, gina, engine.tx.claimTokens(r1, bob));
  check("claimTokens by a third party: tokens to Bob", r.got, 250n * E18);
  check("…and his refund first", (await balance(bob)) - bobMon0, E18 - expected[bob][1]);
  r = await tokenOut(carol, carol, engine.tx.claim(r1));
  check("claim() does refund and tokens together (Carol)", `${r.got}/${events(engine, r.rc, "Claimed").length}`, `${150n * E18}/1`);
  r = await tokenOut(dave, dave, engine.tx.claim(r1));
  check("losing bid: full refund, no tokens (Dave)", `${r.got}/${events(engine, r.rc, "Claimed")[0]?.args.refund}`, `0/${E18}`);
  await expectRevert("nothing left to claim", alice, engine.tx.claim(r1), "nothing to claim");

  s1 = await rm.loadRoundState(engine, r1, null);
  const acts = rm.publicActions(s1, meta, Number(await now())).map((a) => a.id).join();
  check("round model offers dispose + sweep after seeding and refunds", acts, s1.round.unsoldOwed > 0n ? "dispose,sweep" : "sweep");
  if (s1.round.unsoldOwed > 0n) {
    const rc = await send(gina, engine.tx.disposeUnsold(r1));
    check("disposeUnsold burns Degen leftovers", events(engine, rc, "UnsoldDisposed")[0]?.args.to, BURN.toLowerCase());
  }
  await send(gina, engine.tx.sweepDust(r1));
  check("dust swept", (await engine.getRound(r1)).dustSwept, true);
  const avail = await engine.creatorAvailable(r1);
  check("creator proceeds = collected − LP MON", avail, 40n * E18 / 100n - lpMon);
  await expectRevert("only the creator can withdraw", alice, engine.tx.withdrawProceeds(r1), "not creator");
  await send(creator, engine.tx.withdrawProceeds(r1));
  check("round 1 MON fully accounted (roundBalance 0)", await engine.roundBalance(r1), 0n);

  // ═══ Round 2: Raise — allowlist, vesting, LP locked 30 days ═════════════
  const members = [alice, bob, "0x" + "a1".repeat(20), "0x" + "b2".repeat(20), "0x" + "c3".repeat(20)];
  const tree = merkle.buildTree(merkle.parseAddressList(members.join("\n")).addresses);
  const raiseForm = { ...baseForm, preset: "Raise", lpSharePct: "10", lockDays: "30", allowOn: true, tree, allowlistURI: "http://localhost/allowlist.json", vestOn: true };
  // openRound reverts that launch.js flags too.
  const t2 = Number(await now());
  const bad = [
    [{ ...raiseForm, lockDays: "29" }, "lock too short", (lp) => ({ ...lp, lockDuration: 29n * 86400n })],
    [{ ...raiseForm, splits: [{ ...baseForm.splits[0], fee: "100" }] }, "fee tier not supported", (lp) => ({ ...lp, dexSplits: [{ ...lp.dexSplits[0], fee: 100n }] })],
    [{ ...raiseForm, deposit: "0.0000001", minBid: "0.00000009", reserve: "20000000000", tick: "10000000000" }, "no valid bid possible",
      (lp) => ({ ...lp, depositAmount: 10n ** 11n, minBidSize: 9n * 10n ** 10n, reservePrice: 2n * 10n ** 28n, tickSize: 10n ** 28n })],
  ];
  const good = launch.buildOpenParams(raiseForm, tokenInfo, t2).params;
  for (const [form, reason, mutate] of bad) {
    check(`launch.js flags "${reason}"`, launch.buildOpenParams(form, tokenInfo, t2).problems.length > 0, true);
    await expectRevert(`openRound reverts "${reason}"`, creator, engine.tx.openRound(mutate(good)), reason);
  }

  const { id: r2, params: p2 } = await open(raiseForm);
  check("RoundOpened carries allowlistURI", (await engine.roundOpened(r2)).args.allowlistURI, raiseForm.allowlistURI);
  check("Raise lockDuration stored", (await engine.getRound(r2)).lockDuration, 30n * 86400n);
  const round2 = await engine.getRound(r2);
  const raiseBids = { [alice]: { price: 2n * 10n ** 14n, amount: 300n * E18 }, [bob]: { price: 10n ** 14n, amount: 200n * E18 } };
  for (const [who, b] of Object.entries(raiseBids)) {
    const proof = merkle.proofForRound(tree, round2.allowlistRoot, who);
    check(`JS proof verifies for ${who.slice(0, 8)}`, merkle.verifyProof(proof, round2.allowlistRoot, who), true);
    Object.assign(b, await sealAndCommit(r2, round2, who, b.price, b.amount, proof));
  }
  check("contract accepted both Merkle proofs", (await engine.ledgers(r2)).commits, 2n);
  check("outsider gets no proof from the tree", merkle.proofFor(tree, carol), null);
  await expectRevert("outsider with an empty proof cannot commit", carol, engine.tx.commit(r2, "0x" + "11".repeat(32), [], "0x", E18), "not on allowlist");
  await expectRevert("Alice's proof does not work for Carol", carol, engine.tx.commit(r2, "0x" + "11".repeat(32), merkle.proofFor(tree, alice), "0x", E18), "not on allowlist");

  await warpTo(p2.commitEnd);
  for (const [who, b] of Object.entries(raiseBids)) await send(who, await engine.buildReveal(r2, b));
  await warpTo(p2.revealEnd);
  await send(gina, engine.tx.settle(r2, 50n));
  const clr2 = await engine.clearingOf(r2);
  check("undersubscribed Raise clears at the lowest bid", `${clr2.settled}/${clr2.clearingPrice}/${clr2.sold}`, `true/${10n ** 14n}/${500n * E18}`);
  await send(gina, engine.tx.seedLP(r2));
  const creatorTok0 = await engine.erc20.balanceOf(token, creator);
  await send(gina, engine.tx.disposeUnsold(r2));
  check("Raise returns unsold supply to the creator", (await engine.erc20.balanceOf(token, creator)) - creatorTok0 > 400n * E18, true);
  const aliceTok0 = await engine.erc20.balanceOf(token, alice);
  await send(alice, engine.tx.claim(r2));
  check("Raise claim delivers the TGE share (25%)", (await engine.erc20.balanceOf(token, alice)) - aliceTok0, 75n * E18);
  await warpTo((await engine.getRound(r2)).settledAt + p2.vestDuration + 1n);
  const v = await engine.vestedOf(r2, alice);
  check("vestedOf after the vesting period", `${v[0]}/${v[1]}`, `${300n * E18}/${75n * E18}`);
  await send(alice, engine.tx.claimVested(r2));
  check("claimVested releases the rest", (await engine.erc20.balanceOf(token, alice)) - aliceTok0, 300n * E18);

  // ═══ Round 3: seeding blocked → abandonLP ════════════════════════════════
  const adapterIface = makeInterface([{ type: "function", name: "setRevert", inputs: [{ name: "r", type: "bool" }], outputs: [], stateMutability: "nonpayable" }]);
  const { id: r3, params: p3 } = await open(baseForm);
  const round3 = await engine.getRound(r3);
  const b3 = await sealAndCommit(r3, round3, alice, 2n * 10n ** 14n, 500n * E18);
  await warpTo(p3.commitEnd);
  await send(alice, await engine.buildReveal(r3, b3));
  await warpTo(p3.revealEnd);
  await send(gina, engine.tx.settle(r3, 50n));
  await send(gina, { to: local.adapter, data: adapterIface.encodeFunction("setRevert", [true]), value: 0n });
  await expectRevert("seedLP fails while the pool is blocked", gina, engine.tx.seedLP(r3), "pool price deviates");
  const aliceMon3 = await balance(alice);
  await send(gina, engine.tx.claimRefund(r3, alice));
  check("refund does not wait for liquidity", (await balance(alice)) - aliceMon3, E18 - 10n ** 17n);
  const settled3 = (await engine.getRound(r3)).settledAt;
  await warpTo(settled3 + meta.grace);
  let s3 = await rm.loadRoundState(engine, r3, null);
  check("round model offers abandon after the grace period", rm.publicActions(s3, meta, Number(await now())).map((a) => a.id).join(), "seed,abandon");
  const dead3 = await balance(BURN);
  const abRc = await send(gina, engine.tx.abandonLP(r3));
  const lpMon3 = (500n * E18 * 2n * 10n ** 14n / E18) * 2000n / 10000n;
  check("LPAbandoned burns the LP's MON share", `${events(engine, abRc, "LPAbandoned")[0]?.args.monBurned}/${(await balance(BURN)) - dead3}`, `${lpMon3}/${lpMon3}`);
  s3 = await rm.loadRoundState(engine, r3, alice);
  check("after abandon: lpAbandoned, claims open, tokens offered", `${s3.round.lpAbandoned}/${s3.round.claimsOpen}/${rm.bidderActions(s3, alice).map((a) => a.id).join()}`, "true/true/tokens");
  const at3 = await engine.erc20.balanceOf(token, alice);
  await send(alice, engine.tx.claimTokens(r3, alice));
  check("tokens delivered after abandon", (await engine.erc20.balanceOf(token, alice)) - at3, 500n * E18);
  check("creator proceeds exclude the burned LP share", await engine.creatorAvailable(r3), 10n ** 17n - lpMon3);
  await send(gina, engine.tx.disposeUnsold(r3));
  check("unsold supply and the unused reserve disposed", (await engine.getRound(r3)).unsoldOwed, 0n);
  await send(gina, { to: local.adapter, data: adapterIface.encodeFunction("setRevert", [false]), value: 0n });

  // ── token factory: make a token, then launch it ──
  const { createTokenTx, createdToken, newTokenProblems } = await import("./js/engine.js");
  const nt = newTokenProblems("Monad Cat", "MCAT", "1000000000");
  const ftRc = await send(henry, createTokenTx(local.tokenFactory, "Monad Cat", "MCAT", nt.supply));
  const newToken = createdToken(ftRc, local.tokenFactory);
  check("factory receipt yields the new token", /^0x[0-9a-f]{40}$/i.test(newToken ?? ""), true);
  check("new token: symbol, decimals, whole supply to the creator",
    `${await engine.erc20.symbol(newToken)}/${await engine.erc20.decimals(newToken)}/${await engine.erc20.balanceOf(newToken, henry)}`, `MCAT/18/${10n ** 27n}`);
  const ntInfo = { address: newToken, decimals: 18 };
  const ntForm = launch.buildOpenParams({ ...baseForm, sell: "1000000" }, ntInfo, Number(await now()));
  check("open form accepts the factory token", ntForm.problems.length, 0);
  await send(henry, engine.erc20.approveTx(newToken, engine.address, ntForm.need));
  const ntOpen = await send(henry, engine.tx.openRound(ntForm.params));
  const ntRound = events(engine, ntOpen, "RoundOpened")[0]?.args;
  check("round opened on the factory token, creator is the person", `${ntRound?.token?.toLowerCase()}/${ntRound?.creator?.toLowerCase()}`, `${newToken.toLowerCase()}/${henry.toLowerCase()}`);

  // ── simple launch + simple bids (web/js/simple.js), through settlement ──
  const { simpleLaunchForm, simpleBid } = await import("./js/simple.js");
  const sw = simpleLaunchForm({ preset: "Degen", supply: 10n ** 27n, sellPct: "50", floorMon: "10", depositMon: "2", duration: "10m", lpPct: "20", adapter: local.adapter, fee: 3000 }, 18);
  check("wizard: no problems for a 1B supply, half on sale, 10 MON floor", sw.problems.length, 0);
  const sForm = launch.buildOpenParams(sw.form, ntInfo, Number(await now()));
  check("wizard form passes buildOpenParams", sForm.problems.length, 0);
  await send(henry, engine.erc20.approveTx(newToken, engine.address, sForm.need));
  const rs = events(engine, await send(henry, engine.tx.openRound(sForm.params)), "RoundOpened")[0].args.roundId;
  const roundS = await engine.getRound(rs);
  const sb1 = simpleBid({ round: roundS, spendMon: "1.9", priceMultiple: 3 }, 18);
  const sb2 = simpleBid({ round: roundS, spendMon: "1.9", priceMultiple: 1 }, 18);
  check("simple bids are valid", `${sb1.problems.length}/${sb2.problems.length}`, "0/0");
  const sealS1 = await sealAndCommit(rs, roundS, alice, sb1.price, sb1.amount);
  const sealS2 = await sealAndCommit(rs, roundS, bob, sb2.price, sb2.amount);
  await warpTo(roundS.commitEnd);
  await send(alice, await engine.buildReveal(rs, sealS1));
  await send(bob, await engine.buildReveal(rs, sealS2));
  await warpTo(roundS.revealEnd);
  await send(gina, engine.tx.settle(rs, 100n));
  const clrS = await engine.clearingOf(rs);
  check("simple round settles at or above the floor", clrS.settled && clrS.clearingPrice >= roundS.reservePrice, true);
  const qS = await engine.quote(rs, alice);
  check("the 3× bidder pays at most what the form promised", qS.paid <= sb1.spend && qS.allocated > 0n, true);
} catch (e) {
  fail++;
  console.log("FAIL  e2e aborted:", e.message, e.data ? `(${revertReason(e)})` : "");
} finally {
  anvil?.kill();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
