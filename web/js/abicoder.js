// Minimal Solidity ABI coder driven by ABI JSON (no dependencies).
// Supports uintN/intN, address, bool, bytesN, bytes, string, T[], T[k] and tuples,
// which covers every type in AuctionEngine's ABI (OpenParams, Round, DexSplit[]).
// Values: integers as BigInt, addresses as lowercase 0x strings, bytes as 0x hex,
// tuples as objects keyed by component name (encode also accepts arrays).
import { assert, hexToBytes, bytesToHex, concatBytes, keccak256, strip0x, utf8 } from "./hex.js";

const WORD = 32;

function arrayInfo(type) {
  const m = type.match(/^(.*)\[(\d*)\]$/);
  if (!m) return null;
  return { inner: m[1], length: m[2] === "" ? null : Number(m[2]) };
}

function elemParam(p) {
  const a = arrayInfo(p.type);
  return { ...p, type: a.inner, name: "" };
}

export function canonicalType(p) {
  const a = arrayInfo(p.type);
  if (a) return canonicalType(elemParam(p)) + `[${a.length ?? ""}]`;
  if (p.type === "tuple") return "(" + p.components.map(canonicalType).join(",") + ")";
  return p.type;
}

function isDynamic(p) {
  const a = arrayInfo(p.type);
  if (a) return a.length === null || isDynamic(elemParam(p));
  if (p.type === "bytes" || p.type === "string") return true;
  if (p.type === "tuple") return p.components.some(isDynamic);
  return false;
}

function headSize(p) {
  if (isDynamic(p)) return WORD;
  const a = arrayInfo(p.type);
  if (a) return a.length * headSize(elemParam(p));
  if (p.type === "tuple") return p.components.reduce((n, c) => n + headSize(c), 0);
  return WORD;
}

function uintWord(v) {
  v = BigInt(v);
  assert(v >= 0n && v < 1n << 256n, "uint out of range");
  return hexToBytes(v.toString(16).padStart(64, "0"));
}

function padRight(bytes) {
  const len = Math.ceil(bytes.length / WORD) * WORD;
  const out = new Uint8Array(len);
  out.set(bytes);
  return out;
}

function encodeSingle(p, v) {
  const a = arrayInfo(p.type);
  if (a) {
    assert(Array.isArray(v), `${p.name || p.type}: expected array`);
    const ep = elemParam(p);
    if (a.length === null) return concatBytes(uintWord(v.length), encodeTuple(v.map(() => ep), v));
    assert(v.length === a.length, `${p.type}: wrong length`);
    return encodeTuple(v.map(() => ep), v);
  }
  if (p.type === "tuple") {
    const vals = Array.isArray(v) ? v : p.components.map((c) => {
      assert(c.name in v, `tuple field missing: ${c.name}`);
      return v[c.name];
    });
    return encodeTuple(p.components, vals);
  }
  let m;
  if ((m = p.type.match(/^uint(\d*)$/))) {
    const bits = BigInt(m[1] || 256);
    const x = BigInt(v);
    assert(x >= 0n && x < 1n << bits, `${p.name || p.type}: value out of ${p.type} range`);
    return uintWord(x);
  }
  if ((m = p.type.match(/^int(\d*)$/))) {
    const bits = BigInt(m[1] || 256);
    const x = BigInt(v);
    assert(x >= -(1n << (bits - 1n)) && x < 1n << (bits - 1n), `${p.type}: out of range`);
    return uintWord(x < 0n ? (1n << 256n) + x : x);
  }
  if (p.type === "address") {
    const h = strip0x(v);
    assert(/^[0-9a-fA-F]{40}$/.test(h), `${p.name || "address"}: not an address`);
    return hexToBytes(h.padStart(64, "0"));
  }
  if (p.type === "bool") return uintWord(v ? 1n : 0n);
  if ((m = p.type.match(/^bytes(\d+)$/))) {
    const b = hexToBytes(v);
    assert(b.length === Number(m[1]), `${p.type}: wrong length`);
    return padRight(b);
  }
  if (p.type === "bytes" || p.type === "string") {
    const b = p.type === "string" ? utf8(v) : (typeof v === "string" ? hexToBytes(v) : v);
    return concatBytes(uintWord(b.length), padRight(b));
  }
  throw new Error(`unsupported ABI type ${p.type}`);
}

function encodeTuple(params, values) {
  assert(params.length === values.length, "argument count mismatch");
  const heads = [];
  const tails = [];
  let offset = params.reduce((n, p) => n + headSize(p), 0);
  params.forEach((p, i) => {
    const enc = encodeSingle(p, values[i]);
    if (isDynamic(p)) {
      heads.push(uintWord(offset));
      tails.push(enc);
      offset += enc.length;
    } else {
      heads.push(enc);
    }
  });
  return concatBytes(...heads, ...tails);
}

export function encodeParams(params, values) {
  return encodeTuple(params, values);
}

function readWord(data, pos) {
  assert(pos + WORD <= data.length, "ABI decode: out of bounds");
  return BigInt(bytesToHex(data.subarray(pos, pos + WORD)));
}

