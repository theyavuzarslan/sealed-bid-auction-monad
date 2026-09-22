// Per-browser storage (decision 33): the sealed bid, the per-wallet signature determinism result,
// and the journey fee tally. localStorage only, no DOM. Every access tolerates blocked storage;
// the backup file and the on-chain note are the durable copies.
const lc = (a) => String(a).toLowerCase();
const bidKey = (ctx) => `sba.bid.${ctx.chainId}.${lc(ctx.engine)}.${ctx.roundId}.${lc(ctx.bidder)}`;
const detKey = (account) => `sba.sigdet.${lc(account)}`;
const feeKey = (ctx) => `sba.fees.${ctx.chainId}.${lc(ctx.engine)}.${ctx.roundId}.${lc(ctx.bidder)}`;

const ls = () => globalThis.localStorage;
function get(k) {
  try { return ls().getItem(k); } catch { return null; }
}
function set(k, v) {
  try { ls().setItem(k, v); return true; } catch { return false; }
}

// rec: { price, amount, salt, hash, status: "prepared"|"committed", commitTx?, backupSaved? }
export function saveBid(ctx, rec) {
  return set(bidKey(ctx), JSON.stringify({
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

// "deterministic" | "nondeterministic" | null (not checked yet)
export function signatureDeterminism(account) {
  return get(detKey(account));
}
export function setSignatureDeterminism(account, value) {
  set(detKey(account), value);
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
