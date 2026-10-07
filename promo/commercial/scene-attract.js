// Scene 1, attract mode (0-4 s): INSERT COIN, coin drops, maze lights up, EVEN title.
import { P, rect, prog, easeIn, blink } from './palette.js';
import { text, box } from './font.js';
import { coin, logo } from './sprites.js';
import { makeMaze, drawMaze } from './maze.js';

export const MAZE = makeMaze('curve');
const DMAX = Math.max(...MAZE.edge.map(e => e[3]).filter(d => d < 99));

function slotPanel(g, t, cx, cy) {
  // Cabinet coin door: dark plate, glowing slot, two bolts.
  rect(g, cx - 22, cy - 16, 44, 32, P.line);
  rect(g, cx - 21, cy - 15, 42, 30, P.deep);
  rect(g, cx - 18, cy - 12, 2, 2, P.dim); rect(g, cx + 16, cy - 12, 2, 2, P.dim);
  rect(g, cx - 18, cy + 10, 2, 2, P.dim); rect(g, cx + 16, cy + 10, 2, 2, P.dim);
  const hot = t >= 1.0 && t < 1.2;
  rect(g, cx - 2, cy - 9, 4, 18, hot ? P.white : P.lime);
  rect(g, cx - 1, cy - 8, 2, 16, hot ? P.lime : P.night);
  text(g, '25', cx - 14, cy - 3, P.dim, { font: 'tiny' });
  text(g, 'MON', cx + 5, cy - 3, P.dim, { font: 'tiny' });
}

export function draw(g, t, cam) {
  rect(g, 0, 0, 320, 180, P.night);
  if (t < 1.4) {
    const cx = 160, cy = 112;
    slotPanel(g, t, cx, cy);
    if (t >= 0.4 && t < 1.0 && blink(t - 0.4, 0.4, 0.26))
      text(g, 'INSERT COIN', 160, 62, P.white, { align: 'center', scale: 2, shadow: P.berry });
    if (t >= 0.5 && t < 1.0) {
      // Edge-on coin falls into the slot, stepping at 12 fps.
      const p = easeIn(prog(Math.floor(t * 12) / 12, 0.5, 1.0));
      const y = Math.round(-10 + p * (cy - 2 + 10));
      coin(g, cx, y, t, { bob: false });
    }
    if (t >= 1.0) {
      text(g, 'CREDIT 1', 160, 62, P.lime, { align: 'center', scale: 2 });
      if (t < 1.07) rect(g, 0, 0, 320, 180, P.white); // flash frames
      if (t >= 1.07 && t < 1.14) cam.sy = 1;
    }
    text(g, '1P', 8, 6, P.dim);
    return;
  }
  // Corridor-by-corridor light sweep, 1.4 -> 3.6.
  const front = prog(t, 1.4, 3.6) * (DMAX + 4);
  drawMaze(g, MAZE, {
    fill: null,
    lit: d => (d > front ? null : front - d < 2 ? P.white : front - d < 5 ? P.glow : P.purple),
  });
  text(g, 'CREDIT 1', 312, 6, P.lime, { align: 'right' });
  text(g, '1P', 8, 6, P.dim);
  if (t >= 2.6) {
    const pop = t < 2.67 ? 2 : 0;
    box(g, 112 - pop, 70 - pop, 96 + pop * 2, 40 + pop * 2, P.night, t < 2.67 ? P.white : P.purple);
    coin(g, 128, 90, t, { phase: 3 });
    logo(g, 172, 83, 2);
  }
}
