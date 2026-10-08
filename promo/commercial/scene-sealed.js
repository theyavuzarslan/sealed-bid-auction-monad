// Scene 3, sealed (15-26 s): 13 players post sealed capsules into one vault, then lights out.
// makeSealed(cfg) builds the scene from a set of times; the defaults are the 45 s cut.
import { P, rect, prog, blink } from './palette.js';
import { text, textWidth } from './font.js';
import { coin, bot, capsule } from './sprites.js';
import { makeMaze, drawMaze, route, along } from './maze.js';
import { drawVault, VAULT } from './vault.js';

export const MAZE2 = makeMaze('sealed');

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

const DEFAULTS = {
  WALK: 15.4, LAST_ARRIVE: 19.4, DROP0: 16.0, DROP_DT: 0.4, LIGHTS_OUT: 21.2,
  TICK0: 21.6, TICK_DT: 0.4, NTICK: 10, SEALED: 25.5,   // SEALED null to skip
  countBase: 1,              // shown number = NTICK - ticks + countBase
  cutT: 15.0, introEnd: 15.9,
  gathered: false,           // true: everyone starts on their ring spot (no walk)
  bigText: false,            // 30 s cut: scale-2 caption band, big countdown
};

export function drawPlayer(g, p, x, y, t, opts = {}) {
  if (p.name === 'bot') bot(g, x, y, t, { running: opts.moving, eyesOnly: opts.eyesOnly });
  else coin(g, x, y, t, { phase: p.i * 5, bob: opts.moving !== false, ...opts });
}

export function makeSealed(cfg = {}) {
  const C = { ...DEFAULTS, ...cfg };
  const { WALK, LAST_ARRIVE, DROP0, DROP_DT, LIGHTS_OUT, TICK0, TICK_DT, NTICK, SEALED } = C;

  const PLAYERS = CAST.map(([name, from, to], i) => {
    const path = route(MAZE2, [C.gathered ? to : from, to]);
    const drop = DROP0 + DROP_DT * i;
    const arrive = Math.min(drop - 0.3, LAST_ARRIVE);
    // Nobody dawdles: slow walkers wait at their spawn and set off later.
    const speed = Math.max(6, (path.length - 1) / Math.max(1e-6, arrive - WALK));
    const start = arrive - (path.length - 1) / speed;
    return { name, i, path, drop, arrive, speed, start };
  });
  const pIdx = (p, t) => Math.max(0, Math.min(p.path.length - 1, (t - p.start) * p.speed));

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

  function draw(g, t, cam) {
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
      if (t >= C.cutT && t < C.cutT + 0.07) rect(g, 0, 0, 320, 180, P.white); // cut flash
      hud(g, t, dropped);
      if (C.bigText) {
        // Caption band: what the capsules are, readable muted.
        rect(g, 0, 156, 320, 24, P.night);
        rect(g, 0, 156, 320, 1, P.line);
        text(g, 'EVERYONE SEALS A BID', 160, 161, P.white, { align: 'center', scale: 2, tight: true });
      } else if (t < C.introEnd) {
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
    drawVault(g, { dark: true, hot: SEALED !== null && t >= SEALED && t < SEALED + 0.1 });
    if (t < LIGHTS_OUT + 0.07) return; // a beat of pure black
    text(g, 'NOBODY SEES A PRICE', 160, 104, P.white, { align: 'center' });
    if (t >= TICK0) {
      // One pip per tick, each goes dark as it lands.
      const pw = C.bigText ? 8 : 4, gap = C.bigText ? 12 : 6;
      const x0 = C.bigText ? 160 - Math.round((NTICK * gap - (gap - pw)) / 2) : 133;
      for (let k = 0; k < NTICK; k++) {
        const on = k >= ticks;
        rect(g, x0 + k * gap, 116, pw, 2, on ? P.lime : P.line);
      }
      if (SEALED === null || t < SEALED) {
        const n = String(NTICK - ticks + C.countBase);
        if (C.bigText) {
          const last = n === '0';
          text(g, n, 160, 56, tickHot || last ? (last ? P.lime : P.white) : P.glow, { align: 'center', scale: 3 });
        } else text(g, n, 160, 58, tickHot ? P.white : P.glow, { align: 'center', scale: 2 });
      }
    }
    if (SEALED !== null && t >= SEALED) {
      text(g, 'BIDS SEALED', 160, 58, P.lime, { align: 'center' });
      text(g, '13', 160, 68, P.white, { align: 'center', scale: 1 });
    }
  }

  return { draw, PLAYERS };
}

const DEFAULT_SCENE = makeSealed();
export const draw = DEFAULT_SCENE.draw;
export const PLAYERS = DEFAULT_SCENE.PLAYERS;
