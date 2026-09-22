// Display helpers.
import cfg from "../config.js";
import { formatUnits } from "./bid.js";

export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export function short(a) {
  return a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "";
}

export function fmtCountdown(secondsLeft) {
  if (secondsLeft == null) return "";
  let s = Math.max(0, Math.floor(secondsLeft));
  const d = Math.floor(s / 86400); s %= 86400;
  const h = Math.floor(s / 3600); s %= 3600;
  const m = Math.floor(s / 60); const sec = s % 60;
  const p = (n) => String(n).padStart(2, "0");
  if (d > 0) return `${d}d ${h}h ${p(m)}m`;
  if (h > 0) return `${h}h ${p(m)}m ${p(sec)}s`;
  return `${m}m ${p(sec)}s`;
}

export function fmtMon(wei, maxFrac = 6) {
  return `${formatUnits(wei, 18, maxFrac)} MON`;
}

export function fmtMonUsd(wei) {
  let s = fmtMon(wei, 8);
  if (cfg.monPriceUsd) s += ` (≈ $${((Number(wei) / 1e18) * cfg.monPriceUsd).toFixed(4)})`;
  return s;
}

export function fmtTokens(units, decimals, symbol, maxFrac = 4) {
  return `${formatUnits(units, decimals, maxFrac)} ${symbol ?? ""}`.trim();
}

export function fmtTime(sec) {
  return new Date(Number(sec) * 1000).toLocaleString();
}

export function fmtPct(bps) {
  return `${(Number(bps) / 100).toString()}%`;
}
