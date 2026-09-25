// Share card: a 1200×630 PNG of a settled round's result in the cabinet's grammar (DESIGN.md).
// Indigo field, one notched off-white bezel panel with a hard purple offset shadow, Jersey 10 for the
// marquee, Schibsted Grotesk for every amount (the Readable Money Rule), one Win Lime lamp.
// Claim wording is fixed here on purpose: see CLAUDE.md "Claim wording".

export const CARD_W = 1200;
export const CARD_H = 630;

export const TAGLINE = "Sealed bid. One price. Nobody got a head start.";
export const CLAIM = "Snipe-resistant: submission timing no longer determines price.";

const C = {
  indigo: "#200052", deep: "#140033", purple: "#6E54FF", glow: "#B5A8FF", berry: "#A0055D",
  white: "#FBFAF9", grey: "#EDEBE8", ink: "#17142B", inkSoft: "#4A4566", lime: "#C6F24E", dim: "#6D5FB0",
};
const F = {
  display: (px) => `400 ${px}px "Jersey 10", "Silkscreen", monospace`,
  label: (px) => `400 ${px}px "Silkscreen", monospace`,
  body: (px, w = 400) => `${w} ${px}px "Schibsted Grotesk", ui-sans-serif, system-ui, sans-serif`,
};

export async function loadCardFonts() {
  if (!globalThis.document?.fonts) return;
  await Promise.all([
    document.fonts.load(F.display(72), "Aa0"),
    document.fonts.load(F.label(18), "AA0"),
    document.fonts.load(F.body(28, 400), "Aa0"),
    document.fonts.load(F.body(26, 500), "Aa0"),
    document.fonts.load(F.body(30, 600), "Aa0"),
    document.fonts.load(F.body(64, 700), "Aa0"),
  ]);
}

// Largest font size (down to `min`) at which `text` fits in `maxW`.
function fit(ctx, text, font, size, maxW, min = 12) {
  let px = size;
  ctx.font = font(px);
  while (px > min && ctx.measureText(text).width > maxW) { px -= 2; ctx.font = font(px); }
  return px;
}

function notchedPath(ctx, x, y, w, h, n) {
  ctx.beginPath();
  ctx.moveTo(x + n, y); ctx.lineTo(x + w - n, y); ctx.lineTo(x + w - n, y + n); ctx.lineTo(x + w, y + n);
  ctx.lineTo(x + w, y + h - n); ctx.lineTo(x + w - n, y + h - n); ctx.lineTo(x + w - n, y + h);
  ctx.lineTo(x + n, y + h); ctx.lineTo(x + n, y + h - n); ctx.lineTo(x, y + h - n); ctx.lineTo(x, y + n);
  ctx.lineTo(x + n, y + n); ctx.closePath();
}

// A demand staircase from the revealed book: levels = [{price, qty}] (numbers, highest price first).
function drawStair(ctx, { levels, supply, clearing }, x, y, w, h) {
  ctx.fillStyle = C.deep;
  ctx.fillRect(x, y, w, h);
  if (!levels?.length) return;
  const pad = 18;
  const total = levels.reduce((t, l) => t + l.qty, 0);
  const maxX = Math.max(total, supply) * 1.06 || 1;
  const maxY = levels[0].price * 1.12 || 1;
  const X = (v) => x + pad + (v / maxX) * (w - pad * 2);
  const Y = (v) => y + h - pad - (v / maxY) * (h - pad * 2);
  let cum = 0;
  for (const l of levels) {
    const x0 = X(cum); cum += l.qty; const x1 = X(cum); const top = Y(l.price);
    ctx.fillStyle = l.price < clearing ? C.dim : C.purple;
    ctx.fillRect(Math.round(x0), Math.round(top), Math.max(Math.round(x1 - x0) - 2, 2), Math.round(Y(0) - top));
  }
  ctx.fillStyle = C.dim;
  ctx.fillRect(x + pad, Math.round(Y(0)), w - pad * 2, 2);
  // Supply: dashed white line. Clearing: a solid white line, "one price" (no lime here: one lamp per card).
  const sx = Math.round(X(supply));
  ctx.fillStyle = C.white;
  for (let yy = y + 12; yy < Y(0); yy += 8) ctx.fillRect(sx - 1, yy, 2, 4);
  const cy = Math.round(Y(clearing));
  ctx.fillRect(x + pad, cy - 1, sx - x - pad, 3);
  ctx.font = F.label(13);
  ctx.textBaseline = "alphabetic";
  ctx.fillText("ONE PRICE", x + pad + 4, cy - 8);
  ctx.textAlign = "right";
  ctx.fillText("SUPPLY", sx - 6, y + 24);
  ctx.textAlign = "left";
}

