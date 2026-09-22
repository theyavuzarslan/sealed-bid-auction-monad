// App shell: marquee header (network + wallet), hash router, cabinet settings.
import cfg from "../config.js";
import { hasWallet, connectWallet, currentAccount, walletChainId, switchChain, onWalletEvents } from "./wallet.js";
import { network, networkName, setNetworkName, loadDeployment, setDeploymentOverride } from "./net.js";
import { renderHome } from "./screens/home.js";
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
  if (!hasWallet()) wallet = `<span class="note" style="color:var(--purple-glow)">No browser wallet</span>`;
  else if (!app.account) wallet = `<button class="btn btn-coin" id="connect-btn" type="button">Connect wallet</button>`;
  else if (app.walletChainId !== net.chainId) wallet = `<button class="btn btn-coin" id="switch-btn" type="button">Switch to ${esc(net.label)}</button>`;
  else wallet = `<span class="account" title="${esc(app.account)}">${esc(short(app.account))}</span>`;
  area.innerHTML = `<select id="net-select" aria-label="Network">${opts}</select>${wallet}`;
  area.querySelector("#net-select").addEventListener("change", async (e) => {
    setNetworkName(e.target.value);
    await loadDeployment();
    renderHeader();
    renderSettings();
    route();
  });
  const fail = (err) => area.insertAdjacentHTML("beforeend", `<span class="err" style="color:var(--berry-lamp)">${esc(err.message)}</span>`);
  area.querySelector("#connect-btn")?.addEventListener("click", async () => {
    try {
      app.account = await connectWallet();
      app.walletChainId = await walletChainId();
      renderHeader();
      screen?.onAccount?.();
    } catch (err) { fail(err); }
  });
  area.querySelector("#switch-btn")?.addEventListener("click", async () => {
    try { await switchChain(net); } catch (err) { fail(err); }
  });
}

function renderSettings() {
  const net = network();
  const box = document.querySelector("#settings-body");
  box.innerHTML = `<div class="panel panel-dark"><div class="panel-in">
    <dl class="readout" style="--ink-soft: var(--purple-glow)">
      <dt>Network</dt><dd>${esc(net.label)} (chain ${net.chainId})</dd>
      <dt>Read RPC</dt><dd>${esc(net.rpcUrl ?? "through the connected wallet")}</dd>
      <dt>Engine</dt><dd class="mono">${esc(net.deployment.auctionEngine ?? "not set")}</dd>
      <dt>Addresses from</dt><dd>${esc(net.source)}</dd>
    </dl>
    <label for="dep-json" style="color:var(--purple-glow)">Use another deployment (the shape of contracts/deployments/local.json; kept in this browser only)</label>
    <textarea id="dep-json" rows="5" style="margin-top:8px" placeholder='{"auctionEngine":"0x…","token":"0x…","adapter":"0x…","positionManager":"0x…","locker":"0x…"}'></textarea>
    <div class="btn-row" style="margin-top:12px">
      <button class="btn btn-start btn-sm" id="dep-save" type="button">Use this deployment</button>
      <button class="btn btn-sm" id="dep-clear" type="button">Back to defaults</button>
    </div>
    <p class="msg" id="dep-msg"></p>
  </div></div>`;
  box.querySelector("#dep-save").addEventListener("click", () => {
    try {
      setDeploymentOverride(box.querySelector("#dep-json").value);
      renderSettings();
      route();
    } catch (err) {
      const m = box.querySelector("#dep-msg"); m.className = "msg err"; m.textContent = err.message;
    }
  });
  box.querySelector("#dep-clear").addEventListener("click", () => { setDeploymentOverride(null); renderSettings(); route(); });
}

function setNav(key) {
  document.querySelectorAll("[data-nav]").forEach((a) => {
    if (a.dataset.nav === key) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
}

function route() {
  const view = document.querySelector("#view");
  screen?.cleanup?.();
  screen = null;
  view.innerHTML = "";
  const hash = location.hash || "#/";
  let m;
  try {
    if (/^#\/(host|creator)$/.test(hash)) { setNav("host"); screen = renderCreator(view, app); }
    else if ((m = hash.match(/^#\/round\/(\d+)$/))) { setNav("play"); screen = renderRound(view, app, m[1]); }
    else if (hash === "#/play") { setNav("play"); screen = renderHome(view, { scrollTo: "play" }); }
    else if (hash === "#/how") { setNav("how"); screen = renderHome(view, { scrollTo: "how" }); }
    else { setNav(null); screen = renderHome(view); }
  } catch (err) {
    view.innerHTML = `<section class="page"><div class="panel"><div class="panel-in"><p class="err">${esc(err.message)}</p></div></div></section>`;
  }
  if (!/^#\/(play|how)$/.test(hash)) window.scrollTo(0, 0);
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
  renderSettings();
  route();
})();
