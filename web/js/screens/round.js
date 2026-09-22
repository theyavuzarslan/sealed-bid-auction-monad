// Screens 2 & 3 — bidder round page. Rendering and event wiring only; the logic lives in
// round-model.js (state, phases, actions, bid form), recovery.js (seal / recover / backup),
// merkle.js (allowlist), engine.js (calls) and store.js (localStorage).
// Rules: the commitment COUNT and timing are public by design; revealed prices only after settlement.
import cfg from "../../config.js";
import { engine as getEngine, network, chainNow, syncClock } from "../net.js";
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
import { staircase } from "../ui/pixel.js";
import { esc, short, fmtCountdown, fmtMon, fmtMonUsd, fmtTokens, fmtTime, fmtPct, plural } from "../format.js";

export function renderRound(el, app, roundIdRaw) {
  const roundId = BigInt(roundIdRaw);
  const eng = getEngine();
  const net = network();
  if (!eng) {
    el.innerHTML = `<section class="page page-narrow"><div class="panel"><div class="panel-in"><h1 class="panel-title">No engine</h1><p class="err">No AuctionEngine address for ${esc(net.label)}. Set it in config.js or under Cabinet settings at the bottom of the page.</p></div></div></section>`;
    return { cleanup() {}, onAccount() {} };
  }

  let s = null; // round state snapshot
  let meta = null;
  let allow = { status: "none" };
  let prepared = null; // sealed bid not yet committed
  let busy = false;
  let dead = false;
  const me = () => app.account;
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
      <dl class="readout">
        <dt>For sale</dt><dd>${esc(tokens(round.sellAmount))}</dd>
        <dt>Deposit</dt><dd>${esc(fmtMon(round.depositAmount))} each</dd>
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

  function commitShell() {
    if (phase() !== PHASE.Commit) return "";
    if (!me()) return panel("panel-p1", "Insert coin", `<p>Connect a wallet to place a sealed bid.</p>`, "commit");
    if (s.me.committed) {
      return panel("panel-p1", "Coin in", `
        <div class="ticket"><p class="ticket-line">Sealed</p><p>${esc(sealedCopy())}</p>
          <p class="note">Come back when the reveal window opens (${esc(fmtTime(s.round.commitEnd))}), or your deposit is burned.</p></div>
        ${loadBid(ctx()) ? `<div class="btn-row" style="margin-top:16px"><button class="btn btn-panel" type="button" data-act="backup">Download backup file</button></div>` : ""}`, "committed");
    }
    return panel("panel-p1", "Insert coin", `
      <p>Everyone locks the same ${esc(fmtMon(s.round.depositAmount))}, so your deposit gives nothing away. Your price and amount are sealed as a hash.</p>
      <div id="allow-box"></div>
      <form id="bid-form" autocomplete="off">
        <div class="fields">
          <label>Max price per token (MON)<input id="f-price" inputmode="decimal" placeholder="${esc(formatUnits(wireToPerToken(s.round.reservePrice, dec()), 18))}"></label>
          <label>Amount (${esc(sym())})<input id="f-amount" inputmode="decimal"></label>
        </div>
      </form>
      <div id="bid-derived"></div>
      <p class="note">You pay the clearing price for every token you win and get the difference back. If many bids land exactly on the clearing price, they share what is left in proportion to size.</p>
      <div id="bid-prepared"></div>`, "commit");
  }

  function readForm() {
    const f = parseBidInput({ priceText: $("#f-price")?.value, amountText: $("#f-amount")?.value }, s.round, dec());
    if (f.problems) {
      if (allow.status === "missing") f.problems.push({ code: "NOT_ALLOWLISTED", message: "This wallet is not on the allowlist." });
      if (allow.status === "error" || allow.status === "loading") f.problems.push({ code: "NO_PROOF", message: "Allowlist proof not available yet." });
    }
    return f;
  }

  function derivedHtml(f) {
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
      ${f.total > 0n ? `<p class="note" style="margin-top:14px">Network fees for this round (commit + reveal + claim): ${esc(fmtMonUsd(f.total))}</p>` : ""}`, "collect");
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
    commit: () => run("Committing", commit),
    "backup-prepared": () => {
      if (!prepared) return;
      downloadText(backupFilename(ctx()), backupJson(ctx(), prepared));
      prepared.backupSaved = true;
      updateBid(ctx(), { backupSaved: true });
      render();
    },
    backup: () => { const L = loadBid(ctx()); if (L) downloadText(backupFilename(ctx()), backupJson(ctx(), L)); },
    reveal: () => run("Revealing", reveal),
    recover: () => run("Recovering", recover),
  };

  el.addEventListener("click", (e) => {
    const b = e.target.closest("[data-act]");
    if (!b || b.disabled) return;
    e.preventDefault();
    const id = b.dataset.act;
    (handlers[id] ?? (() => runModelAction(id)))();
  });
  el.addEventListener("input", (e) => {
    if (e.target.id === "f-price" || e.target.id === "f-amount") {
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
    cleanup() { dead = true; clearInterval(tick); clearInterval(poll); },
    onAccount() { prepared = null; allow = { status: "none" }; cache.clear(); refresh(); },
  };
}
