import { Horizon, TransactionBuilder, Operation, Asset, BASE_FEE } from "@stellar/stellar-sdk";
import { HORIZON_TESTNET_URL, STELLAR_TESTNET_PASSPHRASE } from "./stellar-wallet";

const server = new Horizon.Server(HORIZON_TESTNET_URL);

/** Fetches the native XLM balance for an address. Returns "0" for unfunded accounts. */
export async function fetchXlmBalance(address: string): Promise<string> {
  try {
    const account = await server.loadAccount(address);
    const native = account.balances.find(
      (balance) => balance.asset_type === "native",
    );
    return native?.balance ?? "0";
  } catch (err) {
    if (isNotFoundError(err)) {
      return "0";
    }
    throw err;
  }
}

/** Builds an unsigned payment transaction XDR for sending native XLM. */
export async function buildPaymentXdr(
  from: string,
  to: string,
  amount: string,
): Promise<string> {
  const account = await server.loadAccount(from);
  const transaction = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: STELLAR_TESTNET_PASSPHRASE,
  })
    .addOperation(
      Operation.payment({
        destination: to,
        asset: Asset.native(),
        amount,
      }),
    )
    .setTimeout(30)
    .build();

  return transaction.toXDR();
}

/** Submits a signed transaction XDR to Horizon testnet and returns the transaction hash. */
export async function submitSignedTx(signedXdr: string): Promise<{ hash: string }> {
  const transaction = TransactionBuilder.fromXDR(signedXdr, STELLAR_TESTNET_PASSPHRASE);
  const response = await server.submitTransaction(transaction);
  return { hash: response.hash };
}

function isNotFoundError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "response" in err &&
    (err as { response?: { status?: number } }).response?.status === 404
  );
}
