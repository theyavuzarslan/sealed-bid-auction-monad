// Screens 2 & 3 — Bidder: round page (commit), reveal and claim (08-ui-notes.md).
// Rule enforced here: commitment COUNT and timing are shown (intentional public
// leak); revealed prices are NEVER rendered before the Cleared event.
import cfg from "../../config.js";
import { encodeCommit, encodeReveal, encodeClaim } from "../abi.js";
import { connectWallet, sendAndWait } from "../wallet.js";
import {
  fetchRoundParams, fetchCommitments, fetchRevealed, fetchCleared,
  fetchMyClaim, phaseOf, recordJourneyFee,
} from "../chain.js";
import { commitPreimageHash, generateSalt } from "../commitHash.js";
import { loadBid, saveBid, downloadBackup, importBackup, loadJourneyFees } from "../salt.js";
import { fmtCountdown, fmtNative, fmtRatio, fmtInt } from "../format.js";

const UINT96_MAX = 2n ** 96n - 1n;

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function short(a) {
  return a.slice(0, 8) + "…" + a.slice(-6);
}

function parseUint96(str, label) {
  if (!/^\d+$/.test(String(str).trim())) throw new Error(`${label}: must be a non-negative integer (raw uint96 value)`);
  const v = BigInt(str);
  if (v > UINT96_MAX) throw new Error(`${label}: above uint96`);
  return v;
}

const feeLine = (fees) => {
  let s = fmtNative(fees.total);
  if (cfg.monPriceUsd) {
    const usd = (Number(fees.total) / 1e18) * cfg.monPriceUsd;
    s += ` (≈ $${usd.toFixed(4)})`;
  }
  return s;
};

