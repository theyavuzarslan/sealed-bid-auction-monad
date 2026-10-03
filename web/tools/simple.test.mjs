// Grid tests for web/js/simple.js: every launch the wizard accepts must pass buildOpenParams (which
// mirrors AuctionEngine._validate), and every bid it builds must pass bidProblems, sit on the tick
// grid, stay below the deposit and never spend more than the bidder asked.
// Run: node web/tools/simple.test.mjs
import "../node-env.mjs";
const { simpleLaunchForm, simpleBid, PRICE_MULTIPLES, tickFor, groupDigits } = await import("../js/simple.js");
const { buildOpenParams } = await import("../js/launch.js");
const { parseUnits, perTokenToWire } = await import("../js/bid.js");

let pass = 0, fail = 0;
const failures = [];
const check = (name, ok) => { if (ok) pass++; else { fail++; if (failures.length < 15) failures.push(name); } };

const ADAPTER = "0x9fe46736679d2d9a65f0992f2272de9f3c7fa6e0";
const NOW = 1_800_000_000;

check("tickFor small", tickFor(5n) === 1n && tickFor(999n) === 1n);
check("tickFor keeps 3 digits", tickFor(123456789n) === 1000000n && tickFor(1000n) === 10n);
check("groupDigits", groupDigits("1234567.891") === "1,234,567.891" && groupDigits("12") === "12" && groupDigits("-1000") === "-1,000");

let launches = 0, accepted = 0, bids = 0, bidOk = 0;
for (const decimals of [18, 8, 6]) {
  for (const supplyWhole of [1_000_000n, 1_000_000_000n, 1_000_000_000_000n]) {
    const supply = supplyWhole * 10n ** BigInt(decimals);
    for (const sellPct of ["1", "50", "100"]) {
      for (const floorMon of ["0.01", "1", "100", "100000"]) {
        for (const depositMon of ["0.1", "5", "1000"]) {
          for (const preset of ["Degen", "Raise"]) {
            launches++;
            const w = simpleLaunchForm({ preset, supply, sellPct, floorMon, depositMon, duration: "10m", lpPct: "20", adapter: ADAPTER, fee: 3000 }, decimals);
            const tag = `${decimals}d ${supplyWhole} sell${sellPct}% floor${floorMon} dep${depositMon} ${preset}`;
            if (w.problems.length) continue; // the wizard refused with a message; nothing to cross-check
            accepted++;
            const { params, problems } = buildOpenParams(w.form, { address: ADAPTER, decimals }, NOW);
            check(`launch accepted by buildOpenParams: ${tag} → ${problems.join(" | ")}`, problems.length === 0);
            if (problems.length) continue;
            check(`reserve on tick grid: ${tag}`, params.reservePrice % params.tickSize === 0n);
            check(`reserve matches derived: ${tag}`, params.reservePrice === w.derived.reserveWire);
            check(`floor not exceeded by rounding: ${tag}`, w.derived.reserveWire * w.derived.sellAmount <= parseUnits(floorMon, 18) * 10n ** 18n);
            const round = { reservePrice: params.reservePrice, tickSize: params.tickSize, depositAmount: params.depositAmount, minBidSize: params.minBidSize, sellAmount: params.sellAmount };
            for (const mul of PRICE_MULTIPLES) {
              for (const spendMon of ["0.05", "0.5", "3", "999999"]) {
                bids++;
                const b = simpleBid({ round, spendMon, priceMultiple: mul }, decimals);
                const btag = `${tag} ×${mul} spend${spendMon}`;
                if (b.error || b.empty) { check(`bid parse: ${btag}`, false); continue; }
                check(`bid on grid and ≥ reserve: ${btag}`, b.price % round.tickSize === 0n && b.price >= round.reservePrice);
                check(`bid spend below deposit: ${btag}`, b.spend < round.depositAmount);
                check(`bid never spends more than asked: ${btag}`, b.spend <= parseUnits(spendMon, 18));
                if (b.problems.length === 0) bidOk++;
                else check(`bid problems are only the minimum-size rule: ${btag} → ${b.problems.map((p) => p.code)}`, b.problems.every((p) => p.code === "BELOW_MIN_BID" || p.code === "ZERO_AMOUNT"));
              }
            }
            // A custom per-token price is snapped down, never up.
            const per = perTokenToWire(parseUnits("0.000000123456789", 18), decimals);
            const c = simpleBid({ round, spendMon: "1", customPerToken: "0.000000123456789" }, decimals);
            check(`custom price snaps down or lifts to reserve: ${tag}`, c.price <= (per > round.reservePrice ? per : round.reservePrice));
          }
        }
      }
    }
  }
}
check(`most wizard launches are valid (${accepted}/${launches})`, accepted > launches * 0.6);
check(`most bids are valid (${bidOk}/${bids})`, bidOk > bids * 0.5);

if (failures.length) console.log(failures.map((f) => "FAIL  " + f).join("\n"));
console.log(`simple: ${pass}/${pass + fail} passed (${accepted}/${launches} launches accepted, ${bidOk}/${bids} bids valid)`);
process.exit(fail ? 1 : 0);
