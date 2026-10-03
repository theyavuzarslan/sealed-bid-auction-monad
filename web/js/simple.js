// Plain-language launch and bid inputs → the exact values the tested paths already accept.
// Launch: simpleLaunchForm() returns the form object that launch.buildOpenParams validates.
// Bid:    simpleBid() returns the integer price (tick grid) and amount that bid.bidProblems checks.
// BigInt only: no floating point ever touches a price, an amount or a MON value.
import { parseUnits, formatUnits, perTokenToWire, wireToPerToken, snapToTick, maxSpend, bidProblems, PRICE_SCALE, UINT96_MAX } from "./bid.js";

const E18 = 10n ** 18n;
export const DURATIONS = {
  "10m": { label: "10 minutes", commit: 10, reveal: 10 },
  "1h": { label: "1 hour", commit: 60, reveal: 60 },
  "1d": { label: "1 day", commit: 1440, reveal: 1440 },
};
export const PRICE_MULTIPLES = [1, 1.5, 2, 3, 5, 10]; // × the floor price, offered as one-tap choices

// A power of ten about 1/100 of `v` (at least 1), so a price on the grid keeps 2–3 significant digits.
export function tickFor(v) {
  v = BigInt(v);
  if (v < 1000n) return 1n;
  return 10n ** BigInt(v.toString().length - 3);
}

const pctToBps = (pct) => {
  const t = String(pct ?? "").trim();
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  return parseUnits(t, 2);
};

/**
 * in:  { preset: "Degen"|"Raise", supply (token units, bigint), sellPct ("50"), floorMon ("100"),
 *        depositMon ("5"), duration ("10m"|"1h"|"1d"), lpPct ("20"), adapter, fee, lockDays }
 * out: { form, problems, derived: { sellAmount, reservePerToken, tickPerToken, deposit, minBid,
 *        fullBidsToSellOut, floorMcap } } — `form` goes to buildOpenParams unchanged.
 */
export function simpleLaunchForm(input, tokenDecimals = 18) {
  const problems = [];
  const tdec = BigInt(tokenDecimals);
  const unit = 10n ** tdec;
  const supply = BigInt(input.supply ?? 0n);
  const sellBps = pctToBps(input.sellPct);
  if (supply === 0n) problems.push("Total supply must be above zero.");
  if (sellBps == null || sellBps === 0n || sellBps > 10000n) problems.push("Tokens for sale: a percentage between 0.01 and 100.");
  const sellAmount = supply * (sellBps ?? 0n) / 10000n;

  let floor = 0n, deposit = 0n;
  try { floor = parseUnits(String(input.floorMon ?? "").trim(), 18); } catch { problems.push("Least you'll accept: a MON amount."); }
  try { deposit = parseUnits(String(input.depositMon ?? "").trim(), 18); } catch { problems.push("Biggest bid: a MON amount."); }
  if (floor === 0n) problems.push("Least you'll accept must be above zero.");
  if (deposit === 0n) problems.push("Biggest bid must be above zero.");

  // Floor price per whole token in MON wei, snapped onto a power-of-ten grid. Working per token keeps
  // the conversion to the contract's units (MON wei per 1e18 token units) exact for decimals ≤ 18.
  let reservePerToken = 0n, tickPerToken = 1n;
  if (BigInt(tokenDecimals) > 18n) problems.push("Tokens with more than 18 decimals are not supported here; use Advanced.");
  if (sellAmount > 0n && floor > 0n) {
    const rawPer = (floor * unit) / sellAmount;
    tickPerToken = tickFor(rawPer);
    reservePerToken = rawPer - (rawPer % tickPerToken);
    if (reservePerToken === 0n) problems.push("Least you'll accept is too small for this many tokens.");
  }
  const reserveWire = perTokenToWire(reservePerToken, tokenDecimals);
  const tickWire = perTokenToWire(tickPerToken, tokenDecimals);

  // Minimum bid: 1% of the biggest bid, but never more than a floor-price bid of a sensible size can reach.
  let minBid = deposit / 100n;
  if (minBid === 0n) minBid = 1n;
  // The contract's own limits, in words a creator can act on (launch.buildOpenParams checks them too).
  if (reserveWire > UINT96_MAX) problems.push("The floor price per token is too high for this token; sell more tokens or lower the floor.");
  if (deposit > UINT96_MAX) problems.push("Biggest bid is too large.");
  if (deposit > 0n && reserveWire > (deposit - minBid) * PRICE_SCALE) problems.push("Biggest bid is smaller than one token at the floor price; raise it.");
  const d = DURATIONS[input.duration] ?? DURATIONS["10m"];
  const lpPct = input.preset === "Raise" && String(input.lpPct ?? "").trim() === "0" ? "0" : String(input.lpPct ?? "20");

  const form = {
    preset: input.preset === "Raise" ? "Raise" : "Degen",
    sell: formatUnits(sellAmount, tokenDecimals),
    deposit: formatUnits(deposit, 18),
    minBid: formatUnits(minBid, 18),
    tick: formatUnits(tickPerToken, 18),
    reserve: formatUnits(reservePerToken, 18),
    commitMinutes: String(d.commit),
    revealMinutes: String(d.reveal),
    lpOn: lpPct !== "0",
    lpSharePct: lpPct === "0" ? "20" : lpPct,
    splits: [{ adapter: input.adapter ?? "", pct: "100", fee: String(input.fee ?? 3000) }],
    lockFeeTier: "DEFAULT",
    lockDays: String(input.lockDays ?? 180),
    allowOn: false, tree: null, allowlistURI: "",
    vestOn: false, tgePct: "25", cliffDays: "0", vestDays: "90",
  };
  const floorMcap = supply > 0n ? (reserveWire * supply) / PRICE_SCALE : 0n; // MON value of the whole supply at the floor
  const fullBidsToSellOut = deposit > 0n ? (maxSpend(reserveWire, sellAmount) + deposit - 1n) / deposit : 0n;
  return {
    form,
    problems,
    derived: { sellAmount, reserveWire, tickWire, reservePerToken, tickPerToken, deposit, minBid, fullBidsToSellOut, floorMcap, unit },
  };
}

