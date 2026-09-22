# 08 — UI Notes

Screen-by-screen description of the creator, bidder, and demo interfaces.

Status: draft

The screens below were first derived from the PRD's flows [src: Monad Sealed-Bid Auction Engine.md]; screens 1–4 are now built as the "Even" web app in `web/` (static HTML/CSS/ES modules), styled by the Two-Player Cabinet design system in [DESIGN.md](DESIGN.md). Each screen names its source file instead of pasting markup, so the doc cannot drift from the code.

## Screen 1 — Creator: open a launch

- Preset picker: Degen / Raise [src: Monad Sealed-Bid Auction Engine.md].
- Inputs: token, supply to lock, commit window, reveal window, minimum bid size, uniform deposit, auto-LP toggle (Raise: allowlist upload, vesting schedule).
- Primary action: "Lock supply and open round".
- Copy guidance: lead with the community line, not the mechanism [src: Monad Sealed-Bid Auction Engine.md].

```html
<!-- Built: web/js/screens/creator.js, route #/host ("Host a launch": Degen/Raise cartridges, pool split, allowlist, vesting). -->
```

## Screen 2 — Bidder: round page

- Header: token, phase (Commit / Reveal / Clearing / Settled), countdown to next phase.
- Live stats allowed to show: number of commitments and their timing — this is an intentional leak [src: Monad Sealed-Bid Auction Engine.md]. Never show revealed prices before clearing.
- Commit panel: **max price per token** (snaps to the round's tick size) and **token amount** (decision 22). Show the max spend, `ceil(price × amount / 1e18)`, which must stay below the deposit; the minimum bid applies to the amount at the **reserve** price, `ceil(reservePrice × amount / 1e18) ≥ minBidSize`, matching the contract. Explain: *"You pay the clearing price for every token you win and get the difference back. If many bids land exactly on the clearing price, they share what is left in proportion to size."* The UI generates the salt, encrypts the bid into the on-chain `note`, and also keeps it in localStorage with a backup-file download; recovery from another device needs only the wallet (decision 33).
- Deposit line: "Everyone locks the same X — this is what keeps your bid private" (explains the uniform deposit).
- After commit: "Come back in the reveal window or you lose your deposit."

```html
<!-- Built: web/js/screens/round.js, route #/round/<id> (phase lamps, clock, "Insert coin" commit panel, coin rack of commitments). -->
```

## Screen 3 — Bidder: reveal and claim

- Reveal panel: pre-filled from stored salt; one button.
- Post-clear: clearing price, your fill, your refund, deposit released; fee total for commit + reveal + claim to prove < $0.01 [src: Monad Sealed-Bid Auction Engine.md].
- Post-clear transparency is intentional: revealed bids may be listed after settlement [src: Monad Sealed-Bid Auction Engine.md].

```html
<!-- Built: web/js/screens/round.js ("Continue?" reveal, "Results" with the called price, "Anyone can press" public actions, "You won"/"Refund" claim, bids board). -->
```

## Screen 4 — Demo: sniper head-to-head

- Two panes, same token, same bot [src: Monad Sealed-Bid Auction Engine.md].
- Left (bonding curve): block-by-block fills; bot's entries highlighted taking the first blocks.
- Right (auction): commitment count ticking, then one clearing price; bot's allocation shown at the same price as everyone else.
- Target length: twenty seconds, no narration [src: Monad Sealed-Bid Auction Engine.md].

```html
<!-- Built: web/js/screens/home.js, route #/ (two-player cabinet: bonding curve vs Even, replayed from demo/results.json via web/js/data/demo-results.js). -->
```

## Screen 5 — Demo: bank run not happening (Exit-Priority)

- Two panes, one vault [src: Monad Sealed-Bid Auction Engine.md].
- Left (FIFO): queue length, peg deviation, liquidation cascade, "latecomers: 0".
- Right (auction): rounds clearing at a widening discount, orderly exits, "accrued to stayers" counter rising.

```html
<!-- Built outside the web app: demo/exit/index.html replays demo/exit/results.json from demo/exit/run.sh. -->
```

## Screen 6 — Exit-Priority holder page (conditional)

- Current round: exit capacity, countdown, commitment count.
- Commit: "discount I will accept" + shares to exit. Reveal moves the shares into escrow; unfilled shares come back at claim (decision 31).
- Reveal / claim as Screens 2–3.

```html
<!-- Not built: no holder page yet; the exit round is shown only by the demo page above (decisions 31, 34). -->
```

## Wording rules for all screens [src: Monad Sealed-Bid Auction Engine.md]

| Do not say | Say instead |
| --- | --- |
| No sniping | Snipe-resistant: submission timing no longer determines price |
| Privacy via encrypted mempool | Privacy via commit-reveal; Monad's local mempool narrows the observer set |
| Losing bids never revealed | Post-clear transparency is intentional; losers who never reveal stay private |

Related files: [04-flows.md](04-flows.md) · [07-tech-stack.md](07-tech-stack.md) · [11-roadmap.md](11-roadmap.md) · [12-open-questions.md](12-open-questions.md)
