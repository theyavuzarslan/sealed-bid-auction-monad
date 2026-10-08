// v3 scene 5, proof (21.0-25.4 s): a pixel CRT bezel whose screen shows the real live round
// page (assets/round1.png), then three proof chips. The screenshot is the one non-pixel
// element: it is drawn on the full-resolution output canvas (drawHi), crisp, with light
// scanlines. The pixel dissolve into this scene lives in index.html (DISSOLVES).
import { P, rect, prog, easeOut } from './palette.js';
import { text, box, textWidth } from './font.js';

const MOVE0 = 21.75, MOVE1 = 21.95;           // bezel steps from centre to the left column
const CHIPS = [22.0, 22.9, 23.8];
// Screen rects in low-res px, 4:3 (the source crop is 1200x900 of the 1600x900 shot).
const BIG = { x: 70, y: 32, w: 176, h: 132 };
const LEFT = { x: 14, y: 34, w: 152, h: 114 };
const SRC = { x: 200, y: 0, w: 1200, h: 900 };

const img = new Image();
img.src = './assets/round1.png';
export const ready = img.decode();

function screenRect(t) {
  const p = easeOut(Math.floor(prog(t, MOVE0, MOVE1) * 6) / 6); // stepped slide
  const l = (a, b) => Math.round(a + (b - a) * p);
  return { x: l(BIG.x, LEFT.x), y: l(BIG.y, LEFT.y), w: l(BIG.w, LEFT.w), h: l(BIG.h, LEFT.h) };
}

function bezel(g, r, t) {
  rect(g, r.x - 8, r.y - 8, r.w + 16, r.h + 18, P.line);
  rect(g, r.x - 7, r.y - 7, r.w + 14, r.h + 16, P.deep);
  rect(g, r.x - 6, r.y - 6, r.w + 12, 1, P.dim);            // top bevel
  rect(g, r.x - 2, r.y - 2, r.w + 4, r.h + 4, P.night);     // screen lip
  // Power LED and speaker slots on the chin.
  rect(g, r.x - 2, r.y + r.h + 4, 3, 2, P.lime);
  for (let k = 0; k < 4; k++) rect(g, r.x + r.w - 18 + k * 5, r.y + r.h + 4, 3, 2, P.line);
}

function chip(g, i, t, y, h, lines) {
  const t0 = CHIPS[i];
  if (t < t0) return;
  const slide = Math.max(0, 3 - Math.floor((t - t0) * 30)) * 4; // in from the right, 3 frames
  const x = 184 + slide, w = 132;
  if (t < t0 + 0.067) { rect(g, x, y, w, h, P.white); return; }
  box(g, x, y, w, h, P.deep, P.purple);
  rect(g, x, y, 2, h, P.lime);
  for (const L of lines) {
    if (L.segs) { // multi-colour line, placed glyph by glyph
      let k = 0;
      for (const [s, c] of L.segs) {
        text(g, s, x + 6 + k * 6 * L.scale, y + L.dy, c, { scale: L.scale });
        k += s.length;
      }
    } else text(g, L.s, x + 6 + (L.dx || 0), y + L.dy, L.c, { scale: L.scale || 1 });
  }
}

export function draw(g, t) {
  rect(g, 0, 0, 320, 180, P.bg);
  // Faint arcade-floor grid.
  for (let y = 30; y < 180; y += 12) rect(g, 0, y, 320, 1, P.deep);
  // Label bar.
  rect(g, 0, 0, 320, 21, P.deep);
  rect(g, 0, 21, 320, 1, P.line);
  text(g, 'LIVE ON MONAD MAINNET', 8, 4, P.lime, { scale: 2, tight: true });
  const live = Math.floor(t * 2) % 2 === 0;
  rect(g, 312 - textWidth('ROUND 1') - 8, 9, 4, 4, live ? P.berryLamp : P.berry);
  text(g, 'ROUND 1', 312, 8, P.white, { align: 'right' });

  bezel(g, screenRect(t), t);

  chip(g, 0, t, 24, 44, [
    { s: 'UNISWAP V3 POOL', c: P.white, dy: 6 },
    { s: 'LP LOCKED', c: P.lime, dy: 16, scale: 2 },
    { s: '(GOPLUS)', c: P.glow, dy: 33 },
  ]);
  chip(g, 1, t, 72, 53, [
    { s: "BOT'S SHARE (MEDIAN)", c: P.white, dy: 6 },
    { segs: [['59% ', P.berryLamp], ['→ ', P.white], ['18%', P.lime]], dy: 16, scale: 2 },
    { s: '500 SIMULATED', c: P.glow, dy: 33 },
    { s: 'LAUNCHES', c: P.glow, dy: 42 },
  ]);
  chip(g, 2, t, 129, 34, [
    { s: 'UNDER', c: P.white, dy: 6 },
    { s: '$0.01', c: P.lime, dy: 16, scale: 2 },
    { s: 'PER BID', c: P.glow, dy: 23, dx: 64 },
  ]);
}

// Full-resolution pass: the real screenshot inside the bezel.
export function drawHi(o, t, cam, S) {
  const r = screenRect(t);
  const X = r.x * S, Y = r.y * S, W = r.w * S, H = r.h * S;
  o.save();
  o.imageSmoothingEnabled = true;
  o.imageSmoothingQuality = 'high';
  o.drawImage(img, SRC.x, SRC.y, SRC.w, SRC.h, X, Y, W, H);
  // Light scanlines and a soft inner glow so it sits in the tube.
  o.fillStyle = 'rgba(0,0,0,0.10)';
  for (let y = Y + 1; y < Y + H; y += 3) o.fillRect(X, y, W, 1);
  o.strokeStyle = 'rgba(181,168,255,0.18)';
  o.lineWidth = S;
  o.strokeRect(X + S / 2, Y + S / 2, W - S, H - S);
  // Pixel-stepped rounded corners in the lip colour.
  o.fillStyle = P.night;
  for (const [cx, cy, dx, dy] of [[X, Y, 1, 1], [X + W - S, Y, -1, 1], [X, Y + H - S, 1, -1], [X + W - S, Y + H - S, -1, -1]]) {
    o.fillRect(cx, cy, S, S);
    o.fillRect(cx + dx * S, cy, S, S);
    o.fillRect(cx, cy + dy * S, S, S);
  }
  o.restore();
}
