package extension

import (
	"encoding/json"
	"fmt"
	"math/big"
	"net/http"
	"strings"
	"testing"

	"sealed-auction/internal/config"
	"sealed-auction/pkg/types"

	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/common/hexutil"
	teetypes "github.com/flare-foundation/tee-node/pkg/types"
	teeutils "github.com/flare-foundation/tee-node/pkg/utils"
)

var (
	contractA = common.HexToAddress("0x00000000000000000000000000000000000000AA")
	alice     = common.HexToAddress("0x0000000000000000000000000000000000000A11")
	bob       = common.HexToAddress("0x0000000000000000000000000000000000000B0B")
	carol     = common.HexToAddress("0x0000000000000000000000000000000000000CA0")
)

func toHash(s string) common.Hash { return teeutils.ToHash(s) }

// newTestExtension returns an Extension whose decrypt is the identity function:
// tests pass ABI-encoded BidPayload bytes directly as "ciphertext".
func newTestExtension() *Extension {
	return &Extension{
		decrypt: func(ct []byte) ([]byte, error) { return ct, nil },
		bids:    make(map[string][]Bid),
		closed:  make(map[string]bool),
	}
}

// buildTestAction constructs a teetypes.Action whose Data.Message is the
// JSON-encoded DataFixed payload, as tee-node sends it.
func buildTestAction(opType, opCommand common.Hash, originalMessage []byte, timestamp uint64) teetypes.Action {
	type dataFixed struct {
		InstructionID      common.Hash    `json:"instructionId"`
		TeeID              common.Address `json:"teeId"`
		Timestamp          uint64         `json:"timestamp"`
		RewardEpochID      uint32         `json:"rewardEpochId"`
		OPType             common.Hash    `json:"opType"`
		OPCommand          common.Hash    `json:"opCommand"`
		Cosigners          []string       `json:"cosigners"`
		CosignersThreshold uint64         `json:"cosignersThreshold"`
		OriginalMessage    hexutil.Bytes  `json:"originalMessage"`
	}

	df := dataFixed{
		Timestamp:       timestamp,
		OPType:          opType,
		OPCommand:       opCommand,
		OriginalMessage: originalMessage,
	}
	msg, _ := json.Marshal(df)

	return teetypes.Action{
		Data: teetypes.ActionData{
			ID:            common.HexToHash("0x1234"),
			SubmissionTag: "submit",
			Message:       msg,
		},
	}
}

func encodePlaceBidMessage(t *testing.T, auctionId *big.Int, bidder common.Address, ciphertext []byte) []byte {
	t.Helper()
	args := abi.Arguments{types.PlaceBidMessageArg}
	encoded, err := args.Pack(struct {
		AuctionId  *big.Int
		Bidder     common.Address
		Ciphertext []byte
	}{auctionId, bidder, ciphertext})
	if err != nil {
		t.Fatalf("encode PlaceBidMessage: %v", err)
	}
	return encoded
}

func encodeBidPayload(t *testing.T, auctionId *big.Int, contractAddr, bidder common.Address, amount *big.Int) []byte {
	t.Helper()
	args := abi.Arguments{types.BidPayloadArg}
	encoded, err := args.Pack(struct {
		AuctionId    *big.Int
		ContractAddr common.Address
		Bidder       common.Address
		AmountWei    *big.Int
		Salt         [32]byte
	}{auctionId, contractAddr, bidder, amount, [32]byte{0x42}})
	if err != nil {
		t.Fatalf("encode BidPayload: %v", err)
	}
	return encoded
}

func encodeCloseMessage(t *testing.T, auctionId *big.Int, contractAddr common.Address, reserve *big.Int, deadline uint64) []byte {
	t.Helper()
	args := abi.Arguments{types.CloseMessageArg}
	encoded, err := args.Pack(struct {
		AuctionId    *big.Int
		ContractAddr common.Address
		ReservePrice *big.Int
		Deadline     uint64
	}{auctionId, contractAddr, reserve, deadline})
	if err != nil {
		t.Fatalf("encode CloseMessage: %v", err)
	}
	return encoded
}

