package extension

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
)

// --- TEE node /decrypt RPC (same pattern as fce-weather-insurance) ---

type decryptRequest struct {
	EncryptedMessage []byte `json:"encryptedMessage"`
}

type decryptResponse struct {
	DecryptedMessage []byte `json:"decryptedMessage"`
}

// decryptViaNode forwards ECIES ciphertext to the local tee-node /decrypt
// endpoint. The ECIES private key lives in tee-node and never enters this process.
func decryptViaNode(signPort int, ciphertext []byte) ([]byte, error) {
	url := fmt.Sprintf("http://localhost:%d/decrypt", signPort)
	reqBody, _ := json.Marshal(decryptRequest{EncryptedMessage: ciphertext})

	resp, err := http.DefaultClient.Post(url, "application/json", bytes.NewReader(reqBody))
	if err != nil {
		return nil, fmt.Errorf("request error: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("node returned %d: %s", resp.StatusCode, string(b))
	}

	var dr decryptResponse
	if err := json.NewDecoder(resp.Body).Decode(&dr); err != nil {
		return nil, fmt.Errorf("decode response: %w", err)
	}
	return dr.DecryptedMessage, nil
}
