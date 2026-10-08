// Creator logic without the DOM: form values → OpenParams, with every check AuctionEngine._validate
// makes, so the creator sees the problem before the transaction reverts.
import { PRESET, ZERO32 } from "./engine.js";
import { parseUnits, perTokenToWire, UINT96_MAX, PRICE_SCALE } from "./bid.js";
import { rootOf } from "./merkle.js";
import { isAddress } from "./hex.js";

/** Shortest commit and reveal window the engine accepts (SealingLayer.MIN_COMMIT_WINDOW / MIN_REVEAL_WINDOW). */
export const MIN_WINDOW_MINUTES = 5;

export const BPS = 10000n;
export const MAX_SPLITS = 4;
export const MIN_RAISE_LOCK_DAYS = 30; // AuctionEngine.MIN_RAISE_LOCK
export const DEX_FEE_TIERS = [500, 3000, 10000]; // adapters' supportsFee; 100 is rejected
export const LOCK_FEE_TIERS = [
  { id: "DEFAULT", label: "DEFAULT: 0.40% of position, 1.60% of fees" },
  { id: "LVP", label: "LVP: 0.64% of position, 0.80% of fees" },
  { id: "LLP", label: "LLP: 0.24% of position, 2.80% of fees" },
];
const U128 = (1n << 128n) - 1n;

export function tokensNeeded(params) {
  return params.sellAmount + (params.sellAmount * params.lpShareBps) / BPS;
}

