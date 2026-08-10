// pause-tee pauses a registered TEE machine on the MachineManager facet.
//
// A restarted simulated-TEE container is a new machine with a fresh key; the
// old registration stays PRODUCTION on-chain even though its key is gone.
// Instructions routed to such a machine are never answered, so the stale
// registration must be paused as soon as its successor is promoted.
package main

import (
	"context"
	"flag"
	"fmt"
	"os"

	"github.com/ethereum/go-ethereum/accounts/abi/bind"
	"github.com/ethereum/go-ethereum/common"
	"github.com/flare-foundation/go-flare-common/pkg/logger"

	"sealed-auction/tools/pkg/configs"
	"sealed-auction/tools/pkg/fccutils"
	"sealed-auction/tools/pkg/support"
)

func main() {
	af := flag.String("a", configs.AddressesFile, "file with deployed addresses")
	cf := flag.String("c", configs.ChainNodeURL, "chain node url")
	flag.Parse()

	if flag.NArg() == 0 {
		fmt.Fprintln(os.Stderr, "usage: pause-tee [-a addresses] [-c rpc] <teeId> [<teeId>...]")
		os.Exit(2)
	}

	testSupport, err := support.DefaultSupport(*af, *cf)
	if err != nil {
		fccutils.FatalWithCause(err)
	}

	opts := &bind.CallOpts{Context: context.Background()}
	for _, raw := range flag.Args() {
		teeID := common.HexToAddress(raw)

		status, err := testSupport.TeeMachineRegistry.GetTeeMachineStatus(opts, teeID)
		if err != nil {
			fccutils.FatalWithCause(err)
		}
		// TeeStatus: pause() only accepts PRODUCTION or PAUSED machines
		// (OnlyProductionOrPausedStatus), and pausing PAUSED is a no-op.
		if status != 2 {
			logger.Infof("TEE %s has status %d, not PRODUCTION — skipping", teeID.Hex(), status)
			continue
		}

		auth, err := bind.NewKeyedTransactorWithChainID(testSupport.Prv, testSupport.ChainID)
		if err != nil {
			fccutils.FatalWithCause(err)
		}
		tx, err := testSupport.TeeMachineRegistry.Pause(auth, teeID)
		if err != nil {
			fccutils.FatalWithCause(err)
		}
		if _, err := support.CheckTx(tx, testSupport.ChainClient); err != nil {
			fccutils.FatalWithCause(err)
		}

		status, err = testSupport.TeeMachineRegistry.GetTeeMachineStatus(opts, teeID)
		if err != nil {
			fccutils.FatalWithCause(err)
		}
		logger.Infof("Paused TEE %s (tx %s, status now %d)", teeID.Hex(), tx.Hash().Hex(), status)
	}
}
