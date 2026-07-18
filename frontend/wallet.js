// Optional Freighter wallet for Tukar. Lazy-loads @stellar/freighter-api only
// when the user clicks Connect, so a missing extension or a CDN hiccup never
// breaks the demo — which always falls back to the embedded throwaway demo key.
import { setWalletSigner, friendbotFund, addUsdcTrustline, faucetUsdc } from "./stellar.js";

const PASSPHRASE = "Test SDF Network ; September 2015";
let _api = null;

async function freighter() {
  if (!_api) {
    const mod = await import("https://esm.sh/@stellar/freighter-api@4.1.0");
    _api = mod.default ?? mod;
  }
  return _api;
}

const withTimeout = (p, ms, msg) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(msg)), ms))]);

/** Connect Freighter and install it as the active signer. Returns { address }. */
export async function connect() {
  const f = await withTimeout(freighter(), 8000, "Freighter library failed to load");
  // Detect the extension first (hangs forever without it) — bail fast if absent.
  const conn = await withTimeout(f.isConnected(), 3000, "Freighter not detected").catch(() => null);
  if (!(conn && (conn.isConnected ?? conn))) {
    throw new Error("Freighter not detected — install the extension to use your own wallet");
  }
  const access = await withTimeout(f.requestAccess(), 60000, "wallet approval timed out");
  if (access && access.error) throw new Error(access.error);
  const address = (access && access.address) || access;
  if (!address || typeof address !== "string") throw new Error("Freighter not available");

  const signer = {
    address,
    signTransaction: async (xdr, opts) => {
      const res = await f.signTransaction(xdr, { networkPassphrase: PASSPHRASE, address, ...(opts || {}) });
      if (res && res.error) throw new Error(res.error);
      return { signedTxXdr: res.signedTxXdr, signerAddress: res.signerAddress || address };
    },
    signAuthEntry: async (xdr, opts) => {
      const res = await f.signAuthEntry(xdr, { address, ...(opts || {}) });
      if (res && res.error) throw new Error(res.error);
      return { signedAuthEntry: res.signedAuthEntry, signerAddress: res.signerAddress || address };
    },
  };
  setWalletSigner(signer);
  return { address, signTransaction: signer.signTransaction };
}

export function disconnect() { setWalletSigner(null); }

/** One-click testnet setup so a fresh wallet can actually deposit: fund XLM
 *  (friendbot), add the USDC trustline (Freighter-signed), faucet USDC. */
export async function setupTestnetFunds(address, signTransaction, onStep) {
  const step = (m) => { if (onStep) onStep(m); };
  step("funding XLM via friendbot…");
  await friendbotFund(address);
  step("approve the USDC trustline in Freighter…");
  try {
    await addUsdcTrustline(address, signTransaction);
  } catch (e) {
    if (!/exist|already|low reserve|op_low_reserve/i.test(String(e && e.message))) throw e;
  }
  step("sending test USDC to your wallet…");
  try { await faucetUsdc(address); } catch (_) { /* may already hold USDC */ }
  step("wallet ready");
}
