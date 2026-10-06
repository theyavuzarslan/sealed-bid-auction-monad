// Demand meter: a signal built only from data that is public while bids are sealed — how many
// sealed bids there are and the uniform deposit each one locked. It never looks at a bid's price or
// size (those stay sealed until reveal), so it can only say how much MON is locked, compared with
// what the whole sale costs at the floor price.
//
// Upper bound, by construction: every bid's max spend is strictly below the deposit, and a bid can
// be far smaller than it, so real demand at the floor is at most what the deposits could buy.
// Rounding keeps it an upper bound that is never overstated: the sale's floor value rounds UP
// (maxSpend, the same ceil the contract uses for payments) and the cover rounds DOWN.
// BigInt only. Token decimals need no handling here: reservePrice is MON wei per 1e18 token base
// units and sellAmount is in base units, so their product is decimal-independent.
import { maxSpend } from "./bid.js";
import { groupDigits } from "./format.js";

const BPS = 10000n;

/**
 * in:  { commits, depositAmount, sellAmount, reservePrice } — the round's public numbers (wire units).
 * out: { locked, floorValue, coverBps, kind } where
 *      locked     = commits × depositAmount (MON wei),
 *      floorValue = ceil(sellAmount × reservePrice / 1e18) (MON wei for the whole sale at the floor),
 *      coverBps   = floor(locked × 10000 / floorValue), null when floorValue is 0,
 *      kind       = "none" (no sealed bids) | "under" (cover < 1×) | "over" (cover ≥ 1×) | "unknown".
 */
export function depositCover({ commits, depositAmount, sellAmount, reservePrice }) {
  const n = BigInt(commits ?? 0n);
  const locked = n * BigInt(depositAmount ?? 0n);
  const floorValue = maxSpend(BigInt(reservePrice ?? 0n), BigInt(sellAmount ?? 0n));
  if (floorValue === 0n) return { locked, floorValue, coverBps: null, kind: "unknown" };
  const coverBps = (locked * BPS) / floorValue;
  const kind = n === 0n ? "none" : coverBps >= BPS ? "over" : "under";
  return { locked, floorValue, coverBps, kind };
}

// "2.4×" (one decimal, rounded down; "8×" when the decimal is 0) for a cover of at least 1×; "40%" (rounded down) below it;
// "under 1%" below that (only used once some deposit is locked, so it never stands in for zero).
export function coverLabel(coverBps) {
  const c = BigInt(coverBps);
  if (c >= BPS) {
    const tenths = c / 1000n;
    return `${groupDigits(String(tenths / 10n))}${tenths % 10n ? `.${tenths % 10n}` : ""}×`;
  }
  if (c < 100n) return "under 1%";
  return `${c / 100n}%`;
}

/**
 * The pixel gauge. Its full width is 1× (the whole sale at the floor) while cover is below 1×, and
 * otherwise the next whole multiple up to `maxScale`; past that the bar is simply full.
 * out: { scale, lit, markPct } — scale in whole sales, lit cells out of `cells`, and where the 1×
 * mark sits as a percentage of the bar's width (100 when scale is 1).
 */
export function coverGauge(coverBps, { cells = 20, maxScale = 10 } = {}) {
  const c = coverBps == null ? 0n : BigInt(coverBps);
  const n = BigInt(cells);
  let scale = c <= BPS ? 1n : (c + BPS - 1n) / BPS;
  if (scale > BigInt(maxScale)) scale = BigInt(maxScale);
  let lit = (c * n) / (scale * BPS);
  if (lit > n) lit = n;
  if (lit === 0n && c > 0n) lit = 1n; // something is locked: show one cell rather than an empty bar
  return { scale: Number(scale), lit: Number(lit), markPct: 100 / Number(scale) };
}

// Plain-English copy for the meter. `headline` is the whole sentence; `before`, `figure` and `after`
// split it around the cover figure so the page can emphasise it. The MON amounts are shown by the page.
export function demandCopy(c) {
  const foot = "An upper bound, not a forecast: everyone locks the same deposit whatever they bid, and a bid can be far smaller than its deposit. Prices and sizes stay sealed, so this says nothing about any one bid.";
  const plain = (headline) => ({ headline, before: headline, figure: "", after: "", foot });
  if (c.kind === "unknown") return plain("The sale's value at the floor price is not available yet.");
  if (c.kind === "none") return plain("No sealed bids yet, so no deposits are locked.");
  const figure = coverLabel(c.coverBps);
  const [before, after] = c.kind === "over"
    ? ["Deposits locked could buy the whole sale ", " over at the floor price."]
    : ["Deposits locked cover ", " of the sale at the floor price."];
  return { headline: before + figure + after, before, figure, after, foot };
}
