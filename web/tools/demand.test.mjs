// Tests for web/js/demand.js, the demand meter on the round page: deposits locked against the value
// of the whole sale at the floor price. It must stay an upper bound that is never overstated, never
// coerce through Number, and be independent of token decimals.
// Run: node web/tools/demand.test.mjs
import "../node-env.mjs";
const { depositCover, coverLabel, coverGauge, demandCopy } = await import("../js/demand.js");
const { perTokenToWire, parseUnits, UINT96_MAX } = await import("../js/bid.js");

let pass = 0, fail = 0;
const check = (name, ok) => { if (ok) pass++; else { fail++; console.log("FAIL  " + name); } };
const E18 = 10n ** 18n;

// A round in contract units: `sellWhole` tokens for sale at `floorPerToken` MON each, `decimals` places.
const round = ({ decimals, sellWhole, floorPerToken, depositMon }) => ({
  sellAmount: sellWhole * 10n ** BigInt(decimals),
  reservePrice: perTokenToWire(parseUnits(floorPerToken, 18), decimals),
  depositAmount: parseUnits(depositMon, 18),
});

// ── zero commits ──
{
  const r = round({ decimals: 18, sellWhole: 500_000n, floorPerToken: "0.00001", depositMon: "10" });
  const c = depositCover({ ...r, commits: 0n });
  check("zero commits: nothing locked", c.locked === 0n);
  check("zero commits: kind none", c.kind === "none");
  check("zero commits: floor value 5 MON", c.floorValue === 5n * E18);
  check("zero commits: gauge empty", coverGauge(c.coverBps).lit === 0);
  check("zero commits: copy says no bids", /No sealed bids yet/.test(demandCopy(c).headline));
}

// ── cover > 1 (the record-round.sh demo round: 4 × 10 MON against 5 MON at the floor = 8×) ──
{
  const r = round({ decimals: 18, sellWhole: 500_000n, floorPerToken: "0.00001", depositMon: "10" });
  const c = depositCover({ ...r, commits: 4n });
  check("cover>1: locked 40 MON", c.locked === 40n * E18);
  check("cover>1: 8×", c.coverBps === 80000n && c.kind === "over");
  check("cover>1: label drops a zero decimal", coverLabel(c.coverBps) === "8×");
  const g = coverGauge(c.coverBps);
  check("cover>1: gauge scale 8, full, 1× mark at 12.5%", g.scale === 8 && g.lit === 20 && g.markPct === 12.5);
  const copy = demandCopy(c);
  check("cover>1: headline", copy.headline === "Deposits locked could buy the whole sale 8× over at the floor price.");
  check("cover>1: parts rebuild the headline", copy.before + copy.figure + copy.after === copy.headline && copy.figure === "8×");
}
{
  // 2.4× exactly, and a value just under it rounds down, never up.
  const base = { sellAmount: 1000n * E18, reservePrice: E18, depositAmount: 100n * E18 }; // floor value 1000 MON
  check("cover 2.4×", coverLabel(depositCover({ ...base, commits: 24n }).coverBps) === "2.4×");
  const justUnder = depositCover({ ...base, depositAmount: 100n * E18 - 1n, commits: 24n });
  check("cover just under 2.4× reads 2.3×", coverLabel(justUnder.coverBps) === "2.3×");
  check("exactly 1× is over", depositCover({ ...base, commits: 10n }).kind === "over");
  check("1× label", coverLabel(depositCover({ ...base, commits: 10n }).coverBps) === "1×");
  check("1.9× label", coverLabel(19999n) === "1.9×");
  const g = coverGauge(depositCover({ ...base, commits: 24n }).coverBps);
  check("2.4× gauge: scale 3, 16 of 20 lit, mark at a third", g.scale === 3 && g.lit === 16 && Math.abs(g.markPct - 100 / 3) < 1e-9);
  check("gauge caps at maxScale", coverGauge(1_000_000n).scale === 10 && coverGauge(1_000_000n).lit === 20);
  check("thousands grouped", coverLabel(123_456_7890n) === "123,456.7×");
}

// ── cover < 1 ──
{
  const base = { sellAmount: 1000n * E18, reservePrice: E18, depositAmount: 100n * E18 }; // floor 1000 MON
  const c = depositCover({ ...base, commits: 4n });
  check("cover<1: 40%", c.coverBps === 4000n && c.kind === "under" && coverLabel(c.coverBps) === "40%");
  check("cover<1: headline", demandCopy(c).headline === "Deposits locked cover 40% of the sale at the floor price.");
  const g = coverGauge(c.coverBps);
  check("cover<1: gauge scale 1, 8 of 20 lit, mark at the end", g.scale === 1 && g.lit === 8 && g.markPct === 100);
  const tiny = depositCover({ ...base, depositAmount: 1n * E18, commits: 1n }); // 0.1%
  check("tiny cover reads under 1%", coverLabel(tiny.coverBps) === "under 1%");
  check("tiny cover still lights one cell", coverGauge(tiny.coverBps).lit === 1);
  const r = depositCover({ ...base, depositAmount: 99_999n * 10n ** 15n, commits: 1n }); // 99.999 MON → 9.9999%
  check("percent rounds down", coverLabel(r.coverBps) === "9%");
}

