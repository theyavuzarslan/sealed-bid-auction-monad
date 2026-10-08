// Landing — the two-player cabinet. The head-to-head replays the real demo run
// (js/data/demo-results.js, generated from demo/results.json), labelled as such.
import demo from "../data/demo-results.js";
import fair from "../data/fairness.js";
import { engine as getEngine, network } from "../net.js";
import { pixelIcon } from "../ui/pixel.js";
import { esc } from "../format.js";

const W = 460, H = 250, PAD = 30;
const MAX_X = 1150; // tokens: supply 1,000 and total auction demand ~1,142 share one axis
const MAX_Y = 0.5; // MON per token
const X = (v) => PAD + (v / MAX_X) * (W - PAD - 10);
const Y = (v) => H - PAD - (v / MAX_Y) * (H - PAD - 14);
const f3 = (v) => v.toFixed(3);

function axes() {
  const ticks = [0.1, 0.2, 0.3, 0.4].map((p) => `
    <line x1="${PAD}" x2="${W - 10}" y1="${Y(p)}" y2="${Y(p)}" style="stroke:var(--screen-line)" stroke-width="1"/>
    <text x="4" y="${Y(p) + 3}">${p.toFixed(1)}</text>`).join("");
  return `${ticks}
    <line x1="${PAD}" x2="${W - 10}" y1="${Y(0)}" y2="${Y(0)}" style="stroke:var(--screen-dim)" stroke-width="2"/>
    <text x="${W - 10}" y="${H - 8}" text-anchor="end">tokens bought →</text>
    <text x="4" y="12">MON / token</text>`;
}

