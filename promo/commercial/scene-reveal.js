// Scene 4, reveal (26-38 s): CONTINUE?, the vault opens, the bids become a staircase,
// one price line sweeps, everyone at or above it lands on one lime step.
// makeReveal(cfg) builds the scene from a set of times; the defaults are the 45 s cut.
import { P, rect, prog, blink, easeIn } from './palette.js';
import { text, textWidth, box } from './font.js';
import { coin, bot } from './sprites.js';
import { drawVault, VAULT } from './vault.js';

const PRICE = 0.22;
// Real bids from the local-chain replay, sorted high -> low.
const BIDS = [
  ['bot', 0.50], ['emi', 0.50], ['ines', 0.45], ['ana', 0.40], ['lea', 0.38], ['chloe', 0.35],
  ['kai', 0.32], ['gia', 0.30], ['jay', 0.28], ['finn', 0.26], ['hugo', 0.24], ['ben', 0.22], ['dev', 0.20],
];
const BASE = 150, K = 180, COLW = 22, X0 = 17;
const colX = i => X0 + i * COLW;
const lineY = BASE - Math.round(PRICE * K);

const DEFAULTS = {
  CONT: 26.2, CONT_END: null, OPEN: 27.4, STEP0: 28.0, STEP_DT: 0.25, SWEEP0: 31.4, SWEEP1: 32.6,
  LAND: 33.0, REFUND: 33.8, DRAW: 34.6, CAPTION: 35.4,
  bigText: false,   // 30 s cut: step label and closing caption at phone-readable sizes
};

function token(g, cx, cy) {
  rect(g, cx - 2, cy - 3, 4, 6, P.lime); rect(g, cx - 3, cy - 2, 6, 4, P.lime);
  rect(g, cx - 1, cy - 2, 1, 2, P.white); rect(g, cx - 1, cy - 1, 3, 1, P.berry);
}

function drawChar(g, i, x, y, t, state) {
  const [name] = BIDS[i];
  if (name === 'bot') bot(g, x, y, t, { running: false });
  else coin(g, x, y, t, { phase: i * 4, state });
}

