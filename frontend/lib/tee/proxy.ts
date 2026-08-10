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

/**
 * The instruction is on-chain but no TEE result came back — the pipeline
 * (indexer → proxy → extension) is stalled or the machine is dead. Distinct
 * from a malformed request, because the user's transaction is fine.
 */
export class TeeResultUnavailableError extends Error {
  constructor(
    readonly status: number,
    detail: string,
  ) {
    super(detail);
    this.name = "TeeResultUnavailableError";
  }
}

export async function pollActionResult(
  instructionId: string,
): Promise<ActionResponse> {
  let res: Response;
  try {
    res = await fetch(`/api/tee/action/${instructionId.replace(/^0x/, "")}`);
  } catch (e) {
    throw new TeeResultUnavailableError(
      0,
      e instanceof Error ? e.message : "network error",
    );
  }
  if (!res.ok) {
    const body = await res.text();
    if (res.status === 502 || res.status === 503 || res.status === 504) {
      throw new TeeResultUnavailableError(res.status, body);
    }
    throw new Error(`Action result failed (${res.status}): ${body}`);
  }
  return res.json() as Promise<ActionResponse>;
}

/** Per-bid liveness: is this instruction's result in yet? */
export type BidTeeStatus = "confirmed" | "pending" | "unreachable";

/** Single-shot status probe — never throws, never blocks the UI. */
export async function peekActionResult(
  instructionId: string,
): Promise<BidTeeStatus> {
  try {
    const res = await fetch(
      `/api/tee/action/${instructionId.replace(/^0x/, "")}?peek=1`,
    );
    if (res.ok) return "confirmed";
    return res.status === 503 ? "unreachable" : "pending";
  } catch {
    return "unreachable";
  }
}

/** Ethereum address of the TEE machine, derived from its secp256k1 key. */
export function teeAddressFromPublicKey(key: TeePublicKey): Address {
  const xy = `0x${key.x.slice(2)}${key.y.slice(2)}` as `0x${string}`;
  return `0x${keccak256(xy).slice(-40)}` as Address;
}
