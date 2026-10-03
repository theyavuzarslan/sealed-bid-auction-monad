// Launch a token in three short steps: token, sale, pool. Plain inputs go through simple.js into the
// same form launch.buildOpenParams validates; one Launch button creates the token (if new), approves
// and opens the round, and can resume where it stopped. The full form lives at #/host/advanced.
import cfg from "../../config.js";
import { engine as getEngine, network, syncClock, chainNow } from "../net.js";
import { sendTx } from "../wallet.js";
import { formatUnits } from "../bid.js";
import { buildOpenParams } from "../launch.js";
import { simpleLaunchForm, DURATIONS } from "../simple.js";
import { createTokenTx, createdToken, newTokenProblems } from "../engine.js";
import { isAddress } from "../hex.js";
import { notLiveHtml } from "../ui/notlive.js";
import { esc, fmtMon, fmtTokens } from "../format.js";

const lsGet = (k) => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } };
const lsSet = (k, v) => { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } };

export function renderLaunchSimple(el, app) {
  const eng = getEngine();
  const net = network();
  if (!eng) { el.innerHTML = notLiveHtml(net, "Launches"); return { cleanup() {}, onAccount() {} }; }

  const st = {
    preset: "Degen", mode: "new", name: "", symbol: "", supply: "1000000000", address: "",
    sellPct: "50", floorMon: "10", depositMon: "2", duration: "10m", lpPct: "20", lockDays: "180",
  };
  let token = null; // {address, decimals, symbol, totalSupply, balance, allowance}
  let busy = false;
  let dead = false;
  let steps = null; // [{label, state}] while launching
  const draftKey = () => `sba.launch.draft.${net.chainId}.${(app.account ?? "").toLowerCase()}`;

  el.innerHTML = `
  <section class="page">
    <div class="section-head" style="margin-bottom:28px">
      <h1 style="font:400 clamp(3rem,8vw,5.6rem)/0.85 var(--f-display)">Launch a token</h1>
      <p style="color:var(--purple-glow)">Three choices, one button. Everyone who wins pays the same price, and the pool opens at that price, locked.</p>
    </div>
    <div class="grid-app">
      <div class="col">
        <section class="panel"><div class="panel-in">
          <h2 class="panel-title"><span class="step-no">1</span> Your token</h2>
          <div class="seg" role="radiogroup" aria-label="Token">
            <button type="button" role="radio" data-mode="new">Make a new token</button>
            <button type="button" role="radio" data-mode="existing">Use a token I have</button>
          </div>
          <div id="tok-new" class="fields" style="margin-top:16px">
            <label>Name<input id="s-name" maxlength="32" placeholder="Monad Cat" autocomplete="off"></label>
            <label>Symbol<input id="s-symbol" maxlength="12" placeholder="MCAT" autocomplete="off"></label>
            <label>Total supply<input id="s-supply" inputmode="numeric" value="${esc(st.supply)}"></label>
          </div>
          <div id="tok-draft"></div>
          <div id="tok-existing" class="hidden" style="margin-top:16px">
            <label>Token address<input id="s-address" placeholder="0x…" autocomplete="off"></label>
            <p class="field-hint" id="s-token-info" style="margin-top:8px"></p>
          </div>
        </div></section>

        <section class="panel"><div class="panel-in">
          <h2 class="panel-title"><span class="step-no">2</span> The sale</h2>
          <div class="seg" role="radiogroup" aria-label="Launch type">
            <button type="button" role="radio" data-preset="Degen">Degen · open to all, pool locked forever</button>
            <button type="button" role="radio" data-preset="Raise">Raise · you choose the lock</button>
          </div>
          <div class="fields" style="margin-top:16px">
            <label>Share of supply to sell (%)<input id="s-sell" inputmode="decimal" value="${esc(st.sellPct)}"></label>
            <label>Least you'll accept for them (MON)<input id="s-floor" inputmode="decimal" value="${esc(st.floorMon)}"></label>
            <label>Biggest single bid (MON)<input id="s-deposit" inputmode="decimal" value="${esc(st.depositMon)}"></label>
          </div>
          <p class="field-hint">Every bidder locks the biggest-bid amount while bidding, so nobody can tell bids apart; they get back everything they don't spend.</p>
          <p class="label-row">Bidding stays open for</p>
          <div class="seg" role="radiogroup" aria-label="Bidding window">
            ${Object.entries(DURATIONS).map(([k, d]) => `<button type="button" role="radio" data-duration="${k}">${esc(d.label)}</button>`).join("")}
          </div>
          <p class="field-hint" style="margin-top:8px">Then the same time again for bidders to reveal.</p>
        </div></section>

        <section class="panel"><div class="panel-in">
          <h2 class="panel-title"><span class="step-no">3</span> The pool</h2>
          <div class="fields">
            <label>Share of the raise that goes into the pool (%)<input id="s-lp" inputmode="decimal" value="${esc(st.lpPct)}"></label>
            <label class="raise-only hidden">Pool lock (days, at least 30)<input id="s-lock" inputmode="numeric" value="${esc(st.lockDays)}"></label>
          </div>
          <p class="field-hint" id="s-pool-hint"></p>
        </div></section>
        <p class="note" style="margin-top:4px"><a href="#/host/advanced">Advanced launch</a>: allowlist, vesting, tick size, several DEXs, and your past rounds.</p>
      </div>

      <div class="col">
        <section class="panel panel-p2" style="position:sticky;top:96px"><div class="panel-in">
          <h2 class="panel-title">Press start</h2>
          <div id="s-summary"></div>
          <div id="s-steps"></div>
          <div class="btn-row"><button type="button" class="btn btn-start btn-lg" id="s-launch">Launch</button></div>
          <p class="msg" id="s-msg" role="status" aria-live="polite"></p>
        </div></section>
      </div>
    </div>
  </section>`;

  const $ = (q) => el.querySelector(q);
  const say = (t, k = "") => { const m = $("#s-msg"); m.className = `msg ${k}`; m.textContent = t; };
  const draft = () => (app.account ? lsGet(draftKey()) : null);

  function syncSeg(attr, value) {
    el.querySelectorAll(`[data-${attr}]`).forEach((b) => b.setAttribute("aria-checked", String(b.dataset[attr] === value)));
  }

  // ── token ──
  async function loadToken(addr) {
    if (!isAddress(addr)) { token = null; return; }
    try {
      const [decimals, symbol, totalSupply] = await Promise.all([
        eng.erc20.decimals(addr), eng.erc20.symbol(addr).catch(() => "TOKEN"), eng.erc20.totalSupply(addr),
      ]);
      let balance = null, allowance = null;
      if (app.account) [balance, allowance] = await Promise.all([eng.erc20.balanceOf(addr, app.account), eng.erc20.allowance(addr, app.account, eng.address)]);
      token = { address: addr, decimals: Number(decimals), symbol, totalSupply, balance, allowance };
    } catch { token = null; }
  }

  // Inputs for simple.js. A new token is 18 decimals with the supply typed here.
  function wizard() {
    const usingDraft = st.mode === "new" && draft()?.token;
    let decimals = 18, supply = 0n;
    if (st.mode === "existing" || usingDraft) {
      decimals = token?.decimals ?? 18;
      supply = token?.totalSupply ?? 0n;
    } else {
      try { supply = /^\d+$/.test(st.supply.replace(/[,_\s]/g, "")) ? BigInt(st.supply.replace(/[,_\s]/g, "")) * 10n ** 18n : 0n; } catch { supply = 0n; }
    }
    const w = simpleLaunchForm({
      preset: st.preset, supply, sellPct: st.sellPct, floorMon: st.floorMon, depositMon: st.depositMon,
      duration: st.duration, lpPct: st.lpPct, lockDays: st.lockDays,
      adapter: net.deployment.adapter ?? "", fee: cfg.creatorDefaults.dexFee,
    }, decimals);
    const p = [...w.problems];
    if (st.mode === "new" && !usingDraft) p.push(...newTokenProblems(st.name, st.symbol.trim().toUpperCase(), st.supply.replace(/[,_\s]/g, "")).problems);
    if (st.mode === "existing" && !token) p.push(st.address ? "Can't read that token on this network." : "Paste your token's address.");
    if (!net.deployment.adapter) p.push(`No DEX adapter configured for ${net.label}.`);
    return { w, problems: [...new Set(p)], decimals, symbol: usingDraft ? token?.symbol : (st.mode === "new" ? st.symbol.trim().toUpperCase() || "TOKEN" : token?.symbol ?? "TOKEN") };
  }

  function render() {
    if (dead) return;
    syncSeg("mode", st.mode); syncSeg("preset", st.preset); syncSeg("duration", st.duration);
    const d = draft();
    const usingDraft = st.mode === "new" && d?.token;
    $("#tok-new").classList.toggle("hidden", st.mode !== "new" || !!usingDraft);
    $("#tok-existing").classList.toggle("hidden", st.mode !== "existing");
    $("#tok-draft").innerHTML = usingDraft
      ? `<div class="ticket" style="margin-top:16px"><p class="ticket-line">${esc(d.symbol)} is ready</p>
          <p>You made it earlier: <span class="mono">${esc(d.token)}</span>. The next launch uses it.</p>
          <button type="button" class="btn btn-sm" id="s-draft-clear">Make a different token</button></div>` : "";
    $("#s-draft-clear")?.addEventListener("click", () => { lsSet(draftKey(), null); token = null; render(); });
    el.querySelectorAll(".raise-only").forEach((n) => n.classList.toggle("hidden", st.preset !== "Raise"));
    $("#s-token-info").textContent = st.mode === "existing" && token
      ? `${token.symbol}, supply ${formatUnits(token.totalSupply, token.decimals, 0)}${token.balance != null ? `, you hold ${formatUnits(token.balance, token.decimals, 2)}` : ""}` : "";

    const { w, problems, decimals, symbol } = wizard();
    const D = w.derived;
    const lpOn = w.form.lpOn;
    $("#s-pool-hint").textContent = st.preset === "Degen"
      ? `Required for Degen. The pool gets ${st.lpPct || 0}% of the MON raised plus matching tokens, opens at the final price on Uniswap, and is locked forever with GoPlus. You keep the trading fees.`
      : lpOn ? `The pool opens at the final price and stays locked for ${st.lockDays || "?"} days. Set 0% for no pool.` : "No pool: you get all the MON raised.";

    const tok = (u) => fmtTokens(u, decimals, symbol, 2);
    const okNumbers = D.sellAmount > 0n && D.reserveWire > 0n;
    $("#s-summary").innerHTML = okNumbers ? `
      <dl class="readout">
        <dt>You sell</dt><dd>${esc(tok(D.sellAmount))}</dd>
        <dt>Floor price</dt><dd>${esc(fmtMon(D.reservePerToken, 12))} per token</dd>
        <dt>Value at the floor</dt><dd>${esc(fmtMon(D.floorMcap, 2))} for the whole supply</dd>
        <dt>Bidding</dt><dd>${esc(DURATIONS[st.duration].label)}, then ${esc(DURATIONS[st.duration].label)} to reveal</dd>
        <dt>Pool</dt><dd>${lpOn ? `${esc(st.lpPct)}% of the raise, locked ${st.preset === "Degen" ? "forever" : `${esc(st.lockDays)} days`}` : "none"}</dd>
      </dl>
      <p class="field-hint">Selling out at the floor takes about <strong>${esc(String(D.fullBidsToSellOut))}</strong> maxed-out bids of ${esc(fmtMon(D.deposit, 4))}. ${D.fullBidsToSellOut > 20n ? "For a small group, raise the biggest bid or lower the floor." : ""} Unsold tokens are ${st.preset === "Degen" ? "burned" : "returned to you"}.</p>` : "";
    $("#s-steps").innerHTML = steps ? `<ol class="run-steps">${steps.map((s) => `<li data-state="${s.state}">${esc(s.label)}</li>`).join("")}</ol>` : "";
    const problemList = problems.length ? `<ul class="problems" style="margin-bottom:12px">${problems.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>` : "";
    $("#s-summary").insertAdjacentHTML("beforeend", problemList);
    const b = $("#s-launch");
    b.disabled = busy || !!problems.length || !app.account;
    b.textContent = !app.account ? "Connect a wallet or passkey to launch" : busy ? "Launching…" : "Launch";
  }

  // ── wiring ──
  el.querySelectorAll("[data-mode]").forEach((b) => b.addEventListener("click", async () => { st.mode = b.dataset.mode; if (st.mode === "new" && draft()?.token) await loadToken(draft().token); render(); }));
  el.querySelectorAll("[data-preset]").forEach((b) => b.addEventListener("click", () => { st.preset = b.dataset.preset; render(); }));
  el.querySelectorAll("[data-duration]").forEach((b) => b.addEventListener("click", () => { st.duration = b.dataset.duration; render(); }));
  const bind = (id, key) => $(id).addEventListener("input", (e) => { st[key] = e.target.value; render(); });
  bind("#s-name", "name"); bind("#s-symbol", "symbol"); bind("#s-supply", "supply");
  bind("#s-sell", "sellPct"); bind("#s-floor", "floorMon"); bind("#s-deposit", "depositMon"); bind("#s-lp", "lpPct"); bind("#s-lock", "lockDays");
  $("#s-address").addEventListener("change", async (e) => { st.address = e.target.value.trim(); await loadToken(st.address); render(); });

  $("#s-launch").addEventListener("click", async () => {
    if (busy) return;
    busy = true; say("");
    const createNew = st.mode === "new" && !draft()?.token;
    steps = [
      ...(createNew ? [{ id: "create", label: `Create ${st.symbol.trim().toUpperCase() || "the token"}`, state: "todo" }] : []),
      { id: "approve", label: "Let the auction hold the tokens on sale", state: "todo" },
      { id: "open", label: "Open the round", state: "todo" },
    ];
    const mark = (id, state) => { const s = steps.find((x) => x.id === id); if (s) s.state = state; render(); };
    render();
    try {
      if (app.walletChainId !== net.chainId) throw new Error(`Switch your wallet to ${net.label}.`);
      // 1. token
      let addr = st.mode === "existing" ? st.address : draft()?.token;
      if (createNew) {
        mark("create", "active");
        const { supply } = newTokenProblems(st.name, st.symbol.trim().toUpperCase(), st.supply.replace(/[,_\s]/g, ""));
        const rc = await sendTx(app.account, createTokenTx(net.deployment.tokenFactory, st.name.trim(), st.symbol.trim().toUpperCase(), supply));
        addr = createdToken(rc, net.deployment.tokenFactory);
        if (!addr) throw new Error("The token was created, but its address was not in the receipt.");
        lsSet(draftKey(), { token: addr, symbol: st.symbol.trim().toUpperCase() });
        mark("create", "done");
      }
      await loadToken(addr);
      if (!token) throw new Error("Can't read the token.");
      // 2. parameters, computed right before opening
      await syncClock();
      const { w } = wizard();
      const { params, problems, need } = buildOpenParams(w.form, token, chainNow());
      if (problems.length) throw new Error(problems[0]);
      if (token.balance != null && token.balance < need) throw new Error(`You need ${fmtTokens(need, token.decimals, token.symbol)}; your wallet holds ${fmtTokens(token.balance, token.decimals, token.symbol)}.`);
      // 3. approve, skipped when the allowance already covers it
      mark("approve", "active");
      if (token.allowance == null || token.allowance < need) await sendTx(app.account, eng.erc20.approveTx(token.address, eng.address, need));
      mark("approve", "done");
      // 4. open
      mark("open", "active");
      const rc = await sendTx(app.account, eng.tx.openRound(params));
      const id = eng.decodeReceiptLogs(rc).find((x) => x.event === "RoundOpened")?.args.roundId;
      mark("open", "done");
      if (st.mode === "new") lsSet(draftKey(), null);
      const m = $("#s-msg");
      m.className = "msg ok";
      m.innerHTML = id != null ? `Round ${id} is open. <a href="#/round/${id}">Go to the round</a> and share the link.` : "Round opened.";
    } catch (e) {
      const s = steps.find((x) => x.state === "active");
      if (s) s.state = "failed";
      say(`${e.message} Press Launch again to continue from this step.`, "err");
    } finally {
      busy = false;
      render();
    }
  });

  (async () => {
    if (draft()?.token) await loadToken(draft().token);
    render();
  })();
  return {
    cleanup() { dead = true; },
    async onAccount() { token = null; if (st.mode === "existing") await loadToken(st.address); else if (draft()?.token) await loadToken(draft().token); render(); },
  };
}

