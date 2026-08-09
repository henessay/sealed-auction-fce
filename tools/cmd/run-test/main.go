package main

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"flag"
	"math/big"
	"os"
	"strings"
	"time"

	"sealed-auction/tools/pkg/configs"
	"sealed-auction/tools/pkg/fccutils"
	"sealed-auction/tools/pkg/support"
	instrutils "sealed-auction/tools/pkg/utils"

	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
	gethcrypto "github.com/ethereum/go-ethereum/crypto"
	"github.com/flare-foundation/go-flare-common/pkg/logger"
	"github.com/pkg/errors"
)

// Expected response/message shapes for the sealed-auction operations.
//
// These are deliberately declared here rather than imported from the extension:
// this tool asserts on the *wire format* (see docs/extension-contract.md).

type placeBidResponse struct {
	Accepted bool `json:"accepted"`
}

// bidPayloadArgs mirrors the frontend's ECIES plaintext:
// (uint256 auctionId, address contractAddr, address bidder, uint256 amountWei, bytes32 salt).
var bidPayloadArgs abi.Arguments

// auctionResultArgs mirrors settle()'s abi.decode(data, (address, uint256, address, uint256)).
var auctionResultArgs abi.Arguments

func init() {
	tupleTy, _ := abi.NewType("tuple", "", []abi.ArgumentMarshaling{
		{Name: "auctionId", Type: "uint256"},
		{Name: "contractAddr", Type: "address"},
		{Name: "bidder", Type: "address"},
		{Name: "amountWei", Type: "uint256"},
		{Name: "salt", Type: "bytes32"},
	})
	bidPayloadArgs = abi.Arguments{{Type: tupleTy}}

	addressTy, _ := abi.NewType("address", "", nil)
	uintTy, _ := abi.NewType("uint256", "", nil)
	auctionResultArgs = abi.Arguments{{Type: addressTy}, {Type: uintTy}, {Type: addressTy}, {Type: uintTy}}
}

