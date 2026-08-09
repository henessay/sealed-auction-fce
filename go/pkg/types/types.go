// Package types contains types that could be useful to other apps when interacting with this extension.
package types

import (
	"math/big"

	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
)

// PlaceBidMessage is the ABI-decoded wrapper of a PLACE_BID instruction.
// The contract builds it on-chain, so Bidder is authenticated by the chain
// (DataFixed carries no tx sender — this wrapper is the trusted source).
// Matches Solidity `struct PlaceBidMessage { uint256 auctionId; address bidder; bytes ciphertext; }`.
type PlaceBidMessage struct {
	AuctionId  *big.Int       `json:"auctionId"`
	Bidder     common.Address `json:"bidder"`
	Ciphertext []byte         `json:"ciphertext"`
}

// BidPayload is ABI-encoded client-side, ECIES-encrypted under the TEE public
// key, and decoded here after tee-node /decrypt. The TEE rejects the bid unless
// Bidder and AuctionId match the chain-authenticated PlaceBidMessage wrapper
// (anti-spoofing and anti-ciphertext-replay).
// Matches the frontend's `parseAbiParameters` tuple exactly, in order.
type BidPayload struct {
	AuctionId    *big.Int       `json:"auctionId"`
	ContractAddr common.Address `json:"contractAddr"`
	Bidder       common.Address `json:"bidder"`
	AmountWei    *big.Int       `json:"amountWei"`
	Salt         common.Hash    `json:"salt"`
}

// PlaceBidResponse is the JSON payload returned in ActionResult.Data for
// PLACE_BID. ActionResult.Data is public (it travels through the proxy), so
// this deliberately reveals nothing beyond acceptance.
type PlaceBidResponse struct {
	Accepted bool `json:"accepted"`
}

// CloseMessage is the ABI-decoded payload of a CLOSE_AUCTION instruction,
// built on-chain (reserve price and deadline are therefore chain-authenticated).
// Matches Solidity `struct CloseMessage { uint256 auctionId; address contractAddr; uint256 reservePrice; uint64 deadline; }`.
type CloseMessage struct {
	AuctionId    *big.Int       `json:"auctionId"`
	ContractAddr common.Address `json:"contractAddr"`
	ReservePrice *big.Int       `json:"reservePrice"`
	Deadline     uint64         `json:"deadline"`
}

// AuctionResult is the decoded form of the CLOSE_AUCTION result payload.
// On-chain, settle() reads the same fields via
// abi.decode(data, (address, uint256, address, uint256)).
// A zero Winner means no bid met the reserve — the contract cancels the auction.
type AuctionResult struct {
	ContractAddr  common.Address
	AuctionId     *big.Int
	Winner        common.Address
	ClearingPrice *big.Int
}

// PlaceBidMessageArg describes the ABI layout of PlaceBidMessage from the Solidity contract.
var PlaceBidMessageArg abi.Argument

// BidPayloadArg describes the ABI layout of the encrypted bid payload.
var BidPayloadArg abi.Argument

// CloseMessageArg describes the ABI layout of CloseMessage from the Solidity contract.
var CloseMessageArg abi.Argument

// AuctionResultArgs is the flat ABI tuple the TEE packs into ActionResult.Data,
// matching Solidity abi.decode(data, (address, uint256, address, uint256)).
var AuctionResultArgs abi.Arguments

func init() {
	placeBidTy, _ := abi.NewType("tuple", "", []abi.ArgumentMarshaling{
		{Name: "auctionId", Type: "uint256"},
		{Name: "bidder", Type: "address"},
		{Name: "ciphertext", Type: "bytes"},
	})
	PlaceBidMessageArg = abi.Argument{Type: placeBidTy}

	bidPayloadTy, _ := abi.NewType("tuple", "", []abi.ArgumentMarshaling{
		{Name: "auctionId", Type: "uint256"},
		{Name: "contractAddr", Type: "address"},
		{Name: "bidder", Type: "address"},
		{Name: "amountWei", Type: "uint256"},
		{Name: "salt", Type: "bytes32"},
	})
	BidPayloadArg = abi.Argument{Type: bidPayloadTy}

	closeTy, _ := abi.NewType("tuple", "", []abi.ArgumentMarshaling{
		{Name: "auctionId", Type: "uint256"},
		{Name: "contractAddr", Type: "address"},
		{Name: "reservePrice", Type: "uint256"},
		{Name: "deadline", Type: "uint64"},
	})
	CloseMessageArg = abi.Argument{Type: closeTy}

	addressTy, _ := abi.NewType("address", "", nil)
	uintTy, _ := abi.NewType("uint256", "", nil)
	AuctionResultArgs = abi.Arguments{
		{Type: addressTy},
		{Type: uintTy},
		{Type: addressTy},
		{Type: uintTy},
	}
}

// State holds the extension's observable state, returned by GET /state.
// Only aggregate counters — bid existence is already public on-chain, amounts
// are never exposed.
type State struct {
	AuctionsTracked int `json:"auctionsTracked"`
	AuctionsClosed  int `json:"auctionsClosed"`
	BidsStored      int `json:"bidsStored"`
}

// --- DO NOT MODIFY below this line. ---

// StateResponse is the envelope returned by GET /state.
type StateResponse struct {
	StateVersion common.Hash `json:"stateVersion"`
	State        State       `json:"state"`
}
