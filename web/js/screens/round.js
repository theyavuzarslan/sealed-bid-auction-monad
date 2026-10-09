// Screens 2 & 3 — bidder round page. Rendering and event wiring only; the logic lives in
// round-model.js (state, phases, actions, bid form), recovery.js (seal / recover / backup),
// merkle.js (allowlist), engine.js (calls) and store.js (localStorage).
// Rules: the commitment COUNT and timing are public by design; revealed prices only after settlement.
import cfg from "../../config.js";
import { engine as getEngine, engineVersion, network, chainNow, syncClock } from "../net.js";
import { sendTx, signTypedData, feeOf } from "../wallet.js";
import { ZERO32 } from "../engine.js";
import { formatUnits, wireToPerToken, bidProblems } from "../bid.js";
import { backupTypedData } from "../note.js";
import { fetchAllowlist, proofForRound, resolveUri } from "../merkle.js";
import {
  sealBid, recoverBidFromNote, checkBidAgainstCommitment, backupJson, backupFilename, parseBackup, NONDETERMINISTIC,
} from "../recovery.js";
import { saveBid, loadBid, updateBid, signatureDeterminism, setSignatureDeterminism, addFee, loadFees } from "../store.js";
import {
  loadRoundMeta, loadRoundState, phaseOf, PHASE, publicActions, bidderActions, parseBidInput, abandonAt, unrevealedDue,
} from "../round-model.js";
import { downloadText } from "../ui/dom.js";
import { notLiveHtml } from "../ui/notlive.js";
import { simpleBid, PRICE_MULTIPLES } from "../simple.js";
import { depositCover, coverGauge, demandCopy } from "../demand.js";
import { staircase } from "../ui/pixel.js";
import { buildRevealIcs, revealIcsFilename } from "../ui/reminder.js";
import { drawShareCard, canvasToPng, shareText, xIntentUrl } from "../ui/sharecard.js";
import { esc, short, fmtCountdown, fmtMon, fmtMonUsd, fmtTokens, fmtTime, fmtPct, plural } from "../format.js";

