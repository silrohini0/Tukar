import Link from "next/link";

export default function Navbar() {
  return (
    <nav className="border-b border-gray-200 bg-white">
      <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
        <Link href="/" className="text-lg font-semibold text-gray-900">
          Tukar
        </Link>
        <div className="flex items-center gap-6">
          <Link
            href="/wallet"
            className="text-sm font-medium text-gray-600 hover:text-gray-900"
          >
            Wallet
          </Link>
        </div>
      </div>
    </nav>
  );
}
