"use client";

import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { decodeAbiParameters, decodeEventLog, formatUnits } from "viem";
import { useAccount, useReadContract, useReadContracts } from "wagmi";

import {
  AUCTION_STATE_LABELS,
  demoAsset721Abi,
  erc20Abi,
  LOT_KIND_ERC721,
  sealedAuctionAbi,
} from "@/lib/abi/sealedAuction";
import {
  EXPLORER_ADDRESS_URL,
  EXPLORER_TX_URL,
  INSTRUCTION_FEE_WEI,
  SEALED_AUCTION_ADDRESS,
} from "@/lib/config";
import { fetchBidLogs, fetchCloseInstructionId } from "@/lib/explorer";
import {
  formatCountdown,
  formatDeadline,
  shortenAddress,
  shortenHash,
} from "@/lib/format";
import { useTx } from "@/lib/hooks/useTx";
import { pollActionResult } from "@/lib/tee/proxy";
import type { ActionResponse } from "@/lib/tee/types";
import { BidForm } from "./BidForm";

const ZERO = "0x0000000000000000000000000000000000000000";

const STATE_COLORS: Record<string, string> = {
  Open: "var(--green)",
  Closing: "var(--amber)",
  Settled: "var(--accent-soft)",
  Cancelled: "var(--muted)",
};

type TeeOutcome = {
  winner: `0x${string}`;
  clearingPrice: bigint;
  response: ActionResponse;
};

function decodeOutcome(response: ActionResponse): TeeOutcome {
  const [, , winner, clearingPrice] = decodeAbiParameters(
    [
      { type: "address" },
      { type: "uint256" },
      { type: "address" },
      { type: "uint256" },
    ],
    response.result.data,
  );
  return { winner, clearingPrice, response };
}

