// Demo harness for the sniper head-to-head.
// Clip parameters below are not protocol defaults. Docs leave them unspecified.
// Curve formula: TODO — nad.fun's formula is not in the docs. Constant product,
// output rounded down. Bid tokenAmount is tokens requested, because Screen 4
// shows an allocation. 05-data-model says Bid.quantity is bidding-token amount.

(function (root) {
  var CONFIG = {
    tokenSymbol: "TOKEN",
    paymentSymbol: "MON",
    virtualTokenReserve: 500000,
    virtualPaymentReserve: 8000,
    tokensForSale: 380000,
    minBuy: 1,
    priceScale: 100,
    minBidSize: 1000,
    sellAmount: 380000,
    bot: {
      startLabel: 1,
      spendPerBlock: [1200, 1600, 2000],
      limitPrice: 800,
      tokenAmount: 120000,
    },
    // Commit order is arrival order. The bot is not first.
    cast: [
      { id: "4c1a", price: 640, tokenAmount: 90000, hash: "b7e1\u202690c" },
      { id: "e55c", price: 250, tokenAmount: 80000, hash: "0ad4\u202611f" },
      { id: "9a2e", price: 510, tokenAmount: 70000, hash: "c83a\u2026d0e" },
      { id: "2d04", price: 360, tokenAmount: 50000, hash: "91af\u2026776" },
      { id: "SNIPER", bot: true, price: 800, tokenAmount: 120000, hash: "e4c0\u2026b21" },
      { id: "b7e0", price: 430, tokenAmount: 60000, hash: "55d9\u20260ac" },
    ],
    // Curve buys, after the bot's three blocks. Same cast, second launch.
    crowdBuys: [
      { id: "4c1a", block: 6, pay: 2200 },
      { id: "9a2e", block: 8, pay: 2400 },
      { id: "b7e0", block: 10, pay: 2600 },
      { id: "2d04", block: 12, pay: 2800 },
      { id: "e55c", block: 14, pay: 3000 },
    ],
    // TODO: not specified — Degen windows are "minutes". These are cut cues, not on-chain times.
    storyboard: {
      clipMs: 20000,
      curveAt: [700, 2000, 3300, 5600, 6800, 8000, 9200, 10400],
      commitAt: [1000, 2400, 4000, 6200, 8400, 10400],
      revealAt: 11200,
      revealStep: 220,
      clearAt: 13400,
      settleAt: 14200,
    },
  };

  function buy(vt, vp, pay, left) {
    var out = Math.floor((vt * pay) / (vp + pay));
    var charged = pay;
    if (out > left) {
      var denom = vt - left;
      var need = Math.ceil((left * vp) / denom);
      return { tokensOut: left, paymentIn: need, capped: true };
    }
    return { tokensOut: out, paymentIn: charged, capped: false };
  }

  function simulateCurve() {
    var vt = CONFIG.virtualTokenReserve;
    var vp = CONFIG.virtualPaymentReserve;
    var left = CONFIG.tokensForSale;
    var open = vp / vt;
    var fills = [];
    var botSpends = CONFIG.bot.spendPerBlock;
    var planned = [];
    for (var i = 0; i < botSpends.length; i++) {
      planned.push({
        id: "SNIPER",
        bot: true,
        block: CONFIG.bot.startLabel + i,
        pay: botSpends[i],
      });
    }
    CONFIG.crowdBuys.forEach(function (row) {
      planned.push({ id: row.id, bot: false, block: row.block, pay: row.pay });
    });
    planned.forEach(function (row, index) {
      var got = buy(vt, vp, row.pay, left);
      if (got.tokensOut <= 0) return;
      vt -= got.tokensOut;
      vp += got.paymentIn;
      left -= got.tokensOut;
      fills.push({
        id: row.id,
        bot: row.bot,
        block: row.block,
        pay: got.paymentIn,
        tokensOut: got.tokensOut,
        price: got.paymentIn / got.tokensOut,
        tokenReserve: vt,
        paymentReserve: vp,
        open: open,
        t: CONFIG.storyboard.curveAt[index],
      });
    });
    return {
      fills: fills,
      open: open,
      sold: CONFIG.tokensForSale - left,
      unsold: left,
      botTokens: fills.filter(function (f) { return f.bot; }).reduce(function (s, f) { return s + f.tokensOut; }, 0),
    };
  }

  // Rank by price descending. Equal prices keep the earlier input (tie break is not specified).
  function clearAuction(bids, sellAmount) {
    var order = bids.map(function (b, i) { return i; });
    order.sort(function (a, b) {
      if (bids[a].price !== bids[b].price) return bids[b].price - bids[a].price;
      return a - b;
    });
    var remaining = sellAmount;
    var clearing = 0;
    var filled = bids.map(function () { return 0; });
    var crossed = false;
    for (var n = 0; n < order.length; n++) {
      if (remaining === 0) break;
      var i = order[n];
      var take = Math.min(bids[i].tokenAmount, remaining);
      filled[i] = take;
      remaining -= take;
      clearing = bids[i].price;
      crossed = true;
    }
    return { clearing: crossed ? clearing : 0, filled: filled, remaining: remaining };
  }

  function payment(tokens, price, scale) {
    return Math.ceil((tokens * price) / scale);
  }

  function build() {
    var curve = simulateCurve();
    var clear = clearAuction(CONFIG.cast, CONFIG.sellAmount);
    var board = CONFIG.storyboard;
    var commits = CONFIG.cast.map(function (bidder, i) {
      return {
        id: bidder.id,
        bot: !!bidder.bot,
        hash: bidder.hash,
        t: board.commitAt[i],
        tokenAmount: bidder.tokenAmount,
        filled: clear.filled[i],
        price: bidder.price,
      };
    });
    var reveals = commits.map(function (row, i) {
      return { t: board.revealAt + i * board.revealStep, index: i };
    });
    return { config: CONFIG, curve: curve, clear: clear, commits: commits, reveals: reveals };
  }

  var api = {
    CONFIG: CONFIG,
    buy: buy,
    simulateCurve: simulateCurve,
    clearAuction: clearAuction,
    payment: payment,
    build: build,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Harness = api;
})(typeof globalThis !== "undefined" ? globalThis : this);

if (typeof require !== "undefined" && require.main === module) {
  var h = require("./harness.js");
  var run = h.build();
  var fails = [];
  function check(name, cond) {
    if (!cond) fails.push(name);
  }
  var board = run.config.storyboard;
  check("clip is 20s", board.clipMs === 20000);
  check("curve cues inside the cut", board.curveAt.every(function (t) { return t > 0 && t < 20000; }));
  check("commit cues inside the cut", board.commitAt.every(function (t) { return t > 0 && t < board.revealAt; }));
  check("reveal finishes before clear", board.revealAt + (run.commits.length - 1) * board.revealStep < board.clearAt);
  check("clear before settle", board.clearAt < board.settleAt && board.settleAt < board.clipMs);
  check("eight curve fills", run.curve.fills.length === 8);
  check("bot owns the first three blocks", run.curve.fills.slice(0, 3).every(function (f) { return f.bot; }));
  check("humans are later blocks", run.curve.fills.slice(3).every(function (f) { return !f.bot && f.block > 3; }));
  check("first fill is 65217", run.curve.fills[0].tokensOut === 65217);
  var rising = true;
  for (var i = 0; i < run.curve.fills.length - 1; i++) {
    if (!(run.curve.fills[i].price < run.curve.fills[i + 1].price)) rising = false;
  }
  check("curve prices rise", rising);
  check("sale not oversold", run.curve.sold <= run.config.tokensForSale);
  check("bot is not the first commit", run.commits[0].bot !== true && run.commits.some(function (c) { return c.bot; }));
  check("demand covers the sale", run.clear.remaining === 0);
  check("one clearing price", run.clear.clearing === 360);
  check("filled volume is the sell amount", run.clear.filled.reduce(function (s, n) { return s + n; }, 0) === 380000);
  check("sniper filled in full at that price", run.commits.some(function (c) {
    return c.bot && c.filled === 120000;
  }));
  check("early low bid is refunded", run.commits[1].id === "e55c" && run.commits[1].filled === 0);
  check("marginal bid is partial", run.commits[3].id === "2d04" && run.commits[3].filled === 40000);
  check("no fill above its request", run.commits.every(function (c) { return c.filled <= c.tokenAmount; }));
  check("ceil payment does not favor the bidder", h.payment(1, 1, 100) === 1);
  if (fails.length) {
    console.error(fails.join("\n"));
    process.exit(1);
  }
  console.log("harness ok");
  console.log("curve bot tokens", run.curve.botTokens, "of sold", run.curve.sold);
  console.log("clearing", (run.clear.clearing / run.config.priceScale).toFixed(2));
}
