// v3 scene 6, end (25.4-30.0 s): coin + EVEN logo land, tagline, one call to action, PRESS START.
import { P, rect, blink } from './palette.js';
import { text, box } from './font.js';
import { coin, logo } from './sprites.js';
import { drawMaze } from './maze.js';
import { MAZE } from './scene-attract.js';

const LAND = 25.4, TAG = 26.1, CTA = 26.9, PRESS = 27.8;

export function draw(g, t, cam) {
  rect(g, 0, 0, 320, 180, P.bg);
  drawMaze(g, MAZE, { edge: P.line, fill: P.deep });
  // Clean field for the text.
  rect(g, 8, 4, 304, 172, P.deep);
  rect(g, 8, 4, 304, 1, P.line); rect(g, 8, 175, 304, 1, P.line);
  rect(g, 8, 4, 1, 172, P.line); rect(g, 311, 4, 1, 172, P.line);

  // Landing on the cut: impact flash, one small bounce, a short shake.
  const tf = Math.floor(t * 30) / 30;
  const dy = tf < LAND + 0.2 ? -([0, 4, 6, 6, 4, 2][Math.floor((tf - LAND) * 30)] || 0) : 0;
  if (t < LAND + 0.13) cam.sy = Math.floor(t * 30) % 2 ? 1 : -1;
  coin(g, 99, 36 + dy, t, { scale: 3, bob: t > LAND + 0.6, state: t < LAND + 0.7 ? 'happy' : null });
  logo(g, 186, 22 + dy, 4);
  if (t < LAND + 0.067) { rect(g, 0, 0, 320, 180, P.white); return; }

  if (t >= TAG) text(g, 'NOBODY GETS A HEAD START.', 160, 68, P.white,
    { align: 'center', scale: 2, tight: true, chars: Math.floor((t - TAG) * 80) + 1 });

  if (t >= CTA) {
    const pop = t < CTA + 0.067;
    box(g, 22, 92, 276, 46, pop ? P.white : P.night, P.lime);
    if (!pop) {
      rect(g, 23, 93, 274, 1, P.lime); rect(g, 23, 136, 274, 1, P.lime); // 2-px frame
      text(g, 'LAUNCH OR BID:', 160, 99, P.white, { align: 'center', scale: 2 });
      text(g, 'EVEN-MONAD.VERCEL.APP', 160, 118, P.lime, { align: 'center', scale: 2 });
    }
  }
  if (t >= PRESS && blink(t - PRESS, 0.5, 0.32))
    text(g, 'PRESS START', 160, 150, P.berryLamp, { align: 'center', scale: 2, shadow: P.berry });
}
