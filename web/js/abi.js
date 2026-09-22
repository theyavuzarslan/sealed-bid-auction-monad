// Contract surface used by the UI. All names/shapes are the *proposed* interface
// from 06-api.md ("names are proposals until code exists") — contract src/ is stubs today.
// TODO: align every signature here once contracts/src/SealingLayer.sol is written.
import { keccak256Hex, hexToBytes } from "./commitHash.js";

function utf8(s) {
  return new TextEncoder().encode(s);
}

// 4-byte selector, e.g. "0xf2f03877"
export function selectorOf(sig) {
  return keccak256Hex(utf8(sig)).slice(0, 10);
}

// Full 32-byte event topic, e.g. "0x26a45469..."
export function topic0(sig) {
  return keccak256Hex(utf8(sig));
}

export function word(v) {
  const n = BigInt(v);
  if (n < 0n) throw new Error("word: negative value");
  return "0x" + n.toString(16).padStart(64, "0");
}

function isHex32(h) {
  return typeof h === "string" && /^0x[0-9a-fA-F]{64}$/.test(h);
}

export function bytes32Word(h) {
  if (!isHex32(h)) throw new Error("bytes32Word: expected 32-byte hex");
  return h.toLowerCase();
}

export function addressWord(a) {
  if (typeof a !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(a)) throw new Error("addressWord: expected 20-byte address");
  return word(a);
}

export function dataWords(data) {
  const h = data.startsWith("0x") ? data.slice(2) : data;
  if (h.length % 64 !== 0) throw new Error("dataWords: bad data length");
  const out = [];
  for (let i = 0; i < h.length; i += 64) out.push("0x" + h.slice(i, i + 64));
  return out;
}

export function wordToBigInt(w) {
  return BigInt(w);
}

export function wordToAddress(w) {
  return "0x" + w.slice(-40).toLowerCase();
}

// ---- Proposed events (06-api.md) -------------------------------------------------
// TODO: which params are indexed is not specified; the UI assumes roundId and
// bidder are indexed (needed to filter logs by round and by bidder).
// TODO: the Cleared event names one "clearingPrice" field while 05-data-model.md
// types the clearing price as a uint96 num/den fraction; decoded here as (num, den).
export const EVENTS = {
  RoundOpened: {
    sig: "RoundOpened(uint256,uint8,uint96,uint64,uint64)",
    decode(log) {
      const d = dataWords(log.data);
      return {
        roundId: BigInt(log.topics[1]),
        preset: Number(BigInt(d[0])),
        sellAmount: BigInt(d[1]),
        commitEnd: BigInt(d[2]),
        revealEnd: BigInt(d[3]),
        blockNumber: log.blockNumber,
        txHash: log.transactionHash,
      };
    },
  },
  Committed: {
    sig: "Committed(uint256,address,bytes32)",
    decode(log) {
      const d = dataWords(log.data);
      return {
        roundId: BigInt(log.topics[1]),
        bidder: wordToAddress(log.topics[2]),
        hash: d[0],
        blockNumber: log.blockNumber,
        txHash: log.transactionHash,
      };
    },
  },
  Revealed: {
    sig: "Revealed(uint256,address,uint96,uint96)",
    decode(log) {
      const d = dataWords(log.data);
      return {
        roundId: BigInt(log.topics[1]),
        bidder: wordToAddress(log.topics[2]),
        price: BigInt(d[0]),
        quantity: BigInt(d[1]),
        blockNumber: log.blockNumber,
      };
    },
  },
  Cleared: {
    sig: "Cleared(uint256,uint96,uint96,uint96)",
    decode(log) {
      const d = dataWords(log.data);
      return {
        roundId: BigInt(log.topics[1]),
        clearingPriceNum: BigInt(d[0]),
        clearingPriceDen: BigInt(d[1]),
        filledVolume: BigInt(d[2]),
        blockNumber: log.blockNumber,
      };
    },
  },
  Claimed: {
    sig: "Claimed(uint256,address,uint96,uint96)",
    decode(log) {
      const d = dataWords(log.data);
      return {
        roundId: BigInt(log.topics[1]),
        bidder: wordToAddress(log.topics[2]),
        filled: BigInt(d[0]),
        refunded: BigInt(d[1]),
        blockNumber: log.blockNumber,
      };
    },
  },
};
for (const e of Object.values(EVENTS)) e.topic0 = topic0(e.sig);

// ---- Call encoders (06-api.md proposed functions) ---------------------------------

// openRound(params) — single struct argument per the proposed signature
// `openRound(params)`. TODO: flat-args variant if the contract expands `params`.
// Preset enum order per 05-data-model.md: Degen=0, Raise=1, Vault=2.
// TODO: vesting (Raise) is collected by Screen 1 but has no field in the proposed
// openRound surface (Q7) — not encoded.
export function encodeOpenRound(p) {
  const body = [
    word(p.preset),
    addressWord(p.auctioningToken),
    addressWord(p.biddingToken),
    word(p.sellAmount),      // uint96
    word(p.minBidSize),      // uint96
    word(p.depositAmount),   // uint256
    word(p.commitEnd),       // uint64 (TODO: timestamp vs block — see config.windowTimebase)
    word(p.revealEnd),       // uint64
    bytes32Word(p.allowlistRoot),
    word(p.autoLP ? 1 : 0),
  ].map((w) => w.slice(2)).join("");
  // head word = offset to the tuple body (0x20), then the 10 tuple words
  return SELECTORS.openRound + word(32n).slice(2) + body;
}

export function encodeCommit(roundId, hash) {
  return selectorOf("commit(uint256,bytes32)") + word(roundId).slice(2) + bytes32Word(hash).slice(2);
}

export function encodeReveal(roundId, price, quantity, salt) {
  return selectorOf("reveal(uint256,uint96,uint96,bytes32)") +
    word(roundId).slice(2) + word(price).slice(2) + word(quantity).slice(2) + bytes32Word(salt).slice(2);
}

export function encodeClaim(roundId) {
  return selectorOf("claim(uint256)") + word(roundId).slice(2);
}

// ERC-20 (approve needed for "Lock supply" — Flow 1 failure case: supply not approved → open reverts)
export function encodeApprove(spender, amount) {
  return selectorOf("approve(address,uint256)") + addressWord(spender).slice(2) + word(amount).slice(2);
}

export function encodeAllowance(owner, spender) {
  return selectorOf("allowance(address,address)") + addressWord(owner).slice(2) + addressWord(spender).slice(2);
}

export const SELECTORS = {
  openRound: selectorOf("openRound((uint8,address,address,uint96,uint96,uint256,uint64,uint64,bytes32,bool))"),
  commit: selectorOf("commit(uint256,bytes32)"),
  reveal: selectorOf("reveal(uint256,uint96,uint96,bytes32)"),
  claim: selectorOf("claim(uint256)"),
  approve: selectorOf("approve(address,uint256)"),
  allowance: selectorOf("allowance(address,address)"),
};
