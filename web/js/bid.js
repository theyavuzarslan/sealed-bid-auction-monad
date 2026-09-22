// MONEY-PATH MODULE — flag for line-by-line human review (AGENTS.md rule 4).
// Bid units, max spend, the reveal-time checks mirrored from AuctionEngine._onReveal,
// and the commit hash. A bid that fails these checks at reveal cannot be revealed and
// its deposit is burned (decision 30), so the UI must block it before commit.
import { assert, bytesToHex, hexToBytes, keccak256, randomBytes, strip0x } from "./hex.js";
import { encodeParams } from "./abicoder.js";

export const PRICE_SCALE = 10n ** 18n; // price = MON wei per 1e18 token units
export const UINT96_MAX = (1n << 96n) - 1n;

// Decimal string -> integer with `decimals` places. Rejects extra precision rather than
// silently truncating, so what the user typed is what gets sealed.
export function parseUnits(str, decimals) {
  const s = String(str).trim();
  assert(/^\d*(\.\d*)?$/.test(s) && s !== "" && s !== ".", "not a decimal number");
  const [whole, frac = ""] = s.split(".");
  assert(frac.length <= decimals, `at most ${decimals} decimal places`);
  return BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt((frac + "0".repeat(decimals)).slice(0, decimals) || "0");
}

export function formatUnits(v, decimals, maxFrac = null) {
  v = BigInt(v);
  const neg = v < 0n;
  if (neg) v = -v;
  const base = 10n ** BigInt(decimals);
  let frac = (v % base).toString().padStart(decimals, "0");
  if (maxFrac != null) frac = frac.slice(0, maxFrac);
  frac = frac.replace(/0+$/, "");
  return (neg ? "-" : "") + (v / base).toString() + (frac ? "." + frac : "");
}

// A price typed per whole token (10^decimals units) -> the contract's price per 1e18 units.
// Identity for 18-decimal tokens. Floors: a max price never rounds up.
export function perTokenToWire(perTokenWei, tokenDecimals) {
  return (BigInt(perTokenWei) * PRICE_SCALE) / 10n ** BigInt(tokenDecimals);
}

export function wireToPerToken(wire, tokenDecimals) {
  return (BigInt(wire) * 10n ** BigInt(tokenDecimals)) / PRICE_SCALE;
}

// Snap down onto the tick grid: the sealed price is never above what the bidder typed.
export function snapToTick(price, tick) {
  price = BigInt(price);
  tick = BigInt(tick);
  assert(tick > 0n, "zero tick");
  return price - (price % tick);
}

// ceil(price × amount / 1e18), same as AuctionEngine._mulDivUp — rounds UP (bug #8).
export function maxSpend(price, amount) {
  const x = BigInt(price) * BigInt(amount);
  return x === 0n ? 0n : (x - 1n) / PRICE_SCALE + 1n;
}

// Every condition AuctionEngine._onReveal enforces, in the same order.
// round: { tickSize, reservePrice, minBidSize, depositAmount } as BigInt.
// Returns [] when the bid will pass reveal; otherwise [{code, message}].
export function bidProblems(round, price, amount) {
  const problems = [];
  price = BigInt(price);
  amount = BigInt(amount);
  const add = (code, message) => problems.push({ code, message });
  if (price > UINT96_MAX) add("PRICE_TOO_LARGE", "Price does not fit the contract's uint96.");
  if (amount > UINT96_MAX) add("AMOUNT_TOO_LARGE", "Token amount does not fit the contract's uint96.");
  if (price % BigInt(round.tickSize) !== 0n) add("OFF_TICK", "Price is not on the round's tick grid.");
  if (price < BigInt(round.reservePrice)) add("BELOW_RESERVE", "Price is below the reserve price.");
  if (amount === 0n) add("ZERO_AMOUNT", "Token amount must be above zero.");
  const spend = maxSpend(price, amount);
  if (amount !== 0n && spend < BigInt(round.minBidSize)) {
    add("BELOW_MIN_BID", "Max spend is below the minimum bid size.");
  }
  if (spend >= BigInt(round.depositAmount)) {
    add("AT_OR_ABOVE_DEPOSIT", "Max spend must be strictly below the deposit.");
  }
  return problems;
}

// keccak256(abi.encode(uint96 price, uint96 amount, bytes32 salt, address bidder)).
// All four fields are load-bearing: no salt → brute-forceable; no bidder → replay and
// reveal front-running (AGENTS.md bugs #1, #2).
export function commitHash(price, amount, salt, bidder) {
  price = BigInt(price);
  amount = BigInt(amount);
  assert(price > 0n && price <= UINT96_MAX, "price must be in (0, 2^96)");
  assert(amount > 0n && amount <= UINT96_MAX, "amount must be in (0, 2^96)");
  assert(/^[0-9a-fA-F]{64}$/.test(strip0x(salt)), "salt must be bytes32");
  assert(/^[0-9a-fA-F]{40}$/.test(strip0x(bidder)), "bidder must be an address");
  const enc = encodeParams(
    [{ type: "uint96" }, { type: "uint96" }, { type: "bytes32" }, { type: "address" }],
    [price, amount, salt, bidder],
  );
  return keccak256(enc);
}

// CSPRNG salt. Losing it (and the note and the backup) means the deposit is burned.
export function generateSalt() {
  return bytesToHex(randomBytes(32));
}

export function isBytes32(h) {
  return typeof h === "string" && /^0x[0-9a-fA-F]{64}$/.test(h) && hexToBytes(h).length === 32;
}
