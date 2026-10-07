// Scene 2, bonding curve (4-15 s): the bot clears the maze, the crowd arrives late.
import { P, rect, prog, blink } from './palette.js';
import { text, box, textWidth } from './font.js';
import { coin, bot, pellet } from './sprites.js';
import { MAZE } from './scene-attract.js';
import { route, along, tileX, tileY, BOX, OX, OY, TILE } from './maze.js';

const BOT_GO = 5.0, STEP = 0.12, NB = 30;             // 30 bot pellets, 5.12 .. 8.6
const CROWD_GO = 8.4, CSPEED = 11;                      // tiles per second
const EATS = [[9.0, 'ana'], [9.4, 'chloe'], [9.8, 'emi'], [10.2, 'ines'], [10.6, 'emi']];
const GREY0 = 11.0, GREY_DT = 0.2;
const TOTAL_PELLETS = NB + EATS.length;

// Bot route from the door; pellet k sits at path index 2k.
const BOT_PATH = route(MAZE, [[8, 9], [9, 9], [9, 4], [12, 4], [12, 7], [24, 7], [24, 1], [35, 1], [35, 17], [26, 17]]);
const BOT_PELLETS = Array.from({ length: NB }, (_, k) => ({ tile: BOT_PATH[2 * (k + 1)], t: BOT_GO + STEP * (k + 1) }));
const botIdx = t => Math.min(2 * NB, Math.max(0, (t - BOT_GO) / (STEP / 2)));

// Crowd: 12 coins on a 4x3 grid in the START box, nearest the door leaves first.
const SPOTS = [[7, 9], [7, 7], [7, 11], [5, 9], [5, 7], [5, 11], [3, 9], [3, 7], [3, 11], [1, 9], [1, 7], [1, 11]];
const PLAN = {
  ana: [[9, 9], [9, 14], [1, 14]],
  chloe: [[9, 9], [16, 9], [16, 4]],
  emi: [[9, 9], [9, 17], [22, 17]],
  ines: [[9, 9], [9, 14], [12, 14], [12, 11], [27, 11]],
  // These eight reach corridors the bot already emptied.
  ben: [[9, 9], [9, 5]], dev: [[9, 9], [9, 4], [12, 5]], finn: [[9, 9], [16, 9], [16, 7], [14, 7]],
  gia: [[9, 9], [16, 9], [16, 7], [18, 7]], hugo: [[9, 9], [16, 9], [16, 7], [21, 7]],
  jay: [[9, 9], [16, 9], [16, 7], [24, 7], [24, 5]], kai: [[9, 9], [16, 9], [16, 7], [24, 7], [24, 2]],
  lea: [[9, 9], [16, 9], [16, 7], [24, 7], [24, 1], [27, 1]],
};
const ORDER = ['ana', 'chloe', 'emi', 'ines', 'ben', 'dev', 'finn', 'gia', 'hugo', 'jay', 'kai', 'lea'];
const DOOR = [8, 9];

const CROWD = ORDER.map((name, k) => {
  const path = route(MAZE, [SPOTS[k], DOOR, ...PLAN[name]]);
  const iDoor = path.findIndex(([c, r]) => c === DOOR[0] && r === DOOR[1]);
  return { name, k, path, iDoor };
});
let prevT = -1;
for (const c of CROWD) { c.T = Math.max(prevT + 0.1, CROWD_GO + c.iDoor / CSPEED); prevT = c.T; c.speed = CSPEED; }
// Grey-out order follows remaining distance; a late coin hurries so it arrives before its grey-out.
const GREYERS = CROWD.slice(4).sort((a, b) => (a.path.length - a.iDoor) - (b.path.length - b.iDoor));
GREYERS.forEach((c, j) => {
  c.grey = GREY0 + GREY_DT * j;
  const need = (c.path.length - 1 - c.iDoor) / (c.grey - 0.35 - c.T);
  c.speed = Math.max(CSPEED, need);
});
const cIdx = (c, t) => {
  const pre = c.iDoor - (c.T - t) * CSPEED; // walking to the door
  const i = t < c.T ? pre : c.iDoor + (t - c.T) * c.speed;
  return Math.max(0, Math.min(c.path.length - 1, i));
};
for (const c of CROWD) c.arrive = c.T + (c.path.length - 1 - c.iDoor) / c.speed;

// Crowd pellets sit where the eater will be at the eat time.
const CROWD_PELLETS = EATS.map(([te, name]) => {
  const c = CROWD.find(x => x.name === name);
  return { tile: c.path[Math.round(cIdx(c, te))], t: te, name };
});

function eatenCount(t) {
  let n = 0;
  for (const p of BOT_PELLETS) if (t >= p.t) n++;
  for (const p of CROWD_PELLETS) if (t >= p.t) n++;
  return n;
}

function hud(g, t) {
  rect(g, 0, 0, 320, 20, P.deep);
  rect(g, 0, 20, 320, 1, P.line);
  const tag = '1P · BONDING CURVE';
  const n = t < 4.3 ? 0 : Math.floor((t - 4.3) * 40);
  text(g, tag, 8, 7, P.white, { chars: n });
  const price = 0.10 + 0.30 * eatenCount(t) / TOTAL_PELLETS;
  const num = price.toFixed(2);
  const lbl = ' MON PER TOKEN';
  const w = textWidth(num + lbl);
  const x = 312 - w;
  const bump = BOT_PELLETS.concat(CROWD_PELLETS).some(p => t >= p.t && t < p.t + 0.06);
  text(g, num, x, 7 - (bump ? 1 : 0), P.lime);
  text(g, lbl, x + textWidth(num) + 1, 7, P.glow);
  text(g, 'PRICE', x, 1, P.dim, { font: 'tiny' });
}

