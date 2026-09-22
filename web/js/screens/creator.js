// Screen 1 — Creator: open a launch (Degen or Raise), token approval, allowlist builder, and
// withdraw proceeds. Rendering and event wiring only; OpenParams and validation live in launch.js,
// the tree in merkle.js, calls in engine.js.
import cfg from "../../config.js";
import { engine as getEngine, network, syncClock, chainNow } from "../net.js";
import { sendTx } from "../wallet.js";
import { formatUnits } from "../bid.js";
import { parseAddressList, buildTree, rootOf } from "../merkle.js";
import { buildOpenParams, DEX_FEE_TIERS, LOCK_FEE_TIERS, MAX_SPLITS, MIN_RAISE_LOCK_DAYS } from "../launch.js";
import { isAddress } from "../hex.js";
import { downloadText } from "../ui/dom.js";
import { esc, fmtMon, fmtTokens } from "../format.js";

export function renderCreator(el, app) {
  const eng = getEngine();
  const net = network();
  const d = cfg.creatorDefaults;
  if (!eng) {
    el.innerHTML = `<section class="wrap"><div class="card"><p class="err">No AuctionEngine address for ${esc(net.label)}. Set it in config.js or in the Network panel on the home page.</p></div></section>`;
    return { cleanup() {}, onAccount() {} };
  }

  let preset = "Degen";
  let token = null; // {address, decimals, symbol, balance, allowance}
  let tree = null;
  let splits = [{ adapter: net.deployment.adapter ?? "", pct: "100", fee: String(d.dexFee) }];
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
          <span>Optional allowlist, optional liquidity locked for a period you choose, optional vesting. Unsold supply returns to you.</span></button>
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
          <label>Minimum bid at the reserve price (MON)<input id="c-minbid" inputmode="decimal" value="0.01"></label>
          <label>Tick size (MON per token)<input id="c-tick" inputmode="decimal" value="0.0000001"></label>
          <label>Reserve price (MON per token)<input id="c-reserve" inputmode="decimal" value="0.0000001"></label>
        </div>
        <p class="hint">Every bidder locks the same deposit, so it caps the largest bid. A bid must be worth at least the minimum bid at the reserve price, and its max spend must stay below the deposit.</p>
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
              <select id="c-feetier">${LOCK_FEE_TIERS.map((t) => `<option value="${t.id}" ${t.id === d.lockFeeTier ? "selected" : ""}>${esc(t.label)}</option>`).join("")}</select></label>
            <label class="raise-only">Liquidity lock after seeding (days, at least ${MIN_RAISE_LOCK_DAYS})<input id="c-lockdays" inputmode="numeric" value="${esc(d.lockDays)}"></label>
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
  const val = (id) => $(id).value;
  const say = (t, k = "") => { const m = $("#msg"); m.className = `msg ${k}`; m.textContent = t; };

  function formValues() {
    return {
      preset, sell: val("#c-sell"), deposit: val("#c-deposit"), minBid: val("#c-minbid"), tick: val("#c-tick"),
      reserve: val("#c-reserve"), commitMinutes: val("#c-commit"), revealMinutes: val("#c-reveal"),
      lpOn: $("#c-lp-on").checked, lpSharePct: val("#c-lpshare"), splits, lockFeeTier: val("#c-feetier"),
      lockDays: val("#c-lockdays"), allowOn: $("#c-allow-on").checked, tree, allowlistURI: val("#c-allow-uri"),
      vestOn: $("#c-vest-on").checked, tgePct: val("#c-tge"), cliffDays: val("#c-cliff"), vestDays: val("#c-vestdays"),
    };
  }

  // ── DEX split rows ──
  function renderSplits() {
    $("#splits").innerHTML = splits.map((s, i) => `
      <div class="split-row" data-i="${i}">
        <label>Adapter<input data-k="adapter" value="${esc(s.adapter)}" placeholder="0x…"></label>
        <label>Share (%)<input data-k="pct" value="${esc(s.pct)}" inputmode="decimal"></label>
        <label>Pool fee tier<select data-k="fee">${DEX_FEE_TIERS.map((f) => `<option value="${f}" ${String(f) === s.fee ? "selected" : ""}>${f / 10000}%</option>`).join("")}</select></label>
        ${splits.length > 1 ? `<button type="button" class="btn small" data-rm="${i}">Remove</button>` : ""}
      </div>`).join("");
    $("#add-split").disabled = splits.length >= MAX_SPLITS;
  }
  renderSplits();
  $("#splits").addEventListener("input", (e) => {
    const row = e.target.closest(".split-row");
    if (row) { splits[Number(row.dataset.i)][e.target.dataset.k] = e.target.value; update(); }
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
    $("#lp-fields").classList.toggle("hidden", !(preset === "Degen" || $("#c-lp-on").checked));
    $("#allow-fields").classList.toggle("hidden", !(preset === "Raise" && $("#c-allow-on").checked));
    $("#vest-fields").classList.toggle("hidden", !(preset === "Raise" && $("#c-vest-on").checked));
  }
  el.querySelectorAll(".preset-card").forEach((b) => b.addEventListener("click", () => { preset = b.dataset.preset; applyPreset(); update(); }));
  ["#c-lp-on", "#c-allow-on", "#c-vest-on"].forEach((id) => $(id).addEventListener("change", () => { applyPreset(); update(); }));
  applyPreset();

  // ── allowlist builder ──
  $("#c-allow-file").addEventListener("change", async (e) => {
    const f = e.target.files[0];
    if (f) { $("#c-allow-csv").value = await f.text(); tree = null; $("#dl-tree").disabled = true; update(); }
  });
  $("#c-allow-csv").addEventListener("input", () => { tree = null; $("#dl-tree").disabled = true; });
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
    if (tree) downloadText(`allowlist-${rootOf(tree).slice(2, 10)}.json`, JSON.stringify(tree, null, 2));
  });

  // ── token ──
  let tokenReq = 0;
  async function loadToken() {
    const addr = val("#c-token").trim();
    const req = ++tokenReq;
    if (!isAddress(addr)) { token = null; $("#token-info").textContent = addr ? "Not an address." : ""; update(); return; }
    try {
      const [decimals, symbol] = await Promise.all([eng.erc20.decimals(addr), eng.erc20.symbol(addr).catch(() => "TOKEN")]);
      let balance = null, allowance = null;
      if (app.account) [balance, allowance] = await Promise.all([eng.erc20.balanceOf(addr, app.account), eng.erc20.allowance(addr, app.account, eng.address)]);
      if (req !== tokenReq) return;
      token = { address: addr, decimals: Number(decimals), symbol, balance, allowance };
      $("#token-info").textContent = `${symbol}, ${decimals} decimals${balance != null ? `. Your balance: ${formatUnits(balance, Number(decimals), 4)}` : ""}`;
    } catch {
      if (req !== tokenReq) return;
      token = null;
      $("#token-info").textContent = "Could not read this token (not an ERC-20 on this network?).";
    }
    update();
  }
  $("#c-token").addEventListener("change", loadToken);

  function update() {
    const { params, problems, need } = buildOpenParams(formValues(), token, chainNow());
    const t = token;
    const enough = t?.allowance != null && t.allowance >= need;
    $("#summary").innerHTML = `
      <dl class="kv">
        <dt>Tokens locked</dt><dd>${t ? esc(fmtTokens(need, t.decimals, t.symbol)) : "?"}${params.lpShareBps ? " (sale + liquidity reserve)" : ""}</dd>
        ${t?.balance != null ? `<dt>Your balance</dt><dd class="${t.balance < need ? "err" : ""}">${esc(fmtTokens(t.balance, t.decimals, t.symbol))}</dd>` : ""}
        ${t?.allowance != null ? `<dt>Approved</dt><dd>${esc(fmtTokens(t.allowance, t.decimals, t.symbol))}</dd>` : ""}
        <dt>Unsold supply</dt><dd>${preset === "Degen" ? "burned (returned to you if nothing sells)" : "returned to you"}</dd>
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
    const { need } = buildOpenParams(formValues(), token, chainNow());
    await sendTx(app.account, eng.erc20.approveTx(token.address, eng.address, need));
    return "Approved.";
  }));
  $("#open").addEventListener("click", () => run("Opening round", async () => {
    await syncClock();
    const { params, problems } = buildOpenParams(formValues(), token, chainNow());
    if (problems.length) throw new Error(problems[0]);
    const rc = await sendTx(app.account, eng.tx.openRound(params));
    const ev = eng.decodeReceiptLogs(rc).find((x) => x.event === "RoundOpened");
    const id = ev?.args.roundId;
    return id != null ? { html: `Round ${id} is open. <a href="#/round/${id}">Go to the round page</a>` } : "Round opened.";
  }));

  // ── your rounds + withdraw proceeds ──
  async function loadMine() {
    if (!app.account) { $("#mine").innerHTML = `<p class="hint">Connect a wallet to see rounds you opened.</p>`; return; }
    try {
      const logs = await eng.roundsByCreator(app.account);
      if (!logs.length) { $("#mine").innerHTML = `<p class="hint">No rounds opened from this wallet.</p>`; return; }
      const now = chainNow();
      const rows = await Promise.all(logs.map(async (l) => {
        const id = l.args.roundId;
        const [r, avail] = await Promise.all([eng.getRound(id), eng.creatorAvailable(id)]);
        const status = r.claimsOpen ? (r.lpAbandoned ? "LP abandoned" : "claims open") : r.settledAt !== 0n ? "settled"
          : Number(r.revealEnd) <= now ? "clearing" : Number(r.commitEnd) <= now ? "reveal" : "commit";
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

  syncClock().catch(() => {}).finally(() => { if (!dead) { loadToken(); loadMine(); } });
  const poll = setInterval(() => { if (!busy && !dead) update(); }, 5000);

  return {
    cleanup() { dead = true; clearInterval(poll); },
    onAccount() { loadToken(); loadMine(); },
  };
}
