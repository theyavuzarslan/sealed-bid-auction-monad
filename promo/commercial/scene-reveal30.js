// v3 scene 4, reveal (14.6-21.0 s): vault opens, 13 steps, one price, DRAW.
import { makeReveal } from './scene-reveal.js';

export const { draw } = makeReveal({
  CONT: 14.6, CONT_END: 15.0, OPEN: 14.6,
  STEP0: 15.0, STEP_DT: 0.15,          // 13 steps, 15.0 .. 16.8
  SWEEP0: 17.0, SWEEP1: 17.6, LAND: 17.8, REFUND: 18.3, DRAW: 18.8, CAPTION: 19.5,
  bigText: true,
});