function sparkle(g, x, y) {
  rect(g, x - 3, y, 2, 1, P.white); rect(g, x + 2, y, 2, 1, P.white);
  rect(g, x, y - 3, 1, 2, P.white); rect(g, x, y + 2, 1, 2, P.white);
}

function stampScreen(g, t, cam) {
  const st = t - 13.4;
  if (st < 0.05) { rect(g, 0, 0, 320, 180, P.white); return; }
  const shake = st < 0.4 ? [[2, -1], [-2, 1], [1, 2], [-1, -2], [2, 1], [0, -1]][Math.floor(st * 30) % 6] : [0, 0];
  cam.sx = shake[0]; cam.sy = shake[1];
  const s = st < 0.1 ? 4 : 3;
  const w = textWidth('BOT WINS', s);
  rect(g, 0, 52, 320, 64, P.night);
  rect(g, 0, 52, 320, 1, P.berryLamp); rect(g, 0, 115, 320, 1, P.berryLamp);
  text(g, 'BOT WINS', 160 - Math.round(w / 2), 62 - (s - 3) * 3, P.berryLamp, { scale: s, shadow: P.berry });
  if (st > 0.2) text(g, '8 OF 12 GOT NOTHING', 160, 96, P.white, { align: 'center' });
}

export function draw(g, t, cam) {
  rect(g, 0, 0, 320, 180, P.bg);
  // drawMaze imported lazily via attract's maze (same geometry, now with fill)
  drawMazeLit(g);
  // START box label and gate.
  const bx = OX + BOX.c0 * TILE, by = OY + BOX.r0 * TILE;
  text(g, 'START', bx + 14, by - 9, t < 4.3 || blink(t, 0.3, 0.2) ? P.lime : P.glow, { font: 'tiny' });
  const gateH = t < 4.3 ? 14 : Math.max(0, 14 - Math.floor((t - 4.3) * 12) * 4);
  if (gateH > 0) rect(g, OX + 9 * TILE - 2, tileY(9) - 7 + (14 - gateH) / 2, 2, gateH, P.lime);

  // Pellets.
  for (const p of BOT_PELLETS.concat(CROWD_PELLETS)) {
    const [c, r] = p.tile;
    if (t < 4.0 + 0.008 * (c + r * 3) % 0.3) continue; // pop in on the cut
    if (t < p.t) pellet(g, tileX(c), tileY(r));
    else if (t < p.t + 0.07) sparkle(g, tileX(c), tileY(r));
  }

  // Crowd.
  for (const c of CROWD) {
    const [x, y] = along(c.path, cIdx(c, t));
    const moving = t >= CROWD_GO && t < c.arrive;
    const grey = c.grey !== undefined && t >= c.grey;
    let state = null;
    if (grey) state = 'sad';
    else if (CROWD_PELLETS.some(p => p.name === c.name && t >= p.t && t < p.t + 0.3)) state = 'happy';
    coin(g, x, y, t, { grey, state, bob: !grey && (moving || t < CROWD_GO), phase: c.k * 3 });
    if (c.grey !== undefined && t >= c.arrive && t < c.grey + 0.6)
      text(g, '?', x - 2, y - 17, grey ? P.grey : P.white);
    const ate = CROWD_PELLETS.find(p => p.name === c.name && t >= p.t && t < p.t + 0.5);
    if (ate) text(g, c.name, x, y - 15, P.lime, { font: 'tiny', align: 'center' });
  }

  // Bot.
  const bi = botIdx(t);
  const [bx2, by2] = along(BOT_PATH, bi);
  const running = t >= BOT_GO && t < BOT_GO + STEP * NB;
  if (running) { rect(g, bx2 - 12, by2 - 2, 3, 1, P.berry); rect(g, bx2 - 15, by2 + 2, 2, 1, P.berry); }
  bot(g, bx2, by2, t, { running });
  if (t >= BOT_GO + STEP * NB) {
    text(g, 'BOT', bx2, by2 - 15, P.berryLamp, { font: 'tiny', align: 'center' });
    // Its stash: a stacked pile of tokens beside it.
    for (let i = 0; i < 5; i++) rect(g, bx2 + 9, by2 + 5 - i * 2, 6, 1, i % 2 ? P.lime : P.white);
  }

  hud(g, t);

  if (t >= 4.6 && t < 5.0) { // punch-in on the gate
    cam.zoom = 2; cam.x = 0; cam.y = 48;
    if (blink(t, 0.2, 0.12)) text(g, 'READY', 44, 60, P.white, { align: 'center' });
  }
  if (t >= 5.0 && t < 5.3) text(g, 'GO!', 160, 154, P.berryLamp, { align: 'center', scale: 2 });

  if (t >= 12.8) {
    box(g, 50, 128, 220, 16, P.night, P.glow);
    const a = 'BOT PAID 0.1375', b = ' · CROWD PAID 0.275';
    const x0 = 160 - Math.round(textWidth(a + b) / 2);
    text(g, a, x0, 133, P.berryLamp);
    text(g, b, x0 + textWidth(a) + 1, 133, P.white);
  }
  if (t >= 13.4) stampScreen(g, t, cam);
}

import { drawMaze } from './maze.js';
function drawMazeLit(g) { drawMaze(g, MAZE, { edge: P.purple, fill: P.line }); }

export const _debug = { CROWD, CROWD_PELLETS, BOT_PATH };
