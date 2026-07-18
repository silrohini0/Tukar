"use client";

import StellarWalletPanel from "@/components/wallet/stellar-wallet-panel";

export default function WalletPage() {
  return (
    <main className="mx-auto max-w-2xl px-6 py-12">
      <h1 className="mb-8 text-2xl font-bold">Stellar Wallet — Freighter Integration</h1>
      <StellarWalletPanel />
    </main>
  );
}
