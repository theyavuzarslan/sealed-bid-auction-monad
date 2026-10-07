// Fixed palette. Every pixel on the low-res canvas uses one of these.
export const P = {
  bg: '#200052',      // indigo
  deep: '#140033',
  night: '#0E100F',
  purple: '#6E54FF',
  lamp: '#8270FF',
  glow: '#B5A8FF',
  berry: '#A0055D',
  berryLamp: '#E0358F', // the bot
  white: '#FBFAF9',
  lime: '#C6F24E',
  line: '#2D1A66',
  dim: '#6D5FB0',
  grey: '#5A5470',
};

// Shared low-res helpers. Integer rects only.
export function rect(g, x, y, w, h, c) {
  g.fillStyle = c;
  g.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
}

// Stepped easing helpers (time-only, deterministic).
export const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
export const prog = (t, a, b) => clamp((t - a) / (b - a));
export const easeOut = p => 1 - (1 - p) * (1 - p);
export const easeIn = p => p * p;
// Hold-frame animation index: n frames at fps.
export const frameAt = (t, fps, n) => Math.floor(t * fps) % n;
// Blink: on for `on` seconds out of `period`.
export const blink = (t, period = 0.5, on = 0.3) => ((t % period) + period) % period < on;
// Deterministic hash for seeded randomness.
export function hash(n) {
  let x = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
  x ^= x >>> 13; x = Math.imul(x, 0xc2b2ae35); x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}
