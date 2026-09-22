// Pixel art in the cabinet's grammar: icons drawn from bitmaps, and the demand staircase.
// Everything is SVG rects with crisp edges, so it stays sharp at any scale.

const ICONS = {
  // 12×12 bitmaps. "x" = main colour, "o" = shade, "." = empty.
  coin: [
    "....xxxx....", "..xxxxxxxx..", ".xxxooooxxx.", ".xxoxxxxxox.", "xxoxxxxxxxox", "xxoxxxxxxxox",
    "xxoxxxxxxxox", "xxoxxxxxxxox", ".xxoxxxxxox.", ".xxxooooxxx.", "..xxxxxxxx..", "....xxxx....",
  ],
  lock: [
    "....xxxx....", "...x....x...", "..x......x..", "..x......x..", "..x......x..", "xxxxxxxxxxxx",
    "xxxxxxxxxxxx", "xxxxxooxxxxx", "xxxxxooxxxxx", "xxxxxooxxxxx", "xxxxxxxxxxxx", "xxxxxxxxxxxx",
  ],
  clock: [
    "...xxxxxx...", "..x......x..", ".x...o....x.", "x....o.....x", "x....o.....x", "x....oooo..x",
    "x..........x", "x..........x", "x..........x", ".x........x.", "..x......x..", "...xxxxxx...",
  ],
  draw: [
    "xxxxxxxxxxxx", "x..........x", "x.oo....oo.x", "x.oo....oo.x", "x..........x", "xxxxxxxxxxxx",
    "............", "xxxxxxxxxxxx", "x..........x", "x.oooooooo.x", "x..........x", "xxxxxxxxxxxx",
  ],
  collect: [
    ".....xx.....", ".....xx.....", ".....xx.....", "..x..xx..x..", "...x.xx.x...", "....xxxx....",
    ".....xx.....", "............", "x..........x", "x..........x", "xoooooooooox", "xxxxxxxxxxxx",
  ],
  bot: [
    ".....xx.....", ".....xx.....", ".xxxxxxxxxx.", "x..........x", "x..oo..oo..x", "x..oo..oo..x",
    "x..........x", "x...xxxx...x", ".xxxxxxxxxx.", "..x..xx..x..", ".xx......xx.", "............",
  ],
};

export function pixelIcon(name, { color = "currentColor", shade = "currentColor", label = "" } = {}) {
  const rows = ICONS[name];
  if (!rows) return "";
  let rects = "";
  rows.forEach((row, y) => {
    [...row].forEach((c, x) => {
      if (c === "x") rects += `<rect x="${x}" y="${y}" width="1" height="1" style="fill:${color}"/>`;
      else if (c === "o") rects += `<rect x="${x}" y="${y}" width="1" height="1" style="fill:${shade}"/>`;
    });
  });
  const a11y = label ? `role="img" aria-label="${label}"` : `aria-hidden="true"`;
  return `<svg viewBox="0 0 12 12" shape-rendering="crispEdges" ${a11y}>${rects}</svg>`;
}

// The demand staircase (DESIGN.md signature component): Monad's pixel stair drawn from real
// price levels. `levels` = [{price, qty, bot?}] sorted by price descending. Returns SVG markup.
// Everything is in chart units: x = cumulative amount, y = price.
export function staircase({ levels, supply, clearing, maxX, maxY, w = 460, h = 250, pad = 28, colors }) {
  const X = (v) => pad + (v / maxX) * (w - pad - 8);
  const Y = (v) => h - pad - (v / maxY) * (h - pad - 12);
  let cum = 0;
  const steps = levels.map((l, i) => {
    const x0 = X(cum);
    cum += l.qty;
    const x1 = X(cum);
    const y = Y(l.price);
    const fill = l.bot ? colors.bot : colors.step;
    return `<rect class="st" data-i="${i}" x="${x0.toFixed(1)}" y="${y.toFixed(1)}" width="${Math.max(x1 - x0 - 1, 1).toFixed(1)}" height="${(Y(0) - y).toFixed(1)}" style="fill:${fill}"/>`;
  }).join("");
  const sx = X(supply);
  const cy = Y(clearing);
  return { svg: steps, supplyX: sx, clearingY: cy, X, Y };
}
