"use client";

import { useState } from "react";
import { useReadContract, useReadContracts } from "wagmi";

import { sealedAuctionAbi } from "@/lib/abi/sealedAuction";
import { SEALED_AUCTION_ADDRESS } from "@/lib/config";

import { AuctionCard } from "./AuctionCard";
import { CompletedAuctionCard } from "./CompletedAuctionCard";

/** Return shape of SealedAuction.auctions(uint256). */
export type AuctionTuple = readonly [
  seller: `0x${string}`,
  lot: string,
  lotKind: number,
  lotToken: `0x${string}`,
  lotTokenId: bigint,
  lotAmount: bigint,
  payToken: `0x${string}`,
  deadline: bigint,
  reservePrice: bigint,
  state: number,
  winner: `0x${string}`,
  clearingPrice: bigint,
  bidCount: bigint,
];

type Tab = "active" | "completed";

/** AuctionState: 1 Open, 2 Closing are live; 3 Settled, 4 Cancelled are done. */
const ACTIVE_STATES = [1, 2];

export function AuctionList() {
  const [tab, setTab] = useState<Tab>("active");

  const { data: count, isLoading } = useReadContract({
    address: SEALED_AUCTION_ADDRESS,
    abi: sealedAuctionAbi,
    functionName: "auctionCount",
    query: { refetchInterval: 20_000 },
  });

  const ids = Array.from({ length: Number(count ?? 0n) }, (_, i) => BigInt(i));

  // Single source of auction state for the whole page: one Multicall3 call,
  // handed down to the cards as props so they never re-read it themselves.
  const {
    data: rows,
    isLoading: rowsLoading,
    refetch: refetchRows,
  } = useReadContracts({
    contracts: ids.map((id) => ({
      address: SEALED_AUCTION_ADDRESS,
      abi: sealedAuctionAbi,
      functionName: "auctions" as const,
      args: [id] as const,
    })),
    query: { enabled: ids.length > 0, refetchInterval: 15_000 },
  });

  const auctions = ids.flatMap((id, i) => {
    const row = rows?.[i];
    if (!row || row.status !== "success") return [];
    return [{ id, data: row.result as unknown as AuctionTuple }];
  });

  const active = auctions
    .filter((a) => ACTIVE_STATES.includes(a.data[9]))
    // Nearest deadline first — what needs attention soonest is on top.
    .sort((a, b) => Number(a.data[7] - b.data[7]));
  const completed = auctions
    .filter((a) => !ACTIVE_STATES.includes(a.data[9]))
    // No settlement timestamp on-chain; creation order is the proxy for recency.
    .sort((a, b) => Number(b.id - a.id));

  if (isLoading || (ids.length > 0 && rowsLoading && auctions.length === 0)) {
    return <p className="text-sm text-[var(--muted)]">Loading auctions…</p>;
  }
  if (ids.length === 0) {
    return (
      <p className="text-sm text-[var(--muted)]">
        No auctions yet — create the first one above.
      </p>
    );
  }

  const shown = tab === "active" ? active : completed;

  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        <button
          type="button"
          className={`btn ${tab === "active" ? "" : "btn-secondary"}`}
          onClick={() => setTab("active")}
        >
          Active ({active.length})
        </button>
        <button
          type="button"
          className={`btn ${tab === "completed" ? "" : "btn-secondary"}`}
          onClick={() => setTab("completed")}
        >
          Completed ({completed.length})
        </button>
      </div>

      {shown.length === 0 ? (
        <p className="text-sm text-[var(--muted)]">
          {tab === "active"
            ? "No active auctions — create one above."
            : "No completed auctions yet."}
        </p>
      ) : tab === "active" ? (
        <div className="space-y-4">
          {shown.map((a) => (
            <AuctionCard
              key={a.id.toString()}
              auctionId={a.id}
              auction={a.data}
              onChanged={() => void refetchRows()}
            />
          ))}
        </div>
      ) : (
        <div className="space-y-2">
          {shown.map((a) => (
            <CompletedAuctionCard
              key={a.id.toString()}
              auctionId={a.id}
              auction={a.data}
            />
          ))}
        </div>
      )}
    </div>
  );
}
