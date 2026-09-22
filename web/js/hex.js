// Byte/hex helpers and keccak256 over the vendored js-sha3 (MIT, vendor/js-sha3).
// In the browser, vendor/js-sha3/sha3.js is loaded as a classic script and attaches
// `keccak256` to window. In node, web/node-env.mjs does the same.

export function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

export function strip0x(hex) {
  return hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
}

export function hexToBytes(hex) {
  const h = strip0x(hex);
  assert(h.length % 2 === 0, "hexToBytes: odd-length hex");
  assert(/^[0-9a-fA-F]*$/.test(h), "hexToBytes: non-hex input");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesToHex(bytes) {
  let s = "0x";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

export function concatBytes(...parts) {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export function utf8(str) {
  return new TextEncoder().encode(str);
}

export function keccak256(input) {
  const k = globalThis.keccak256;
  assert(typeof k === "function", "keccak256 unavailable: vendor/js-sha3/sha3.js must load first");
  const bytes = typeof input === "string" ? hexToBytes(input) : input;
  return "0x" + k(bytes);
}

export function isAddress(a) {
  return typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);
}

export function sameAddress(a, b) {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}

export function randomBytes(n) {
  const b = new Uint8Array(n);
  globalThis.crypto.getRandomValues(b);
  return b;
}

export function toQuantity(v) {
  return "0x" + BigInt(v).toString(16);
}
