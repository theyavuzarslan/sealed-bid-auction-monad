// Scene 6, end card (41.5-45 s): mascot and EVEN logo land, tagline, PRESS START.
import { P, rect, prog, easeIn, blink } from './palette.js';
import { text, textWidth, box } from './font.js';
import { coin, logo } from './sprites.js';
import { drawMaze } from './maze.js';
import { MAZE } from './scene-attract.js';

const LOGO = 41.7, PRESS = 43.0;

export function draw(g, t, cam) {
  rect(g, 0, 0, 320, 180, P.bg);
  drawMaze(g, MAZE, { edge: P.line, fill: P.deep });
  // Centre panel so text sits on a clean field.
  rect(g, 52, 4, 216, 172, P.deep);
  rect(g, 52, 4, 216, 1, P.line); rect(g, 52, 175, 216, 1, P.line);
  rect(g, 52, 4, 1, 172, P.line); rect(g, 267, 4, 1, 172, P.line);

  // Logo drop: falls in, one small bounce, stepped at 30 fps.
  const tf = Math.floor(t * 30) / 30;
  const fall = easeIn(prog(tf, 41.5, LOGO));
  let dy = Math.round(-70 * (1 - fall));
  if (tf > LOGO && tf < LOGO + 0.2) dy = -[3, 5, 5, 3, 1, 0][Math.floor((tf - LOGO) * 30)] || 0;
  if (t >= LOGO && t < LOGO + 0.13) cam.sy = Math.floor(t * 30) % 2 ? 1 : -1;
  coin(g, 160, 30 + dy, t, { scale: 3, bob: t > LOGO + 0.4, state: t < LOGO + 0.6 && t > LOGO ? 'happy' : null });
  // Pellets the coin is heading for.
  for (let k = 0; k < 3; k++) if (t >= LOGO + 0.2 + k * 0.1) rect(g, 190 + k * 9, 30, 3, 3, P.lime);
  logo(g, 160, 56 + dy, 4);

  if (t >= 42.0) text(g, 'NOBODY GETS A HEAD START.', 160, 96, P.white, { align: 'center', chars: Math.floor((t - 42.0) * 60) });
  if (t >= 42.3) text(g, 'FAIR LAUNCHES ON MONAD', 160, 108, P.glow, { align: 'center' });
  if (t >= 42.6) {
    const s = 'LIVE ON MONAD MAINNET';
    const bw = textWidth(s) + 10;
    box(g, 160 - bw / 2, 121, bw, 13, P.night, P.lime);
    text(g, s, 160, 124, P.lime, { align: 'center' });
  }
  if (t >= 42.8) text(g, 'EVEN-MONAD.VERCEL.APP', 160, 141, P.white, { align: 'center' });
  if (t >= PRESS && blink(t - PRESS, 0.5, 0.32)) text(g, 'PRESS START', 160, 158, P.berryLamp, { align: 'center', shadow: P.berry });
  if (t >= 41.5 && t < 41.57) rect(g, 0, 0, 320, 180, P.white);
}
