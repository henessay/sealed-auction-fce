package utils

import (
	"context"
	"math/big"
	"time"

	"sealed-auction/tools/pkg/contracts/sealedauction"
	"sealed-auction/tools/pkg/fccutils"
	"sealed-auction/tools/pkg/support"

	"github.com/ethereum/go-ethereum/accounts/abi/bind"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/pkg/errors"
)

// InstructionFeeWei is the native fee forwarded to the registry with every
// instruction — must match the registry's required fee.
var InstructionFeeWei = big.NewInt(1000000)

func DeployInstructionSender(s *support.Support) (common.Address, *sealedauction.SealedAuction, error) {
	opts, err := bind.NewKeyedTransactorWithChainID(s.Prv, s.ChainID)
	if err != nil {
		return common.Address{}, nil, errors.Errorf("failed to create transactor: %s", err)
	}

	// Both registry args are the FlareTeeManager diamond proxy: the diamond
	// routes ExtensionManager and MachineManager calls to the right facets.
	address, tx, contract, err := sealedauction.DeploySealedAuction(
		opts, s.ChainClient, s.Addresses.FlareTeeManager, s.Addresses.FlareTeeManager,
	)
	if err != nil {
		return common.Address{}, nil, errors.Errorf("failed to deploy contract: %s", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	receipt, err := bind.WaitMined(ctx, s.ChainClient, tx)
	if err != nil {
		return common.Address{}, nil, errors.Errorf("deployment tx not mined within 2 minutes (tx: %s): %s", tx.Hash().Hex(), err)
	}

	if receipt.Status != types.ReceiptStatusSuccessful {
		return common.Address{}, nil, errors.New("contract deployment failed")
	}

	return address, contract, nil
}

func SetExtensionId(s *support.Support, instructionSenderAddress common.Address) error {
	sender, err := sealedauction.NewSealedAuction(instructionSenderAddress, s.ChainClient)
	if err != nil {
		return errors.Errorf("failed to bind contract: %s", err)
	}

	opts, err := bind.NewKeyedTransactorWithChainID(s.Prv, s.ChainID)
	if err != nil {
		return errors.Errorf("failed to create transactor: %s", err)
	}

	tx, err := sender.SetExtensionId(opts)
	if err != nil {
		reason := fccutils.DecodeRevertReason(err)
		if reason == "" {
			parsed, _ := sealedauction.SealedAuctionMetaData.GetAbi()
			if parsed != nil {
				callData, packErr := parsed.Pack("setExtensionId")
				if packErr == nil {
					from := crypto.PubkeyToAddress(s.Prv.PublicKey)
					reason = fccutils.SimulateAndDecodeRevert(
						s.ChainClient, from, instructionSenderAddress, nil, callData,
					)
				}
			}
		}
		if reason != "" {
			return errors.Errorf("failed to call setExtensionId: %s (revert reason: %s)", err, reason)
		}
		return errors.Errorf("failed to call setExtensionId: %s", err)
	}

	receipt, err := bind.WaitMined(context.Background(), s.ChainClient, tx)
	if err != nil {
		return errors.Errorf("failed waiting for transaction: %s", err)
	}

	if receipt.Status != types.ReceiptStatusSuccessful {
		parsed, _ := sealedauction.SealedAuctionMetaData.GetAbi()
		if parsed != nil {
			callData, packErr := parsed.Pack("setExtensionId")
			if packErr == nil {
				from := crypto.PubkeyToAddress(s.Prv.PublicKey)
				reason := fccutils.SimulateAndDecodeRevert(
					s.ChainClient, from, instructionSenderAddress, nil, callData,
				)
				if reason != "" {
					return errors.Errorf("setExtensionId transaction failed (revert reason: %s)", reason)
				}
			}
		}
		return errors.New("setExtensionId transaction failed")
	}

	return nil
}

// SetTeeAddress registers the TEE signing address settle() verifies against.
func SetTeeAddress(s *support.Support, instructionSenderAddress, teeAddress common.Address) error {
	sender, err := sealedauction.NewSealedAuction(instructionSenderAddress, s.ChainClient)
	if err != nil {
		return errors.Errorf("failed to bind contract: %s", err)
	}
	opts, err := bind.NewKeyedTransactorWithChainID(s.Prv, s.ChainID)
	if err != nil {
		return errors.Errorf("failed to create transactor: %s", err)
	}
	tx, err := sender.SetTeeAddress(opts, teeAddress)
	if err != nil {
		return errors.Errorf("failed to call setTeeAddress: %s", err)
	}
	return waitOK(s, tx, "setTeeAddress")
}

// CreateAuction creates an auction and returns its id.
func CreateAuction(s *support.Support, instructionSenderAddress common.Address, lot string, payToken common.Address, deadline uint64, reservePrice *big.Int) (*big.Int, error) {
	sender, err := sealedauction.NewSealedAuction(instructionSenderAddress, s.ChainClient)
	if err != nil {
		return nil, errors.Errorf("failed to bind contract: %s", err)
	}
	opts, err := bind.NewKeyedTransactorWithChainID(s.Prv, s.ChainID)
	if err != nil {
		return nil, errors.Errorf("failed to create transactor: %s", err)
	}

	tx, err := sender.CreateAuction(opts, lot, payToken, deadline, reservePrice)
	if err != nil {
		return nil, errors.Errorf("failed to call createAuction: %s", err)
	}
	receipt, err := bind.WaitMined(context.Background(), s.ChainClient, tx)
	if err != nil {
		return nil, errors.Errorf("failed waiting for transaction: %s", err)
	}
	if receipt.Status != types.ReceiptStatusSuccessful {
		return nil, errors.New("createAuction transaction failed")
	}

	for _, lg := range receipt.Logs {
		created, parseErr := sender.ParseAuctionCreated(*lg)
		if parseErr == nil {
			return created.AuctionId, nil
		}
	}
	return nil, errors.New("AuctionCreated event not found in receipt")
}

// PlaceBid submits ECIES ciphertext as a sealed bid and returns the FCC
// instruction id parsed from the registry's TeeInstructionsSent event.
func PlaceBid(s *support.Support, instructionSenderAddress common.Address, auctionId *big.Int, ciphertext []byte) (common.Hash, common.Hash, error) {
	sender, err := sealedauction.NewSealedAuction(instructionSenderAddress, s.ChainClient)
	if err != nil {
		return common.Hash{}, common.Hash{}, errors.Errorf("failed to bind contract: %s", err)
	}
	opts, err := bind.NewKeyedTransactorWithChainID(s.Prv, s.ChainID)
	if err != nil {
		return common.Hash{}, common.Hash{}, errors.Errorf("failed to create transactor: %s", err)
	}
	opts.Value = InstructionFeeWei

	tx, err := sender.PlaceBid(opts, auctionId, ciphertext)
	if err != nil {
		return common.Hash{}, common.Hash{}, errors.Errorf("failed to call placeBid: %s", err)
	}
	return instructionFromTx(s, tx, "placeBid")
}

// CloseAuction requests winner selection and returns the FCC instruction id.
func CloseAuction(s *support.Support, instructionSenderAddress common.Address, auctionId *big.Int) (common.Hash, common.Hash, error) {
	sender, err := sealedauction.NewSealedAuction(instructionSenderAddress, s.ChainClient)
	if err != nil {
		return common.Hash{}, common.Hash{}, errors.Errorf("failed to bind contract: %s", err)
	}
	opts, err := bind.NewKeyedTransactorWithChainID(s.Prv, s.ChainID)
	if err != nil {
		return common.Hash{}, common.Hash{}, errors.Errorf("failed to create transactor: %s", err)
	}
	opts.Value = InstructionFeeWei

	tx, err := sender.CloseAuction(opts, auctionId)
	if err != nil {
		return common.Hash{}, common.Hash{}, errors.Errorf("failed to call closeAuction: %s", err)
	}
	return instructionFromTx(s, tx, "closeAuction")
}

// Settle relays the TEE-signed CLOSE_AUCTION result on-chain.
func Settle(s *support.Support, instructionSenderAddress common.Address, resultData []byte, actionId common.Hash, submissionTag string, status uint8, signature []byte) (common.Hash, error) {
	sender, err := sealedauction.NewSealedAuction(instructionSenderAddress, s.ChainClient)
	if err != nil {
		return common.Hash{}, errors.Errorf("failed to bind contract: %s", err)
	}
	opts, err := bind.NewKeyedTransactorWithChainID(s.Prv, s.ChainID)
	if err != nil {
		return common.Hash{}, errors.Errorf("failed to create transactor: %s", err)
	}

	tx, err := sender.Settle(opts, resultData, actionId, submissionTag, status, signature)
	if err != nil {
		return common.Hash{}, errors.Errorf("failed to call settle: %s", err)
	}
	if err := waitOK(s, tx, "settle"); err != nil {
		return common.Hash{}, err
	}
	return tx.Hash(), nil
}

// SendNative transfers native coin from the support key — used to give
// ephemeral test bidders gas money.
func SendNative(s *support.Support, to common.Address, amountWei *big.Int) error {
	from := crypto.PubkeyToAddress(s.Prv.PublicKey)
	nonce, err := s.ChainClient.PendingNonceAt(context.Background(), from)
	if err != nil {
		return errors.Errorf("failed to fetch nonce: %s", err)
	}
	gasPrice, err := s.ChainClient.SuggestGasPrice(context.Background())
	if err != nil {
		return errors.Errorf("failed to fetch gas price: %s", err)
	}
	tx := types.NewTransaction(nonce, to, amountWei, 21000, gasPrice, nil)
	signed, err := types.SignTx(tx, types.LatestSignerForChainID(s.ChainID), s.Prv)
	if err != nil {
		return errors.Errorf("failed to sign transfer: %s", err)
	}
	if err := s.ChainClient.SendTransaction(context.Background(), signed); err != nil {
		return errors.Errorf("failed to send transfer: %s", err)
	}
	return waitOK(s, signed, "native transfer")
}

func waitOK(s *support.Support, tx *types.Transaction, label string) error {
	receipt, err := bind.WaitMined(context.Background(), s.ChainClient, tx)
	if err != nil {
		return errors.Errorf("failed waiting for %s transaction: %s", label, err)
	}
	if receipt.Status != types.ReceiptStatusSuccessful {
		return errors.Errorf("%s transaction failed", label)
	}
	return nil
}

func instructionFromTx(s *support.Support, tx *types.Transaction, label string) (common.Hash, common.Hash, error) {
	receipt, err := bind.WaitMined(context.Background(), s.ChainClient, tx)
	if err != nil {
		return common.Hash{}, common.Hash{}, errors.Errorf("failed waiting for %s transaction: %s", label, err)
	}
	if receipt.Status != types.ReceiptStatusSuccessful {
		return common.Hash{}, common.Hash{}, errors.Errorf("%s transaction failed", label)
	}

	for _, lg := range receipt.Logs {
		instructionSent, parseErr := s.TeeVerification.ParseTeeInstructionsSent(*lg)
		if parseErr == nil {
			return instructionSent.InstructionId, receipt.TxHash, nil
		}
	}
	return common.Hash{}, common.Hash{}, errors.Errorf("TeeInstructionsSent event not found in %s receipt", label)
}
