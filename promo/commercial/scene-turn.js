// v3 scene 2, turn (8.0-9.4 s): hard cut to black, one coin drops into a slot, the question.
import { P, rect, prog, easeIn } from './palette.js';
import { text } from './font.js';
import { coin } from './sprites.js';
import { slotPanel } from './scene-attract.js';

const CLINK = 8.15, Q = 8.3;

export function draw(g, t, cam) {
  rect(g, 0, 0, 320, 180, P.night);
  const cx = 160, cy = 58;
  slotPanel(g, t, cx, cy, CLINK);
  if (t < CLINK) {
    // The coin falls into the slot, stepping at 12 fps.
    const p = easeIn(prog(Math.floor(t * 12) / 12, 8.0, CLINK));
    coin(g, cx, Math.round(-10 + p * (cy - 2 + 10)), t, { bob: false });
  } else if (t < CLINK + 0.07) cam.sy = 1;
  if (t >= Q) {
    const n = Math.floor((t - Q) * 110) + 1;
    const o = { align: 'center', scale: 2, tight: true };
    text(g, 'WHAT IF NOBODY', 160, 104, P.white, { ...o, chars: n });
    text(g, 'GOT A HEAD START?', 160, 124, P.lime, { ...o, chars: Math.max(0, n - 14) });
  }
}
