# Daily improvement backlog

One real improvement per day until the Metropolis deadline (13 Oct 2026), committed and pushed to `master` (Vercel redeploys https://even-monad.vercel.app on every push). The daily run takes the first unchecked item it can finish in one session, does it, ticks it here with the date and commit, and adds one line to the log at the bottom.

Status: settled

## Rules for every run

- Work only on items in this list, top to bottom; skip an item marked `(user)` or one that needs a decision, and leave a note.
- Do not change the money-path contracts (`contracts/src/SealingLayer.sol`, `DepositLedger.sol`, `UniformClearing.sol`, `AuctionEngine.sol`). Tests, scripts, web, indexer and docs are fine.
- Never deploy to a public network, touch keys or wallets, change the repo's visibility, or post anywhere.
- Every suite must pass before the push (commands in `CLAUDE.md`): `forge test` in `contracts/`, `node web/selftest.mjs`, `node web/e2e.mjs`, `node web/tools/reminder.test.mjs`, `npm test` in `indexer/`, `forge test` in `demo/`. If anything fails and can't be fixed in the run, revert the day's changes and log why instead of pushing.
- Claim wording: "snipe-resistant: submission timing no longer determines price"; never "no sniping", "MEV-proof" or "bot-proof"; never mention an encrypted mempool as something we use.
- Keep published numbers true (test counts in `SUBMISSION.md`, `PRODUCT.md`, `AUDIT.md`, `PRD-CONFORMANCE.md`, the Certified section in `web/js/screens/home.js`).

## Backlog

- [ ] **Serve the passkey libraries from the site.** Vendor Mera 0.2.0, viem 2.55.13 and @scure/bip39/bip32 2.4.0 as ESM files under `web/vendor/` (build them once with a pinned bundler run, record versions and SHA-256 in `web/vendor/README.md`), point `web/js/passkey-wallet.js` at them, and remove the jsDelivr runtime load and its disclosure line in `SUBMISSION.md` "Honest limits". Re-run the `?passkeytest=1` local round (see `SUBMISSION.md`).
- [ ] **Write-up for a VC-heavy panel.** Restructure `SUBMISSION.md` so the first screen is: the problem in one sentence, the head-to-head table, one line on who it is for, the live link. Mechanism, tests and limits follow. Keep every number sourced.
- [ ] **Thousands separators** in token and MON amounts across the web app and the share card (`web/js/format.js`), with selftests.
- [ ] **Unit tests for the passkey provider shim** (`web/js/passkey-wallet.js` `makeProvider`): request routing, typed-data handling (EIP712Domain removed), chain-switch refusal, using a fake account object; add to `web/selftest.mjs` or a new `web/tools/passkey.test.mjs`.
- [ ] **Demo-recording script**: one command (`demo/record-round.sh`) that starts anvil, deploys, creates a token, opens a Degen round and commits bids from several anvil accounts, then prints the URLs to open with `?devwallet=` / `?passkeytest=` for each stage, so the video can be shot in minutes.
- [ ] **Accessibility pass** with the impeccable audit on `web/` (contrast of every text token on its surface, focus order in the passkey dialog, `aria-live` on status messages); fix what it finds.
- [ ] **Envio indexer** (possible sponsor bounty; criteria unread): an Envio HyperIndex config for the engine's 13 events alongside the existing Node indexer, documented in `indexer/README.md`. Skip if it needs an account or API key.
- [ ] **Pitch deck** `(user)`: wait until the user says where it should live.

## Log

<!-- One line per run: date — item — commit — notes. -->
