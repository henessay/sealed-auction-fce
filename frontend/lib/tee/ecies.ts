import ecies from "ecies-geth";
import {
  type Address,
  encodeAbiParameters,
  hexToBytes,
  parseAbiParameters,
} from "viem";

import type { TeePublicKey } from "./types";

/** Matches Go BidPayloadArg / extension BidPayload: ABI tuple struct. */
const bidPayloadParams = parseAbiParameters(
  "(uint256 auctionId, address contractAddr, address bidder, uint256 amountWei, bytes32 salt)",
);

/** Build 65-byte uncompressed secp256k1 key from TEE /info machineData.publicKey. */
export function teePublicKeyToBuffer(key: TeePublicKey): Buffer {
  const x = hexToBytes(key.x);
  const y = hexToBytes(key.y);
  if (x.length !== 32 || y.length !== 32) {
    throw new Error(
      `unexpected TEE coordinate length: x=${x.length} y=${y.length}`,
    );
  }
  return Buffer.concat([Buffer.from([0x04]), Buffer.from(x), Buffer.from(y)]);
}

export function encodeBidPayload(
  auctionId: bigint,
  contractAddr: Address,
  bidder: Address,
  amountWei: bigint,
  salt: `0x${string}`,
): Uint8Array {
  const encoded = encodeAbiParameters(bidPayloadParams, [
    { auctionId, contractAddr, bidder, amountWei, salt },
  ]);
  return hexToBytes(encoded);
}

export function randomSalt(): `0x${string}` {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}` as `0x${string}`;
}

export async function encryptForTee(
  publicKey: TeePublicKey,
  plaintext: Uint8Array,
): Promise<Uint8Array> {
  const pub = teePublicKeyToBuffer(publicKey);
  const ciphertext = await ecies.encrypt(pub, Buffer.from(plaintext));
  return Uint8Array.from(ciphertext);
}

/** ECIES-encrypt a sealed bid under the TEE machine key. */
export async function buildBidCiphertext(
  machinePublicKey: TeePublicKey,
  auctionId: bigint,
  contractAddr: Address,
  bidder: Address,
  amountWei: bigint,
): Promise<`0x${string}`> {
  const plaintext = encodeBidPayload(
    auctionId,
    contractAddr,
    bidder,
    amountWei,
    randomSalt(),
  );
  const encrypted = await encryptForTee(machinePublicKey, plaintext);
  return `0x${Buffer.from(encrypted).toString("hex")}` as `0x${string}`;
}