export function AuctionCard({ auctionId }: { auctionId: bigint }) {
  const { address } = useAccount();
  const { execute, isPending } = useTx();
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [outcome, setOutcome] = useState<TeeOutcome | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [workingLabel, setWorkingLabel] = useState<string | null>(null);

  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const { data: auction, refetch: refetchAuction } = useReadContract({
    address: SEALED_AUCTION_ADDRESS,
    abi: sealedAuctionAbi,
    functionName: "auctions",
    args: [auctionId],
    query: { refetchInterval: 10_000 },
  });

  const lotKind = auction?.[2];
  const lotToken = auction?.[3];
  const lotTokenId = auction?.[4];
  const lotAmount = auction?.[5];
  const payToken = auction?.[6];
  const isNft = lotKind === LOT_KIND_ERC721;

  const { data: payMeta } = useReadContracts({
    contracts: [
      { address: payToken, abi: erc20Abi, functionName: "symbol" },
      { address: payToken, abi: erc20Abi, functionName: "decimals" },
    ],
    query: { enabled: !!payToken },
  });
  const tokenSymbol = (payMeta?.[0]?.result as string | undefined) ?? "tokens";
  const tokenDecimals = (payMeta?.[1]?.result as number | undefined) ?? 18;

  // Lot metadata: ERC-721 symbol, or ERC-20 symbol/decimals for token lots.
  const { data: lotMeta } = useReadContracts({
    contracts: [
      { address: lotToken, abi: demoAsset721Abi, functionName: "symbol" },
      { address: lotToken, abi: erc20Abi, functionName: "decimals" },
    ],
    query: { enabled: !!lotToken },
  });
  const lotSymbol = (lotMeta?.[0]?.result as string | undefined) ?? "lot";
  const lotDecimals = (lotMeta?.[1]?.result as number | undefined) ?? 18;

  // Who holds the lot right now — this is what "in escrow" actually means.
  const { data: lotHolder, refetch: refetchLotHolder } = useReadContract({
    address: lotToken,
    abi: demoAsset721Abi,
    functionName: "ownerOf",
    args: lotTokenId !== undefined ? [lotTokenId] : undefined,
    query: { enabled: !!lotToken && isNft, refetchInterval: 15_000 },
  });

  const { data: bids, refetch: refetchBids } = useQuery({
    queryKey: ["bids", auctionId.toString()],
    queryFn: () => fetchBidLogs(auctionId),
    refetchInterval: 15_000,
  });

  const stateLabel = auction
    ? (AUCTION_STATE_LABELS[auction[9]] ?? "Unknown")
    : "…";
  const deadline = auction ? Number(auction[7]) : 0;
  const pastDeadline = deadline > 0 && nowMs / 1000 >= deadline;
  const countdown = deadline ? formatCountdown(deadline, nowMs) : "";
  const inEscrow =
    !isNft
      ? stateLabel === "Open" || stateLabel === "Closing"
      : lotHolder?.toLowerCase() === SEALED_AUCTION_ADDRESS.toLowerCase();

  // Recover the TEE outcome for auctions already Closing (e.g. after reload).
  useEffect(() => {
    if (!auction || stateLabel !== "Closing" || outcome) return;
    let cancelled = false;
    (async () => {
      try {
        const instructionId = await fetchCloseInstructionId(auctionId);
        if (!instructionId || cancelled) return;
        const response = await pollActionResult(instructionId);
        if (!cancelled) setOutcome(decodeOutcome(response));
      } catch (e) {
        if (!cancelled)
          setActionError(
            e instanceof Error ? e.message : "TEE result fetch failed",
          );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [auction, stateLabel, outcome, auctionId]);

  function lotLabel(): string {
    if (isNft) return `${lotSymbol} #${lotTokenId?.toString() ?? "?"}`;
    return `${formatUnits(lotAmount ?? 0n, lotDecimals)} ${lotSymbol}`;
  }

  async function closeAuction() {
    setActionError(null);
    try {
      setWorkingLabel("Confirm closeAuction in your wallet…");
      const receipt = await execute({
        address: SEALED_AUCTION_ADDRESS,
        abi: sealedAuctionAbi,
        functionName: "closeAuction",
        args: [auctionId],
        value: INSTRUCTION_FEE_WEI,
      });
      let instructionId: `0x${string}` | null = null;
      for (const log of receipt.logs) {
        if (log.address.toLowerCase() !== SEALED_AUCTION_ADDRESS.toLowerCase())
          continue;
        try {
          const decoded = decodeEventLog({
            abi: sealedAuctionAbi,
            data: log.data,
            topics: log.topics,
            eventName: "AuctionClosing",
          });
          instructionId = decoded.args.instructionId;
          break;
        } catch {
          /* not this event */
        }
      }
      if (!instructionId)
        throw new Error("AuctionClosing event not found in receipt");

      setWorkingLabel("TEE is picking the winner…");
      const response = await pollActionResult(instructionId);
      setOutcome(decodeOutcome(response));
      await refetchAuction();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Close failed");
    } finally {
      setWorkingLabel(null);
    }
  }

  async function settle() {
    if (!outcome || !payToken) return;
    setActionError(null);
    try {
      if (outcome.winner !== ZERO) {
        setWorkingLabel("Approve the pay token in your wallet…");
        await execute({
          address: payToken,
          abi: erc20Abi,
          functionName: "approve",
          args: [SEALED_AUCTION_ADDRESS, outcome.clearingPrice],
        });
      }
      setWorkingLabel("Confirm settle — payment and lot swap atomically…");
      const { result, signature } = outcome.response;
      await execute({
        address: SEALED_AUCTION_ADDRESS,
        abi: sealedAuctionAbi,
        functionName: "settle",
        args: [
          result.data,
          result.id,
          result.submissionTag,
          result.status,
          signature,
        ],
      });
      await refetchAuction();
      await refetchLotHolder();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Settle failed");
    } finally {
      setWorkingLabel(null);
    }
  }

  if (!auction) {
    return (
      <div className="panel p-4 text-sm text-[var(--muted)]">
        Loading auction #{auctionId.toString()}…
      </div>
    );
  }

  const seller = auction[0];
  const lot = auction[1];
  const reservePrice = auction[8];
  const winner = auction[10];
  const clearingPrice = auction[11];
  const bidCount = auction[12];

  const isWinner =
    outcome && address && outcome.winner.toLowerCase() === address.toLowerCase();
  const zeroWinner = outcome?.winner === ZERO;
  const viewerIsSettledWinner =
    address && winner.toLowerCase() === address.toLowerCase();
  const viewerIsSeller = address && seller.toLowerCase() === address.toLowerCase();

  return (
    <article className="panel p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold">
            #{auctionId.toString()} · {lot}
          </h3>
          <p className="mt-0.5 text-xs text-[var(--muted)]">
            Seller <span className="mono">{shortenAddress(seller)}</span> ·
            Reserve{" "}
            {reservePrice > 0n
              ? `${formatUnits(reservePrice, tokenDecimals)} ${tokenSymbol}`
              : "none"}
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <span
            className="badge"
            style={{
              background: `color-mix(in srgb, ${STATE_COLORS[stateLabel] ?? "var(--muted)"} 15%, transparent)`,
              color: STATE_COLORS[stateLabel] ?? "var(--muted)",
            }}
          >
            {stateLabel}
          </span>
          {inEscrow && (
            <span
              className="badge"
              style={{
                background: "color-mix(in srgb, var(--green) 15%, transparent)",
                color: "var(--green)",
              }}
            >
              Lot in escrow
            </span>
          )}
        </div>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
        <div>
          <div className="text-[var(--muted)]">Lot</div>
          <div className="mono">
            <a
              className="text-[var(--accent-soft)] hover:underline"
              href={`${EXPLORER_ADDRESS_URL}${lotToken}`}
              target="_blank"
              rel="noreferrer"
            >
              {lotLabel()} ↗
            </a>
          </div>
        </div>
        <div>
          <div className="text-[var(--muted)]">Deadline</div>
          <div className="mono">
            {formatDeadline(deadline)}
            {countdown && (
              <span className="ml-1 text-[var(--amber)]">({countdown})</span>
            )}
          </div>
        </div>
        <div>
          <div className="text-[var(--muted)]">Pay token</div>
          <div className="mono">{tokenSymbol}</div>
        </div>
        <div>
          <div className="text-[var(--muted)]">Sealed bids</div>
          <div className="mono">{bidCount.toString()}</div>
        </div>
      </div>

      {stateLabel === "Settled" && (
        <div className="mt-3 rounded-lg bg-[var(--panel-2)] p-3 text-sm">
          {viewerIsSettledWinner ? (
            <p className="text-[var(--green)]">
              You won {lotLabel()} for{" "}
              <span className="font-semibold">
                {formatUnits(clearingPrice, tokenDecimals)} {tokenSymbol}
              </span>{" "}
              — the lot is in your wallet.
            </p>
          ) : viewerIsSeller ? (
            <p className="text-[var(--green)]">
              Sold to <span className="mono">{shortenAddress(winner)}</span> —
              you received{" "}
              <span className="font-semibold">
                {formatUnits(clearingPrice, tokenDecimals)} {tokenSymbol}
              </span>
              .
            </p>
          ) : (
            <p>
              Winner <span className="mono">{shortenAddress(winner)}</span> paid{" "}
              <span className="font-semibold">
                {formatUnits(clearingPrice, tokenDecimals)} {tokenSymbol}
              </span>{" "}
              for {lotLabel()}.
            </p>
          )}
        </div>
      )}
      {stateLabel === "Cancelled" && (
        <p className="mt-3 text-sm text-[var(--muted)]">
          Auction cancelled — the lot went back to the seller.
        </p>
      )}

      {outcome && stateLabel === "Closing" && (
        <div className="mt-3 rounded-lg bg-[var(--panel-2)] p-3 text-sm">
          {zeroWinner ? (
            <p>
              TEE result: no bid met the reserve — settling returns the lot to
              the seller.
            </p>
          ) : (
            <p>
              TEE result: winner{" "}
              <span className="mono">{shortenAddress(outcome.winner)}</span> at{" "}
              <span className="font-semibold">
                {formatUnits(outcome.clearingPrice, tokenDecimals)}{" "}
                {tokenSymbol}
              </span>
            </p>
          )}
          <button
            className="btn mt-2"
            onClick={settle}
            disabled={isPending || (!isWinner && !zeroWinner)}
          >
            {zeroWinner
              ? "Settle (return lot)"
              : isWinner
                ? "Approve & settle"
                : "Settle (winner only)"}
          </button>
          {!isWinner && !zeroWinner && (
            <p className="mt-1 text-xs text-[var(--muted)]">
              Connect the winning wallet — settlement pulls the payment and
              hands over the lot in one transaction.
            </p>
          )}
        </div>
      )}

      {stateLabel === "Open" && !pastDeadline && (
        <BidForm
          auctionId={auctionId}
          tokenSymbol={tokenSymbol}
          tokenDecimals={tokenDecimals}
          onBidAccepted={() => {
            refetchBids();
            refetchAuction();
          }}
        />
      )}

      {(stateLabel === "Open" || stateLabel === "Closing") && pastDeadline && (
        <button className="btn mt-3" onClick={closeAuction} disabled={isPending}>
          {stateLabel === "Closing" ? "Re-run close (recovery)" : "Close auction"}
        </button>
      )}

      {workingLabel && (
        <p className="mt-2 text-xs text-[var(--amber)]">{workingLabel}</p>
      )}
      {actionError && (
        <p className="mt-2 break-all text-xs text-[var(--red)]">{actionError}</p>
      )}

      {bids && bids.length > 0 && (
        <details className="mt-3 text-xs">
          <summary className="cursor-pointer text-[var(--muted)]">
            Bid commitments ({bids.length}) — amounts unknown until close
          </summary>
          <ul className="mt-2 space-y-1">
            {bids.map((bid) => (
              <li
                key={bid.commitment}
                className="mono flex justify-between gap-2"
              >
                <span>{shortenAddress(bid.bidder)}</span>
                <span className="text-[var(--muted)]">
                  {shortenHash(bid.commitment)}
                </span>
                <a
                  className="text-[var(--accent-soft)] hover:underline"
                  href={`${EXPLORER_TX_URL}${bid.transactionHash}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  tx ↗
                </a>
              </li>
            ))}
          </ul>
        </details>
      )}
    </article>
  );
}