func main() {
	af := flag.String("a", configs.AddressesFile, "file with deployed addresses")
	cf := flag.String("c", configs.ChainNodeURL, "chain node url")
	pf := flag.String("p", configs.ExtensionProxyURL, "extension proxy url")
	instructionSenderF := flag.String("instructionSender", "", "instructionSender address")
	bidWei := flag.Int64("bid", 3_000_000, "winning bid amount in pay-token base units")
	losingBidWei := flag.Int64("losing-bid", 2_000_000, "losing bid amount in pay-token base units")
	reserveWei := flag.Int64("reserve", 1_000_000, "reserve price in pay-token base units")
	biddingSeconds := flag.Int64("bidding-seconds", 60, "seconds until the auction deadline")
	flag.Parse()

	instructionSenderAddress := common.HexToAddress(*instructionSenderF)

	testSupport, err := support.DefaultSupport(*af, *cf)
	if err != nil {
		fccutils.FatalWithCause(err)
	}
	deployer := gethcrypto.PubkeyToAddress(testSupport.Prv.PublicKey)

	// PAY_TOKEN: an explicit ERC-20 address, or "FXRP"/empty to resolve the
	// FXRP FAsset dynamically via the FlareContractRegistry.
	payTokenHex := os.Getenv("PAY_TOKEN")
	var payToken common.Address
	if payTokenHex == "" || strings.EqualFold(payTokenHex, "FXRP") {
		token, decimals, err := instrutils.ResolveFXRP(testSupport.ChainClient)
		if err != nil {
			fccutils.FatalWithCause(errors.Errorf(
				"resolve FXRP (set PAY_TOKEN to an ERC-20 address to override): %s", err))
		}
		payToken = token
		logger.Infof("Resolved FXRP via FlareContractRegistry: %s (decimals: %d)", token.Hex(), decimals)
	} else {
		payToken = common.HexToAddress(payTokenHex)
		logger.Infof("Using PAY_TOKEN from env: %s", payToken.Hex())
	}

	demoAssetHex := os.Getenv("DEMO_ASSET")
	if demoAssetHex == "" {
		fccutils.FatalWithCause(errors.New(
			"DEMO_ASSET env var not set — deploy contracts/DemoAsset721.sol and set its address (the deployer must own it)"))
	}
	demoAsset := common.HexToAddress(demoAssetHex)

	balance, err := instrutils.TokenBalanceOf(testSupport.ChainClient, payToken, deployer)
	if err != nil {
		fccutils.FatalWithCause(errors.Errorf("pay-token balanceOf(deployer): %s", err))
	}
	logger.Infof("Deployer pay-token balance: %s", balance)
	if balance.Cmp(big.NewInt(*bidWei)) < 0 {
		fccutils.FatalWithCause(errors.Errorf(
			"deployer holds %s pay-token units but the winning bid is %d — top up before running (FXRP faucet for Coston2)",
			balance, *bidWei))
	}

	// --- Generic: configure contract -----------------------------------------
	logger.Infof("Setting extension ID on instruction sender...")
	err = instrutils.SetExtensionId(testSupport, instructionSenderAddress)
	if err != nil {
		if strings.Contains(err.Error(), "already set") || strings.Contains(err.Error(), "Extension ID already set") {
			logger.Infof("Extension ID already set on contract, continuing")
		} else {
			fccutils.FatalWithCause(errors.Errorf(
				"setExtensionId failed — is the extension registered? Check that pre-build.sh completed successfully. Error: %s", err))
		}
	}

	// settle() verifies against the registered TEE signing address.
	logger.Infof("Registering TEE signing address on contract...")
	teeAddress, err := fccutils.TeeSigningAddress(*pf)
	if err != nil {
		fccutils.FatalWithCause(errors.Errorf("fetch TEE signing address: %s", err))
	}
	if err := instrutils.SetTeeAddress(testSupport, instructionSenderAddress, teeAddress); err != nil {
		fccutils.FatalWithCause(err)
	}

	// --- Second bidder: ephemeral key, funded with gas money by the deployer --
	// Two bids from two distinct keys prove the TEE ranks sealed bids across
	// bidders; the ephemeral key places the losing bid so settle() (which needs
	// pay-token balance) stays with the deployer. The ephemeral key is ALSO the
	// seller: FXRP (FAsset) reverts self-transfers (CannotTransferToSelf,
	// 0xdad89dca), so seller and winner must be distinct addresses.
	bidder2Prv, err := gethcrypto.GenerateKey()
	if err != nil {
		fccutils.FatalWithCause(err)
	}
	bidder2 := gethcrypto.PubkeyToAddress(bidder2Prv.PublicKey)
	logger.Infof("Funding second bidder %s with gas money...", bidder2.Hex())
	// Coston2 gas is ~650 gwei and this key runs approve + create + bid, so
	// fund it generously — leftovers are swept back at the end of the run.
	if err := instrutils.SendNative(testSupport, bidder2, big.NewInt(3_000_000_000_000_000_000)); err != nil {
		fccutils.FatalWithCause(errors.Errorf("fund second bidder: %s", err))
	}
	bidder2Support, err := support.NewSupport(bidder2Prv, testSupport.ChainClient, testSupport.Addresses)
	if err != nil {
		fccutils.FatalWithCause(err)
	}

	// --- Test case 1: create an auction --------------------------------------
	// Anchor the deadline to CHAIN time, not the local clock: closeAuction
	// requires block.timestamp >= deadline and local clocks skew.
	head, err := testSupport.ChainClient.HeaderByNumber(context.Background(), nil)
	if err != nil {
		fccutils.FatalWithCause(errors.Errorf("fetch chain head: %s", err))
	}
	deadline := head.Time + uint64(*biddingSeconds)

	// The lot is a real ERC-721 held in escrow. The deployer owns DemoAsset721,
	// so it mints the token and hands it to the ephemeral seller, who approves
	// the auction house and creates the auction.
	logger.Infof("Minting a demo NFT to seller %s...", bidder2.Hex())
	lotTokenId, err := instrutils.MintDemoAsset(testSupport, demoAsset, bidder2)
	if err != nil {
		fccutils.FatalWithCause(errors.Errorf("mint demo asset: %s", err))
	}
	logger.Infof("Minted token id %s", lotTokenId)

	if err := instrutils.ApproveNFT(bidder2Support, demoAsset, instructionSenderAddress, lotTokenId); err != nil {
		fccutils.FatalWithCause(errors.Errorf("approve lot: %s", err))
	}

	logger.Infof("Creating auction as seller %s (deadline in %ds, reserve %d)...", bidder2.Hex(), *biddingSeconds, *reserveWei)
	auctionId, err := instrutils.CreateAuction(
		bidder2Support, instructionSenderAddress,
		"Sealed-auction e2e test lot (escrowed NFT)",
		instrutils.LotKindERC721, demoAsset, lotTokenId, big.NewInt(0),
		payToken, deadline, big.NewInt(*reserveWei),
	)
	if err != nil {
		fccutils.FatalWithCause(err)
	}
	logger.Infof("Auction created. ID: %s", auctionId)

	// The lot must be in escrow now — that is what makes the auction real.
	lotHolder, err := instrutils.NFTOwner(testSupport, demoAsset, lotTokenId)
	if err != nil {
		fccutils.FatalWithCause(err)
	}
	if lotHolder != instructionSenderAddress {
		fccutils.FatalWithCause(errors.Errorf(
			"expected the lot to be escrowed by %s, but it is held by %s",
			instructionSenderAddress.Hex(), lotHolder.Hex()))
	}
	logger.Infof("Test passed: lot escrowed by the auction contract")

	// --- Test case 2: sealed PLACE_BID from two distinct bidders --------------
	teePub, err := fccutils.TeeECIESPublicKey(*pf)
	if err != nil {
		fccutils.FatalWithCause(errors.Errorf("fetch TEE ECIES key: %s", err))
	}

	sealBid := func(bidder common.Address, amount int64) []byte {
		var salt [32]byte
		if _, err := rand.Read(salt[:]); err != nil {
			fccutils.FatalWithCause(err)
		}
		plaintext, err := bidPayloadArgs.Pack(struct {
			AuctionId    *big.Int
			ContractAddr common.Address
			Bidder       common.Address
			AmountWei    *big.Int
			Salt         [32]byte
		}{auctionId, instructionSenderAddress, bidder, big.NewInt(amount), salt})
		if err != nil {
			fccutils.FatalWithCause(err)
		}
		ciphertext, err := fccutils.EncryptForTee(teePub, plaintext)
		if err != nil {
			fccutils.FatalWithCause(err)
		}
		return ciphertext
	}

	checkAccepted := func(label string, instructionId common.Hash) {
		response, err := fccutils.ActionResult(*pf, instructionId)
		if err != nil {
			fccutils.FatalWithCause(err)
		}
		if response.Result.Status != 1 {
			fccutils.FatalWithCause(errors.Errorf("%s failed: %s", label, response.Result.Log))
		}
		var resp placeBidResponse
		if err := json.Unmarshal(response.Result.Data, &resp); err != nil || !resp.Accepted {
			fccutils.FatalWithCause(errors.Errorf("%s: expected {\"accepted\":true}, got %s", label, response.Result.Data))
		}
	}

	logger.Infof("Sending losing PLACE_BID (%d) from second bidder %s...", *losingBidWei, bidder2.Hex())
	losingInstructionId, losingTx, err := instrutils.PlaceBid(bidder2Support, instructionSenderAddress, auctionId, sealBid(bidder2, *losingBidWei))
	if err != nil {
		fccutils.FatalWithCause(err)
	}
	logger.Infof("Losing bid tx: %s (instruction %s)", losingTx.Hex(), losingInstructionId.Hex())

	logger.Infof("Sending winning PLACE_BID (%d) from deployer %s...", *bidWei, deployer.Hex())
	winningInstructionId, winningTx, err := instrutils.PlaceBid(testSupport, instructionSenderAddress, auctionId, sealBid(deployer, *bidWei))
	if err != nil {
		fccutils.FatalWithCause(err)
	}
	logger.Infof("Winning bid tx: %s (instruction %s)", winningTx.Hex(), winningInstructionId.Hex())

	time.Sleep(5 * time.Second)

	checkAccepted("PLACE_BID (losing)", losingInstructionId)
	checkAccepted("PLACE_BID (winning)", winningInstructionId)
	logger.Infof("Test passed: both sealed bids accepted (amounts never on-chain)")

	// --- Test case 3: CLOSE_AUCTION after the deadline ------------------------
	// Poll the chain until a mined block's timestamp passes the deadline —
	// only then is closeAuction guaranteed not to hit "bidding still open".
	logger.Infof("Waiting for chain time to pass the bidding deadline...")
	for {
		head, err := testSupport.ChainClient.HeaderByNumber(context.Background(), nil)
		if err != nil {
			fccutils.FatalWithCause(errors.Errorf("fetch chain head: %s", err))
		}
		if head.Time >= deadline {
			break
		}
		time.Sleep(2 * time.Second)
	}

	logger.Infof("Sending CLOSE_AUCTION instruction...")
	closeInstructionId, _, err := instrutils.CloseAuction(testSupport, instructionSenderAddress, auctionId)
	if err != nil {
		fccutils.FatalWithCause(err)
	}
	logger.Infof("Instruction sent. ID: %s", closeInstructionId.Hex())

	time.Sleep(5 * time.Second)

	closeResponse, err := fccutils.ActionResult(*pf, closeInstructionId)
	if err != nil {
		fccutils.FatalWithCause(err)
	}
	if closeResponse.Result.Status != 1 {
		fccutils.FatalWithCause(errors.Errorf("CLOSE_AUCTION failed: %s", closeResponse.Result.Log))
	}

	vals, err := auctionResultArgs.Unpack(closeResponse.Result.Data)
	if err != nil {
		fccutils.FatalWithCause(errors.Errorf("decode auction result: %s", err))
	}
	winner := vals[2].(common.Address)
	clearingPrice := vals[3].(*big.Int)
	logger.Infof("TEE result: winner=%s clearingPrice=%s", winner.Hex(), clearingPrice)

	if winner != deployer {
		fccutils.FatalWithCause(errors.Errorf("expected winner %s, got %s", deployer.Hex(), winner.Hex()))
	}
	if clearingPrice.Cmp(big.NewInt(*bidWei)) != 0 {
		fccutils.FatalWithCause(errors.Errorf("expected clearing price %d, got %s", *bidWei, clearingPrice))
	}
	logger.Infof("Test passed: CLOSE_AUCTION picked the expected winner")

	// --- Test case 4: settle on-chain -----------------------------------------
	logger.Infof("Approving pay token and settling on-chain...")
	if err := instrutils.Approve(testSupport, payToken, instructionSenderAddress, clearingPrice); err != nil {
		fccutils.FatalWithCause(err)
	}

	settleTx, err := instrutils.Settle(
		testSupport, instructionSenderAddress,
		closeResponse.Result.Data,
		closeResponse.Result.ID,
		string(closeResponse.Result.SubmissionTag),
		closeResponse.Result.Status,
		closeResponse.Signature,
	)
	if err != nil {
		fccutils.FatalWithCause(err)
	}
	logger.Infof("Test passed: settle() verified the TEE signature on-chain (tx %s)", settleTx.Hex())

	sellerBalance, err := instrutils.TokenBalance(testSupport, payToken, bidder2)
	if err != nil {
		fccutils.FatalWithCause(err)
	}
	if sellerBalance.Cmp(clearingPrice) != 0 {
		fccutils.FatalWithCause(errors.Errorf(
			"expected seller to hold the clearing price %s, got %s", clearingPrice, sellerBalance))
	}
	logger.Infof("Test passed: seller received %s pay-token units", sellerBalance)

	// The other half of the atomic swap: the lot is now the winner's.
	lotHolder, err = instrutils.NFTOwner(testSupport, demoAsset, lotTokenId)
	if err != nil {
		fccutils.FatalWithCause(err)
	}
	if lotHolder != winner {
		fccutils.FatalWithCause(errors.Errorf(
			"expected the lot to be owned by the winner %s, got %s", winner.Hex(), lotHolder.Hex()))
	}
	logger.Infof("Test passed: lot token %s transferred to the winner", lotTokenId)

	// Recover the pay tokens from the ephemeral seller so repeated runs don't
	// bleed the deployer's balance.
	if err := instrutils.TransferToken(bidder2Support, payToken, deployer, sellerBalance); err != nil {
		fccutils.FatalWithCause(errors.Errorf("refund pay tokens from ephemeral seller: %s", err))
	}
	logger.Infof("Refunded %s pay-token units from ephemeral seller back to deployer", sellerBalance)

	logger.Infof("All tests passed.")
	logger.Infof("Summary: auctionId=%s losingBidTx=%s winningBidTx=%s settleTx=%s",
		auctionId, losingTx.Hex(), winningTx.Hex(), settleTx.Hex())
}
