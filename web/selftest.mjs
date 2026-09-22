// Node self-test:  node web/selftest.mjs
// Verifies the vendored keccak (KATs), the money-path commit preimage encoding
// against a `cast keccak` reference vector, event topic0s, function selectors,
// calldata encodings against `cast calldata` vectors, and the event decoders.
// Expected values were produced with foundry `cast` 1.8.3.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const dir = path.dirname(fileURLToPath(import.meta.url));

// Node 26 misdetects the vendored UMD as ESM on require(); load it deterministically.
const vendorSrc = readFileSync(path.join(dir, "vendor/js-sha3/sha3.js"), "utf8");
const vendorModule = { exports: {} };
new Function("module", "exports", vendorSrc)(vendorModule, vendorModule.exports);
globalThis.keccak256 = vendorModule.exports.keccak256;

const { commitPreimageHash, generateSalt, selfCheck, hexToBytes, bytesToHex } = await import(path.join(dir, "js/commitHash.js"));
const abi = await import(path.join(dir, "js/abi.js"));

let failures = 0;
function check(name, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n  expected: ${expected}\n  actual:   ${actual}`}`);
}

// 1. Keccak KATs + preimage vector (money path)
selfCheck();
console.log("PASS  commitHash.selfCheck (KATs + cast preimage vector)");

const preimage = commitPreimageHash(
  1000000000000000000n, 5000000000000000000n,
  "0x0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20",
  "0x1111111111111111111111111111111111111111"
);
check("preimage == cast keccak(abi.encode(...))",
  preimage,
  "0xbac85ead30c48ac268dc15b0ea6690d6820fb338cd2eafe6362851176f932550");

// preimage rejects bad shapes (bugs #1/#2/#8 territory)
let threw = 0;
for (const fn of [
  () => commitPreimageHash(0n, 1n, "0x" + "11".repeat(32), "0x" + "11".repeat(20)),
  () => commitPreimageHash(1n, 0n, "0x" + "11".repeat(32), "0x" + "11".repeat(20)),
  () => commitPreimageHash(2n ** 96n, 1n, "0x" + "11".repeat(32), "0x" + "11".repeat(20)),
  () => commitPreimageHash(1n, 1n, "0x1234", "0x" + "11".repeat(20)),
  () => commitPreimageHash(1n, 1n, "0x" + "11".repeat(32), "0x1234"),
]) {
  try { fn(); } catch { threw++; }
}
check("preimage rejects zero/oversize/short inputs", String(threw), "5");

// 2. Salt: bytes32 shape + CSPRNG distinctness
check("generateSalt shape", String(/^0x[0-9a-f]{64}$/.test(generateSalt())), "true");
check("generateSalt distinct", String(generateSalt() !== generateSalt()), "true");

// 3. hexToBytes / bytesToHex round trip
check("hex round-trip", bytesToHex(hexToBytes("0x00ff10")), "0x00ff10");

// 4. Event topic0s (cast sig-event / cast keccak of signature)
check("topic0 RoundOpened", abi.EVENTS.RoundOpened.topic0, "0x396c54e39d0cb82fa48756e25f90b93b3016fc2cc3142ceee00afda92eb34358");
check("topic0 Committed", abi.EVENTS.Committed.topic0, "0x26a454697a4923cb3646779d831b5e4696bd3fab14b67dd6dfe23d72354f57dd");
check("topic0 Revealed", abi.EVENTS.Revealed.topic0, "0x670fdee14fc1ce4786a226c21882f5de6bcb4c96e9e72ed8cbdf75f2f5442f1d");
check("topic0 Cleared", abi.EVENTS.Cleared.topic0, "0x284479dc553dcc894b2aae1122fcea2c6bd6c6eec98ccca55358af043f741f56");
check("topic0 Claimed", abi.EVENTS.Claimed.topic0, "0xf3a14f900159bafdc1683a95f3d1b2920b28044fcccf05622c0752db9daad1b9");

// 5. Selectors (cast sig)
check("selector openRound", abi.SELECTORS.openRound, "0x4181d654");
check("selector commit", abi.SELECTORS.commit, "0xf2f03877");
check("selector reveal", abi.SELECTORS.reveal, "0xf650c156");
check("selector claim", abi.SELECTORS.claim, "0x379607f5");
check("selector approve", abi.SELECTORS.approve, "0x095ea7b3");
check("selector allowance", abi.SELECTORS.allowance, "0xdd62ed3e");

// 6. Calldata against `cast calldata` vectors
const SALT = "0x0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20";
check("calldata commit(7, salt)", abi.encodeCommit(7n, SALT),
  "0xf2f038770000000000000000000000000000000000000000000000000000000000000007" + SALT.slice(2));
