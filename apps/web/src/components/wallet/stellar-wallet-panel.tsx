"use client";

import { useEffect, useState } from "react";
import { detectFreighter } from "@/lib/stellar-wallet";
import { useWallet } from "@/hooks/use-stellar-wallet";

type TxFeedback =
  | { status: "success"; hash: string }
  | { status: "error"; message: string }
  | null;

export default function StellarWalletPanel() {
  const [isFreighterInstalled, setIsFreighterInstalled] = useState<boolean | null>(null);
  const [destination, setDestination] = useState("");
  const [amount, setAmount] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [txFeedback, setTxFeedback] = useState<TxFeedback>(null);

  const {
    address,
    balance,
    isConnected,
    isLoading,
    error,
    connect,
    disconnect,
    refreshBalance,
    sendXlm,
  } = useWallet();

  useEffect(() => {
    detectFreighter()
      .then(setIsFreighterInstalled)
      .catch(() => setIsFreighterInstalled(false));
  }, []);

  const handleDisconnect = () => {
    disconnect();
    setTxFeedback(null);
    setDestination("");
    setAmount("");
  };

  const handleSend = async (event: React.FormEvent) => {
    event.preventDefault();
    setTxFeedback(null);
    setIsSending(true);
    try {
      const result = await sendXlm(destination, amount);
      setTxFeedback({ status: "success", hash: result.hash });
      setDestination("");
      setAmount("");
    } catch (err) {
      setTxFeedback({
        status: "error",
        message: err instanceof Error ? err.message : "Transaction failed",
      });
    } finally {
      setIsSending(false);
    }
  };

  if (isFreighterInstalled === null) {
    return (
      <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
        <p className="text-sm text-gray-500">Checking for Freighter…</p>
      </div>
    );
  }

  if (!isFreighterInstalled) {
    return (
      <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
        <h2 className="mb-2 text-lg font-semibold">Freighter not detected</h2>
        <p className="mb-4 text-sm text-gray-600">
          Install the Freighter browser extension to connect your Stellar wallet.
        </p>
        <a
          href="https://freighter.app"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-block rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700"
        >
          Install Freighter
        </a>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
        <h2 className="mb-4 text-lg font-semibold">Wallet</h2>

        {!isConnected ? (
          <button
            onClick={connect}
            disabled={isLoading}
            className="rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isLoading ? "Connecting…" : "Connect Wallet"}
          </button>
        ) : (
          <div className="flex flex-col gap-3">
            <div>
              <p className="text-xs font-medium uppercase text-gray-500">Address</p>
              <p className="break-all font-mono text-sm">{address}</p>
            </div>

            <div>
              <p className="text-xs font-medium uppercase text-gray-500">Balance</p>
              <p className="text-2xl font-bold">
                {balance !== null ? `${balance} XLM` : "—"}
                {balance === "0" && (
                  <span className="ml-2 text-sm font-normal text-gray-500">
                    (account not funded)
                  </span>
                )}
              </p>
            </div>

            <div className="flex gap-3">
              <button
                onClick={() => refreshBalance()}
                disabled={isLoading}
                className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isLoading ? "Refreshing…" : "Refresh Balance"}
              </button>
              <button
                onClick={handleDisconnect}
                className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium hover:bg-gray-50"
              >
                Disconnect
              </button>
            </div>

            {error && <p className="text-sm text-red-600">{error}</p>}
          </div>
        )}
      </div>

      {isConnected && (
        <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
          <h2 className="mb-4 text-lg font-semibold">Send XLM</h2>
          <form onSubmit={handleSend} className="flex flex-col gap-4">
            <div>
              <label htmlFor="destination" className="mb-1 block text-sm font-medium text-gray-700">
                Destination address
              </label>
              <input
                id="destination"
                type="text"
                value={destination}
                onChange={(event) => setDestination(event.target.value)}
                placeholder="G..."
                required
                className="w-full rounded-lg border border-gray-300 px-3 py-2 font-mono text-sm focus:border-gray-500 focus:outline-none"
              />
            </div>

            <div>
              <label htmlFor="amount" className="mb-1 block text-sm font-medium text-gray-700">
                Amount (XLM)
              </label>
              <input
                id="amount"
                type="number"
                min="0"
                step="0.0000001"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                placeholder="0.00"
                required
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-gray-500 focus:outline-none"
              />
            </div>

            <button
              type="submit"
              disabled={isSending}
              className="rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isSending ? "Sending…" : "Send XLM"}
            </button>
          </form>

          {txFeedback?.status === "success" && (
            <div className="mt-4 rounded-lg border border-green-200 bg-green-50 p-4 text-sm text-green-800">
              Transaction sent! Hash: <span className="break-all font-mono">{txFeedback.hash}</span>
              <br />
              <a
                href={`https://stellar.expert/explorer/testnet/tx/${txFeedback.hash}`}
                target="_blank"
                rel="noopener noreferrer"
                className="font-medium underline"
              >
                View on Stellar Expert →
              </a>
            </div>
          )}

          {txFeedback?.status === "error" && (
            <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">
              {txFeedback.message}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
