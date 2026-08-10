"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { type Address, isAddress } from "viem";
import { useAccount, usePublicClient, useReadContract } from "wagmi";

import { erc721Abi } from "@/lib/abi/sealedAuction";
import { DEMO_ASSET_ADDRESS, EXPLORER_ADDRESS_URL } from "@/lib/config";
import { friendlyError } from "@/lib/errors";
import { shortenAddress } from "@/lib/format";
import { enumerateOwnedNfts, type NftEnumeration } from "@/lib/nft";

const METHOD_HINT: Record<NftEnumeration["method"], string> = {
  enumerable: "via ERC721Enumerable",
  sequential: "via ownerOf sweep",
  explorer: "via explorer index",
};

/**
 * Wallet-aware lot picker: lists the NFTs the connected seller actually owns
 * instead of asking for a hand-typed tokenId. Any collection works; if it
 * cannot be enumerated the manual input comes back with a note.
 */
export function NftPicker({
  collection,
  onCollectionChange,
  tokenId,
  onTokenIdChange,
}: {
  collection: string;
  onCollectionChange: (address: string) => void;
  tokenId: string;
  onTokenIdChange: (tokenId: string) => void;
}) {
  const { address: owner } = useAccount();
  const publicClient = usePublicClient();
  const [otherCollection, setOtherCollection] = useState(
    collection.toLowerCase() !== DEMO_ASSET_ADDRESS.toLowerCase(),
  );

  const collectionValid = isAddress(collection);

  const { data: symbol } = useReadContract({
    address: collectionValid ? (collection as Address) : undefined,
    abi: erc721Abi,
    functionName: "symbol",
    query: { enabled: collectionValid },
  });

  const owned = useQuery<NftEnumeration>({
    queryKey: ["owned-nfts", collection.toLowerCase(), owner?.toLowerCase()],
    enabled: collectionValid && !!owner && !!publicClient,
    retry: false,
    queryFn: () =>
      enumerateOwnedNfts(publicClient!, collection as Address, owner!),
  });

  // Pre-select the first owned token so the happy path is one click.
  const onTokenIdChangeRef = useRef(onTokenIdChange);
  onTokenIdChangeRef.current = onTokenIdChange;
  const ids = owned.data?.tokenIds;
  useEffect(() => {
    if (!ids || ids.length === 0) return;
    const stillOwned = ids.some((id) => id.toString() === tokenId);
    if (!stillOwned) onTokenIdChangeRef.current(ids[0].toString());
  }, [ids, tokenId]);

  const label = symbol ?? "NFT";
  const isDemoCollection =
    collection.toLowerCase() === DEMO_ASSET_ADDRESS.toLowerCase();

  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={`btn ${otherCollection ? "btn-secondary" : ""}`}
          onClick={() => {
            setOtherCollection(false);
            onCollectionChange(DEMO_ASSET_ADDRESS);
            onTokenIdChange("");
          }}
        >
          Demo collection
        </button>
        <button
          type="button"
          className={`btn ${otherCollection ? "" : "btn-secondary"}`}
          onClick={() => {
            setOtherCollection(true);
            onTokenIdChange("");
          }}
        >
          Other collection…
        </button>
        {collectionValid && (
          <a
            className="mono text-xs text-[var(--accent-soft)] hover:underline"
            href={`${EXPLORER_ADDRESS_URL}${collection}`}
            target="_blank"
            rel="noreferrer"
          >
            {symbol ? `${symbol} ` : ""}
            {shortenAddress(collection)}
          </a>
        )}
      </div>

      {otherCollection && (
        <input
          className="input"
          placeholder="ERC-721 collection address (0x…)"
          value={collection}
          onChange={(e) => onCollectionChange(e.target.value)}
        />
      )}

      {!owner ? (
        <ManualTokenId
          tokenId={tokenId}
          onTokenIdChange={onTokenIdChange}
          note="Connect a wallet to list the NFTs you own."
        />
      ) : !collectionValid ? (
        <p className="text-xs text-[var(--muted)]">
          Enter a collection address to list your tokens.
        </p>
      ) : owned.isPending ? (
        <p className="text-xs text-[var(--muted)]">Loading your tokens…</p>
      ) : owned.isError ? (
        <ManualTokenId
          tokenId={tokenId}
          onTokenIdChange={onTokenIdChange}
          note={`Could not list this collection (${
            friendlyError(owned.error, "read failed").message
          }) — enter the token id manually.`}
        />
      ) : owned.data.tokenIds.length === 0 ? (
        <p className="text-xs text-[var(--amber)]">
          No {label} tokens found in this wallet
          {isDemoCollection ? (
            <>
              {" — "}
              <a className="text-[var(--accent-soft)] hover:underline" href="#mint-demo">
                mint a demo NFT
              </a>
              .
            </>
          ) : (
            "."
          )}
        </p>
      ) : (
        <div>
          <select
            className="input"
            value={tokenId}
            onChange={(e) => onTokenIdChange(e.target.value)}
          >
            {owned.data.tokenIds.map((id) => (
              <option key={id.toString()} value={id.toString()}>
                {label} #{id.toString()}
              </option>
            ))}
          </select>
          <p className="mt-1 text-xs text-[var(--muted)]">
            You own {owned.data.tokenIds.length} in this collection{" "}
            {METHOD_HINT[owned.data.method]}
            {owned.data.truncated && " · list may be incomplete (id scan capped)"}
          </p>
        </div>
      )}
    </div>
  );
}

function ManualTokenId({
  tokenId,
  onTokenIdChange,
  note,
}: {
  tokenId: string;
  onTokenIdChange: (value: string) => void;
  note: string;
}) {
  return (
    <div>
      <input
        className="input"
        placeholder="Token id"
        inputMode="numeric"
        value={tokenId}
        onChange={(e) => onTokenIdChange(e.target.value)}
      />
      <p className="mt-1 text-xs text-[var(--muted)]">{note}</p>
    </div>
  );
}
