package extension

import (
	"math/big"

	"github.com/ethereum/go-ethereum/common"
)

// Bid is one sealed bid held in TEE memory. Plaintext amounts never leave this
// process except as the winner's clearing price in the CLOSE_AUCTION result.
type Bid struct {
	Bidder       common.Address
	ContractAddr common.Address // from the decrypted payload; cross-checked at close
	Amount       *big.Int
	Timestamp    uint64 // DataFixed.Timestamp of the PLACE_BID instruction
	Seq          uint64 // arrival order within this process, tie-break of last resort
}

// pickWinner selects the winning bid: highest amount wins and pays its own bid
// (first-price). Bids below the reserve (or for a different contract) are
// excluded. Tie-break: earlier instruction timestamp, then earlier arrival.
// ok is false when no bid qualifies — the caller reports winner = address(0).
func pickWinner(bids []Bid, contractAddr common.Address, reserve *big.Int) (winner common.Address, clearingPrice *big.Int, ok bool) {
	if reserve == nil {
		reserve = big.NewInt(0)
	}
	var best *Bid
	for i := range bids {
		b := &bids[i]
		if b.ContractAddr != contractAddr {
			continue
		}
		if b.Amount == nil || b.Amount.Sign() <= 0 || b.Amount.Cmp(reserve) < 0 {
			continue
		}
		if best == nil || better(b, best) {
			best = b
		}
	}
	if best == nil {
		return common.Address{}, big.NewInt(0), false
	}
	return best.Bidder, new(big.Int).Set(best.Amount), true
}

// better reports whether a beats b under (amount desc, timestamp asc, seq asc).
func better(a, b *Bid) bool {
	switch a.Amount.Cmp(b.Amount) {
	case 1:
		return true
	case -1:
		return false
	}
	if a.Timestamp != b.Timestamp {
		return a.Timestamp < b.Timestamp
	}
	return a.Seq < b.Seq
}
