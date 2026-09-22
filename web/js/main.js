// App shell: network + wallet header, hash router, home screen.
import cfg from "../config.js";
import { hasWallet, connectWallet, currentAccount, walletChainId, switchChain, onWalletEvents } from "./wallet.js";
import { network, networkName, setNetworkName, loadDeployment, setDeploymentOverride, engine } from "./net.js";
import { renderCreator } from "./screens/creator.js";
import { renderRound } from "./screens/round.js";
import { commitHash } from "./bid.js";
import { esc, short } from "./format.js";

const app = { account: null, walletChainId: null };
let screen = null;

function renderHeader() {
  const net = network();
  const area = document.querySelector("#wallet-area");
  const opts = Object.entries(cfg.networks)
    .map(([k, n]) => `<option value="${k}" ${k === networkName() ? "selected" : ""}>${esc(n.label)}</option>`).join("");
  let wallet;
  if (!hasWallet()) wallet = `<span class="hint">No browser wallet found</span>`;
  else if (!app.account) wallet = `<button class="btn" id="connect-btn">Connect wallet</button>`;
  else if (app.walletChainId !== net.chainId) wallet = `<button class="btn warn-btn" id="switch-btn">Switch to ${esc(net.label)}</button> <span class="account mono">${esc(short(app.account))}</span>`;
  else wallet = `<span class="account mono" title="${esc(app.account)}">${esc(short(app.account))}</span>`;
  area.innerHTML = `<select id="net-select" aria-label="Network">${opts}</select> ${wallet}`;
  area.querySelector("#net-select").addEventListener("change", async (e) => {
    setNetworkName(e.target.value);
    await loadDeployment();
    renderHeader();
    route();
  });
  area.querySelector("#connect-btn")?.addEventListener("click", async () => {
    try {
      app.account = await connectWallet();
      app.walletChainId = await walletChainId();
      renderHeader();
      screen?.onAccount?.();
    } catch (err) {
      area.insertAdjacentHTML("beforeend", ` <span class="err">${esc(err.message)}</span>`);
    }
  });
  area.querySelector("#switch-btn")?.addEventListener("click", async () => {
    try {
      await switchChain(net);
    } catch (err) {
      area.insertAdjacentHTML("beforeend", ` <span class="err">${esc(err.message)}</span>`);
    }
  });
}

async function renderHome(el) {
  const net = network();
  const eng = engine();
  el.innerHTML = `
  <section class="wrap">
    <h1>Sealed-bid launches on Monad</h1>
    <p class="lede">Everyone who wins pays one clearing price. Bids are sealed until the reveal window, then the round clears in one step.</p>
    <p class="taglines"><span>Snipe-resistant: submission timing no longer determines price</span><span>Privacy via commit-reveal</span></p>
    <div class="card">
      <h2>Go to a round</h2>
      <form id="goto-form" class="round-goto">
        <input id="round-id" placeholder="Round id" inputmode="numeric">
        <button class="btn primary" type="submit">Open round</button>
      </form>
      <div id="recent"></div>
    </div>
    <div class="card">
      <h2>Launch a token</h2>
      <p><a href="#/creator">Open a launch</a>: lock supply and start a Degen or Raise round.</p>
    </div>
    <div class="card">
      <h2>Network</h2>
      <dl class="kv">
        <dt>Network</dt><dd>${esc(net.label)} (chain ${net.chainId})</dd>
        <dt>Read RPC</dt><dd>${esc(net.rpcUrl ?? "through the connected wallet")}</dd>
        <dt>AuctionEngine</dt><dd class="mono">${esc(net.deployment.auctionEngine ?? "not set")}</dd>
        <dt>Addresses from</dt><dd>${esc(net.source)}</dd>
      </dl>
      <details>
        <summary>Use another deployment</summary>
        <p class="hint">Paste a deployments JSON (the shape of contracts/deployments/local.json). It is kept in this browser only.</p>
        <textarea id="dep-json" rows="6" placeholder='{"auctionEngine":"0x…","token":"0x…","adapter":"0x…","positionManager":"0x…","locker":"0x…"}'></textarea>
        <div class="row"><button class="btn" id="dep-save">Use this deployment</button><button class="btn" id="dep-clear">Back to defaults</button></div>
        <p class="msg" id="dep-msg"></p>
      </details>
    </div>
  </section>`;
  el.querySelector("#goto-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const v = el.querySelector("#round-id").value.trim();
    if (/^\d+$/.test(v)) location.hash = `#/round/${v}`;
  });
  el.querySelector("#dep-save").addEventListener("click", () => {
    try {
      setDeploymentOverride(el.querySelector("#dep-json").value);
      route();
    } catch (err) {
      el.querySelector("#dep-msg").textContent = err.message;
    }
  });
  el.querySelector("#dep-clear").addEventListener("click", () => { setDeploymentOverride(null); route(); });

  if (!eng) return;
  try {
    const count = Number(await eng.roundCount());
    const ids = Array.from({ length: Math.min(count, 10) }, (_, i) => count - i);
    if (!ids.length) { el.querySelector("#recent").innerHTML = `<p class="hint">No rounds yet on this engine.</p>`; return; }
    el.querySelector("#recent").innerHTML = `<h3>Recent rounds</h3><ul class="plain">${ids.map((i) => `<li><a href="#/round/${i}">Round ${i}</a></li>`).join("")}</ul>`;
  } catch (err) {
    el.querySelector("#recent").innerHTML = `<p class="warn">Could not read the engine: ${esc(err.message)}</p>`;
  }
}

function route() {
  const view = document.querySelector("#view");
  screen?.cleanup?.();
  screen = null;
  view.innerHTML = "";
  const hash = location.hash || "#/";
  let m;
  try {
    if (/^#\/creator$/.test(hash)) screen = renderCreator(view, app);
    else if ((m = hash.match(/^#\/round\/(\d+)$/))) screen = renderRound(view, app, m[1]);
    else renderHome(view);
  } catch (err) {
    view.innerHTML = `<section class="wrap"><div class="card"><p class="err">${esc(err.message)}</p></div></section>`;
  }
}

// ── boot ──
try {
  // Known-answer check of the money-path hash against a Foundry `cast` vector (see selftest.mjs).
  const h = commitHash(10n ** 18n, 5n * 10n ** 18n, "0x0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20", "0x1111111111111111111111111111111111111111");
  if (h !== "0xbac85ead30c48ac268dc15b0ea6690d6820fb338cd2eafe6362851176f932550") throw new Error("commit hash self-check mismatch");
} catch (err) {
  document.body.insertAdjacentHTML("afterbegin", `<div class="boot-err">Self-check failed, do not bid from this page: ${esc(err.message)}</div>`);
}

onWalletEvents(
  (acct) => { app.account = acct; renderHeader(); screen?.onAccount?.(); },
  (id) => { app.walletChainId = id; renderHeader(); screen?.onAccount?.(); },
);
window.addEventListener("hashchange", route);

(async () => {
  await loadDeployment();
  app.account = await currentAccount().catch(() => null);
  app.walletChainId = await walletChainId().catch(() => null);
  renderHeader();
  route();
})();
