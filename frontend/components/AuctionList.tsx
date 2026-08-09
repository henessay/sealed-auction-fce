"use client";

import { useReadContract } from "wagmi";

import { sealedAuctionAbi } from "@/lib/abi/sealedAuction";
import { SEALED_AUCTION_ADDRESS } from "@/lib/config";

import { AuctionCard } from "./AuctionCard";

export function AuctionList() {
  const { data: count, isLoading } = useReadContract({
    address: SEALED_AUCTION_ADDRESS,
    abi: sealedAuctionAbi,
    functionName: "auctionCount",
    query: { refetchInterval: 10_000 },
  });

  if (isLoading) {
    return <p className="text-sm text-[var(--muted)]">Loading auctions…</p>;
  }
  if (!count || count === 0n) {
    return (
      <p className="text-sm text-[var(--muted)]">
        No auctions yet — create the first one above.
      </p>
    );
  }

  // Newest first.
  const ids = Array.from({ length: Number(count) }, (_, i) => BigInt(i)).reverse();

  return (
    <div className="space-y-4">
      {ids.map((id) => (
        <AuctionCard key={id.toString()} auctionId={id} />
      ))}
    </div>
  );
}
