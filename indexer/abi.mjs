// Minimal ABI codec driven by the ABI JSON: event topic hashing, log decoding and return-value
// decoding, including dynamic types (string, bytes, arrays) and tuples. No dependencies.
//
// Value representation: uint/int -> BigInt, address -> lowercase 0x hex, bool -> boolean,
// bytes/bytesN -> 0x hex, string -> string, tuple -> object keyed by component name, array -> array.

import { keccak256 } from "./keccak.mjs";

const strip = (hex) => (hex.startsWith("0x") ? hex.slice(2) : hex).toLowerCase();

/** Canonical type string used in signatures: tuples expand to (a,b,...). */
export function canonicalType(param) {
  if (param.type.startsWith("tuple")) {
    return `(${param.components.map(canonicalType).join(",")})${param.type.slice(5)}`;
  }
  return param.type;
}

export const signatureOf = (item) => `${item.name}(${item.inputs.map(canonicalType).join(",")})`;
export const selectorOf = (signature) => keccak256(signature).slice(0, 10);

// Array helpers: "uint256[3][]" -> outer dimension is the last bracket pair.
function arrayInfo(type) {
  const m = type.match(/^(.*)\[(\d*)\]$/);
  if (!m) return null;
  return { inner: m[1], length: m[2] === "" ? null : Number(m[2]) };
}

function isDynamic(param) {
  const arr = arrayInfo(param.type);
  if (arr) return arr.length === null || isDynamic({ ...param, type: arr.inner });
  if (param.type === "string" || param.type === "bytes") return true;
  if (param.type === "tuple") return param.components.some(isDynamic);
  return false;
}

function headSize(param) {
  if (isDynamic(param)) return 32;
  const arr = arrayInfo(param.type);
  if (arr) return arr.length * headSize({ ...param, type: arr.inner });
  if (param.type === "tuple") return param.components.reduce((n, c) => n + headSize(c), 0);
  return 32;
}

const word = (hex, pos) => {
  const w = hex.slice(pos * 2, pos * 2 + 64);
  if (w.length !== 64) throw new Error(`ABI data too short: need word at byte ${pos}`);
  return w;
};
const uintAt = (hex, pos) => BigInt("0x" + word(hex, pos));

function decodeStatic(type, w) {
  if (type === "address") return "0x" + w.slice(24);
  if (type === "bool") return BigInt("0x" + w) !== 0n;
  if (type.startsWith("uint")) return BigInt("0x" + w);
  if (type.startsWith("int")) {
    const bits = BigInt(type.slice(3) || 256);
    const v = BigInt("0x" + w) & ((1n << bits) - 1n);
    return v >= 1n << (bits - 1n) ? v - (1n << bits) : v;
  }
  const fixed = type.match(/^bytes(\d+)$/);
  if (fixed) return "0x" + w.slice(0, Number(fixed[1]) * 2);
  throw new Error(`unsupported ABI type ${type}`);
}

function decodeTuple(params, hex, base) {
  let head = base;
  const values = params.map((p) => {
    const pos = isDynamic(p) ? base + Number(uintAt(hex, head)) : head;
    head += headSize(p);
    return decodeAt(p, hex, pos);
  });
  return values;
}

function decodeAt(param, hex, pos) {
  const arr = arrayInfo(param.type);
  if (arr) {
    let length = arr.length;
    let start = pos;
    if (length === null) {
      length = Number(uintAt(hex, pos));
      start = pos + 32;
    }
    const elem = { ...param, type: arr.inner };
    return decodeTuple(Array(length).fill(elem), hex, start);
  }
  if (param.type === "tuple") {
    const vals = decodeTuple(param.components, hex, pos);
    return Object.fromEntries(param.components.map((c, i) => [c.name || String(i), vals[i]]));
  }
  if (param.type === "string" || param.type === "bytes") {
    const len = Number(uintAt(hex, pos));
    const body = hex.slice((pos + 32) * 2, (pos + 32 + len) * 2);
    if (body.length !== len * 2) throw new Error("ABI data too short for dynamic bytes");
    if (param.type === "bytes") return "0x" + body;
    return Buffer.from(body, "hex").toString("utf8");
  }
  return decodeStatic(param.type, word(hex, pos));
}

/** Decode an ABI-encoded parameter list (e.g. event data or call return data). */
export function decodeParams(params, data) {
  const hex = strip(data);
  const values = decodeTuple(params, hex, 0);
  return Object.fromEntries(params.map((p, i) => [p.name || String(i), values[i]]));
}

/** Build { topic0 -> event } for every non-anonymous event in an ABI. */
export function eventRegistry(abi) {
  const registry = {};
  for (const item of abi) {
    if (item.type !== "event" || item.anonymous) continue;
    const signature = signatureOf(item);
    registry[keccak256(signature)] = { name: item.name, signature, inputs: item.inputs };
  }
  return registry;
}

/**
 * Decode one raw RPC log against a registry. Returns null for logs that are not in it.
 * Indexed static values come from topics; indexed dynamic values are only their hash (kept as hex).
 */
export function decodeLog(registry, log) {
  const ev = registry[(log.topics[0] || "").toLowerCase()];
  if (!ev) return null;
  const indexed = ev.inputs.filter((i) => i.indexed);
  const plain = ev.inputs.filter((i) => !i.indexed);
  if (log.topics.length !== indexed.length + 1) {
    throw new Error(`${ev.name}: expected ${indexed.length + 1} topics, got ${log.topics.length}`);
  }
  const fromData = decodeParams(plain, log.data || "0x");
  const args = {};
  let t = 1;
  for (const input of ev.inputs) {
    if (input.indexed) {
      const w = strip(log.topics[t++]);
      args[input.name] = isDynamic(input) || input.type === "tuple" ? "0x" + w : decodeStatic(input.type, w);
    } else {
      args[input.name] = fromData[input.name];
    }
  }
  return {
    event: ev.name,
    args,
    address: log.address?.toLowerCase(),
    blockNumber: log.blockNumber == null ? null : Number(BigInt(log.blockNumber)),
    blockTimestamp: log.blockTimestamp == null ? null : Number(BigInt(log.blockTimestamp)),
    txHash: log.transactionHash?.toLowerCase(),
    logIndex: log.logIndex == null ? null : Number(BigInt(log.logIndex)),
  };
}

/** Encode a call whose arguments are all static words (uint/address/bool/bytes32). */
export function encodeStaticCall(signature, args) {
  const words = args.map((a) => {
    const v = typeof a === "boolean" ? BigInt(a) : BigInt(a);
    return (v < 0n ? (1n << 256n) + v : v).toString(16).padStart(64, "0");
  });
  return selectorOf(signature) + words.join("");
}

/** JSON.stringify replacer: BigInt -> decimal string. */
export const jsonReplacer = (_k, v) => (typeof v === "bigint" ? v.toString() : v);