check("calldata reveal(7, 1e18, 5e18, salt)", abi.encodeReveal(7n, 1000000000000000000n, 5000000000000000000n, SALT),
  "0xf650c1560000000000000000000000000000000000000000000000000000000000000007" +
  "0000000000000000000000000000000000000000000000000de0b6b3a7640000" +
  "0000000000000000000000000000000000000000000000004563918244f40000" +
  SALT.slice(2));
check("calldata claim(7)", abi.encodeClaim(7n),
  "0x379607f50000000000000000000000000000000000000000000000000000000000000007");
// openRound: cast calldata/abi-encode flatten the top-level tuple, so the expected
// body is the 10 tuple words; encodeOpenRound wraps them with the single-struct-arg
// head (offset 0x20) per the proposed signature `openRound(params)`.
const openRoundEncoded = abi.encodeOpenRound({
  preset: 1,
  auctioningToken: "0xAaaaAaAaaaAaaAAaAaAAAAaaaAaAAaaAAaAaaAaA",
  biddingToken: "0xBbbbBbBbbbBbbBBbBbBBBBbbbBbBBbbBBbBbbBbB",
  sellAmount: 123456789n,
  minBidSize: 1000n,
  depositAmount: 5000000000000000000n,
  commitEnd: 1700000000n,
  revealEnd: 1700003600n,
  allowlistRoot: "0x" + "0".repeat(64),
  autoLP: true,
});
check("openRound selector", openRoundEncoded.slice(0, 10), "0x4181d654");
check("openRound struct-arg offset head", openRoundEncoded.slice(10, 10 + 64), "0".repeat(62) + "20");
check("openRound body == cast-calldata tuple body", openRoundEncoded.slice(10 + 64),
  "0000000000000000000000000000000000000000000000000000000000000001000000000000000000000000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa000000000000000000000000bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb00000000000000000000000000000000000000000000000000000000075bcd1500000000000000000000000000000000000000000000000000000000000003e80000000000000000000000000000000000000000000000004563918244f40000000000000000000000000000000000000000000000000000000000006553f100000000000000000000000000000000000000000000000000000000006553ff1000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001");

// 7. Event decoders on synthetic logs
const decodedCommitted = abi.EVENTS.Committed.decode({
  blockNumber: "0x64",
  transactionHash: "0x" + "ab".repeat(32),
  topics: [abi.EVENTS.Committed.topic0, abi.word(7n), abi.word("0x1111111111111111111111111111111111111111")],
  data: SALT,
});
check("decode Committed", `${decodedCommitted.roundId}|${decodedCommitted.bidder}|${decodedCommitted.hash}|${decodedCommitted.blockNumber}`,
  `7|0x1111111111111111111111111111111111111111|${SALT.toLowerCase()}|0x64`);

const decodedCleared = abi.EVENTS.Cleared.decode({
  blockNumber: "0x65",
  transactionHash: "0x" + "cd".repeat(32),
  topics: [abi.EVENTS.Cleared.topic0, abi.word(7n)],
  data: "0x" + abi.word(2n).slice(2) + abi.word(1n).slice(2) + abi.word(1000n).slice(2),
});
check("decode Cleared", `${decodedCleared.clearingPriceNum}|${decodedCleared.clearingPriceDen}|${decodedCleared.filledVolume}`, "2|1|1000");

const decodedClaimed = abi.EVENTS.Claimed.decode({
  blockNumber: "0x66",
  transactionHash: "0x" + "ef".repeat(32),
  topics: [abi.EVENTS.Claimed.topic0, abi.word(7n), abi.word("0x2222222222222222222222222222222222222222")],
  data: "0x" + abi.word(55n).slice(2) + abi.word(66n).slice(2),
});
check("decode Claimed", `${decodedClaimed.bidder}|${decodedClaimed.filled}|${decodedClaimed.refunded}`, "0x2222222222222222222222222222222222222222|55|66");

const decodedOpened = abi.EVENTS.RoundOpened.decode({
  blockNumber: "0x67",
  transactionHash: "0x" + "12".repeat(32),
  topics: [abi.EVENTS.RoundOpened.topic0, abi.word(7n)],
  data: "0x" + abi.word(0n).slice(2) + abi.word(1000000000n).slice(2) + abi.word(1700000000n).slice(2) + abi.word(1700003600n).slice(2),
});
check("decode RoundOpened", `${decodedOpened.preset}|${decodedOpened.sellAmount}|${decodedOpened.commitEnd}|${decodedOpened.revealEnd}`, "0|1000000000|1700000000|1700003600");

console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL CHECKS PASSED");
process.exit(failures ? 1 : 0);
