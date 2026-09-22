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
import { esc, short, fmtCountdown, fmtMon, fmtMonUsd, fmtTokens, fmtTime, fmtPct, plural } from "../format.js";

export function renderRound(el, app, roundIdRaw) {
  const roundId = BigInt(roundIdRaw);
  const eng = getEngine();
  const net = network();
  if (!eng) {
    el.innerHTML = `<section class="wrap"><div class="card"><p class="err">No AuctionEngine address for ${esc(net.label)}. Set it in config.js or in the Network panel on the home page.</p></div></section>`;
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
  <section class="wrap">
    <div class="card" id="p-head"></div>
    <div id="p-commit"></div>
    <div id="p-reveal"></div>
    <div id="p-public"></div>
    <div id="p-result"></div>
    <div id="p-bids"></div>
    <p class="msg" id="msg" role="status"></p>
  </section>`;
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
  const button = (a, primary = false) => `<button class="btn${primary ? " primary" : ""}" data-act="${a.id}">${esc(a.label)}</button>`;

  // ── panels ──
  function headHtml() {
    const { round, ledger, commits } = s;
    const ph = phaseOf(s, chainNow());
    const now = chainNow();
    const blocks = commits.slice(-24).map((c) => `<span class="blockchip">#${c.blockNumber}</span>`).join("");
    const unrevealed = ledger.commits - ledger.reveals;
    return `
      <div class="round-title">
        <h1>${esc(sym())} · round ${roundId}</h1>
        <span class="chip">${round.preset === 0n ? "Degen" : "Raise"}</span>
        <span class="chip" data-phase="${esc(ph.phase)}">${esc(ph.phase)}</span>
      </div>
      ${ph.nextAt ? `<div class="countdown" id="countdown">${fmtCountdown(ph.nextAt - now)}</div>
        <span class="hint">${esc(ph.next)} at ${esc(fmtTime(ph.nextAt))}</span>` : ""}
      <p class="deposit-line">Everyone locks the same ${esc(fmtMon(round.depositAmount))}. This is what keeps your bid private.</p>
      <div class="stats">
        <div class="statline"><strong>${ledger.commits}</strong> <span>${plural(ledger.commits, "commitment")}</span></div>
        ${now >= Number(round.commitEnd) ? `<div class="statline"><strong>${ledger.reveals}</strong> <span>revealed</span></div>` : ""}
        ${now >= Number(round.revealEnd) && unrevealed > 0n ? `<div class="statline"><strong>${unrevealed}</strong> <span>not revealed</span></div>` : ""}
      </div>
      <span class="hint">The number of commitments and when they arrived are public by design. Bid prices stay sealed until each bidder reveals.</span>
      ${blocks ? `<div class="blockrow" title="Blocks of the most recent commitments">${blocks}</div>` : ""}
      <dl class="kv">
        <dt>For sale</dt><dd>${esc(tokens(round.sellAmount))}</dd>
        <dt>Reserve price</dt><dd>${esc(perToken(round.reservePrice))} per token</dd>
        <dt>Tick size</dt><dd>${esc(perToken(round.tickSize))}</dd>
        <dt>Minimum bid</dt><dd>${esc(fmtMon(round.minBidSize))} at the reserve price</dd>
        <dt>Commit window ends</dt><dd>${esc(fmtTime(round.commitEnd))}</dd>
        <dt>Reveal window ends</dt><dd>${esc(fmtTime(round.revealEnd))}</dd>
        <dt>Liquidity</dt><dd>${round.lpShareBps === 0n ? "none" : `${fmtPct(round.lpShareBps)} of tokens sold and MON raised, ${round.preset === 0n ? "locked permanently" : `locked for ${Number(round.lockDuration) / 86400} days from seeding`}`}</dd>
        ${round.allowlistRoot !== ZERO32 ? `<dt>Allowlist</dt><dd>yes${meta.allowlistURI ? ` · <a href="${esc(resolveUri(meta.allowlistURI, cfg.ipfsGateway))}" target="_blank" rel="noopener">tree</a>` : ""}</dd>` : ""}
        ${round.vestDuration !== 0n ? `<dt>Vesting</dt><dd>${fmtPct(round.tgeBps)} at claim, the rest linear over ${Number(round.vestDuration) / 86400} days after a ${Number(round.cliff) / 86400}-day cliff</dd>` : ""}
        <dt>Token</dt><dd class="mono">${esc(round.token)}</dd>
      </dl>
      <p class="taglines"><span>Snipe-resistant: submission timing no longer determines price</span><span>Privacy via commit-reveal</span></p>`;
  }

  function commitShell() {
    if (phase() !== PHASE.Commit) return "";
    if (!me()) return `<div class="card"><h2>Place a sealed bid</h2><p>Connect a wallet to bid.</p></div>`;
    if (s.me.committed) {
      return `<div class="card"><h2>Bid committed</h2>
        <p class="ok">${esc(sealedCopy())}</p>
        <p>Come back in the reveal window (opens ${esc(fmtTime(s.round.commitEnd))}) or you lose your deposit.</p>
        ${loadBid(ctx()) ? `<button class="btn" data-act="backup">Download backup file</button>` : ""}</div>`;
    }
    return `<div class="card"><h2>Place a sealed bid</h2>
      <div id="allow-box"></div>
      <form id="bid-form" autocomplete="off">
        <div class="grid2">
          <label>Max price per token (MON)<input id="f-price" inputmode="decimal" placeholder="${esc(formatUnits(wireToPerToken(s.round.reservePrice, dec()), 18))}"></label>
          <label>Token amount (${esc(sym())})<input id="f-amount" inputmode="decimal"></label>
        </div>
      </form>
      <div id="bid-derived"></div>
      <p class="explain">You pay the clearing price for every token you win and get the difference back. If many bids land exactly on the clearing price, they share what is left in proportion to size.</p>
      <div id="bid-prepared"></div>
    </div>`;
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
    const minLine = `<p class="hint">Smallest amount: ${esc(tokensUp(f.minAmount ?? 0n))} (the minimum bid at the reserve price).</p>`;
    if (f.empty) return `${minLine}<p class="hint">Enter a max price and an amount to see your max spend.</p>`;
    if (f.error) return `<p class="err">${esc(f.error)}</p>`;
    const detail = (p) => {
      if (p.code === "BELOW_MIN_BID") return `${p.message} Smallest amount: ${tokensUp(f.minAmount)}.`;
      if (p.code === "AT_OR_ABOVE_DEPOSIT") return `${p.message} At this price the largest amount is ${tokens(f.maxAmount)}.`;
      if (p.code === "BELOW_RESERVE") return `${p.message} Reserve: ${perToken(s.round.reservePrice)}.`;
      return p.message;
    };
    return `
      ${f.snapped ? `<p class="hint">Snapped down to the tick grid: ${esc(perToken(f.price))} per token.</p>` : ""}
      <dl class="kv">
        <dt>Max spend</dt><dd>${esc(fmtMon(f.spend, 18))}</dd>
        <dt>Deposit locked</dt><dd>${esc(fmtMon(s.round.depositAmount))}</dd>
      </dl>
      ${f.problems.length ? `<ul class="problems">${f.problems.map((p) => `<li class="err">${esc(detail(p))}</li>`).join("")}</ul>`
        : `<button class="btn primary" data-act="seal">Seal bid</button>`}`;
  }

  function preparedHtml() {
    if (!prepared) return "";
    const needBackup = prepared.determinism === NONDETERMINISTIC && !prepared.backupSaved;
    return `<div class="sealed">
      <p><strong>Sealed:</strong> ${esc(perToken(prepared.price))} per token × ${esc(tokens(prepared.amount))}</p>
      ${prepared.determinism === NONDETERMINISTIC
        ? `<p class="warn">This wallet's signatures are not deterministic, so on-chain recovery is off for it. Download the backup file before committing; it is the only way to reveal from another browser.</p>`
        : `<p class="hint">An encrypted copy goes on-chain with your commitment; this wallet can decrypt it from any device.</p>`}
      <div class="row">
        <button class="btn" data-act="backup-prepared">Download backup file</button>
        <button class="btn primary" data-act="commit" ${needBackup ? "disabled" : ""}>Commit and lock ${esc(fmtMon(s.round.depositAmount))}</button>
      </div>
    </div>`;
  }

  function allowHtml() {
    if (s.round.allowlistRoot === ZERO32) return "";
    if (allow.status === "loading" || allow.status === "none") return `<p class="hint">Loading the allowlist…</p>`;
    if (allow.status === "ok") return `<p class="ok">This wallet is on the allowlist.</p>`;
    if (allow.status === "missing") return `<p class="err">This wallet is not on the allowlist for this round.</p>`;
    return `<p class="warn">Could not load the allowlist: ${esc(allow.error)}. Load the tree file yourself:</p>
      <input type="file" id="allow-file" accept="application/json">`;
  }

  function revealHtml() {
    const ph = phase();
    if (!me() || !s.me.committed || ph === PHASE.Commit) return "";
    if (s.me.revealed) {
      return ph === PHASE.Reveal ? `<div class="card"><h2>Revealed</h2><p class="ok">Your bid is in the book. Results after the reveal window closes.</p></div>` : "";
    }
    if (ph !== PHASE.Reveal) return `<div class="card"><h2>Not revealed</h2><p class="err">This wallet's commitment was not revealed in the reveal window. Its deposit is burned.</p></div>`;
    const L = loadBid(ctx());
    const localOk = L && L.hash?.toLowerCase() === s.me.commitment.hash.toLowerCase();
    return `<div class="card"><h2>Reveal your bid</h2>
      ${localOk ? `<p>Saved in this browser: ${esc(perToken(L.price))} per token × ${esc(tokens(L.amount))}.</p>
          <button class="btn primary" data-act="reveal">Reveal</button>`
        : `<p>${L ? "The bid saved in this browser does not match your commitment." : "No bid saved in this browser."}
            ${recoveryOff() ? "Load your backup file." : "Recover it with your wallet, or load your backup file."}</p>
          <div class="row">
            ${recoveryOff() ? "" : `<button class="btn primary" data-act="recover">Recover with wallet</button>`}
            <label class="btn file">Load backup file<input type="file" id="backup-file" accept="application/json" hidden></label>
          </div>`}
      <p class="hint">Reveal closes ${esc(fmtTime(s.round.revealEnd))}. An unrevealed deposit is burned.</p>
    </div>`;
  }

  function publicHtml() {
    const { round, clearing } = s;
    const now = chainNow();
    if (now < Number(round.revealEnd)) return "";
    const acts = publicActions(s, meta, now, { settleSteps: cfg.settleStepsPerTx });
    const lp = round.lpAbandoned ? `abandoned: its ${fmtMon(round.lpMonBurned)} share was burned`
      : round.lpDone ? (round.lpMonSpent > 0n ? `seeded: ${tokens(round.lpTokensUsed)} + ${fmtMon(round.lpMonSpent)}` : "none")
        : "not seeded yet";
    return `<div class="card"><h2>${clearing.settled ? "Result" : "Clearing"}</h2>
      ${clearing.settled ? `<dl class="kv">
          <dt>Clearing price</dt><dd>${esc(perToken(clearing.clearingPrice))} per token</dd>
          <dt>Tokens sold</dt><dd>${esc(tokens(clearing.sold))} of ${esc(tokens(round.sellAmount))}</dd>
          <dt>Demand</dt><dd>${clearing.oversubscribed ? "oversubscribed: bids at the clearing price share pro-rata" : "every revealed bid fills in full"}</dd>
          <dt>Refunds</dt><dd>open</dd>
          <dt>Liquidity</dt><dd>${esc(lp)}</dd>
          <dt>Token delivery</dt><dd>${round.claimsOpen ? "open" : "opens once liquidity is seeded"}</dd>
        </dl>`
        : `<p>The reveal window is closed. Anyone can settle the round; large books settle over several transactions (${cfg.settleStepsPerTx} price levels each, ${clearing.levelCount} in this book).</p>`}
      ${clearing.settled && !round.lpDone && now < abandonAt(s, meta) ? `<p class="hint">If seeding keeps failing, anyone can abandon the liquidity from ${esc(fmtTime(abandonAt(s, meta)))}: its MON share is burned and token delivery opens.</p>` : ""}
      ${unrevealedDue(s) > 0n ? `<p class="hint">Deposits of commitments nobody revealed are burned, not paid to anyone.</p>` : ""}
      ${acts.length ? `<div class="row">${acts.map((a) => button(a, a.id === "settle" || a.id === "seed")).join("")}</div><p class="hint">Anyone can press these.</p>` : ""}
    </div>`;
  }

  function resultHtml() {
    const m = s.me;
    if (!me() || !s.clearing.settled || !m?.revealed) return "";
    const q = m.quote;
    const { round } = s;
    const acts = bidderActions(s, me());
    const status = [];
    status.push(m.refunded ? `Refund of ${fmtMon(q.refund, 18)} claimed.` : "");
    if (q.allocated > 0n) {
      if (m.tokensClaimed) status.push("Tokens claimed.");
      else if (!round.claimsOpen) status.push(`Your tokens are delivered once liquidity is seeded.${m.refunded ? "" : " Your refund is available now."}`);
    }
    const f = loadFees(ctx());
    return `<div class="card"><h2>Your allocation</h2>
      <dl class="kv">
        <dt>Tokens won</dt><dd>${esc(tokens(q.allocated))}</dd>
        <dt>Paid</dt><dd>${esc(fmtMon(q.paid, 18))}</dd>
        <dt>Refund</dt><dd>${esc(fmtMon(q.refund, 18))}</dd>
        ${round.vestDuration !== 0n && q.allocated > 0n ? `<dt>At claim</dt><dd>${esc(tokens(q.allocated * round.tgeBps / 10000n))}, the rest vests</dd>` : ""}
        ${m.vest && m.tokensClaimed && q.allocated > 0n ? `<dt>Vested so far</dt><dd>${esc(tokens(m.vest[0]))}, released ${esc(tokens(m.vest[1]))}</dd>` : ""}
      </dl>
      ${status.filter(Boolean).map((t) => `<p>${esc(t)}</p>`).join("")}
      ${acts.length ? `<div class="row">${acts.map((a) => button(a, true)).join("")}</div>` : ""}
      ${f.total > 0n ? `<p class="fee-line">Network fees for this round (commit + reveal + claim): ${esc(fmtMonUsd(f.total))}</p>` : ""}
    </div>`;
  }

  function bidsHtml() {
    if (!s.clearing.settled || !s.revealed?.length) return "";
    const P = s.clearing.clearingPrice;
    const rows = [...s.revealed].sort((a, b) => (b.args.price > a.args.price ? 1 : b.args.price < a.args.price ? -1 : 0)).map((r) => {
      const p = r.args.price;
      const fill = p > P ? "full" : p < P ? "none" : s.clearing.oversubscribed ? "pro-rata" : "full";
      return `<tr><td>${esc(short(r.args.bidder))}</td><td>${esc(perToken(p))}</td><td>${esc(tokens(r.args.amount))}</td><td>${fill}</td></tr>`;
    }).join("");
    return `<div class="card"><h2>Revealed bids</h2>
      <p class="hint">Post-clear transparency is intentional: revealed bids are public once the round settles.</p>
      <table class="bids"><thead><tr><th>Bidder</th><th>Max price</th><th>Amount</th><th>Fill</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }

  function render() {
    if (!s) return;
    patch("#p-head", headHtml());
    patch("#p-commit", commitShell());
    if ($("#allow-box")) patch("#allow-box", allowHtml());
    if ($("#bid-form")) { patch("#bid-derived", derivedHtml(readForm())); patch("#bid-prepared", preparedHtml()); }
    patch("#p-reveal", revealHtml());
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
    if (c && ph.nextAt) c.textContent = fmtCountdown(ph.nextAt - chainNow());
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
