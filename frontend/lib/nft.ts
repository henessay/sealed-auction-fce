"use client";

import { type Address, isAddress } from "viem";
import type { usePublicClient } from "wagmi";

import {
  erc721Abi,
  erc721EnumerableAbi,
  sequentialMintAbi,
} from "@/lib/abi/sealedAuction";
import { EXPLORER_API_URL, MULTICALL3_ADDRESS } from "@/lib/config";

type Client = NonNullable<ReturnType<typeof usePublicClient>>;

/** How the owned set was obtained — surfaced in the UI as a one-line hint. */
export type EnumerationMethod = "enumerable" | "sequential" | "explorer";

export type NftEnumeration = {
  tokenIds: bigint[];
  method: EnumerationMethod;
  /** Set when the id scan was capped and the list may be incomplete. */
  truncated: boolean;
};

/** Sequential scans stay one multicall wide; bigger collections go to the explorer. */
const MAX_SEQUENTIAL_SCAN = 600;

/**
 * List the tokenIds `owner` holds in `collection`.
 *
 * Coston2's public RPC caps eth_getLogs at 30 blocks, so a Transfer-log scan
 * is not viable in the browser. Three paths instead, cheapest first:
 *
 *   1. ERC721Enumerable — tokenOfOwnerByIndex, exact and standard.
 *   2. Sequential ids — nextTokenId()/totalSupply() then an ownerOf() sweep.
 *      This is what our DemoAsset721 needs (it is not Enumerable).
 *   3. Blockscout — /addresses/{owner}/nft, an index of every collection.
 *
 * Throws only if the address is not an ERC-721 or every path fails; the caller
 * then falls back to a manual tokenId input.
 */
export async function enumerateOwnedNfts(
  client: Client,
  collection: Address,
  owner: Address,
): Promise<NftEnumeration> {
  // balanceOf doubles as the "is this really an ERC-721" probe.
  const balance = await client.readContract({
    address: collection,
    abi: erc721Abi,
    functionName: "balanceOf",
    args: [owner],
  });
  if (balance === 0n) {
    return { tokenIds: [], method: "enumerable", truncated: false };
  }

  const fromEnumerable = await tryEnumerable(client, collection, owner, balance);
  if (fromEnumerable) {
    return { tokenIds: fromEnumerable, method: "enumerable", truncated: false };
  }

  const fromSequential = await trySequentialScan(
    client,
    collection,
    owner,
    balance,
  );
  if (fromSequential) return fromSequential;

  const fromExplorer = await tryExplorer(collection, owner);
  if (fromExplorer) {
    return { tokenIds: fromExplorer, method: "explorer", truncated: false };
  }

  throw new Error("Could not enumerate this collection");
}

async function tryEnumerable(
  client: Client,
  collection: Address,
  owner: Address,
  balance: bigint,
): Promise<bigint[] | null> {
  const indices = Array.from({ length: Number(balance) }, (_, i) => BigInt(i));
  try {
    const results = await client.multicall({
      multicallAddress: MULTICALL3_ADDRESS,
      allowFailure: true,
      contracts: indices.map((index) => ({
        address: collection,
        abi: erc721EnumerableAbi,
        functionName: "tokenOfOwnerByIndex" as const,
        args: [owner, index] as const,
      })),
    });
    const ids = results
      .filter((r) => r.status === "success")
      .map((r) => r.result as bigint);
    // A partial answer means the collection is not really Enumerable.
    return ids.length === Number(balance) ? ids : null;
  } catch {
    return null;
  }
}

async function trySequentialScan(
  client: Client,
  collection: Address,
  owner: Address,
  balance: bigint,
): Promise<NftEnumeration | null> {
  const supply = await readIdCeiling(client, collection);
  if (supply === null || supply === 0n) return null;

  // Ids may start at 0 or 1 — sweep the whole range and let ownerOf decide.
  const ceiling = supply > BigInt(MAX_SEQUENTIAL_SCAN)
    ? BigInt(MAX_SEQUENTIAL_SCAN)
    : supply;
  const truncated = ceiling < supply;
  const candidates = Array.from({ length: Number(ceiling) + 1 }, (_, i) =>
    BigInt(i),
  );

  try {
    const results = await client.multicall({
      multicallAddress: MULTICALL3_ADDRESS,
      allowFailure: true,
      contracts: candidates.map((tokenId) => ({
        address: collection,
        abi: erc721Abi,
        functionName: "ownerOf" as const,
        args: [tokenId] as const,
      })),
    });
    const ids = candidates.filter((_, i) => {
      const r = results[i];
      return (
        r.status === "success" &&
        (r.result as Address).toLowerCase() === owner.toLowerCase()
      );
    });
    if (ids.length === 0) return null;
    return {
      tokenIds: ids,
      method: "sequential",
      truncated: truncated && BigInt(ids.length) < balance,
    };
  } catch {
    return null;
  }
}

/** nextTokenId() (our demo asset) or totalSupply() — whichever the token exposes. */
async function readIdCeiling(
  client: Client,
  collection: Address,
): Promise<bigint | null> {
  try {
    return await client.readContract({
      address: collection,
      abi: sequentialMintAbi,
      functionName: "nextTokenId",
    });
  } catch {
    /* not a sequential minter — try the ERC721Enumerable supply */
  }
  try {
    return await client.readContract({
      address: collection,
      abi: erc721EnumerableAbi,
      functionName: "totalSupply",
    });
  } catch {
    return null;
  }
}

type ExplorerNftItem = {
  id?: string;
  token?: { address_hash?: string; address?: string };
};

async function tryExplorer(
  collection: Address,
  owner: Address,
): Promise<bigint[] | null> {
  try {
    const res = await fetch(
      `${EXPLORER_API_URL}/addresses/${owner}/nft?type=ERC-721`,
      { headers: { accept: "application/json" } },
    );
    if (!res.ok) return null;
    const body = (await res.json()) as { items?: ExplorerNftItem[] };
    const wanted = collection.toLowerCase();
    const ids = (body.items ?? [])
      .filter((item) => {
        const addr = item.token?.address_hash ?? item.token?.address ?? "";
        return addr.toLowerCase() === wanted;
      })
      .map((item) => item.id)
      .filter((id): id is string => !!id && /^\d+$/.test(id))
      .map((id) => BigInt(id));
    return ids.length > 0 ? ids : null;
  } catch {
    return null;
  }
}

export function isAddressLike(value: string): value is Address {
  return isAddress(value.trim());
}