export function makeReveal(cfg = {}) {
  const C = { ...DEFAULTS, ...cfg };
  const { CONT, OPEN, STEP0, STEP_DT, SWEEP0, SWEEP1, LAND, REFUND, DRAW, CAPTION } = C;
  const CONT_END = C.CONT_END ?? OPEN;

  function hud(g, t) {
    rect(g, 0, 0, 320, 20, P.deep);
    rect(g, 0, 20, 320, 1, P.line);
    text(g, '2P · ', 8, 7, P.white);
    text(g, 'EVEN', 8 + textWidth('2P · ') + 1, 7, P.lime);
    const found = t >= SWEEP1;
    text(g, found ? '0.220' : '?.??', 312, 7, found ? P.lime : P.dim, { align: 'right' });
    text(g, 'PRICE ', 312 - textWidth(found ? '0.220' : '?.??') - 1, 7, P.dim, { align: 'right' });
  }

  function preBoard(g, t, cam) {
    rect(g, 0, 0, 320, 180, P.night);
    cam.zoom = 2; cam.x = 80; cam.y = 54;
    const open = t < OPEN ? 0 : Math.min(1, Math.floor((t - OPEN) * 15) / 5);
    if (t >= OPEN) {
      // Light pours out: stepped rays fanning up from the door.
      const n = Math.min(6, Math.floor((t - OPEN) * 20));
      for (let k = 0; k < n; k++) {
        const w = 6 + k * 10, yb = VAULT.y + 6 - k * 9;
        rect(g, 160 - w / 2, yb, w, 3, k % 2 ? P.lime : P.glow);
      }
      rect(g, 152, 20, 16, VAULT.y - 14, P.lime);
      rect(g, 156, 20, 8, VAULT.y - 14, P.white);
    }
    drawVault(g, { open, locked: t < OPEN });
    const bl = C.bigText ? blink(t - CONT, 0.2, 0.14) : blink(t - CONT, 0.4, 0.26);
    if (t >= CONT && t < CONT_END && bl)
      text(g, 'CONTINUE?', 160, 124, P.white, { align: 'center', shadow: P.berry });
    if (t >= OPEN && t < OPEN + 0.07) rect(g, 0, 0, 320, 180, P.white);
    if (t >= OPEN && t < OPEN + 0.3) cam.sy = Math.floor(t * 30) % 2 ? 1 : -1;
  }

  function stepTop(i, t) {
    const bid = BIDS[i][1];
    const t0 = STEP0 + STEP_DT * i;
    const full = Math.round(bid * K);
    let h = t < t0 ? 0 : Math.min(full, Math.ceil(prog(t, t0, t0 + 0.2) * full / 4) * 4);
    if (t >= LAND && bid >= PRICE) {
      const p = prog(Math.floor(t * 30) / 30, LAND, LAND + 0.2);
      h = Math.round(full + (BASE - lineY - full) * p);
    }
    return BASE - h;
  }

  function draw(g, t, cam) {
    if (t < STEP0) { preBoard(g, t, cam); return; }
    rect(g, 0, 0, 320, 180, P.bg);
    // Faint grid behind the board.
    for (let y = BASE - 20; y > 30; y -= 20) rect(g, 8, y, 304, 1, P.line);
    rect(g, 8, BASE, 304, 1, P.dim);
    const landed = t >= LAND + 0.2;
    // Columns.
    for (let i = 0; i < BIDS.length; i++) {
      const [name, bid] = BIDS[i];
      const top = stepTop(i, t);
      const x = colX(i);
      if (top < BASE) {
        const win = landed && bid >= PRICE;
        if (!win) {
          rect(g, x, top, COLW - 2, BASE - top, P.purple);
          rect(g, x, top, COLW - 2, 1, P.glow);
          rect(g, x + COLW - 4, top + 1, 2, BASE - top - 1, P.lamp);
          if (BASE - top >= 10) text(g, bid.toFixed(2), x + 2, top + 3, P.deep, { font: 'tiny' });
        }
      }
      text(g, name, x + (COLW - 2) / 2, BASE + 3, name === 'bot' ? P.berryLamp : P.glow, { font: 'tiny', align: 'center' });
    }
    if (landed) {
      // One lime step for everyone at or above the price.
      const x0 = colX(0), x1 = colX(11) + COLW - 2;
      rect(g, x0, lineY, x1 - x0, BASE - lineY, P.lime);
      rect(g, x0, lineY, x1 - x0, 1, P.white);
      if (C.bigText) {
        text(g, 'EVERYONE ON THIS STEP PAYS', (x0 + x1) / 2, lineY + 6, P.deep, { align: 'center' });
        text(g, '0.220', (x0 + x1) / 2, lineY + 17, P.deep, { align: 'center', scale: 2 });
      } else {
        text(g, 'EVERYONE ON THIS STEP PAYS', (x0 + x1) / 2, lineY + 8, P.deep, { font: 'tiny', align: 'center' });
        text(g, '0.220', (x0 + x1) / 2, lineY + 18, P.deep, { align: 'center' });
      }
    }
    if (t >= SWEEP0) {
      const p = prog(Math.floor(t * 30) / 30, SWEEP0, SWEEP1);
      const xe = Math.round(8 + p * 304);
      rect(g, 8, lineY, xe - 8, 1, P.lime);
      if (p < 1) rect(g, xe - 2, lineY - 2, 3, 5, P.white);
    }
    // Characters stand on their step; they pop on when the step finishes.
    for (let i = 0; i < BIDS.length; i++) {
      const t0 = STEP0 + STEP_DT * i;
      if (t < t0 + 0.2) continue;
      const top = stepTop(i, t);
      let y = top - 7;
      if (t >= LAND && BIDS[i][1] >= PRICE && t < LAND + 0.2) {
        // Fall onto the shared step, stepped gravity.
        const startY = BASE - Math.round(BIDS[i][1] * K) - 7;
        const p = easeIn(prog(Math.floor(t * 30) / 30, LAND, LAND + 0.2));
        y = Math.round(startY + (lineY - 7 - startY) * p);
      }
      const pop = t < t0 + 0.27 ? -2 : 0;
      const state = t >= LAND + 0.2 && BIDS[i][1] >= PRICE ? 'happy' : null;
      drawChar(g, i, colX(i) + 9, y + pop, t, state);
    }
    // Price line sweep.
    if (t >= SWEEP0) {
      if (t < REFUND) {
        const s = 'ONE PRICE · 0.220';
        text(g, s, 160, 26, P.lime, { align: 'center', scale: 2, chars: Math.floor((t - SWEEP0) * (C.bigText ? 60 : 24)) });
      }
    }
    // dev's refund.
    if (t >= REFUND) {
      const x = colX(12) + 9, top = stepTop(12, t);
      const f = prog(Math.floor(t * 30) / 30, REFUND, REFUND + 0.35);
      // A MON token drops back into dev's hands.
      const cy = Math.round(top - 26 + f * 12);
      if (f < 1) token(g, x, cy);
      if (t < REFUND + 0.07) rect(g, x - 9, top - 34, 18, 16, P.white);
      if (C.bigText) {
        box(g, x - 23, top - 38, 43, 11, P.night, P.lime);
        text(g, 'REFUND', x - 19, top - 36, P.lime);
      } else {
        box(g, x - 16, top - 36, 31, 9, P.night, P.lime);
        text(g, 'REFUND', x - 12, top - 34, P.lime, { font: 'tiny' });
      }
      text(g, '11 OF 12 GOT TOKENS', 160, 26, P.white, { align: 'center', scale: 2 });
    }
    if (t >= DRAW) {
      const st = t - DRAW;
      if (st < 0.07) rect(g, 0, 0, 320, 180, P.white);
      else {
        if (st < 0.4) {
          const sh = [[2, 1], [-2, -1], [1, -2], [-1, 2], [2, -1], [0, 1]][Math.floor(st * 30) % 6];
          cam.sx = sh[0]; cam.sy = sh[1];
        }
        const s = st < 0.14 ? 5 : 4;
        const w = textWidth('DRAW', s);
        box(g, 160 - w / 2 - 8, 50 - (s - 4) * 4, w + 16, 7 * s + 12, P.night, P.lime);
        text(g, 'DRAW', 160 - w / 2, 56 - (s - 4) * 4, P.lime, { scale: s, shadow: P.line });
      }
    }
    if (t >= CAPTION) {
      const n = Math.floor((t - CAPTION) * 60);
      if (C.bigText) {
        // Three scale-2 lines on a dark band over the lower board.
        rect(g, 0, 116, 320, 64, P.night);
        rect(g, 0, 116, 320, 1, P.lime);
        const o = { align: 'center', scale: 2, tight: true };
        text(g, 'THE BOT CAN STILL PLAY.', 160, 122, P.white, { ...o, chars: n });
        text(g, 'IT JUST PAYS WHAT', 160, 141, P.lime, { ...o, chars: Math.max(0, n - 23) });
        text(g, 'EVERYONE PAYS.', 160, 160, P.lime, { ...o, chars: Math.max(0, n - 40) });
      } else {
        rect(g, 0, 159, 320, 21, P.night);
        text(g, 'THE BOT CAN STILL PLAY.', 160, 161, P.white, { align: 'center', chars: n });
        text(g, 'IT JUST PAYS WHAT EVERYONE PAYS.', 160, 170, P.lime, { align: 'center', chars: Math.max(0, n - 23) });
      }
    }
    hud(g, t);
  }

  return { draw };
}

export const draw = makeReveal().draw;
