// AuctionEngine client shared by the browser UI and the node e2e script.
// `request(method, params)` is any JSON-RPC transport (injected wallet or plain fetch).
// Transaction builders return {to, data, value}; the caller sends them.
import ENGINE_ABI from "./abi/AuctionEngine.js";
import { makeInterface, decodeRevert } from "./abicoder.js";
import { toQuantity, sameAddress } from "./hex.js";
import { commitHash } from "./bid.js";
import { decryptNote, keyFromSignature, isEmptyNote } from "./note.js";

export const engineIface = makeInterface(ENGINE_ABI);

export const ERC20_ABI = [
  { type: "function", name: "decimals", inputs: [], outputs: [{ name: "", type: "uint8" }], stateMutability: "view" },
  { type: "function", name: "symbol", inputs: [], outputs: [{ name: "", type: "string" }], stateMutability: "view" },
  { type: "function", name: "balanceOf", inputs: [{ name: "a", type: "address" }], outputs: [{ name: "", type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "allowance", inputs: [{ name: "o", type: "address" }, { name: "s", type: "address" }], outputs: [{ name: "", type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "approve", inputs: [{ name: "s", type: "address" }, { name: "v", type: "uint256" }], outputs: [{ name: "", type: "bool" }], stateMutability: "nonpayable" },
];
export const erc20Iface = makeInterface(ERC20_ABI);

export const NO_HINT = (1n << 256n) - 1n;
export const PRESET = { Degen: 0n, Raise: 1n };

// Extracts a revert reason from a JSON-RPC error (anvil, MetaMask and most nodes put it in error.data).
export function revertReason(err) {
  const seen = new Set();
  const walk = (e) => {
    if (!e || typeof e !== "object" || seen.has(e)) return null;
    seen.add(e);
    if (typeof e.data === "string" && e.data.startsWith("0x")) return decodeRevert(e.data);
    return walk(e.data) || walk(e.error) || walk(e.cause);
  };
  const r = walk(err);
  if (r) return r;
  const m = String(err?.message ?? err).match(/reverted(?: with reason string)?:? '?([^']+)'?/i);
  return m ? m[1] : null;
}

export function makeEngine({ request, address, fromBlock = 0n, logChunk = null }) {
  const iface = engineIface;

  async function call(name, args = [], from = undefined, target = address, ifc = iface) {
    const tx = { to: target, data: ifc.encodeFunction(name, args) };
    if (from) tx.from = from;
    const out = await request("eth_call", [tx, "latest"]);
    return ifc.decodeResult(name, out);
  }

  async function getLogs(topics, from = fromBlock) {
    const latest = BigInt(await request("eth_blockNumber", []));
    const start = BigInt(from);
    const chunk = logChunk ? BigInt(logChunk) : null;
    const out = [];
    for (let lo = start; lo <= latest; lo = chunk ? lo + chunk : latest + 1n) {
      const hi = chunk && lo + chunk - 1n < latest ? lo + chunk - 1n : latest;
      const logs = await request("eth_getLogs", [{ address, topics, fromBlock: toQuantity(lo), toBlock: toQuantity(hi) }]);
      for (const l of logs) out.push(iface.decodeLog(l));
    }
    return out;
  }

  const word = (v) => "0x" + BigInt(v).toString(16).padStart(64, "0");
  const addrTopic = (a) => "0x" + a.slice(2).toLowerCase().padStart(64, "0");

  const tx = (name, args, value = 0n) => ({ to: address, data: iface.encodeFunction(name, args), value });

  return {
    address,
    iface,
    call,
    getLogs,

    // ── reads ──
    roundCount: () => call("roundCount"),
    getRound: (id) => call("getRound", [id]),
    clearingOf: (id) => call("clearingOf", [id]),
    ledgers: (id) => call("ledgers", [id]),
    commitment: (id, who) => call("commitments", [id, who]),
    account: (id, who) => call("accounts", [id, who]),
    bidOf: (id, who) => call("bids", [id, who]),
    quote: (id, who) => call("quote", [id, who]),
    vestedOf: (id, who) => call("vestedOf", [id, who]),
    creatorAvailable: (id) => call("creatorAvailable", [id]),
    findHint: (id, price) => call("findHint", [id, price]),
    splitsOf: (id) => call("splitsOf", [id]),
    lpGracePeriod: () => call("lpGracePeriod"),
    maxNoteLength: () => call("MAX_NOTE_LENGTH"),

    async roundOpened(id) {
      const logs = await getLogs([iface.eventTopic("RoundOpened"), word(id)]);
      return logs[logs.length - 1] ?? null;
    },
    roundsByCreator(creator) {
      return getLogs([iface.eventTopic("RoundOpened"), null, addrTopic(creator)]);
    },
    committedLogs(id) {
      return getLogs([iface.eventTopic("Committed"), word(id)]);
    },
    async committedLog(id, bidder) {
      const logs = await getLogs([iface.eventTopic("Committed"), word(id), addrTopic(bidder)]);
      return logs[logs.length - 1] ?? null;
    },
    revealedLogs(id) {
      return getLogs([iface.eventTopic("Revealed"), word(id)]);
    },

    // ── erc20 ──
    erc20: {
      decimals: (t) => call("decimals", [], undefined, t, erc20Iface),
      symbol: (t) => call("symbol", [], undefined, t, erc20Iface),
      balanceOf: (t, a) => call("balanceOf", [a], undefined, t, erc20Iface),
      allowance: (t, o, s) => call("allowance", [o, s], undefined, t, erc20Iface),
      approveTx: (t, spender, v) => ({ to: t, data: erc20Iface.encodeFunction("approve", [spender, v]), value: 0n }),
    },

    // ── transactions ──
    tx: {
      openRound: (p) => tx("openRound", [p]),
      commit: (id, hash, proof, note, deposit) => tx("commit", [id, hash, proof, note], BigInt(deposit)),
      // A stale or invalid hint only costs gas (the contract falls back to walking the book).
      reveal: (id, bid, hint) => (hint == null || BigInt(hint) === NO_HINT
        ? tx("reveal", [id, bid.price, bid.amount, bid.salt])
        : tx("revealWithHint", [id, bid.price, bid.amount, bid.salt, hint])),
      settle: (id, maxSteps) => tx("settle", [id, maxSteps]),
      seedLP: (id) => tx("seedLP", [id]),
      forceOpenClaims: (id) => tx("forceOpenClaims", [id]),
      burnUnrevealed: (id) => tx("burnUnrevealed", [id]),
      claim: (id) => tx("claim", [id]),
      claimVested: (id) => tx("claimVested", [id]),
      withdrawProceeds: (id) => tx("withdrawProceeds", [id]),
      sweepDust: (id) => tx("sweepDust", [id]),
    },
  };
}

// Before any reveal: the bid must hash to the stored commitment, or the reveal reverts and
// the deposit is burned later. Returns {ok, onchain, local}.
export async function checkBidAgainstCommitment(engine, roundId, bidder, bid) {
  const c = await engine.commitment(roundId, bidder);
  const local = commitHash(bid.price, bid.amount, bid.salt, bidder);
  return { ok: c.hash.toLowerCase() === local.toLowerCase(), onchain: c.hash, local, revealed: c.revealed };
}

// Recovery path (decision 33): signature -> key -> decrypt this bidder's Committed note ->
// recompute the hash -> compare with the stored commitment. Throws with a `code`.
export async function recoverBidFromNote({ engine, chainId, roundId, bidder, signature }) {
  const fail = (code, message) => Object.assign(new Error(message), { code });
  const log = await engine.committedLog(roundId, bidder);
  if (!log) throw fail("NO_COMMIT", "No commitment from this wallet in this round.");
  if (!sameAddress(log.args.bidder, bidder)) throw fail("NO_COMMIT", "Commitment belongs to another address.");
  if (isEmptyNote(log.args.note)) throw fail("NO_NOTE", "This commitment carries no recovery note. Use your backup file.");
  const key = await keyFromSignature(signature);
  let bid;
  try {
    bid = await decryptNote(key, log.args.note, { chainId, engine: engine.address, roundId, bidder });
  } catch (e) {
    throw fail("DECRYPT_FAILED", "The recovery note did not decrypt with this wallet's signature. Use your backup file.");
  }
  const check = await checkBidAgainstCommitment(engine, roundId, bidder, bid);
  if (!check.ok) throw fail("HASH_MISMATCH", "The recovered bid does not match your commitment. Use your backup file.");
  return { ...bid, hash: check.local, commitTx: log.transactionHash };
}
