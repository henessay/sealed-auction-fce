"use client";

import { useQueryClient } from "@tanstack/react-query";

import { AuctionList } from "@/components/AuctionList";
import { CreateAuctionForm } from "@/components/CreateAuctionForm";
import { MintDemoAsset } from "@/components/MintDemoAsset";
import { VerifyPanel } from "@/components/VerifyPanel";

export default function Home() {
  const queryClient = useQueryClient();

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
      <div className="space-y-4">
        <CreateAuctionForm
          onCreated={() => queryClient.invalidateQueries()}
        />
        <AuctionList />
      </div>
      <aside className="space-y-4 lg:order-none">
        <VerifyPanel />
        <MintDemoAsset />
        <section className="panel p-4 text-xs leading-relaxed text-[var(--muted)]">
          <h2 className="mb-2 text-sm font-semibold text-[var(--text)]">
            How it works
          </h2>
          <ol className="list-inside list-decimal space-y-1">
            <li>
              Seller escrows the lot (an NFT or tokens) into the contract and
              names an ERC-20 pay token (FXRP).
            </li>
            <li>
              Bids are ECIES-encrypted in the browser under the TEE key — the
              chain only sees ciphertext and a commitment.
            </li>
            <li>
              After the deadline anyone closes the auction; the TEE decrypts
              bids in memory and signs the winner.
            </li>
            <li>
              settle() verifies the TEE signature and swaps atomically: payment
              to the seller, lot to the winner — or nothing at all.
            </li>
          </ol>
        </section>
      </aside>
    </div>
  );
}
