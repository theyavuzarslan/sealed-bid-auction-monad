// Minimal EIP-1193 wrapper over the injected wallet (window.ethereum). No wallet library.
import { revertReason } from "./engine.js";
import { toQuantity } from "./hex.js";

export function hasWallet() {
  return typeof window.ethereum !== "undefined";
}

const eth = (method, params = []) => {
  if (!hasWallet()) throw new Error("No injected wallet found");
  return window.ethereum.request({ method, params });
};

export async function connectWallet() {
  const accounts = await eth("eth_requestAccounts");
  return accounts[0] ?? null;
}

export async function currentAccount() {
  if (!hasWallet()) return null;
  const accounts = await eth("eth_accounts");
  return accounts[0] ?? null;
}

export async function walletChainId() {
  if (!hasWallet()) return null;
  return Number(BigInt(await eth("eth_chainId")));
}

export async function switchChain(net) {
  const hex = toQuantity(net.chainId);
  try {
    await eth("wallet_switchEthereumChain", [{ chainId: hex }]);
  } catch (e) {
    if (e?.code !== 4902 || !net.rpcUrl) throw e;
    await eth("wallet_addEthereumChain", [{
      chainId: hex, chainName: net.label, rpcUrls: [net.rpcUrl],
      nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
    }]);
  }
}

export function onWalletEvents(onAccounts, onChain) {
  if (!hasWallet() || typeof window.ethereum.on !== "function") return;
  window.ethereum.on("accountsChanged", (a) => onAccounts(a[0] ?? null));
  window.ethereum.on("chainChanged", (c) => onChain(Number(BigInt(c))));
}

export async function signTypedData(account, typedData) {
  return eth("eth_signTypedData_v4", [account, JSON.stringify(typedData)]);
}

function friendly(err) {
  if (err?.code === 4001) return new Error("Rejected in wallet");
  const r = revertReason(err);
  return r ? Object.assign(new Error(`Reverted: ${r}`), { reason: r }) : err;
}

// Simulates first so a revert shows its reason before the wallet prompt, then sends and waits.
export async function sendTx(from, t, { onHash } = {}) {
  const tx = { from, to: t.to, data: t.data, value: toQuantity(t.value ?? 0n) };
  try {
    await eth("eth_call", [tx, "latest"]);
  } catch (e) {
    throw friendly(e);
  }
  let hash;
  try {
    hash = await eth("eth_sendTransaction", [tx]);
  } catch (e) {
    throw friendly(e);
  }
  onHash?.(hash);
  for (let i = 0; ; i++) {
    const rc = await eth("eth_getTransactionReceipt", [hash]);
    if (rc) {
      if (rc.status !== "0x1") throw new Error(`Transaction reverted (${hash})`);
      return rc;
    }
    if (i > 600) throw new Error(`No receipt yet for ${hash}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

export function feeOf(receipt) {
  return BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice ?? "0x0");
}
