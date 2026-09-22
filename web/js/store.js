// Per-browser bid storage (decision 33): the sealed bid in localStorage, the backup file,
// the per-wallet signature determinism result, and the journey fee tally.
// Every read and write tolerates blocked storage; the backup file and the on-chain note are
// the durable copies.
import { commitHash } from "./bid.js";
import { sameAddress } from "./hex.js";

const lc = (a) => String(a).toLowerCase();
const bidKey = (ctx) => `sba.bid.${ctx.chainId}.${lc(ctx.engine)}.${ctx.roundId}.${lc(ctx.bidder)}`;
const detKey = (account) => `sba.sigdet.${lc(account)}`;
const feeKey = (ctx) => `sba.fees.${ctx.chainId}.${lc(ctx.engine)}.${ctx.roundId}.${lc(ctx.bidder)}`;

function get(k) {
  try { return localStorage.getItem(k); } catch { return null; }
}
function set(k, v) {
  try { localStorage.setItem(k, v); return true; } catch { return false; }
}

// Record: { chainId, engine, roundId, bidder, price, amount, salt, hash, status, commitTx, backupSaved }
export function saveBid(ctx, rec) {
  return set(bidKey(ctx), JSON.stringify({
    kind: "sealed-bid-backup",
    version: 1,
    chainId: Number(ctx.chainId),
    engine: ctx.engine,
    roundId: String(ctx.roundId),
    bidder: ctx.bidder,
    price: String(rec.price),
    amount: String(rec.amount),
    salt: rec.salt,
    hash: rec.hash,
    status: rec.status ?? "prepared",
    commitTx: rec.commitTx ?? null,
    backupSaved: !!rec.backupSaved,
  }));
}

export function loadBid(ctx) {
  try {
    const r = JSON.parse(get(bidKey(ctx)));
    if (!r) return null;
    return { ...r, price: BigInt(r.price), amount: BigInt(r.amount) };
  } catch {
    return null;
  }
}

export function updateBid(ctx, patch) {
  const r = loadBid(ctx);
  if (r) saveBid(ctx, { ...r, ...patch });
}

export function backupBlob(rec) {
  const body = {
    kind: "sealed-bid-backup",
    version: 1,
    warning: "Keep this file private until the round is settled. Reveal needs price, amount and salt together.",
    chainId: rec.chainId, engine: rec.engine, roundId: String(rec.roundId), bidder: rec.bidder,
    price: String(rec.price), amount: String(rec.amount), salt: rec.salt, hash: rec.hash,
  };
  return new Blob([JSON.stringify(body, null, 2)], { type: "application/json" });
}

export function downloadBackup(rec) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(backupBlob(rec));
  a.download = `sealed-bid-round-${rec.roundId}-${rec.bidder.slice(0, 8)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// Parses and checks a backup file for this context. Returns the bid record or throws.
export function parseBackup(text, ctx) {
  let j;
  try { j = JSON.parse(text); } catch { throw new Error("Not a JSON file"); }
  if (j?.kind !== "sealed-bid-backup") throw new Error("Not a sealed-bid backup file");
  if (String(j.roundId) !== String(ctx.roundId)) throw new Error(`This backup is for round ${j.roundId}`);
  if (Number(j.chainId) !== Number(ctx.chainId) || !sameAddress(j.engine, ctx.engine)) {
    throw new Error("This backup is for another network or engine");
  }
  if (!sameAddress(j.bidder, ctx.bidder)) {
    throw new Error("This backup was made by another wallet; the reveal must come from that wallet");
  }
  const rec = { price: BigInt(j.price), amount: BigInt(j.amount), salt: j.salt };
  rec.hash = commitHash(rec.price, rec.amount, rec.salt, ctx.bidder);
  return rec;
}

// "deterministic" | "nondeterministic" | null (not checked yet)
export function signatureDeterminism(account) {
  return get(detKey(account));
}
export function setSignatureDeterminism(account, ok) {
  set(detKey(account), ok ? "deterministic" : "nondeterministic");
}

export function addFee(ctx, kind, wei) {
  let f = {};
  try { f = JSON.parse(get(feeKey(ctx)) || "{}"); } catch { /* reset */ }
  f[kind] = (BigInt(f[kind] ?? 0) + BigInt(wei)).toString();
  set(feeKey(ctx), JSON.stringify(f));
}
export function loadFees(ctx) {
  let f = {};
  try { f = JSON.parse(get(feeKey(ctx)) || "{}"); } catch { /* none */ }
  const out = { commit: 0n, reveal: 0n, claim: 0n };
  for (const k of Object.keys(out)) out[k] = BigInt(f[k] ?? 0);
  out.total = out.commit + out.reveal + out.claim;
  return out;
}
