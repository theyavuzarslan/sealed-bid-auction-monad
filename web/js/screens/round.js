// Screens 2 & 3 — bidder round page: phase, countdown, commit, recovery, reveal, settle, seed LP,
// claim, claim vested (08-ui-notes.md, tasks/ui-bid.md, decisions 22, 27, 30, 32, 33).
// Rules: the commitment COUNT and timing are public by design and shown; revealed prices are
// shown only after settlement (post-clear transparency is intentional).
import cfg from "../../config.js";
import { engine as getEngine, network, chainNow, syncClock } from "../net.js";
import { sendTx, signTypedData, feeOf } from "../wallet.js";
import { NO_HINT, checkBidAgainstCommitment, recoverBidFromNote } from "../engine.js";
import {
  parseUnits, formatUnits, perTokenToWire, wireToPerToken, snapToTick, maxSpend, bidProblems,
  commitHash, generateSalt,
} from "../bid.js";
import { backupTypedData, keyFromSignature, encryptNote, decryptNote, signaturesMatch } from "../note.js";
import { proofFor, rootOf } from "../merkle.js";
import {
  saveBid, loadBid, updateBid, downloadBackup, parseBackup, signatureDeterminism, setSignatureDeterminism,
  addFee, loadFees,
} from "../store.js";
import { esc, short, fmtCountdown, fmtMon, fmtMonUsd, fmtTokens, fmtTime, fmtPct } from "../format.js";

const ZERO32 = "0x" + "00".repeat(32);

