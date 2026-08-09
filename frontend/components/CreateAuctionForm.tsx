"use client";

import { useState } from "react";
import { parseUnits } from "viem";
import { useAccount, usePublicClient } from "wagmi";

import {
  demoAsset721Abi,
  erc20Abi,
  LOT_KIND_ERC20,
  LOT_KIND_ERC721,
  sealedAuctionAbi,
} from "@/lib/abi/sealedAuction";
import { DEMO_ASSET_ADDRESS, SEALED_AUCTION_ADDRESS } from "@/lib/config";
import { useTx } from "@/lib/hooks/useTx";

export function CreateAuctionForm({ onCreated }: { onCreated: () => void }) {
  const { address } = useAccount();
  const publicClient = usePublicClient();
  const { execute, isPending } = useTx();
  const [open, setOpen] = useState(false);
  const [lot, setLot] = useState("");
  const [lotKind, setLotKind] = useState<number>(LOT_KIND_ERC721);
  const [lotToken, setLotToken] = useState<string>(DEMO_ASSET_ADDRESS);
  const [lotTokenId, setLotTokenId] = useState("");
  const [lotAmount, setLotAmount] = useState("");
  const [payToken, setPayToken] = useState("");
  const [minutes, setMinutes] = useState("5");
  const [reserve, setReserve] = useState("");
  const [step, setStep] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const isNft = lotKind === LOT_KIND_ERC721;

  function requireAddress(value: string, label: string): `0x${string}` {
    const trimmed = value.trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(trimmed))
      throw new Error(`${label} must be a contract address`);
    return trimmed as `0x${string}`;
  }

  async function submit() {
    setError(null);
    try {
      if (!publicClient) throw new Error("RPC not ready");
      if (!lot.trim()) throw new Error("Lot description required");
      const lotAddress = requireAddress(lotToken, "Lot token");
      const payAddress = requireAddress(payToken, "Pay token");

      const payDecimals = await publicClient.readContract({
        address: payAddress,
        abi: erc20Abi,
        functionName: "decimals",
      });

      let tokenIdArg = 0n;
      let amountArg = 0n;

      // The auction pulls the lot into escrow on creation, so it needs an
      // allowance first — this is the "approve lot" step.
      if (isNft) {
        if (!/^\d+$/.test(lotTokenId.trim()))
          throw new Error("Token id required for an NFT lot");
        tokenIdArg = BigInt(lotTokenId.trim());
        setStep("Approving the NFT for escrow…");
        await execute({
          address: lotAddress,
          abi: demoAsset721Abi,
          functionName: "approve",
          args: [SEALED_AUCTION_ADDRESS, tokenIdArg],
        });
      } else {
        if (!lotAmount.trim()) throw new Error("Lot amount required");
        const lotDecimals = await publicClient.readContract({
          address: lotAddress,
          abi: erc20Abi,
          functionName: "decimals",
        });
        amountArg = parseUnits(lotAmount.trim(), lotDecimals);
        setStep("Approving the lot tokens for escrow…");
        await execute({
          address: lotAddress,
          abi: erc20Abi,
          functionName: "approve",
          args: [SEALED_AUCTION_ADDRESS, amountArg],
        });
      }

      const mins = Number(minutes);
      if (!Number.isFinite(mins) || mins <= 0)
        throw new Error("Duration must be positive minutes");

      // Anchor to chain time — local clocks skew vs block.timestamp.
      const head = await publicClient.getBlock();
      const deadline = head.timestamp + BigInt(Math.round(mins * 60));

      const reserveWei = reserve.trim()
        ? parseUnits(reserve.trim(), payDecimals)
        : 0n;

      setStep("Creating the auction and escrowing the lot…");
      await execute({
        address: SEALED_AUCTION_ADDRESS,
        abi: sealedAuctionAbi,
        functionName: "createAuction",
        args: [
          lot.trim(),
          lotKind,
          lotAddress,
          tokenIdArg,
          amountArg,
          payAddress,
          deadline,
          reserveWei,
        ],
      });

      setLot("");
      setReserve("");
      setLotTokenId("");
      setLotAmount("");
      setOpen(false);
      onCreated();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Create failed");
    } finally {
      setStep(null);
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
          placeholder="Lot description (e.g. Demo house deed #1)"
          value={lot}
          onChange={(e) => setLot(e.target.value)}
        />
      </div>

      <fieldset className="mt-3 rounded-lg border border-[var(--border)] p-3">
        <legend className="px-1 text-xs text-[var(--muted)]">
          Lot — escrowed by the contract on creation
        </legend>
        <div className="mb-2 flex gap-2">
          <button
            type="button"
            className={`btn ${isNft ? "" : "btn-secondary"}`}
            onClick={() => setLotKind(LOT_KIND_ERC721)}
          >
            NFT (ERC-721)
          </button>
          <button
            type="button"
            className={`btn ${isNft ? "btn-secondary" : ""}`}
            onClick={() => setLotKind(LOT_KIND_ERC20)}
          >
            Tokens (ERC-20)
          </button>
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          <input
            className="input sm:col-span-2"
            placeholder="Lot token address"
            value={lotToken}
            onChange={(e) => setLotToken(e.target.value)}
          />
          {isNft ? (
            <input
              className="input"
              placeholder="Token id"
              inputMode="numeric"
              value={lotTokenId}
              onChange={(e) => setLotTokenId(e.target.value)}
            />
          ) : (
            <input
              className="input"
              placeholder="Lot amount"
              inputMode="decimal"
              value={lotAmount}
              onChange={(e) => setLotAmount(e.target.value)}
            />
          )}
        </div>
      </fieldset>

      <div className="mt-3 grid gap-2 sm:grid-cols-2">
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
          {isPending ? "Working…" : "Approve lot & create"}
        </button>
        <button
          className="btn btn-secondary"
          onClick={() => setOpen(false)}
          disabled={isPending}
        >
          Cancel
        </button>
      </div>
      {step && <p className="mt-2 text-xs text-[var(--amber)]">{step}</p>}
      {error && (
        <p className="mt-2 break-all text-xs text-[var(--red)]">{error}</p>
      )}
    </div>
  );
}
