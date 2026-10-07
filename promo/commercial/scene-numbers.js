// Scene 5, numbers (38-41.5 s): medians from 500 simulated launches, curve vs Even.
import { P, rect, prog } from './palette.js';
import { text, textWidth } from './font.js';

const ROWS = [
  { t: 38.4, label: "BOT'S SHARE OF SUPPLY", a: 59, b: 18, max: 100, fmt: v => Math.round(v) + '%' },
  { t: 39.1, label: 'BUYERS SHUT OUT', a: 60, b: 0, max: 100, fmt: v => Math.round(v) + '%' },
  { t: 39.8, label: 'HIGHEST ÷ LOWEST PRICE', a: 1.79, b: 1, max: 2.2, fmt: v => (v >= 1.005 ? v.toFixed(2) : '1') + '×', fixed: true },
];
const BX = 52, BW = 220, Y0 = 40, DY = 38;

function bar(g, y, value, max, p, color, edge, fmt, label, labelColor, fixed) {
  text(g, label, BX - 4, y, labelColor, { font: 'tiny', align: 'right' });
  const full = Math.round(value / max * BW);
  const w = Math.min(full, Math.ceil(p * full / 4) * 4);
  if (w > 0) {
    rect(g, BX, y - 1, w, 7, color);
    rect(g, BX, y - 1, w, 1, edge);
  } else rect(g, BX, y - 1, 1, 7, color);
  const shown = value * (full ? w / full : 1);
  text(g, fmt(p >= 1 || fixed ? value : shown), BX + Math.max(w, 1) + 4, y, edge);
}

export function draw(g, t) {
  rect(g, 0, 0, 320, 180, P.bg);
  // Arcade high-score frame.
  rect(g, 4, 4, 312, 1, P.line); rect(g, 4, 175, 312, 1, P.line);
  rect(g, 4, 4, 1, 172, P.line); rect(g, 315, 4, 1, 172, P.line);
  const title = '500 SIMULATED LAUNCHES';
  text(g, title, 160, 10, P.white, { align: 'center', scale: 2, shadow: P.berry, chars: Math.floor((t - 38.0) * 50) });
  // Legend.
  rect(g, 126, 30, 6, 5, P.berryLamp); text(g, 'CURVE', 135, 30, P.glow, { font: 'tiny' });
  rect(g, 170, 30, 6, 5, P.lime); text(g, 'EVEN', 179, 30, P.glow, { font: 'tiny' });
  ROWS.forEach((r, i) => {
    if (t < r.t) return;
    const y = Y0 + i * DY;
    const p = prog(Math.floor(t * 12) / 12, r.t, r.t + 0.4);
    if (t < r.t + 0.05) rect(g, 8, y - 2, 304, 34, P.line); // row flash
    text(g, r.label, 16, y, P.white);
    bar(g, y + 11, r.a, r.max, p, P.berryLamp, P.berryLamp, r.fmt, 'CURVE', P.berryLamp, r.fixed);
    bar(g, y + 21, r.b, r.max, prog(Math.floor(t * 12) / 12, r.t + 0.15, r.t + 0.55), P.lime, P.lime, r.fmt, 'EVEN', P.lime, r.fixed);
  });
  if (t >= 40.3) text(g, 'MEDIAN OF 500 RANDOM LAUNCHES', 160, 160, P.dim, { align: 'center' });
}
