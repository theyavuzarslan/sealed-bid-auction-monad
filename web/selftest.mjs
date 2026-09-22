// Node self-test:  node web/selftest.mjs            (no network, no dependencies)
//                  node web/selftest.mjs --sync-abi (rewrite web/js/abi/AuctionEngine.js from contracts/abi)
// Reference vectors were produced with Foundry `cast` 1.8.3:
//   cast keccak $(cast abi-encode "f(uint96,uint96,bytes32,address)" <price> <amount> <salt> <bidder>)
//   cast keccak $(cast keccak $(cast abi-encode "f(address)" <addr>))       (allowlist leaf)
//   cast calldata "openRound((uint8,address,...))" "(...)"                    (tuple encoding)
// The on-chain half (contract accepts our hash, note and Merkle proof) is web/e2e.mjs.
import { webDir } from "./node-env.mjs";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const { keccak256, hexToBytes, bytesToHex } = await import("./js/hex.js");
const { makeInterface, decodeParams, encodeParams, decodeRevert } = await import("./js/abicoder.js");
const bid = await import("./js/bid.js");
const note = await import("./js/note.js");
const merkle = await import("./js/merkle.js");
const { engineIface, revertReason } = await import("./js/engine.js");
const ABI = (await import("./js/abi/AuctionEngine.js")).default;

const abiPath = path.join(webDir, "../contracts/abi/AuctionEngine.json");
if (process.argv.includes("--sync-abi")) {
  const src = JSON.parse(readFileSync(abiPath, "utf8"));
  writeFileSync(path.join(webDir, "js/abi/AuctionEngine.js"),
    "// Generated copy of contracts/abi/AuctionEngine.json (the contract is the source of truth).\n" +
    "// Regenerate with: node web/selftest.mjs --sync-abi   (selftest fails if the two drift)\n" +
    "export default " + JSON.stringify(src) + ";\n");
  console.log("wrote web/js/abi/AuctionEngine.js");
  process.exit(0);
}

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const ok = actual === expected;
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      expected: ${expected}\n      actual:   ${actual}`}`);
}
function throws(name, fn) {
  let threw = false;
  try { fn(); } catch { threw = true; }
  check(name, threw, true);
}
async function rejects(name, fn) {
  let threw = false;
  try { await fn(); } catch { threw = true; }
  check(name, threw, true);
}

// ── 0. ABI copy matches the contract's ABI ─────────────────────────────────────
check("web ABI copy == contracts/abi/AuctionEngine.json",
  JSON.stringify(ABI), JSON.stringify(JSON.parse(readFileSync(abiPath, "utf8"))));

