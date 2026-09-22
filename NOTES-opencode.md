# NOTES — opencode (web UI task, 22 Sep 2026)

Observations from building `web/` against the docs. None of these are resolved by
guessing in the UI — each became a constructor parameter (web/config.js) or a
`// TODO: not specified` marker, and each is named in the task summary.

1. **Deposit asset vs bidding token (Q9).** `06-api.md` has `commit(roundId, hash)`
   payable with `value = depositAmount` (native MON), while the bidding token may
   be "MON, a stable, or creator's choice" (Q9) and deposits are "released net of
   fills" — if fills pay in an ERC-20 stable, a native-value deposit cannot be
   applied to the fill. The UI sends native value as specced; the tension is the
   docs'.

2. **Bidder-critical round fields missing from the proposed events.**
   `RoundOpened(roundId, preset, sellAmount, commitEnd, revealEnd)` carries no
   `auctioningToken`, `depositAmount`, or `minBidSize`. The bidder UI needs all
   three (header token, commit value, bid-size floor hint). Until a getter or
   widened event exists, they are constructor parameters in web/config.js
   (`sealingLayerAddress`, `depositAmountWei`, `tokenLabel`).

3. **Vesting absent from `openRound`.** `08-ui-notes.md` Screen 1 collects a
   vesting schedule for Raise, and `05-data-model.md` has a `vesting` struct, but
   the proposed `openRound(params)` in `06-api.md` has no vesting field. The UI
   collects cliff/duration (shape is Q7) and submits nothing for them.

4. **`Cleared.clearingPrice` singular vs fraction type.** `05-data-model.md`
   types the clearing price as a uint96 num/den fraction; the proposed event has
   one `clearingPrice` field. The UI decodes `Cleared(uint256,uint96,uint96,uint96)`
   as (clearingPriceNum, clearingPriceDen, filledVolume) — needs confirming when
   the contract is written.

5. **Refund vs deposit release not separable in `Claimed`.** Screen 3 wants
   "your fill, your refund, deposit released" but the proposed
   `Claimed(roundId, bidder, filled, refunded)` carries a single `refunded`
   value. The UI renders one combined line ("deposit released net of fills").

6. **Allowlist root derivation undefined (Q7).** Screen 1's Raise preset uploads
   an allowlist and `openRound` takes `allowlistRoot`, but no format or root
   derivation is specified. `deriveAllowlistRoot()` in
   `web/js/screens/creator.js` is an isolated, TODO-marked placeholder
   (keccak256 over sorted unique lowercase addresses).

7. **Window timebase unresolved.** `05-data-model.md` says commitEnd/revealEnd
   are "Timestamp/block". The UI assumes unix seconds (countdown needs wall
   clock); `config.windowTimebase` marks the assumption.

8. **Node's loader vs the vendored UMD.** Node 26 `require()` misdetects
   `vendor/js-sha3/sha3.js` (UMD) as an ESM module and returns an empty
   namespace. Browser loading (classic `<script>`) is unaffected;
   `web/selftest.mjs` loads the vendor via `new Function` and both paths are
   covered by keccak KATs.