// Player 1: the bonding curve. Spot price p(x) = vM·vT / (vT − x)², pixel-stepped every 25 tokens.
function curveChart() {
  const vT = 2000, vM = 200;
  const spot = (x) => (vM * vT) / (vT - x) ** 2;
  let d = `M ${X(0)} ${Y(spot(0))}`;
  for (let x = 25; x <= 1000; x += 25) d += ` H ${X(x).toFixed(1)} V ${Y(spot(x)).toFixed(1)}`;
  let cum = 0;
  const blocks = demo.curve.fills.map((f, i) => {
    const x0 = X(cum); cum += f.tokens; const x1 = X(cum);
    return `<rect class="fill" data-i="${i}" x="${x0.toFixed(1)}" y="${Y(f.avg).toFixed(1)}" width="${(x1 - x0 - 2).toFixed(1)}" height="${(Y(0) - Y(f.avg)).toFixed(1)}"
      style="fill:${f.bot ? "var(--berry-lamp)" : "var(--purple-lamp)"}"><title>${esc(f.who)}, block ${f.block}: ${f.tokens} tokens at ${f.avg} MON avg</title></rect>`;
  }).join("");
  const botEnd = X(demo.curve.fills.filter((f) => f.bot).reduce((a, f) => a + f.tokens, 0));
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" shape-rendering="crispEdges" role="img"
      aria-label="Bonding curve: the bot buys the first ${demo.curve.botShare}% of the sale at an average of ${f3(demo.curve.botAvg)} MON; the crowd pays ${f3(demo.curve.crowdAvg)} on average.">
    ${axes()}
    <g class="fills">${blocks}</g>
    <path d="${d}" fill="none" style="stroke:var(--marquee-white)" stroke-width="2"/>
    <g class="botmark" opacity="0">
      <line x1="${X(0)}" x2="${botEnd}" y1="${Y(0.2) - 6}" y2="${Y(0.2) - 6}" style="stroke:var(--berry-lamp)" stroke-width="3"/>
      <text x="${(X(0) + botEnd) / 2}" y="${Y(0.2) - 12}" text-anchor="middle" style="fill:var(--berry-lamp)">bot · blocks 1–3</text>
    </g>
  </svg>`;
}

// Player 2: Even. The demand staircase from the revealed bids, the supply line, and one price.
function evenLevels() {
  const by = new Map();
  for (const p of demo.people) {
    const cur = by.get(p.auction.bidPrice) ?? { price: p.auction.bidPrice, qty: 0, bot: false };
    cur.qty += p.auction.bidAmount;
    cur.bot ||= p.bot;
    by.set(p.auction.bidPrice, cur);
  }
  return [...by.values()].sort((a, b) => b.price - a.price);
}

function evenChart() {
  const levels = evenLevels();
  let cum = 0;
  const steps = levels.map((l, i) => {
    const x0 = X(cum); cum += l.qty; const x1 = X(cum);
    return `<rect class="step" data-i="${i}" x="${x0.toFixed(1)}" y="${Y(l.price).toFixed(1)}" width="${Math.max(x1 - x0 - 2, 2).toFixed(1)}" height="${(Y(0) - Y(l.price)).toFixed(1)}"
      style="fill:${l.bot ? "var(--berry-lamp)" : "var(--monad-purple)"}"><title>Bids at ${l.price} MON: ${l.qty.toFixed(0)} tokens${l.bot ? " (includes the bot)" : ""}</title></rect>`;
  }).join("");
  const P = demo.auction.clearing;
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" shape-rendering="crispEdges" role="img"
      aria-label="Even: sealed bids stack into a staircase by price; all ${demo.auction.sold} tokens clear at ${f3(P)} MON and every winner, the bot included, pays that price.">
    ${axes()}
    <g class="steps">${steps}</g>
    <line class="supply" x1="${X(demo.auction.sold)}" x2="${X(demo.auction.sold)}" y1="${Y(MAX_Y) + 4}" y2="${Y(0)}" style="stroke:var(--marquee-white)" stroke-width="2" stroke-dasharray="4 4" opacity="0"/>
    <text class="supply-label" x="${X(demo.auction.sold) + 4}" y="${Y(0.46)}" opacity="0">supply</text>
    <rect class="band" x="${X(0)}" y="${Y(P)}" width="${X(demo.auction.sold) - X(0)}" height="${Y(0) - Y(P)}" style="fill:var(--win-lime)" opacity="0"/>
    <line class="clear" x1="${X(0)}" x2="${X(demo.auction.sold)}" y1="${Y(P)}" y2="${Y(P)}" style="stroke:var(--win-lime)" stroke-width="3" stroke-dasharray="${X(demo.auction.sold) - X(0)}" stroke-dashoffset="${X(demo.auction.sold) - X(0)}"/>
    <text class="clear-label" x="${X(demo.auction.sold) - 4}" y="${Y(P) - 8}" text-anchor="end" style="fill:var(--win-lime)" opacity="0">one price · ${f3(P)}</text>
  </svg>`;
}

function scoreboard(side) {
  const bot = side === 1 ? demo.curve.botAvg : demo.auction.clearing;
  const crowd = side === 1 ? demo.curve.crowdAvg : demo.auction.clearing;
  return `<dl class="score" data-score="${side}">
    <div class="is-bot"><dt>Bot paid / token</dt><dd><span data-v="${bot}">—</span><small>MON</small></dd></div>
    <div><dt>Crowd paid / token</dt><dd><span data-v="${crowd}">—</span><small>MON</small></dd></div>
  </dl>`;
}

function hiscoreRows() {
  const order = [...demo.people].sort((a, b) => a.arrival - b.arrival);
  return order.map((p, i) => {
    const c = p.curve.status === "filled" ? `${f3(p.curve.avg)} <span class="note">· ${p.curve.tokens}</span>`
      : `<span class="note">${esc(p.curve.status)}</span>`;
    const e = p.auction.tokens > 0 ? `<strong>${f3(p.auction.avg)}</strong> <span class="note">· ${p.auction.tokens}${p.auction.status === "partial" ? " (pro-rata)" : ""}</span>`
      : `<span class="note">below the price, refunded</span>`;
    return `<tr class="${p.bot ? "is-bot" : ""}"><td class="rank">${i + 1}</td><td>${p.bot ? `<span class="chip chip-berry">bot</span>` : esc(p.name)}</td>
      <td>${esc(String(p.maxPrice))}</td><td>${c}</td><td>${e}</td></tr>`;
  }).join("");
}