export function renderRound(el, app, roundIdRaw) {
  const roundId = BigInt(roundIdRaw);
  const eng = getEngine();
  const net = network();
  if (!eng) {
    el.innerHTML = notLiveHtml(net, "Rounds");
    return { cleanup() {}, onAccount() {} };
  }

  let s = null; // round state snapshot
  let meta = null;
  let allow = { status: "none" };
  let prepared = null; // sealed bid not yet committed
  let bidMode = "simple"; // "simple": spend + highest price; "advanced": exact price and amount
  let supplyTotal = null; // token totalSupply, for market-cap figures
  let busy = false;
  let dead = false;
  let notify = { status: "idle" }; // reveal reminder: idle | scheduled | unsupported | denied | dismissed | shown
  let notifyTimer = null;
  let share = null; // { key, status: drawing | ready | error, url, blob, error }
  const me = () => app.account;
  const roundUrl = () => `${location.origin}${location.pathname}#/${engineVersion() ? engineVersion() + "/" : ""}round/${roundId}`;
  const ctx = () => ({ chainId: net.chainId, engine: eng.address, roundId, bidder: me() });

  el.innerHTML = `
  <section class="page">
    <div id="p-head"></div>
    <div class="grid-app">
      <div class="col">
        <div id="p-commit"></div>
        <div id="p-reveal"></div>
        <div id="p-called"></div>
        <div id="p-public"></div>
        <div id="p-result"></div>
        <div id="p-bids"></div>
      </div>
      <div class="col">
        <div id="p-status"></div>
      </div>
    </div>
  </section>
  <div class="status-bar"><p class="msg" id="msg" role="status" aria-live="polite"></p></div>`;
  const $ = (sel) => el.querySelector(sel);
  const cache = new Map();
  const patch = (id, html) => {
    if (cache.get(id) === html) return;
    cache.set(id, html);
    $(id).innerHTML = html;
    if (id === "#p-commit") ["#allow-box", "#bid-derived", "#bid-prepared"].forEach((c) => cache.delete(c));
  };
  const say = (text, kind = "") => { const m = $("#msg"); m.className = `msg ${kind}`; m.textContent = text; };

  const dec = () => meta?.decimals ?? 18;
  const sym = () => meta?.symbol ?? "tokens";
  const perToken = (wire) => `${formatUnits(wireToPerToken(wire, dec()), 18, 18)} MON`;
  const tokens = (units) => fmtTokens(units, dec(), sym());
  // Rounded UP to what is displayed, so a lower bound shown to the user is never too low.
  const tokensUp = (units) => { const q = 10n ** BigInt(Math.max(dec() - 4, 0)); return tokens(((units + q - 1n) / q) * q); };
  const phase = () => phaseOf(s, chainNow()).phase;
  const recoveryOff = () => me() && signatureDeterminism(me()) === NONDETERMINISTIC;
  const sealedCopy = () => `Your bid is sealed. Reveal it in the reveal window or your deposit is burned.${recoveryOff() ? "" : " You can reveal from any device with this wallet."}`;
  const btn = (a, kind = "") => `<button class="btn ${kind}" type="button" data-act="${a.id}">${esc(a.label)}</button>`;
  const panel = (tone, title, body, sub = "") =>
    `<section class="panel ${tone}"><div class="panel-in"><h2 class="panel-title">${title}${sub ? ` <small>${esc(sub)}</small>` : ""}</h2>${body}</div></section>`;

  // ── panels ──
  // The four arcade stages (DESIGN.md "Phase lamps"): insert coin, continue?, results, collect.
  const STAGES = [
    { key: "commit", label: "Insert coin", sub: "commit", phases: [PHASE.Commit] },
    { key: "reveal", label: "Continue?", sub: "reveal", phases: [PHASE.Reveal] },
    { key: "results", label: "Results", sub: "settle", phases: [PHASE.Clearing, PHASE.Settled] },
    { key: "collect", label: "Collect", sub: "claim", phases: [PHASE.ClaimsOpen] },
  ];
  function lampsHtml(ph) {
    const cur = STAGES.findIndex((st) => st.phases.includes(ph));
    return `<ol class="lamps" aria-label="Round stage">${STAGES.map((st, i) =>
      `<li class="lamp" data-state="${i < cur ? "past" : i === cur ? "lit" : "dark"}" ${i === cur ? 'aria-current="step"' : ""}>${esc(st.label)}<b>${esc(st.sub)}</b></li>`).join("")}</ol>`;
  }

  function headHtml() {
    const { round } = s;
    const ph = phaseOf(s, chainNow());
    const now = chainNow();
    const clockLabel = ph.phase === PHASE.Commit ? "Reveal opens in" : ph.phase === PHASE.Reveal ? "Continue? Reveal closes in" : "";
    const urgent = ph.phase === PHASE.Reveal && ph.nextAt - now < 300;
    return `
      <div class="round-marquee">
        <div>
          <div class="chips">
            <span class="chip chip-purple">${round.preset === 0n ? "Degen" : "Raise"}</span>
            <span class="chip">Round ${roundId}</span>
          </div>
          <h1>${esc(sym())} <span>launch</span></h1>
        </div>
        <div class="clock">
          ${ph.nextAt ? `<div class="clock-label">${esc(clockLabel)}</div>
            <div class="clock-digits num${urgent ? " urgent" : ""}" id="countdown">${fmtCountdown(ph.nextAt - now)}</div>
            <div class="clock-when">${esc(ph.next)} at ${esc(fmtTime(ph.nextAt))}</div>`
            : `<div class="clock-label">Clock</div><div class="clock-digits">${ph.phase === PHASE.ClaimsOpen ? "Collect" : "Results"}</div>`}
        </div>
      </div>
      ${lampsHtml(ph.phase)}`;
  }

  function statusHtml() {
    const { round, ledger } = s;
    const now = chainNow();
    const unrevealed = ledger.commits - ledger.reveals;
    const shown = Math.min(Number(ledger.commits), 120);
    const coins = Array.from({ length: shown }, (_, i) =>
      `<span class="coin${i < Number(ledger.reveals) ? " revealed" : ""}"></span>`).join("");
    const lp = round.lpShareBps === 0n ? "No pool"
      : `${fmtPct(round.lpShareBps)} of tokens sold and MON raised; ${round.preset === 0n ? "locked permanently" : `locked ${Number(round.lockDuration) / 86400} days from seeding`}`;
    return panel("", "Coins in", `
      <div class="coin-count">
        <div><strong class="num">${ledger.commits}</strong><span>${plural(ledger.commits, "sealed bid")}</span></div>
        ${now >= Number(round.commitEnd) ? `<div><strong class="num">${ledger.reveals}</strong><span>revealed</span></div>` : ""}
        ${now >= Number(round.revealEnd) && unrevealed > 0n ? `<div><strong class="num">${unrevealed}</strong><span>not revealed</span></div>` : ""}
      </div>
      <div class="coin-rack" aria-hidden="true">${coins}</div>
      <p class="note">How many bids and when they arrived are public by design. Prices stay sealed until each bidder reveals.</p>
      ${meterHtml()}
      <dl class="readout">
        <dt>For sale</dt><dd>${esc(tokens(round.sellAmount))}</dd>
        <dt>Deposit</dt><dd>${esc(fmtMon(round.depositAmount))} each, also the biggest bid per wallet</dd>
        <dt>Reserve</dt><dd>${esc(perToken(round.reservePrice))} / token</dd>
        <dt>Tick</dt><dd>${esc(perToken(round.tickSize))}</dd>
        <dt>Min bid</dt><dd>${esc(fmtMon(round.minBidSize))} at the reserve</dd>
        <dt>Pool</dt><dd>${esc(lp)}</dd>
        ${round.allowlistRoot !== ZERO32 ? `<dt>Allowlist</dt><dd>Yes${meta.allowlistURI ? ` · <a href="${esc(resolveUri(meta.allowlistURI, cfg.ipfsGateway))}" target="_blank" rel="noopener">tree</a>` : ""}</dd>` : ""}
        ${round.vestDuration !== 0n ? `<dt>Vesting</dt><dd>${fmtPct(round.tgeBps)} at claim, the rest over ${Number(round.vestDuration) / 86400} days after a ${Number(round.cliff) / 86400}-day cliff</dd>` : ""}
        <dt>Commit ends</dt><dd>${esc(fmtTime(round.commitEnd))}</dd>
        <dt>Reveal ends</dt><dd>${esc(fmtTime(round.revealEnd))}</dd>
        <dt>Token</dt><dd class="mono">${esc(round.token)}</dd>
      </dl>`);
  }

  // Demand meter (demand.js): only the public commit count × the uniform deposit, against the whole
  // sale at the floor price. Shown while bids are sealed; after the reveal window the real book takes over.
  function meterHtml() {
    const ph = phase();
    if (ph !== PHASE.Commit && ph !== PHASE.Reveal) return "";
    const { round, ledger } = s;
    const c = depositCover({ commits: ledger.commits, depositAmount: round.depositAmount, sellAmount: round.sellAmount, reservePrice: round.reservePrice });
    const copy = demandCopy(c);
    // A non-zero deposit always lights at least one cell, even when the cover rounds down to 0 bps.
    const g = coverGauge(c.kind === "none" || c.kind === "unknown" ? 0n : (c.coverBps > 0n ? c.coverBps : 1n));
    const cells = Array.from({ length: 20 }, (_, i) => `<i${i < g.lit ? ' class="on"' : ""}></i>`).join("");
    const scale = g.scale === 1
      ? `<span class="end">whole sale</span>`
      : `<span class="at" style="left:${g.markPct}%">whole sale</span><span class="end">${g.scale}×</span>`;
    return `<figure class="demand">
        <figcaption class="demand-title">Demand meter</figcaption>
        <div class="meter" aria-hidden="true">${cells}<b class="meter-mark" style="left:${g.markPct}%"></b></div>
        <div class="meter-scale" aria-hidden="true"><span>0</span>${scale}</div>
        <p class="demand-line">${esc(copy.before)}${copy.figure ? `<strong>${esc(copy.figure)}</strong>` : ""}${esc(copy.after)}</p>
        ${c.kind === "unknown" ? "" : `<dl class="demand-nums"><dt>Deposits locked</dt><dd>${esc(fmtMon(c.locked))}</dd><dt>Whole sale at the floor</dt><dd>${esc(fmtMon(c.floorValue))}</dd></dl>`}
        <p class="demand-foot">${esc(copy.foot)}</p>
      </figure>`;
  }

  // Next to the bid form in both modes: a sealed uniform-price bid is safest at the bidder's true max.
  const realMaxHtml = (word) => `<p class="field-hint real-max"><strong>Bid your real max.</strong> It's a ceiling, not what you pay: you pay the ${word} price everyone pays and anything above it comes back, so the safe choice is the most you'd really pay per token.</p>`;

  function commitShell() {
    if (phase() !== PHASE.Commit) return "";
    if (!me()) return panel("panel-p1", "Insert coin", `<p>Connect a wallet to place a sealed bid.</p>`, "commit");
    if (s.me.committed) {
      return panel("panel-p1", "Coin in", `
        <div class="ticket"><p class="ticket-line">Sealed</p><p>${esc(sealedCopy())}</p>
          <p class="note">Come back when the reveal window opens (${esc(fmtTime(s.round.commitEnd))}), or your deposit is burned.</p></div>
        ${reminderHtml()}`, "committed");
    }
    return panel("panel-p1", "Insert coin", `
      <p>Everyone locks the same ${esc(fmtMon(s.round.depositAmount))}, so your deposit gives nothing away. Your price and amount are sealed as a hash.</p>
      <p class="note cap-note">That deposit is also the most one wallet can bid. It spreads the tokens across more people, and splitting a bid across wallets gets no better price, since every winner pays the same one.</p>
      <div id="allow-box"></div>
      <form id="bid-form" autocomplete="off">${bidMode === "simple" ? `
        <p class="field-hint">Floor price ${esc(perToken(s.round.reservePrice))} per token${mcap(s.round.reservePrice)}. Nobody pays less, and everyone who wins pays the same final price.</p>
        <div class="fields">
          <label>Spend up to (MON)<input id="f-spend" inputmode="decimal" placeholder="e.g. ${esc(formatUnits(s.round.depositAmount / 2n, 18, 4))}"></label>
        </div>
        <div class="seg seg-sm" aria-label="Quick amounts">
          <button type="button" data-spend="4">¼ max</button><button type="button" data-spend="2">½ max</button><button type="button" data-spend="1">Max</button>
        </div>
        <p class="label-row">Highest price you'd pay</p>
        ${realMaxHtml("final")}
        <div class="seg" role="radiogroup" aria-label="Highest price">
          ${PRICE_MULTIPLES.map((m) => `<button type="button" role="radio" data-mul="${m}" aria-checked="${m === 2}">${m === 1 ? "Floor" : `${m}× floor`}</button>`).join("")}
          <button type="button" role="radio" data-mul="custom" aria-checked="false">Custom</button>
        </div>
        <label class="hidden" id="f-custom-wrap" style="margin-top:12px">Highest price per token (MON)<input id="f-custom" inputmode="decimal"></label>`
        : `
        <div class="fields">
          <label>Max price per token (MON)<input id="f-price" inputmode="decimal" placeholder="${esc(formatUnits(wireToPerToken(s.round.reservePrice, dec()), 18))}"></label>
          <label>Amount (${esc(sym())})<input id="f-amount" inputmode="decimal"></label>
        </div>
        ${realMaxHtml("clearing")}`}
        <p style="margin-top:12px"><button type="button" class="linklike" data-act="bid-mode">${bidMode === "simple" ? "Advanced: exact price and amount" : "Simple: spend and highest price"}</button></p>
      </form>
      <div id="bid-derived"></div>
      ${bidMode === "simple" ? "" : `<p class="note">If many bids land exactly on the clearing price, they share what is left in proportion to size.</p>`}
      <div id="bid-prepared"></div>`, "commit");
  }

  // Reveal reminders: a forgotten reveal burns the whole deposit.
  function reminderHtml() {
    const NOTE = {
      scheduled: ["ok", "A browser notification is set for when the reveal window opens. It only fires while this page stays open, so add the calendar file too."],
      shown: ["ok", "The reveal window is open."],
      unsupported: ["warn", "This browser cannot show notifications. Add the reveal window to your calendar instead."],
      denied: ["warn", "Notifications are blocked for this site. Add the reveal window to your calendar instead."],
      dismissed: ["warn", "Notifications were not allowed. Add the reveal window to your calendar instead."],
    }[notify.status];
    return `<div class="reminders">
        <p class="note">Set a reminder for the reveal window:</p>
        <div class="btn-row">
          <button class="btn btn-panel" type="button" data-act="calendar">Add to calendar</button>
          <button class="btn btn-panel" type="button" data-act="notify">${notify.status === "scheduled" ? "Notification set" : "Notify me"}</button>
          ${loadBid(ctx()) ? `<button class="btn btn-panel" type="button" data-act="backup">Download backup file</button>` : ""}
        </div>
        ${NOTE ? `<p class="${NOTE[0]} reminder-note">${esc(NOTE[1])}</p>` : ""}
      </div>`;
  }

  function downloadCalendar() {
    const ics = buildRevealIcs({
      roundId, symbol: sym(), bidder: me(), chainId: net.chainId, engine: eng.address,
      commitEnd: s.round.commitEnd, revealEnd: s.round.revealEnd, url: roundUrl(),
    });
    downloadText(revealIcsFilename(sym(), roundId), ics, "text/calendar;charset=utf-8");
    say("Calendar file downloaded. Open it to add the reveal window to your calendar.", "ok");
  }

  function clearNotify() {
    if (notifyTimer) clearTimeout(notifyTimer);
    notifyTimer = null;
  }

  // Waits on chain time: each wake-up re-reads chainNow(), so clock syncs and long waits (setTimeout
  // caps near 24.8 days) cannot fire it early.
  function scheduleNotify() {
    clearNotify();
    const at = Number(s.round.commitEnd);
    const wake = () => {
      if (dead) return;
      const left = at - chainNow();
      if (left > 0) { notifyTimer = setTimeout(wake, Math.min(left * 1000, 2 ** 31 - 1)); return; }
      notifyTimer = null;
      try {
        const n = new Notification(`Reveal your ${sym()} bid`, {
          body: `Round ${roundId}: the reveal window is open until ${fmtTime(s.round.revealEnd)}. Reveal before it closes or the deposit is burned.`,
          tag: `even-reveal-${net.chainId}-${roundId}`,
        });
        n.onclick = () => { window.focus(); n.close(); };
      } catch { /* e.g. mobile browsers that only notify from a service worker: the page itself still updates */ }
      notify = { status: "shown" };
      render();
    };
    wake();
  }

  async function enableNotify() {
    if (!("Notification" in globalThis)) notify = { status: "unsupported" };
    else if (Notification.permission === "denied") notify = { status: "denied" };
    else {
      // Older Safari takes a callback and returns nothing; newer browsers return a promise.
      const p = Notification.permission === "granted" ? "granted"
        : await new Promise((ok) => { const r = Notification.requestPermission(ok); if (r?.then) r.then(ok); });
      if (p === "granted") { notify = { status: "scheduled" }; scheduleNotify(); }
      else notify = { status: p === "denied" ? "denied" : "dismissed" };
    }
    render();
  }

  function readForm() {
    const f = bidMode === "simple" ? readSimple() : parseBidInput({ priceText: $("#f-price")?.value, amountText: $("#f-amount")?.value }, s.round, dec());
    if (f.problems) {
      if (allow.status === "missing") f.problems.push({ code: "NOT_ALLOWLISTED", message: "This wallet is not on the allowlist." });
      if (allow.status === "error" || allow.status === "loading") f.problems.push({ code: "NO_PROOF", message: "Allowlist proof not available yet." });
    }
    return f;
  }

  // Spend + highest price → the exact (price, amount) the seal path takes.
  function readSimple() {
    const sel = el.querySelector('[data-mul][aria-checked="true"]')?.dataset.mul ?? "2";
    const b = simpleBid({
      round: s.round, spendMon: $("#f-spend")?.value,
      priceMultiple: sel === "custom" ? null : Number(sel),
      customPerToken: sel === "custom" ? ($("#f-custom")?.value || "0") : null,
    }, dec());
    if (b.empty || b.error) return { ...b, minAmount: 0n, simple: true };
    return { ...b, simple: true, snapped: false, minAmount: 0n, maxAmount: null };
  }

  const mcap = (wire) => {
    if (supplyTotal == null) return "";
    const v = (BigInt(wire) * supplyTotal) / 10n ** 18n;
    return ` (a ${fmtMon(v, 0)} market cap)`;
  };

  function simpleOutcomeHtml(f) {
    if (f.empty) return `<p class="field-hint">Enter how much MON you're willing to spend. The most is just under the ${esc(fmtMon(s.round.depositAmount))} everyone locks.</p>`;
    if (f.error) return `<ul class="problems"><li>${esc(f.error)}</li></ul>`;
    const words = (p) => p.code === "BELOW_MIN_BID" ? "That's below this round's minimum bid; spend a bit more." : p.message;
    return `
      <div class="bid-outcome">
        <p>You get <strong>${esc(tokens(f.amount))}</strong> if the final price ends at or below <strong>${esc(perToken(f.price))}</strong>${esc(mcap(f.price))}.</p>
        <p>You pay the final price for each token: at most <strong>${esc(fmtMon(f.spend, 6))}</strong>. The rest of your ${esc(fmtMon(s.round.depositAmount))} deposit comes back. If the price ends above your max, all of it comes back.</p>
        <p class="note" style="color:var(--purple-glow)">If many bids land exactly on the final price, they share what's left in proportion to size.</p>
        ${f.capped ? `<p class="note" style="color:var(--purple-glow)">Capped just under the ${esc(fmtMon(s.round.depositAmount))} deposit.</p>` : ""}
        ${f.wholeSale ? `<p class="note" style="color:var(--purple-glow)">That's the whole sale; you can't win more.</p>` : ""}
      </div>
      ${f.problems.length ? `<ul class="problems">${f.problems.map((p) => `<li>${esc(words(p))}</li>`).join("")}</ul>`
        : `<div class="btn-row"><button class="btn btn-coin btn-lg" type="button" data-act="place">Place sealed bid · lock ${esc(fmtMon(s.round.depositAmount))}</button></div>`}`;
  }

  function derivedHtml(f) {
    if (f.simple) return simpleOutcomeHtml(f);
    const minLine = `<p class="field-hint">Smallest amount: ${esc(tokensUp(f.minAmount ?? 0n))} (the minimum bid at the reserve price).</p>`;
    if (f.empty) return `${minLine}`;
    if (f.error) return `<ul class="problems"><li>${esc(f.error)}</li></ul>`;
    const detail = (p) => {
      if (p.code === "BELOW_MIN_BID") return `${p.message} Smallest amount: ${tokensUp(f.minAmount)}.`;
      if (p.code === "AT_OR_ABOVE_DEPOSIT") return `${p.message} At this price the largest amount is ${tokens(f.maxAmount)}.`;
      if (p.code === "BELOW_RESERVE") return `${p.message} Reserve: ${perToken(s.round.reservePrice)}.`;
      return p.message;
    };
    return `
      ${f.snapped ? `<p class="field-hint">Snapped down to the tick grid: ${esc(perToken(f.price))} per token.</p>` : ""}
      <dl class="readout">
        <dt>Max spend</dt><dd><strong>${esc(fmtMon(f.spend, 18))}</strong></dd>
        <dt>Deposit locked</dt><dd>${esc(fmtMon(s.round.depositAmount))}</dd>
      </dl>
      ${f.problems.length ? `<ul class="problems">${f.problems.map((p) => `<li>${esc(detail(p))}</li>`).join("")}</ul>`
        : `<div class="btn-row"><button class="btn btn-start" type="button" data-act="seal">Seal bid</button></div>`}`;
  }

  function preparedHtml() {
    if (!prepared) return "";
    const needBackup = prepared.determinism === NONDETERMINISTIC && !prepared.backupSaved;
    return `<div class="ticket">
      <p class="ticket-line">Sealed · <span class="num">${esc(perToken(prepared.price))} × ${esc(tokens(prepared.amount))}</span></p>
      ${prepared.determinism === NONDETERMINISTIC
        ? `<p>This wallet's signatures are not deterministic, so on-chain recovery is off for it. Download the backup file before you insert your coin; it is the only way to reveal from another browser.</p>`
        : `<p class="note">An encrypted copy goes on-chain with your bid. This wallet can decrypt it from any device.</p>`}
      <div class="btn-row">
        <button class="btn" type="button" data-act="backup-prepared">Download backup file</button>
        <button class="btn btn-coin" type="button" data-act="commit" ${needBackup ? "disabled" : ""}>Insert coin · lock ${esc(fmtMon(s.round.depositAmount))}</button>
      </div>
    </div>`;
  }

  function allowHtml() {
    if (s.round.allowlistRoot === ZERO32) return "";
    if (allow.status === "loading" || allow.status === "none") return `<p class="field-hint">Loading the allowlist…</p>`;
    if (allow.status === "ok") return `<p class="ok">This wallet is on the allowlist.</p>`;
    if (allow.status === "missing") return `<ul class="problems"><li>This wallet is not on the allowlist for this round.</li></ul>`;
    return `<p class="warn">Could not load the allowlist: ${esc(allow.error)}. Load the tree file yourself:</p>
      <input type="file" id="allow-file" accept="application/json">`;
  }

  function revealHtml() {
    const ph = phase();
    if (ph === PHASE.Reveal && (!me() || !s.me.committed)) {
      return panel("panel-p2", "Continue?", `<p>Bidding is closed. Bidders are revealing their sealed bids now; nobody can add or change one.</p>
        <p class="note" style="margin-top:14px">One price is called for everyone when the reveal window closes, ${esc(fmtTime(s.round.revealEnd))}.</p>`, "reveal window");
    }
    if (!me() || !s.me.committed || ph === PHASE.Commit) return "";
    if (s.me.revealed) {
      return ph === PHASE.Reveal ? panel("panel-p2", "Continued", `<p class="ok">Your bid is in the book. Results come when the reveal window closes.</p>`, "revealed") : "";
    }
    if (ph !== PHASE.Reveal) return panel("panel-p1", "Game over", `<p class="err">This wallet's bid was not revealed in time. Its deposit is burned.</p>`, "not revealed");
    const L = loadBid(ctx());
    const localOk = L && L.hash?.toLowerCase() === s.me.commitment.hash.toLowerCase();
    return panel("panel-p2", "Continue?", `
      ${localOk ? `<div class="ticket"><p class="ticket-line">Your bid · <span class="num">${esc(perToken(L.price))} × ${esc(tokens(L.amount))}</span></p><p class="note">Saved in this browser.</p></div>
          <div class="btn-row" style="margin-top:16px"><button class="btn btn-start btn-lg" type="button" data-act="reveal">Reveal bid</button></div>`
        : `<p>${L ? "The bid saved in this browser does not match your commitment." : "No bid saved in this browser."}
            ${recoveryOff() ? "Load your backup file." : "Recover it with your wallet, or load your backup file."}</p>
          <div class="btn-row">
            ${recoveryOff() ? "" : `<button class="btn btn-start" type="button" data-act="recover">Recover with wallet</button>`}
            <label class="btn file">Load backup file<input type="file" id="backup-file" accept="application/json"></label>
          </div>`}
      <p class="note" style="margin-top:14px">Reveal closes ${esc(fmtTime(s.round.revealEnd))}. An unrevealed deposit is burned.</p>`, "reveal window");
  }

  // The result, called once for everyone (Monad's outlined numeral).
  function calledHtml() {
    const { round, clearing } = s;
    if (chainNow() < Number(round.revealEnd)) return "";
    if (!clearing.settled) {
      return panel("panel-p2", "Counting", `<p>The reveal window is closed. Anyone can settle the round; large books settle over several transactions (${cfg.settleStepsPerTx} price levels each, ${clearing.levelCount} in this book). Press Settle below.</p>`, "results");
    }
    const lp = round.lpAbandoned ? `abandoned: its ${fmtMon(round.lpMonBurned)} share was burned`
      : round.lpDone ? (round.lpMonSpent > 0n ? `seeded with ${tokens(round.lpTokensUsed)} + ${fmtMon(round.lpMonSpent)} and locked` : "none")
        : "not seeded yet";
    const P = perToken(clearing.clearingPrice);
    return panel("panel-p2", "Results", `
      ${stairHtml()}
      <div class="called" aria-label="Clearing price ${esc(P)} per token">
        <span class="called-price" aria-hidden="true">${esc(P.replace(" MON", ""))}</span>
        <span class="called-unit">MON per token<br><span class="called-readable">${esc(P)}</span></span>
      </div>
      <p>Every winning bid pays this price. ${clearing.oversubscribed ? "Bids exactly at it share what was left, pro-rata." : "Every revealed bid filled in full."}</p>
      <dl class="readout">
        <dt>Sold</dt><dd>${esc(tokens(clearing.sold))} of ${esc(tokens(round.sellAmount))}</dd>
        <dt>Refunds</dt><dd>Open now</dd>
        <dt>Pool</dt><dd>${esc(lp)}</dd>
        <dt>Tokens</dt><dd>${round.claimsOpen ? "Open" : "Open once the pool is seeded"}</dd>
      </dl>`, "called");
  }

  // The demand staircase (DESIGN.md signature component) drawn from the revealed book:
  // one step per price level, the supply line, and the step where they meet.
  function stairHtml() {
    if (!s.revealed?.length) return "";
    const px = (wire) => Number(formatUnits(wireToPerToken(wire, dec()), 18));
    const qn = (units) => Number(formatUnits(units, dec()));
    const byPrice = new Map();
    for (const r of s.revealed) byPrice.set(r.args.price, (byPrice.get(r.args.price) ?? 0n) + r.args.amount);
    const P = s.clearing.clearingPrice;
    const levels = [...byPrice.entries()].sort((a, b) => (b[0] > a[0] ? 1 : b[0] < a[0] ? -1 : 0))
      .map(([price, qty]) => ({ price: px(price), qty: qn(qty), bot: price < P }));
    const supply = qn(s.round.sellAmount);
    const total = levels.reduce((t, l) => t + l.qty, 0);
    const maxX = Math.max(total, supply) * 1.06;
    const maxY = levels[0].price * 1.12;
    const w = 460, h = 200, pad = 28;
    const st = staircase({ levels, supply, clearing: px(P), maxX, maxY, w, h, pad,
      colors: { step: "var(--monad-purple)", bot: "var(--screen-dim)" } });
    const x0 = st.X(0), y0 = st.Y(0);
    return `<figure class="stair-well">
      <svg class="chart" viewBox="0 0 ${w} ${h}" shape-rendering="crispEdges" role="img"
        aria-label="Demand staircase: ${levels.length} price levels, supply ${esc(tokens(s.round.sellAmount))}, clearing at ${esc(perToken(P))}">
        <line x1="${x0}" x2="${w - 8}" y1="${y0}" y2="${y0}" style="stroke:var(--screen-dim)" stroke-width="2"/>
        ${st.svg}
        <line x1="${st.supplyX}" x2="${st.supplyX}" y1="10" y2="${y0}" style="stroke:var(--marquee-white)" stroke-width="2" stroke-dasharray="4 4"/>
        <text x="${st.supplyX - 4}" y="20" text-anchor="end">supply</text>
        <line x1="${x0}" x2="${st.supplyX}" y1="${st.clearingY}" y2="${st.clearingY}" style="stroke:var(--win-lime)" stroke-width="3"/>
        <text x="${x0 + 4}" y="${st.clearingY - 6}" style="fill:var(--win-lime)">one price</text>
      </svg>
      <figcaption>Revealed bids, highest price first. Where the stairs cross the supply line is the price everyone pays; grey steps sit below it and are refunded.</figcaption>
    </figure>`;
  }

  function publicHtml() {
    const { round, clearing } = s;
    const now = chainNow();
    if (now < Number(round.revealEnd)) return "";
    const acts = publicActions(s, meta, now, { settleSteps: cfg.settleStepsPerTx });
    const notes = [];
    if (clearing.settled && !round.lpDone && now < abandonAt(s, meta)) notes.push(`If seeding keeps failing, anyone can abandon the pool from ${fmtTime(abandonAt(s, meta))}: its MON share is burned and token delivery opens.`);
    if (unrevealedDue(s) > 0n) notes.push("Deposits of bids nobody revealed are burned, not paid to anyone.");
    if (!acts.length && !notes.length) return "";
    return `<section class="panel panel-dark"><div class="panel-in">
      <h2 class="panel-title">Anyone can press</h2>
      ${acts.length ? `<div class="btn-row">${acts.map((a) => btn(a, a.id === "settle" || a.id === "seed" ? "btn-start" : "")).join("")}</div>` : ""}
      ${notes.map((t) => `<p class="note" style="margin-top:14px">${esc(t)}</p>`).join("")}
    </div></section>`;
  }

  function resultHtml() {
    const m = s.me;
    if (!me() || !s.clearing.settled || !m?.revealed) return "";
    const q = m.quote;
    const { round } = s;
    const acts = bidderActions(s, me());
    const status = [];
    if (m.refunded) status.push(`Refund of ${fmtMon(q.refund, 18)} claimed.`);
    if (q.allocated > 0n) {
      if (m.tokensClaimed) status.push("Tokens collected.");
      else if (!round.claimsOpen) status.push(`Your tokens arrive once the pool is seeded.${m.refunded ? "" : " Your refund is available now."}`);
    }
    const f = loadFees(ctx());
    return panel("panel-p2", q.allocated > 0n ? "You won" : "Refund", `
      <dl class="readout">
        <dt>Tokens won</dt><dd><strong>${esc(tokens(q.allocated))}</strong></dd>
        <dt>Paid</dt><dd>${esc(fmtMon(q.paid, 18))}</dd>
        <dt>Refund</dt><dd>${esc(fmtMon(q.refund, 18))}</dd>
        ${round.vestDuration !== 0n && q.allocated > 0n ? `<dt>At claim</dt><dd>${esc(tokens(q.allocated * round.tgeBps / 10000n))}, the rest vests</dd>` : ""}
        ${m.vest && m.tokensClaimed && q.allocated > 0n ? `<dt>Vested</dt><dd>${esc(tokens(m.vest[0]))}, released ${esc(tokens(m.vest[1]))}</dd>` : ""}
      </dl>
      ${status.map((t) => `<p>${esc(t)}</p>`).join("")}
      ${acts.length ? `<div class="btn-row">${acts.map((a) => btn(a, "btn-start")).join("")}</div>` : ""}
      ${f.total > 0n ? `<p class="note" style="margin-top:14px">Network fees for this round (commit + reveal + claim): ${esc(fmtMonUsd(f.total))}</p>` : ""}
      ${shareHtml()}`, "collect");
  }

  // Share card (ui/sharecard.js): the settled result as a 1200×630 image, and an X post the user sends.
  function shareData() {
    const q = s.me.quote;
    const P = s.clearing.clearingPrice;
    const px = (wire) => Number(formatUnits(wireToPerToken(wire, dec()), 18));
    const byPrice = new Map();
    for (const r of s.revealed ?? []) byPrice.set(r.args.price, (byPrice.get(r.args.price) ?? 0n) + r.args.amount);
    const levels = [...byPrice.entries()].sort((a, b) => (b[0] > a[0] ? 1 : b[0] < a[0] ? -1 : 0))
      .map(([price, qty]) => ({ price: px(price), qty: Number(formatUnits(qty, dec())) }));
    return {
      symbol: sym(), roundId: String(roundId), price: perToken(P), won: q.allocated > 0n,
      tokens: tokens(q.allocated), paid: fmtMon(q.paid, 18),
      stair: levels.length ? { levels, supply: Number(formatUnits(s.round.sellAmount, dec())), clearing: px(P) } : null,
    };
  }
  const shareKey = (d) => JSON.stringify([d.symbol, d.roundId, d.price, d.won, d.tokens, d.paid, d.stair?.levels.length]);

  function shareHtml() {
    if (!share || share.key !== shareKey(shareData())) {
      return `<div class="btn-row share-open"><button class="btn btn-panel" type="button" data-act="share">Share result</button></div>`;
    }
    if (share.status === "drawing") return `<div class="share"><p class="note">Drawing the share card…</p></div>`;
    if (share.status === "error") {
      return `<div class="share"><p class="err">Could not draw the share card: ${esc(share.error)}</p>
        <div class="btn-row"><button class="btn btn-panel" type="button" data-act="share">Try again</button></div></div>`;
    }
    const d = shareData();
    return `<div class="share" role="group" aria-label="Share result">
      <img class="share-preview" src="${esc(share.url)}" width="1200" height="630"
        alt="Share card: ${esc(d.symbol)} launch, round ${esc(d.roundId)}. Everyone paid ${esc(d.price)} per token. ${d.won ? `Won ${esc(d.tokens)} for ${esc(d.paid)}` : "Refunded in full"}.">
      <div class="btn-row">
        <button class="btn btn-start" type="button" data-act="share-download">Download image</button>
        <button class="btn btn-panel" type="button" data-act="share-x">Post on X</button>
      </div>
      <p class="note">X opens with the text and link filled in; you post it yourself. To add the image, download it first and attach it to the post.</p>
    </div>`;
  }

  function dropShare() {
    if (share?.url) URL.revokeObjectURL(share.url);
    share = null;
  }

  async function makeShare() {
    const d = shareData();
    dropShare();
    const mine = { key: shareKey(d), status: "drawing" };
    share = mine;
    render();
    try {
      const blob = await canvasToPng(await drawShareCard(document.createElement("canvas"), d));
      if (dead || share !== mine) return;
      share = { ...mine, status: "ready", blob, url: URL.createObjectURL(blob) };
    } catch (e) {
      if (dead || share !== mine) return;
      share = { ...mine, status: "error", error: e.message };
    }
    render();
    el.querySelector('[data-act="share-download"], #p-result [data-act="share"]')?.focus();
  }

  function shareFilename() {
    const safe = sym().replace(/[^A-Za-z0-9_-]/g, "").slice(0, 24) || "token";
    return `even-${safe}-round-${roundId}.png`;
  }

  function bidsHtml() {
    if (!s.clearing.settled || !s.revealed?.length) return "";
    const P = s.clearing.clearingPrice;
    const mine = me()?.toLowerCase();
    const rows = [...s.revealed].sort((a, b) => (b.args.price > a.args.price ? 1 : b.args.price < a.args.price ? -1 : 0)).map((r, i) => {
      const p = r.args.price;
      const fill = p > P ? "full" : p < P ? "none" : s.clearing.oversubscribed ? "pro-rata" : "full";
      return `<tr class="${r.args.bidder.toLowerCase() === mine ? "is-me" : ""}"><td class="rank">${i + 1}</td><td class="mono">${esc(short(r.args.bidder))}</td>
        <td class="right">${esc(perToken(p))}</td><td class="right">${esc(tokens(r.args.amount))}</td>
        <td>${fill === "none" ? `<span class="note">refunded</span>` : `<span class="chip ${fill === "full" ? "chip-purple" : ""}">${fill}</span>`}</td>
        <td class="right">${fill === "none" ? "—" : esc(perToken(P))}</td></tr>`;
    }).join("");
    return panel("", "High scores", `
      <p class="note">Every bid is public once the round settles; that transparency is intentional. Every winner pays the same price.</p>
      <div class="table-scroll"><table class="hiscore">
        <thead><tr><th>#</th><th>Bidder</th><th class="right">Max price</th><th class="right">Amount</th><th>Fill</th><th class="right">Pays / token</th></tr></thead>
        <tbody>${rows}</tbody></table></div>`, "revealed bids");
  }

  let renderedPhase = null;
  function render() {
    if (!s) return;
    patch("#p-head", headHtml());
    const ph = phase();
    if (renderedPhase && ph !== renderedPhase) $("#p-head .lamps")?.classList.add("wipe");
    renderedPhase = ph;
    patch("#p-status", statusHtml());
    patch("#p-commit", commitShell());
    if ($("#allow-box")) patch("#allow-box", allowHtml());
    if ($("#bid-form")) { patch("#bid-derived", derivedHtml(readForm())); patch("#bid-prepared", preparedHtml()); }
    patch("#p-reveal", revealHtml());
    patch("#p-called", calledHtml());
    patch("#p-public", publicHtml());
    patch("#p-result", resultHtml());
    patch("#p-bids", bidsHtml());
  }

  async function refresh() {
    try {
      if (!meta) meta = await loadRoundMeta(eng, roundId);
      await syncClock();
      s = await loadRoundState(eng, roundId, me());
      if (supplyTotal == null && s.round?.token) supplyTotal = await eng.erc20.totalSupply(s.round.token).catch(() => null);
      if (s.round.allowlistRoot !== ZERO32 && me() && allow.status === "none") loadAllowlist();
      render();
    } catch (e) {
      if (!s) patch("#p-head", `<p class="err">${esc(e.message)}</p>`);
      else say(e.message, "err");
    }
  }

  function useTree(tree) {
    const proof = proofForRound(tree, s.round.allowlistRoot, me());
    allow = proof ? { status: "ok", proof } : { status: "missing" };
  }

  async function loadAllowlist() {
    allow = { status: "loading" };
    try {
      useTree(await fetchAllowlist(meta.allowlistURI, { ipfsGateway: cfg.ipfsGateway }));
    } catch (e) {
      allow = { status: "error", error: e.message };
    }
    render();
  }

  // ── actions ──
  async function run(label, fn) {
    if (busy) return;
    busy = true;
    const buttons = [...el.querySelectorAll("button")];
    const was = buttons.map((b) => b.disabled);
    buttons.forEach((b) => { b.disabled = true; });
    say(`${label}…`);
    try {
      if (!me()) throw new Error("Connect a wallet first");
      if (app.walletChainId !== net.chainId) throw new Error(`Switch your wallet to ${net.label} (chain ${net.chainId})`);
      say((await fn()) ?? `${label}: done.`, "ok");
    } catch (e) {
      say(e.message, "err");
    } finally {
      busy = false;
      buttons.forEach((b, i) => { b.disabled = was[i]; });
      await refresh();
    }
  }

  const send = (t, feeKind) => sendTx(me(), t, { onHash: (h) => say(`Sent ${short(h)}, waiting for confirmation…`) })
    .then((rc) => { if (feeKind) addFee(ctx(), feeKind, feeOf(rc)); return rc; });
  const sign = (typed) => signTypedData(me(), typed);

  async function seal() {
    const f = readForm();
    if (f.empty || f.error || f.problems.length) throw new Error("Fix the bid first");
    say("Sign the bid-backup message in your wallet…");
    const known = signatureDeterminism(me());
    const sealed = await sealBid({
      price: f.price, amount: f.amount, ctx: ctx(), signTypedData: sign, knownDeterminism: known,
      onSecondSignature: () => say("First bid from this wallet: sign the same message once more to check it signs deterministically…"),
    });
    if (sealed.determinismWasChecked) setSignatureDeterminism(me(), sealed.determinism);
    prepared = { ...sealed, backupSaved: false };
    saveBid(ctx(), { ...prepared, status: "prepared" }); // before sending: a crash after sending cannot lose the salt
    return sealed.determinism === NONDETERMINISTIC ? "Bid sealed. Download the backup file, then commit." : "Bid sealed. Commit it to lock your deposit.";
  }

  async function commit() {
    if (!prepared) throw new Error("Seal the bid first");
    if (prepared.determinism === NONDETERMINISTIC && !prepared.backupSaved) throw new Error("Download the backup file first");
    const f = readForm();
    if (f.price !== prepared.price || f.amount !== prepared.amount) { prepared = null; throw new Error("The bid changed after sealing. Seal it again."); }
    const proof = s.round.allowlistRoot === ZERO32 ? [] : allow.proof;
    if (!proof) throw new Error("No allowlist proof for this wallet");
    const rc = await send(eng.tx.commit(roundId, prepared.hash, proof, prepared.note, s.round.depositAmount), "commit");
    updateBid(ctx(), { status: "committed", commitTx: rc.transactionHash });
    prepared = null;
    return sealedCopy();
  }

  async function reveal() {
    const bid = loadBid(ctx());
    if (!bid) throw new Error("No bid saved in this browser");
    const check = await checkBidAgainstCommitment(eng, roundId, me(), bid);
    if (!check.ok) throw new Error("This bid does not match your commitment. Load your backup file.");
    const problems = bidProblems(s.round, bid.price, bid.amount);
    if (problems.length) throw new Error(`The contract will reject this bid: ${problems.map((p) => p.message).join(" ")}`);
    await send(await eng.buildReveal(roundId, bid), "reveal");
    return "Revealed.";
  }

  async function recover() {
    say("Sign the bid-backup message to decrypt your bid…");
    const signature = await sign(backupTypedData(ctx()));
    const bid = await recoverBidFromNote({ engine: eng, chainId: net.chainId, roundId, bidder: me(), signature });
    saveBid(ctx(), { ...bid, status: "committed" });
    return "Bid recovered and checked against your commitment. You can reveal now.";
  }

  async function settleAll(action) {
    for (let i = 0; i < 20; i++) {
      await send(action.build(eng, roundId));
      if ((await eng.clearingOf(roundId)).settled) return "Settled.";
      say("Settlement continues: confirm the next transaction…");
    }
    return "Settlement is still in progress. Press Settle again.";
  }

  const DONE = {
    burn: "Unrevealed deposits burned.", seed: "Liquidity seeded. Token delivery is open.",
    abandon: "Liquidity abandoned; its MON share was burned. Token delivery is open.", dispose: "Unsold supply disposed.",
    sweep: "Dust swept.", refund: "Refund claimed.", tokens: "Tokens claimed.", vested: "Vested tokens claimed.",
  };
  const FEE_KIND = { refund: "claim", tokens: "claim" };

  function runModelAction(id) {
    const all = [...publicActions(s, meta, chainNow(), { settleSteps: cfg.settleStepsPerTx }), ...bidderActions(s, me())];
    const a = all.find((x) => x.id === id);
    if (!a) return;
    if (id === "settle") return run("Settling", () => settleAll(a));
    return run(a.label, () => send(a.build(eng, roundId), FEE_KIND[id]).then(() => DONE[id]));
  }

  const handlers = {
    seal: () => run("Sealing", seal),
    // One press: seal (saved locally with its note before anything is sent), then commit — unless this
    // wallet signs non-deterministically, where the backup-file step still has to come first.
    place: () => run("Placing your sealed bid", async () => {
      const msg = await seal();
      if (prepared && prepared.determinism !== NONDETERMINISTIC) return commit();
      return msg;
    }),
    "bid-mode": () => { bidMode = bidMode === "simple" ? "advanced" : "simple"; prepared = null; cache.delete("#p-commit"); render(); },
    commit: () => run("Committing", commit),
    "backup-prepared": () => {
      if (!prepared) return;
      downloadText(backupFilename(ctx()), backupJson(ctx(), prepared));
      prepared.backupSaved = true;
      updateBid(ctx(), { backupSaved: true });
      render();
    },
    backup: () => { const L = loadBid(ctx()); if (L) downloadText(backupFilename(ctx()), backupJson(ctx(), L)); },
    calendar: () => downloadCalendar(),
    notify: () => enableNotify().then(() => el.querySelector('[data-act="notify"]')?.focus()),
    share: () => makeShare(),
    // downloadText wraps its payload in a Blob, and a Blob accepts a Blob part.
    "share-download": () => { if (share?.blob) downloadText(shareFilename(), share.blob, "image/png"); },
    "share-x": () => { window.open(xIntentUrl(shareText(shareData()), roundUrl()), "_blank", "noopener"); },
    reveal: () => run("Revealing", reveal),
    recover: () => run("Recovering", recover),
  };

  el.addEventListener("click", (e) => {
    const mul = e.target.closest("[data-mul]");
    if (mul) {
      el.querySelectorAll("[data-mul]").forEach((x) => x.setAttribute("aria-checked", String(x === mul)));
      $("#f-custom-wrap")?.classList.toggle("hidden", mul.dataset.mul !== "custom");
      if (prepared) { prepared = null; say(""); }
      render();
      return;
    }
    const sp = e.target.closest("[data-spend]");
    if (sp && $("#f-spend")) {
      const cap = s.round.depositAmount - 1n;
      $("#f-spend").value = formatUnits(sp.dataset.spend === "1" ? cap : s.round.depositAmount / BigInt(sp.dataset.spend), 18, 6);
      if (prepared) { prepared = null; say(""); }
      render();
      return;
    }
    const b = e.target.closest("[data-act]");
    if (!b || b.disabled) return;
    e.preventDefault();
    const id = b.dataset.act;
    (handlers[id] ?? (() => runModelAction(id)))();
  });
  el.addEventListener("input", (e) => {
    if (["f-price", "f-amount", "f-spend", "f-custom"].includes(e.target.id)) {
      if (prepared) { prepared = null; say(""); }
      render();
    }
  });
  el.addEventListener("submit", (e) => e.preventDefault());
  el.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (e.target.id === "backup-file") {
      await run("Loading backup", async () => {
        const bid = parseBackup(await file.text(), ctx());
        const check = await checkBidAgainstCommitment(eng, roundId, me(), bid);
        if (!check.ok) throw new Error("This backup does not match your commitment.");
        saveBid(ctx(), { ...bid, status: "committed" });
        return "Backup loaded and checked. You can reveal now.";
      });
    }
    if (e.target.id === "allow-file") {
      try { useTree(JSON.parse(await file.text())); } catch (err) { allow = { status: "error", error: err.message }; }
      render();
    }
  });

  // ── timers ──
  let lastPhase = null;
  const tick = setInterval(() => {
    if (!s || dead) return;
    const ph = phaseOf(s, chainNow());
    const c = $("#countdown");
    if (c && ph.nextAt) {
      c.textContent = fmtCountdown(ph.nextAt - chainNow());
      c.classList.toggle("urgent", ph.phase === PHASE.Reveal && ph.nextAt - chainNow() < 300);
    }
    if (lastPhase && ph.phase !== lastPhase && !busy) refresh();
    lastPhase = ph.phase;
  }, 1000);
  const poll = setInterval(() => { if (!busy && !dead) refresh(); }, cfg.pollMs);
  refresh();

  return {
    cleanup() { dead = true; clearInterval(tick); clearInterval(poll); clearNotify(); dropShare(); },
    onAccount() { prepared = null; allow = { status: "none" }; clearNotify(); notify = { status: "idle" }; dropShare(); cache.clear(); refresh(); },
  };
}