function decodeSingle(p, data, base, pos) {
  // `pos` is where this value's head lives; dynamic values point to base + offset.
  const a = arrayInfo(p.type);
  if (isDynamic(p)) {
    const off = Number(readWord(data, pos));
    const start = base + off;
    if (a) {
      const ep = elemParam(p);
      let len = a.length;
      let inner = start;
      if (len === null) { len = Number(readWord(data, start)); inner = start + WORD; }
      return decodeTuple(Array.from({ length: len }, () => ep), data, inner);
    }
    if (p.type === "tuple") return toObj(p.components, decodeTuple(p.components, data, start));
    const len = Number(readWord(data, start));
    assert(start + WORD + len <= data.length, "ABI decode: bytes out of bounds");
    const b = data.slice(start + WORD, start + WORD + len);
    return p.type === "string" ? new TextDecoder().decode(b) : bytesToHex(b);
  }
  if (a) return decodeTuple(Array.from({ length: a.length }, () => elemParam(p)), data, pos);
  if (p.type === "tuple") return toObj(p.components, decodeTuple(p.components, data, pos));
  const w = readWord(data, pos);
  let m;
  if (/^uint\d*$/.test(p.type)) return w;
  if ((m = p.type.match(/^int(\d*)$/))) return w >= 1n << 255n ? w - (1n << 256n) : w;
  if (p.type === "address") return "0x" + w.toString(16).padStart(64, "0").slice(24);
  if (p.type === "bool") return w !== 0n;
  if ((m = p.type.match(/^bytes(\d+)$/))) return bytesToHex(data.subarray(pos, pos + Number(m[1])));
  throw new Error(`unsupported ABI type ${p.type}`);
}

function decodeTuple(params, data, base) {
  const out = [];
  let pos = base;
  for (const p of params) {
    out.push(decodeSingle(p, data, base, pos));
    pos += headSize(p);
  }
  return out;
}

function toObj(params, values) {
  if (!params.every((p) => p.name)) return values;
  const o = {};
  params.forEach((p, i) => { o[p.name] = values[i]; });
  return o;
}

export function decodeParams(params, hexData) {
  const data = typeof hexData === "string" ? hexToBytes(hexData) : hexData;
  return decodeTuple(params, data, 0);
}

export function signatureOf(item) {
  return `${item.name}(${item.inputs.map(canonicalType).join(",")})`;
}

export function selectorOf(item) {
  return keccak256(utf8(signatureOf(item))).slice(0, 10);
}

export function topicOf(item) {
  return keccak256(utf8(signatureOf(item)));
}

// Contract interface from ABI JSON.
export function makeInterface(abi) {
  const fns = new Map();
  const events = new Map();
  const byTopic = new Map();
  for (const item of abi) {
    if (item.type === "function") fns.set(item.name, item);
    if (item.type === "event") {
      events.set(item.name, item);
      byTopic.set(topicOf(item), item);
    }
  }
  const fn = (name) => {
    const f = fns.get(name);
    assert(f, `unknown function ${name}`);
    return f;
  };
  const ev = (name) => {
    const e = events.get(name);
    assert(e, `unknown event ${name}`);
    return e;
  };
  return {
    encodeFunction(name, args = []) {
      const f = fn(name);
      return selectorOf(f) + strip0x(bytesToHex(encodeParams(f.inputs, args)));
    },
    decodeResult(name, hexData) {
      const f = fn(name);
      const vals = decodeParams(f.outputs, hexData);
      if (f.outputs.length === 1) return vals[0];
      return Object.assign(vals, toObj(f.outputs, vals));
    },
    eventTopic(name) {
      return topicOf(ev(name));
    },
    // Decodes a raw log ({topics, data, blockNumber, transactionHash}).
    decodeLog(log) {
      const e = byTopic.get(log.topics[0]);
      if (!e) return null;
      const indexed = e.inputs.filter((i) => i.indexed);
      const plain = e.inputs.filter((i) => !i.indexed);
      const args = {};
      indexed.forEach((p, i) => {
        // Indexed dynamic values are hashes; none of this ABI's indexed params are dynamic.
        args[p.name] = isDynamic(p) ? log.topics[i + 1] : decodeParams([p], log.topics[i + 1])[0];
      });
      const vals = decodeParams(plain, log.data);
      plain.forEach((p, i) => { args[p.name] = vals[i]; });
      return {
        event: e.name,
        args,
        blockNumber: log.blockNumber != null ? Number(BigInt(log.blockNumber)) : null,
        transactionHash: log.transactionHash ?? null,
        address: log.address,
      };
    },
  };
}

// Decodes a revert payload: Error(string), Panic(uint256), or raw.
export function decodeRevert(hexData) {
  if (!hexData || hexData === "0x") return null;
  const h = strip0x(hexData);
  if (h.startsWith("08c379a0")) {
    try { return decodeParams([{ type: "string" }], "0x" + h.slice(8))[0]; } catch { /* fallthrough */ }
  }
  if (h.startsWith("4e487b71")) {
    try { return `panic 0x${decodeParams([{ type: "uint256" }], "0x" + h.slice(8))[0].toString(16)}`; } catch { /* fallthrough */ }
  }
  return "0x" + h;
}
