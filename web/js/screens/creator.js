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
import { createTokenTx, createdToken, newTokenProblems } from "../engine.js";
import { downloadText } from "../ui/dom.js";
import { notLiveHtml } from "../ui/notlive.js";
import { esc, fmtMon, fmtTokens } from "../format.js";

export function renderCreator(el, app) {
  const eng = getEngine();
  const net = network();
  const d = cfg.creatorDefaults;
  if (!eng) {
    el.innerHTML = notLiveHtml(net, "Launches");
    return { cleanup() {}, onAccount() {} };
  }

  let preset = "Degen";
  let token = null; // {address, decimals, symbol, balance, allowance}
  let tree = null;
  let splits = [{ adapter: net.deployment.adapter ?? "", pct: "100", fee: String(d.dexFee) }];
  let busy = false;
  let dead = false;

  const P = (tone, title, body, extra = "") =>
    `<section class="panel ${tone}" ${extra}><div class="panel-in"><h2 class="panel-title">${title}</h2>${body}</div></section>`;

  el.innerHTML = `
  <section class="page">
    <div class="section-head" style="margin-bottom:32px">
      <h1 style="font:400 clamp(3rem,8vw,5.6rem)/0.85 var(--f-display)">Advanced launch</h1>
      <p style="color:var(--purple-glow)">Launch to your community at one fair price. Every winner pays the same clearing price, whatever block they bid in, and the pool opens at that price.</p>
    </div>
    <div class="grid-app">
      <form id="open-form" class="col" autocomplete="off">
        ${P("", "Choose a cartridge", `
          <div class="cartridges">
            <button type="button" class="cartridge selected" data-preset="Degen" aria-pressed="true"><strong>Degen</strong>
              <span>Open to everyone. A pool is required and locked permanently; you collect its trading fees. Unsold supply is burned.</span></button>
            <button type="button" class="cartridge" data-preset="Raise" aria-pressed="false"><strong>Raise</strong>
              <span>Optional allowlist, optional pool locked for a period you choose, optional vesting. Unsold supply returns to you.</span></button>
          </div>`)}

        ${P("", "Token and sale", `
          <label class="check"><input type="checkbox" id="c-new-on"${net.deployment.tokenFactory ? "" : " disabled"}> Make a new token for this launch</label>
          <p class="field-hint">${net.deployment.tokenFactory
            ? "A plain token with a fixed supply, minted once to you: no owner, no mint, no fees, nothing you could use against buyers later."
            : `No token factory on ${esc(net.label)} yet; use an existing token.`}</p>
          <div id="new-token" class="hidden">
            <div class="fields">
              <label>Token name<input id="c-new-name" maxlength="32" placeholder="Monad Cat"></label>
              <label>Symbol<input id="c-new-symbol" maxlength="12" placeholder="MCAT"></label>
              <label>Total supply (tokens)<input id="c-new-supply" inputmode="numeric" value="1000000000"></label>
            </div>
            <div class="btn-row" style="margin-bottom:16px"><button class="btn btn-start" id="c-new-create" type="button">Create token</button></div>
          </div>
          <label>Token address<input id="c-token" value="${esc(net.deployment.token ?? "")}" placeholder="0x…"></label>
          <p class="field-hint" id="token-info" style="margin-top:8px"></p>
          <div class="fields">
            <label>Tokens for sale<input id="c-sell" inputmode="decimal" value="1000000"></label>
            <label>Deposit per bidder (MON)<input id="c-deposit" inputmode="decimal" value="1"></label>
            <label>Minimum bid at the reserve (MON)<input id="c-minbid" inputmode="decimal" value="0.01"></label>
            <label>Tick size (MON / token)<input id="c-tick" inputmode="decimal" value="0.0000001"></label>
            <label>Reserve price (MON / token)<input id="c-reserve" inputmode="decimal" value="0.0000001"></label>
          </div>
          <p class="field-hint">Every bidder locks the same deposit, so it caps the largest bid and gives nothing away. A bid must be worth at least the minimum at the reserve price, and its max spend must stay below the deposit.</p>
          <div class="fields">
            <label>Commit window (minutes)<input id="c-commit" inputmode="numeric" value="10"></label>
            <label>Reveal window (minutes)<input id="c-reveal" inputmode="numeric" value="10"></label>
          </div>`)}

        ${P("", "Pool", `
          <label class="check raise-only"><input type="checkbox" id="c-lp-on" checked> Seed a DEX pool after the sale</label>
          <div id="lp-fields">
            <div class="fields" style="margin-top:12px">
              <label>Share of tokens sold and MON raised for the pool (%)<input id="c-lpshare" inputmode="decimal" value="${esc(d.lpSharePct)}"></label>
            </div>
            <p class="field-hint">The pool opens at the clearing price. You deposit a reserve of the same share of the sale supply up front; what the pool does not use follows the unsold-supply rule.</p>
            <h3 class="subhead">DEX split</h3>
            <div id="splits"></div>
            <button type="button" class="btn btn-sm" id="add-split">Add a DEX</button>
            <div class="fields" style="margin-top:18px">
              <label>Lock fee tier (GoPlus)
                <select id="c-feetier">${LOCK_FEE_TIERS.map((t) => `<option value="${t.id}" ${t.id === d.lockFeeTier ? "selected" : ""}>${esc(t.label)}</option>`).join("")}</select></label>
              <label class="raise-only">Pool lock after seeding (days, at least ${MIN_RAISE_LOCK_DAYS})<input id="c-lockdays" inputmode="numeric" value="${esc(d.lockDays)}"></label>
            </div>
            <p class="field-hint degen-only">Degen pools are locked permanently with GoPlus. You collect the trading fees.</p>
          </div>`)}

        ${P("raise-only", "Allowlist", `
          <label class="check"><input type="checkbox" id="c-allow-on"> Only allowlisted wallets can bid</label>
          <div id="allow-fields" class="hidden" style="margin-top:14px">
            <label>Addresses (one per line or comma separated)<textarea id="c-allow-csv" rows="5" placeholder="0x…"></textarea></label>
            <p style="margin:10px 0"><input type="file" id="c-allow-file" accept=".csv,.txt,text/csv,text/plain" aria-label="Load addresses from a file"></p>
            <div class="btn-row"><button type="button" class="btn btn-sm" id="build-tree">Build tree</button>
              <button type="button" class="btn btn-sm" id="dl-tree" disabled>Download tree JSON</button></div>
            <p id="tree-info" class="field-hint" style="margin-top:10px"></p>
            <label>Allowlist URI (where you host the tree; bidders' browsers fetch it)<input id="c-allow-uri" placeholder="https://… or ipfs://…"></label>
          </div>`)}

        ${P("raise-only", "Vesting", `
          <label class="check"><input type="checkbox" id="c-vest-on"> Vest bought tokens</label>
          <div id="vest-fields" class="fields hidden" style="margin-top:14px">
            <label>Delivered at claim (%)<input id="c-tge" inputmode="decimal" value="${esc(d.tgePct)}"></label>
            <label>Cliff after settlement (days)<input id="c-cliff" inputmode="decimal" value="${esc(d.cliffDays)}"></label>
            <label>Linear vesting after the cliff (days)<input id="c-vestdays" inputmode="decimal" value="${esc(d.vestDays)}"></label>
          </div>`)}
      </form>

      <div class="col">
        <section class="panel panel-p2" style="position:sticky;top:96px"><div class="panel-in">
          <h2 class="panel-title">Press start</h2>
          <div id="summary"></div>
          <div class="btn-row">
            <button type="button" class="btn btn-panel" id="approve">Approve</button>
            <button type="button" class="btn btn-start" id="open">Lock supply and open</button>
          </div>
          <p class="msg" id="msg" role="status" aria-live="polite"></p>
        </div></section>
        <section class="panel"><div class="panel-in">
          <h2 class="panel-title">Your rounds</h2>
          <div id="mine"><p class="note">Connect a wallet to see rounds you opened.</p></div>
        </div></section>
      </div>
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
        <label>Pool fee<select data-k="fee">${DEX_FEE_TIERS.map((f) => `<option value="${f}" ${String(f) === s.fee ? "selected" : ""}>${f / 10000}%</option>`).join("")}</select></label>
        ${splits.length > 1 ? `<button type="button" class="btn btn-sm" data-rm="${i}">Remove</button>` : "<span></span>"}
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
    el.querySelectorAll(".cartridge").forEach((b) => { b.classList.toggle("selected", b.dataset.preset === preset); b.setAttribute("aria-pressed", String(b.dataset.preset === preset)); });
    el.querySelectorAll(".raise-only").forEach((n) => n.classList.toggle("hidden", preset !== "Raise"));
    el.querySelectorAll(".degen-only").forEach((n) => n.classList.toggle("hidden", preset !== "Degen"));
    $("#lp-fields").classList.toggle("hidden", !(preset === "Degen" || $("#c-lp-on").checked));
    $("#allow-fields").classList.toggle("hidden", !(preset === "Raise" && $("#c-allow-on").checked));
    $("#vest-fields").classList.toggle("hidden", !(preset === "Raise" && $("#c-vest-on").checked));
  }
  // PRD preset table: Degen runs in minutes, Raise over hours to days. Only untouched windows follow the preset.
  const WINDOWS = { Degen: "10", Raise: "1440" };
  el.querySelectorAll(".cartridge").forEach((b) => b.addEventListener("click", () => {
    const was = WINDOWS[preset];
    preset = b.dataset.preset;
    for (const id of ["#c-commit", "#c-reveal"]) if ($(id).value === was) $(id).value = WINDOWS[preset];
    applyPreset(); update();
  }));
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

  // ── new token (TokenFactory) ──
  $("#c-new-on").addEventListener("change", () => $("#new-token").classList.toggle("hidden", !$("#c-new-on").checked));
  $("#c-new-create").addEventListener("click", () => run("Creating token", async () => {
    const factory = net.deployment.tokenFactory;
    const name = val("#c-new-name"), symbol = val("#c-new-symbol").trim().toUpperCase();
    const { problems, supply } = newTokenProblems(name, symbol, val("#c-new-supply"));
    if (problems.length) throw new Error(problems.join(" "));
    const rc = await sendTx(app.account, createTokenTx(factory, name.trim(), symbol, supply));
    const addr = createdToken(rc, factory);
    if (!addr) throw new Error("Token created, but its address was not in the receipt. Check the transaction.");
    $("#c-token").value = addr;
    $("#c-new-on").checked = false;
    $("#new-token").classList.add("hidden");
    return `${symbol} created at ${addr}, all ${val("#c-new-supply")} tokens in your wallet. Next: approve, then press start.`;
  }));

  function update() {
    const { params, problems, need } = buildOpenParams(formValues(), token, chainNow());
    const t = token;
    const enough = t?.allowance != null && t.allowance >= need;
    $("#summary").innerHTML = `
      <dl class="readout">
        <dt>Tokens locked</dt><dd>${t ? esc(fmtTokens(need, t.decimals, t.symbol)) : "?"}${params.lpShareBps ? " (sale + liquidity reserve)" : ""}</dd>
        ${t?.balance != null ? `<dt>Your balance</dt><dd class="${t.balance < need ? "err" : ""}">${esc(fmtTokens(t.balance, t.decimals, t.symbol))}</dd>` : ""}
        ${t?.allowance != null ? `<dt>Approved</dt><dd>${esc(fmtTokens(t.allowance, t.decimals, t.symbol))}</dd>` : ""}
        <dt>Unsold supply</dt><dd>${preset === "Degen" ? "burned (returned to you if nothing sells)" : "returned to you"}</dd>
      </dl>
      ${problems.length ? `<ul class="problems" style="margin-bottom:16px">${problems.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>` : ""}`;
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
    if (!app.account) { $("#mine").innerHTML = `<p class="note">Connect a wallet to see rounds you opened.</p>`; return; }
    try {
      const logs = await eng.roundsByCreator(app.account);
      if (!logs.length) { $("#mine").innerHTML = `<p class="note">No rounds opened from this wallet yet.</p>`; return; }
      const now = chainNow();
      const rows = await Promise.all(logs.map(async (l) => {
        const id = l.args.roundId;
        const [r, avail] = await Promise.all([eng.getRound(id), eng.creatorAvailable(id)]);
        const status = r.claimsOpen ? (r.lpAbandoned ? "LP abandoned" : "claims open") : r.settledAt !== 0n ? "settled"
          : Number(r.revealEnd) <= now ? "clearing" : Number(r.commitEnd) <= now ? "reveal" : "commit";
        return `<tr><td><a href="#/round/${id}">#${id}</a></td><td>${r.preset === 0n ? "Degen" : "Raise"}</td><td>${esc(status)}</td>
          <td>${esc(fmtMon(avail))}</td>
          <td>${r.lpDone && avail > 0n ? `<button type="button" class="btn btn-start btn-sm" data-withdraw="${id}">Withdraw</button>` : r.lpDone ? "" : `<span class="note">after the pool</span>`}</td></tr>`;
      }));
      $("#mine").innerHTML = `<div class="table-scroll"><table class="hiscore"><thead><tr><th>Round</th><th>Preset</th><th>Stage</th><th>Yours to withdraw</th><th></th></tr></thead><tbody>${rows.reverse().join("")}</tbody></table></div>`;
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
