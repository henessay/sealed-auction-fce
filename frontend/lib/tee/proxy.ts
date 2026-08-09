import { keccak256, type Address } from "viem";

import type { ActionResponse, TeeInfoResponse, TeePublicKey } from "./types";

export async function fetchTeeInfo(): Promise<TeeInfoResponse> {
  const res = await fetch("/api/tee/info");
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`TEE info failed (${res.status}): ${body}`);
  }
  return res.json() as Promise<TeeInfoResponse>;
}

export async function pollActionResult(
  instructionId: string,
): Promise<ActionResponse> {
  const res = await fetch(`/api/tee/action/${instructionId.replace(/^0x/, "")}`);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Action result failed (${res.status}): ${body}`);
  }
  return res.json() as Promise<ActionResponse>;
}

/** Ethereum address of the TEE machine, derived from its secp256k1 key. */
export function teeAddressFromPublicKey(key: TeePublicKey): Address {
  const xy = `0x${key.x.slice(2)}${key.y.slice(2)}` as `0x${string}`;
  return `0x${keccak256(xy).slice(-40)}` as Address;
}