export function renderHome(el, { scrollTo } = {}) {
  const P = f3(demo.auction.clearing);
  el.innerHTML = `
  <section class="hero" aria-labelledby="hero-h">
    <div class="hero-head">
      <div class="hero-title">
        <img class="hero-coin" src="assets/coin-360.png" width="180" height="180" alt="">
        <h1 id="hero-h">Nobody gets <em>a head start.</em></h1>
      </div>
      <div>
        <p class="hero-sub">Sealed bids, one clearing price. The bot that wins the bonding-curve race pays <strong>exactly what you pay</strong>, and the pool opens at that price, locked.</p>
        <div class="hero-actions">
          <a class="btn btn-coin btn-lg" href="#/play">Insert coin · bid on a launch</a>
          <a class="btn btn-lg" href="#/host">Launch a token</a>
          <p class="claim">Snipe-resistant: submission timing no longer determines price.</p>
        </div>
      </div>
    </div>

    <div class="cabinet" id="cabinet">
      <div class="cabinet-top"><span>Head-to-head · same token · same 13 players</span><span class="insert" aria-hidden="true">Insert coin</span></div>
      <div class="screen">
        <section class="player player-1" aria-label="Player 1: bonding curve">
          <div class="player-head"><span class="player-tag">1P</span><span class="player-name">Bonding curve</span></div>
          <p class="player-rule" data-rule="1">Price rises with every buy. First in, cheapest in.</p>
          ${curveChart()}
          ${scoreboard(1)}
          <div class="banner" data-banner="1">Bot wins<small>${demo.curve.emptyHanded} of ${demo.crowd} got nothing</small></div>
        </section>
        <section class="player player-2" aria-label="Player 2: Even">
          <div class="player-head"><span class="player-tag">2P</span><span class="player-name">Even</span></div>
          <p class="player-rule" data-rule="2">Everyone bids sealed. One price for every winner.</p>
          ${evenChart()}
          ${scoreboard(2)}
          <div class="banner" data-banner="2">Draw<small>everyone pays ${P} MON</small></div>
        </section>
      </div>
      <div class="cabinet-foot">
        <p class="note">Replay of ${demo.transactions} real transactions on a local chain against the actual contracts (demo/results.json). Not live market data.</p>
        <button class="btn btn-ghost btn-sm" id="replay" type="button">Replay</button>
      </div>
    </div>
  </section>

  <section class="section" aria-labelledby="fair-h">
    <div class="section-head">
      <h2 id="fair-h">Fair, in numbers</h2>
      <p>${fair.launches} random launches, each played twice with the same ${fair.crowdSize.min}–${fair.crowdSize.max} buyers and the same sniper bot: once on a bonding curve, once on Even. Real auction contracts, run in memory.</p>
    </div>
    <div class="fair-grid" role="table" aria-label="Bonding curve versus Even over ${fair.launches} launches">
      <div class="fair-row fair-headrow" role="row"><span role="columnheader">Over ${fair.launches} launches</span><span role="columnheader">1P Bonding curve</span><span role="columnheader">2P Even</span></div>
      ${[
        ["Bot's share of the supply (median)", `${Math.round(fair.curve.botShare.median)}%`, `${Math.round(fair.even.botShare.median)}%`],
        ["Buyers willing to pay the fair price who got nothing", `${Math.round(fair.curve.shutOutPct)}%`, `${Math.round(fair.even.shutOutPct)}%`],
        ["Launches where the last third to arrive got nothing", `${Math.round(fair.curve.lateThirdGotNothingPct)}%`, "0%"],
        ["Highest price a buyer paid ÷ lowest (median)", `${fair.curve.priceSpread.median.toFixed(2)}×`, "1×"],
        ["Launches where the bot paid less than the crowd", `${Math.round(fair.curve.botCheaperPct)}%`, "0%"],
      ].map(([m, c, e]) => `<div class="fair-row" role="row"><span role="cell">${esc(m)}</span><strong role="cell" class="fair-curve">${esc(c)}</strong><strong role="cell" class="fair-even">${esc(e)}</strong></div>`).join("")}
    </div>
    <p class="note fair-note">On the curve the bot buys in the first three blocks and buyers arrive in random order, each buying while the price is under their limit. On Even everyone bids sealed and the bot bids high. Every Even winner paid the same price, to the wei of rounding. Source: <code>demo/script/FairnessStats.s.sol</code>.</p>
  </section>

  <section class="section" id="how" aria-labelledby="how-h">
    <div class="section-head">
      <h2 id="how-h">How it plays</h2>
      <p>A round is four stages. The clock runs on chain time, and anyone can press the buttons that move a round forward. Your money always goes to you.</p>
    </div>
    <ol class="steps">
      <li class="step" data-tone="coin">
        <div class="step-icon">${pixelIcon("coin", { color: "var(--berry-lamp)", shade: "var(--berry-shade)" })}</div>
        <h3>Insert coin</h3><p class="what">Commit window</p>
        <p>Pick a max price and an amount. Your bid is sealed as a hash, and everyone locks the same deposit, so the deposit gives nothing away.</p>
      </li>
      <li class="step" data-tone="p2">
        <div class="step-icon">${pixelIcon("clock", { color: "var(--purple-glow)", shade: "var(--win-lime)" })}</div>
        <h3>Continue?</h3><p class="what">Reveal window</p>
        <p>Open your bid before the clock runs out. Miss it and the deposit is burned. Your wallet can recover a lost bid from any device.</p>
      </li>
      <li class="step" data-tone="p2">
        <div class="step-icon">${pixelIcon("draw", { color: "var(--purple-lamp)", shade: "var(--win-lime)" })}</div>
        <h3>Results</h3><p class="what">Settlement</p>
        <p>Bids stack from the highest price down until they cover the supply. That step is the price for every winner. Bids exactly on it share what's left.</p>
      </li>
      <li class="step" data-tone="win">
        <div class="step-icon">${pixelIcon("collect", { color: "var(--win-lime)", shade: "var(--purple-lamp)" })}</div>
        <h3>Collect</h3><p class="what">Claims</p>
        <p>Take the unused part of your deposit right away. Tokens arrive once the pool is seeded at the clearing price and locked with GoPlus.</p>
      </li>
    </ol>
  </section>

  <section class="section" aria-labelledby="scores-h">
    <div class="section-head">
      <h2 id="scores-h">High scores:<br>all tied</h2>
      <p>The same ${demo.people.length} players in both games. On the curve, arrival order decided the price. On Even, every winner paid ${P} MON, the bot included.</p>
    </div>
    <div class="panel"><div class="panel-in table-scroll">
      <table class="hiscore">
        <thead><tr><th>#</th><th>Player</th><th>Max price</th><th>Curve: paid / token · tokens</th><th>Even: paid / token · tokens</th></tr></thead>
        <tbody>${hiscoreRows()}</tbody>
      </table>
      <p class="note">MON per token. Players are listed in the order they arrived. Replay of the demo run, not live data.</p>
    </div></div>
  </section>

  <section class="section" aria-labelledby="rules-h">
    <div class="section-head">
      <h2 id="rules-h">House rules</h2>
      <p>Exactly what is private and what is not. Privacy via commit-reveal.</p>
    </div>
    <div class="panel"><div class="panel-in rules">
      <div class="private"><h3>Sealed until you reveal</h3><ul>
        <li>Your price and amount: only a hash is on-chain during the commit window.</li>
        <li>Your deposit size says nothing: everyone locks the same amount.</li>
        <li>Your recovery note is encrypted to your wallet.</li>
      </ul></div>
      <div class="public"><h3>Public by design</h3><ul>
        <li>How many bids there are, and when they arrived.</li>
        <li>Every bid, once the round settles: post-clear transparency is intentional.</li>
        <li>Deposits of bids nobody revealed are burned, not paid to anyone.</li>
      </ul></div>
    </div></div>
  </section>

  <section class="section" aria-labelledby="cert-h">
    <div class="section-head">
      <h2 id="cert-h">Certified</h2>
      <p>The contracts behind every button, tested and reviewed. Details are in the repository's audit file.</p>
    </div>
    <div class="certs">
      <div class="cert"><strong>102</strong><span>contract tests; the fuzz tests also run clean at 10,000 runs each</span></div>
      <div class="cert"><strong>2</strong><span>security reviews with a proof of concept per finding, each fixed or documented</span></div>
      <div class="cert"><strong>19</strong><span>tests against real Uniswap v3 and the GoPlus locker on a Monad mainnet fork</span></div>
      <div class="cert"><strong>${demo.transactions}</strong><span>real transactions behind the head-to-head replay above</span></div>
    </div>
  </section>

  <section class="section" id="play" aria-labelledby="play-h">
    <div class="section-head">
      <h2 id="play-h">Now playing</h2>
      <p>Rounds on the connected engine. Open one to bid, or enter a round number.</p>
    </div>
    <div class="now-playing">
      <div class="panel panel-p2"><div class="panel-in">
        <h3 class="panel-title">Rounds</h3>
        <div id="recent"><p class="note">Reading the engine…</p></div>
      </div></div>
      <div class="panel panel-p1"><div class="panel-in">
        <h3 class="panel-title">Go to a round</h3>
        <form id="goto-form" class="goto">
          <input id="round-id" placeholder="Round number" inputmode="numeric" aria-label="Round number">
          <button class="btn btn-start" type="submit">Open</button>
        </form>
        <p class="note" style="margin-top:14px">Launching a token? <a href="#/host">Start here</a>.</p>
      </div></div>
    </div>
  </section>`;

  // ── recent rounds ──
  el.querySelector("#goto-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const v = el.querySelector("#round-id").value.trim();
    if (/^\d+$/.test(v)) location.hash = `#/round/${v}`;
  });
  loadRecent(el.querySelector("#recent"));

  // ── the head-to-head ──
  const stop = playHeadToHead(el);
  el.querySelector("#replay").addEventListener("click", () => playHeadToHead(el, true));
  if (scrollTo) requestAnimationFrame(() => el.querySelector(`#${scrollTo}`)?.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" }));
  return { cleanup: stop };
}

