"use client";

import { useState } from "react";
import { decodeEventLog, parseUnits } from "viem";
import { useAccount } from "wagmi";

import { sealedAuctionAbi } from "@/lib/abi/sealedAuction";
import {
  EXPLORER_TX_URL,
  INSTRUCTION_FEE_WEI,
  SEALED_AUCTION_ADDRESS,
} from "@/lib/config";
import { type FriendlyError, friendlyError } from "@/lib/errors";
import { useTx } from "@/lib/hooks/useTx";
import { buildBidCiphertext } from "@/lib/tee/ecies";
import {
  fetchTeeInfo,
  pollActionResult,
  TeeResultUnavailableError,
} from "@/lib/tee/proxy";
import { ErrorNote } from "./ErrorNote";
import { InfoDot } from "./ui";

type Props = {
  auctionId: bigint;
  tokenSymbol: string;
  tokenDecimals: number;
  onBidAccepted: () => void;
};

type Step =
  | { phase: "idle" }
  | { phase: "working"; label: string }
  | { phase: "accepted" }
  /** Transaction mined, TEE silent — a pipeline problem, not a user error. */
  | { phase: "unconfirmed"; hash: `0x${string}` | null }
  | { phase: "error"; error: FriendlyError };

export function BidForm({
  auctionId,
  tokenSymbol,
  tokenDecimals,
  onBidAccepted,
}: Props) {
  const { address } = useAccount();
  const { execute } = useTx();
  const [amount, setAmount] = useState("");
  const [step, setStep] = useState<Step>({ phase: "idle" });

  const busy = step.phase === "working";

  async function submit() {
    if (!address) return;
    let amountWei: bigint;
    try {
      amountWei = parseUnits(amount, tokenDecimals);
    } catch {
      setStep({
        phase: "error",
        error: {
          message: "That is not a valid amount.",
          details: "",
          transient: false,
        },
      });
      return;
    }
    if (amountWei <= 0n) {
      setStep({
        phase: "error",
        error: {
          message: "The bid amount must be greater than zero.",
          details: "",
          transient: false,
        },
      });
      return;
    }

    let bidHash: `0x${string}` | null = null;
    try {
      setStep({ phase: "working", label: "Fetching TEE public key…" });
      const info = await fetchTeeInfo();

      setStep({ phase: "working", label: "Encrypting bid (ECIES)…" });
      const ciphertext = await buildBidCiphertext(
        info.machineData.publicKey,
        auctionId,
        SEALED_AUCTION_ADDRESS,
        address,
        amountWei,
      );

      setStep({ phase: "working", label: "Confirm placeBid in your wallet…" });
      const receipt = await execute({
        address: SEALED_AUCTION_ADDRESS,
        abi: sealedAuctionAbi,
        functionName: "placeBid",
        args: [auctionId, ciphertext],
        value: INSTRUCTION_FEE_WEI,
      });
      bidHash = receipt.transactionHash;

      let instructionId: `0x${string}` | null = null;
      for (const log of receipt.logs) {
        if (log.address.toLowerCase() !== SEALED_AUCTION_ADDRESS.toLowerCase())
          continue;
        try {
          const decoded = decodeEventLog({
            abi: sealedAuctionAbi,
            data: log.data,
            topics: log.topics,
            eventName: "BidPlaced",
          });
          instructionId = decoded.args.instructionId;
          break;
        } catch {
          /* not this event */
        }
      }
      if (!instructionId) throw new Error("BidPlaced event not found in receipt");

      setStep({ phase: "working", label: "Waiting for TEE acceptance…" });
      const result = await pollActionResult(instructionId);
      const body = JSON.parse(
        Buffer.from(result.result.data.slice(2), "hex").toString("utf8"),
      ) as { accepted?: boolean };
      if (!body.accepted) throw new Error("TEE rejected the bid");

      setStep({ phase: "accepted" });
      setAmount("");
      onBidAccepted();
    } catch (e) {
      // The bid is mined and the commitment is on-chain; only the TEE leg is
      // missing. Say exactly that instead of surfacing a proxy status code,
      // and still refresh so the bid shows up with a pending TEE badge.
      if (e instanceof TeeResultUnavailableError) {
        setStep({ phase: "unconfirmed", hash: bidHash });
        setAmount("");
        onBidAccepted();
        return;
      }
      setStep({ phase: "error", error: friendlyError(e, "The bid failed.") });
    }
  }

  return (
    <div className="mt-3 border-t border-[var(--border)] pt-3">
      <div className="flex gap-2">
        <input
          className="input"
          placeholder={`Bid amount (${tokenSymbol})`}
          value={amount}
          inputMode="decimal"
          onChange={(e) => setAmount(e.target.value)}
          disabled={busy}
        />
        <button
          className="btn shrink-0"
          onClick={submit}
          disabled={busy || !address || !amount}
        >
          {busy ? "Working…" : "Place sealed bid"}
        </button>
      </div>
      <p className="mt-2 text-xs text-[var(--muted)]">
        {address ? (
          <>
            Encrypted in your browser — only ciphertext goes on-chain
            <InfoDot title="Anyone except the seller may bid until the deadline. Approve this contract on the pay token for at least your bid, or a winning bid cannot settle." />
          </>
        ) : (
          "Connect a wallet to place a sealed bid."
        )}
      </p>
      {step.phase === "working" && (
        <p className="mt-2 text-xs text-[var(--amber)]">{step.label}</p>
      )}
      {step.phase === "accepted" && (
        <p className="mt-2 text-xs text-[var(--green)]">
          Sealed bid accepted by the TEE ✓
        </p>
      )}
      {step.phase === "unconfirmed" && (
        <p className="mt-2 text-xs text-[var(--amber)]">
          Bid is on-chain, but TEE confirmation hasn&apos;t arrived — the
          extension may be unreachable.{" "}
          <a className="underline" href="#verify">
            Check service status
          </a>
          .
          {step.hash && (
            <>
              {" "}
              <a
                className="text-[var(--accent-soft)] hover:underline"
                href={`${EXPLORER_TX_URL}${step.hash}`}
                target="_blank"
                rel="noreferrer"
              >
                bid tx ↗
              </a>
            </>
          )}
        </p>
      )}
      {step.phase === "error" && <ErrorNote error={step.error} />}
    </div>
  );
}
