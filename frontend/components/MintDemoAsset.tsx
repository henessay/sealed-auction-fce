"use client";

import { useState } from "react";
import { decodeEventLog, parseAbi } from "viem";
import { useAccount, useReadContract } from "wagmi";

import { demoAsset721Abi } from "@/lib/abi/sealedAuction";
import { DEMO_ASSET_ADDRESS, EXPLORER_ADDRESS_URL } from "@/lib/config";
import { shortenHash } from "@/lib/format";
import { type FriendlyError, friendlyError } from "@/lib/errors";
import { useTx } from "@/lib/hooks/useTx";
import { ErrorNote } from "./ErrorNote";

const transferEventAbi = parseAbi([
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
]);

/// Dev helper: mint a demo NFT to use as a lot. Only the DemoAsset721 owner
/// can mint, so the panel hides itself for everyone else.
export function MintDemoAsset() {
  const { address } = useAccount();
  const { execute, isPending } = useTx();
  const [minted, setMinted] = useState<bigint | null>(null);
  const [error, setError] = useState<FriendlyError | null>(null);

  const { data: assetOwner } = useReadContract({
    address: DEMO_ASSET_ADDRESS,
    abi: demoAsset721Abi,
    functionName: "owner",
  });

  const canMint =
    !!address &&
    !!assetOwner &&
    assetOwner.toLowerCase() === address.toLowerCase();

  if (!canMint) return null;

  async function mint() {
    setError(null);
    try {
      const receipt = await execute({
        address: DEMO_ASSET_ADDRESS,
        abi: demoAsset721Abi,
        functionName: "mint",
        args: [address!],
      });
      for (const log of receipt.logs) {
        if (log.address.toLowerCase() !== DEMO_ASSET_ADDRESS.toLowerCase())
          continue;
        try {
          const decoded = decodeEventLog({
            abi: transferEventAbi,
            data: log.data,
            topics: log.topics,
            eventName: "Transfer",
          });
          setMinted(decoded.args.tokenId);
          break;
        } catch {
          /* not this event */
        }
      }
    } catch (e) {
      setError(friendlyError(e, "Minting the demo NFT failed."));
    }
  }

  return (
    <section className="panel p-4" id="mint-demo">
      <h2 className="mb-2 text-sm font-semibold">Demo asset (dev)</h2>
      <p className="mb-2 text-xs text-[var(--muted)]">
        Mint a{" "}
        <a
          className="text-[var(--accent-soft)] hover:underline"
          href={`${EXPLORER_ADDRESS_URL}${DEMO_ASSET_ADDRESS}`}
          target="_blank"
          rel="noreferrer"
        >
          DemoAsset721
        </a>{" "}
        token ({shortenHash(DEMO_ASSET_ADDRESS)}) to your wallet, then use its id
        as an auction lot.
      </p>
      <button className="btn btn-secondary" onClick={mint} disabled={isPending}>
        {isPending ? "Minting…" : "Mint demo NFT"}
      </button>
      {minted !== null && (
        <p className="mt-2 text-xs text-[var(--green)]">
          Minted token id {minted.toString()} — use it as the lot token id.
        </p>
      )}
      <ErrorNote error={error} />
    </section>
  );
}
