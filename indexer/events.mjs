// Event registry for the sealed-bid auction engine.
//
// Source of truth for the field lists is 06-api.md "Events (proposed)".
// Since emitting contracts do not exist yet (core/fork still outstanding),
// the topic0 hashes below were derived from these provisional signatures
// with `cast keccak`. Before merging the indexer against live contracts:
//   1. copy the real event declarations out of SealingLayer.sol /
//      ClearingCore.sol / DepositLedger.sol / LPSeeder.sol,
//   2. reset this table to match the ABI (names, order, types, and which
//      entries are `indexed`),
//   3. recompute each topic0 with:  cast keccak "ExactSignature(types...)"
//
// Indexed-ness assumption: nothing is indexed in this provisional table,
// so every field decodes from data. If the contracts index roundId,
// roundId moves to topics[1] and disappears from data.
const EVENTS = {
  "0x4f9edc3623d481bf3a6e66ee277e36b38d219e3abcfd12f5da38a1b3cfffab56": {
    name: "RoundOpened",
    signature: "RoundOpened(uint256,uint96,uint96,uint256,uint256)",
    fields: ["roundId", "preset", "sellAmount", "commitEnd", "revealEnd"],
  },
  "0x26a454697a4923cb3646779d831b5e4696bd3fab14b67dd6dfe23d72354f57dd": {
    name: "Committed",
    signature: "Committed(uint256,address,bytes32)",
    fields: ["roundId", "bidder", "hash"],
  },
  "0x670fdee14fc1ce4786a226c21882f5de6bcb4c96e9e72ed8cbdf75f2f5442f1d": {
    name: "Revealed",
    signature: "Revealed(uint256,address,uint96,uint96)",
    fields: ["roundId", "bidder", "price", "quantity"],
  },
  "0x052a8bde4735246ee118673cae264b9b029de874700b6dbd878c6c317149740e": {
    name: "Cleared",
    signature: "Cleared(uint256,uint96,uint96)",
    fields: ["roundId", "clearingPrice", "filledVolume"],
  },
  "0xf3a14f900159bafdc1683a95f3d1b2920b28044fcccf05622c0752db9daad1b9": {
    name: "Claimed",
    signature: "Claimed(uint256,address,uint96,uint96)",
    fields: ["roundId", "bidder", "filled", "refunded"],
  },
  "0x3a4e2a819d45274f9344fe9c19939e2b6eb3bfe72e5413e0605cdec305a4ca4c": {
    name: "Slashed",
    signature: "Slashed(uint256,address,uint96)",
    fields: ["roundId", "bidder", "amount"],
  },
  "0x94457eb7828d550eb27bb6d1598db12ced1b3d081e3096fa750a6ef464f5da57": {
    name: "LPSeeded",
    signature: "LPSeeded(uint256,address,uint96,uint96,uint64)",
    fields: ["roundId", "pool", "tokenAmount", "proceedsAmount", "lockedUntil"],
  },
};

export default EVENTS;
