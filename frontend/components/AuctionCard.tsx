"use client";

import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { decodeAbiParameters, decodeEventLog, formatUnits } from "viem";
import { useAccount, useReadContract, useReadContracts } from "wagmi";

import {
  AUCTION_STATE_LABELS,
  erc20Abi,
  sealedAuctionAbi,
} from "@/lib/abi/sealedAuction";
import {
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

  const {
    data: auction,
    refetch: refetchAuction,
  } = useReadContract({
    address: SEALED_AUCTION_ADDRESS,
    abi: sealedAuctionAbi,
    functionName: "auctions",
    args: [auctionId],
    query: { refetchInterval: 10_000 },
  });

  const payToken = auction?.[2];
  const { data: tokenMeta } = useReadContracts({
    contracts: [
      { address: payToken, abi: erc20Abi, functionName: "symbol" },
      { address: payToken, abi: erc20Abi, functionName: "decimals" },
    ],
    query: { enabled: !!payToken },
  });
  const tokenSymbol = (tokenMeta?.[0]?.result as string | undefined) ?? "tokens";
  const tokenDecimals = (tokenMeta?.[1]?.result as number | undefined) ?? 18;

  const { data: bids, refetch: refetchBids } = useQuery({
    queryKey: ["bids", auctionId.toString()],
    queryFn: () => fetchBidLogs(auctionId),
    refetchInterval: 15_000,
  });

  const stateLabel = auction
    ? (AUCTION_STATE_LABELS[auction[5]] ?? "Unknown")
    : "…";
  const deadline = auction ? Number(auction[3]) : 0;
  const pastDeadline = deadline > 0 && nowMs / 1000 >= deadline;
  const countdown = deadline ? formatCountdown(deadline, nowMs) : "";

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
          setActionError(e instanceof Error ? e.message : "TEE result fetch failed");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [auction, stateLabel, outcome, auctionId]);

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
      if (outcome.winner !== "0x0000000000000000000000000000000000000000") {
        setWorkingLabel("Approve the pay token in your wallet…");
        await execute({
          address: payToken,
          abi: erc20Abi,
          functionName: "approve",
          args: [SEALED_AUCTION_ADDRESS, outcome.clearingPrice],
        });
      }
      setWorkingLabel("Confirm settle in your wallet…");
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

  const [seller, lot, , , reservePrice, , winner, clearingPrice, bidCount] = [
    auction[0],
    auction[1],
    auction[2],
    auction[3],
    auction[4],
    auction[5],
    auction[6],
    auction[7],
    auction[8],
  ];

  const isWinner =
    outcome &&
    address &&
    outcome.winner.toLowerCase() === address.toLowerCase();
  const zeroWinner =
    outcome?.winner === "0x0000000000000000000000000000000000000000";

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
        <span
          className="badge shrink-0"
          style={{
            background: `color-mix(in srgb, ${STATE_COLORS[stateLabel] ?? "var(--muted)"} 15%, transparent)`,
            color: STATE_COLORS[stateLabel] ?? "var(--muted)",
          }}
        >
          {stateLabel}
        </span>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-3">
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
        <p className="mt-3 rounded-lg bg-[var(--panel-2)] p-3 text-sm">
          Winner <span className="mono">{shortenAddress(winner)}</span> at{" "}
          <span className="font-semibold">
            {formatUnits(clearingPrice, tokenDecimals)} {tokenSymbol}
          </span>
        </p>
      )}
      {stateLabel === "Cancelled" && (
        <p className="mt-3 text-sm text-[var(--muted)]">
          Auction cancelled{outcome && zeroWinner ? " (no valid bids)" : ""}.
        </p>
      )}

      {outcome && stateLabel === "Closing" && (
        <div className="mt-3 rounded-lg bg-[var(--panel-2)] p-3 text-sm">
          {zeroWinner ? (
            <p>TEE result: no valid bids — settling will cancel the auction.</p>
          ) : (
            <p>
              TEE result: winner{" "}
              <span className="mono">{shortenAddress(outcome.winner)}</span> at{" "}
              <span className="font-semibold">
                {formatUnits(outcome.clearingPrice, tokenDecimals)} {tokenSymbol}
              </span>
            </p>
          )}
          <button
            className="btn mt-2"
            onClick={settle}
            disabled={isPending || (!isWinner && !zeroWinner)}
          >
            {zeroWinner
              ? "Settle (cancel)"
              : isWinner
                ? "Approve & settle"
                : "Settle (winner only)"}
          </button>
          {!isWinner && !zeroWinner && (
            <p className="mt-1 text-xs text-[var(--muted)]">
              Connect the winning wallet — settlement pulls the payment via
              transferFrom.
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
              <li key={bid.commitment} className="mono flex justify-between gap-2">
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

