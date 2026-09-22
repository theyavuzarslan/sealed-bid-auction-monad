// Sniper head-to-head player.
// Plays demo/results.json — written by demo/run.sh from real transactions on anvil — as a
// twenty-second, two-pane animation. Nothing here computes an outcome: every fill, bid,
// allocation and price comes from the chain (LocalBondingCurve + SniperBot on the left,
// the real AuctionEngine on the right). This file only decides *when* to show each fact.
//
// Browser: index.html loads it. Keys: space = pause, R = replay. URL: ?t=15000 starts at 15 s,
// ?loop=1 replays forever.
// Node:    node demo/harness.js   checks results.json for the two claims and prints them.

(function () {
  "use strict";

  // ── Storyboard (ms). Clip cues only; the on-chain windows are 10 minutes each. ──────────
  var T = {
    botStart: 1200, botStep: 500,          // bot: three curve buys + the first commitment
    crowdStart: 3000, crowdStep: 450,      // crowd: one arrival per step, both panes at once
    leftVerdict: 8800,
    revealStart: 9000, revealStep: 120,
    clearStart: 10800, clearDur: 1000,
    settleStart: 12000, settleStep: 100,
    rightVerdict: 13600,
    takeaway: 15200,
    end: 20000,
  };

  function mon(wei) { return Number(BigInt(wei)) / 1e18; }
  function px(v) { return v.toFixed(3); }
  function tok(v) { return Math.round(v).toLocaleString("en-US"); }
  function pct(v) { return Math.round(v * 100) + "%"; }
  function shortHash(h) { return h.slice(0, 6) + "…" + h.slice(-4); }
  function shortAddr(a) { return a.slice(0, 6) + "…" + a.slice(-4); }

  // ── Model: results.json → a flat, display-ready script ──────────────────────────────────
  function model(R) {
    var supply = mon(R.meta.supply);
    var P = mon(R.auction.clearingPrice);
    var people = R.participants.map(function (p, i) {
      return {
        i: i,
        name: p.name,
        bot: p.bot,
        maxPrice: mon(p.maxPrice),
        curve: {
          status: p.curve.status,
          block: p.curve.block,
          spotAtArrival: mon(p.curve.spotAtArrival),
          tokens: mon(p.curve.tokens),
          avg: mon(p.curve.avgPrice),
        },
        auction: {
          hash: p.auction.hash,
          bidPrice: mon(p.auction.bidPrice),
          bidAmount: mon(p.auction.bidAmount),
          alloc: mon(p.auction.allocated),
          paid: mon(p.auction.paid),
          perToken: mon(p.auction.pricePerToken),
          status: p.auction.status,
        },
        // Same arrival cue on both panes: the bot first, then the crowd in order.
        arriveAt: p.bot ? T.botStart : T.crowdStart + (p.arrival - 1) * T.crowdStep,
        revealAt: T.revealStart + i * T.revealStep,
        settleAt: T.settleStart + i * T.settleStep,
      };
    });

    var botFill = 0;
    var cum = 0;
    var fills = R.curve.fills.map(function (f) {
      var tokens = mon(f.tokens);
      var at;
      if (f.bot) at = T.botStart + (botFill++) * T.botStep;
      else {
        var who = people.filter(function (p) { return p.name === f.who; })[0];
        at = who.arriveAt;
      }
      var row = { who: f.who, bot: f.bot, block: f.block, tokens: tokens, paid: mon(f.paid), spotAfter: mon(f.spotAfter), x0: cum, at: at };
      cum += tokens;
      row.x1 = cum;
      return row;
    });

    // Ladder: bids by price, highest first (the bot first on a tie — it gains nothing from it).
    var ladder = people.slice().sort(function (a, b) {
      if (b.auction.bidPrice !== a.auction.bidPrice) return b.auction.bidPrice - a.auction.bidPrice;
      return a.i - b.i;
    });
    var x = 0;
    ladder.forEach(function (p) { p.ladderX = x; x += p.auction.bidAmount; });
    var demand = x;

    var crowd = people.filter(function (p) { return !p.bot; });
    var bot = people[0];
    return {
      R: R,
      supply: supply,
      P: P,
      people: people,
      bot: bot,
      crowd: crowd,
      fills: fills,
      ladder: ladder,
      demand: demand,
      vt: mon(R.curve.virtualToken),
      vm: mon(R.curve.virtualMon),
      xMax: Math.max(supply, demand) * 1.04,
      yMax: Math.max(bot.auction.bidPrice, mon(R.curve.finalSpot)) * 1.12,
      left: {
        botAvg: mon(R.curve.bot.avgPrice),
        crowdAvg: mon(R.curve.crowd.avgPrice),
        botShare: mon(R.curve.bot.tokens) / supply,
        empty: crowd.filter(function (p) { return p.curve.status !== "filled"; }).length,
      },
      right: {
        botAvg: mon(R.auction.bot.avgPrice),
        crowdAvg: mon(R.auction.crowd.avgPrice),
        botShare: mon(R.auction.bot.tokens) / supply,
        filled: crowd.filter(function (p) { return p.auction.alloc > 0; }).length,
      },
    };
  }

  // ── Node check ──────────────────────────────────────────────────────────────────────────
  if (typeof window === "undefined") {
    // Works whether Node treats this file as CommonJS or as an ES module.
    var mod = function (n) { return typeof require === "function" ? require(n) : process.getBuiltinModule(n); };
    var fs = mod("fs");
    var path = mod("path");
    var M = model(JSON.parse(fs.readFileSync(path.join(path.dirname(process.argv[1]), "results.json"), "utf8")));
    var R = M.R;
    var fails = [];
    function check(name, ok) { if (!ok) fails.push(name); }
    var cb = R.curve.bot, cc = R.curve.crowd, ab = R.auction.bot, ac = R.auction.crowd;
    check("curve: bot avg below crowd avg", BigInt(cb.paid) * BigInt(cc.tokens) < BigInt(cc.paid) * BigInt(cb.tokens));
    check("curve: bot owns the first fills", R.curve.fills[0].bot && !R.curve.fills[R.curve.fills.length - 1].bot);
    check("auction: bot price == clearing price", ab.avgPrice === R.auction.clearingPrice);
    R.participants.forEach(function (p) {
      if (p.auction.allocated !== "0") {
        check(p.name + " pays the clearing price", p.auction.pricePerToken === R.auction.clearingPrice);
      }
    });
    check("auction: every commitment revealed and claimed", R.participants.every(function (p) { return p.auction.revealed && p.auction.claimed; }));
    if (fails.length) { console.error("FAIL\n" + fails.join("\n")); process.exit(1); }
    console.log("results.json ok (" + R.meta.transactions + " transactions)");
    console.log("curve    bot " + px(M.left.botAvg) + "  crowd " + px(M.left.crowdAvg) + " MON/token");
    console.log("auction  bot " + px(M.right.botAvg) + "  crowd " + px(M.right.crowdAvg) + " MON/token  (clearing " + px(M.P) + ")");
    return;
  }

  // ── Browser ─────────────────────────────────────────────────────────────────────────────
  var $ = function (id) { return document.getElementById(id); };
  var SVGNS = "http://www.w3.org/2000/svg";

  function svg(tag, attrs, parent) {
    var n = document.createElementNS(SVGNS, tag);
    for (var k in attrs) n.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(n);
    return n;
  }
  function el(tag, cls, text, parent) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    if (parent) parent.appendChild(n);
    return n;
  }
  function setText(n, s) { if (n.textContent !== s) n.textContent = s; }
  function setOn(n, on, cls) { n.classList.toggle(cls || "on", !!on); }
  function show(n, on) { var v = on ? "1" : "0"; if (n.style.opacity !== v) n.style.opacity = v; }
  function place(n, xPct, yPct) { n.style.left = xPct + "%"; n.style.top = yPct + "%"; }

  function load() {
    return fetch("results.json", { cache: "no-store" })
      .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
      .catch(function () {
        if (window.RESULTS) return window.RESULTS;
        throw new Error("no results");
      });
  }

  function build(M) {
    var X = function (t) { return (t / M.xMax) * 1000; };
    var Y = function (p) { return 400 - (p / M.yMax) * 400; };
    var XP = function (t) { return (X(t) / 1000) * 100; };
    var YP = function (p) { return (Y(p) / 400) * 100; };
    var sym = "$" + M.R.meta.token;

    setText($("briefToken"), "Same " + sym + " token");
    setText($("briefSupply"), "same " + tok(M.supply) + "-token sale");
    setText($("briefCrowd"), "same " + M.crowd.length + " buyers");
    setText($("rightKicker"), "Real AuctionEngine · " + M.R.meta.preset + " preset");
    $("proof").textContent =
      "Real transactions on a local chain (anvil, " + M.R.meta.transactions + " txs) · left: LocalBondingCurve + SniperBot " +
      "· right: AuctionEngine " + shortAddr(M.R.meta.engine) + ", commit → reveal → settle → LP → claim";

    // Shared axes: price gridlines on both charts so heights compare across panes.
    [["leftSvg", "leftChart"], ["rightSvg", "rightChart"]].forEach(function (pair) {
      var s = $(pair[0]);
      for (var g = 0.1; g < M.yMax - 1e-9; g += 0.1) {
        svg("line", { class: "axis", x1: 0, x2: 1000, y1: Y(g), y2: Y(g) }, s);
        var l = el("div", "lbl y", g.toFixed(1), $(pair[1]));
        place(l, 0, YP(g));
        l.style.transform = "translate(-110%, -50%)";
      }
      svg("line", { class: "axis", x1: 0, x2: 1000, y1: 400, y2: 400 }, s);
      svg("line", { class: "supply-line", x1: X(M.supply), x2: X(M.supply), y1: 0, y2: 400 }, s);
    });

    // ── Left chart: the curve, and who bought which stretch of it ────────────────────────
    var ls = $("leftSvg");
    var k = M.vt * M.vm;
    var spot = function (sold) { return k / Math.pow(M.vt - sold, 2); };
    var ghost = "";
    for (var i = 0; i <= 60; i++) {
      var s0 = (M.supply * i) / 60;
      ghost += (i ? " L " : "M ") + X(s0).toFixed(2) + " " + Y(spot(s0)).toFixed(2);
    }
    svg("path", { class: "ghost", d: ghost }, ls);
    var areas = M.fills.map(function (f) {
      var d = "M " + X(f.x0) + " 400";
      for (var j = 0; j <= 16; j++) {
        var sx = f.x0 + ((f.x1 - f.x0) * j) / 16;
        d += " L " + X(sx).toFixed(2) + " " + Y(spot(sx)).toFixed(2);
      }
      d += " L " + X(f.x1) + " 400 Z";
      var a = svg("path", { class: f.bot ? "area-bot" : "area-crowd", d: d }, ls);
      svg("line", { class: "edge", x1: X(f.x1), x2: X(f.x1), y1: Y(spot(f.x1)), y2: 400 }, ls);
      a.style.opacity = "0";
      a.style.transition = "opacity 250ms ease";
      return a;
    });
    var dot = el("i", "spot-dot", null, $("leftChart"));
    var spotLbl = el("div", "lbl big", "", $("leftChart"));
    var botEnd = M.fills.filter(function (f) { return f.bot; }).pop();
    var botLbl = el("div", "lbl big bot", "SNIPER BOT", $("leftChart"));
    place(botLbl, XP(botEnd.x1 / 2), YP(spot(botEnd.x1) + M.yMax * 0.14));
    botLbl.style.transform = "translate(-50%, -50%)";
    var saleLbl = el("div", "lbl", "sale: " + tok(M.supply) + " tokens", $("leftChart"));
    place(saleLbl, XP(M.supply), 100);
    saleLbl.style.transform = "translate(-50%, 15%)";

    // ── Right chart: the revealed book, then one clearing price ──────────────────────────
    var rs = $("rightSvg");
    M.ladder.forEach(function (p) {
      var cls = p.bot ? "bot" : "crowd";
      p.barBid = svg("rect", {
        class: "bar-bid " + cls, x: X(p.ladderX), width: X(p.auction.bidAmount),
        y: Y(p.auction.bidPrice), height: 400 - Y(p.auction.bidPrice),
      }, rs);
      p.barPaid = svg("rect", {
        class: "bar-paid " + cls, x: X(p.ladderX), width: X(p.auction.alloc),
        y: Y(M.P), height: 400 - Y(M.P),
      }, rs);
      p.barBid.style.opacity = "0";
      p.barPaid.style.opacity = "0";
    });
    var clearLine = svg("line", { class: "clear-line", x1: 0, x2: 1000, y1: 0, y2: 0 }, rs);
    var clearLbl = el("div", "lbl big price", "", $("rightChart"));
    clearLbl.style.transform = "translate(-100%, -115%)";
    var demandLbl = el("div", "lbl", "sale: " + tok(M.supply) + " tokens", $("rightChart"));
    place(demandLbl, XP(M.supply), 100);
    demandLbl.style.transform = "translate(-50%, 15%)";
    var botBar = M.bot;
    var botBarLbl = el("div", "lbl big inbar", "SNIPER\nBOT", $("rightChart"));
    place(botBarLbl, XP(botBar.ladderX + botBar.auction.bidAmount / 2), YP(botBar.auction.bidPrice));
    botBarLbl.style.transform = "translate(-50%, 18%)";
    var locks = M.people.map(function (p) { return el("i", p.bot ? "bot" : "", null, $("locks")); });

    // ── Rows ─────────────────────────────────────────────────────────────────────────────
    M.people.forEach(function (p) {
      p.lrow = el("li", "row" + (p.bot ? " bot" : ""), null, $("leftRows"));
      p.lcells = ["name", "note", "num", "px"].map(function (c) { return el("span", c, "", p.lrow); });
      p.rrow = el("li", "row" + (p.bot ? " bot" : ""), null, $("rightRows"));
      p.rcells = ["name", "note", "num", "px"].map(function (c) { return el("span", c, "", p.rrow); });
      setText(p.lcells[0], p.name);
      setText(p.rcells[0], p.name);
    });

    // ── Verdicts ─────────────────────────────────────────────────────────────────────────
    function vs(botVal, crowdVal, botCls, crowdCls, unit) {
      return '<div class="vs">' +
        '<div><div class="who bot">Sniper bot</div><div class="val ' + botCls + '">' + px(botVal) + "</div></div>" +
        '<div><div class="who crowd">Crowd</div><div class="val ' + crowdCls + '">' + px(crowdVal) + "</div></div>" +
        '<div class="unit">' + unit + "</div></div>";
    }
    $("leftVerdict").innerHTML =
      vs(M.left.botAvg, M.left.crowdAvg, "bot", "crowd", "MON per token<br>average paid") +
      '<p class="punch">Crowd paid <b>' + (M.left.crowdAvg / M.left.botAvg).toFixed(1) + "×</b> the bot’s price. " +
      "Bot took <b>" + pct(M.left.botShare) + "</b> of the sale; <b>" + M.left.empty + " of " + M.crowd.length +
      "</b> buyers got nothing.</p>";
    $("rightVerdict").innerHTML =
      vs(M.right.botAvg, M.right.crowdAvg, "same", "same", "MON per token<br>paid by every winner") +
      '<p class="punch"><b class="ok">One price</b> for every winner, the bot included. ' +
      "Bot got the " + pct(M.right.botShare) + " it bid for; <b class=\"ok\">" + M.right.filled + " of " + M.crowd.length +
      "</b> buyers filled.</p>";

    // ── Frame ────────────────────────────────────────────────────────────────────────────
    return function render(t) {
      $("progress").style.transform = "scaleX(" + Math.min(1, t / T.end) + ")";

      // Left pane.
      var shown = M.fills.filter(function (f) { return f.at <= t; });
      M.fills.forEach(function (f, n) { show(areas[n], f.at <= t); });
      var last = shown[shown.length - 1];
      var spotNow = last ? last.spotAfter : M.vm / M.vt;
      var xNow = last ? last.x1 : 0;
      place(dot, XP(xNow), YP(spotNow));
      place(spotLbl, XP(xNow), YP(spotNow));
      spotLbl.style.transform = xNow > M.supply * 0.7 ? "translate(-115%, -120%)" : "translate(18%, -120%)";
      setText(spotLbl, px(spotNow) + " now");
      show(botLbl, t >= T.botStart + 2 * T.botStep);
      var ls2 = $("leftStatus");
      if (!last) { setText(ls2, "Trading opens"); setOn(ls2, false, "hot"); }
      else {
        var soldOut = Math.abs(last.x1 - M.supply) < 1e-6 && t >= T.crowdStart + M.crowd.length * T.crowdStep;
        setText(ls2, "Block +" + last.block + (soldOut ? " · sold out" : ""));
        setOn(ls2, last.bot, "hot");
      }

      M.people.forEach(function (p) {
        var c = p.lcells;
        setOn(p.lrow, t >= p.arriveAt);
        if (p.bot) {
          var mine = shown.filter(function (f) { return f.bot; });
          var got = mine.reduce(function (s, f) { return s + f.tokens; }, 0);
          var paid = mine.reduce(function (s, f) { return s + f.paid; }, 0);
          setText(c[1], mine.length ? "block " + mine.map(function (f) { return "+" + f.block; }).join(" ") : "");
          setText(c[2], got ? tok(got) : "");
          var all = mine.length === M.fills.filter(function (f) { return f.bot; }).length;
          setText(c[3], got ? px(all ? p.curve.avg : paid / got) : "");
          c[3].className = "px hot";
          return;
        }
        if (p.curve.status === "filled") {
          setText(c[1], "block +" + p.curve.block);
          setText(c[2], tok(p.curve.tokens));
          setText(c[3], px(p.curve.avg));
          c[3].className = "px warm";
        } else {
          setOn(p.lrow, t >= p.arriveAt, "out");
          setText(c[1], p.curve.status === "sold out" ? "sold out" : "priced out at " + px(p.curve.spotAtArrival));
          setText(c[2], "—");
          setText(c[3], "—");
          c[2].className = c[3].className = "num dimmed";
        }
      });
      setOn($("leftVerdict"), t >= T.leftVerdict);

      // Right pane.
      var phase = t < T.revealStart ? "commit" : t < T.clearStart ? "reveal" : t < T.settleStart ? "clear" : "settled";
      var commits = M.people.filter(function (p) { return p.arriveAt <= t; }).length;
      var rsx = $("rightStatus");
      setText(rsx, phase === "commit" ? "Commit window" : phase === "reveal" ? "Reveal window" : phase === "clear" ? "Clearing" : "Settled · claimed");
      setOn(rsx, phase === "clear" || phase === "settled", "price");
      setText($("sealedCount"), String(commits));
      locks.forEach(function (l, n) { l.style.visibility = M.people[n].arriveAt <= t ? "visible" : "hidden"; });
      show($("sealed"), phase === "commit");
      setText($("rightCol2"), phase === "commit" ? "Commitment" : "Revealed bid");
      show(demandLbl, t >= T.revealStart);
      show(botBarLbl, t >= M.bot.revealAt);

      M.ladder.forEach(function (p) {
        show(p.barBid, t >= p.revealAt);
        setOn(p.barBid, t >= T.settleStart, "settled");
        show(p.barPaid, t >= p.settleAt && p.auction.alloc > 0);
      });

      if (t >= T.clearStart) {
        var k2 = Math.min(1, (t - T.clearStart) / T.clearDur);
        var ease = 1 - Math.pow(1 - k2, 3);
        var pNow = M.yMax - (M.yMax - M.P) * ease;
        clearLine.setAttribute("y1", Y(pNow));
        clearLine.setAttribute("y2", Y(pNow));
        clearLine.style.opacity = "1";
        place(clearLbl, 100, YP(pNow));
        setText(clearLbl, (k2 >= 1 ? "clearing price " : "") + px(pNow));
        show(clearLbl, true);
      } else {
        clearLine.style.opacity = "0";
        show(clearLbl, false);
      }

      M.people.forEach(function (p) {
        var c = p.rcells;
        var a = p.auction;
        setOn(p.rrow, t >= p.arriveAt);
        var state = t < p.revealAt ? "sealed" : t < p.settleAt ? "bid" : "done";
        if (p._rstate !== state) {
          if (p._rstate) { p.rrow.classList.remove("flash"); void p.rrow.offsetWidth; p.rrow.classList.add("flash"); }
          p._rstate = state;
        }
        var bid = "bid " + px(a.bidPrice) + " × " + tok(a.bidAmount);
        if (state === "sealed") {
          setText(c[1], "sealed " + shortHash(a.hash));
          c[1].className = "note";
          setText(c[2], "?");
          setText(c[3], "?");
          c[2].className = "num dimmed";
          c[3].className = "px dimmed";
        } else if (state === "bid") {
          setText(c[1], bid);
          setText(c[2], "");
          setText(c[3], "");
        } else if (a.alloc > 0) {
          setText(c[1], bid + (a.status === "partial" ? " · part" : ""));
          setText(c[2], tok(a.alloc));
          setText(c[3], px(a.perToken));
          c[2].className = "num";
          c[3].className = "px price";
        } else {
          setText(c[1], bid);
          c[1].className = "note dimmed";
          setText(c[2], "0");
          setText(c[3], "refund");
          c[2].className = "num dimmed";
          c[3].className = "px dimmed";
        }
      });
      setOn($("rightVerdict"), t >= T.rightVerdict);

      setOn(document.body, t >= T.takeaway, "end");
      setOn(document.body, t >= T.end, "done");
    };
  }

  function start(M) {
    var render = build(M);
    var q = new URLSearchParams(location.search);
    var loop = q.get("loop") === "1";
    var offset = Math.max(0, Number(q.get("t")) || 0);
    var t0 = performance.now() - offset;
    var pausedAt = q.get("pause") === "1" ? offset : null; // ?t=…&pause=1 holds a frame, for stills

    function frame(now) {
      var t = pausedAt != null ? pausedAt : now - t0;
      render(Math.min(t, T.end));
      if (loop && t > T.end + 3000) t0 = now;
      requestAnimationFrame(frame);
    }
    function replay() { pausedAt = null; t0 = performance.now(); }
    $("replay").addEventListener("click", replay);
    document.addEventListener("keydown", function (e) {
      if (e.key === "r" || e.key === "R") replay();
      if (e.key === " ") {
        e.preventDefault();
        if (pausedAt == null) pausedAt = performance.now() - t0;
        else { t0 = performance.now() - pausedAt; pausedAt = null; }
      }
    });
    requestAnimationFrame(frame);
  }

  load().then(function (R) { start(model(R)); }).catch(function () {
    var e = $("error");
    e.style.display = "flex";
    e.innerHTML = "<div>No results yet. Run <code>demo/run.sh</code> to play both launches on a local chain,<br>then reload this page.</div>";
  });
})();
