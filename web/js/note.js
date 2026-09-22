// Bid recovery note (decision 33, tasks/ui-bid.md "Bid recovery").
//
// Key:  sign EIP-712 {domain: SealedBidAuction/1/chainId/engine, message: {roundId, purpose: "bid-backup"}},
//       key = HKDF-SHA256(ikm = keccak256(signature)) -> AES-256-GCM.
// Note: version(1) || iv(12) || AES-GCM(plaintext(64)) || tag(16)  = 93 bytes, always.
//       plaintext = 0x01 || price uint96 (12) || amount uint96 (12) || salt (32) || zero pad (7).
//       Every field is fixed-width, and the plaintext is padded to 64 bytes, so every note has
//       the same length whatever the bid.
//       AAD = abi.encode(chainId, engine, roundId, bidder): a note only decrypts in its own context.
import { assert, bytesToHex, concatBytes, hexToBytes, keccak256, randomBytes, strip0x, utf8 } from "./hex.js";
import { encodeParams } from "./abicoder.js";

export const NOTE_VERSION = 1;
export const PLAINTEXT_LEN = 64;
export const IV_LEN = 12;
export const TAG_LEN = 16;
export const NOTE_LEN = 1 + IV_LEN + PLAINTEXT_LEN + TAG_LEN; // 93, under MAX_NOTE_LENGTH = 256
const HKDF_INFO = utf8("SealedBidAuction bid-backup v1");

const subtle = () => {
  const s = globalThis.crypto?.subtle;
  assert(s, "WebCrypto unavailable (needs a secure context: https or localhost)");
  return s;
};

export function backupTypedData({ chainId, engine, roundId }) {
  return {
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ],
      BidBackup: [
        { name: "roundId", type: "uint256" },
        { name: "purpose", type: "string" },
      ],
    },
    primaryType: "BidBackup",
    domain: { name: "SealedBidAuction", version: "1", chainId: Number(chainId), verifyingContract: engine },
    message: { roundId: BigInt(roundId).toString(), purpose: "bid-backup" },
  };
}

// Some wallets return v as 0/1, others as 27/28; normalise so the same wallet always
// derives the same key.
export function normalizeSignature(sigHex) {
  const b = hexToBytes(sigHex);
  assert(b.length === 65, "expected a 65-byte ECDSA signature");
  if (b[64] < 27) b[64] += 27;
  return bytesToHex(b);
}

export function signaturesMatch(a, b) {
  try {
    return normalizeSignature(a) === normalizeSignature(b);
  } catch {
    return false;
  }
}

export async function keyFromSignature(sigHex) {
  const ikm = hexToBytes(keccak256(hexToBytes(normalizeSignature(sigHex))));
  const base = await subtle().importKey("raw", ikm, "HKDF", false, ["deriveKey"]);
  return subtle().deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: HKDF_INFO },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export function noteAad({ chainId, engine, roundId, bidder }) {
  return encodeParams(
    [{ type: "uint256" }, { type: "address" }, { type: "uint256" }, { type: "address" }],
    [BigInt(chainId), engine, BigInt(roundId), bidder],
  );
}

function uint96Bytes(v) {
  v = BigInt(v);
  assert(v >= 0n && v < 1n << 96n, "uint96 out of range");
  return hexToBytes(v.toString(16).padStart(24, "0"));
}

export function encodePlaintext({ price, amount, salt }) {
  const s = hexToBytes(salt);
  assert(s.length === 32, "salt must be bytes32");
  const pt = new Uint8Array(PLAINTEXT_LEN);
  pt.set([NOTE_VERSION], 0);
  pt.set(uint96Bytes(price), 1);
  pt.set(uint96Bytes(amount), 13);
  pt.set(s, 25);
  return pt; // bytes 57..63 stay zero
}

export function decodePlaintext(pt) {
  assert(pt.length === PLAINTEXT_LEN, "bad plaintext length");
  assert(pt[0] === NOTE_VERSION, "unknown note version");
  for (let i = 57; i < PLAINTEXT_LEN; i++) assert(pt[i] === 0, "bad padding");
  return {
    price: BigInt(bytesToHex(pt.subarray(1, 13))),
    amount: BigInt(bytesToHex(pt.subarray(13, 25))),
    salt: bytesToHex(pt.subarray(25, 57)),
  };
}

export async function encryptNote(key, bid, ctx) {
  const iv = randomBytes(IV_LEN);
  const ct = new Uint8Array(await subtle().encrypt(
    { name: "AES-GCM", iv, additionalData: noteAad(ctx), tagLength: TAG_LEN * 8 },
    key,
    encodePlaintext(bid),
  ));
  const note = concatBytes(new Uint8Array([NOTE_VERSION]), iv, ct);
  assert(note.length === NOTE_LEN, "note length invariant");
  return bytesToHex(note);
}

// Throws on any tampering, wrong key, or wrong context.
export async function decryptNote(key, noteHex, ctx) {
  const note = hexToBytes(noteHex);
  assert(note.length === NOTE_LEN, "note has the wrong length");
  assert(note[0] === NOTE_VERSION, "unknown note version");
  const iv = note.subarray(1, 1 + IV_LEN);
  let pt;
  try {
    pt = new Uint8Array(await subtle().decrypt(
      { name: "AES-GCM", iv, additionalData: noteAad(ctx), tagLength: TAG_LEN * 8 },
      key,
      note.subarray(1 + IV_LEN),
    ));
  } catch {
    throw new Error("note did not decrypt (wrong wallet, wrong round, or tampered)");
  }
  return decodePlaintext(pt);
}

export function isEmptyNote(noteHex) {
  return !noteHex || strip0x(noteHex).length === 0;
}
