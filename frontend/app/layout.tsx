import type { Metadata } from "next";
import type { ReactNode } from "react";

import { Web3Provider } from "@/components/Web3Provider";
import { ConnectButton } from "@/components/ConnectButton";

import "./globals.css";

export const metadata: Metadata = {
  title: "Sealed Auction — Flare Confidential Extension",
  description:
    "Sealed-bid auctions with TEE-encrypted bids on Flare Coston2. Bid amounts never touch the chain.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">
        <Web3Provider>
          <header className="border-b border-[var(--border)]">
            <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
              <div>
                <h1 className="text-lg font-bold tracking-tight">
                  Sealed<span className="text-[var(--accent)]">Auction</span>
                </h1>
                <p className="text-xs text-[var(--muted)]">
                  Confidential bids via Flare TEE · Coston2
                </p>
              </div>
              <ConnectButton />
            </div>
          </header>
          <main className="mx-auto max-w-5xl px-6 py-8">{children}</main>
          <footer className="mx-auto max-w-5xl px-6 pb-8 text-xs text-[var(--muted)]">
            Flare Confidential Extension demo — bid amounts are ECIES-encrypted
            under the TEE key and never appear on-chain.
          </footer>
        </Web3Provider>
      </body>
    </html>
  );
}
