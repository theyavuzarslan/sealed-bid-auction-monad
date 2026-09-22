// Screen 1 — Creator: open a launch (Degen or Raise), token approval, allowlist builder,
// and withdraw proceeds for the creator's rounds (08-ui-notes.md, decisions 23–29, 32).
import cfg from "../../config.js";
import { engine as getEngine, network, syncClock, chainNow } from "../net.js";
import { sendTx } from "../wallet.js";
import { PRESET } from "../engine.js";
import { parseUnits, formatUnits, perTokenToWire, UINT96_MAX } from "../bid.js";
import { parseAddressList, buildTree, rootOf } from "../merkle.js";
import { isAddress } from "../hex.js";
import { esc, fmtMon, fmtTokens } from "../format.js";

const ZERO32 = "0x" + "00".repeat(32);
const BPS = 10000n;
const MAX_SPLITS = 4;
const U = (bits) => (1n << BigInt(bits)) - 1n;

export function renderCreator(el, app) {
  const eng = getEngine();
  const net = network();
  const d = cfg.creatorDefaults;
  if (!eng) {
    el.innerHTML = `<section class="wrap"><div class="card"><p class="err">No AuctionEngine address for ${esc(net.label)}. Set it in config.js or in the Network panel on the home page.</p></div></section>`;
    return { cleanup() {}, onAccount() {} };
  }

  let preset = "Degen";
  let tokenInfo = null; // {address, decimals, symbol, balance, allowance}
  let tree = null; // allowlist dump
  let busy = false;
  let dead = false;

  el.innerHTML = `
  <section class="wrap">
    <h1>Open a launch</h1>
    <p class="lede">Launch to your community at one fair price. Everyone who wins pays the same clearing price, whatever block they bid in.</p>
    <p class="taglines"><span>Snipe-resistant: submission timing no longer determines price</span><span>Privacy via commit-reveal</span></p>

    <div class="card">
      <h2>Preset</h2>
      <div class="preset-row">
        <button type="button" class="preset-card selected" data-preset="Degen"><strong>Degen</strong>
          <span>Open to everyone. Liquidity is required and locked permanently. Unsold supply is burned.</span></button>
        <button type="button" class="preset-card" data-preset="Raise"><strong>Raise</strong>
          <span>Optional allowlist, optional liquidity with an unlock date, optional vesting. Unsold supply returns to you.</span></button>
      </div>
    </div>

    <form id="open-form" autocomplete="off">
      <div class="card">
        <h2>Token and sale</h2>
        <label>Token address<input id="c-token" value="${esc(net.deployment.token ?? "")}" placeholder="0x…"></label>
        <p class="hint" id="token-info"></p>
        <div class="grid2">
          <label>Tokens for sale<input id="c-sell" inputmode="decimal" value="1000000"></label>
          <label>Uniform deposit (MON)<input id="c-deposit" inputmode="decimal" value="1"></label>
          <label>Minimum bid, on max spend (MON)<input id="c-minbid" inputmode="decimal" value="0.01"></label>
          <label>Tick size (MON per token)<input id="c-tick" inputmode="decimal" value="0.0000001"></label>
          <label>Reserve price (MON per token)<input id="c-reserve" inputmode="decimal" value="0.0000001"></label>
        </div>
        <p class="hint">Every bidder locks the same deposit, so it must be larger than any bid you want to accept. A bid's max spend must be at least the minimum bid and below the deposit.</p>
        <div class="grid2">
          <label>Commit window (minutes)<input id="c-commit" inputmode="numeric" value="60"></label>
          <label>Reveal window (minutes)<input id="c-reveal" inputmode="numeric" value="60"></label>
        </div>
      </div>

      <div class="card">
        <h2>Liquidity</h2>
        <label class="check raise-only"><input type="checkbox" id="c-lp-on" checked> Seed a DEX pool after the sale</label>
        <div id="lp-fields">
          <label>Share of tokens sold and MON raised that goes to the pool (%)<input id="c-lpshare" inputmode="decimal" value="${esc(d.lpSharePct)}"></label>
          <p class="hint">The pool opens at the clearing price. You deposit a reserve of the same share of the sale supply up front; what is not used follows the unsold-supply rule.</p>
          <h3>DEX split</h3>
          <div id="splits"></div>
          <button type="button" class="btn" id="add-split">Add a DEX</button>
          <div class="grid2">
            <label>Lock fee tier (GoPlus)
              <select id="c-feetier">
                <option value="DEFAULT">DEFAULT: 0.40% of position, 1.60% of fees</option>
                <option value="LVP">LVP: 0.64% of position, 0.80% of fees</option>
                <option value="LLP">LLP: 0.24% of position, 2.80% of fees</option>
              </select></label>
            <label class="raise-only">Liquidity unlock date<input type="datetime-local" id="c-lockend"></label>
          </div>
          <p class="hint degen-only">Degen liquidity is locked permanently. You collect the trading fees.</p>
        </div>
      </div>

      <div class="card raise-only">
        <h2>Allowlist</h2>
        <label class="check"><input type="checkbox" id="c-allow-on"> Only allowlisted wallets can bid</label>
        <div id="allow-fields" class="hidden">
          <label>Addresses (CSV, one per line or comma separated)<textarea id="c-allow-csv" rows="5" placeholder="0x…"></textarea></label>
          <input type="file" id="c-allow-file" accept=".csv,.txt,text/csv,text/plain">
          <div class="row"><button type="button" class="btn" id="build-tree">Build tree</button>
            <button type="button" class="btn" id="dl-tree" disabled>Download tree JSON</button></div>
          <p id="tree-info" class="hint"></p>
          <label>Allowlist URI (where you host the tree JSON; bidders' browsers fetch it)<input id="c-allow-uri" placeholder="https://… or ipfs://…"></label>
        </div>
      </div>

      <div class="card raise-only">
        <h2>Vesting</h2>
        <label class="check"><input type="checkbox" id="c-vest-on"> Vest bought tokens</label>
        <div id="vest-fields" class="grid2 hidden">
          <label>Paid at claim (%)<input id="c-tge" inputmode="decimal" value="${esc(d.tgePct)}"></label>
          <label>Cliff after settlement (days)<input id="c-cliff" inputmode="decimal" value="${esc(d.cliffDays)}"></label>
          <label>Linear vesting after the cliff (days)<input id="c-vestdays" inputmode="decimal" value="${esc(d.vestDays)}"></label>
        </div>
      </div>

      <div class="card">
        <h2>Lock supply and open round</h2>
        <div id="summary"></div>
        <div class="row">
          <button type="button" class="btn" id="approve">Approve</button>
          <button type="button" class="btn primary" id="open">Lock supply and open round</button>
        </div>
        <p class="msg" id="msg" role="status"></p>
      </div>
    </form>

    <div class="card">
      <h2>Your rounds</h2>
      <div id="mine"><p class="hint">Connect a wallet to see rounds you opened.</p></div>
    </div>
  </section>`;

  const $ = (s) => el.querySelector(s);
  const say = (t, k = "") => { const m = $("#msg"); m.className = `msg ${k}`; m.textContent = t; };

  // ── DEX split rows ──
  let splits = [{ adapter: net.deployment.adapter ?? "", pct: "100", fee: String(d.dexFee) }];
  function renderSplits() {
    $("#splits").innerHTML = splits.map((s, i) => `
      <div class="split-row" data-i="${i}">
        <label>Adapter<input data-k="adapter" value="${esc(s.adapter)}" placeholder="0x…"></label>
        <label>Share (%)<input data-k="pct" value="${esc(s.pct)}" inputmode="decimal"></label>
        <label>Pool fee tier<select data-k="fee">${[100, 500, 3000, 10000].map((f) => `<option value="${f}" ${String(f) === s.fee ? "selected" : ""}>${f / 10000}%</option>`).join("")}</select></label>
        ${splits.length > 1 ? `<button type="button" class="btn small" data-rm="${i}">Remove</button>` : ""}
      </div>`).join("");
    $("#add-split").disabled = splits.length >= MAX_SPLITS;
  }
  renderSplits();
  $("#splits").addEventListener("input", (e) => {
    const row = e.target.closest(".split-row");
    if (!row) return;
    splits[Number(row.dataset.i)][e.target.dataset.k] = e.target.value;
    update();
  });
  $("#splits").addEventListener("click", (e) => {
    if (e.target.dataset.rm == null) return;
    splits.splice(Number(e.target.dataset.rm), 1);
    renderSplits();
    update();
  });
  $("#add-split").addEventListener("click", () => {
    splits.push({ adapter: net.deployment.adapter ?? "", pct: "0", fee: String(d.dexFee) });
    renderSplits();
    update();
  });

  // ── preset + toggles ──
  function applyPreset() {
    el.querySelectorAll(".preset-card").forEach((b) => b.classList.toggle("selected", b.dataset.preset === preset));
    el.querySelectorAll(".raise-only").forEach((n) => n.classList.toggle("hidden", preset !== "Raise"));
    el.querySelectorAll(".degen-only").forEach((n) => n.classList.toggle("hidden", preset !== "Degen"));
    const lpOn = preset === "Degen" || $("#c-lp-on").checked;
    $("#lp-fields").classList.toggle("hidden", !lpOn);
    $("#allow-fields").classList.toggle("hidden", !(preset === "Raise" && $("#c-allow-on").checked));
    $("#vest-fields").classList.toggle("hidden", !(preset === "Raise" && $("#c-vest-on").checked));
  }
  el.querySelectorAll(".preset-card").forEach((b) => b.addEventListener("click", () => { preset = b.dataset.preset; applyPreset(); update(); }));
  ["#c-lp-on", "#c-allow-on", "#c-vest-on"].forEach((id) => $(id).addEventListener("change", () => { applyPreset(); update(); }));
  applyPreset();

  // ── allowlist builder ──
  $("#c-allow-file").addEventListener("change", async (e) => {
    const f = e.target.files[0];
    if (f) { $("#c-allow-csv").value = await f.text(); tree = null; update(); }
  });
  $("#c-allow-csv").addEventListener("input", () => { tree = null; $("#dl-tree").disabled = true; update(); });
  $("#build-tree").addEventListener("click", () => {
    try {
      const { addresses, invalid } = parseAddressList($("#c-allow-csv").value);
      tree = buildTree(addresses);
      $("#tree-info").innerHTML = `${addresses.length} addresses. Root <span class="mono">${esc(rootOf(tree))}</span>${invalid.length ? `<br><span class="warn">Skipped ${invalid.length} entries that are not addresses: ${esc(invalid.slice(0, 5).join(", "))}${invalid.length > 5 ? "…" : ""}</span>` : ""}`;
      $("#dl-tree").disabled = false;
    } catch (err) {
      tree = null;
      $("#tree-info").innerHTML = `<span class="err">${esc(err.message)}</span>`;
    }
    update();
  });
  $("#dl-tree").addEventListener("click", () => {
    if (!tree) return;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify(tree, null, 2)], { type: "application/json" }));
    a.download = `allowlist-${rootOf(tree).slice(2, 10)}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });

  // ── token info ──
  let tokenReq = 0;
  async function loadToken() {
    const addr = $("#c-token").value.trim();
    const req = ++tokenReq;
    if (!isAddress(addr)) { tokenInfo = null; $("#token-info").textContent = addr ? "Not an address." : ""; update(); return; }
    try {
      const [decimals, symbol] = await Promise.all([eng.erc20.decimals(addr), eng.erc20.symbol(addr).catch(() => "TOKEN")]);
      let balance = null, allowance = null;
      if (app.account) {
        [balance, allowance] = await Promise.all([eng.erc20.balanceOf(addr, app.account), eng.erc20.allowance(addr, app.account, eng.address)]);
      }
      if (req !== tokenReq) return;
      tokenInfo = { address: addr, decimals: Number(decimals), symbol, balance, allowance };
      $("#token-info").textContent = `${symbol}, ${decimals} decimals${balance != null ? `. Your balance: ${formatUnits(balance, Number(decimals), 4)}` : ""}`;
    } catch {
      if (req !== tokenReq) return;
      tokenInfo = null;
      $("#token-info").textContent = "Could not read this token (not an ERC-20 on this network?).";
    }
    update();
  }
  $("#c-token").addEventListener("change", loadToken);

  // ── build + validate OpenParams (mirrors AuctionEngine._validate) ──
  function build(nowSec) {
    const problems = [];
    const val = (id) => $(id).value.trim();
    const num = (id, decimals, label) => {
      try { return parseUnits(val(id), decimals); } catch (e) { problems.push(`${label}: ${e.message}`); return 0n; }
    };
    if (!tokenInfo) problems.push("Enter a readable token address.");
    const tdec = tokenInfo?.decimals ?? 18;
    const sellAmount = num("#c-sell", tdec, "Tokens for sale");
    const depositAmount = num("#c-deposit", 18, "Deposit");
    const minBidSize = num("#c-minbid", 18, "Minimum bid");
    const tickSize = perTokenToWire(num("#c-tick", 18, "Tick size"), tdec);
    const reservePrice = perTokenToWire(num("#c-reserve", 18, "Reserve price"), tdec);
    const commitMin = Number(val("#c-commit"));
    const revealMin = Number(val("#c-reveal"));
    if (!(commitMin > 0) || !(revealMin > 0)) problems.push("Both windows must be longer than zero minutes.");
    const commitEnd = BigInt(nowSec + Math.round(commitMin * 60) + 30); // 30 s margin for inclusion
    const revealEnd = commitEnd + BigInt(Math.round(revealMin * 60));

    if (sellAmount === 0n) problems.push("Tokens for sale must be above zero.");
    if (sellAmount > U(128)) problems.push("Tokens for sale does not fit uint128.");
    if (tickSize === 0n) problems.push("Tick size must be above zero.");
    if (reservePrice === 0n || (tickSize !== 0n && reservePrice % tickSize !== 0n)) problems.push("Reserve price must be above zero and a multiple of the tick size.");
    if (minBidSize === 0n || depositAmount <= minBidSize) problems.push("The deposit must be larger than the minimum bid, and the minimum bid above zero.");
    for (const [v, n] of [[depositAmount, "Deposit"], [minBidSize, "Minimum bid"], [tickSize, "Tick size"], [reservePrice, "Reserve price"]]) {
      if (v > UINT96_MAX) problems.push(`${n} does not fit uint96.`);
    }

    const lpOn = preset === "Degen" || $("#c-lp-on").checked;
    let lpShareBps = 0n;
    let dexSplits = [];
    let lockEnd = 0n;
    let lockFeeTier = "";
    if (lpOn) {
      try { lpShareBps = parseUnits(val("#c-lpshare"), 2); } catch { problems.push("Liquidity share must be a percentage with at most two decimals."); }
      if (lpShareBps === 0n) problems.push(preset === "Degen" ? "Degen launches need a liquidity share above zero." : "Liquidity share must be above zero, or turn liquidity off.");
      if (lpShareBps > BPS) problems.push("Liquidity share cannot exceed 100%.");
      let sum = 0n;
      dexSplits = splits.map((s, i) => {
        let bps = 0n;
        try { bps = parseUnits(s.pct, 2); } catch { problems.push(`DEX ${i + 1}: share must be a percentage.`); }
        if (!isAddress(s.adapter)) problems.push(`DEX ${i + 1}: adapter is not an address.`);
        if (bps === 0n) problems.push(`DEX ${i + 1}: share must be above zero.`);
        sum += bps;
        return { adapter: s.adapter, bps, fee: BigInt(s.fee) };
      });
      if (sum !== BPS) problems.push("DEX shares must add up to 100%.");
      lockFeeTier = $("#c-feetier").value;
      if (preset === "Raise") {
        const t = Date.parse(val("#c-lockend"));
        if (!Number.isFinite(t)) problems.push("Pick a liquidity unlock date.");
        else lockEnd = BigInt(Math.floor(t / 1000));
        if (lockEnd && lockEnd <= revealEnd) problems.push("The liquidity unlock date must be after the reveal window ends.");
      }
    }

    let allowlistRoot = ZERO32;
    let allowlistURI = "";
    if (preset === "Raise" && $("#c-allow-on").checked) {
      if (!tree) problems.push("Build the allowlist tree first.");
      else allowlistRoot = rootOf(tree);
      allowlistURI = val("#c-allow-uri");
      if (!allowlistURI) problems.push("Enter the URI where bidders can fetch the allowlist tree.");
    }

    let tgeBps = 0n, cliff = 0n, vestDuration = 0n;
    if (preset === "Raise" && $("#c-vest-on").checked) {
      try { tgeBps = parseUnits(val("#c-tge"), 2); } catch { problems.push("Paid at claim must be a percentage."); }
      const days = (id) => { const v = Number(val(id)); if (!(v >= 0)) problems.push("Vesting days must be zero or more."); return BigInt(Math.round(v * 86400)); };
      cliff = days("#c-cliff");
      vestDuration = days("#c-vestdays");
      if (vestDuration === 0n) problems.push("Vesting duration must be above zero, or turn vesting off.");
      if (tgeBps >= BPS) problems.push("Paid at claim must be below 100%.");
    }

    const params = {
      preset: PRESET[preset], token: tokenInfo?.address ?? "0x" + "00".repeat(20), sellAmount, depositAmount, minBidSize, tickSize,
      reservePrice, commitEnd, revealEnd, allowlistRoot, allowlistURI, lpShareBps, dexSplits, lockEnd, lockFeeTier,
      tgeBps, cliff, vestDuration,
    };
    const need = sellAmount + sellAmount * lpShareBps / BPS;
    return { params, problems, need };
  }

  function update() {
    const { params, problems, need } = build(chainNow());
    const t = tokenInfo;
    const enough = t?.allowance != null && t.allowance >= need;
    $("#summary").innerHTML = `
      <dl class="kv">
        <dt>Tokens locked</dt><dd>${t ? esc(fmtTokens(need, t.decimals, t.symbol)) : "—"}${params.lpShareBps ? ` (sale ${esc(formatUnits(params.sellAmount, t?.decimals ?? 18, 4))} + liquidity reserve)` : ""}</dd>
        ${t?.balance != null ? `<dt>Your balance</dt><dd class="${t.balance < need ? "err" : ""}">${esc(fmtTokens(t.balance, t.decimals, t.symbol))}</dd>` : ""}
        ${t?.allowance != null ? `<dt>Approved</dt><dd>${esc(fmtTokens(t.allowance, t.decimals, t.symbol))}</dd>` : ""}
        <dt>Unsold supply</dt><dd>${preset === "Degen" ? "burned" : "returned to you"} (returned to you if nothing sells)</dd>
      </dl>
      ${problems.length ? `<ul class="problems">${problems.map((p) => `<li class="err">${esc(p)}</li>`).join("")}</ul>` : ""}`;
    $("#approve").disabled = busy || !app.account || !t || need === 0n || enough;
    $("#approve").textContent = t ? `Approve ${formatUnits(need, t.decimals, 4)} ${t.symbol}` : "Approve";
    $("#open").disabled = busy || !app.account || problems.length > 0 || !enough;
  }
  $("#open-form").addEventListener("input", (e) => { if (!e.target.closest(".split-row")) update(); });
  $("#open-form").addEventListener("submit", (e) => e.preventDefault());

  async function run(label, fn) {
    if (busy) return;
    busy = true; update(); say(`${label}…`);
    try {
      if (!app.account) throw new Error("Connect a wallet first");
      if (app.walletChainId !== net.chainId) throw new Error(`Switch your wallet to ${net.label} (chain ${net.chainId})`);
      const out = await fn();
      if (out?.html) { $("#msg").className = "msg ok"; $("#msg").innerHTML = out.html; } else say(out ?? `${label}: done.`, "ok");
    } catch (e) {
      say(e.message, "err");
    } finally {
      busy = false;
      await loadToken();
      loadMine();
    }
  }

  $("#approve").addEventListener("click", () => run("Approving", async () => {
    const { need } = build(chainNow());
    await sendTx(app.account, eng.erc20.approveTx(tokenInfo.address, eng.address, need));
    return "Approved.";
  }));
  $("#open").addEventListener("click", () => run("Opening round", async () => {
    await syncClock();
    const { params, problems } = build(chainNow());
    if (problems.length) throw new Error(problems[0]);
    const rc = await sendTx(app.account, eng.tx.openRound(params));
    const ev = rc.logs.map((l) => { try { return eng.iface.decodeLog(l); } catch { return null; } }).find((x) => x?.event === "RoundOpened");
    const id = ev?.args.roundId;
    return id != null ? { html: `Round ${id} is open. <a href="#/round/${id}">Go to the round page</a>` } : "Round opened.";
  }));

  // ── your rounds + withdraw proceeds ──
  async function loadMine() {
    if (!app.account) { $("#mine").innerHTML = `<p class="hint">Connect a wallet to see rounds you opened.</p>`; return; }
    try {
      const logs = await eng.roundsByCreator(app.account);
      if (!logs.length) { $("#mine").innerHTML = `<p class="hint">No rounds opened from this wallet.</p>`; return; }
      const rows = await Promise.all(logs.map(async (l) => {
        const id = l.args.roundId;
        const [r, avail] = await Promise.all([eng.getRound(id), eng.creatorAvailable(id)]);
        const status = r.claimsOpen ? "claims open" : r.settledAt !== 0n ? "settled" : Number(r.revealEnd) <= chainNow() ? "clearing" : Number(r.commitEnd) <= chainNow() ? "reveal" : "commit";
        return `<tr><td><a href="#/round/${id}">#${id}</a></td><td>${r.preset === 0n ? "Degen" : "Raise"}</td><td>${esc(status)}</td>
          <td>${esc(fmtMon(avail))}</td>
          <td>${r.lpDone && avail > 0n ? `<button type="button" class="btn small" data-withdraw="${id}">Withdraw proceeds</button>` : r.lpDone ? "" : `<span class="hint">after liquidity is seeded</span>`}</td></tr>`;
      }));
      $("#mine").innerHTML = `<table class="bids"><thead><tr><th>Round</th><th>Preset</th><th>Status</th><th>Withdrawable</th><th></th></tr></thead><tbody>${rows.reverse().join("")}</tbody></table>`;
    } catch (e) {
      $("#mine").innerHTML = `<p class="err">${esc(e.message)}</p>`;
    }
  }
  $("#mine").addEventListener("click", (e) => {
    const id = e.target.dataset.withdraw;
    if (id) run("Withdrawing proceeds", async () => { await sendTx(app.account, eng.tx.withdrawProceeds(BigInt(id))); return `Proceeds of round ${id} withdrawn.`; });
  });

  // Default Raise unlock date: 180 days out.
  const lockDefault = new Date(Date.now() + 180 * 86400e3);
  $("#c-lockend").value = new Date(lockDefault.getTime() - lockDefault.getTimezoneOffset() * 60e3).toISOString().slice(0, 16);

  syncClock().catch(() => {}).finally(() => { if (!dead) { loadToken(); loadMine(); } });
  const poll = setInterval(() => { if (!busy && !dead) update(); }, 5000);

  return {
    cleanup() { dead = true; clearInterval(poll); },
    onAccount() { loadToken(); loadMine(); },
  };
}