// ── 1. keccak KATs ─────────────────────────────────────────────────────────────
check("keccak256('')", keccak256(new Uint8Array(0)), "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
check("keccak256('abc')", keccak256(hexToBytes("616263")), "0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45");

// ── 2. Commit hash == keccak256(abi.encode(uint96,uint96,bytes32,address)) ────
const HASH_VECTORS = [
  [10n ** 18n, 5n * 10n ** 18n, "0x0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20",
    "0x1111111111111111111111111111111111111111", "0xbac85ead30c48ac268dc15b0ea6690d6820fb338cd2eafe6362851176f932550"],
  [bid.UINT96_MAX, 1n, "0x" + "ff".repeat(32),
    "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", "0x85813f9452afeb614b0de2a2541138271478048264132f0dad2efba2eda2697b"],
  [2500000000000n, 123456789000000000000000n, "0x" + "00".repeat(31) + "aa",
    "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266", "0xd5600f04a70f300fc1bf7b6293741589123ebfde4d2ccb105519e469aab88db6"],
];
HASH_VECTORS.forEach(([p, a, s, who, want], i) => check(`commitHash vector ${i + 1} == cast`, bid.commitHash(p, a, s, who), want));
check("commitHash ignores address case",
  bid.commitHash(1n, 1n, "0x" + "11".repeat(32), "0x70997970c51812dc3a010c7d01b50e0d17dc79c8"),
  bid.commitHash(1n, 1n, "0x" + "11".repeat(32), "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"));
check("commitHash binds the salt",
  bid.commitHash(1n, 1n, "0x" + "11".repeat(32), "0x" + "22".repeat(20)) !== bid.commitHash(1n, 1n, "0x" + "12".repeat(32), "0x" + "22".repeat(20)), true);
check("commitHash binds the bidder",
  bid.commitHash(1n, 1n, "0x" + "11".repeat(32), "0x" + "22".repeat(20)) !== bid.commitHash(1n, 1n, "0x" + "11".repeat(32), "0x" + "23".repeat(20)), true);
throws("commitHash rejects zero price", () => bid.commitHash(0n, 1n, "0x" + "11".repeat(32), "0x" + "11".repeat(20)));
throws("commitHash rejects zero amount", () => bid.commitHash(1n, 0n, "0x" + "11".repeat(32), "0x" + "11".repeat(20)));
throws("commitHash rejects price >= 2^96", () => bid.commitHash(1n << 96n, 1n, "0x" + "11".repeat(32), "0x" + "11".repeat(20)));
throws("commitHash rejects short salt", () => bid.commitHash(1n, 1n, "0x1234", "0x" + "11".repeat(20)));
throws("commitHash rejects short address", () => bid.commitHash(1n, 1n, "0x" + "11".repeat(32), "0x1234"));
check("generateSalt is bytes32", /^0x[0-9a-f]{64}$/.test(bid.generateSalt()), true);
check("generateSalt is random", bid.generateSalt() !== bid.generateSalt(), true);

// ── 3. Calldata encoding == cast calldata ──────────────────────────────────────
const openParams = {
  preset: 1n, token: "0x5FbDB2315678afecb367f032d93F642f64180aa3", sellAmount: 10n ** 24n,
  depositAmount: 10n ** 18n, minBidSize: 10n ** 16n, tickSize: 10n ** 12n, reservePrice: 10n ** 12n,
  commitEnd: 1700000000n, revealEnd: 1700003600n, allowlistRoot: "0x" + "00".repeat(31) + "ab",
  allowlistURI: "ipfs://allow", lpShareBps: 2000n,
  dexSplits: [
    { adapter: "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0", bps: 6000n, fee: 3000n },
    { adapter: "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0", bps: 4000n, fee: 10000n },
  ],
  lockEnd: 1800000000n, lockFeeTier: "DEFAULT", tgeBps: 2500n, cliff: 0n, vestDuration: 7776000n,
};
const OPEN_CD = "0x7f36b301000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000010000000000000000000000005fbdb2315678afecb367f032d93f642f64180aa300000000000000000000000000000000000000000000d3c21bcecceda10000000000000000000000000000000000000000000000000000000de0b6b3a7640000000000000000000000000000000000000000000000000000002386f26fc10000000000000000000000000000000000000000000000000000000000e8d4a51000000000000000000000000000000000000000000000000000000000e8d4a51000000000000000000000000000000000000000000000000000000000006553f100000000000000000000000000000000000000000000000000000000006553ff1000000000000000000000000000000000000000000000000000000000000000ab000000000000000000000000000000000000000000000000000000000000024000000000000000000000000000000000000000000000000000000000000007d00000000000000000000000000000000000000000000000000000000000000280000000000000000000000000000000000000000000000000000000006b49d200000000000000000000000000000000000000000000000000000000000000036000000000000000000000000000000000000000000000000000000000000009c40000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000076a700000000000000000000000000000000000000000000000000000000000000000c697066733a2f2f616c6c6f77000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000020000000000000000000000009fe46736679d2d9a65f0992f2272de9f3c7fa6e000000000000000000000000000000000000000000000000000000000000017700000000000000000000000000000000000000000000000000000000000000bb80000000000000000000000009fe46736679d2d9a65f0992f2272de9f3c7fa6e00000000000000000000000000000000000000000000000000000000000000fa00000000000000000000000000000000000000000000000000000000000002710000000000000000000000000000000000000000000000000000000000000000744454641554c5400000000000000000000000000000000000000000000000000";
check("openRound(OpenParams) calldata == cast", engineIface.encodeFunction("openRound", [openParams]), OPEN_CD);
const COMMIT_CD = "0x436db844000000000000000000000000000000000000000000000000000000000000000700000000000000000000000000000000000000000000000000000000000000aa000000000000000000000000000000000000000000000000000000000000008000000000000000000000000000000000000000000000000000000000000000e0000000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000bb00000000000000000000000000000000000000000000000000000000000000cc00000000000000000000000000000000000000000000000000000000000000050102030405000000000000000000000000000000000000000000000000000000";
check("commit(...) calldata == cast", engineIface.encodeFunction("commit",
  [7n, "0x" + "00".repeat(31) + "aa", ["0x" + "00".repeat(31) + "bb", "0x" + "00".repeat(31) + "cc"], "0x0102030405"]), COMMIT_CD);
// Round trip the OpenParams tuple through the decoder.
const openFn = ABI.find((x) => x.name === "openRound");
const dec = decodeParams(openFn.inputs, "0x" + OPEN_CD.slice(10))[0];
check("OpenParams decode round trip", JSON.stringify(dec, (k, v) => typeof v === "bigint" ? v.toString() : v),
  JSON.stringify({ ...openParams, token: openParams.token.toLowerCase(),
    dexSplits: openParams.dexSplits.map((s) => ({ ...s, adapter: s.adapter.toLowerCase() })) },
  (k, v) => typeof v === "bigint" ? v.toString() : v));
check("Error(string) revert decode",
  decodeRevert("0x08c379a0" + bytesToHex(encodeParams([{ type: "string" }], ["bid exceeds deposit"])).slice(2)), "bid exceeds deposit");
check("revertReason from nested RPC error",
  revertReason({ code: 3, message: "execution reverted", data: "0x08c379a0" + bytesToHex(encodeParams([{ type: "string" }], ["wrong deposit"])).slice(2) }),
  "wrong deposit");
check("Committed topic0", engineIface.eventTopic("Committed"), keccak256(new TextEncoder().encode("Committed(uint256,address,bytes32,bytes)")));

// ── 4. Units, tick snapping, max spend rounding ───────────────────────────────
check("parseUnits 0.0001 @18", bid.parseUnits("0.0001", 18), 10n ** 14n);
check("parseUnits 12 @18", bid.parseUnits("12", 18), 12n * 10n ** 18n);
throws("parseUnits rejects too many decimals", () => bid.parseUnits("0.1234567", 6));
throws("parseUnits rejects junk", () => bid.parseUnits("1e5", 18));
check("formatUnits", bid.formatUnits(1234500000000000000n, 18), "1.2345");
check("snapToTick floors onto the grid", bid.snapToTick(1234567n, 1000n), 1234000n);
check("snapToTick keeps on-grid prices", bid.snapToTick(5000n, 1000n), 5000n);
check("perTokenToWire identity for 18 decimals", bid.perTokenToWire(777n, 18), 777n);
check("perTokenToWire for 6 decimals", bid.perTokenToWire(5n * 10n ** 15n, 6), 5n * 10n ** 27n);
check("maxSpend exact product", bid.maxSpend(2n * 10n ** 18n, 3n * 10n ** 18n), 6n * 10n ** 18n);
check("maxSpend rounds up (1 wei/token × 1 unit)", bid.maxSpend(1n, 1n), 1n);
check("maxSpend rounds up (price 3, amount 1e18/2+1)", bid.maxSpend(3n, 5n * 10n ** 17n + 1n), 2n);
check("maxSpend rounds up by exactly one wei", bid.maxSpend(10n ** 18n + 1n, 10n ** 18n + 1n), 10n ** 18n + 2n + 1n);
check("maxSpend zero", bid.maxSpend(0n, 5n), 0n);

// ── 5. Blocking conditions (mirror of AuctionEngine._onReveal) ────────────────
const R = { tickSize: 10n ** 12n, reservePrice: 10n ** 13n, minBidSize: 10n ** 16n, depositAmount: 10n ** 18n };
const codes = (p, a) => bid.bidProblems(R, p, a).map((x) => x.code).join(",");
check("valid bid has no problems", codes(10n ** 14n, 1000n * 10n ** 18n), "");
check("blocks maxSpend < minBidSize", codes(10n ** 13n, 999n * 10n ** 18n), "BELOW_MIN_BID");
check("allows maxSpend == minBidSize", codes(10n ** 13n, 1000n * 10n ** 18n), "");
check("blocks maxSpend == deposit", codes(10n ** 15n, 1000n * 10n ** 18n), "AT_OR_ABOVE_DEPOSIT");
check("blocks maxSpend > deposit", codes(10n ** 15n, 2000n * 10n ** 18n), "AT_OR_ABOVE_DEPOSIT");
check("allows maxSpend == deposit - 1 wei", codes(10n ** 15n, 1000n * 10n ** 18n - 1000n), "");
check("blocks maxSpend rounding up onto the deposit",
  codes(10n ** 15n, 1000n * 10n ** 18n - 999n) /* product/1e18 = 1e18 - 0.999 → ceil = 1e18 */, "AT_OR_ABOVE_DEPOSIT");
check("blocks price off the tick grid", codes(10n ** 14n + 1n, 1000n * 10n ** 18n), "OFF_TICK");
check("blocks price below reserve", codes(10n ** 12n, 20000n * 10n ** 18n), "BELOW_RESERVE");
check("blocks zero amount", codes(10n ** 14n, 0n), "ZERO_AMOUNT");
check("blocks amount above uint96", codes(10n ** 13n, 1n << 96n).split(",").includes("AMOUNT_TOO_LARGE"), true);

// ── 6. Recovery note ───────────────────────────────────────────────────────────
const ctx = { chainId: 31337, engine: "0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9", roundId: 3n, bidder: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" };
const sig = "0x" + "ab".repeat(64) + "1c";
const key = await note.keyFromSignature(sig);
const sample = { price: 123456789n, amount: 10n ** 21n, salt: bid.generateSalt() };
const n1 = await note.encryptNote(key, sample, ctx);
const back = await note.decryptNote(key, n1, ctx);
check("note round trip: price", back.price, sample.price);
check("note round trip: amount", back.amount, sample.amount);
check("note round trip: salt", back.salt, sample.salt);
const lens = new Set();
for (const b of [
  { price: 1n, amount: 1n, salt: "0x" + "00".repeat(32) },
  { price: bid.UINT96_MAX, amount: bid.UINT96_MAX, salt: "0x" + "ff".repeat(32) },
  sample,
]) lens.add(hexToBytes(await note.encryptNote(key, b, ctx)).length);
check("every note has the same length", [...lens].join(","), String(note.NOTE_LEN));
check("note fits MAX_NOTE_LENGTH (256)", note.NOTE_LEN <= 256, true);
check("two encryptions of one bid differ (fresh IV)", n1 !== await note.encryptNote(key, sample, ctx), true);
const tampered = hexToBytes(n1);
tampered[40] ^= 0x01;
await rejects("tampered ciphertext fails to decrypt", () => note.decryptNote(key, bytesToHex(tampered), ctx));
const tamperedTag = hexToBytes(n1);
tamperedTag[tamperedTag.length - 1] ^= 0x80;
await rejects("tampered tag fails to decrypt", () => note.decryptNote(key, bytesToHex(tamperedTag), ctx));
await rejects("truncated note fails", () => note.decryptNote(key, n1.slice(0, -2), ctx));
await rejects("note from another round fails", () => note.decryptNote(key, n1, { ...ctx, roundId: 4n }));
await rejects("note for another bidder fails", () => note.decryptNote(key, n1, { ...ctx, bidder: "0x" + "22".repeat(20) }));
await rejects("wrong signature fails", async () => note.decryptNote(await note.keyFromSignature("0x" + "cd".repeat(64) + "1b"), n1, ctx));
const key27 = await note.keyFromSignature("0x" + "ab".repeat(64) + "01"); // v = 1 ≡ 28
check("v=0/1 and v=27/28 derive the same key",
  (await note.decryptNote(key27, n1, ctx)).salt, sample.salt);
check("signaturesMatch normalises v", note.signaturesMatch("0x" + "ab".repeat(64) + "01", sig), true);
check("signaturesMatch detects a different signature", note.signaturesMatch("0x" + "ab".repeat(64) + "1b", sig), false);
const td = note.backupTypedData({ chainId: 143, engine: ctx.engine, roundId: 9n });
check("typed data domain", `${td.domain.name}/${td.domain.version}/${td.domain.chainId}/${td.domain.verifyingContract}`,
  `SealedBidAuction/1/143/${ctx.engine}`);
check("typed data message", `${td.message.roundId}/${td.message.purpose}`, "9/bid-backup");

// ── 7. Allowlist Merkle tree (OpenZeppelin StandardMerkleTree / MerkleProofLib) ─
const ALICE = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
check("leaf == cast keccak(keccak(abi.encode(address)))", merkle.leafOf(ALICE),
  "0x208697df1b2d4c083944c10909fe1ed6e99c1eaccff33ba129464b28f8245f01");
check("checksum == cast to-check-sum-address", merkle.toChecksumAddress(ALICE.toLowerCase()), ALICE);
// Same construction as contracts/test/AuctionEngine.t.sol (two leaves, sorted pair).
const BOB = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
const two = merkle.buildTree([ALICE, BOB]);
const la = merkle.leafOf(ALICE), lb = merkle.leafOf(BOB);
check("2-leaf root == forge test construction",
  merkle.rootOf(two), keccak256(hexToBytes((la < lb ? la + lb.slice(2) : lb + la.slice(2)))));
check("2-leaf proof for Alice is [leaf(Bob)]", JSON.stringify(merkle.proofFor(two, ALICE)), JSON.stringify([lb]));
const many = Array.from({ length: 7 }, (_, i) => "0x" + (i + 1).toString(16).padStart(40, "0"));
const { addresses, invalid } = merkle.parseAddressList("address\n" + many.join(",\n") + "\n" + many[0] + "\nnot-an-address\n");
check("CSV parse dedupes and flags junk", `${addresses.length}/${invalid.join("|")}`, "7/not-an-address");
const t7 = merkle.buildTree(addresses);
check("tree dump format", `${t7.format}/${t7.leafEncoding.join()}/${t7.tree.length}`, "standard-v1/address/13");
check("every proof verifies (MerkleProofLib algorithm)",
  addresses.every((a) => merkle.verifyProof(merkle.proofFor(t7, a), merkle.rootOf(t7), a)), true);
check("outsider has no proof", merkle.proofFor(t7, "0x" + "99".repeat(20)), null);
check("a member's proof fails for an outsider",
  merkle.verifyProof(merkle.proofFor(t7, addresses[0]), merkle.rootOf(t7), "0x" + "99".repeat(20)), false);
check("single-address tree: root = leaf, empty proof",
  `${merkle.rootOf(merkle.buildTree([ALICE])) === la}/${merkle.proofFor(merkle.buildTree([ALICE]), ALICE).length}`, "true/0");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
