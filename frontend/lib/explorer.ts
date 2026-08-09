import {
  decodeEventLog,
  numberToHex,
  toEventSelector,
  type Hex,
} from "viem";

import { sealedAuctionAbi } from "@/lib/abi/sealedAuction";
import { SEALED_AUCTION_ADDRESS } from "@/lib/config";

const EXPLORER_API = "https://coston2-explorer.flare.network/api";

export const BID_PLACED_TOPIC = toEventSelector(
  "BidPlaced(uint256,address,bytes32,bytes32)",
);
export const AUCTION_CLOSING_TOPIC = toEventSelector(
  "AuctionClosing(uint256,bytes32)",
);

type ExplorerLog = {
  transactionHash: string;
  topics: (string | null)[];
  data: string;
};

async function fetchLogs(topic0: Hex, auctionId: bigint): Promise<ExplorerLog[]> {
  const params = new URLSearchParams({
    module: "logs",
    action: "getLogs",
    address: SEALED_AUCTION_ADDRESS,
    topic0,
    topic1: numberToHex(auctionId, { size: 32 }),
    topic0_1_opr: "and",
    fromBlock: "0",
    toBlock: "latest",
  });
  const res = await fetch(`${EXPLORER_API}?${params}`);
  if (!res.ok) throw new Error(`Explorer API returned ${res.status}`);
  const json = (await res.json()) as {
    status?: string;
    result?: ExplorerLog[] | string;
  };
  // status "0" with empty result = no logs yet; only array results are usable.
  return Array.isArray(json.result) ? json.result : [];
}

export type BidLogEntry = {
  bidder: `0x${string}`;
  commitment: `0x${string}`;
  transactionHash: `0x${string}`;
};

export async function fetchBidLogs(auctionId: bigint): Promise<BidLogEntry[]> {
  const logs = await fetchLogs(BID_PLACED_TOPIC, auctionId);
  return logs.map((log) => {
    const topics = log.topics.filter((t): t is string => t != null) as [
      Hex,
      ...Hex[],
    ];
    const decoded = decodeEventLog({
      abi: sealedAuctionAbi,
      data: log.data as Hex,
      topics,
      eventName: "BidPlaced",
    });
    return {
      bidder: decoded.args.bidder,
      commitment: decoded.args.commitment,
      transactionHash: log.transactionHash as `0x${string}`,
    };
  });
}

/** instructionId of the most recent AuctionClosing event for an auction. */
export async function fetchCloseInstructionId(
  auctionId: bigint,
): Promise<`0x${string}` | null> {
  const logs = await fetchLogs(AUCTION_CLOSING_TOPIC, auctionId);
  if (logs.length === 0) return null;
  const last = logs[logs.length - 1];
  const topics = last.topics.filter((t): t is string => t != null) as [
    Hex,
    ...Hex[],
  ];
  const decoded = decodeEventLog({
    abi: sealedAuctionAbi,
    data: last.data as Hex,
    topics,
    eventName: "AuctionClosing",
  });
  return decoded.args.instructionId;
}
