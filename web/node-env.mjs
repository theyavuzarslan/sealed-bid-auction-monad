// Node shim for selftest.mjs and e2e.mjs: loads the vendored js-sha3 the way the browser does
// (a global `keccak256`). Node's require() misdetects the UMD file as ESM, so evaluate it directly.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const dir = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(dir, "vendor/js-sha3/sha3.js"), "utf8");
const mod = { exports: {} };
new Function("module", "exports", src)(mod, mod.exports);
globalThis.keccak256 = mod.exports.keccak256;

export const webDir = dir;
