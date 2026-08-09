"use client";

import { useState } from "react";
import { decodeEventLog, parseUnits } from "viem";
import { useAccount } from "wagmi";

import { sealedAuctionAbi } from "@/lib/abi/sealedAuction";
import { INSTRUCTION_FEE_WEI, SEALED_AUCTION_ADDRESS } from "@/lib/config";
import { useTx } from "@/lib/hooks/useTx";
import { buildBidCiphertext } from "@/lib/tee/ecies";
import { fetchTeeInfo, pollActionResult } from "@/lib/tee/proxy";

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
  | { phase: "error"; message: string };

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
      setStep({ phase: "error", message: "Invalid amount" });
      return;
    }
    if (amountWei <= 0n) {
      setStep({ phase: "error", message: "Amount must be positive" });
      return;
    }

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
      setStep({
        phase: "error",
        message: e instanceof Error ? e.message : "Bid failed",
      });
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
        The amount is encrypted in your browser under the TEE key — only an
        opaque ciphertext goes on-chain. Approve this contract on the pay token
        for at least your bid, or a winning bid cannot settle.
      </p>
      {step.phase === "working" && (
        <p className="mt-2 text-xs text-[var(--amber)]">{step.label}</p>
      )}
      {step.phase === "accepted" && (
        <p className="mt-2 text-xs text-[var(--green)]">
          Sealed bid accepted by the TEE ✓
        </p>
      )}
      {step.phase === "error" && (
        <p className="mt-2 break-all text-xs text-[var(--red)]">{step.message}</p>
      )}
    </div>
  );
}
