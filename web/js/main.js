// App shell: boot self-check, hash router, wallet header, home screen.
import { selfCheck } from "./commitHash.js";
import { hasWallet, connectWallet, getChainId, onAccountsChanged, onChainChanged } from "./wallet.js";
import { renderCreator } from "./screens/creator.js";
import { renderRound } from "./screens/round.js";
import cfg from "./config.js";

const state = {
  account: null,
  chainId: null,
  refreshHeader: null,
};

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function renderHeader() {
  const area = document.querySelector("#wallet-area");
  if (!hasWallet()) {
    area.innerHTML = `<span class="hint">No injected wallet found — TODO (Q11): wallet library choice is open.</span>`;
    return;
  }
  area.innerHTML = state.account
    ? `<span class="account mono" title="${esc(state.account)}">${esc(state.account.slice(0, 10))}…</span>`
    : `<button class="btn" id="connect-btn">Connect wallet</button>`;
  const btn = area.querySelector("#connect-btn");
  if (btn) {
    btn.addEventListener("click", async () => {
      try {
        state.account = await connectWallet();
        state.chainId = await getChainId();
        renderHeader();
        route();
      } catch (err) {
        area.insertAdjacentHTML("beforeend", `<span class="err">${esc(err.message)}</span>`);
      }
    });
  }
}

function renderHome(el) {
  el.innerHTML = `
  <section class="wrap">
    <h1>Sealed-bid, uniform-price batch auctions on Monad</h1>
    <p class="lede">Replaces first-come-first-served allocation with blind bids that all clear at one price.</p>
    <p class="taglines">
      <span>Snipe-resistant: submission timing no longer determines price</span>
      <span>Privacy via commit-reveal</span>
    </p>
    <div class="card">
      <h2>Go to a round</h2>
      <form id="goto-form" class="round-goto">
        <input id="round-id" placeholder="Round id" inputmode="numeric">
        <button class="btn primary" type="submit">Open round page</button>
      </form>
    </div>
    <div class="card">
      <h2>Create</h2>
      <p><a href="#/creator">Open a launch</a> — lock supply and start a round (Degen or Raise preset).</p>
    </div>
    ${cfg.sealingLayerAddress ? "" : `<p class="hint">Sealing layer address not configured (web/config.js) — screens render, onchain data is unavailable until it is set after deploy.</p>`}
  </section>`;
  el.querySelector("#goto-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const v = el.querySelector("#round-id").value.trim();
    if (/^\d+$/.test(v)) location.hash = `#/round/${v}`;
  });
}

let cleanup = null;

function route() {
  const view = document.querySelector("#view");
  if (cleanup) { cleanup(); cleanup = null; }
  const hash = location.hash || "#/";
  view.innerHTML = "";
  let m;
  if ((m = hash.match(/^#\/creator$/))) {
    renderCreator(view, state);
  } else if ((m = hash.match(/^#\/round\/(\d+)$/))) {
    try {
      cleanup = renderRound(view, state, m[1]);
    } catch (err) {
      view.innerHTML = `<section class="wrap"><div class="card"><span class="err">${esc(err.message)}</span></div></section>`;
    }
  } else {
    renderHome(view);
  }
}

// Boot ---------------------------------------------------------------------------

try {
  selfCheck();
} catch (err) {
  document.body.insertAdjacentHTML("afterbegin",
    `<div class="boot-err">Self-check failed: ${esc(err.message)}</div>`);
}

onAccountsChanged((accts) => {
  state.account = accts[0] ?? null;
  renderHeader();
  route();
});
onChainChanged(() => {
  getChainId().then((id) => { state.chainId = id; });
});

window.addEventListener("hashchange", route);
renderHeader();
route();
