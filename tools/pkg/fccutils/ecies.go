package fccutils

import (
	"crypto/rand"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/ethereum/go-ethereum/crypto/ecies"
	teetypes "github.com/flare-foundation/tee-node/pkg/types"
	"github.com/pkg/errors"
)

// TeeECIESPublicKey fetches the extension proxy /info response and returns the
// TEE node's ECIES public key (machineData.publicKey).
func TeeECIESPublicKey(proxyURL string) (*ecies.PublicKey, error) {
	teeInfo, err := TeeInfo(proxyURL)
	if err != nil {
		return nil, errors.Errorf("fetch TEE info: %s", err)
	}

	ecdsaPub, err := teetypes.ParsePubKey(teeInfo.MachineData.PublicKey)
	if err != nil {
		return nil, errors.Errorf("parse TEE public key: %s", err)
	}

	return &ecies.PublicKey{
		X:      ecdsaPub.X,
		Y:      ecdsaPub.Y,
		Curve:  ecies.DefaultCurve,
		Params: ecies.ECIES_AES128_SHA256,
	}, nil
}

// EncryptForTee ECIES-encrypts plaintext under the TEE public key.
func EncryptForTee(pub *ecies.PublicKey, plaintext []byte) ([]byte, error) {
	ciphertext, err := ecies.Encrypt(rand.Reader, pub, plaintext, nil, nil)
	if err != nil {
		return nil, errors.Errorf("ECIES encrypt: %s", err)
	}
	return ciphertext, nil
}

// TeeSigningAddress returns the on-chain address derived from the TEE public key in /info.
func TeeSigningAddress(proxyURL string) (common.Address, error) {
	teeInfo, err := TeeInfo(proxyURL)
	if err != nil {
		return common.Address{}, errors.Errorf("fetch TEE info: %s", err)
	}
	pubKey, err := teetypes.ParsePubKey(teeInfo.TeeInfo.PublicKey)
	if err != nil {
		return common.Address{}, errors.Errorf("parse TEE public key: %s", err)
	}
	return crypto.PubkeyToAddress(*pubKey), nil
}
