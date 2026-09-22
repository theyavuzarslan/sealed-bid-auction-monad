// Constructor parameters for the UI (tasks/ui.md rule: anything the docs leave
// unspecified becomes a parameter here and is named in the task summary — do not guess).
export default {
  // TODO: Monad testnet chain id is not specified in the docs; null = no chain enforcement.
  chainId: null,
  // TODO: set after testnet deploy; null = screens render but onchain data is unavailable.
  sealingLayerAddress: null,
  // First block scanned for logs (RoundOpened / Committed / ...).
  scanFromBlock: 0,
  // Log refresh interval while a round page is open.
  pollMs: 4000,
  // TODO: 05-data-model.md says commitEnd/revealEnd are "Timestamp/block" — unresolved.
  // The UI assumes unix timestamps in seconds. "block" mode is not implemented.
  windowTimebase: "timestamp",
  // TODO: no proposed event or getter exposes the uniform deposit; the commit
  // transaction needs value = depositAmount. Constructor parameter until a
  // getter or event field exists. null = commit disabled.
  depositAmountWei: null,
  // TODO: auctioningToken is not a field of the proposed RoundOpened event.
  // Label shown in the round header until a getter or event field exists.
  tokenLabel: null,
  // TODO: token decimals are not specified anywhere; 18 assumed for both.
  tokenDecimals: 18,
  biddingTokenDecimals: 18,
  // Native (MON) decimals used for deposit and gas-fee formatting.
  nativeDecimals: 18,
  // TODO: fee USD display needs a MON/USD price source; null = show MON only.
  monPriceUsd: null,
}
