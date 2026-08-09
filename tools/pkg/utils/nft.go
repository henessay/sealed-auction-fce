package utils

import (
	"context"
	"math/big"
	"strings"

	"sealed-auction/tools/pkg/support"

	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/accounts/abi/bind"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/pkg/errors"
)

// Minimal DemoAsset721 surface: mint (owner only), approve, ownerOf.
const demoAsset721ABI = `[
  {"name":"mint","type":"function","stateMutability":"nonpayable","inputs":[{"name":"to","type":"address"}],"outputs":[{"name":"","type":"uint256"}]},
  {"name":"approve","type":"function","stateMutability":"nonpayable","inputs":[{"name":"to","type":"address"},{"name":"tokenId","type":"uint256"}],"outputs":[]},
  {"name":"ownerOf","type":"function","stateMutability":"view","inputs":[{"name":"tokenId","type":"uint256"}],"outputs":[{"name":"","type":"address"}]},
  {"name":"nextTokenId","type":"function","stateMutability":"view","inputs":[],"outputs":[{"name":"","type":"uint256"}]},
  {"anonymous":false,"name":"Transfer","type":"event","inputs":[{"indexed":true,"name":"from","type":"address"},{"indexed":true,"name":"to","type":"address"},{"indexed":true,"name":"tokenId","type":"uint256"}]}
]`

func demoAsset(token common.Address, s *support.Support) (*bind.BoundContract, abi.ABI, error) {
	parsed, err := abi.JSON(strings.NewReader(demoAsset721ABI))
	if err != nil {
		return nil, abi.ABI{}, err
	}
	return bind.NewBoundContract(token, parsed, s.ChainClient, s.ChainClient, s.ChainClient), parsed, nil
}

// MintDemoAsset mints the next token id to `to` and returns it. The support
// key must own the DemoAsset721 contract.
func MintDemoAsset(s *support.Support, asset, to common.Address) (*big.Int, error) {
	c, parsed, err := demoAsset(asset, s)
	if err != nil {
		return nil, errors.Errorf("demo asset bind: %s", err)
	}
	opts, err := bind.NewKeyedTransactorWithChainID(s.Prv, s.ChainID)
	if err != nil {
		return nil, errors.Errorf("transactor: %s", err)
	}
	tx, err := c.Transact(opts, "mint", to)
	if err != nil {
		return nil, errors.Errorf("mint: %s", err)
	}
	receipt, err := bind.WaitMined(context.Background(), s.ChainClient, tx)
	if err != nil {
		return nil, errors.Errorf("wait mint: %s", err)
	}
	if receipt.Status != types.ReceiptStatusSuccessful {
		return nil, errors.New("mint transaction failed")
	}

	// Transfer(from=0, to, tokenId) — tokenId is the third indexed topic.
	transferTopic := parsed.Events["Transfer"].ID
	for _, lg := range receipt.Logs {
		if len(lg.Topics) == 4 && lg.Topics[0] == transferTopic {
			return new(big.Int).SetBytes(lg.Topics[3].Bytes()), nil
		}
	}
	return nil, errors.New("Transfer event not found in mint receipt")
}

// ApproveNFT lets `spender` move a single token id.
func ApproveNFT(s *support.Support, asset, spender common.Address, tokenId *big.Int) error {
	c, _, err := demoAsset(asset, s)
	if err != nil {
		return errors.Errorf("demo asset bind: %s", err)
	}
	opts, err := bind.NewKeyedTransactorWithChainID(s.Prv, s.ChainID)
	if err != nil {
		return errors.Errorf("transactor: %s", err)
	}
	tx, err := c.Transact(opts, "approve", spender, tokenId)
	if err != nil {
		return errors.Errorf("approve nft: %s", err)
	}
	return waitOK(s, tx, "approve nft")
}

// NFTOwner returns the current holder of a token id.
func NFTOwner(s *support.Support, asset common.Address, tokenId *big.Int) (common.Address, error) {
	c, _, err := demoAsset(asset, s)
	if err != nil {
		return common.Address{}, errors.Errorf("demo asset bind: %s", err)
	}
	var out []interface{}
	if err := c.Call(&bind.CallOpts{}, &out, "ownerOf", tokenId); err != nil {
		return common.Address{}, errors.Errorf("ownerOf: %s", err)
	}
	if len(out) != 1 {
		return common.Address{}, errors.New("ownerOf: unexpected output")
	}
	return out[0].(common.Address), nil
}
