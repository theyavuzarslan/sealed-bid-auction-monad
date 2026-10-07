// Original lattice maze, 8 px tiles. Walls are drawn as neon outlines: the
// corridor area is every open tile grown by 3 px, so corridors read 14 px wide.
import { P } from './palette.js';

export const COLS = 37, ROWS = 19, TILE = 8, OX = 12, OY = 22;

// Corridor segments: [row, c0, c1] horizontal, [col, r0, r1] vertical.
const H = [
  [1, 1, 35], [17, 1, 35], [4, 1, 12], [4, 16, 35], [14, 1, 20], [14, 24, 35],
  [9, 9, 16], [9, 20, 35], [7, 12, 24], [11, 12, 31],
];
const V = [
  [1, 1, 4], [1, 14, 17], [9, 1, 17], [16, 1, 9], [20, 4, 14], [24, 1, 7],
  [24, 11, 17], [28, 4, 14], [35, 1, 17], [12, 4, 7], [12, 11, 14], [31, 1, 4],
  [31, 14, 17], [5, 14, 17], [5, 1, 4],
];
// START box interior and its door.
export const BOX = { c0: 1, c1: 7, r0: 7, r1: 11, door: [8, 9] };

function baseGrid() {
  const g = Array.from({ length: ROWS }, () => Array(COLS).fill(false));
  for (const [r, a, b] of H) for (let c = a; c <= b; c++) g[r][c] = true;
  for (const [c, a, b] of V) for (let r = a; r <= b; r++) g[r][c] = true;
  return g;
}

export function makeMaze(kind) {
  const open = baseGrid();
  if (kind === 'curve') {
    for (let r = BOX.r0; r <= BOX.r1; r++) for (let c = BOX.c0; c <= BOX.c1; c++) open[r][c] = true;
    open[BOX.door[1]][BOX.door[0]] = true;
  } else {
    // Central vault room for the sealed cabinet.
    for (let r = 6; r <= 12; r++) for (let c = 13; c <= 23; c++) open[r][c] = true;
    for (let r = 7; r <= 11; r++) open[r][1] = true; // left loop
    for (let c = 1; c <= 8; c++) open[9][c] = true;
  }
  return { kind, open, ...buildMask(open) };
}

const isOpen = (open, c, r) => r >= 0 && r < ROWS && c >= 0 && c < COLS && open[r][c];

function buildMask(open) {
  const w = COLS * TILE, h = ROWS * TILE;
  const corr = new Uint8Array(w * h);
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
    if (!open[r][c]) continue;
    for (let y = r * TILE - 3; y < r * TILE + TILE + 3; y++)
      for (let x = c * TILE - 3; x < c * TILE + TILE + 3; x++)
        if (x >= 0 && y >= 0 && x < w && y < h) corr[y * w + x] = 1;
  }
  const edge = [], fill = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (corr[y * w + x]) continue;
    const n = (xx, yy) => xx >= 0 && yy >= 0 && xx < w && yy < h && corr[yy * w + xx];
    const tile = [Math.floor(x / TILE), Math.floor(y / TILE)];
    if (n(x - 1, y) || n(x + 1, y) || n(x, y - 1) || n(x, y + 1)) edge.push([x, y, tile]);
    else fill.push([x, y, tile]);
  }
  // BFS distance from the maze centre-left for the attract sweep.
  const dist = bfsDist(open, [9, 9]);
  for (const e of edge) e.push(nearDist(dist, e[2]));
  return { edge, fill, dist };
}

function bfsDist(open, [sc, sr]) {
  const d = Array.from({ length: ROWS }, () => Array(COLS).fill(-1));
  const q = [[sc, sr]]; d[sr][sc] = 0;
  while (q.length) {
    const [c, r] = q.shift();
    for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nc = c + dc, nr = r + dr;
      if (isOpen(open, nc, nr) && d[nr][nc] < 0) { d[nr][nc] = d[r][c] + 1; q.push([nc, nr]); }
    }
  }
  return d;
}

function nearDist(dist, [c, r]) {
  let best = 99;
  for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
    const v = dist[r + dr]?.[c + dc];
    if (v >= 0 && v < best) best = v;
  }
  return best;
}

// Shortest tile path from a to b (inclusive), deterministic neighbour order.
export function bfs(maze, a, b) {
  const prev = new Map();
  const key = (c, r) => r * COLS + c;
  const q = [a]; prev.set(key(...a), null);
  while (q.length) {
    const [c, r] = q.shift();
    if (c === b[0] && r === b[1]) break;
    for (const [dc, dr] of [[1, 0], [0, -1], [-1, 0], [0, 1]]) {
      const nc = c + dc, nr = r + dr;
      if (isOpen(maze.open, nc, nr) && !prev.has(key(nc, nr))) { prev.set(key(nc, nr), [c, r]); q.push([nc, nr]); }
    }
  }
  if (!prev.has(key(...b))) throw new Error('no path ' + a + ' -> ' + b);
  const out = [];
  for (let p = b; p; p = prev.get(key(...p))) out.push(p);
  return out.reverse();
}

// Chain waypoints into one tile path.
export function route(maze, pts) {
  let path = [pts[0]];
  for (let i = 1; i < pts.length; i++) path = path.concat(bfs(maze, pts[i - 1], pts[i]).slice(1));
  return path;
}

export const tileX = c => OX + c * TILE + 4;
export const tileY = r => OY + r * TILE + 4;

// Pixel centre at fractional tile distance d along a path (clamped).
export function along(path, d) {
  d = Math.max(0, Math.min(path.length - 1, d));
  const i = Math.floor(d), f = d - i;
  const [c0, r0] = path[i], [c1, r1] = path[Math.min(i + 1, path.length - 1)];
  return [Math.round(tileX(c0 + (c1 - c0) * f)), Math.round(tileY(r0 + (r1 - r0) * f))];
}

// Draw the maze. opts.edge / opts.fill colours; opts.lit(d) -> colour or null per edge pixel.
export function drawMaze(g, maze, opts = {}) {
  const { edge = P.purple, fill = P.line, lit = null, dx = 0, dy = 0 } = opts;
  const x0 = OX + dx, y0 = OY + dy;
  if (fill) {
    g.fillStyle = fill;
    for (const [x, y] of maze.fill) g.fillRect(x0 + x, y0 + y, 1, 1);
  }
  if (lit) {
    for (const [x, y, , d] of maze.edge) {
      const c = lit(d);
      if (!c) continue;
      g.fillStyle = c; g.fillRect(x0 + x, y0 + y, 1, 1);
    }
  } else if (edge) {
    g.fillStyle = edge;
    for (const [x, y] of maze.edge) g.fillRect(x0 + x, y0 + y, 1, 1);
  }
}
