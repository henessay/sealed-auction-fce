"use client";

import { useAccount, useConnect, useDisconnect, useSwitchChain } from "wagmi";
import { coston2 } from "@/lib/wagmi";

import { shortenAddress } from "@/lib/format";

export function ConnectButton() {
  const { address, isConnected, chain } = useAccount();
  const { connect, connectors, isPending: isConnecting } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain, isPending: isSwitching } = useSwitchChain();

  const wrongNetwork = isConnected && chain?.id !== coston2.id;
  const injected = connectors[0];

  if (!isConnected) {
    return (
      <button
        className="btn"
        disabled={isConnecting}
        onClick={() =>
          injected && connect({ connector: injected, chainId: coston2.id })
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
        onClick={() => switchChain({ chainId: coston2.id })}
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
