// Chain reads for the round page: decodes the proposed events (06-api.md) into UI state.
// There is no indexer HTTP API yet (06-api.md marks it TODO) — the UI reads logs
// directly from the injected provider.
import cfg from "../config.js";
import { EVENTS, word, dataWords } from "./abi.js";
import { getLogs } from "./wallet.js";
import { addJourneyFee } from "./salt.js";

const addr = () => {
  if (!cfg.sealingLayerAddress) throw new Error("Sealing layer address not configured (web/config.js)");
  return cfg.sealingLayerAddress;
};

function roundTopicFilter(eventDef, roundId, bidder = null) {
  const topics = [eventDef.topic0, word(roundId)];
  if (bidder) topics.push(word(bidder));
  return { address: addr(), topics, fromBlock: "0x" + cfg.scanFromBlock.toString(16) };
}

export async function fetchRoundParams(roundId) {
  const logs = await getLogs(roundTopicFilter(EVENTS.RoundOpened, roundId));
  if (!logs.length) return null;
  return EVENTS.RoundOpened.decode(logs[logs.length - 1]);
}

// Commitment count + timing is the intentional public leak (05-data-model.md:
// "show it, do not hide it"). Revealed prices are decoded separately and must
// never render before the Cleared event (see screens/round.js).
export async function fetchCommitments(roundId) {
  const logs = await getLogs(roundTopicFilter(EVENTS.Committed, roundId));
  return logs.map((l) => EVENTS.Committed.decode(l));
}

export async function fetchRevealed(roundId) {
  const logs = await getLogs(roundTopicFilter(EVENTS.Revealed, roundId));
  return logs.map((l) => EVENTS.Revealed.decode(l));
}

export async function fetchCleared(roundId) {
  const logs = await getLogs(roundTopicFilter(EVENTS.Cleared, roundId));
  return logs.length ? EVENTS.Cleared.decode(logs[logs.length - 1]) : null;
}

export async function fetchMyClaim(roundId, account) {
  if (!account) return null;
  const logs = await getLogs(roundTopicFilter(EVENTS.Claimed, roundId, account));
  return logs.length ? EVENTS.Claimed.decode(logs[logs.length - 1]) : null;
}

// Commit / Reveal / Clearing / Settled — phase names per 08-ui-notes.md Screen 2.
export function phaseOf(params, cleared, nowSec) {
  if (!params) return { phase: "Unknown", nextAt: null };
  if (cleared) return { phase: "Settled", nextAt: null };
  if (nowSec < params.commitEnd) return { phase: "Commit", nextAt: params.commitEnd };
  if (nowSec < params.revealEnd) return { phase: "Reveal", nextAt: params.revealEnd };
  return { phase: "Clearing", nextAt: null };
}

export function recordJourneyFee(roundId, account, kind, receipt) {
  const gasUsed = BigInt(receipt.gasUsed);
  const price = BigInt(receipt.effectiveGasPrice || "0x0");
  addJourneyFee(roundId, account, kind, gasUsed * price);
}

// RoundOpened log inside an openRound receipt (to read the roundId the contract assigned).
export function findRoundOpenedInReceipt(receipt) {
  const logs = (receipt.logs || []).filter((l) =>
    l.address.toLowerCase() === addr().toLowerCase() &&
    l.topics[0] === EVENTS.RoundOpened.topic0
  );
  return logs.length ? EVENTS.RoundOpened.decode(logs[logs.length - 1]) : null;
}

export { dataWords };
