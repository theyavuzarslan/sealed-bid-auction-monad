// Sealing a bid and getting it back (decision 33, tasks/ui-bid.md "Bid recovery"). No DOM.
//
// sealBid:            wallet signature → key → encrypted fixed-length note, salt, commit hash.
//                     First use per wallet signs twice; differing signatures turn on-chain recovery
//                     off for that wallet (empty note) and make the backup file mandatory.
// recoverBidFromNote: re-sign → fetch this bidder's Committed note → decrypt → recompute the hash →
//                     compare with the stored commitment. Never reveal a bid that fails that check.
// backupJson / parseBackup: the backup file, checked against the context and re-hashed on load.
import { commitHash, generateSalt } from "./bid.js";
import { backupTypedData, keyFromSignature, encryptNote, decryptNote, signaturesMatch, isEmptyNote } from "./note.js";
import { sameAddress } from "./hex.js";

export const DETERMINISTIC = "deterministic";
export const NONDETERMINISTIC = "nondeterministic";

const fail = (code, message) => Object.assign(new Error(message), { code });

// ctx: {chainId, engine (address), roundId, bidder}
// signTypedData(typedData) -> signature hex
// knownDeterminism: stored result for this wallet, or null on first use.
export async function sealBid({ price, amount, ctx, signTypedData, knownDeterminism = null, onSecondSignature }) {
  const typed = backupTypedData(ctx);
  const sig = await signTypedData(typed);
  let determinism = knownDeterminism;
  if (!determinism) {
    onSecondSignature?.();
    const sig2 = await signTypedData(typed);
    determinism = signaturesMatch(sig, sig2) ? DETERMINISTIC : NONDETERMINISTIC;
  }
  const salt = generateSalt();
  const hash = commitHash(price, amount, salt, ctx.bidder);
  let note = "0x";
  if (determinism === DETERMINISTIC) {
    const key = await keyFromSignature(sig);
    note = await encryptNote(key, { price, amount, salt }, ctx);
    // Never commit a note we cannot read back.
    const back = await decryptNote(key, note, ctx);
    if (back.price !== price || back.amount !== amount || back.salt !== salt) throw new Error("Note self-check failed");
  }
  return { price, amount, salt, hash, note, determinism, determinismWasChecked: !knownDeterminism };
}

export async function checkBidAgainstCommitment(engine, roundId, bidder, bid) {
  const c = await engine.commitment(roundId, bidder);
  const local = commitHash(bid.price, bid.amount, bid.salt, bidder);
  return { ok: c.hash.toLowerCase() === local.toLowerCase(), onchain: c.hash, local, revealed: c.revealed };
}

// Throws an Error with `code`: NO_COMMIT | NO_NOTE | DECRYPT_FAILED | HASH_MISMATCH.
export async function recoverBidFromNote({ engine, chainId, roundId, bidder, signature }) {
  const log = await engine.committedLog(roundId, bidder);
  if (!log || !sameAddress(log.args.bidder, bidder)) throw fail("NO_COMMIT", "No commitment from this wallet in this round.");
  if (isEmptyNote(log.args.note)) throw fail("NO_NOTE", "This commitment carries no recovery note. Use your backup file.");
  const key = await keyFromSignature(signature);
  let bid;
  try {
    bid = await decryptNote(key, log.args.note, { chainId, engine: engine.address, roundId, bidder });
  } catch {
    throw fail("DECRYPT_FAILED", "The recovery note did not decrypt with this wallet's signature. Use your backup file.");
  }
  const check = await checkBidAgainstCommitment(engine, roundId, bidder, bid);
  if (!check.ok) throw fail("HASH_MISMATCH", "The recovered bid does not match your commitment. Use your backup file.");
  return { ...bid, hash: check.local, commitTx: log.transactionHash };
}

export function backupJson(ctx, bid) {
  return JSON.stringify({
    kind: "sealed-bid-backup",
    version: 1,
    warning: "Keep this file private until the round is settled. Reveal needs price, amount and salt together.",
    chainId: Number(ctx.chainId),
    engine: ctx.engine,
    roundId: String(ctx.roundId),
    bidder: ctx.bidder,
    price: String(bid.price),
    amount: String(bid.amount),
    salt: bid.salt,
    hash: bid.hash,
  }, null, 2);
}

export function backupFilename(ctx) {
  return `sealed-bid-round-${ctx.roundId}-${String(ctx.bidder).slice(0, 8)}.json`;
}

// Parses a backup file for this context and re-derives the hash. Throws on any mismatch.
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
  const bid = { price: BigInt(j.price), amount: BigInt(j.amount), salt: j.salt };
  bid.hash = commitHash(bid.price, bid.amount, bid.salt, ctx.bidder);
  return bid;
}
