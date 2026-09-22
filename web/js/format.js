// Formatting helpers.
import cfg from "../config.js";

export function fmtCountdown(secondsLeft) {
  if (secondsLeft == null) return "—";
  let s = Math.max(0, Math.floor(secondsLeft));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m ${String(sec).padStart(2, "0")}s`;
  if (m > 0) return `${m}m ${String(sec).padStart(2, "0")}s`;
  return `${sec}s`;
}

// wei (BigInt) -> decimal string with `decimals` decimals, trimmed.
export function fmtWei(wei, decimals = cfg.nativeDecimals) {
  const neg = wei < 0n;
  let s = BigInt(wei < 0n ? -wei : wei).toString().padStart(decimals + 1, "0");
  const cut = s.length - decimals;
  let out = decimals > 0 ? `${s.slice(0, cut)}.${s.slice(cut)}` : s;
  if (decimals > 0) out = out.replace(/\.?0+$/, "");
  return (neg ? "-" : "") + out;
}

export function fmtNative(wei) {
  return `${fmtWei(wei, cfg.nativeDecimals)} MON`;
}

// uint96 fraction (num/den) -> readable ratio + 6-significant-digit decimal.
export function fmtRatio(num, den) {
  if (den === 0n) return "—";
  const dec = Number(num) / Number(den);
  const decStr = dec.toPrecision(6).replace(/\.?0+$/, "");
  return `${num} / ${den} (≈ ${decStr})`;
}

export function fmtInt(v) {
  return BigInt(v).toLocaleString("en-US");
}
