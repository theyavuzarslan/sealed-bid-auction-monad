// Allowlist Merkle tree compatible with OpenZeppelin's StandardMerkleTree (leafEncoding ["address"])
// and with contracts/src/lib/MerkleProofLib.sol:
//   leaf     = keccak256(bytes.concat(keccak256(abi.encode(address))))
//   internal = keccak256(sorted(a, b))            (sorted-pair hashing)
// The dump format ("standard-v1") is what StandardMerkleTree.load() reads, so creators can
// host it at allowlistURI and any OZ-compatible tool can produce proofs from it.
import { assert, concatBytes, hexToBytes, keccak256, utf8 } from "./hex.js";
import { encodeParams } from "./abicoder.js";

const cmp = (a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0);

export function toChecksumAddress(addr) {
  assert(/^0x[0-9a-fA-F]{40}$/.test(addr), `not an address: ${addr}`);
  const lower = addr.slice(2).toLowerCase();
  const h = keccak256(utf8(lower)).slice(2);
  let out = "0x";
  for (let i = 0; i < 40; i++) out += parseInt(h[i], 16) >= 8 ? lower[i].toUpperCase() : lower[i];
  return out;
}

export function leafOf(address) {
  const inner = keccak256(encodeParams([{ type: "address" }], [address]));
  return keccak256(hexToBytes(inner));
}

export function hashPair(a, b) {
  const [x, y] = cmp(a, b) <= 0 ? [a, b] : [b, a];
  return keccak256(concatBytes(hexToBytes(x), hexToBytes(y)));
}

// Parses a CSV / newline / whitespace separated list; returns unique checksummed addresses
// plus the tokens that were not addresses.
export function parseAddressList(text) {
  const seen = new Set();
  const addresses = [];
  const invalid = [];
  for (const raw of String(text).split(/[\s,;]+/)) {
    const t = raw.trim().replace(/^"|"$/g, "");
    if (!t) continue;
    if (!/^0x[0-9a-fA-F]{40}$/.test(t)) {
      if (!/^address$/i.test(t)) invalid.push(t);
      continue;
    }
    const k = t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    addresses.push(toChecksumAddress(t));
  }
  return { addresses, invalid };
}

export function buildTree(addresses) {
  assert(addresses.length > 0, "allowlist is empty");
  const hashed = addresses.map((a, valueIndex) => ({ value: a, valueIndex, hash: leafOf(a) }));
  hashed.sort((a, b) => cmp(a.hash, b.hash));
  const n = hashed.length;
  const tree = new Array(2 * n - 1);
  hashed.forEach((h, i) => { tree[tree.length - 1 - i] = h.hash; });
  for (let i = tree.length - 1 - n; i >= 0; i--) tree[i] = hashPair(tree[2 * i + 1], tree[2 * i + 2]);
  const values = addresses.map((a) => ({ value: [a], treeIndex: 0 }));
  hashed.forEach((h, leafIndex) => { values[h.valueIndex].treeIndex = tree.length - 1 - leafIndex; });
  return { format: "standard-v1", leafEncoding: ["address"], tree, values };
}

export function rootOf(dump) {
  return dump.tree[0];
}

export function proofFor(dump, address) {
  assert(dump && dump.format === "standard-v1", "allowlist file is not a StandardMerkleTree dump");
  assert(Array.isArray(dump.leafEncoding) && dump.leafEncoding.length === 1 && dump.leafEncoding[0] === "address",
    "allowlist leaf encoding must be [\"address\"]");
  const entry = dump.values.find((v) => String(v.value[0]).toLowerCase() === address.toLowerCase());
  if (!entry) return null;
  let i = entry.treeIndex;
  assert(dump.tree[i]?.toLowerCase() === leafOf(address).toLowerCase(), "allowlist file is inconsistent (leaf hash)");
  const proof = [];
  while (i > 0) {
    proof.push(dump.tree[i % 2 === 1 ? i + 1 : i - 1]);
    i = Math.floor((i - 1) / 2);
  }
  return proof;
}

// Same algorithm as MerkleProofLib.verify.
export function verifyProof(proof, root, address) {
  let h = leafOf(address);
  for (const p of proof) h = hashPair(h, p);
  return h.toLowerCase() === root.toLowerCase();
}

// ── allowlist hosting (bidder side) ──

export function resolveUri(uri, ipfsGateway) {
  return uri.startsWith("ipfs://") ? ipfsGateway + uri.slice(7) : uri;
}

export async function fetchAllowlist(uri, { ipfsGateway = "https://ipfs.io/ipfs/", fetchImpl = globalThis.fetch } = {}) {
  assert(uri, "the round has no allowlist URI");
  const res = await fetchImpl(resolveUri(uri, ipfsGateway));
  assert(res.ok, `allowlist fetch failed: HTTP ${res.status}`);
  return res.json();
}

// Checks the tree against the round's root, then returns the proof for `account` (null if absent).
export function proofForRound(dump, allowlistRoot, account) {
  assert(rootOf(dump).toLowerCase() === allowlistRoot.toLowerCase(), "allowlist tree root does not match this round");
  return proofFor(dump, account);
}
