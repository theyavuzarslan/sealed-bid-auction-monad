// Event registry for the AuctionEngine, built from the contract ABI (contracts/abi/AuctionEngine.json).
// The contract is the source of truth: layouts and topic0 hashes are derived from the ABI at load
// time, never hand-copied. indexer.test.mjs pins the topic0 hashes against `cast keccak` output, so
// an ABI change that the views do not handle fails the tests instead of silently mis-decoding.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eventRegistry } from "./abi.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_ABI_PATH = path.resolve(here, "../contracts/abi/AuctionEngine.json");

/** Every event the views consume (13). Emitted by AuctionEngine, SealingLayer and DepositLedger. */
export const EXPECTED_EVENTS = [
  "RoundOpened",
  "Committed",
  "Revealed",
  "UnrevealedBurned",
  "Cleared",
  "LPSeeded",
  "LPAbandoned",
  "ClaimsOpened",
  "UnsoldDisposed",
  "Claimed",
  "TokensClaimed",
  "VestedClaimed",
  "ProceedsWithdrawn",
];

/** Order of `AuctionEngine.Preset`. */
export const PRESETS = ["Degen", "Raise"];

export function loadAbi(abiPath = process.env.ABI_PATH || DEFAULT_ABI_PATH) {
  const json = JSON.parse(fs.readFileSync(abiPath, "utf8"));
  return Array.isArray(json) ? json : json.abi;
}

/** Registry of the expected events only; throws if the ABI lacks one. */
export function buildRegistry(abi = loadAbi()) {
  const all = eventRegistry(abi);
  const registry = {};
  for (const [topic, ev] of Object.entries(all)) {
    if (EXPECTED_EVENTS.includes(ev.name)) registry[topic] = ev;
  }
  const missing = EXPECTED_EVENTS.filter((n) => !Object.values(registry).some((e) => e.name === n));
  if (missing.length) throw new Error(`ABI is missing events: ${missing.join(", ")}`);
  return registry;
}
