// Scene 3, sealed (15-26 s): 13 players post sealed capsules into one vault, then lights out.
import { P, rect, prog, blink } from './palette.js';
import { text, textWidth } from './font.js';
import { coin, bot, capsule } from './sprites.js';
import { makeMaze, drawMaze, route, along } from './maze.js';
import { drawVault, VAULT } from './vault.js';

export const MAZE2 = makeMaze('sealed');
const WALK = 15.4, LAST_ARRIVE = 19.4, DROP0 = 16.0, DROP_DT = 0.4, LIGHTS_OUT = 21.2;
const TICK0 = 21.6, TICK_DT = 0.4, NTICK = 10, SEALED = 25.5;

// [name, spawn tile, ring spot]; listed in drop order.
const CAST = [
  ['bot', [9, 9], [13, 9]],
  ['ana', [16, 2], [15, 6]],
  ['chloe', [14, 14], [21, 12]],
  ['dev', [24, 2], [19, 6]],
  ['emi', [1, 14], [13, 12]],
  ['finn', [35, 4], [23, 6]],
  ['gia', [31, 17], [17, 12]],
  ['hugo', [35, 3], [21, 6]],
  ['ines', [1, 17], [15, 12]],
  ['jay', [35, 17], [23, 12]],
  ['kai', [1, 4], [17, 6]],
  ['lea', [28, 17], [19, 12]],
  ['ben', [35, 9], [23, 9]],
];
export const PLAYERS = CAST.map(([name, from, to], i) => {
  const path = route(MAZE2, [from, to]);
  const drop = DROP0 + DROP_DT * i;
  const arrive = Math.min(drop - 0.3, LAST_ARRIVE);
  // Nobody dawdles: slow walkers wait at their spawn and set off later.
  const speed = Math.max(6, (path.length - 1) / (arrive - WALK));
  const start = arrive - (path.length - 1) / speed;
  return { name, i, path, drop, arrive, speed, start };
});
const pIdx = (p, t) => Math.max(0, Math.min(p.path.length - 1, (t - p.start) * p.speed));

export function drawPlayer(g, p, x, y, t, opts = {}) {
  if (p.name === 'bot') bot(g, x, y, t, { running: opts.moving, eyesOnly: opts.eyesOnly });
  else coin(g, x, y, t, { phase: p.i * 5, bob: opts.moving !== false, ...opts });
}

function capsulePos(p, t) {
  // Held over the head, then lobbed into the slot over 0.3 s, landing at p.drop.
  const [x, y] = along(p.path, p.path.length - 1);
  const f = prog(Math.floor(t * 30) / 30, p.drop - 0.3, p.drop);
  const sx = VAULT.slotX, sy = VAULT.slotY - 1;
  const hx = x, hy = y - 12;
  const cx = Math.round(hx + (sx - hx) * f);
  const cy = Math.round(hy + (sy - hy) * f - Math.sin(f * Math.PI) * 14);
  return [cx, cy];
}

function hud(g, t, dropped) {
  rect(g, 0, 0, 320, 20, P.deep);
  rect(g, 0, 20, 320, 1, P.line);
  const tag = '2P · ';
  text(g, tag, 8, 7, P.white);
  text(g, 'EVEN', 8 + textWidth(tag) + 1, 7, P.lime);
  const right = 'BIDS ' + String(dropped).padStart(2, '0') + '/13';
  text(g, right, 312, 7, P.white, { align: 'right' });
  text(g, 'PRICE ?.??', 312 - textWidth(right) - 14, 7, P.dim, { align: 'right' });
}

export function draw(g, t, cam) {
  const dropped = PLAYERS.filter(p => t >= p.drop).length;
  if (t < LIGHTS_OUT) {
    rect(g, 0, 0, 320, 180, P.bg);
    drawMaze(g, MAZE2, { edge: P.lamp, fill: P.line });
    const hot = PLAYERS.some(p => t >= p.drop && t < p.drop + 0.07);
    drawVault(g, { hot, locked: dropped === 13 });
    for (const p of PLAYERS) {
      const [x, y] = along(p.path, pIdx(p, t));
      const moving = t >= p.start && t < p.arrive;
      drawPlayer(g, p, x, y, t, { moving, state: t >= p.drop && t < p.drop + 0.5 ? 'happy' : null });
      if (t < p.drop) {
        const [cx, cy] = t < p.drop - 0.3 ? [x, y - 12] : capsulePos(p, t);
        capsule(g, cx, cy);
      } else rect(g, x - 1, y - 11, 2, 2, P.lime); // sealed: lock pip
    }
    if (t >= 15.0 && t < 15.07) rect(g, 0, 0, 320, 180, P.white); // cut flash
    hud(g, t, dropped);
    if (t < 15.9) {
      const s = 'PLAYER 2 · SEALED BIDS';
      if (blink(t, 0.3, 0.2)) text(g, s, 160, 160, P.white, { align: 'center' });
    }
    return;
  }
  // Lights out: only the slot glows. Punch in on the vault.
  rect(g, 0, 0, 320, 180, P.night);
  cam.zoom = 2; cam.x = 80; cam.y = 50;
  const ticks = t < TICK0 ? 0 : Math.min(NTICK, 1 + Math.floor((t - TICK0) / TICK_DT + 1e-6));
  const tickHot = t >= TICK0 && ((t - TICK0) % TICK_DT) < 0.07 && ticks <= NTICK;
  drawVault(g, { dark: true, hot: t >= SEALED && t < SEALED + 0.1 });
  if (t < LIGHTS_OUT + 0.07) return; // a beat of pure black
  text(g, 'NOBODY SEES A PRICE', 160, 104, P.white, { align: 'center' });
  if (t >= TICK0) {
    // Ten pips, one goes dark per tick.
    for (let k = 0; k < NTICK; k++) {
      const on = k >= ticks;
      rect(g, 133 + k * 6, 116, 4, 2, on ? P.lime : P.line);
    }
    if (t < SEALED) {
      const n = String(NTICK - ticks + 1);
      text(g, n, 160, 58, tickHot ? P.white : P.glow, { align: 'center', scale: 2 });
    }
  }
  if (t >= SEALED) {
    text(g, 'BIDS SEALED', 160, 58, P.lime, { align: 'center' });
    text(g, '13', 160, 68, P.white, { align: 'center', scale: 1 });
  }
}