// placeBid drives a full PLACE_BID action through processAction and returns the ActionResult.
func placeBid(t *testing.T, e *Extension, auctionId int64, bidder common.Address, payload []byte, timestamp uint64) teetypes.ActionResult {
	t.Helper()
	msg := encodePlaceBidMessage(t, big.NewInt(auctionId), bidder, payload)
	action := buildTestAction(toHash(config.OPTypeAuction), toHash(config.OPCommandPlaceBid), msg, timestamp)
	status, body := e.processAction(action)
	if status != http.StatusOK {
		t.Fatalf("PLACE_BID: expected HTTP 200, got %d: %s", status, body)
	}
	var ar teetypes.ActionResult
	if err := json.Unmarshal(body, &ar); err != nil {
		t.Fatalf("unmarshal ActionResult: %v", err)
	}
	return ar
}

// closeAuction drives a CLOSE_AUCTION action and returns the decoded result.
func closeAuction(t *testing.T, e *Extension, auctionId int64, reserve *big.Int) types.AuctionResult {
	t.Helper()
	msg := encodeCloseMessage(t, big.NewInt(auctionId), contractA, reserve, 1700000000)
	action := buildTestAction(toHash(config.OPTypeAuction), toHash(config.OPCommandCloseAuction), msg, 1700000100)
	status, body := e.processAction(action)
	if status != http.StatusOK {
		t.Fatalf("CLOSE_AUCTION: expected HTTP 200, got %d: %s", status, body)
	}
	var ar teetypes.ActionResult
	if err := json.Unmarshal(body, &ar); err != nil {
		t.Fatalf("unmarshal ActionResult: %v", err)
	}
	if ar.Status != 1 {
		t.Fatalf("CLOSE_AUCTION: expected status 1, got %d (%s)", ar.Status, ar.Log)
	}
	vals, err := types.AuctionResultArgs.Unpack(ar.Data)
	if err != nil {
		t.Fatalf("unpack AuctionResult: %v", err)
	}
	return types.AuctionResult{
		ContractAddr:  vals[0].(common.Address),
		AuctionId:     vals[1].(*big.Int),
		Winner:        vals[2].(common.Address),
		ClearingPrice: vals[3].(*big.Int),
	}
}

// --- pickWinner: table-driven ---

func TestPickWinner(t *testing.T) {
	wei := func(n int64) *big.Int { return big.NewInt(n) }
	bid := func(bidder common.Address, amount int64, ts, seq uint64) Bid {
		return Bid{Bidder: bidder, ContractAddr: contractA, Amount: wei(amount), Timestamp: ts, Seq: seq}
	}

	cases := []struct {
		name       string
		bids       []Bid
		reserve    *big.Int
		wantWinner common.Address
		wantPrice  int64
		wantOK     bool
	}{
		{name: "empty set", bids: nil, reserve: wei(0), wantWinner: common.Address{}, wantPrice: 0, wantOK: false},
		{name: "single bid no reserve", bids: []Bid{bid(alice, 100, 1, 1)}, reserve: wei(0),
			wantWinner: alice, wantPrice: 100, wantOK: true},
		{name: "highest wins", bids: []Bid{bid(alice, 100, 1, 1), bid(bob, 300, 2, 2), bid(carol, 200, 3, 3)},
			reserve: wei(0), wantWinner: bob, wantPrice: 300, wantOK: true},
		{name: "all below reserve", bids: []Bid{bid(alice, 100, 1, 1), bid(bob, 150, 2, 2)}, reserve: wei(200),
			wantWinner: common.Address{}, wantPrice: 0, wantOK: false},
		{name: "reserve exactly met", bids: []Bid{bid(alice, 200, 1, 1)}, reserve: wei(200),
			wantWinner: alice, wantPrice: 200, wantOK: true},
		{name: "reserve filters the highest bidder out never happens (highest >= others), lower filtered",
			bids: []Bid{bid(alice, 100, 1, 1), bid(bob, 250, 2, 2)}, reserve: wei(200),
			wantWinner: bob, wantPrice: 250, wantOK: true},
		{name: "tie on amount earlier timestamp wins", bids: []Bid{bid(alice, 300, 20, 1), bid(bob, 300, 10, 2)},
			reserve: wei(0), wantWinner: bob, wantPrice: 300, wantOK: true},
		{name: "tie on amount and timestamp lower seq wins", bids: []Bid{bid(alice, 300, 10, 5), bid(bob, 300, 10, 4)},
			reserve: wei(0), wantWinner: bob, wantPrice: 300, wantOK: true},
		{name: "nil reserve treated as zero", bids: []Bid{bid(alice, 1, 1, 1)}, reserve: nil,
			wantWinner: alice, wantPrice: 1, wantOK: true},
		{name: "other contract bids excluded",
			bids: []Bid{{Bidder: alice, ContractAddr: common.HexToAddress("0xdead"), Amount: wei(999), Timestamp: 1, Seq: 1},
				bid(bob, 100, 2, 2)},
			reserve: wei(0), wantWinner: bob, wantPrice: 100, wantOK: true},
		{name: "zero amount excluded", bids: []Bid{{Bidder: alice, ContractAddr: contractA, Amount: wei(0), Timestamp: 1, Seq: 1}},
			reserve: wei(0), wantWinner: common.Address{}, wantPrice: 0, wantOK: false},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			winner, price, ok := pickWinner(tc.bids, contractA, tc.reserve)
			if ok != tc.wantOK {
				t.Fatalf("ok: want %v, got %v", tc.wantOK, ok)
			}
			if winner != tc.wantWinner {
				t.Errorf("winner: want %s, got %s", tc.wantWinner.Hex(), winner.Hex())
			}
			if price.Cmp(big.NewInt(tc.wantPrice)) != 0 {
				t.Errorf("price: want %d, got %s", tc.wantPrice, price)
			}
		})
	}
}

