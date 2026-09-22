// MONEY-PATH MODULE — hand-written, flagged for line-by-line human review (AGENTS.md rule 4).
// Commit hash construction and salt generation sit between "bidder sends money"
// and "bidder gets tokens or a refund".

// h = keccak256(abi.encode(price, quantity, salt, msg.sender))
// Types per 05-data-model.md: price uint96, quantity uint96, salt bytes32, bidder address.
// TODO (06-api.md): confirm abi.encode vs abi.encodePacked once contract code exists;
// the docs direct abi.encode to avoid ambiguity.

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

export function hexToBytes(hex) {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  assert(h.length % 2 === 0, "hexToBytes: odd-length hex");
  assert(/^[0-9a-fA-F]*$/.test(h), "hexToBytes: non-hex input");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesToHex(bytes) {
  return "0x" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function keccak256Hex(bytes) {
  const k = globalThis.keccak256; // attached by vendor/js-sha3/sha3.js
  assert(typeof k === "function", "keccak256 unavailable: vendor/js-sha3/sha3.js must load first");
  return "0x" + k(bytes);
}

function wordHex(value) {
  assert(value >= 0n, "wordHex: negative value");
  return value.toString(16).padStart(64, "0");
}

const UINT96_MAX = 2n ** 96n - 1n;

// All four inputs are load-bearing: dropping the salt makes commitments
// brute-forceable; dropping msg.sender allows replay and reveal front-running.
export function commitPreimageHash(price, quantity, saltHex, senderHex) {
  price = BigInt(price);
  quantity = BigInt(quantity);
  assert(price > 0n && price <= UINT96_MAX, "price must be in (0, 2^96]");
  assert(quantity > 0n && quantity <= UINT96_MAX, "quantity must be in (0, 2^96]");
  const salt = saltHex.startsWith("0x") ? saltHex.slice(2) : saltHex;
  assert(/^[0-9a-fA-F]{64}$/.test(salt), "salt must be a bytes32 hex string");
  const sender = senderHex.startsWith("0x") ? senderHex.slice(2) : senderHex;
  assert(/^[0-9a-fA-F]{40}$/.test(sender), "sender must be a 20-byte address");
  // abi.encode of static types: each argument right-aligned in one 32-byte word, 128 bytes total.
  const encoded = wordHex(price) + wordHex(quantity) + salt.toLowerCase() + sender.toLowerCase().padStart(64, "0");
  return keccak256Hex(hexToBytes(encoded));
}

// CSPRNG salt; a lost salt means the bid cannot be revealed and the deposit is slashed.
export function generateSalt() {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return bytesToHex(b);
}

// Boot self-check: known-answer tests + a preimage vector cross-checked with
// `cast keccak` of `cast abi-encode "f(uint96,uint96,bytes32,address)" 1e18 5e18
//  0x0102...1f20 0x1111...1111` = 0xbac85ead30c48ac268dc15b0ea6690d6820fb338cd2eafe6362851176f932550.
export function selfCheck() {
  assert(keccak256Hex(new Uint8Array(0)) ===
    "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470", "keccak256 KAT failed (empty)");
  assert(keccak256Hex(hexToBytes("616263")) ===
    "0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45", "keccak256 KAT failed (abc)");
  const h = commitPreimageHash(
    1000000000000000000n,
    5000000000000000000n,
    "0x0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20",
    "0x1111111111111111111111111111111111111111"
  );
  assert(h === "0xbac85ead30c48ac268dc15b0ea6690d6820fb338cd2eafe6362851176f932550", "preimage vector mismatch");
  return true;
}
