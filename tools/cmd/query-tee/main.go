package main

import (
	"context"
	"flag"
	"fmt"
	"math/big"
	"os"

	"github.com/ethereum/go-ethereum/accounts/abi/bind"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/ethclient"
	"github.com/flare-foundation/go-flare-common/pkg/contracts/tee/machinemanager"
)

func main() {
	rpc := flag.String("rpc", "https://coston2-api.flare.network/ext/C/rpc", "rpc url")
	// Default is the Coston2 FlareTeeManager diamond (config/coston2/
	// deployed-addresses.json) — machine calls route through its facet. The old
	// standalone registry default answered but held nothing for our extension.
	reg := flag.String("reg", "0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE", "FlareTeeManager (diamond) address")
	listExt := flag.Int64("ext", -1, "list active TEEs in extension id (e.g. 0 for FTDC, 1588 for user)")
	flag.Parse()

	cc, err := ethclient.Dial(*rpc)
	if err != nil {
		fmt.Fprintf(os.Stderr, "dial: %v\n", err)
		os.Exit(1)
	}
	mm, err := machinemanager.NewMachineManager(common.HexToAddress(*reg), cc)
	if err != nil {
		fmt.Fprintf(os.Stderr, "bind: %v\n", err)
		os.Exit(1)
	}

	opts := &bind.CallOpts{Context: context.Background()}

	if *listExt >= 0 {
		ext := big.NewInt(*listExt)
		fmt.Printf("\n=== Active TEEs for extensionId=%s ===\n", ext.String())
		out, err := mm.GetActiveTeeMachines(opts, ext)
		if err != nil {
			fmt.Printf("getActiveTeeMachines ERROR: %v\n", err)
		} else {
			for i, id := range out.TeeIds {
				fmt.Printf("  %d: %s url=%q\n", i, id.Hex(), out.Urls[i])
			}
			if len(out.TeeIds) == 0 {
				fmt.Println("  (none)")
			}
		}
	}

	for _, raw := range flag.Args() {
		id := common.HexToAddress(raw)
		fmt.Printf("\n=== TEE %s ===\n", id.Hex())

		m, err := mm.GetTeeMachine(opts, id)
		if err != nil {
			fmt.Printf("  getTeeMachine ERROR: %v\n", err)
		} else {
			fmt.Printf("  getTeeMachine: teeId=%s teeProxyId=%s url=%q\n", m.TeeId.Hex(), m.TeeProxyId.Hex(), m.Url)
			if m.TeeId == (common.Address{}) {
				fmt.Println("  -> EMPTY/UNREGISTERED")
			}
		}

		st, err := mm.GetTeeMachineStatus(opts, id)
		if err != nil {
			fmt.Printf("  getTeeMachineStatus ERROR: %v\n", err)
		} else {
			fmt.Printf("  getTeeMachineStatus: %d\n", st)
		}

		owner, err := mm.GetTeeMachineOwner(opts, id)
		if err != nil {
			fmt.Printf("  getTeeMachineOwner ERROR: %v\n", err)
		} else {
			fmt.Printf("  getTeeMachineOwner: %s\n", owner.Hex())
		}

		extID, err := mm.GetExtensionId(opts, id)
		if err != nil {
			fmt.Printf("  getExtensionId ERROR: %v\n", err)
		} else {
			fmt.Printf("  getExtensionId: %s\n", extID.String())
		}

		ts, err := mm.GetLastStatusChangeTs(opts, id)
		if err != nil {
			fmt.Printf("  getLastStatusChangeTs ERROR: %v\n", err)
		} else {
			fmt.Printf("  getLastStatusChangeTs: %s\n", ts.String())
		}

		spid, err := mm.GetInitialSigningPolicyId(opts, id)
		if err != nil {
			fmt.Printf("  getInitialSigningPolicyId ERROR: %v\n", err)
		} else {
			fmt.Printf("  getInitialSigningPolicyId: %d\n", spid)
		}
	}
}
