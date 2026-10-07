// The vault: a dark machine with a glowing bid slot. Shared by sealed and reveal.
import { P, rect } from './palette.js';
import { spr, LOCK } from './sprites.js';

export const VAULT = { x: 144, y: 82, w: 32, h: 28, slotX: 160, slotY: 88 };

// opts: dark (lights out: only the slot shows), hot (slot flash), open (0..1 door swing), locked.
export function drawVault(g, opts = {}) {
  const { dark = false, hot = false, open = 0, locked = false, glowSlot = true } = opts;
  const { x, y, w, h } = VAULT;
  if (!dark) {
    rect(g, x - 1, y - 1, w + 2, h + 2, P.line);
    rect(g, x, y, w, h, P.deep);
    rect(g, x + 2, y + 2, w - 4, 1, P.dim);           // top bevel
    rect(g, x + 3, y + h, 5, 2, P.line); rect(g, x + w - 8, y + h, 5, 2, P.line); // feet
    // LEDs
    rect(g, x + 3, y + 5, 2, 2, P.lime); rect(g, x + w - 5, y + 5, 2, 2, P.berryLamp);
    if (open <= 0) {
      // Door with a dial.
      rect(g, x + 4, y + 9, w - 8, h - 12, P.night);
      rect(g, x + 4, y + 9, w - 8, 1, P.dim);
      const cx = x + w / 2, cy = y + 17;
      rect(g, cx - 6, cy - 6, 12, 12, P.dim);
      rect(g, cx - 5, cy - 5, 10, 10, P.deep);
      if (!locked) {
        rect(g, cx - 1, cy - 4, 2, 8, P.glow); rect(g, cx - 4, cy - 1, 8, 2, P.glow);
        rect(g, cx - 1, cy - 1, 2, 2, P.white);
      }
      rect(g, x + w - 7, y + 14, 2, 6, P.glow); // handle
      if (locked) spr(g, LOCK, cx - 3, cy - 3, { g: P.lime, l: P.night });
    } else {
      // Door swings open: interior blazes, door panel narrows to the left.
      rect(g, x + 4, y + 9, w - 8, h - 12, P.white);
      rect(g, x + 6, y + 11, w - 12, h - 16, P.lime);
      const dw = Math.max(2, Math.round((w - 8) * (1 - open)));
      rect(g, x + 4 - Math.round(open * 6), y + 9, dw, h - 12, P.night);
      rect(g, x + 4 - Math.round(open * 6), y + 9, 1, h - 12, P.dim);
    }
  }
  // The slot always glows.
  const sx = VAULT.slotX, sy = VAULT.slotY;
  rect(g, sx - 8, sy - 2, 16, 5, dark ? P.night : P.line);
  if (glowSlot) {
    rect(g, sx - 7, sy - 1, 14, 3, hot ? P.white : P.lime);
    rect(g, sx - 6, sy, 12, 1, hot ? P.lime : P.night);
  }
}
