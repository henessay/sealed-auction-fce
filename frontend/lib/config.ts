import { type Address, zeroAddress } from "viem";

function addressFromEnv(value: string | undefined, fallback: Address): Address {
  if (!value || value.length < 42) return fallback;
  return value as Address;
}

export const CHAIN_ID = Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? "114");

export const RPC_URL =
  process.env.NEXT_PUBLIC_RPC_URL ??
  "https://coston2-api.flare.network/ext/C/rpc";

/**
 * Tried in order; the first that answers wins, and a failing one is skipped.
 * Both were verified to serve chainId 114. Override with a comma-separated
 * NEXT_PUBLIC_RPC_URLS to put a private endpoint first.
 */
export const RPC_URLS: string[] = (
  process.env.NEXT_PUBLIC_RPC_URLS ??
  `${RPC_URL},https://rpc.ankr.com/flare_coston2`
)
  .split(",")
  .map((url) => url.trim())
  .filter(Boolean);

export const SEALED_AUCTION_ADDRESS = addressFromEnv(
  process.env.NEXT_PUBLIC_SEALED_AUCTION,
  "0x057c49831762029EA82c5644ff9D426D02486EeB",
);

/** contracts/DemoAsset721.sol — used by the "mint demo NFT" helper. */
export const DEMO_ASSET_ADDRESS = addressFromEnv(
  process.env.NEXT_PUBLIC_DEMO_ASSET,
  "0x6F7640AcbdCA0dfc4817C660928d02d0B3B6011E",
);

export const FLARE_TEE_MANAGER_ADDRESS = addressFromEnv(
  process.env.NEXT_PUBLIC_FLARE_TEE_MANAGER,
  "0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE",
);

/** Canonical Multicall3 — deployed on Coston2, but absent from viem's chain def. */
export const MULTICALL3_ADDRESS: Address =
  "0xcA11bde05977b3631167028862bE2a173976CA11";

/** Native fee forwarded with each placeBid/closeAuction instruction. */
export const INSTRUCTION_FEE_WEI = BigInt(
  process.env.NEXT_PUBLIC_INSTRUCTION_FEE_WEI ?? "1000000",
);

export const EXPLORER_TX_URL = "https://coston2-explorer.flare.network/tx/";
export const EXPLORER_ADDRESS_URL =
  "https://coston2-explorer.flare.network/address/";

export function isConfigured(): boolean {
  return SEALED_AUCTION_ADDRESS !== zeroAddress;
}
