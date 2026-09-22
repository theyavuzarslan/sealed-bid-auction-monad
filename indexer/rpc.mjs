// JSON-RPC over fetch (Node >= 18). No dependencies.

export function createRpc(url, { timeoutMs = 15_000 } = {}) {
  let id = 0;
  return async function rpc(method, params = []) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`rpc ${method}: HTTP ${res.status}`);
    const body = await res.json();
    if (body.error) throw new Error(`rpc ${method}: ${JSON.stringify(body.error)}`);
    return body.result;
  };
}

export const toHex = (n) => "0x" + BigInt(n).toString(16);
