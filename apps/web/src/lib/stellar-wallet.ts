import {
  isConnected,
  isAllowed,
  requestAccess,
  getAddress,
  signTransaction,
} from "@stellar/freighter-api";

export const STELLAR_TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";
export const HORIZON_TESTNET_URL = "https://horizon-testnet.stellar.org";

/** Whether the Freighter browser extension is installed and reachable. */
export async function detectFreighter(): Promise<boolean> {
  const result = await isConnected();
  if ("error" in result && result.error) {
    return false;
  }
  return result.isConnected;
}

/** Requests wallet access permission and returns the connected G-address. */
export async function connectWallet(): Promise<string> {
  const allowed = await isAllowed();
  if ("error" in allowed && allowed.error) {
    throw new Error(allowed.error);
  }

  if (!allowed.isAllowed) {
    const access = await requestAccess();
    if ("error" in access && access.error) {
      throw new Error(access.error);
    }
    return access.address;
  }

  const address = await getAddress();
  if ("error" in address && address.error) {
    throw new Error(address.error);
  }
  return address.address;
}

/** Returns the currently authorized wallet address, or null if not connected. */
export async function getWalletAddress(): Promise<string | null> {
  const allowed = await isAllowed();
  if ("error" in allowed && allowed.error) {
    throw new Error(allowed.error);
  }
  if (!allowed.isAllowed) {
    return null;
  }

  const address = await getAddress();
  if ("error" in address && address.error) {
    throw new Error(address.error);
  }
  return address.address;
}

/** Signs a transaction XDR on Stellar testnet using Freighter and returns the signed XDR. */
export async function signTx(xdr: string): Promise<string> {
  const result = await signTransaction(xdr, {
    networkPassphrase: STELLAR_TESTNET_PASSPHRASE,
  });
  if ("error" in result && result.error) {
    throw new Error(String(result.error));
  }
  return result.signedTxXdr;
}
