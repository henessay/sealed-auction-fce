package utils

import (
	"context"
	"math/big"

	"github.com/ethereum/go-ethereum"
	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/ethclient"
	"github.com/pkg/errors"
)

// FlareContractRegistry lives at the same address on every Flare chain.
// https://dev.flare.network/network/guides/flare-contracts-registry
var FlareContractRegistry = common.HexToAddress("0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019")

// ResolveFXRP discovers the FXRP FAsset token on the connected chain:
// FlareContractRegistry.getContractAddressByName("AssetManagerFXRP") →
// AssetManager.fAsset(). Returns the token address and its decimals.
func ResolveFXRP(client *ethclient.Client) (common.Address, uint8, error) {
	assetManager, err := callForAddress(
		client, FlareContractRegistry, "getContractAddressByName", "AssetManagerFXRP",
	)
	if err != nil {
		return common.Address{}, 0, errors.Errorf("resolve AssetManagerFXRP: %s", err)
	}
	if assetManager == (common.Address{}) {
		return common.Address{}, 0, errors.New("AssetManagerFXRP not found in FlareContractRegistry — is FXRP deployed on this chain?")
	}

	token, err := callForAddress(client, assetManager, "fAsset")
	if err != nil {
		return common.Address{}, 0, errors.Errorf("AssetManager.fAsset(): %s", err)
	}

	decimals, err := tokenDecimals(client, token)
	if err != nil {
		return common.Address{}, 0, errors.Errorf("FXRP decimals(): %s", err)
	}
	return token, decimals, nil
}

func callForAddress(client *ethclient.Client, to common.Address, method string, strArg ...string) (common.Address, error) {
	var (
		inputs abi.Arguments
		args   []any
	)
	if len(strArg) > 0 {
		stringTy, _ := abi.NewType("string", "", nil)
		inputs = abi.Arguments{{Type: stringTy}}
		args = []any{strArg[0]}
	}
	addressTy, _ := abi.NewType("address", "", nil)
	m := abi.NewMethod(method, method, abi.Function, "view", false, false, inputs, abi.Arguments{{Type: addressTy}})

	packedArgs, err := inputs.Pack(args...)
	if err != nil {
		return common.Address{}, err
	}
	out, err := client.CallContract(context.Background(), ethereum.CallMsg{
		To: &to, Data: append(m.ID, packedArgs...),
	}, nil)
	if err != nil {
		return common.Address{}, err
	}
	vals, err := m.Outputs.Unpack(out)
	if err != nil {
		return common.Address{}, err
	}
	return vals[0].(common.Address), nil
}

func tokenDecimals(client *ethclient.Client, token common.Address) (uint8, error) {
	uint8Ty, _ := abi.NewType("uint8", "", nil)
	m := abi.NewMethod("decimals", "decimals", abi.Function, "view", false, false, nil, abi.Arguments{{Type: uint8Ty}})
	out, err := client.CallContract(context.Background(), ethereum.CallMsg{To: &token, Data: m.ID}, nil)
	if err != nil {
		return 0, err
	}
	vals, err := m.Outputs.Unpack(out)
	if err != nil {
		return 0, err
	}
	return vals[0].(uint8), nil
}

// TokenBalanceOf returns the ERC-20 balance of an account.
func TokenBalanceOf(client *ethclient.Client, token, account common.Address) (*big.Int, error) {
	addressTy, _ := abi.NewType("address", "", nil)
	uintTy, _ := abi.NewType("uint256", "", nil)
	m := abi.NewMethod("balanceOf", "balanceOf", abi.Function, "view", false, false,
		abi.Arguments{{Type: addressTy}}, abi.Arguments{{Type: uintTy}})
	packedArgs, err := abi.Arguments{{Type: addressTy}}.Pack(account)
	if err != nil {
		return nil, err
	}
	out, err := client.CallContract(context.Background(), ethereum.CallMsg{
		To: &token, Data: append(m.ID, packedArgs...),
	}, nil)
	if err != nil {
		return nil, err
	}
	vals, err := m.Outputs.Unpack(out)
	if err != nil {
		return nil, err
	}
	return vals[0].(*big.Int), nil
}
