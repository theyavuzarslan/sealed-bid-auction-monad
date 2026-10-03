// App shell: marquee header (network + wallet), hash router, cabinet settings.
import cfg from "../config.js";
import { hasWallet, hasInjectedWallet, connectWallet, currentAccount, walletChainId, switchChain, onWalletEvents, setProvider, usingPasskey } from "./wallet.js";
import { passkeySupported, hasStoredPasskey, connectPasskey } from "./passkey-wallet.js";
import { network, networkName, setNetworkName, loadDeployment, setDeploymentOverride } from "./net.js";
import { renderHome } from "./screens/home.js";
import { renderCreator } from "./screens/creator.js";
import { renderRound } from "./screens/round.js";
import { commitHash } from "./bid.js";
import { esc, short } from "./format.js";

const app = { account: null, walletChainId: null };
let passkey = null; // {address, mnemonic(), end()} while signed in with a passkey
let screen = null;

function renderHeader() {
  const net = network();
  const area = document.querySelector("#wallet-area");
  const opts = Object.entries(cfg.networks)
    .map(([k, n]) => `<option value="${k}" ${k === networkName() ? "selected" : ""}>${esc(n.label)}</option>`).join("");
  let wallet;
  const pk = passkeySupported() && net.rpcUrl ? `<button class="btn btn-ghost btn-sm" id="passkey-btn" type="button">Passkey</button>` : "";
  if (usingPasskey()) wallet = `<button class="account account-btn" id="passkey-account" type="button" title="${esc(app.account)}">${esc(short(app.account))}<small>passkey</small></button>`;
  else if (!hasWallet()) wallet = pk || `<span class="note" style="color:var(--purple-glow)">No browser wallet</span>`;
  else if (!app.account) wallet = `${pk}<button class="btn btn-coin" id="connect-btn" type="button">Connect wallet</button>`;
  else if (app.walletChainId !== net.chainId) wallet = `<button class="btn btn-coin" id="switch-btn" type="button">Switch to ${esc(net.label)}</button>`;
  else wallet = `<span class="account" title="${esc(app.account)}">${esc(short(app.account))}</span>`;
  area.innerHTML = `<select id="net-select" aria-label="Network">${opts}</select>${wallet}`;
  area.querySelector("#net-select").addEventListener("change", async (e) => {
    if (passkey) { passkey.end(); passkey = null; setProvider(null); app.account = null; } // a passkey provider is bound to one network
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
  area.querySelector("#passkey-btn")?.addEventListener("click", () => openPasskey());
  area.querySelector("#passkey-account")?.addEventListener("click", () => openPasskey());
}

// ── passkey sign-in (Mera) ──
function passkeyDialog() {
  let d = document.querySelector("#passkey-dialog");
  if (!d) {
    d = document.createElement("dialog");
    d.id = "passkey-dialog";
    d.className = "passkey-dialog";
    d.setAttribute("aria-labelledby", "passkey-title");
    d.addEventListener("click", (e) => { if (e.target === d) d.close(); });
    document.body.appendChild(d);
  }
  return d;
}

async function balanceOf(addr) {
  try {
    const { readRequest } = await import("./net.js");
    return BigInt(await readRequest("eth_getBalance", [addr, "latest"]));
  } catch { return null; }
}

async function openPasskey() {
  const d = passkeyDialog();
  const net = network();
  const fmt = (wei) => (wei == null ? "?" : `${(Number(wei) / 1e18).toLocaleString(undefined, { maximumFractionDigits: 4 })} MON`);
  const shell = (body) => `<div class="panel"><div class="panel-in">
      <h2 class="panel-title" id="passkey-title">${passkey ? "Your passkey account" : "Sign in with a passkey"}</h2>${body}
      <p class="msg" id="pk-msg" role="status"></p>
      <div class="btn-row" style="margin-top:8px"><button class="btn btn-sm" type="button" data-pk="close">Close</button></div>
    </div></div>`;
  if (!passkey) {
    d.innerHTML = shell(`
      <p>Face ID, Touch ID or a security key makes you an ordinary ${esc(net.label)} account. No extension, no seed phrase to write down, and the same passkey opens it on any device it syncs to.</p>
      ${hasStoredPasskey()
        ? `<div class="btn-row">
            <button class="btn btn-start" type="button" data-pk="signin">Sign in</button>
            <button class="btn btn-panel" type="button" data-pk="create">Create another account</button>
          </div>
          <p class="field-hint" style="margin-top:10px">"Create another account" makes a new, empty address. To reach the account you already funded, use Sign in.</p>`
        : `<div class="btn-row">
            <button class="btn btn-start" type="button" data-pk="create">Create a passkey account</button>
            <button class="btn btn-panel" type="button" data-pk="signin">I already have one</button>
          </div>
          <p class="field-hint" style="margin-top:10px">Each new passkey is a new account. Accounts belong to this site's address (${esc(location.hostname)}).</p>`}
      <p class="field-hint" style="margin-top:12px">Powered by Mera from Category Labs. Your key is derived on this device and never leaves it.</p>`);
  } else {
    const bal = await balanceOf(passkey.address);
    d.innerHTML = shell(`
      <dl class="readout">
        <dt>Address</dt><dd class="mono" style="word-break:break-all">${esc(passkey.address)}</dd>
        <dt>Balance</dt><dd>${esc(fmt(bal))}</dd>
      </dl>
      <p>To bid, send MON to this address from an exchange or another wallet. The deposit and a little gas come out of it, and every refund comes back to it.</p>
      <div class="btn-row">
        <button class="btn btn-start btn-sm" type="button" data-pk="copy">Copy address</button>
        <button class="btn btn-panel btn-sm" type="button" data-pk="phrase">Back up recovery phrase</button>
        <button class="btn btn-sm" type="button" data-pk="signout">Sign out</button>
      </div>
      <div id="pk-phrase"></div>`);
  }
  const say = (t, cls = "") => { const m = d.querySelector("#pk-msg"); m.className = `msg ${cls}`; m.textContent = t; };
  d.querySelectorAll("[data-pk]").forEach((b) => b.addEventListener("click", async () => {
    const act = b.dataset.pk;
    if (act === "close") return d.close();
    if (act === "create" || act === "signin") {
      try {
        say(act === "create" ? "Follow your device's passkey prompt…" : "Choose your passkey…");
        const got = await connectPasskey({ mode: act, net });
        passkey = got;
        setProvider(got.provider);
        app.account = got.address.toLowerCase();
        app.walletChainId = net.chainId;
        renderHeader();
        screen?.onAccount?.();
        openPasskey();
      } catch (err) {
        const prf = /prf/i.test(String(err?.message ?? err?.code ?? ""));
        say(prf ? "This browser or authenticator does not support passkey PRF. Try Safari on iOS 18+, Chrome with Google Password Manager, or a browser wallet." : (err?.name === "NotAllowedError" ? "Cancelled." : err.message), "err");
      }
    }
    if (act === "copy") { try { await navigator.clipboard.writeText(passkey.address); say("Address copied.", "ok"); } catch { say(passkey.address); } }
    if (act === "phrase") {
      const box = d.querySelector("#pk-phrase");
      if (box.textContent) { box.innerHTML = ""; return; }
      box.innerHTML = `<p class="warn" style="margin-top:12px">Anyone with these words controls the account. Write them down offline; never paste them into a website or chat.</p>
        <p class="mono phrase">${esc(passkey.mnemonic())}</p>
        <p class="field-hint">They import into MetaMask or Rabby (first account), so your funds never depend on this site.</p>`;
    }
    if (act === "signout") {
      passkey.end();
      passkey = null;
      setProvider(null);
      app.account = await currentAccount().catch(() => null);
      app.walletChainId = await walletChainId().catch(() => null);
      renderHeader();
      screen?.onAccount?.();
      d.close();
    }
  }));
  if (!d.open) d.showModal();
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
