"use client";

import { useAccount, useConnect, useDisconnect, useSwitchChain } from "wagmi";
import { flareTestnet } from "viem/chains";

import { shortenAddress } from "@/lib/format";

export function ConnectButton() {
  const { address, isConnected, chain } = useAccount();
  const { connect, connectors, isPending: isConnecting } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain, isPending: isSwitching } = useSwitchChain();

  const wrongNetwork = isConnected && chain?.id !== flareTestnet.id;
  const injected = connectors[0];

  if (!isConnected) {
    return (
      <button
        className="btn"
        disabled={isConnecting}
        onClick={() =>
          injected && connect({ connector: injected, chainId: flareTestnet.id })
        }
      >
        {isConnecting ? "Connecting…" : "Connect wallet"}
      </button>
    );
  }

  if (wrongNetwork) {
    return (
      <button
        className="btn"
        disabled={isSwitching}
        onClick={() => switchChain({ chainId: flareTestnet.id })}
      >
        {isSwitching ? "Switching…" : "Switch to Coston2"}
      </button>
    );
  }

  return (
    <div className="flex items-center gap-3">
      <span className="mono text-sm text-[var(--muted)]">
        {address ? shortenAddress(address) : null}
      </span>
      <button className="btn btn-secondary" onClick={() => disconnect()}>
        Disconnect
      </button>
    </div>
  );
}
