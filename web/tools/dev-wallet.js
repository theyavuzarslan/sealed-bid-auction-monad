// Development-only wallet shim. Inactive unless the URL has ?devwallet=<n>; then it acts as a
// browser wallet backed by local anvil (http://127.0.0.1:8545), using anvil's unlocked test account
// number n. Anvil signs transactions and typed data for its own test accounts, so the whole flow
// (connect, seal, commit, reveal, claim) runs in the browser with no extension. For local testing
// and demo recordings only: it never talks to anything but 127.0.0.1.
(function () {
  const idx = new URLSearchParams(location.search).get("devwallet");
  if (idx === null) return;
  // Only on a page served from this machine: a deployed site must never swap in a fake wallet.
  if (!/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname)) return;
  const RPC = "http://127.0.0.1:8545";
  let id = 0;
  let account = null;
  const call = (method, params = []) =>
    fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) })
      .then((r) => r.json())
      .then((j) => {
        if (j.error) throw Object.assign(new Error(j.error.message), { code: j.error.code, data: j.error.data });
        return j.result;
      });
  window.ethereum = {
    isDevWallet: true,
    async request({ method, params }) {
      if (method === "eth_requestAccounts" || method === "eth_accounts") {
        if (!account) account = (await call("eth_accounts"))[Number(idx) || 0];
        return [account];
      }
      if (method === "wallet_switchEthereumChain" || method === "wallet_addEthereumChain") return null;
      return call(method, params ?? []);
    },
    on() {},
    removeListener() {},
  };
  addEventListener("DOMContentLoaded", () => {
    const b = document.createElement("div");
    b.textContent = `Dev wallet · anvil account ${idx}`;
    b.setAttribute("role", "note");
    b.style.cssText = "position:fixed;right:12px;top:84px;z-index:99;background:#C6F24E;color:#17142B;font:400 11px/1 Silkscreen,monospace;text-transform:uppercase;padding:8px 10px;box-shadow:3px 3px 0 #0E100F";
    document.body.appendChild(b);
  });
})();
