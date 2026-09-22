// Minimal EIP-1193 wrapper over window.ethereum — no wallet library.
// TODO (Q11): wallet library choice is an open question; the injected provider is the minimum.

export function hasWallet() {
  return typeof window.ethereum !== "undefined";
}

export async function connectWallet() {
  if (!hasWallet()) throw new Error("No injected wallet found (window.ethereum)");
  const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
  return accounts[0];
}

export async function getChainId() {
  const hex = await window.ethereum.request({ method: "eth_chainId" });
  return parseInt(hex, 16);
}

export function onAccountsChanged(cb) {
  if (hasWallet() && typeof window.ethereum.on === "function") window.ethereum.on("accountsChanged", cb);
}

export function onChainChanged(cb) {
  if (hasWallet() && typeof window.ethereum.on === "function") window.ethereum.on("chainChanged", cb);
}

export async function sendTx({ from, to, data, value = "0x0" }) {
  return await window.ethereum.request({
    method: "eth_sendTransaction",
    params: [{ from, to, value, data }],
  });
}

export async function getReceipt(txHash, { pollMs = 1000, timeoutMs = 120000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = await window.ethereum.request({ method: "eth_getTransactionReceipt", params: [txHash] });
    if (r) return r;
    if (Date.now() > deadline) throw new Error("Transaction receipt timeout");
    await new Promise((res) => setTimeout(res, pollMs));
  }
}

export async function sendAndWait({ from, to, data, value = "0x0" }) {
  const txHash = await sendTx({ from, to, data, value });
  const receipt = await getReceipt(txHash);
  if (receipt.status !== "0x1") throw new Error(`Transaction reverted (tx ${txHash})`);
  return receipt;
}

export async function ethCall({ from, to, data }) {
  return await window.ethereum.request({
    method: "eth_call",
    params: [{ from, to, data }, "latest"],
  });
}

export async function getLogs({ address, topics, fromBlock = "0x0", toBlock = "latest" }) {
  return await window.ethereum.request({
    method: "eth_getLogs",
    params: [{ address, topics, fromBlock, toBlock }],
  });
}
