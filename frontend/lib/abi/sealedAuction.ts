import { parseAbi } from "viem";

/** Client surface of contracts/InstructionSender.sol (contract SealedAuction). */
export const sealedAuctionAbi = parseAbi([
  "function auctionCount() view returns (uint256)",
  "function auctions(uint256) view returns (address seller, string lot, address payToken, uint64 deadline, uint256 reservePrice, uint8 state, address winner, uint256 clearingPrice, uint256 bidCount)",
  "function teeAddress() view returns (address)",
  "function createAuction(string lot, address payToken, uint64 deadline, uint256 reservePrice) returns (uint256)",
  "function placeBid(uint256 auctionId, bytes ciphertext) payable",
  "function closeAuction(uint256 auctionId) payable",
  "function cancelAuction(uint256 auctionId)",
  "function settle(bytes data, bytes32 actionId, string submissionTag, uint8 status, bytes signature)",
  "event AuctionCreated(uint256 indexed auctionId, address indexed seller, address payToken, uint64 deadline, uint256 reservePrice, string lot)",
  "event BidPlaced(uint256 indexed auctionId, address indexed bidder, bytes32 commitment, bytes32 instructionId)",
  "event AuctionClosing(uint256 indexed auctionId, bytes32 instructionId)",
  "event AuctionSettled(uint256 indexed auctionId, address indexed winner, uint256 clearingPrice)",
  "event AuctionCancelled(uint256 indexed auctionId)",
]);

export const erc20Abi = parseAbi([
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);

export const flareTeeManagerAbi = parseAbi([
  "function getTeeMachineStatus(address teeId) view returns (uint8)",
]);

export const AUCTION_STATE_LABELS = [
  "None",
  "Open",
  "Closing",
  "Settled",
  "Cancelled",
] as const;

export type AuctionStateLabel = (typeof AUCTION_STATE_LABELS)[number];

export const MACHINE_STATUS_LABELS: Record<number, string> = {
  0: "NONE",
  1: "INITIALIZED",
  2: "PRODUCTION",
  3: "DEPRECATED",
};
