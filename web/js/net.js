// Active network, its deployment addresses, and the read transport.
// Reads go to the network's rpcUrl when set (works without a wallet); otherwise through the wallet.
import cfg from "../config.js";
import { makeEngine } from "./engine.js";
import { isAddress } from "./hex.js";

const NET_KEY = "sba.network";
const overrideKey = (name) => `sba.deployment.${name}`;

function lsGet(k) {
  try { return localStorage.getItem(k); } catch { return null; }
}
function lsSet(k, v) {
  try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* storage blocked */ }
}

export function networkName() {
  const n = lsGet(NET_KEY);
  return n && cfg.networks[n] ? n : cfg.defaultNetwork;
}

export function setNetworkName(n) {
  lsSet(NET_KEY, n);
}

let fetched = {}; // name -> deployment loaded from deploymentUrls
let fetchedFrom = {};

export async function loadDeployment() {
  const name = networkName();
  const net = cfg.networks[name];
  for (const url of net.deploymentUrls ?? []) {
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) continue;
      const j = await res.json();
      if (isAddress(j.auctionEngine)) {
        fetched[name] = j;
        fetchedFrom[name] = url;
        return;
      }
    } catch { /* not served: fall back to config */ }
  }
}

export function setDeploymentOverride(jsonText) {
  const name = networkName();
  if (jsonText == null) return lsSet(overrideKey(name), null);
  const j = JSON.parse(jsonText);
  if (!isAddress(j.auctionEngine)) throw new Error("auctionEngine is not an address");
  lsSet(overrideKey(name), JSON.stringify(j));
}

export function network() {
  const name = networkName();
  const net = cfg.networks[name];
  let deployment = { ...net.deployment };
  let source = "config.js";
  if (fetched[name]) { deployment = { ...deployment, ...fetched[name] }; source = fetchedFrom[name]; }
  const o = lsGet(overrideKey(name));
  if (o) {
    try { deployment = { ...deployment, ...JSON.parse(o) }; source = "pasted override"; } catch { /* ignore */ }
  }
  return { name, ...net, deployment, source };
}

let rpcId = 0;
export async function readRequest(method, params) {
  const net = network();
  if (net.rpcUrl) {
    const res = await fetch(net.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
    });
    const j = await res.json();
    if (j.error) throw Object.assign(new Error(j.error.message), { data: j.error.data, code: j.error.code });
    return j.result;
  }
  if (!globalThis.ethereum) throw new Error("No read RPC configured for this network and no wallet connected");
  return globalThis.ethereum.request({ method, params });
}

export function engine() {
  const net = network();
  if (!isAddress(net.deployment.auctionEngine)) return null;
  return makeEngine({
    request: readRequest,
    address: net.deployment.auctionEngine,
    fromBlock: BigInt(net.fromBlock ?? 0),
    logChunk: net.logChunk,
  });
}

// Chain time, so countdowns follow anvil time warps and not only the local clock.
let clockOffset = 0;
export async function syncClock() {
  const b = await readRequest("eth_getBlockByNumber", ["latest", false]);
  clockOffset = Number(BigInt(b.timestamp)) - Date.now() / 1000;
  return Number(BigInt(b.timestamp));
}
export function chainNow() {
  return Math.floor(Date.now() / 1000 + clockOffset);
}
