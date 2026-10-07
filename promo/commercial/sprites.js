// Hand-drawn pixel maps. One char per pixel, '.' is transparent.
import { P } from './palette.js';

// THE COIN (Even mascot), 14x14. o outline, r rim, d rim shade, b body, e eyes, m mouth.
const COIN_BASE = [
  '....oooooo....',
  '..oorrrrrroo..',
  '.orrbbbbbbrro.',
  '.orbbbbbbbbro.',
  'odbbbbbbbbbbro',
  'odbbeebbeebbro',
  'odbbbbbbbbbbro',
  'odbbeebbeebbro',
  'odbbbbbbbbbbro',
  'odbbmbbbbmbbro',
  '.odbbmmmmbbro.',
  '.orrbbbbbbrro.',
  '..oorrrrrroo..',
  '....oooooo....',
];
// Blink frame: eyes squeeze to one line.
const COIN_BLINK = COIN_BASE.map((r, i) =>
  i === 5 || i === 7 ? 'odbbbbbbbbbbro' : i === 6 ? 'odbbeebbeebbro' : r);
// Happy frame (eyes up as arcs) for wins.
const COIN_HAPPY = COIN_BASE.map((r, i) =>
  i === 5 ? 'odbbebbbbebbro' : i === 6 ? 'odbebebbebebro' : i === 7 ? 'odbbbbbbbbbbro' : r);
// Sad frame for grey-outs: mouth flipped.
const COIN_SAD = COIN_BASE.map((r, i) =>
  i === 9 ? 'odbbbmmmmbbbro' : i === 10 ? '.odbmbbbbmbro.' : r);

export const COIN = { base: COIN_BASE, blink: COIN_BLINK, happy: COIN_HAPPY, sad: COIN_SAD };
export const COIN_COLORS = { o: P.deep, r: P.glow, d: P.lamp, b: P.purple, e: P.lime, m: P.deep };
export const COIN_GREY = { o: P.deep, r: P.dim, d: P.grey, b: P.grey, e: P.line, m: P.deep };
// Eyes only (for lights-out).
export const COIN_EYES = { e: P.lime };

// THE BOT (sniper), 14x14. w white, p berry shade, P berry-lamp, n visor slit.
const BOT_HEAD = [
  '......ww......',
  '.......p......',
  '..pppppppppp..',
  '.pPPPPPPPPPPp.',
  '.pPwwwwwwwwPp.',
  '.pPwnnwwnnwPp.',
  '.pPwwwwwwwwPp.',
  '.pPPPPPPPPPPp.',
  '..pppppppppp..',
  '...pPPPPPPp...',
];
const BOT_A = [...BOT_HEAD,
  '.ppPPPwwPPPpp.',
  '.p.pPPPPPPp.p.',
  '...pPPPPPPp...',
  '...pp....pp...'];
const BOT_B = [...BOT_HEAD,
  '..pPPPwwPPPp..',
  '..ppPPPPPPpp..',
  '...pPPPPPPp...',
  '....pp..pp....'];
const BOT_C = [...BOT_HEAD,
  '.ppPPPwwPPPpp.',
  '.p.pPPPPPPp.p.',
  '...pPPPPPPp...',
  '..pp......pp..'];
export const BOT = { run: [BOT_A, BOT_B, BOT_C, BOT_B], idle: BOT_A };
export const BOT_COLORS = { w: P.white, p: P.berry, P: P.berryLamp, n: P.night };
export const BOT_EYES = { w: P.white };

// Sealed bid capsule, 6x4: g glow, p purple, e lime lock pixel.
export const CAPSULE = ['.gggg.', 'gppepg', 'gppppg', '.gggg.'];
export const CAPSULE_COLORS = { g: P.glow, p: P.purple, e: P.lime };

// Small padlock, 5x6, for the vault.
export const LOCK = ['.ggg.', 'g...g', 'g...g', 'ggggg', 'gglgg', 'ggggg'];

// Draw a pixel map. colors maps char -> colour; unknown chars are skipped.
export function spr(g, map, x, y, colors, opts = {}) {
  const { scale = 1, flip = false } = opts;
  x = Math.round(x); y = Math.round(y);
  const w = map[0].length;
  for (let r = 0; r < map.length; r++) {
    const row = map[r];
    for (let k = 0; k < w; k++) {
      const c = colors[row[k]];
      if (!c) continue;
      g.fillStyle = c;
      const kx = flip ? w - 1 - k : k;
      g.fillRect(x + kx * scale, y + r * scale, scale, scale);
    }
  }
}

// Coin at centre (cx, cy). state: base|blink|happy|sad; grey: greyed palette.
export function coin(g, cx, cy, t, opts = {}) {
  const { state = null, grey = false, eyesOnly = false, scale = 1, bob = true, phase = 0 } = opts;
  const f = Math.floor(t * 10 + phase);
  let map = COIN.base;
  if (state) map = COIN[state];
  else if (f % 23 === 0) map = COIN.blink;
  const dy = bob ? (f % 4 === 1 || f % 4 === 2 ? -1 : 0) * scale : 0;
  const cols = eyesOnly ? COIN_EYES : grey ? COIN_GREY : COIN_COLORS;
  spr(g, map, cx - 7 * scale, cy - 7 * scale + dy, cols, { scale });
}

// Bot at centre (cx, cy). running: 4-frame run cycle at 12 fps.
export function bot(g, cx, cy, t, opts = {}) {
  const { running = true, eyesOnly = false, scale = 1, flip = false } = opts;
  const f = Math.floor(t * 12);
  const map = running ? BOT.run[f % 4] : BOT.idle;
  const dy = running && f % 2 === 1 ? -1 : 0;
  spr(g, map, cx - 7 * scale, cy - 7 * scale + dy * scale, eyesOnly ? BOT_EYES : BOT_COLORS, { scale, flip });
}

export function pellet(g, cx, cy, c = P.lime) {
  g.fillStyle = c;
  g.fillRect(Math.round(cx) - 1, Math.round(cy) - 1, 2, 2);
}

export function capsule(g, cx, cy) {
  spr(g, CAPSULE, cx - 3, cy - 2, CAPSULE_COLORS);
}

// Bold 2-pixel-stroke logo letters.
const L = {
  E: ['######', '######', '##....', '#####.', '##....', '######', '######'],
  V: ['##..##', '##..##', '##..##', '##..##', '.####.', '.####.', '..##..'],
  N: ['##...##', '###..##', '####.##', '##.####', '##..###', '##...##', '##...##'],
};
export function logo(g, cx, y, scale) {
  const word = ['E', 'V', 'E', 'N'];
  const width = word.reduce((a, c) => a + L[c][0].length + 1, -1) * scale;
  for (const [col, ox, oy] of [[P.berryLamp, -2, 2], [P.white, 0, 0]]) {
    let x = Math.round(cx - width / 2);
    for (const c of word) {
      spr(g, L[c], x + ox, y + oy, { '#': col }, { scale });
      x += (L[c][0].length + 1) * scale;
    }
  }
}