// ── decimals: the same sale in whole tokens gives the same floor value whatever the decimals ──
{
  const values = [18, 8, 6, 0].map((decimals) => {
    const r = round({ decimals, sellWhole: 1_000_000n, floorPerToken: "0.002", depositMon: "5" });
    return depositCover({ ...r, commits: 3n });
  });
  check("decimals: floor value 2,000 MON for 18/8/6/0", values.every((c) => c.floorValue === 2000n * E18));
  check("decimals: same cover for 18/8/6/0", values.every((c) => c.coverBps === values[0].coverBps && c.coverBps === 75n));
  check("decimals: 0.75% reads under 1%", coverLabel(values[0].coverBps) === "under 1%");
  // A 6-decimal token whose floor price does not divide evenly: the floor value is rounded up.
  const odd = depositCover({ sellAmount: 3n, reservePrice: perTokenToWire(1n, 6), commits: 1n, depositAmount: 1n });
  check("decimals: floor value rounds up (6 dec, 3 base units at 1 wei per token)", odd.floorValue === 1n);
}

// ── huge numbers: no Number coercion anywhere ──
{
  const commits = 2n ** 60n + 7n; // > 2^53
  const c = depositCover({ commits, depositAmount: UINT96_MAX, sellAmount: UINT96_MAX, reservePrice: UINT96_MAX });
  const floorValue = (UINT96_MAX * UINT96_MAX - 1n) / E18 + 1n;
  check("huge: locked exact", c.locked === commits * UINT96_MAX);
  check("huge: floor value exact (ceil)", c.floorValue === floorValue);
  check("huge: cover exact", c.coverBps === (commits * UINT96_MAX * 10000n) / floorValue);
  const big = depositCover({ commits, depositAmount: UINT96_MAX, sellAmount: 1n, reservePrice: E18 }); // floor 1 wei
  check("huge: enormous cover is exact", big.coverBps === commits * UINT96_MAX * 10000n && big.kind === "over");
  const tenths = big.coverBps / 1000n;
  check("huge: label keeps every digit", coverLabel(big.coverBps).replace(/[,×.]/g, "") === String(tenths % 10n ? tenths : tenths / 10n));
  check("huge: gauge capped", coverGauge(big.coverBps).scale === 10 && coverGauge(big.coverBps).lit === 20);
}

// ── upper bound is never overstated: brute force small values against exact rationals ──
{
  let ok = true;
  for (let price = 1n; price <= 40n && ok; price += 3n)
    for (let sell = 1n; sell <= 3n * E18 && ok; sell += E18 / 3n + 7n)
      for (let commits = 0n; commits <= 5n && ok; commits++) {
        const deposit = 10n ** 17n + price;
        const c = depositCover({ commits, depositAmount: deposit, sellAmount: sell, reservePrice: price * 10n ** 12n });
        // coverBps / 10000 <= locked / (exact floor value) = locked × 1e18 / (sell × price)
        if (c.coverBps * sell * price * 10n ** 12n > commits * deposit * 10000n * E18) ok = false;
      }
  check("cover never exceeds the exact ratio", ok);
}

// ── unknown floor value ──
{
  const c = depositCover({ commits: 2n, depositAmount: E18, sellAmount: 0n, reservePrice: E18 });
  check("no floor value: kind unknown, no cover", c.kind === "unknown" && c.coverBps === null);
  check("no floor value: gauge empty", coverGauge(c.coverBps).lit === 0);
}

// ── copy rules (CLAUDE.md claim wording): upper bound named, no banned claims, no bid knowledge ──
{
  const cases = [
    depositCover({ commits: 0n, depositAmount: E18, sellAmount: E18, reservePrice: E18 }),
    depositCover({ commits: 3n, depositAmount: E18, sellAmount: E18, reservePrice: E18 }),
    depositCover({ commits: 3n, depositAmount: E18, sellAmount: 100n * E18, reservePrice: E18 }),
    depositCover({ commits: 3n, depositAmount: E18, sellAmount: 0n, reservePrice: E18 }),
  ];
  const text = cases.map((c) => Object.values(demandCopy(c)).join(" ")).join(" ");
  check("copy names the upper bound", /upper bound/i.test(demandCopy(cases[1]).foot));
  check("copy has no banned claims", !/no sniping|bot-proof|mev-proof|mempool|guarantee/i.test(text));
  check("copy never claims to know a bid", !/(average|typical|expected) (bid|price)|bids? (are|is) (at|above)/i.test(text));
}

console.log(`demand: ${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