/**
 * in:  round {reservePrice, tickSize, depositAmount, minBidSize} (wire units), spendMon ("0.5"),
 *      priceMultiple (number from PRICE_MULTIPLES) or customPerToken (MON per token text).
 * out: { price, amount, spend, problems, empty } — price on the tick grid, spend = ceil(price×amount)
 *      strictly below the deposit; the same integers then go through the existing seal path.
 */
export function simpleBid({ round, spendMon, priceMultiple, customPerToken }, tokenDecimals = 18) {
  const s = String(spendMon ?? "").trim();
  if (!s) return { empty: true };
  let spendWei;
  try { spendWei = parseUnits(s, 18); } catch { return { error: "Spend: a MON amount, like 0.5." }; }
  const reserve = BigInt(round.reservePrice);
  const tick = BigInt(round.tickSize);
  const deposit = BigInt(round.depositAmount);

  let price;
  if (customPerToken != null && String(customPerToken).trim() !== "") {
    let per;
    try { per = parseUnits(String(customPerToken).trim(), 18); } catch { return { error: "Max price: a MON amount per token." }; }
    price = snapToTick(perTokenToWire(per, tokenDecimals), tick);
  } else {
    const mulX100 = BigInt(Math.round(Number(priceMultiple ?? 1) * 100));
    price = snapToTick((reserve * mulX100) / 100n, tick);
  }
  if (price < reserve) price = reserve;
  const priceCapped = price > UINT96_MAX;
  if (priceCapped) price = snapToTick(UINT96_MAX, tick); // the contract stores prices as uint96

  // The deposit caps every bid: max spend must stay strictly below it.
  const cap = deposit - 1n;
  const capped = spendWei > cap;
  const budget = capped ? cap : spendWei;
  let amount = price > 0n ? (budget * PRICE_SCALE) / price : 0n;
  // Nobody can win more than the whole sale, and the contract stores amounts as uint96.
  const ceiling = round.sellAmount != null && BigInt(round.sellAmount) < UINT96_MAX ? BigInt(round.sellAmount) : UINT96_MAX;
  const wholeSale = amount > ceiling;
  if (wholeSale) amount = ceiling;
  const spend = maxSpend(price, amount);
  return { price, amount, spend, capped, wholeSale, priceCapped, problems: bidProblems(round, price, amount) };
}

export { E18 };
export { groupDigits } from "./format.js";
