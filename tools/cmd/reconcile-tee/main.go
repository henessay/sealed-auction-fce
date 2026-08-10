// reconcile-tee converges on-chain machine registration with the live TEE key.
//
// tee-node generates its machine key in memory on every boot and never writes
// it anywhere (crypto.GenerateKey in internal/node.Initialize) — a restarted
// container is a brand-new machine and no volume can change that. What CAN be
// converged is the registry: this tool checks the live key's status and, once
// it is PRODUCTION, pauses every other active machine we own on the extension,
// so instructions are never routed to a machine whose key died with an old
// container.
//
// Exit codes: 0 = converged (live key PRODUCTION, no stale active machines we
// own), 3 = live key not registered/promoted yet — run post-build.sh, then
// re-run this tool.
package main

import (
	"context"
	"flag"
	"os"

	"github.com/ethereum/go-ethereum/accounts/abi/bind"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/flare-foundation/go-flare-common/pkg/logger"

	"sealed-auction/tools/pkg/configs"
	"sealed-auction/tools/pkg/fccutils"
	"sealed-auction/tools/pkg/support"
)

const statusProduction = 2

func main() {
	af := flag.String("a", configs.AddressesFile, "file with deployed addresses")
	cf := flag.String("c", configs.ChainNodeURL, "chain node url")
	pf := flag.String("p", configs.ExtensionProxyURL, "extension proxy url (source of the live key)")
	flag.Parse()

	testSupport, err := support.DefaultSupport(*af, *cf)
	if err != nil {
		fccutils.FatalWithCause(err)
	}

	teeInfo, err := fccutils.TeeInfo(*pf)
	if err != nil {
		fccutils.FatalWithCause(err)
	}
	liveID, _, err := fccutils.TeeProxyId(teeInfo)
	if err != nil {
		fccutils.FatalWithCause(err)
	}
	extensionID := teeInfo.MachineData.ExtensionID.Big()
	deployer := crypto.PubkeyToAddress(testSupport.Prv.PublicKey)

	opts := &bind.CallOpts{Context: context.Background()}
	registry := testSupport.TeeMachineRegistry

	// An unregistered machine reverts on every getter, so a call error here
	// means "not registered", not a transport failure worth dying over.
	liveStatus, err := registry.GetTeeMachineStatus(opts, liveID)
	if err != nil || liveStatus != statusProduction {
		logger.Infof("Live TEE %s is not PRODUCTION on-chain (status err=%v) — registration needed", liveID.Hex(), err)
		logger.Infof("Run scripts/post-build.sh, then re-run reconcile-tee to pause stale machines")
		os.Exit(3)
	}
	logger.Infof("Live TEE %s is PRODUCTION for extension %s", liveID.Hex(), extensionID.String())

	active, err := registry.GetActiveTeeMachines(opts, extensionID)
	if err != nil {
		fccutils.FatalWithCause(err)
	}

	stale := 0
	for _, id := range active.TeeIds {
		if id == liveID {
			continue
		}
		owner, err := registry.GetTeeMachineOwner(opts, id)
		if err != nil {
			logger.Warnf("cannot read owner of active TEE %s: %v — leaving it alone", id.Hex(), err)
			continue
		}
		// Only touch our own machines; the extension registry is shared.
		if owner != deployer {
			logger.Infof("Active TEE %s is owned by %s, not us — leaving it alone", id.Hex(), owner.Hex())
			continue
		}
		stale++
		logger.Infof("Pausing stale TEE %s (its key died with an old container)", id.Hex())
		auth, err := bind.NewKeyedTransactorWithChainID(testSupport.Prv, testSupport.ChainID)
		if err != nil {
			fccutils.FatalWithCause(err)
		}
		tx, err := registry.Pause(auth, id)
		if err != nil {
			fccutils.FatalWithCause(err)
		}
		if _, err := support.CheckTx(tx, testSupport.ChainClient); err != nil {
			fccutils.FatalWithCause(err)
		}
		logger.Infof("Paused %s (tx %s)", id.Hex(), tx.Hash().Hex())
	}

	logger.Infof("Reconciled: live=%s PRODUCTION, stale machines paused this run: %d", liveID.Hex(), stale)
}