// v: {
//   preset: "Degen"|"Raise", sell, deposit, minBid, tick, reserve, commitMinutes, revealMinutes,
//   lpOn, lpSharePct, splits: [{adapter, pct, fee}], lockFeeTier, lockDays,
//   allowOn, tree, allowlistURI, vestOn, tgePct, cliffDays, vestDays }   (numbers as typed strings)
// token: {address, decimals} or null. nowSec: chain time.
// Returns {params, problems, need}.
export function buildOpenParams(v, token, nowSec) {
  const problems = [];
  const num = (text, decimals, label) => {
    try { return parseUnits(text, decimals); } catch (e) { problems.push(`${label}: ${e.message}`); return 0n; }
  };
  const raise = v.preset === "Raise";
  if (!token) problems.push("Enter a readable token address.");
  const tdec = token?.decimals ?? 18;

  const sellAmount = num(v.sell, tdec, "Tokens for sale");
  const depositAmount = num(v.deposit, 18, "Deposit");
  const minBidSize = num(v.minBid, 18, "Minimum bid");
  const tickSize = perTokenToWire(num(v.tick, 18, "Tick size"), tdec);
  const reservePrice = perTokenToWire(num(v.reserve, 18, "Reserve price"), tdec);
  const commitMin = Number(v.commitMinutes);
  const revealMin = Number(v.revealMinutes);
  // The engine refuses windows under MIN_COMMIT_WINDOW / MIN_REVEAL_WINDOW (5 minutes each): a reveal
  // window too short for people to reveal in would burn honest bidders' deposits.
  if (!(commitMin >= MIN_WINDOW_MINUTES)) problems.push(`Bidding must stay open at least ${MIN_WINDOW_MINUTES} minutes.`);
  if (!(revealMin >= MIN_WINDOW_MINUTES)) problems.push(`The reveal window must be at least ${MIN_WINDOW_MINUTES} minutes, so bidders have time to reveal.`);
  const commitEnd = BigInt(Math.floor(nowSec) + Math.round((commitMin || 0) * 60) + 30); // 30 s for inclusion
  const revealEnd = commitEnd + BigInt(Math.round((revealMin || 0) * 60));

  if (sellAmount === 0n) problems.push("Tokens for sale must be above zero.");
  if (sellAmount > U128) problems.push("Tokens for sale does not fit uint128.");
  if (tickSize === 0n) problems.push("Tick size must be above zero.");
  if (reservePrice === 0n || (tickSize !== 0n && reservePrice % tickSize !== 0n)) {
    problems.push("Reserve price must be above zero and a multiple of the tick size.");
  }
  if (minBidSize === 0n || depositAmount <= minBidSize) {
    problems.push("The deposit must be larger than the minimum bid, and the minimum bid above zero.");
  } else if (reservePrice > (depositAmount - minBidSize) * PRICE_SCALE) {
    problems.push("No valid bid is possible: at the reserve price, no amount is both above the minimum bid and below the deposit.");
  }
  for (const [x, n] of [[depositAmount, "Deposit"], [minBidSize, "Minimum bid"], [tickSize, "Tick size"], [reservePrice, "Reserve price"]]) {
    if (x > UINT96_MAX) problems.push(`${n} does not fit uint96.`);
  }

  const lpOn = !raise || !!v.lpOn;
  let lpShareBps = 0n;
  let dexSplits = [];
  let lockFeeTier = "";
  let lockDuration = 0n;
  if (lpOn) {
    try { lpShareBps = parseUnits(v.lpSharePct, 2); } catch { problems.push("Liquidity share must be a percentage with at most two decimals."); }
    if (lpShareBps === 0n) problems.push(raise ? "Liquidity share must be above zero, or turn liquidity off." : "Degen launches need a liquidity share above zero.");
    if (lpShareBps > BPS) problems.push("Liquidity share cannot exceed 100%.");
    if (!v.splits?.length || v.splits.length > MAX_SPLITS) problems.push(`Use between 1 and ${MAX_SPLITS} DEXs.`);
    let sum = 0n;
    dexSplits = (v.splits ?? []).map((s, i) => {
      let bps = 0n;
      try { bps = parseUnits(s.pct, 2); } catch { problems.push(`DEX ${i + 1}: share must be a percentage.`); }
      if (!isAddress(s.adapter)) problems.push(`DEX ${i + 1}: adapter is not an address.`);
      if (bps === 0n) problems.push(`DEX ${i + 1}: share must be above zero.`);
      if (!DEX_FEE_TIERS.includes(Number(s.fee))) problems.push(`DEX ${i + 1}: fee tier not supported.`);
      sum += bps;
      return { adapter: s.adapter, bps, fee: BigInt(s.fee) };
    });
    if (sum !== BPS) problems.push("DEX shares must add up to 100%.");
    lockFeeTier = v.lockFeeTier;
    if (!lockFeeTier) problems.push("Pick a lock fee tier.");
    if (raise) {
      const days = Number(v.lockDays);
      if (!(days >= MIN_RAISE_LOCK_DAYS)) problems.push(`Liquidity must stay locked at least ${MIN_RAISE_LOCK_DAYS} days after seeding.`);
      else lockDuration = BigInt(Math.round(days * 86400));
    }
  }

  let allowlistRoot = ZERO32;
  let allowlistURI = "";
  if (raise && v.allowOn) {
    if (!v.tree) problems.push("Build the allowlist tree first.");
    else allowlistRoot = rootOf(v.tree);
    allowlistURI = String(v.allowlistURI ?? "").trim();
    if (!allowlistURI) problems.push("Enter the URI where bidders can fetch the allowlist tree.");
  }

  let tgeBps = 0n, cliff = 0n, vestDuration = 0n;
  if (raise && v.vestOn) {
    try { tgeBps = parseUnits(v.tgePct, 2); } catch { problems.push("Paid at claim must be a percentage."); }
    const secs = (d) => { const x = Number(d); if (!(x >= 0)) { problems.push("Vesting days must be zero or more."); return 0n; } return BigInt(Math.round(x * 86400)); };
    cliff = secs(v.cliffDays);
    vestDuration = secs(v.vestDays);
    if (vestDuration === 0n) problems.push("Vesting duration must be above zero, or turn vesting off.");
    if (tgeBps >= BPS) problems.push("Paid at claim must be below 100%.");
  }

  const params = {
    preset: PRESET[v.preset], token: token?.address ?? "0x" + "00".repeat(20), sellAmount, depositAmount, minBidSize,
    tickSize, reservePrice, commitEnd, revealEnd, allowlistRoot, allowlistURI, lpShareBps, dexSplits, lockDuration,
    lockFeeTier, tgeBps, cliff, vestDuration,
  };
  return { params, problems, need: tokensNeeded(params) };
}
