"use client";

import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
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
import { type FriendlyError, friendlyError } from "@/lib/errors";
import { fetchBidLogs, fetchCloseInstructionId } from "@/lib/explorer";
import {
  formatCountdown,
  formatDeadline,
  shortenAddress,
  shortenHash,
} from "@/lib/format";
import { useTx } from "@/lib/hooks/useTx";
import {
  type BidTeeStatus,
  peekActionResult,
  pollActionResult,
} from "@/lib/tee/proxy";
import type { ActionResponse } from "@/lib/tee/types";
import type { AuctionTuple } from "./AuctionList";
import { BidForm } from "./BidForm";
import { ErrorNote } from "./ErrorNote";
import {
  ActionButton,
  AdvancedRow,
  InfoDot,
  RoleBadge,
  StateLine,
} from "./ui";

const ZERO = "0x0000000000000000000000000000000000000000";

const STATE_COLORS: Record<string, string> = {
  Open: "var(--green)",
  Closing: "var(--amber)",
  Settled: "var(--accent-soft)",
  Cancelled: "var(--muted)",
};

const TOOLTIP = {
  close:
    "Permissionless: anyone may trigger the close after the deadline. The winner is decided by the TEE, not by whoever clicks.",
  reclose:
    "The TEE result is missing or expired. Re-issuing the close instruction is safe — the TEE decides deterministically, so the outcome cannot change.",
  settleWinner:
    "Approves the pay token, then swaps payment and lot in one atomic transaction. Either leg failing reverts both.",
  settleAdvanced:
    "Permissionless once the winner has approved — settle() pulls the payment from the winner, so it reverts until then.",
  settleReturn:
    "No bid met the reserve. Settling pays nobody and releases the escrowed lot back to the seller; anyone may submit it.",
  cancel:
    "Seller-only, and only while no bids have arrived. The escrowed lot returns to your wallet.",
  sellerNoBid:
    "The contract would allow it, but FXRP rejects transfers to yourself — a seller-won auction could never settle.",
} as const;

type TeeOutcome = {
  winner: `0x${string}`;
  clearingPrice: bigint;
  response: ActionResponse;
};

/** UI states from docs/LOGIC.md — four on-chain states plus TEE-result detail. */
type UiState =
  | "open"
  | "openExpired"
  | "awaitingTee"
  | "awaitingSettle"
  | "noWinner"
  | "terminal";

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

/** Did this bid's instruction actually reach the enclave? */
function TeeBadge({ status }: { status?: BidTeeStatus }) {
  if (!status) return <span className="text-[var(--muted)]">TEE …</span>;
  if (status === "confirmed")
    return <span style={{ color: "var(--green)" }}>TEE ✓</span>;
  if (status === "unreachable")
    return <span style={{ color: "var(--red)" }}>TEE unreachable</span>;
  return <span style={{ color: "var(--amber)" }}>TEE pending</span>;
}