// --- PLACE_BID handler ---

func TestPlaceBid_Success(t *testing.T) {
	e := newTestExtension()
	payload := encodeBidPayload(t, big.NewInt(7), contractA, alice, big.NewInt(500))
	ar := placeBid(t, e, 7, alice, payload, 100)

	if ar.Status != 1 {
		t.Fatalf("expected status 1, got %d (%s)", ar.Status, ar.Log)
	}
	var resp types.PlaceBidResponse
	if err := json.Unmarshal(ar.Data, &resp); err != nil || !resp.Accepted {
		t.Fatalf("expected {accepted:true}, got %s (err %v)", ar.Data, err)
	}
	if got := string(ar.Data); strings.Contains(got, "500") {
		t.Errorf("PLACE_BID result must not leak the amount, got %s", got)
	}
	if len(e.bids["7"]) != 1 {
		t.Fatalf("expected 1 stored bid, got %d", len(e.bids["7"]))
	}
}

func TestPlaceBid_Rejections(t *testing.T) {
	cases := []struct {
		name    string
		payload func(t *testing.T) []byte
		wantLog string
	}{
		{"bidder mismatch (spoof or ciphertext replay)",
			func(t *testing.T) []byte { return encodeBidPayload(t, big.NewInt(7), contractA, bob, big.NewInt(500)) },
			"payload bidder does not match on-chain sender"},
		{"auctionId mismatch",
			func(t *testing.T) []byte { return encodeBidPayload(t, big.NewInt(8), contractA, alice, big.NewInt(500)) },
			"payload auctionId does not match instruction"},
		{"zero amount",
			func(t *testing.T) []byte { return encodeBidPayload(t, big.NewInt(7), contractA, alice, big.NewInt(0)) },
			"bid amount must be positive"},
		{"garbage plaintext",
			func(t *testing.T) []byte { return []byte("not abi") },
			"decoding bid payload"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			e := newTestExtension()
			ar := placeBid(t, e, 7, alice, tc.payload(t), 100)
			if ar.Status != 0 {
				t.Fatalf("expected status 0, got %d (%s)", ar.Status, ar.Log)
			}
			if !strings.Contains(ar.Log, tc.wantLog) {
				t.Errorf("log: want substring %q, got %q", tc.wantLog, ar.Log)
			}
			if len(e.bids["7"]) != 0 {
				t.Errorf("rejected bid must not be stored")
			}
		})
	}
}

func TestPlaceBid_DecryptFailure(t *testing.T) {
	e := newTestExtension()
	e.decrypt = func([]byte) ([]byte, error) { return nil, fmt.Errorf("boom") }
	payload := encodeBidPayload(t, big.NewInt(7), contractA, alice, big.NewInt(500))
	ar := placeBid(t, e, 7, alice, payload, 100)
	if ar.Status != 0 || !strings.Contains(ar.Log, "decryption failed") {
		t.Fatalf("expected decryption failure, got status %d log %q", ar.Status, ar.Log)
	}
}

func TestPlaceBid_AfterCloseRejected(t *testing.T) {
	e := newTestExtension()
	closeAuction(t, e, 7, big.NewInt(0))

	payload := encodeBidPayload(t, big.NewInt(7), contractA, alice, big.NewInt(500))
	ar := placeBid(t, e, 7, alice, payload, 100)
	if ar.Status != 0 || !strings.Contains(ar.Log, "already closed") {
		t.Fatalf("expected 'already closed' rejection, got status %d log %q", ar.Status, ar.Log)
	}
}

