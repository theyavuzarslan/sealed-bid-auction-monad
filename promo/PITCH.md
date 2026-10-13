# Pitch video and demo video: script and shot list

Two videos the Metropolis form needs: a **pitch** (2 minutes at most) and a **demo** (3 minutes at most). The pitch opens with the 30-second film (`promo/even-film-30s.mp4`). The demo is cut from one recording of the showcase round (`SHOWCASE=1 contracts/script/live-round.sh`).

Wording rules for both: say "snipe-resistant: submission timing no longer determines price", never "no sniping", "MEV-proof" or "bot-proof". Privacy comes from commit-reveal, not an encrypted mempool. The showcase bidders are our own burner wallets: call it a scripted round.

## Pitch (2:00)

| Time | Picture | Voice (about 220 words in all) |
| --- | --- | --- |
| 0:00–0:30 | The film, `promo/even-film-30s.mp4`, with its own score | None |
| 0:30–0:48 | Site, "How it plays", then the replay's results table (`SUBMISSION.md`, the head-to-head) | "On a bonding curve, arrival order sets the price. We replayed the same launch both ways: on the curve the bot paid half what the crowd paid, and eight of twelve players got nothing. On Even, the bot paid what everyone paid, and one player got nothing, because they bid below the price and were refunded." |
| 0:48–1:15 | Round page: sealed counter, then reveal, then the staircase with the one-price line | "Even is a sealed-bid launch. You bid a price and an amount as a hash, and everyone locks the same deposit, so the deposit says nothing about the bid. When bidding closes, bids are revealed and stacked from the top price down until they cover the supply. That price is the price for everyone. The pool opens at it, with its liquidity locked." |
| 1:15–1:35 | MonadScan: the v2 engine, the round's seed-and-lock transaction; then `SECURITY.md` | "It is live on Monad mainnet. Our test rounds cleared, seeded the pool and swept back to zero. The money path is hand-written and covered by 154 tests, invariant runs, mutation testing and two independent AI reviews. There is no external audit yet." |
| 1:35–1:50 | The exit demo page, institutional vault tab | "The same engine prices vault exits: when a vault's cash is short, holders bid a sealed discount to leave, and everyone pays one discount instead of racing a queue." |
| 1:50–2:00 | End card from the film | "Even. Fair launches on Monad." |

Keep the vault line to what is true: the exit auction runs on a local chain and a mainnet fork; it is not deployed on mainnet.

## Demo (3:00), recorded from the showcase round

Start the screen recording before you run the script. The round takes about 35 minutes; the demo uses a few minutes of it, so cut freely. Times are from when you press Enter.

| Run time | What happens | Capture | Demo time |
| --- | --- | --- | --- |
| Before | — | Home page, scroll the hero once | 0:00–0:12 |
| 0–2 min | The script makes 8 burner wallets, funds them, creates EVSHOW, opens round 2 and prints the link | Terminal, sped up 8×; then open `even-monad.vercel.app/web/#/round/2` | 0:12–0:25 |
| 2–4 min | The 8 commits land; the counter climbs to 8 and the demand meter fills | The round page, real time. Hover the "Coins in" card | 0:25–0:55 |
| any time in the bidding window | Your own bid, if you make one: Passkey → create → fund it with 0.35 MON → spend → "Place sealed bid" | The whole flow, then the commit on MonadScan: the input is only a hash | 0:55–1:35 |
| 23 min | Bidding closes; the script reveals all 8 | The reveal panel ("Bidding is closed…"), the revealed counter reaching 8. **If you bid with a passkey, press "Reveal bid" now, or your deposit is burned** | 1:35–2:00 |
| 33 min | Settle: one price; then seed and lock; then claims | The results staircase with the one-price line, the pro-rata bidder and the refunded one | 2:00–2:35 |
| 34 min | Seed-and-lock transaction | MonadScan: the transaction and the GoPlus lock | 2:35–2:50 |
| 35 min | Sweep; the script prints the summary | The round page in "Collect", then the end card | 2:50–3:00 |

Voice for the demo is optional; captions naming each phase (Seal · Reveal · One price · Pool locked) are enough.

## Before you start

- **MON:** the showcase needs 3.2 MON up front. You have about 2.8, so add **1 MON**, or **1.5 MON** if you will bid with a passkey (that account needs about 0.35). Expect a net cost of about 1.4 MON.
- **Command:**
  ```bash
  cd "/Users/0xatakan/Claude Code/Sealed Bid Auction on Monad/contracts" && SHOWCASE=1 ./script/live-round.sh
  ```
- **If it stops:** run the same command with the state folder it printed, `./script/live-round.sh live-round/<folder>` (plus `SHOWCASE=1`), and it picks up where it stopped.

## Schedule back from the deadline (14 Oct, 06:59 GMT+3)

| By | Step |
| --- | --- |
| 13 Oct, evening | Top up, run and record the showcase round (about an hour with setup) |
| 13 Oct, night | Cut the demo; record the pitch voice and lay it over the film and screens |
| 14 Oct, 04:00 | Both uploaded (YouTube, unlisted is fine) and the links in the form, with time to spare |