async function loadRecent(box) {
  const eng = getEngine();
  if (!eng) { box.innerHTML = `<p class="note">Live rounds open on ${esc(network().label)} soon. Until then, the head-to-head above is a replay of the real contracts.</p>`; return; }
  try {
    const count = Number(await eng.roundCount());
    if (!count) { box.innerHTML = `<p class="note">No rounds yet on this engine. <a href="#/host">Launch the first one</a>.</p>`; return; }
    const ids = Array.from({ length: Math.min(count, 8) }, (_, i) => count - i);
    const rows = await Promise.all(ids.map(async (id) => {
      try {
        const r = await eng.getRound(BigInt(id));
        const now = Date.now() / 1000;
        const st = r.claimsOpen ? "collect" : r.settledAt !== 0n ? "results" : Number(r.revealEnd) <= now ? "results" : Number(r.commitEnd) <= now ? "continue?" : "insert coin";
        return `<li><a href="#/round/${id}"><span class="rid">#${id}</span><span>${r.preset === 0n ? "Degen" : "Raise"}</span><span class="chip ${st === "insert coin" ? "chip-berry" : "chip-purple"}">${st}</span></a></li>`;
      } catch { return `<li><a href="#/round/${id}"><span class="rid">#${id}</span><span></span><span></span></a></li>`; }
    }));
    box.innerHTML = `<ul class="rounds-list">${rows.join("")}</ul>`;
  } catch (err) {
    box.innerHTML = `<p class="note">No engine answering on ${esc(network().label)} yet. Live rounds run on the local demo stack (see the README); pick another network in the header or set a deployment under Cabinet settings.</p>`;
    console.warn("recent rounds:", err);
  }
}

