// Bid preimage persistence: localStorage + download-backup (08-ui-notes.md Screen 2;
// TODO Q8: "confirm salt UX" is an open question — this implements exactly what the
// screen spec names: localStorage plus a download-a-backup button).
// The stored record is everything reveal() needs: price, quantity, salt.

const bidKey = (roundId, account) => `sba.bid.${roundId}.${account.toLowerCase()}`;
const feesKey = (roundId, account) => `sba.fees.${roundId}.${account.toLowerCase()}`;

export function saveBid(roundId, account, bid) {
  localStorage.setItem(bidKey(roundId, account), JSON.stringify({
    roundId: String(roundId),
    bidder: account.toLowerCase(),
    price: String(bid.price),
    quantity: String(bid.quantity),
    salt: bid.salt,
    committedAt: bid.committedAt ?? null,
    commitTxHash: bid.commitTxHash ?? null,
  }));
}

export function loadBid(roundId, account) {
  if (!account) return null;
  try {
    const b = JSON.parse(localStorage.getItem(bidKey(roundId, account)));
    if (!b || String(b.roundId) !== String(roundId)) return null;
    return b;
  } catch {
    return null;
  }
}

// TODO (Q2): one commitment per address per round, or many, is unresolved.
// The UI stores one bid record per (round, account) — the latest commit overwrites.
export function downloadBackup(roundId, account) {
  const bid = loadBid(roundId, account);
  if (!bid) return false;
  const payload = JSON.stringify({ ...bid, note: "Reveal needs price, quantity and salt together. Keep this file private." }, null, 2);
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([payload], { type: "application/json" }));
  a.download = `sealed-bid-backup-round-${roundId}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  return true;
}

export async function importBackup(file, roundId, account) {
  const parsed = JSON.parse(await file.text());
  const okShape = parsed &&
    String(parsed.roundId) === String(roundId) &&
    typeof parsed.bidder === "string" &&
    typeof parsed.price === "string" &&
    typeof parsed.quantity === "string" &&
    typeof parsed.salt === "string";
  if (!okShape) throw new Error("Backup file does not match this round or is malformed");
  if (parsed.bidder.toLowerCase() !== account.toLowerCase()) {
    throw new Error("Backup was made from a different address — reveal would revert (msg.sender is in the hash)");
  }
  saveBid(roundId, account, {
    price: BigInt(parsed.price),
    quantity: BigInt(parsed.quantity),
    salt: parsed.salt,
    committedAt: parsed.committedAt ?? null,
    commitTxHash: parsed.commitTxHash ?? null,
  });
  return loadBid(roundId, account);
}

// ---- Journey fee tracking (commit + reveal + claim gas), for the "< $0.01" display ----
// gasUsed * effectiveGasPrice per receipt, summed per (round, account).

export function addJourneyFee(roundId, account, kind, wei) {
  const k = feesKey(roundId, account);
  const fees = JSON.parse(localStorage.getItem(k) || "{}");
  fees[kind] = (BigInt(fees[kind] || 0n) + BigInt(wei)).toString();
  localStorage.setItem(k, JSON.stringify(fees));
}

export function loadJourneyFees(roundId, account) {
  if (!account) return { commit: 0n, reveal: 0n, claim: 0n, total: 0n };
  const fees = JSON.parse(localStorage.getItem(feesKey(roundId, account)) || "{}");
  const commit = BigInt(fees.commit || 0n);
  const reveal = BigInt(fees.reveal || 0n);
  const claim = BigInt(fees.claim || 0n);
  return { commit, reveal, claim, total: commit + reveal + claim };
}
