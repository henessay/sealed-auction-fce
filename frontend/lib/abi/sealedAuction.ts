import { parseAbi } from "viem";

/** Client surface of contracts/InstructionSender.sol (contract SealedAuction). */
export const sealedAuctionAbi = parseAbi([
  "function auctionCount() view returns (uint256)",
  "function auctions(uint256) view returns (address seller, string lot, uint8 lotKind, address lotToken, uint256 lotTokenId, uint256 lotAmount, address payToken, uint64 deadline, uint256 reservePrice, uint8 state, address winner, uint256 clearingPrice, uint256 bidCount)",
  "function teeAddress() view returns (address)",
  "function createAuction(string lot, uint8 lotKind, address lotToken, uint256 lotTokenId, uint256 lotAmount, address payToken, uint64 deadline, uint256 reservePrice) returns (uint256)",
  "function placeBid(uint256 auctionId, bytes ciphertext) payable",
  "function closeAuction(uint256 auctionId) payable",
  "function cancelAuction(uint256 auctionId)",
  "function settle(bytes data, bytes32 actionId, string submissionTag, uint8 status, bytes signature)",
  "event AuctionCreated(uint256 indexed auctionId, address indexed seller, address payToken, uint64 deadline, uint256 reservePrice, string lot)",
  "event LotEscrowed(uint256 indexed auctionId, uint8 lotKind, address indexed lotToken, uint256 lotTokenId, uint256 lotAmount)",
  "event LotReleased(uint256 indexed auctionId, address indexed to)",
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

/** ContractRegistry → AssetManagerFXRP → fAsset(): dynamic FXRP resolution. */
export const flareContractRegistryAbi = parseAbi([
  "function getContractAddressByName(string name) view returns (address)",
]);

export const assetManagerAbi = parseAbi([
  "function fAsset() view returns (address)",
]);

/** Plain ERC-721 surface any lot collection must implement. */
export const erc721Abi = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function balanceOf(address owner) view returns (uint256)",
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function getApproved(uint256 tokenId) view returns (address)",
  "function approve(address to, uint256 tokenId)",
]);

/** Optional extensions probed while enumerating a seller's tokens. */
export const erc721EnumerableAbi = parseAbi([
  "function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
]);

/** Sequential-id mints (our DemoAsset721): ids run 1..nextTokenId-1. */
export const sequentialMintAbi = parseAbi([
  "function nextTokenId() view returns (uint256)",
]);

export const flareTeeManagerAbi = parseAbi([
  "function getTeeMachineStatus(address teeId) view returns (uint8)",
]);

/** contracts/DemoAsset721.sol — the demo lot token. */
export const demoAsset721Abi = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function getApproved(uint256 tokenId) view returns (address)",
  "function owner() view returns (address)",
  "function approve(address to, uint256 tokenId)",
  "function mint(address to) returns (uint256)",
]);

/** Matches SealedAuction.LotKind. */
export const LOT_KIND_ERC721 = 0;
export const LOT_KIND_ERC20 = 1;

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