// One authored moment (DESIGN.md): both games play side by side, then the result is called.
let timers = [];
function playHeadToHead(el, restart = false) {
  timers.forEach(clearTimeout);
  timers = [];
  const cab = el.querySelector("#cabinet");
  if (!cab) return () => {};
  const $$ = (s) => [...cab.querySelectorAll(s)];
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const at = (ms, fn) => timers.push(setTimeout(fn, reduce ? 0 : ms));
  const rule = (n, t) => { const p = cab.querySelector(`[data-rule="${n}"]`); if (p) p.textContent = t; };
  const score = (n) => $$(`[data-score="${n}"] [data-v]`).forEach((s) => { s.textContent = Number(s.dataset.v).toFixed(3); });

  // reset
  $$(".fill, .step").forEach((r) => { r.style.opacity = "0"; });
  $$(".botmark, .supply, .supply-label, .band, .clear-label").forEach((n) => n.setAttribute("opacity", "0"));
  const clear = cab.querySelector(".clear");
  if (clear) { clear.style.transition = "none"; clear.style.strokeDashoffset = clear.getAttribute("stroke-dasharray"); }
  $$("[data-v]").forEach((s) => { s.textContent = "—"; });
  $$(".banner").forEach((b) => b.classList.remove("on"));
  rule(1, "Price rises with every buy. First in, cheapest in.");
  rule(2, "Everyone bids sealed. One price for every winner.");

  const fills = $$(".fill");
  const steps = $$(".step");
  // 1P: the bot's three blocks land first, then the crowd, pricier each time.
  fills.forEach((r, i) => at(600 + i * 520, () => { r.style.opacity = "1"; }));
  at(600 + 3 * 520, () => { cab.querySelector(".botmark")?.setAttribute("opacity", "1"); rule(1, "Blocks 1–3: the bot buys first and cheapest."); });
  at(600 + fills.length * 520, () => rule(1, "The crowd arrives later and buys the top."));
  // 2P: sealed coins; then the reveal stacks the staircase; then one price is called.
  at(900, () => rule(2, `Insert coin: ${demo.people.length} sealed bids, the same deposit each.`));
  steps.forEach((r, i) => at(2600 + i * 360, () => { r.style.opacity = "1"; }));
  at(2600, () => rule(2, "Continue? Bids revealed, highest price first."));
  const tCall = Math.max(600 + fills.length * 520, 2600 + steps.length * 360) + 500;
  at(tCall, () => {
    cab.querySelector(".supply")?.setAttribute("opacity", "1");
    cab.querySelector(".supply-label")?.setAttribute("opacity", "1");
    if (clear) { clear.style.transition = reduce ? "none" : "stroke-dashoffset 700ms steps(10, end)"; clear.style.strokeDashoffset = "0"; }
  });
  at(tCall + 800, () => {
    cab.querySelector(".band")?.setAttribute("opacity", "0.22");
    cab.querySelector(".clear-label")?.setAttribute("opacity", "1");
    score(1); score(2);
    rule(1, `${demo.curve.emptyHanded} of ${demo.crowd} got nothing. The bot averaged ${f3(demo.curve.botAvg)}.`);
    rule(2, `Results: everyone pays ${f3(demo.auction.clearing)}. Arrival order bought nothing.`);
  });
  at(tCall + 1300, () => $$(".banner").forEach((b) => b.classList.add("on")));
  return () => { timers.forEach(clearTimeout); timers = []; };
}
