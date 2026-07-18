import Link from "next/link";

export default function Home() {
  return (
    <main className="mx-auto flex max-w-2xl flex-col items-start gap-4 px-6 py-16">
      <h1 className="text-3xl font-bold">Tukar</h1>
      <p className="text-gray-600">
        Stellar Web3 app scaffold. Head to the wallet page to connect Freighter
        and try the testnet payment flow.
      </p>
      <Link
        href="/wallet"
        className="rounded-lg bg-gray-900 px-4 py-2 text-white hover:bg-gray-700"
      >
        Go to Wallet →
      </Link>
    </main>
  );
}
