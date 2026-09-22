#!/usr/bin/env node
// Turn bidder-journey gas (commit + reveal + claim) into MON and USD, against the PRD budget of
// < $0.01 in network fees per journey. No MON price is built in: pass it with --mon-usd.
//
// Gas input, one of:
//   forge script script/FeeProbe.s.sol --isolate | node fee-report.mjs --gas-price 102gwei
//                                        (reads the FEEPROBE lines from stdin, or --probe <file>)
//   node fee-report.mjs --commit 78805 --reveal 163243 --claim 175974 --gas-price 102gwei
// Gas price, one of:
//   --gas-price <wei | N gwei>      e.g. 102000000000 or 102gwei
//   --rpc <url>                      reads eth_gasPrice (read-only), e.g. https://rpc.monad.xyz
// Optional:
//   --mon-usd <price>               MON/USD; without it the report gives MON and the break-even MON price
//   --basis needed|used              which probe figure to price (default: needed). Monad charges
//                                    gas LIMIT x price, not gas used; `needed` (pre-refund gas) is the
//                                    floor of the limit a wallet must set.
//   --buffer <pct>                   extra gas-limit headroom a wallet adds on top (default 0)
//   --json                           machine-readable output

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRpc } from "./rpc.mjs";

const BUDGET_USD = 0.01;

export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) throw new Error(`unexpected argument ${a}`);
    const key = a.slice(2);
    if (key === "json") out.json = true;
    else out[key] = argv[++i];
    if (out[key] === undefined) throw new Error(`missing value for --${key}`);
  }
  return out;
}

export function parseGasPrice(s) {
  const m = String(s).trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*(gwei|wei)?$/);
  if (!m) throw new Error(`bad gas price ${s}`);
  if (m[2] === "gwei") {
    const [int, frac = ""] = m[1].split(".");
    return BigInt(int) * 10n ** 9n + BigInt((frac + "000000000").slice(0, 9));
  }
  if (m[1].includes(".")) throw new Error("fractional wei");
  return BigInt(m[1]);
}

/** FEEPROBE {json} lines -> journeys. Steps a bidder never took have gas 0 and are marked incomplete. */
export function parseProbe(text) {
  return text
    .split("\n")
    .map((l) => l.match(/FEEPROBE\s+(\{.*\})\s*$/))
    .filter(Boolean)
    .map((m) => JSON.parse(m[1]));
}

export function formatMon(wei) {
  const s = wei.toString().padStart(19, "0");
  return `${s.slice(0, -18)}.${s.slice(-18)}`.replace(/(\.\d*?[1-9])0+$/, "$1").replace(/\.0+$/, ".0");
}

export function report({ journeys, gasPrice, monUsd = null, basis = "needed", bufferPct = 0 }) {
  const rows = journeys.map((j) => {
    const g = (step) => {
      const v = j[step];
      if (v == null) return 0n;
      const base = BigInt(typeof v === "object" ? v[basis] : v);
      return (base * BigInt(Math.round((100 + bufferPct) * 100))) / 10000n;
    };
    const gas = { commit: g("commit"), reveal: g("reveal"), claim: g("claim") };
    const total = gas.commit + gas.reveal + gas.claim;
    const feeWei = total * gasPrice;
    const usd = monUsd == null ? null : (Number(feeWei) / 1e18) * monUsd;
    return {
      label: j.label ?? "journey",
      complete: gas.commit > 0n && gas.reveal > 0n && gas.claim > 0n,
      gas,
      totalGas: total,
      feeWei,
      feeMon: formatMon(feeWei),
      feeUsd: usd,
      breakEvenMonUsd: feeWei === 0n ? null : BUDGET_USD / (Number(feeWei) / 1e18),
    };
  });
  const complete = rows.filter((r) => r.complete);
  const worst = complete.reduce((w, r) => (w == null || r.feeWei > w.feeWei ? r : w), null);
  return {
    gasPriceWei: gasPrice,
    basis,
    bufferPct,
    monUsd,
    budgetUsd: BUDGET_USD,
    rows,
    worst,
    verdict:
      worst == null
        ? "no complete journey in input"
        : monUsd == null
          ? `cannot judge without a MON/USD price; the worst journey stays under $${BUDGET_USD} while MON < $${worst.breakEvenMonUsd.toFixed(4)}`
          : worst.feeUsd < BUDGET_USD
            ? `PASS: worst complete journey costs $${worst.feeUsd.toFixed(6)} < $${BUDGET_USD}`
            : `FAIL: worst complete journey costs $${worst.feeUsd.toFixed(6)} >= $${BUDGET_USD}`,
  };
}

function printText(r, source) {
  const gwei = Number(r.gasPriceWei) / 1e9;
  console.log(`Gas price: ${r.gasPriceWei} wei (${gwei} gwei)${source ? ` from ${source}` : ""}`);
  console.log(`Priced gas: ${r.basis}${r.bufferPct ? ` + ${r.bufferPct}% buffer` : ""} (Monad charges gas limit x price)`);
  console.log(`MON/USD: ${r.monUsd ?? "not supplied"}`);
  console.log("");
  for (const row of r.rows) {
    const usd = row.feeUsd == null ? "" : `  $${row.feeUsd.toFixed(6)}`;
    const tag = row.complete ? "" : "  (incomplete journey)";
    console.log(
      `${row.label.padEnd(42)} commit ${String(row.gas.commit).padStart(7)}  reveal ${String(row.gas.reveal).padStart(7)}  claim ${String(row.gas.claim).padStart(7)}  = ${String(row.totalGas).padStart(7)} gas  ${row.feeMon} MON${usd}${tag}`,
    );
  }
  console.log("");
  console.log(r.verdict);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let source = null;
  let gasPrice;
  if (args["gas-price"]) gasPrice = parseGasPrice(args["gas-price"]);
  else if (args.rpc) {
    gasPrice = BigInt(await createRpc(args.rpc)("eth_gasPrice"));
    source = `eth_gasPrice at ${args.rpc}`;
  } else throw new Error("pass --gas-price or --rpc");

  let journeys;
  if (args.commit || args.reveal || args.claim) {
    journeys = [{ label: "journey", commit: args.commit ?? 0, reveal: args.reveal ?? 0, claim: args.claim ?? 0 }];
  } else {
    const text = args.probe ? fs.readFileSync(args.probe, "utf8") : process.stdin.isTTY ? "" : fs.readFileSync(0, "utf8");
    journeys = parseProbe(text);
    if (!journeys.length) throw new Error("no FEEPROBE lines found: pipe FeeProbe output in, or pass --commit/--reveal/--claim");
  }
  const basis = args.basis ?? "needed";
  if (!["needed", "used"].includes(basis)) throw new Error("--basis must be needed or used");
  const r = report({
    journeys,
    gasPrice,
    monUsd: args["mon-usd"] == null ? null : Number(args["mon-usd"]),
    basis,
    bufferPct: Number(args.buffer ?? 0),
  });
  if (args.json) console.log(JSON.stringify({ source, ...r }, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  else printText(r, source);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