export function renderRound(el, app, roundIdRaw) {
  const roundId = BigInt(roundIdRaw);
  const eng = getEngine();
  const net = network();
  if (!eng) {
    el.innerHTML = `<section class="wrap"><div class="card"><p class="err">No AuctionEngine address for ${esc(net.label)}. Set it in config.js or in the Network panel on the home page.</p></div></section>`;
    return { cleanup() {}, onAccount() {} };
  }

  // ── state ──
  let s = null; // latest snapshot from chain
  let meta = null; // token decimals/symbol, allowlistURI, lpGracePeriod (read once)
  let allow = { status: "none" }; // allowlist proof state
  let prepared = null; // sealed-but-not-committed bid
  let busy = false;
  let dead = false;
  const me = () => app.account;
  const ctx = () => ({ chainId: net.chainId, engine: eng.address, roundId, bidder: me() });

  el.innerHTML = `
  <section class="wrap">
    <div class="card" id="p-head"></div>
    <div id="p-commit"></div>
    <div id="p-reveal"></div>
    <div id="p-settle"></div>
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
    // Children were replaced too: forget what they held.
    if (id === "#p-commit") ["#allow-box", "#bid-derived", "#bid-prepared"].forEach((c) => cache.delete(c));
  };
  const say = (text, kind = "") => {
    const m = $("#msg");
    m.className = `msg ${kind}`;
    m.textContent = text;
  };

  // ── units ──
  const dec = () => meta?.decimals ?? 18;
  const sym = () => meta?.symbol ?? "tokens";
  const perToken = (wire) => `${formatUnits(wireToPerToken(wire, dec()), 18, 18)} MON`;
  const tokens = (units) => fmtTokens(units, dec(), sym());

  // ── chain snapshot ──
  async function load() {
    if (!meta) {
      const r = await eng.getRound(roundId);
      if (/^0x0+$/.test(r.creator)) throw new Error(`Round ${roundId} does not exist on ${net.label}.`);
      const [decimals, symbol, opened, grace] = await Promise.all([
        eng.erc20.decimals(r.token).catch(() => 18n),
        eng.erc20.symbol(r.token).catch(() => "TOKEN"),
        eng.roundOpened(roundId).catch(() => null),
        eng.lpGracePeriod(),
      ]);
      meta = { decimals: Number(decimals), symbol, allowlistURI: opened?.args.allowlistURI ?? "", grace };
    }
    await syncClock();
    const [round, clearing, ledger, commits] = await Promise.all([
      eng.getRound(roundId), eng.clearingOf(roundId), eng.ledgers(roundId), eng.committedLogs(roundId),
    ]);
    const snap = { round, clearing, ledger, commits, now: chainNow() };
    if (me()) {
      const [commitment, account] = await Promise.all([eng.commitment(roundId, me()), eng.account(roundId, me())]);
      snap.commitment = commitment;
      snap.account = account;
      snap.committed = commitment.hash !== ZERO32;
      if (clearing.settled && commitment.revealed) snap.quote = await eng.quote(roundId, me());
      if (round.vestDuration !== 0n) snap.vest = await eng.vestedOf(roundId, me());
      snap.local = loadBid(ctx());
      snap.fees = loadFees(ctx());
    }
    if (clearing.settled) snap.revealed = await eng.revealedLogs(roundId);
    return snap;
  }

  function phaseOf(snap, now = chainNow()) {
    const { round, clearing } = snap;
    if (now < Number(round.commitEnd)) return { phase: "Commit", nextAt: Number(round.commitEnd), next: "Reveal window opens" };
    if (now < Number(round.revealEnd)) return { phase: "Reveal", nextAt: Number(round.revealEnd), next: "Reveal window closes" };
    if (!clearing.settled) return { phase: "Clearing", nextAt: null };
    if (!round.claimsOpen) return { phase: "Settled", nextAt: null };
    return { phase: "Claims open", nextAt: null };
  }

  // ── panels ──
  function headHtml() {
    const { round, ledger, commits } = s;
    const ph = phaseOf(s);
    const preset = round.preset === 0n ? "Degen" : "Raise";
    const unrevealed = ledger.commits - ledger.reveals;
    const blocks = commits.slice(-24).map((c) => `<span class="blockchip">#${c.blockNumber}</span>`).join("");
    return `
      <div class="round-title">
        <h1>${esc(sym())} · round ${roundId}</h1>
        <span class="chip">${preset}</span>
        <span class="chip" data-phase="${esc(ph.phase)}">${esc(ph.phase)}</span>
      </div>
      ${ph.nextAt ? `<div class="countdown" id="countdown">${fmtCountdown(ph.nextAt - chainNow())}</div>
        <span class="hint">${esc(ph.next)} at ${esc(fmtTime(ph.nextAt))}</span>` : ""}
      <p class="deposit-line">Everyone locks the same ${esc(fmtMon(round.depositAmount))}. This is what keeps your bid private.</p>
      <div class="stats">
        <div class="statline"><strong>${ledger.commits}</strong> <span>commitments</span></div>
        ${Number(round.commitEnd) <= s.now ? `<div class="statline"><strong>${ledger.reveals}</strong> <span>revealed</span></div>` : ""}
        ${Number(round.revealEnd) <= s.now && unrevealed > 0n ? `<div class="statline"><strong>${unrevealed}</strong> <span>unrevealed</span></div>` : ""}
      </div>
      <span class="hint">The number of commitments and when they arrived are public by design. Bid prices stay sealed until each bidder reveals.</span>
      ${blocks ? `<div class="blockrow" title="Blocks of the most recent commitments">${blocks}</div>` : ""}
      <dl class="kv">
        <dt>For sale</dt><dd>${esc(tokens(round.sellAmount))}</dd>
        <dt>Reserve price</dt><dd>${esc(perToken(round.reservePrice))} per token</dd>
        <dt>Tick size</dt><dd>${esc(perToken(round.tickSize))}</dd>
        <dt>Minimum bid</dt><dd>${esc(fmtMon(round.minBidSize))} max spend</dd>
        <dt>Commit window ends</dt><dd>${esc(fmtTime(round.commitEnd))}</dd>
        <dt>Reveal window ends</dt><dd>${esc(fmtTime(round.revealEnd))}</dd>
        <dt>Liquidity</dt><dd>${round.lpShareBps === 0n ? "none" : `${fmtPct(round.lpShareBps)} of tokens sold and MON raised, ${round.preset === 0n ? "locked permanently" : `locked until ${esc(fmtTime(round.lockEnd))}`}`}</dd>
        ${round.allowlistRoot !== ZERO32 ? `<dt>Allowlist</dt><dd>yes${meta.allowlistURI ? ` · <a href="${esc(resolveUri(meta.allowlistURI))}" target="_blank" rel="noopener">tree</a>` : ""}</dd>` : ""}
        ${round.vestDuration !== 0n ? `<dt>Vesting</dt><dd>${fmtPct(round.tgeBps)} at claim, rest linear over ${Number(round.vestDuration) / 86400} days after a ${Number(round.cliff) / 86400}-day cliff</dd>` : ""}
        <dt>Token</dt><dd class="mono">${esc(round.token)}</dd>
      </dl>
      <p class="taglines"><span>Snipe-resistant: submission timing no longer determines price</span><span>Privacy via commit-reveal</span></p>`;
  }

  const recoveryOff = () => me() && signatureDeterminism(me()) === "nondeterministic";
  const sealedCopy = () => `Your bid is sealed. Reveal it in the reveal window or your deposit is burned.${recoveryOff() ? "" : " You can reveal from any device with this wallet."}`;

  function commitShell() {
    const ph = phaseOf(s).phase;
    if (ph !== "Commit") return "";
    if (!me()) return `<div class="card"><h2>Place a sealed bid</h2><p>Connect a wallet to bid.</p></div>`;
    if (s.committed) {
      return `<div class="card"><h2>Bid committed</h2>
        <p class="ok">${esc(sealedCopy())}</p>
        <p>Come back in the reveal window (opens ${esc(fmtTime(s.round.commitEnd))}) or you lose your deposit.</p>
        ${s.local ? `<button class="btn" data-act="backup">Download backup file</button>` : ""}</div>`;
    }
    return `<div class="card"><h2>Place a sealed bid</h2>
      <div id="allow-box"></div>
      <form id="bid-form" autocomplete="off">
        <div class="grid2">
          <label>Max price per token (MON)<input id="f-price" inputmode="decimal" placeholder="${esc(formatUnits(wireToPerToken(s.round.reservePrice, dec()), 18))}"></label>
          <label>Token amount (${esc(sym())})<input id="f-amount" inputmode="decimal" placeholder="1000"></label>
        </div>
      </form>
      <div id="bid-derived"></div>
      <p class="explain">You pay the clearing price for every token you win and get the difference back. If many bids land exactly on the clearing price, they share what is left in proportion to size.</p>
      <div id="bid-prepared"></div>
    </div>`;
  }

  // Parses the form; returns {price, amount, spend, problems, notes} or {error}.
  function readForm() {
    const pStr = $("#f-price")?.value.trim() ?? "";
    const aStr = $("#f-amount")?.value.trim() ?? "";
    if (!pStr || !aStr) return { empty: true };
    let perTokenWei, amount;
    try { perTokenWei = parseUnits(pStr, 18); } catch (e) { return { error: `Price: ${e.message}` }; }
    try { amount = parseUnits(aStr, dec()); } catch (e) { return { error: `Amount: ${e.message}` }; }
    const wire = perTokenToWire(perTokenWei, dec());
    const price = snapToTick(wire, s.round.tickSize);
    const notes = [];
    if (price !== wire || wireToPerToken(wire, dec()) !== perTokenWei) notes.push(`Snapped down to the tick grid: ${perToken(price)} per token.`);
    const spend = maxSpend(price, amount);
    const problems = bidProblems(s.round, price, amount);
    if (allow.status === "missing") problems.push({ code: "NOT_ALLOWLISTED", message: "This wallet is not on the allowlist." });
    if (allow.status === "error" || allow.status === "loading") problems.push({ code: "NO_PROOF", message: "Allowlist proof not available yet." });
    return { price, amount, spend, problems, notes };
  }

  function derivedHtml(f) {
    if (f.empty) return `<p class="hint">Enter a max price and an amount to see your max spend.</p>`;
    if (f.error) return `<p class="err">${esc(f.error)}</p>`;
    const detail = (p) => {
      if (p.code === "BELOW_MIN_BID") return `${p.message} Minimum: ${fmtMon(s.round.minBidSize)}.`;
      if (p.code === "AT_OR_ABOVE_DEPOSIT") return `${p.message} Deposit: ${fmtMon(s.round.depositAmount)}.`;
      if (p.code === "BELOW_RESERVE") return `${p.message} Reserve: ${perToken(s.round.reservePrice)}.`;
      return p.message;
    };
    return `
      ${f.notes.map((n) => `<p class="hint">${esc(n)}</p>`).join("")}
      <dl class="kv">
        <dt>Max spend</dt><dd>${esc(fmtMon(f.spend, 18))}</dd>
        <dt>Deposit locked</dt><dd>${esc(fmtMon(s.round.depositAmount))}</dd>
        <dt>Refund if you win nothing</dt><dd>${esc(fmtMon(s.round.depositAmount))}</dd>
      </dl>
      ${f.problems.length ? `<ul class="problems">${f.problems.map((p) => `<li class="err">${esc(detail(p))}</li>`).join("")}</ul>`
        : `<button class="btn primary" data-act="seal">Seal bid</button>`}`;
  }

  function preparedHtml() {
    if (!prepared) return "";
    const needBackup = prepared.recovery === "nondeterministic" && !prepared.backupSaved;
    return `<div class="sealed">
      <p><strong>Sealed:</strong> ${esc(perToken(prepared.price))} per token × ${esc(tokens(prepared.amount))}</p>
      ${prepared.recovery === "nondeterministic"
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
    switch (allow.status) {
      case "loading": return `<p class="hint">Loading the allowlist…</p>`;
      case "ok": return `<p class="ok">This wallet is on the allowlist.</p>`;
      case "missing": return `<p class="err">This wallet is not on the allowlist for this round.</p>`;
      default: return `<p class="warn">Could not load the allowlist${allow.error ? `: ${esc(allow.error)}` : ""}. Load the tree file yourself:</p>
        <input type="file" id="allow-file" accept="application/json">`;
    }
  }

  function revealHtml() {
    const ph = phaseOf(s).phase;
    if (!me() || !s.committed) return "";
    if (ph === "Commit") return "";
    if (s.commitment.revealed) {
      return ph === "Reveal" ? `<div class="card"><h2>Revealed</h2><p class="ok">Your bid is in the book. Results after the reveal window closes.</p></div>` : "";
    }
    if (ph !== "Reveal") {
      return `<div class="card"><h2>Not revealed</h2><p class="err">This wallet's commitment was not revealed in the reveal window. Its deposit is burned.</p></div>`;
    }
    const L = s.local;
    const localOk = L && L.hash?.toLowerCase() === s.commitment.hash.toLowerCase();
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

  function settleHtml() {
    const { round, clearing, ledger } = s;
    if (s.now < Number(round.revealEnd)) return "";
    const due = (ledger.commits - ledger.reveals) * round.depositAmount;
    const burnable = due > ledger.burned;
    const graceAt = Number(round.settledAt) + Number(meta.grace);
    const btns = [];
    if (burnable) btns.push(`<button class="btn" data-act="burn">Burn unrevealed deposits (${ledger.commits - ledger.reveals})</button>`);
    if (!clearing.settled) btns.push(`<button class="btn primary" data-act="settle">Settle</button>`);
    if (clearing.settled && !round.lpDone) btns.push(`<button class="btn primary" data-act="seed">${round.claimsOpen ? "Retry seeding liquidity" : "Seed liquidity"}</button>`);
    if (clearing.settled && !round.claimsOpen && s.now >= graceAt) btns.push(`<button class="btn" data-act="force">Open claims without liquidity</button>`);
    if (round.lpDone && !round.dustSwept && ledger.claims === ledger.reveals) btns.push(`<button class="btn" data-act="sweep">Sweep rounding dust</button>`);
    return `<div class="card"><h2>${clearing.settled ? "Result" : "Clearing"}</h2>
      ${clearing.settled ? `<dl class="kv">
          <dt>Clearing price</dt><dd>${esc(perToken(clearing.clearingPrice))} per token</dd>
          <dt>Tokens sold</dt><dd>${esc(tokens(clearing.sold))} of ${esc(tokens(round.sellAmount))}</dd>
          <dt>Demand</dt><dd>${clearing.oversubscribed ? "oversubscribed: bids at the clearing price share pro-rata" : "every revealed bid fills in full"}</dd>
          <dt>Liquidity</dt><dd>${round.lpDone ? (round.lpMonSpent > 0n ? `seeded: ${esc(tokens(round.lpTokensUsed))} + ${esc(fmtMon(round.lpMonSpent))}` : "none") : "not seeded yet"}</dd>
          <dt>Claims</dt><dd>${round.claimsOpen ? "open" : "open once liquidity is seeded"}</dd>
        </dl>`
        : `<p>The reveal window is closed. Anyone can settle the round; large books settle over several transactions (${cfg.settleStepsPerTx} price levels each, ${clearing.levelCount} levels in this book).</p>`}
      ${clearing.settled && !round.claimsOpen && s.now < graceAt ? `<p class="hint">If seeding keeps failing, anyone can open claims without liquidity from ${esc(fmtTime(graceAt))}.</p>` : ""}
      ${burnable ? `<p class="hint">Deposits of commitments that were never revealed are burned, not paid to anyone.</p>` : ""}
      ${btns.length ? `<div class="row">${btns.join("")}</div><p class="hint">Anyone can press these.</p>` : ""}
    </div>`;
  }

  function resultHtml() {
    if (!me() || !s.clearing.settled || !s.commitment?.revealed) return "";
    const q = s.quote;
    const { round } = s;
    const claimed = s.account.settled;
    let action = "";
    if (!round.claimsOpen) action = `<p>Claims open after liquidity is seeded.</p><button class="btn primary" data-act="seed">Seed liquidity</button>`;
    else if (!claimed) action = `<button class="btn primary" data-act="claim">Claim</button>`;
    else action = `<p class="ok">Claimed.</p>`;
    let vest = "";
    if (s.vest && claimed && q.allocated > 0n) {
      const [vested, released] = s.vest;
      vest = `<h3>Vesting</h3><dl class="kv">
        <dt>Released</dt><dd>${esc(tokens(released))} of ${esc(tokens(q.allocated))}</dd>
        <dt>Claimable now</dt><dd>${esc(tokens(vested - released))}</dd></dl>
        ${vested > released ? `<button class="btn primary" data-act="vested">Claim vested tokens</button>` : ""}`;
    }
    const f = s.fees;
    return `<div class="card"><h2>Your allocation</h2>
      <dl class="kv">
        <dt>Tokens won</dt><dd>${esc(tokens(q.allocated))}</dd>
        <dt>Paid</dt><dd>${esc(fmtMon(q.paid, 18))}</dd>
        <dt>Refund</dt><dd>${esc(fmtMon(q.refund, 18))}</dd>
        ${round.vestDuration !== 0n && q.allocated > 0n ? `<dt>At claim</dt><dd>${esc(tokens(q.allocated * round.tgeBps / 10000n))}, the rest vests</dd>` : ""}
      </dl>
      ${action}${vest}
      ${f && f.total > 0n ? `<p class="fee-line">Network fees for this round (commit + reveal + claim): ${esc(fmtMonUsd(f.total))}</p>` : ""}
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
    patch("#p-settle", settleHtml());
    patch("#p-result", resultHtml());
    patch("#p-bids", bidsHtml());
  }

  async function refresh() {
    try {
      s = await load();
      if (s.round.allowlistRoot !== ZERO32 && me() && allow.status === "none") loadAllowlist();
      render();
    } catch (e) {
      if (!s) patch("#p-head", `<p class="err">${esc(e.message)}</p>`);
      else say(e.message, "err");
    }
  }

  function resolveUri(uri) {
    return uri.startsWith("ipfs://") ? cfg.ipfsGateway + uri.slice(7) : uri;
  }

  function useTree(tree) {
    if (rootOf(tree).toLowerCase() !== s.round.allowlistRoot.toLowerCase()) throw new Error("tree root does not match this round");
    const proof = proofFor(tree, me());
    allow = proof ? { status: "ok", proof, owner: me() } : { status: "missing", owner: me() };
  }

  async function loadAllowlist() {
    allow = { status: "loading", owner: me() };
    try {
      if (!meta.allowlistURI) throw new Error("the round has no allowlist URI");
      const res = await fetch(resolveUri(meta.allowlistURI));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      useTree(await res.json());
    } catch (e) {
      allow = { status: "error", error: e.message, owner: me() };
    }
    render();
  }

  // ── actions ──
  function requireWallet() {
    if (!me()) throw new Error("Connect a wallet first");
    if (app.walletChainId !== net.chainId) throw new Error(`Switch your wallet to ${net.label} (chain ${net.chainId})`);
  }

  async function run(label, fn) {
    if (busy) return;
    busy = true;
    el.querySelectorAll("button").forEach((b) => { b.dataset.wasDisabled = b.disabled ? "1" : ""; b.disabled = true; });
    say(`${label}…`);
    try {
      requireWallet();
      const done = await fn();
      say(done ?? `${label}: done.`, "ok");
    } catch (e) {
      say(e.message, "err");
    } finally {
      busy = false;
      el.querySelectorAll("button").forEach((b) => { b.disabled = b.dataset.wasDisabled === "1"; });
      await refresh();
    }
  }

  const send = (t, feeKind) => sendTx(me(), t, { onHash: (h) => say(`Sent ${short(h)}, waiting for confirmation…`) })
    .then((rc) => { if (feeKind) addFee(ctx(), feeKind, feeOf(rc)); return rc; });

  async function seal() {
    const f = readForm();
    if (f.empty || f.error || f.problems.length) throw new Error("Fix the bid first");
    const typed = backupTypedData({ chainId: net.chainId, engine: eng.address, roundId });
    say("Sign the bid-backup message in your wallet…");
    const sig = await signTypedData(me(), typed);
    let det = signatureDeterminism(me());
    if (!det) {
      say("First bid from this wallet: sign the same message once more to check it signs deterministically…");
      const sig2 = await signTypedData(me(), typed);
      setSignatureDeterminism(me(), signaturesMatch(sig, sig2));
      det = signatureDeterminism(me());
    }
    const salt = generateSalt();
    const hash = commitHash(f.price, f.amount, salt, me());
    let note = "0x";
    if (det === "deterministic") {
      const key = await keyFromSignature(sig);
      note = await encryptNote(key, { price: f.price, amount: f.amount, salt }, ctx());
      const back = await decryptNote(key, note, ctx()); // never commit a note we cannot read back
      if (back.price !== f.price || back.amount !== f.amount || back.salt !== salt) throw new Error("Note self-check failed");
    }
    prepared = { price: f.price, amount: f.amount, salt, hash, note, recovery: det, backupSaved: false };
    // Saved before the commit is sent, so a crash after sending cannot lose the salt.
    saveBid(ctx(), { ...prepared, status: "prepared" });
    return det === "deterministic" ? "Bid sealed. Commit it to lock your deposit." : "Bid sealed. Download the backup file, then commit.";
  }

  async function commit() {
    if (!prepared) throw new Error("Seal the bid first");
    if (prepared.recovery === "nondeterministic" && !prepared.backupSaved) throw new Error("Download the backup file first");
    const f = readForm();
    if (f.price !== prepared.price || f.amount !== prepared.amount) { prepared = null; throw new Error("The bid changed after sealing. Seal it again."); }
    const proof = s.round.allowlistRoot === ZERO32 ? [] : allow.proof;
    if (!proof) throw new Error("No allowlist proof for this wallet");
    const rc = await send(eng.tx.commit(roundId, prepared.hash, proof, prepared.note, s.round.depositAmount), "commit");
    updateBid(ctx(), { status: "committed", commitTx: rc.transactionHash });
    prepared = null;
    return sealedCopy();
  }

  async function reveal(rec) {
    const check = await checkBidAgainstCommitment(eng, roundId, me(), rec);
    if (!check.ok) throw new Error("This bid does not match your commitment. Load your backup file.");
    const problems = bidProblems(s.round, rec.price, rec.amount);
    if (problems.length) throw new Error(`The contract will reject this bid: ${problems.map((p) => p.message).join(" ")}`);
    const hint = await eng.findHint(roundId, rec.price);
    await send(eng.tx.reveal(roundId, rec, hint === NO_HINT ? null : hint), "reveal");
    return "Revealed.";
  }

  async function recover() {
    say("Sign the bid-backup message to decrypt your bid…");
    const sig = await signTypedData(me(), backupTypedData({ chainId: net.chainId, engine: eng.address, roundId }));
    const rec = await recoverBidFromNote({ engine: eng, chainId: net.chainId, roundId, bidder: me(), signature: sig });
    saveBid(ctx(), { ...rec, status: "committed" });
    return "Bid recovered and checked against your commitment. You can reveal now.";
  }

  async function settleAll() {
    for (let i = 0; i < 20; i++) {
      await send(eng.tx.settle(roundId, BigInt(cfg.settleStepsPerTx)));
      if ((await eng.clearingOf(roundId)).settled) return "Settled.";
      say("Settlement continues: confirm the next transaction…");
    }
    return "Settlement is still in progress. Press Settle again.";
  }

  const actions = {
    seal: () => run("Sealing", seal),
    commit: () => run("Committing", commit),
    "backup-prepared": () => {
      if (!prepared) return;
      downloadBackup({ ...ctx(), ...prepared });
      prepared.backupSaved = true;
      updateBid(ctx(), { backupSaved: true });
      render();
    },
    backup: () => { const L = loadBid(ctx()); if (L) downloadBackup({ ...ctx(), ...L }); },
    reveal: () => run("Revealing", () => reveal(s.local)),
    recover: () => run("Recovering", recover),
    burn: () => run("Burning unrevealed deposits", () => send(eng.tx.burnUnrevealed(roundId)).then(() => "Unrevealed deposits burned.")),
    settle: () => run("Settling", settleAll),
    seed: () => run("Seeding liquidity", () => send(eng.tx.seedLP(roundId)).then(() => "Liquidity seeded. Claims are open.")),
    force: () => run("Opening claims", () => send(eng.tx.forceOpenClaims(roundId)).then(() => "Claims are open.")),
    sweep: () => run("Sweeping dust", () => send(eng.tx.sweepDust(roundId)).then(() => "Dust swept.")),
    claim: () => run("Claiming", () => send(eng.tx.claim(roundId), "claim").then(() => "Claimed.")),
    vested: () => run("Claiming vested tokens", () => send(eng.tx.claimVested(roundId)).then(() => "Vested tokens claimed.")),
  };

  el.addEventListener("click", (e) => {
    const b = e.target.closest("[data-act]");
    if (!b || b.disabled) return;
    e.preventDefault();
    actions[b.dataset.act]?.();
  });
  el.addEventListener("input", (e) => {
    if (e.target.id === "f-price" || e.target.id === "f-amount") {
      if (prepared) { prepared = null; say(""); }
      render();
    }
  });
  el.addEventListener("submit", (e) => e.preventDefault());
  el.addEventListener("change", async (e) => {
    if (e.target.id === "backup-file" && e.target.files[0]) {
      const file = e.target.files[0];
      await run("Loading backup", async () => {
        const rec = parseBackup(await file.text(), ctx());
        const check = await checkBidAgainstCommitment(eng, roundId, me(), rec);
        if (!check.ok) throw new Error("This backup does not match your commitment.");
        saveBid(ctx(), { ...rec, status: "committed" });
        return "Backup loaded and checked. You can reveal now.";
      });
    }
    if (e.target.id === "allow-file" && e.target.files[0]) {
      try { useTree(JSON.parse(await e.target.files[0].text())); } catch (err) { allow = { status: "error", error: err.message }; }
      render();
    }
  });

  // ── timers ──
  let lastPhase = null;
  const tick = setInterval(() => {
    if (!s || dead) return;
    const ph = phaseOf(s);
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