// data: { symbol, roundId, price: "0.0012 MON", won: bool, tokens: "1,000 PEPE", paid: "1.2 MON",
//         stair?: { levels, supply, clearing } }
export async function drawShareCard(canvas, data) {
  await loadCardFonts();
  canvas.width = CARD_W;
  canvas.height = CARD_H;
  const ctx = canvas.getContext("2d");
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";

  // Field + the faint pixel grid.
  ctx.fillStyle = C.indigo;
  ctx.fillRect(0, 0, CARD_W, CARD_H);
  ctx.fillStyle = "rgba(255,255,255,0.03)";
  for (let i = 0; i < CARD_W; i += 16) ctx.fillRect(i, 0, 1, CARD_H);
  for (let j = 0; j < CARD_H; j += 16) ctx.fillRect(0, j, CARD_W, 1);

  // Marquee: logo plate with its berry offset, then the round tag with the one lime lamp (results called).
  ctx.font = F.display(52);
  const logoW = ctx.measureText("EVEN").width + 28;
  ctx.fillStyle = C.berry; ctx.fillRect(64, 36, logoW, 56);
  ctx.fillStyle = C.purple; ctx.fillRect(60, 32, logoW, 56);
  ctx.fillStyle = C.white; ctx.fillText("EVEN", 74, 78);
  ctx.font = F.label(15);
  ctx.fillStyle = C.glow;
  ctx.fillText("SEALED-BID LAUNCH ON MONAD", 60 + logoW + 22, 68);
  const tag = `ROUND ${data.roundId} · RESULTS`;
  ctx.font = F.label(18);
  const tagW = ctx.measureText(tag).width;
  ctx.fillStyle = C.white;
  ctx.fillText(tag, CARD_W - 60 - tagW, 68);
  ctx.fillStyle = C.lime;
  ctx.fillRect(CARD_W - 60 - tagW - 26, 53, 14, 14);

  // The bezel panel: notched, hard purple offset shadow (Player 2).
  const px = 60, py = 124, pw = 1072, ph = 336, notch = 12;
  ctx.fillStyle = C.purple; notchedPath(ctx, px + 8, py + 8, pw, ph, notch); ctx.fill();
  ctx.fillStyle = C.white; notchedPath(ctx, px, py, pw, ph, notch); ctx.fill();

  const hasStair = !!data.stair?.levels?.length;
  const colW = hasStair ? 580 : pw - 80;
  const lx = px + 40;

  // Headline: token and round, in the marquee face.
  const head = `${data.symbol} launch`;
  fit(ctx, head, F.display, 76, colW, 36);
  ctx.fillStyle = C.ink;
  ctx.fillText(head, lx, py + 86);

  // The called price, readable (Schibsted), in Even's purple.
  ctx.font = F.body(26, 400);
  ctx.fillStyle = C.inkSoft;
  ctx.fillText("Everyone paid", lx, py + 136);
  const priceSize = fit(ctx, data.price, (s) => F.body(s, 700), 60, colW - 150, 28);
  ctx.fillStyle = C.purple;
  ctx.fillText(data.price, lx, py + 136 + priceSize + 6);
  const priceW = ctx.measureText(data.price).width;
  ctx.font = F.body(26, 400);
  ctx.fillStyle = C.inkSoft;
  ctx.fillText("per token", lx + priceW + 14, py + 136 + priceSize + 6);

  // Your outcome: a bezel-grey well.
  const wy = py + 232, wh = 72;
  ctx.fillStyle = C.grey;
  ctx.fillRect(lx, wy, colW, wh);
  ctx.font = F.label(14);
  ctx.fillStyle = C.inkSoft;
  ctx.fillText(data.won ? "YOU WON" : "YOUR BID", lx + 18, wy + 28);
  const outcome = data.won ? `${data.tokens} for ${data.paid}` : "Refunded in full";
  fit(ctx, outcome, (s) => F.body(s, 600), 28, colW - 36, 16);
  ctx.fillStyle = C.ink;
  ctx.fillText(outcome, lx + 18, wy + 60);

  if (hasStair) drawStair(ctx, data.stair, px + pw - 40 - 392, py + 40, 392, ph - 80);

  // Tagline and claim on the field.
  ctx.fillStyle = C.white;
  fit(ctx, TAGLINE, F.display, 54, CARD_W - 120, 30);
  ctx.fillText(TAGLINE, 60, 534);
  ctx.fillStyle = C.glow;
  fit(ctx, CLAIM, (s) => F.body(s, 500), 26, CARD_W - 120, 16);
  ctx.fillText(CLAIM, 60, 578);
  return canvas;
}

export function canvasToPng(canvas) {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Could not render the image"))), "image/png"));
}

export function shareText({ symbol, roundId, price, won, tokens }) {
  return won
    ? `I won ${tokens} in the ${symbol} sealed-bid launch on Even (round ${roundId}). Everyone paid one price: ${price} per token.`
    : `I bid in the ${symbol} sealed-bid launch on Even (round ${roundId}). Everyone paid one price: ${price} per token; my bid was refunded in full.`;
}

export function xIntentUrl(text, url) {
  return `https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`;
}
