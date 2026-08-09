package extension

import (
	"encoding/json"
	"fmt"
	"net/http"
	"sync"

	"sealed-auction/internal/config"
	"sealed-auction/pkg/types"

	"github.com/flare-foundation/go-flare-common/pkg/tee/instruction"
	"github.com/flare-foundation/go-flare-common/pkg/tee/structs"
	teetypes "github.com/flare-foundation/tee-node/pkg/types"
	teeutils "github.com/flare-foundation/tee-node/pkg/utils"

	"github.com/flare-foundation/tee-node/pkg/processorutils"
)

// Extension holds sealed bids in process memory, keyed by auction id.
// Bids are volatile by design (v1): a restart between placeBid and closeAuction
// loses them and the auction settles as cancelled. See ARCHITECTURE.md.
type Extension struct {
	Server *http.Server

	// decrypt forwards ECIES ciphertext to tee-node /decrypt.
	// Injectable for unit tests; defaults to the local node call.
	decrypt func(ciphertext []byte) ([]byte, error)

	mu     sync.RWMutex
	bids   map[string][]Bid // auctionId (decimal string) → bids in arrival order
	closed map[string]bool  // auctions already closed in this process
	seq    uint64
}

// --- DO NOT MODIFY: New(), actionHandler() are boilerplate.
func New(extensionPort, signPort int) *Extension {
	e := &Extension{
		decrypt: func(ct []byte) ([]byte, error) { return decryptViaNode(signPort, ct) },
		bids:    make(map[string][]Bid),
		closed:  make(map[string]bool),
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /state", e.stateHandler)
	mux.HandleFunc("POST /action", e.actionHandler)

	e.Server = &http.Server{Addr: fmt.Sprintf(":%d", extensionPort), Handler: mux}
	return e
}

// stateHandler reports aggregate counters only — never bid amounts.
func (e *Extension) stateHandler(w http.ResponseWriter, r *http.Request) {
	e.mu.RLock()
	bidsStored := 0
	for _, bs := range e.bids {
		bidsStored += len(bs)
	}
	stateResponse := types.StateResponse{
		StateVersion: teeutils.ToHash(config.Version),
		State: types.State{
			AuctionsTracked: len(e.bids),
			AuctionsClosed:  len(e.closed),
			BidsStored:      bidsStored,
		},
	}
	e.mu.RUnlock()

	err := json.NewEncoder(w).Encode(stateResponse)
	if err != nil {
		http.Error(w, fmt.Sprintf("sending response: %v", err), http.StatusInternalServerError)
		return
	}
}

func (e *Extension) processAction(action teetypes.Action) (int, []byte) {
	dataFixed, err := processorutils.Parse[instruction.DataFixed](action.Data.Message)
	if err != nil {
		return http.StatusBadRequest, []byte(fmt.Sprintf("decoding fixed data: %v", err))
	}

	switch {
	case dataFixed.OPType == teeutils.ToHash(config.OPTypeAuction):
		return e.processAuction(action, dataFixed)

	default:
		return http.StatusNotImplemented, []byte(fmt.Sprintf(
			"unsupported op type: received %s, expected %s (%s)",
			dataFixed.OPType.Hex(), teeutils.ToHash(config.OPTypeAuction).Hex(), config.OPTypeAuction,
		))
	}
}

// processAuction routes AUCTION instructions by OPCommand.
func (e *Extension) processAuction(action teetypes.Action, df *instruction.DataFixed) (int, []byte) {
	switch {
	case df.OPCommand == teeutils.ToHash(config.OPCommandPlaceBid):
		ar := e.processPlaceBid(action, df)
		b, _ := json.Marshal(ar)
		return http.StatusOK, b

	case df.OPCommand == teeutils.ToHash(config.OPCommandCloseAuction):
		ar := e.processCloseAuction(action, df)
		b, _ := json.Marshal(ar)
		return http.StatusOK, b

	default:
		return http.StatusNotImplemented, []byte(fmt.Sprintf(
			"unsupported op command: received %s, expected one of [%s (%s), %s (%s)]",
			df.OPCommand.Hex(),
			teeutils.ToHash(config.OPCommandPlaceBid).Hex(), config.OPCommandPlaceBid,
			teeutils.ToHash(config.OPCommandCloseAuction).Hex(), config.OPCommandCloseAuction,
		))
	}
}

// processPlaceBid decodes the chain-authenticated wrapper, decrypts the ECIES
// ciphertext via tee-node, cross-checks wrapper vs payload, and stores the bid.
func (e *Extension) processPlaceBid(action teetypes.Action, df *instruction.DataFixed) teetypes.ActionResult {
	if len(df.OriginalMessage) == 0 {
		return buildResult(action, df, nil, 0, fmt.Errorf("originalMessage is empty"))
	}

	wrapper, err := structs.Decode[types.PlaceBidMessage](types.PlaceBidMessageArg, df.OriginalMessage)
	if err != nil {
		return buildResult(action, df, nil, 0, fmt.Errorf("decoding place-bid message: %v", err))
	}
	if wrapper.AuctionId == nil {
		return buildResult(action, df, nil, 0, fmt.Errorf("auctionId missing"))
	}
	if len(wrapper.Ciphertext) == 0 {
		return buildResult(action, df, nil, 0, fmt.Errorf("ciphertext must not be empty"))
	}

	// Cheap checks before touching the node: a bid for an already-closed
	// auction is rejected without decryption.
	key := wrapper.AuctionId.String()
	e.mu.RLock()
	isClosed := e.closed[key]
	e.mu.RUnlock()
	if isClosed {
		return buildResult(action, df, nil, 0, fmt.Errorf("auction %s already closed", key))
	}

	plaintext, err := e.decrypt(wrapper.Ciphertext)
	if err != nil {
		return buildResult(action, df, nil, 0, fmt.Errorf("decryption failed: %v", err))
	}

	payload, err := structs.Decode[types.BidPayload](types.BidPayloadArg, plaintext)
	if err != nil {
		return buildResult(action, df, nil, 0, fmt.Errorf("decoding bid payload: %v", err))
	}

	// The wrapper is built on-chain from msg.sender — it is the trusted source.
	// A payload that disagrees is either a spoof attempt or a replayed
	// ciphertext from another bidder; both are rejected.
	if payload.Bidder != wrapper.Bidder {
		return buildResult(action, df, nil, 0, fmt.Errorf("payload bidder does not match on-chain sender"))
	}
	if payload.AuctionId == nil || payload.AuctionId.Cmp(wrapper.AuctionId) != 0 {
		return buildResult(action, df, nil, 0, fmt.Errorf("payload auctionId does not match instruction"))
	}
	if payload.AmountWei == nil || payload.AmountWei.Sign() <= 0 {
		return buildResult(action, df, nil, 0, fmt.Errorf("bid amount must be positive"))
	}

	e.mu.Lock()
	e.seq++
	e.bids[key] = append(e.bids[key], Bid{
		Bidder:       payload.Bidder,
		ContractAddr: payload.ContractAddr,
		Amount:       payload.AmountWei,
		Timestamp:    df.Timestamp,
		Seq:          e.seq,
	})
	e.mu.Unlock()

	// ActionResult.Data is public — acknowledge, reveal nothing.
	data, _ := json.Marshal(types.PlaceBidResponse{Accepted: true})
	return buildResult(action, df, data, 1, nil)
}

// processCloseAuction selects the winner and returns the ABI-encoded result
// that SealedAuction.settle() verifies on-chain. Idempotent: bids are retained,
// so re-issuing CLOSE_AUCTION (the recovery path) reproduces the same result.
func (e *Extension) processCloseAuction(action teetypes.Action, df *instruction.DataFixed) teetypes.ActionResult {
	if len(df.OriginalMessage) == 0 {
		return buildResult(action, df, nil, 0, fmt.Errorf("originalMessage is empty"))
	}

	req, err := structs.Decode[types.CloseMessage](types.CloseMessageArg, df.OriginalMessage)
	if err != nil {
		return buildResult(action, df, nil, 0, fmt.Errorf("decoding close message: %v", err))
	}
	if req.AuctionId == nil {
		return buildResult(action, df, nil, 0, fmt.Errorf("auctionId missing"))
	}

	key := req.AuctionId.String()

	e.mu.Lock()
	e.closed[key] = true
	snapshot := make([]Bid, len(e.bids[key]))
	copy(snapshot, e.bids[key])
	e.mu.Unlock()

	// winner = address(0) when nothing qualifies → the contract cancels.
	winner, clearingPrice, _ := pickWinner(snapshot, req.ContractAddr, req.ReservePrice)

	encoded, err := types.AuctionResultArgs.Pack(
		req.ContractAddr,
		req.AuctionId,
		winner,
		clearingPrice,
	)
	if err != nil {
		return buildResult(action, df, nil, 0, fmt.Errorf("ABI encode auction result: %v", err))
	}

	return buildResult(action, df, encoded, 1, nil)
}
