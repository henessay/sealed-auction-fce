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

/** Same address on every Flare network — entry point for FXRP resolution. */
export const FLARE_CONTRACT_REGISTRY: Address =
  "0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019";

/** Used only if the registry lookup fails; the resolver is the source of truth. */
export const FXRP_FALLBACK_ADDRESS = addressFromEnv(
  process.env.NEXT_PUBLIC_FXRP,
  "0x0b6A3645c240605887a5532109323A3E12273dc7",
);

/**
 * USDT0 as handed out by faucet.flare.network (10 per day) — "USDT0 test",
 * 6 decimals. Not in the ContractRegistry, so it has to be pinned.
 */
export const USDT0_ADDRESS = addressFromEnv(
  process.env.NEXT_PUBLIC_USDT0,
  "0xC1A5B41512496B80903D1f32d6dEa3a73212E71F",
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
/** Blockscout v2 API — the last-resort NFT enumeration path (CORS is open). */
export const EXPLORER_API_URL = "https://coston2-explorer.flare.network/api/v2";

export function isConfigured(): boolean {
  return SEALED_AUCTION_ADDRESS !== zeroAddress;
}
