import type { Metadata } from "next";
import Navbar from "@/components/layout/navbar";
import "./globals.css";

export const metadata: Metadata = {
  title: "Tukar",
  description: "Stellar Web3 app",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-gray-50 text-gray-900 antialiased">
        <Navbar />
        {children}
      </body>
    </html>
  );
}
