// Unit tests for the passkey EIP-1193 shim (makeProvider in web/js/passkey-wallet.js), driven with a
// fake viem and a fake account so no CDN load, WebAuthn ceremony or RPC is needed.
// Run: node web/tools/passkey.test.mjs
const { makeProvider } = await import("../js/passkey-wallet.js");

let pass = 0, fail = 0;
const failures = [];
const check = (name, ok) => { if (ok) pass++; else { fail++; failures.push(name); } };
const rejects = async (p) => { try { await p; return null; } catch (e) { return e; } };

const ADDRESS = "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01";
const NET = { chainId: 10143, label: "Monad testnet", rpcUrl: "http://rpc.test" };

function fakes() {
  const calls = { sent: [], typed: [], signed: [], pub: [], chain: null, http: [] };
  const viem = {
    defineChain: (c) => { calls.chain = c; return c; },
    http: (url) => { calls.http.push(url); return { url }; },
    toHex: (n) => "0x" + BigInt(n).toString(16),
    createWalletClient: () => ({ sendTransaction: async (tx) => { calls.sent.push(tx); return "0xhash"; } }),
    createPublicClient: () => ({ request: async (r) => { calls.pub.push(r); return "0xpub"; } }),
  };
  const account = {
    address: ADDRESS,
    signTypedData: async (td) => { calls.typed.push(td); return "0xtyped"; },
    signMessage: async (m) => { calls.signed.push(m); return "0xsigned"; },
  };
  return { calls, provider: makeProvider(viem, account, NET) };
}

// Setup: chain and transport come from the network config.
{
  const { calls, provider } = fakes();
  check("isPasskey flag", provider.isPasskey === true);
  check("chain id and name from net", calls.chain.id === 10143 && calls.chain.name === "Monad testnet");
  check("chain currency is MON with 18 decimals", calls.chain.nativeCurrency.symbol === "MON" && calls.chain.nativeCurrency.decimals === 18);
  check("transport uses net.rpcUrl", calls.http.every((u) => u === NET.rpcUrl) && calls.chain.rpcUrls.default.http[0] === NET.rpcUrl);
}

// Accounts and chain id.
{
  const { calls, provider } = fakes();
  const req = await provider.request({ method: "eth_requestAccounts" });
  const acc = await provider.request({ method: "eth_accounts" });
  check("eth_requestAccounts returns the lowercased address", req.length === 1 && req[0] === ADDRESS.toLowerCase());
  check("eth_accounts matches eth_requestAccounts", acc[0] === req[0]);
  check("eth_chainId is hex of net.chainId", (await provider.request({ method: "eth_chainId" })) === "0x279f");
  check("accounts and chainId never reach the RPC", calls.pub.length === 0);
}

// Chain switching: same chain accepted, anything else refused with 4902.
{
  const { calls, provider } = fakes();
  check("switch to the same chain returns null", (await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x279f" }] })) === null);
  check("add the same chain returns null", (await provider.request({ method: "wallet_addEthereumChain", params: [{ chainId: "0x279f", chainName: "x" }] })) === null);
  const e1 = await rejects(provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x1" }] }));
  check("switch to another chain refused with 4902", e1?.code === 4902 && /Monad testnet/.test(e1.message));
  const e2 = await rejects(provider.request({ method: "wallet_addEthereumChain", params: [{ chainId: "0x8f" }] }));
  check("add another chain refused with 4902", e2?.code === 4902);
  const e3 = await rejects(provider.request({ method: "wallet_switchEthereumChain" }));
  check("switch without params refused", e3?.code === 4902);
  check("chain switching never reaches the RPC", calls.pub.length === 0);
}

// eth_sendTransaction: hex quantities become bigints, value defaults to 0, gas left to viem when absent.
{
  const { calls, provider } = fakes();
  const h = await provider.request({ method: "eth_sendTransaction", params: [{ from: ADDRESS, to: "0xdead", data: "0x1234", value: "0xde0b6b3a7640000", gas: "0x5208" }] });
  const t = calls.sent[0];
  check("send returns the wallet's hash", h === "0xhash");
  check("send passes to and data", t.to === "0xdead" && t.data === "0x1234");
  check("send converts value to bigint", t.value === 10n ** 18n);
  check("send converts gas to bigint", t.gas === 21000n);
  check("send drops from (the account signs)", !("from" in t));
  await provider.request({ method: "eth_sendTransaction", params: [{ to: "0xdead", data: "0x" }] });
  const u = calls.sent[1];
  check("send defaults value to 0n", u.value === 0n);
  check("send leaves gas undefined for viem to estimate", u.gas === undefined);
}

// eth_signTypedData_v4: accepts a JSON string or an object, strips EIP712Domain, keeps the caller's types.
{
  const { calls, provider } = fakes();
  const td = {
    types: {
      EIP712Domain: [{ name: "name", type: "string" }, { name: "chainId", type: "uint256" }],
      Permit: [{ name: "owner", type: "address" }, { name: "value", type: "uint256" }],
    },
    domain: { name: "Even", chainId: 10143 },
    primaryType: "Permit",
    message: { owner: ADDRESS, value: "5" },
  };
  const sig = await provider.request({ method: "eth_signTypedData_v4", params: [ADDRESS, JSON.stringify(td)] });
  const a = calls.typed[0];
  check("typed data returns the account's signature", sig === "0xtyped");
  check("typed data (string) drops EIP712Domain", !("EIP712Domain" in a.types) && Object.keys(a.types).join() === "Permit");
  check("typed data keeps domain, primaryType and message", a.domain.name === "Even" && a.primaryType === "Permit" && a.message.value === "5");
  await provider.request({ method: "eth_signTypedData_v4", params: [ADDRESS, td] });
  const b = calls.typed[1];
  check("typed data (object) drops EIP712Domain", !("EIP712Domain" in b.types) && "Permit" in b.types);
  check("caller's typed data object is not mutated", "EIP712Domain" in td.types);
  check("typed data never reaches the RPC", calls.pub.length === 0);
}

// personal_sign signs the raw bytes given.
{
  const { calls, provider } = fakes();
  const sig = await provider.request({ method: "personal_sign", params: ["0x68656c6c6f", ADDRESS] });
  check("personal_sign returns the account's signature", sig === "0xsigned");
  check("personal_sign signs params[0] as raw", calls.signed[0]?.message?.raw === "0x68656c6c6f");
}

// Everything else goes to the public client unchanged.
{
  const { calls, provider } = fakes();
  const r = await provider.request({ method: "eth_getBalance", params: [ADDRESS, "latest"] });
  check("read methods forward to the public client", r === "0xpub" && calls.pub[0].method === "eth_getBalance" && calls.pub[0].params[1] === "latest");
  await provider.request({ method: "eth_blockNumber" });
  check("missing params forward as []", Array.isArray(calls.pub[1].params) && calls.pub[1].params.length === 0);
  check("forwarded reads do not sign or send", calls.sent.length === 0 && calls.typed.length === 0 && calls.signed.length === 0);
}

// Event listeners: on / removeListener do not throw and remove only the given function.
{
  const { provider } = fakes();
  const f = () => {}, g = () => {};
  let ok = true;
  try { provider.on("accountsChanged", f); provider.on("accountsChanged", g); provider.removeListener("accountsChanged", f); provider.removeListener("chainChanged", f); }
  catch { ok = false; }
  check("on / removeListener work without throwing", ok);
}

if (failures.length) console.log(failures.map((f) => "FAIL  " + f).join("\n"));
console.log(`passkey: ${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