export function renderRound(el, state, roundIdRaw) {
  const roundId = BigInt(roundIdRaw); // throws on bad route
  const account = () => state.account;
  const me = () => account()?.toLowerCase() ?? null;

  let params = null, cleared = null, commitments = [], revealed = [], myClaim = null;
  let lastActionPhase = null;

  el.innerHTML = `
  <section class="wrap">
    <div class="card" id="round-head">
      <div class="round-title">
        <h1 id="round-token">${esc(cfg.tokenLabel ?? "Token")}</h1>
        <span class="hint">Round #${roundId}</span>
        <span class="chip" id="phase-chip">…</span>
      </div>
      <div class="countdown" id="countdown">—</div>
      <div class="taglines">
        <span>Snipe-resistant: submission timing no longer determines price</span>
        <span>Privacy via commit-reveal</span>
      </div>
    </div>

    <div class="card" id="stats-card">
      <h2>Commitments</h2>
      <div id="stats-zone">Loading…</div>
      <p class="hint">Commitment count and timing are public by design — an intentional leak.</p>
    </div>

    <div id="action-zone"></div>
    <div id="postclear-zone"></div>
  </section>`;

  const $ = (id) => el.querySelector("#" + id);
  const actionZone = $("action-zone"), postclearZone = $("postclear-zone");

  const myCommitment = () => commitments.some((c) => c.bidder === me());
  const myReveal = () => revealed.some((r) => r.bidder === me());

  function renderStats() {
    const zone = $("stats-zone");
    if (!commitments.length) {
      zone.innerHTML = "<div><strong>No commitments yet</strong></div>";
      return;
    }
    const first = commitments[0].blockNumber;
    const last = commitments[commitments.length - 1].blockNumber;
    const recent = commitments.slice(-12).map((c) => `<span class="blockchip" title="tx ${esc(c.txHash)}">blk ${esc(c.blockNumber)}</span>`).join("");
    zone.innerHTML = `
      <div class="statline"><strong>${fmtInt(commitments.length)}</strong> commitment${commitments.length === 1 ? "" : "s"}</div>
      <div class="hint">first block ${esc(first)} · latest block ${esc(last)}</div>
      <div class="blockrow">${recent}</div>`;
  }

  function renderAction(force = false) {
    const { phase } = phaseOf(params, cleared, Date.now() / 1000);
    if (!force && phase === lastActionPhase) return;
    lastActionPhase = phase;
    const storedBid = me() ? loadBid(roundId, account()) : null;

    if (phase === "Unknown") {
      actionZone.innerHTML = `<div class="card"><h2>Round not found</h2>
        <p>No RoundOpened event for round #${roundId}. Check the round id, the sealing layer address, and the wallet RPC.</p></div>`;
      return;
    }

    if (phase === "Commit") {
      if (myCommitment() && storedBid) {
        actionZone.innerHTML = `<div class="card">
          <h2>Committed</h2>
          <p>Locked: ${cfg.depositAmountWei ? fmtNative(cfg.depositAmountWei) : "the uniform deposit"} — your price and quantity stay sealed until you reveal.</p>
          <p class="warn">Come back in the reveal window or you lose your deposit.</p>
          <button class="btn" id="dl-backup">Download bid backup</button>
        </div>`;
      } else {
        const depositText = cfg.depositAmountWei
          ? fmtNative(cfg.depositAmountWei)
          : "the same capped amount (not configured — web/config.js)";
        actionZone.innerHTML = `<div class="card">
          <h2>Commit a bid</h2>
          <p class="hint">Your price and quantity are sealed onchain — only the commitment hash is public.</p>
          <div class="grid2">
            <label>Price
              <span class="hint">Raw uint96 value — TODO: human-readable price format is not specified in the docs.</span>
              <input id="bid-price" placeholder="1000000000000000000">
            </label>
            <label>Quantity
              <span class="hint">Raw uint96 value.</span>
              <input id="bid-quantity" placeholder="5000000000000000000">
            </label>
          </div>
          <p class="deposit-line">Everyone locks the same ${depositText} — this is what keeps your bid private</p>
          <p class="hint">A random salt is generated in your browser and stored locally. It is needed to reveal.</p>
          ${cfg.depositAmountWei ? "" : `<p class="warn">Commit is disabled: uniform deposit not configured (web/config.js) — TODO: no proposed event or getter exposes depositAmount yet.</p>`}
          <div id="bid-msg" class="msg" role="status"></div>
          <button class="btn primary" id="commit-btn" ${cfg.depositAmountWei ? "" : "disabled"}>Commit bid</button>
        </div>`;
      }
      return;
    }

    if (phase === "Reveal") {
      if (myReveal()) {
        actionZone.innerHTML = `<div class="card"><h2>Revealed</h2><p>Your bid is revealed. Waiting for the reveal window to close and the round to clear.</p></div>`;
        return;
      }
      if (storedBid) {
        actionZone.innerHTML = `<div class="card">
          <h2>Reveal your bid</h2>
          <p class="hint">Pre-filled from the bid stored in this browser.</p>
          <dl class="kv">
            <dt>Price</dt><dd>${esc(storedBid.price)}</dd>
            <dt>Quantity</dt><dd>${esc(storedBid.quantity)}</dd>
            <dt>Salt</dt><dd class="mono">${esc(storedBid.salt)}</dd>
          </dl>
          <div id="bid-msg" class="msg" role="status"></div>
          <button class="btn primary" id="reveal-btn">Reveal bid</button>
          <button class="btn" id="dl-backup">Download bid backup</button>
        </div>`;
      } else if (myCommitment()) {
        actionZone.innerHTML = `<div class="card">
          <h2>Reveal your bid</h2>
          <p class="warn">No bid stored in this browser. Import your backup file — otherwise you cannot reveal and your deposit is slashed.</p>
          <input type="file" id="import-file" accept=".json">
          <div id="bid-msg" class="msg" role="status"></div>
        </div>`;
      } else {
        actionZone.innerHTML = `<div class="card"><h2>Reveal window</h2><p>The commit window has closed. No commitment from this address in this round.</p></div>`;
      }
      return;
    }

    if (phase === "Clearing") {
      actionZone.innerHTML = `<div class="card"><h2>Clearing</h2>
        <p>Reveal window closed — sorting revealed bids and setting the clearing price. Settlement may span multiple transactions.</p></div>`;
      return;
    }

    // Settled — claim + post-clear (Screen 3)
    const fees = me() ? loadJourneyFees(roundId, account()) : { total: 0n, commit: 0n, reveal: 0n, claim: 0n };
    let claimBlock;
    if (!myCommitment()) {
      claimBlock = `<p>Nothing to claim — no commitment from this address in this round.</p>`;
    } else if (myClaim) {
      claimBlock = `
        <dl class="kv">
          <dt>Your fill</dt><dd>${esc(myClaim.filled)}</dd>
          <dt>Your refund</dt><dd>${esc(myClaim.refunded)}</dd>
        </dl>
        <p class="hint">Refund = deposit released net of fills. TODO: not specified — the proposed Claimed event carries one refunded field covering both.</p>`;
    } else {
      claimBlock = `<button class="btn primary" id="claim-btn">Claim</button>
        <div id="bid-msg" class="msg" role="status"></div>`;
    }
    actionZone.innerHTML = `<div class="card">
      <h2>Settled — claim</h2>
      ${claimBlock}
      <p class="fee-line">Journey cost (commit + reveal + claim): ${feeLine(fees)}</p>
      <p class="hint">Full bidder journey target: &lt; $0.01 in network fees.</p>
    </div>`;

    // Post-clear: cleared price + revealed bids (allowed only after clearing).
    postclearZone.innerHTML = `<div class="card">
      <h2>Clearing result</h2>
      <dl class="kv">
        <dt>Clearing price</dt><dd>${fmtRatio(cleared.clearingPriceNum, cleared.clearingPriceDen)}</dd>
        <dt>Filled volume</dt><dd>${esc(cleared.filledVolume)}</dd>
      </dl>
      ${revealed.length ? `
      <h3>Revealed bids</h3>
      <table class="bids">
        <thead><tr><th>Bidder</th><th>Price</th><th>Quantity</th></tr></thead>
        <tbody>${revealed.map((r) => `<tr><td class="mono">${short(r.bidder)}</td><td>${esc(r.price)}</td><td>${esc(r.quantity)}</td></tr>`).join("")}</tbody>
      </table>
      <p class="hint">Post-clear transparency is intentional; losers who never reveal stay private.</p>` : ""}
    </div>`;
  }

  function tickCountdown() {
    const { phase, nextAt } = phaseOf(params, cleared, Date.now() / 1000);
    const chip = $("phase-chip");
    chip.textContent = phase;
    chip.dataset.phase = phase;
    $("countdown").textContent =
      nextAt != null ? `${fmtCountdown(Number(nextAt) - Date.now() / 1000)} to ${phase === "Commit" ? "commit window close" : "reveal window close"}`
      : phase === "Clearing" ? "waiting for settlement"
      : phase === "Settled" ? "settled"
      : "—";
  }

  async function refresh() {
    try {
      [params, cleared, commitments] = await Promise.all([
        fetchRoundParams(roundId),
        fetchCleared(roundId),
        fetchCommitments(roundId),
      ]);
      const [rv, mc] = await Promise.all([
        fetchRevealed(roundId),
        me() ? fetchMyClaim(roundId, account()) : Promise.resolve(null),
      ]);
      revealed = rv;
      myClaim = mc;
      renderStats();
      renderAction();
      tickCountdown();
    } catch (err) {
      const zone = $("stats-zone");
      if (zone) zone.innerHTML = `<span class="err">${esc(err.message)}</span>`;
    }
  }

  // Transaction handlers --------------------------------------------------------

  el.addEventListener("click", async (e) => {
    const id = e.target?.id;
    const msgEl = $("bid-msg");
    const setMsg = (m, cls = "") => {
      if (msgEl) { msgEl.className = "msg " + cls; msgEl.textContent = m; }
    };
    try {
      if (id === "commit-btn") {
        if (!cfg.sealingLayerAddress) throw new Error("Sealing layer address not configured (web/config.js)");
        if (!cfg.depositAmountWei) throw new Error("Uniform deposit not configured (web/config.js) — TODO: no proposed event or getter exposes depositAmount yet");
        const acct = account() ?? (await connectWallet());
        if (!state.account) { state.account = acct; state.refreshHeader?.(); }
        const price = parseUint96(el.querySelector("#bid-price").value, "Price");
        const quantity = parseUint96(el.querySelector("#bid-quantity").value, "Quantity");
        if (price <= 0n || quantity <= 0n) throw new Error("Price and quantity must be positive");
        const salt = generateSalt();
        const hash = commitPreimageHash(price, quantity, salt, acct);
        // Persist the preimage BEFORE sending — the salt must survive a reload
        // even if the tab closes while the transaction is pending.
        saveBid(roundId, acct, { price, quantity, salt, committedAt: Date.now() });
        setMsg("Sending commit transaction…");
        const receipt = await sendAndWait({
          from: acct,
          to: cfg.sealingLayerAddress,
          data: encodeCommit(roundId, hash),
          value: "0x" + BigInt(cfg.depositAmountWei).toString(16),
        });
        saveBid(roundId, acct, { price, quantity, salt, committedAt: Date.now(), commitTxHash: receipt.transactionHash });
        recordJourneyFee(roundId, acct, "commit", receipt);
        await refresh();
        renderAction(true);
      }

      if (id === "reveal-btn") {
        const acct = account() ?? (await connectWallet());
        if (!state.account) { state.account = acct; state.refreshHeader?.(); }
        const bid = loadBid(roundId, acct);
        if (!bid) throw new Error("No stored bid to reveal");
        setMsg("Revealing…");
        const receipt = await sendAndWait({
          from: acct,
          to: cfg.sealingLayerAddress,
          data: encodeReveal(roundId, BigInt(bid.price), BigInt(bid.quantity), bid.salt),
        });
        recordJourneyFee(roundId, acct, "reveal", receipt);
        await refresh();
        renderAction(true);
      }

      if (id === "claim-btn") {
        const acct = account() ?? (await connectWallet());
        if (!state.account) { state.account = acct; state.refreshHeader?.(); }
        setMsg("Claiming…");
        const receipt = await sendAndWait({ from: acct, to: cfg.sealingLayerAddress, data: encodeClaim(roundId) });
        recordJourneyFee(roundId, acct, "claim", receipt);
        setMsg("Claimed.", "ok");
        await refresh();
        renderAction(true);
      }

      if (id === "dl-backup") {
        downloadBackup(roundId, account());
      }
    } catch (err) {
      setMsg(err.message, "err");
    }
  });

  el.addEventListener("change", async (e) => {
    if (e.target?.id === "import-file") {
      const file = e.target.files[0];
      if (!file) return;
      try {
        await importBackup(file, roundId, account());
        renderAction(true);
      } catch (err) {
        const msgEl = $("bid-msg");
        if (msgEl) { msgEl.className = "msg err"; msgEl.textContent = err.message; }
      }
    }
  });

  const poll = setInterval(refresh, cfg.pollMs);
  const ticker = setInterval(tickCountdown, 1000);
  refresh();

  return () => { clearInterval(poll); clearInterval(ticker); };
}
