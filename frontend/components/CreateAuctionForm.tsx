"use client";

import { useState } from "react";
import { parseUnits } from "viem";
import { useAccount, usePublicClient } from "wagmi";

import { erc20Abi, sealedAuctionAbi } from "@/lib/abi/sealedAuction";
import { SEALED_AUCTION_ADDRESS } from "@/lib/config";
import { useTx } from "@/lib/hooks/useTx";

export function CreateAuctionForm({ onCreated }: { onCreated: () => void }) {
  const { address } = useAccount();
  const publicClient = usePublicClient();
  const { execute, isPending } = useTx();
  const [open, setOpen] = useState(false);
  const [lot, setLot] = useState("");
  const [payToken, setPayToken] = useState("");
  const [minutes, setMinutes] = useState("5");
  const [reserve, setReserve] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setError(null);
    try {
      if (!publicClient) throw new Error("RPC not ready");
      if (!lot.trim()) throw new Error("Lot description required");
      const token = payToken.trim() as `0x${string}`;
      if (!/^0x[0-9a-fA-F]{40}$/.test(token))
        throw new Error("Pay token must be an ERC-20 address");

      const decimals = await publicClient.readContract({
        address: token,
        abi: erc20Abi,
        functionName: "decimals",
      });

      const mins = Number(minutes);
      if (!Number.isFinite(mins) || mins <= 0)
        throw new Error("Duration must be positive minutes");

      // Anchor to chain time — local clocks skew vs block.timestamp.
      const head = await publicClient.getBlock();
      const deadline = head.timestamp + BigInt(Math.round(mins * 60));

      const reserveWei = reserve.trim()
        ? parseUnits(reserve.trim(), decimals)
        : 0n;

      await execute({
        address: SEALED_AUCTION_ADDRESS,
        abi: sealedAuctionAbi,
        functionName: "createAuction",
        args: [lot.trim(), token, deadline, reserveWei],
      });

      setLot("");
      setReserve("");
      setOpen(false);
      onCreated();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Create failed");
    }
  }

  if (!open) {
    return (
      <button
        className="btn btn-secondary"
        onClick={() => setOpen(true)}
        disabled={!address}
      >
        + New auction
      </button>
    );
  }

  return (
    <div className="panel p-4">
      <h3 className="mb-3 text-sm font-semibold">Create auction</h3>
      <div className="grid gap-2 sm:grid-cols-2">
        <input
          className="input sm:col-span-2"
          placeholder="Lot description (e.g. Signed hackathon hoodie)"
          value={lot}
          onChange={(e) => setLot(e.target.value)}
        />
        <input
          className="input sm:col-span-2"
          placeholder="Pay token address (e.g. FXRP)"
          value={payToken}
          onChange={(e) => setPayToken(e.target.value)}
        />
        <input
          className="input"
          placeholder="Duration (minutes)"
          inputMode="numeric"
          value={minutes}
          onChange={(e) => setMinutes(e.target.value)}
        />
        <input
          className="input"
          placeholder="Reserve price (optional)"
          inputMode="decimal"
          value={reserve}
          onChange={(e) => setReserve(e.target.value)}
        />
      </div>
      <div className="mt-3 flex gap-2">
        <button className="btn" onClick={submit} disabled={isPending}>
          {isPending ? "Creating…" : "Create"}
        </button>
        <button
          className="btn btn-secondary"
          onClick={() => setOpen(false)}
          disabled={isPending}
        >
          Cancel
        </button>
      </div>
      {error && (
        <p className="mt-2 break-all text-xs text-[var(--red)]">{error}</p>
      )}
    </div>
  );
}
