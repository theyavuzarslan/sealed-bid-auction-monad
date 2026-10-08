// v3 scene 1, hook (0-8 s): cold open mid-race. The bonding-curve maze is already lit and
// the bot is already eating; big captions carry the story with the sound off.
import { P, rect } from './palette.js';
import { text } from './font.js';
import { makeCurve } from './scene-curve.js';

const CURVE = makeCurve({
  BOT_GO: -0.1, STEP: 0.1, NB: 30, pelletT: k => k / 10,   // a pellet every 0.1 s, 0.0 .. 2.9
  // Already 6 tiles out of the box at t=0; ends mid-maze so the caption band never hides it.
  botRoute: [[8, 9], [9, 9], [9, 4], [12, 4], [12, 7], [24, 7], [24, 1], [35, 1], [35, 9], [20, 9], [20, 11]],
  botOffset: 6,
  CROWD_GO: 3.2,
  EATS: [[3.6, 'ana'], [4.0, 'chloe'], [4.4, 'emi'], [4.8, 'ines']],
  plan: { emi: [[9, 9], [9, 14], [17, 14]] },     // off the bottom row (caption band)
  GREY0: 5.0, GREY_DT: 0.2,
  cutT: -1, tagT: -10, gateT: 3.0,
  punchIn: null, goText: null,
  HUD_T: null, STAMP_T: 7.0,
  bigPrice: true, bigStamp: true,
});

const CAP = [[0.2, 2.0, 'TOKEN LAUNCHES ARE A RACE.'], [2.0, 6.6, 'THE FASTEST BOT WINS IT.']];
const PAID = 6.6;

function band(g) {
  rect(g, 0, 151, 320, 29, P.night);
  rect(g, 0, 151, 320, 1, P.line);
}

export function draw(g, t, cam) {
  CURVE.draw(g, t, cam);
  band(g);
  for (const [a, b, s] of CAP) {
    if (t < a || t >= b) continue;
    text(g, s, 160, 158, P.white, { align: 'center', scale: 2, tight: true, chars: Math.floor((t - a) * 90) + 1 });
  }
  if (t >= PAID) {
    // Scoreboard: what each side paid per token.
    const pop = t < PAID + 0.07;
    text(g, 'BOT PAID', 80, 154, P.berryLamp, { align: 'center' });
    text(g, '0.1375', 80, 163, pop ? P.white : P.berryLamp, { align: 'center', scale: 2 });
    text(g, 'VS', 160, 163, P.dim, { align: 'center' });
    text(g, 'CROWD PAID', 240, 154, P.white, { align: 'center' });
    text(g, '0.275', 240, 163, pop ? P.lime : P.white, { align: 'center', scale: 2 });
  }
}
