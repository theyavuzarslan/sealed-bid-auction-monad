// Screen 1 — Creator: open a launch (08-ui-notes.md).
import cfg from "../../config.js";
import { encodeOpenRound, encodeApprove, encodeAllowance } from "../abi.js";
import { connectWallet, getChainId, ethCall, sendAndWait } from "../wallet.js";
import { findRoundOpenedInReceipt } from "../chain.js";
import { keccak256Hex } from "../commitHash.js";

const UINT96_MAX = 2n ** 96n - 1n;

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function parseAmount(str, decimals) {
  const t = String(str).trim();
  if (!/^\d+(\.\d+)?$/.test(t)) throw new Error(`"${t}" is not a number`);
  const [whole, frac = ""] = t.split(".");
  if (frac.length > decimals) throw new Error("Too many decimal places");
  return BigInt(whole + frac.padEnd(decimals, "0"));
}

function parseAddress(str, label) {
  const t = String(str).trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(t)) throw new Error(`${label}: not an address`);
  return t;
}

// TODO: not specified (Q7) — allowlist format and root derivation are not defined in
// the docs. Placeholder: keccak256 over sorted, unique, lowercase addresses joined
// by newlines. Isolated here so the contract side can align the format later.
function deriveAllowlistRoot(addresses) {
  const joined = [...new Set(addresses.map((a) => a.toLowerCase()))].sort().join("\n");
  return keccak256Hex(new TextEncoder().encode(joined));
}

function parseAllowlistFile(text) {
  const addresses = text
    .split(/\r?\n|,/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));
  const valid = addresses.filter((a) => /^0x[0-9a-fA-F]{40}$/.test(a));
  return { valid, invalid: addresses.length - valid.length };
}

function windowSeconds(value, unit) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new Error("Window lengths must be positive");
  return BigInt(Math.round(n * (unit === "hours" ? 3600 : 60)));
}

