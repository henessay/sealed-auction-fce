import { type Address, zeroAddress } from "viem";

function addressFromEnv(value: string | undefined, fallback: Address): Address {
  if (!value || value.length < 42) return fallback;
  return value as Address;
}

export const CHAIN_ID = Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? "114");

export const RPC_URL =
  process.env.NEXT_PUBLIC_RPC_URL ??
  "https://coston2-api.flare.network/ext/C/rpc";

export const SEALED_AUCTION_ADDRESS = addressFromEnv(
  process.env.NEXT_PUBLIC_SEALED_AUCTION,
  "0x5a468D17C292C262C4bAa0A953561bF31CDA79a0",
);

export const FLARE_TEE_MANAGER_ADDRESS = addressFromEnv(
  process.env.NEXT_PUBLIC_FLARE_TEE_MANAGER,
  "0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE",
);

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