// --- CLOSE_AUCTION handler ---

func TestCloseAuction_EndToEnd(t *testing.T) {
	e := newTestExtension()
	placeBid(t, e, 7, alice, encodeBidPayload(t, big.NewInt(7), contractA, alice, big.NewInt(100)), 10)
	placeBid(t, e, 7, bob, encodeBidPayload(t, big.NewInt(7), contractA, bob, big.NewInt(300)), 20)
	placeBid(t, e, 7, carol, encodeBidPayload(t, big.NewInt(7), contractA, carol, big.NewInt(200)), 30)

	res := closeAuction(t, e, 7, big.NewInt(150))
	if res.Winner != bob {
		t.Errorf("winner: want %s, got %s", bob.Hex(), res.Winner.Hex())
	}
	if res.ClearingPrice.Cmp(big.NewInt(300)) != 0 {
		t.Errorf("clearingPrice: want 300, got %s", res.ClearingPrice)
	}
	if res.ContractAddr != contractA || res.AuctionId.Cmp(big.NewInt(7)) != 0 {
		t.Errorf("result binding wrong: %s %s", res.ContractAddr.Hex(), res.AuctionId)
	}
}

func TestCloseAuction_NoBidsMeansZeroWinner(t *testing.T) {
	e := newTestExtension()
	res := closeAuction(t, e, 9, big.NewInt(0))
	if res.Winner != (common.Address{}) || res.ClearingPrice.Sign() != 0 {
		t.Fatalf("expected zero winner and price, got %s / %s", res.Winner.Hex(), res.ClearingPrice)
	}
}

func TestCloseAuction_IdempotentReclose(t *testing.T) {
	e := newTestExtension()
	placeBid(t, e, 7, alice, encodeBidPayload(t, big.NewInt(7), contractA, alice, big.NewInt(100)), 10)

	first := closeAuction(t, e, 7, big.NewInt(0))
	second := closeAuction(t, e, 7, big.NewInt(0))
	if first.Winner != second.Winner || first.ClearingPrice.Cmp(second.ClearingPrice) != 0 {
		t.Fatalf("re-close must reproduce the same result: %s/%s vs %s/%s",
			first.Winner.Hex(), first.ClearingPrice, second.Winner.Hex(), second.ClearingPrice)
	}
}

// --- Router ---

func TestProcessAction_UnknownOPType(t *testing.T) {
	e := newTestExtension()
	action := buildTestAction(toHash("UNKNOWN_TYPE"), toHash(config.OPCommandPlaceBid), nil, 0)

	status, body := e.processAction(action)
	if status != http.StatusNotImplemented {
		t.Fatalf("expected 501, got %d", status)
	}
	bodyStr := string(body)
	if !strings.Contains(bodyStr, "unsupported op type") {
		t.Error("expected body to contain 'unsupported op type'")
	}
	for _, want := range []string{toHash("UNKNOWN_TYPE").Hex(), toHash(config.OPTypeAuction).Hex(), config.OPTypeAuction} {
		if !strings.Contains(bodyStr, want) {
			t.Errorf("expected body to contain %q", want)
		}
	}
}

func TestProcessAction_UnknownOPCommand(t *testing.T) {
	e := newTestExtension()
	action := buildTestAction(toHash(config.OPTypeAuction), toHash("NOT_A_COMMAND"), nil, 0)

	status, body := e.processAction(action)
	if status != http.StatusNotImplemented {
		t.Fatalf("expected 501, got %d", status)
	}
	bodyStr := string(body)
	if !strings.Contains(bodyStr, "unsupported op command") {
		t.Error("expected body to contain 'unsupported op command'")
	}
	for _, cmd := range []string{config.OPCommandPlaceBid, config.OPCommandCloseAuction} {
		if !strings.Contains(bodyStr, cmd) || !strings.Contains(bodyStr, toHash(cmd).Hex()) {
			t.Errorf("expected body to name %q and its hash", cmd)
		}
	}
}

func TestProcessAction_InvalidDataMessage(t *testing.T) {
	e := newTestExtension()
	action := teetypes.Action{
		Data: teetypes.ActionData{
			ID:      common.HexToHash("0xabcd"),
			Message: []byte(`not json at all`),
		},
	}

	status, body := e.processAction(action)
	if status != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d: %s", status, body)
	}
	if !strings.Contains(string(body), "decoding fixed data") {
		t.Errorf("expected body to mention 'decoding fixed data', got %q", body)
	}
}