export function renderCreator(el, state) {
  let preset = "Degen";
  el.innerHTML = `
  <section class="wrap">
    <h1>Open a launch</h1>
    <p class="lede">Your community shouldn't lose its own launch to three bots in the first block — everyone pays the same price, nobody gets a head start.</p>
    <p class="sub">Snipe-resistant: submission timing no longer determines price</p>

    <div class="card">
      <h2>Preset</h2>
      <div class="preset-row">
        <button type="button" class="preset-card selected" id="preset-degen">
          <strong>Degen</strong>
          <span>Minutes-scale windows · no allowlist · no vesting · auto-LP on</span>
        </button>
        <button type="button" class="preset-card" id="preset-raise">
          <strong>Raise</strong>
          <span>Hours–days · allowlist · vesting · optional auto-LP</span>
        </button>
      </div>
    </div>

    <form class="card" id="open-form">
      <h2>Round parameters</h2>
      <div class="grid2">
        <label>Token (auctioning token address)
          <input id="f-token" placeholder="0x…" required>
        </label>
        <label>Bidding token address
          <span class="hint">TODO (Q9): bidding token choice is unresolved; the deposit is sent as native value.</span>
          <input id="f-bidtoken" placeholder="0x…" required>
        </label>
        <label>Supply to lock
          <span class="hint">Token units; must stay under 2^96 wei (EasyAuction constraint).</span>
          <input id="f-supply" placeholder="e.g. 1000000000" required>
        </label>
        <label>Uniform deposit (native MON)
          <span class="hint">Everyone locks the same amount — larger than the maximum allowed bid.</span>
          <input id="f-deposit" placeholder="e.g. 5" required>
        </label>
        <label>Commit window
          <input id="f-commitwin" placeholder="30" required>
          <select id="f-commitunit"><option value="minutes">minutes</option><option value="hours">hours</option></select>
        </label>
        <label>Reveal window
          <input id="f-revealwin" placeholder="10" required>
          <select id="f-revealunit"><option value="minutes">minutes</option><option value="hours">hours</option></select>
        </label>
        <label>Minimum bid size (bidding-token units)
          <span class="hint">Required — the defense against gas DoS via dust commits.</span>
          <input id="f-minbid" placeholder="e.g. 0.1" required>
        </label>
        <label class="check">
          <input type="checkbox" id="f-autolp" checked>
          Auto-LP on settle (pool proceeds + remaining supply, LP locked)
        </label>
      </div>

      <div id="raise-only" class="hidden">
        <h3>Raise preset</h3>
        <label>Allowlist upload
          <span class="hint">One address per line (.txt/.csv). TODO (Q7): format and root derivation not specified.</span>
          <input type="file" id="f-allowlist" accept=".txt,.csv">
        </label>
        <div id="allowlist-info" class="hint"></div>
        <div class="grid2">
          <label>Vesting cliff (days)
            <span class="hint">TODO (Q7): vesting schedule shape not found in source; collected, not yet submitted onchain.</span>
            <input id="f-cliff" placeholder="0">
          </label>
          <label>Vesting duration (days)
            <span class="hint">TODO (Q7): not part of the proposed openRound surface yet.</span>
            <input id="f-vestdur" placeholder="180">
          </label>
        </div>
      </div>

      <div id="creator-msg" class="msg" role="status"></div>
      <button type="submit" class="btn primary" id="open-btn">Lock supply and open round</button>
    </form>
  </section>`;

  const $ = (id) => el.querySelector("#" + id);
  const degen = $("preset-degen"), raise = $("preset-raise"), raiseOnly = $("raise-only");
  const autoLp = $("f-autolp"), msg = $("creator-msg");

  function setPreset(p) {
    preset = p;
    degen.classList.toggle("selected", p === "Degen");
    raise.classList.toggle("selected", p === "Raise");
    raiseOnly.classList.toggle("hidden", p !== "Raise");
    // TODO: not specified — Raise auto-LP default (preset table says "Optional").
    autoLp.checked = p === "Degen";
  }
  degen.addEventListener("click", () => setPreset("Degen"));
  raise.addEventListener("click", () => setPreset("Raise"));

  let allowlistAddresses = [];
  $("f-allowlist").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const { valid, invalid } = parseAllowlistFile(await file.text());
    allowlistAddresses = valid;
    $("allowlist-info").textContent = valid
      ? `${valid.length} addresses loaded${invalid ? ` (${invalid} invalid lines skipped)` : ""}`
      : "";
  });

  $("open-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    msg.className = "msg";
    msg.textContent = "";
    try {
      if (!cfg.sealingLayerAddress) throw new Error("Sealing layer address not configured (web/config.js) — TODO: set after testnet deploy");
      const account = state.account ?? (await connectWallet());
      if (!state.account) {
        state.account = account;
        state.refreshHeader?.();
      }
      const chainId = await getChainId();
      if (cfg.chainId && chainId !== cfg.chainId) throw new Error(`Wrong chain (have ${chainId}, expect ${cfg.chainId})`);

      const token = parseAddress($("f-token").value, "Token");
      const biddingToken = parseAddress($("f-bidtoken").value, "Bidding token");
      const supplyWei = parseAmount($("f-supply").value, cfg.tokenDecimals);
      if (supplyWei <= 0n || supplyWei > UINT96_MAX) throw new Error("Supply to lock must be in (0, 2^96] wei");
      const depositWei = parseAmount($("f-deposit").value, cfg.nativeDecimals);
      if (depositWei <= 0n) throw new Error("Uniform deposit must be positive");
      const minBidWei = parseAmount($("f-minbid").value, cfg.biddingTokenDecimals);
      if (minBidWei <= 0n) throw new Error("Minimum bid size is required");
      const commitEnd = BigInt(Math.floor(Date.now() / 1000)) + windowSeconds($("f-commitwin").value, $("f-commitunit").value);
      const revealEnd = commitEnd + windowSeconds($("f-revealwin").value, $("f-revealunit").value);

      let allowlistRoot = "0x" + "0".repeat(64);
      if (preset === "Raise") {
        if (!allowlistAddresses.length) throw new Error("Raise preset requires an allowlist upload");
        allowlistRoot = deriveAllowlistRoot(allowlistAddresses);
      }

      const params = {
        preset: preset === "Degen" ? 0 : 1,
        auctioningToken: token,
        biddingToken,
        sellAmount: supplyWei,
        minBidSize: minBidWei,
        depositAmount: depositWei,
        commitEnd,
        revealEnd,
        allowlistRoot,
        autoLP: autoLp.checked,
      };

      const btn = $("open-btn");
      btn.disabled = true;
      const allowanceHex = await ethCall({ from: account, to: token, data: encodeAllowance(account, cfg.sealingLayerAddress) });
      if (BigInt(allowanceHex || "0x0") < supplyWei) {
        msg.textContent = "Approving token supply…";
        await sendAndWait({ from: account, to: token, data: encodeApprove(cfg.sealingLayerAddress, supplyWei) });
      }
      msg.textContent = "Locking supply and opening round…";
      const receipt = await sendAndWait({ from: account, to: cfg.sealingLayerAddress, data: encodeOpenRound(params) });
      const opened = findRoundOpenedInReceipt(receipt);
      msg.className = "msg ok";
      msg.innerHTML = opened
        ? `Round <a href="#/round/${opened.roundId}">#${opened.roundId}</a> opened — commit window is live.`
        : `Round opened. TODO: RoundOpened event not found in receipt — the round id is not yet readable from the UI.`;
    } catch (err) {
      msg.className = "msg err";
      msg.textContent = err.message;
    } finally {
      $("open-btn").disabled = false;
    }
  });
}
