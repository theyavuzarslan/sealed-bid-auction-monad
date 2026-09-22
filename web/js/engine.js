// AuctionEngine contract calls, shared by the browser UI and the node e2e script. No DOM.
// `request(method, params)` is any JSON-RPC transport (injected wallet or plain fetch).
// Transaction builders return {to, data, value}; the caller sends them.
import ENGINE_ABI from "./abi/AuctionEngine.js";
import { makeInterface, decodeRevert } from "./abicoder.js";
import { toQuantity } from "./hex.js";

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
export const ZERO32 = "0x" + "00".repeat(32);

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

  const engine = {
    address,
    iface,
    call,
    getLogs,
    decodeReceiptLogs: (rc) => (rc.logs || []).map((l) => {
      try { return l.address.toLowerCase() === address.toLowerCase() ? iface.decodeLog(l) : null; } catch { return null; }
    }).filter(Boolean),

    // ── reads ──
    roundCount: () => call("roundCount"),
    getRound: (id) => call("getRound", [id]),
    clearingOf: (id) => call("clearingOf", [id]),
    ledgers: (id) => call("ledgers", [id]),
    commitment: (id, who) => call("commitments", [id, who]),
    account: (id, who) => call("accounts", [id, who]), // refund settled?
    tokensClaimed: (id, who) => call("tokensClaimed", [id, who]),
    bidOf: (id, who) => call("bids", [id, who]),
    quote: (id, who) => call("quote", [id, who]),
    vestedOf: (id, who) => call("vestedOf", [id, who]),
    creatorAvailable: (id) => call("creatorAvailable", [id]),
    roundBalance: (id) => call("roundBalance", [id]),
    findHint: (id, price) => call("findHint", [id, price]),
    splitsOf: (id) => call("splitsOf", [id]),
    lpGracePeriod: () => call("lpGracePeriod"),
    minRaiseLock: () => call("MIN_RAISE_LOCK"),
    isAdapter: (a) => call("isAdapter", [a]),

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
      // Always revealWithHint: a hint from findHint makes insertion O(1) instead of walking the book.
      // A stale or NO_HINT value is safe: the contract falls back to walking.
      revealWithHint: (id, bid, hint) => tx("revealWithHint", [id, bid.price, bid.amount, bid.salt, BigInt(hint)]),
      settle: (id, maxSteps) => tx("settle", [id, maxSteps]),
      burnUnrevealed: (id) => tx("burnUnrevealed", [id]),
      seedLP: (id) => tx("seedLP", [id]),
      abandonLP: (id) => tx("abandonLP", [id]),
      disposeUnsold: (id) => tx("disposeUnsold", [id]),
      claim: (id) => tx("claim", [id]),
      claimRefund: (id, bidder) => tx("claimRefund", [id, bidder]),
      claimTokens: (id, bidder) => tx("claimTokens", [id, bidder]),
      claimVested: (id) => tx("claimVested", [id]),
      withdrawProceeds: (id) => tx("withdrawProceeds", [id]),
      sweepDust: (id) => tx("sweepDust", [id]),
    },

    // findHint at the latest state, then revealWithHint.
    async buildReveal(id, bid) {
      const hint = await engine.findHint(id, bid.price);
      return engine.tx.revealWithHint(id, bid, hint);
    },
  };
  return engine;
}
