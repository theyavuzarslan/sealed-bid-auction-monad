// Passkey accounts with Mera (Category Labs): Face ID / Touch ID / a security key derives an ordinary
// EVM account, with no extension, seed phrase prompt, smart account or custody service.
// Recipe: https://mera.category.xyz/recipes/create-passkey-accounts/ — PRF output → BIP-39 entropy →
// BIP-44 m/44'/60'/0'/0/0 → secp256k1 session → viem local account. The resulting EIP-1193 provider
// plugs into wallet.js, so every screen works unchanged. Libraries load from jsDelivr only when the
// visitor chooses a passkey, at pinned versions (viem matches the version Mera's adapter imports).
const CDN = "https://cdn.jsdelivr.net/npm/";
const LIBS = {
  mera: "@category-labs/mera@0.2.0/+esm",
  meraViem: "@category-labs/mera@0.2.0/dist/viem.js/+esm",
  viem: "viem@2.55.13/+esm",
  bip39: "@scure/bip39@2.4.0/+esm",
  wordlist: "@scure/bip39@2.4.0/wordlists/english.js/+esm",
  bip32: "@scure/bip32@2.4.0/+esm",
};
const CREDENTIAL_KEY = "sba.passkey.credential";
const EVM_PATH = "m/44'/60'/0'/0/0";

let libs = null;
async function load() {
  if (!libs) {
    const entries = await Promise.all(Object.entries(LIBS).map(async ([k, p]) => [k, await import(CDN + p)]));
    libs = Object.fromEntries(entries);
  }
  return libs;
}

const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode: sign-in still works */ } };

/** True when this browser can make passkeys at all. PRF support is only known at the ceremony. */
export function passkeySupported() {
  return typeof window !== "undefined" && window.isSecureContext && typeof window.PublicKeyCredential === "function";
}

export function hasStoredPasskey() {
  return lsGet(CREDENTIAL_KEY) != null;
}

// The test hook below is how the local suite exercises everything after the WebAuthn ceremony.
const isLocalHost = () => /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);

/**
 * Runs the passkey ceremony and returns { provider, address, mnemonic(), end() }.
 * mode "create" makes a new passkey; "signin" uses an existing one (the browser offers its passkeys).
 */
export async function connectPasskey({ mode, net }) {
  const L = await load();
  const rpId = location.hostname;
  let prfOutput;
  const testSeed = new URLSearchParams(location.search).get("passkeytest");
  if (testSeed !== null && isLocalHost()) {
    // Local only: a fixed 32-byte "PRF output" so the derivation, signing and sending path can be
    // tested against anvil without an authenticator. Never active on a deployed site.
    prfOutput = L.viem.hexToBytes(L.viem.keccak256(L.viem.toHex(`even-passkey-test-${testSeed}`)));
  } else if (mode === "create") {
    const created = await L.mera.createPasskeyWithPrfOutput({
      rp: { id: rpId, name: "Even" },
      user: { name: `even-${new Date().toISOString().slice(0, 10)}`, displayName: "Even account" },
    });
    lsSet(CREDENTIAL_KEY, JSON.stringify({ credentialId: created.credentialId, transports: created.transports }));
    prfOutput = created.prfOutput;
  } else {
    const stored = lsGet(CREDENTIAL_KEY);
    const known = stored ? JSON.parse(stored) : undefined;
    const got = await L.mera.getPasskeyPrfOutput({ rpId, credential: known });
    lsSet(CREDENTIAL_KEY, JSON.stringify(known?.credentialId === got.credentialId ? known : { credentialId: got.credentialId }));
    prfOutput = got.prfOutput;
  }

  const words = L.bip39.entropyToMnemonic(prfOutput, L.wordlist.wordlist);
  const seed = L.bip39.mnemonicToSeedSync(words);
  const node = L.bip32.HDKey.fromMasterSeed(seed).derive(EVM_PATH);
  if (!node.privateKey) throw new Error("Passkey derivation produced no key");
  const session = L.mera.createSecp256k1SigningSession({ privateKey: node.privateKey });
  const account = L.meraViem.toViemAccount(session);
  const provider = makeProvider(L.viem, account, net);
  return {
    provider,
    address: account.address,
    mnemonic: () => words, // shown only when the visitor asks to back it up
    end: () => session.end(),
  };
}

function makeProvider(viem, account, net) {
  const chain = viem.defineChain({
    id: net.chainId,
    name: net.label,
    nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
    rpcUrls: { default: { http: [net.rpcUrl] } },
  });
  const transport = viem.http(net.rpcUrl);
  const wallet = viem.createWalletClient({ account, chain, transport });
  const pub = viem.createPublicClient({ chain, transport });
  const listeners = {};
  const hex = (v) => (v == null ? undefined : BigInt(v));

  return {
    isPasskey: true,
    async request({ method, params = [] }) {
      switch (method) {
        case "eth_requestAccounts":
        case "eth_accounts":
          return [account.address.toLowerCase()];
        case "eth_chainId":
          return viem.toHex(net.chainId);
        case "wallet_switchEthereumChain":
        case "wallet_addEthereumChain": {
          const want = Number(BigInt(params[0]?.chainId ?? "0x0"));
          if (want !== net.chainId) throw Object.assign(new Error(`Passkey account is set up for ${net.label}; reload to switch networks`), { code: 4902 });
          return null;
        }
        case "eth_sendTransaction": {
          const t = params[0];
          return wallet.sendTransaction({
            to: t.to, data: t.data, value: hex(t.value) ?? 0n,
            gas: hex(t.gas), // Monad bills the gas limit; viem estimates it when absent
          });
        }
        case "eth_signTypedData_v4": {
          const td = typeof params[1] === "string" ? JSON.parse(params[1]) : params[1];
          const types = { ...td.types };
          delete types.EIP712Domain;
          return account.signTypedData({ domain: td.domain, types, primaryType: td.primaryType, message: td.message });
        }
        case "personal_sign":
          return account.signMessage({ message: { raw: params[0] } });
        default:
          return pub.request({ method, params });
      }
    },
    on(ev, fn) { (listeners[ev] ||= []).push(fn); },
    removeListener(ev, fn) { listeners[ev] = (listeners[ev] || []).filter((f) => f !== fn); },
  };
}