export function AuctionCard({
  auctionId,
  auction,
  onChanged,
}: {
  auctionId: bigint;
  auction: AuctionTuple;
  onChanged: () => void;
}) {
  const { address } = useAccount();
  const { execute, isPending } = useTx();
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [manualOutcome, setManualOutcome] = useState<TeeOutcome | null>(null);
  const [actionError, setActionError] = useState<FriendlyError | null>(null);
  const [workingLabel, setWorkingLabel] = useState<string | null>(null);

  const [seller, lot, lotKind, lotToken, lotTokenId, lotAmount, payToken] =
    auction;
  const deadline = Number(auction[7]);
  const reservePrice = auction[8];
  const state = auction[9];
  const settledWinner = auction[10];
  const settledPrice = auction[11];
  const bidCount = auction[12];
  const isNft = lotKind === LOT_KIND_ERC721;
  const stateLabel = AUCTION_STATE_LABELS[state] ?? "Unknown";
  const isLive = state === 1 || state === 2;

  useEffect(() => {
    if (!isLive) return;
    const t = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(t);
  }, [isLive]);

  const pastDeadline = deadline > 0 && nowMs / 1000 >= deadline;
  const countdown = deadline ? formatCountdown(deadline, nowMs) : "";

  const { data: meta } = useReadContracts({
    contracts: [
      { address: payToken, abi: erc20Abi, functionName: "symbol" },
      { address: payToken, abi: erc20Abi, functionName: "decimals" },
      { address: lotToken, abi: demoAsset721Abi, functionName: "symbol" },
      { address: lotToken, abi: erc20Abi, functionName: "decimals" },
    ],
    // Token metadata never changes — read it once per session.
    query: { enabled: !!payToken && !!lotToken, staleTime: Infinity },
  });
  const tokenSymbol = (meta?.[0]?.result as string | undefined) ?? "tokens";
  const tokenDecimals = (meta?.[1]?.result as number | undefined) ?? 18;
  const lotSymbol = (meta?.[2]?.result as string | undefined) ?? "lot";
  const lotDecimals = (meta?.[3]?.result as number | undefined) ?? 18;

  // Who holds the lot right now — this is what "in escrow" actually means.
  const { data: lotHolder } = useReadContract({
    address: lotToken,
    abi: demoAsset721Abi,
    functionName: "ownerOf",
    args: [lotTokenId],
    query: { enabled: !!lotToken && isNft && isLive, refetchInterval: 30_000 },
  });

  const { data: bids, refetch: refetchBids } = useQuery({
    queryKey: ["bids", auctionId.toString()],
    queryFn: () => fetchBidLogs(auctionId),
    refetchInterval: isLive ? 30_000 : false,
  });

  // --- TEE result for a Closing auction ------------------------------------
  const isClosing = state === 2;
  const { data: closeInstructionId } = useQuery({
    queryKey: ["close-instruction", auctionId.toString()],
    queryFn: () => fetchCloseInstructionId(auctionId),
    enabled: isClosing,
    staleTime: 60_000,
  });
  const { data: polledOutcome } = useQuery({
    queryKey: ["close-result", auctionId.toString(), closeInstructionId],
    enabled: isClosing && !!closeInstructionId,
    refetchInterval: (query) => (query.state.data ? false : 10_000),
    queryFn: async (): Promise<TeeOutcome | null> => {
      const status = await peekActionResult(closeInstructionId!);
      if (status !== "confirmed") return null;
      return decodeOutcome(await pollActionResult(closeInstructionId!));
    },
  });
  const outcome = manualOutcome ?? polledOutcome ?? null;
  const hasWinner = !!outcome && outcome.winner !== ZERO;

  // Whether settlement can succeed right now: settle() pulls the payment from
  // the winner, so everyone except the winner is blocked until they approve.
  const { data: winnerAllowance } = useReadContract({
    address: payToken,
    abi: erc20Abi,
    functionName: "allowance",
    args: hasWinner ? [outcome!.winner, SEALED_AUCTION_ADDRESS] : undefined,
    query: { enabled: hasWinner, refetchInterval: 20_000 },
  });
  const winnerApproved =
    hasWinner &&
    winnerAllowance !== undefined &&
    winnerAllowance >= outcome!.clearingPrice;

  // --- per-bid liveness of the instruction pipeline -------------------------
  const confirmedIds = useRef<Set<string>>(new Set());
  const bidInstructionIds = (bids ?? []).map((b) => b.instructionId);
  const { data: bidTeeStatus } = useQuery({
    queryKey: ["bid-tee-status", auctionId.toString(), bidInstructionIds.join()],
    enabled: bidInstructionIds.length > 0 && isLive,
    refetchInterval: 20_000,
    queryFn: async () => {
      const entries = await Promise.all(
        bidInstructionIds.map(async (id) => {
          if (confirmedIds.current.has(id)) return [id, "confirmed"] as const;
          const status = await peekActionResult(id);
          if (status === "confirmed") confirmedIds.current.add(id);
          return [id, status] as const;
        }),
      );
      return Object.fromEntries(entries) as Record<string, BidTeeStatus>;
    },
  });
  const teeConfirmedCount = bidInstructionIds.filter(
    (id) => bidTeeStatus?.[id] === "confirmed",
  ).length;
  const teeUnreachable = bidInstructionIds.some(
    (id) => bidTeeStatus?.[id] === "unreachable",
  );
  const teePendingCount = bidInstructionIds.length - teeConfirmedCount;
  const showTeeWarning = !!bidTeeStatus && teePendingCount > 0;

  // --- roles ----------------------------------------------------------------
  const isSeller = !!address && seller.toLowerCase() === address.toLowerCase();
  const isBidder =
    !!address &&
    (bids ?? []).some((b) => b.bidder.toLowerCase() === address.toLowerCase());
  const isWinner =
    !!address &&
    hasWinner &&
    outcome!.winner.toLowerCase() === address.toLowerCase();
  const isSettledWinner =
    !!address && settledWinner.toLowerCase() === address.toLowerCase();
  const isParticipant = isSeller || isBidder;

  const roleBadge =
    isWinner || isSettledWinner
      ? "You won"
      : isSeller
        ? "You are the seller"
        : isBidder
          ? "You bid here"
          : null;

  const uiState: UiState = !isLive
    ? "terminal"
    : state === 1
      ? pastDeadline
        ? "openExpired"
        : "open"
      : outcome
        ? hasWinner
          ? "awaitingSettle"
          : "noWinner"
        : "awaitingTee";

  const inEscrow = !isNft
    ? isLive
    : lotHolder?.toLowerCase() === SEALED_AUCTION_ADDRESS.toLowerCase();

  function lotLabel(): string {
    if (isNft) return `${lotSymbol} #${lotTokenId.toString()}`;
    return `${formatUnits(lotAmount, lotDecimals)} ${lotSymbol}`;
  }

  function price(value: bigint): string {
    return `${formatUnits(value, tokenDecimals)} ${tokenSymbol}`;
  }

  /** One sentence: what happens next, and who is expected to act. */
  function stateLine(): { text: string; tone: "normal" | "muted" | "waiting" } {
    switch (uiState) {
      case "open":
        return {
          text: countdown
            ? `Bidding open — deadline in ${countdown}.`
            : "Bidding open — the deadline is passing now.",
          tone: "normal",
        };
      case "openExpired":
        return {
          text: "Awaiting close — anyone can trigger it; the TEE decides the winner.",
          tone: "waiting",
        };
      case "awaitingTee":
        return {
          text: "Close sent — waiting for the TEE result.",
          tone: "waiting",
        };
      case "awaitingSettle":
        if (isWinner)
          return {
            text: `You won at ${price(outcome!.clearingPrice)} — approve and settle to receive ${lotLabel()}.`,
            tone: "normal",
          };
        if (winnerApproved)
          return {
            text: `Winner ${shortenAddress(outcome!.winner)} decided at ${price(outcome!.clearingPrice)} — approved, settlement can be submitted by anyone.`,
            tone: "waiting",
          };
        return {
          text: `Winner decided at ${price(outcome!.clearingPrice)} — waiting for the winner (${shortenAddress(outcome!.winner)}) to approve & settle.`,
          tone: "waiting",
        };
      case "noWinner":
        return {
          text: "No bid met the reserve — settling returns the lot to the seller.",
          tone: "waiting",
        };
      case "terminal":
        return stateLabel === "Settled"
          ? {
              text: `Settled — ${shortenAddress(settledWinner)} paid ${price(settledPrice)}.`,
              tone: "muted",
            }
          : {
              text: "Cancelled — the lot went back to the seller.",
              tone: "muted",
            };
    }
  }

  // --- actions --------------------------------------------------------------
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
      onChanged();
      if (!instructionId)
        throw new Error("AuctionClosing event not found in receipt");

      setWorkingLabel("TEE is picking the winner…");
      setManualOutcome(decodeOutcome(await pollActionResult(instructionId)));
    } catch (e) {
      setActionError(friendlyError(e, "Close failed"));
    } finally {
      setWorkingLabel(null);
    }
  }

  async function settle() {
    if (!outcome || !payToken) return;
    setActionError(null);
    try {
      // Only the winner can approve their own allowance; anyone else is just
      // relaying a result the winner has already funded.
      if (isWinner && !winnerApproved) {
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
      onChanged();
    } catch (e) {
      setActionError(friendlyError(e, "Settle failed"));
    } finally {
      setWorkingLabel(null);
    }
  }

  async function cancelAuction() {
    setActionError(null);
    try {
      setWorkingLabel("Confirm cancelAuction — the lot returns to you…");
      await execute({
        address: SEALED_AUCTION_ADDRESS,
        abi: sealedAuctionAbi,
        functionName: "cancelAuction",
        args: [auctionId],
      });
      onChanged();
    } catch (e) {
      setActionError(friendlyError(e, "Cancel failed"));
    } finally {
      setWorkingLabel(null);
    }
  }

  const busy = isPending && !!workingLabel;
  const noWallet = !address;
  const line = stateLine();

  return (
    <article className="panel p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="font-semibold">
            #{auctionId.toString()} · {lot}
          </h3>
          <p className="mt-0.5 text-xs text-[var(--muted)]">
            Seller <span className="mono">{shortenAddress(seller)}</span> ·
            Reserve {reservePrice > 0n ? price(reservePrice) : "none"}
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
          <RoleBadge role={roleBadge} />
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

      <StateLine text={line.text} tone={line.tone} />

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
          <div className="mono">{formatDeadline(deadline)}</div>
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

      {/* --- Open: the primary action is the bid itself -------------------- */}
      {uiState === "open" &&
        (isSeller ? (
          <p className="mt-3 text-xs text-[var(--muted)]">
            You cannot bid on your own lot
            <InfoDot title={TOOLTIP.sellerNoBid} />
          </p>
        ) : (
          <BidForm
            auctionId={auctionId}
            tokenSymbol={tokenSymbol}
            tokenDecimals={tokenDecimals}
            onBidAccepted={() => {
              refetchBids();
              onChanged();
            }}
          />
        ))}

      {/* --- Close / re-run close ----------------------------------------- */}
      {(uiState === "openExpired" || uiState === "awaitingTee") && (
        <div className="mt-3">
          <ActionButton
            label={
              uiState === "awaitingTee" ? "Re-run close (recovery)" : "Close auction"
            }
            title={uiState === "awaitingTee" ? TOOLTIP.reclose : TOOLTIP.close}
            onClick={closeAuction}
            busy={busy}
            // Participants are expected to act; for a stranger this is allowed
            // but not their job, so it stays quiet.
            variant={isParticipant ? "primary" : "secondary"}
            disabledReason={
              noWallet ? "Connect a wallet to send the close instruction." : undefined
            }
          />
        </div>
      )}

      {/* --- Settle -------------------------------------------------------- */}
      {uiState === "awaitingSettle" &&
        (isWinner ? (
          <div className="mt-3">
            <ActionButton
              label={winnerApproved ? "Settle" : "Approve & settle"}
              title={TOOLTIP.settleWinner}
              onClick={settle}
              busy={busy}
              disabledReason={
                noWallet ? "Connect the winning wallet to settle." : undefined
              }
            />
          </div>
        ) : (
          <AdvancedRow>
            <ActionButton
              label="Settle (advanced)"
              title={TOOLTIP.settleAdvanced}
              onClick={settle}
              busy={busy}
              variant="secondary"
              disabledReason={
                noWallet ? "Connect a wallet to submit the settlement." : undefined
              }
            />
          </AdvancedRow>
        ))}

      {uiState === "noWinner" && (
        <div className="mt-3">
          <ActionButton
            label="Settle (return lot)"
            title={TOOLTIP.settleReturn}
            onClick={settle}
            busy={busy}
            variant={isSeller ? "primary" : "secondary"}
            disabledReason={
              noWallet ? "Connect a wallet to submit the settlement." : undefined
            }
          />
        </div>
      )}

      {/* --- Seller-only cancel, never the headline ------------------------ */}
      {(uiState === "open" || uiState === "openExpired") &&
        isSeller &&
        bidCount === 0n && (
          <AdvancedRow>
            <ActionButton
              label="Cancel auction"
              title={TOOLTIP.cancel}
              onClick={cancelAuction}
              busy={busy}
              variant="secondary"
            />
          </AdvancedRow>
        )}

      {showTeeWarning && (
        <p
          className="mt-3 text-xs"
          style={{ color: teeUnreachable ? "var(--red)" : "var(--amber)" }}
        >
          {teeUnreachable
            ? "TEE proxy unreachable"
            : `${teePendingCount} of ${bidInstructionIds.length} bids unconfirmed by the TEE`}
          <InfoDot title="Unconfirmed bids never reached the enclave and will be ignored at close." />{" "}
          <a className="underline" href="#verify">
            Check service status
          </a>
        </p>
      )}

      {workingLabel && (
        <p className="mt-2 text-xs text-[var(--amber)]">{workingLabel}</p>
      )}
      <ErrorNote error={actionError} />

      {bids && bids.length > 0 && (
        <details className="mt-3 text-xs" open={showTeeWarning}>
          <summary className="cursor-pointer text-[var(--muted)]">
            Bid commitments ({bids.length})
            {bidTeeStatus && ` · TEE confirmed ${teeConfirmedCount}/${bids.length}`}
          </summary>
          <ul className="mt-2 space-y-1">
            {bids.map((bid) => (
              <li
                key={bid.commitment}
                className="mono flex justify-between gap-2"
              >
                <span>
                  {shortenAddress(bid.bidder)}
                  {address &&
                    bid.bidder.toLowerCase() === address.toLowerCase() &&
                    " (you)"}
                </span>
                <span className="text-[var(--muted)]">
                  {shortenHash(bid.commitment)}
                </span>
                <TeeBadge status={bidTeeStatus?.[bid.instructionId]} />
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
