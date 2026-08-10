"use client";

import { useQuery } from "@tanstack/react-query";
import { formatUnits } from "viem";
import { useAccount, useReadContracts } from "wagmi";

import {
  AUCTION_STATE_LABELS,
  demoAsset721Abi,
  erc20Abi,
  LOT_KIND_ERC721,
} from "@/lib/abi/sealedAuction";
import { EXPLORER_TX_URL } from "@/lib/config";
import { fetchSettlementTx } from "@/lib/explorer";
import { shortenAddress } from "@/lib/format";
import type { AuctionTuple } from "./AuctionList";
import { RoleBadge } from "./ui";

const ZERO = "0x0000000000000000000000000000000000000000";

/**
 * Read-only summary of a finished auction. Deliberately hook-light and
 * button-free: nothing here is actionable, so it must not poll the TEE or
 * compete for attention with live auctions.
 */
export function CompletedAuctionCard({
  auctionId,
  auction,
}: {
  auctionId: bigint;
  auction: AuctionTuple;
}) {
  const { address } = useAccount();
  const [seller, lot, lotKind, lotToken, lotTokenId, lotAmount, payToken] =
    auction;
  const state = auction[9];
  const winner = auction[10];
  const clearingPrice = auction[11];
  const isNft = lotKind === LOT_KIND_ERC721;
  const stateLabel = AUCTION_STATE_LABELS[state] ?? "Unknown";

  const { data: meta } = useReadContracts({
    contracts: [
      { address: payToken, abi: erc20Abi, functionName: "symbol" },
      { address: payToken, abi: erc20Abi, functionName: "decimals" },
      { address: lotToken, abi: demoAsset721Abi, functionName: "symbol" },
      { address: lotToken, abi: erc20Abi, functionName: "decimals" },
    ],
    query: { enabled: !!payToken && !!lotToken, staleTime: Infinity },
  });
  const tokenSymbol = (meta?.[0]?.result as string | undefined) ?? "tokens";
  const tokenDecimals = (meta?.[1]?.result as number | undefined) ?? 18;
  const lotSymbol = (meta?.[2]?.result as string | undefined) ?? "lot";
  const lotDecimals = (meta?.[3]?.result as number | undefined) ?? 18;

  const { data: settlement } = useQuery({
    queryKey: ["settlement-tx", auctionId.toString()],
    queryFn: () => fetchSettlementTx(auctionId),
    staleTime: Infinity,
  });

  const lotLabel = isNft
    ? `${lotSymbol} #${lotTokenId.toString()}`
    : `${formatUnits(lotAmount, lotDecimals)} ${lotSymbol}`;
  const soldToViewer =
    !!address && winner.toLowerCase() === address.toLowerCase();
  const viewerIsSeller =
    !!address && seller.toLowerCase() === address.toLowerCase();

  return (
    <article className="panel flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-3 text-sm">
      <span className="text-[var(--muted)]">#{auctionId.toString()}</span>
      <span className="font-semibold">{lot}</span>
      <span className="mono text-xs text-[var(--muted)]">{lotLabel}</span>

      <span className="ml-auto text-xs">
        {winner !== ZERO ? (
          <>
            <span className="font-semibold">
              {formatUnits(clearingPrice, tokenDecimals)} {tokenSymbol}
            </span>
            <span className="text-[var(--muted)]">
              {" "}
              ·{" "}
              {shortenAddress(winner)}
            </span>
          </>
        ) : (
          <span className="text-[var(--muted)]">
            no winner — lot returned to the seller
          </span>
        )}
      </span>

      <RoleBadge
        role={
          soldToViewer
            ? "You won"
            : viewerIsSeller
              ? "You are the seller"
              : null
        }
      />

      <span
        className="badge shrink-0"
        style={{
          background: `color-mix(in srgb, ${
            stateLabel === "Settled" ? "var(--accent-soft)" : "var(--muted)"
          } 15%, transparent)`,
          color: stateLabel === "Settled" ? "var(--accent-soft)" : "var(--muted)",
        }}
      >
        {stateLabel}
      </span>

      {settlement && (
        <a
          className="shrink-0 text-xs text-[var(--accent-soft)] hover:underline"
          href={`${EXPLORER_TX_URL}${settlement.hash}`}
          target="_blank"
          rel="noreferrer"
        >
          {settlement.kind === "settled" ? "settle tx ↗" : "cancel tx ↗"}
        </a>
      )}
    </article>
  );
}
