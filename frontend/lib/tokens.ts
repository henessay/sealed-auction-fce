"use client";

import { useQuery } from "@tanstack/react-query";
import { type Address, isAddress, zeroAddress } from "viem";
import { usePublicClient } from "wagmi";

import {
  assetManagerAbi,
  erc20Abi,
  flareContractRegistryAbi,
} from "@/lib/abi/sealedAuction";
import {
  FLARE_CONTRACT_REGISTRY,
  FXRP_FALLBACK_ADDRESS,
  USDT0_ADDRESS,
} from "@/lib/config";

type Client = NonNullable<ReturnType<typeof usePublicClient>>;

export type PayTokenPresetId = "FXRP" | "USDT0" | "CUSTOM";

export type TokenMeta = { symbol: string; decimals: number };

/**
 * FXRP the same way tools/pkg/utils/fxrp.go does it: ContractRegistry →
 * AssetManagerFXRP → fAsset(). Falls back to the pinned address only if the
 * registry hop fails, so a redeployed AssetManager is picked up automatically.
 */
export async function resolveFxrpAddress(client: Client): Promise<Address> {
  try {
    const assetManager = await client.readContract({
      address: FLARE_CONTRACT_REGISTRY,
      abi: flareContractRegistryAbi,
      functionName: "getContractAddressByName",
      args: ["AssetManagerFXRP"],
    });
    if (assetManager !== zeroAddress) {
      const fAsset = await client.readContract({
        address: assetManager,
        abi: assetManagerAbi,
        functionName: "fAsset",
      });
      if (fAsset !== zeroAddress) return fAsset;
    }
  } catch {
    /* registry unavailable — fall through to the pinned address */
  }
  return FXRP_FALLBACK_ADDRESS;
}

export function useFxrpAddress() {
  const publicClient = usePublicClient();
  return useQuery({
    queryKey: ["fxrp-address"],
    enabled: !!publicClient,
    staleTime: Infinity,
    queryFn: () => resolveFxrpAddress(publicClient!),
  });
}

/** symbol()/decimals() for any ERC-20; undefined while loading or invalid. */
export function useTokenMeta(address: string | undefined) {
  const publicClient = usePublicClient();
  const valid = !!address && isAddress(address);
  return useQuery<TokenMeta>({
    queryKey: ["token-meta", address?.toLowerCase()],
    enabled: valid && !!publicClient,
    staleTime: Infinity,
    queryFn: async () => {
      const token = address as Address;
      const [symbol, decimals] = await Promise.all([
        publicClient!.readContract({
          address: token,
          abi: erc20Abi,
          functionName: "symbol",
        }),
        publicClient!.readContract({
          address: token,
          abi: erc20Abi,
          functionName: "decimals",
        }),
      ]);
      return { symbol, decimals: Number(decimals) };
    },
  });
}

export const PAY_TOKEN_PRESETS: Array<{
  id: PayTokenPresetId;
  label: string;
  hint: string;
  address?: Address;
}> = [
  {
    id: "FXRP",
    label: "FXRP",
    hint: "Bridged XRP FAsset — resolved live via ContractRegistry → AssetManagerFXRP → fAsset()",
    address: FXRP_FALLBACK_ADDRESS,
  },
  {
    id: "USDT0",
    label: "USDT0",
    hint: "Coston2 test stablecoin — claim 10 per day at faucet.flare.network",
    address: USDT0_ADDRESS,
  },
  { id: "CUSTOM", label: "Custom…", hint: "Any ERC-20 on Coston2" },
];
