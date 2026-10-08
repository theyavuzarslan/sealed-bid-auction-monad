// v3 scene 3, sealed (9.4-14.6 s): everyone is already at the vault; 13 capsules drop,
// lights out, countdown 3-2-1-0. Times from timeline-30.json.
import { makeSealed } from './scene-sealed.js';

export const { draw } = makeSealed({
  gathered: true, WALK: 9.4, LAST_ARRIVE: 9.4,
  DROP0: 9.6, DROP_DT: 0.2,            // 13 drops, 9.6 .. 12.0
  LIGHTS_OUT: 12.2,
  TICK0: 12.4, TICK_DT: 0.6, NTICK: 4, countBase: 0, // 3, 2, 1, 0 at 12.4 / 13.0 / 13.6 / 14.2
  SEALED: null,
  cutT: 9.4, bigText: true,
});
