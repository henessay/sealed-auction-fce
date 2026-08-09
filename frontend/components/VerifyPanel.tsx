"use client";

import { useQuery } from "@tanstack/react-query";
import { hexToString, type Hex } from "viem";
import { useReadContract } from "wagmi";

import {
  flareTeeManagerAbi,
  MACHINE_STATUS_LABELS,
} from "@/lib/abi/sealedAuction";
import {
  EXPLORER_ADDRESS_URL,
  FLARE_TEE_MANAGER_ADDRESS,
  SEALED_AUCTION_ADDRESS,
} from "@/lib/config";
import { shortenHash } from "@/lib/format";
import { fetchTeeInfo, teeAddressFromPublicKey } from "@/lib/tee/proxy";

function decodePlatform(platform: Hex): string {
  try {
    return hexToString(platform, { size: 32 }).replace(/\0+$/, "");
  } catch {
    return platform;
  }
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1">
      <span className="shrink-0 text-xs text-[var(--muted)]">{label}</span>
      <span className="mono truncate text-xs">{children}</span>
    </div>
  );
}

export function VerifyPanel() {
  const {
    data: info,
    error,
    isLoading,
  } = useQuery({
    queryKey: ["tee-info"],
    queryFn: fetchTeeInfo,
    refetchInterval: 30_000,
  });

  const teeId = info ? teeAddressFromPublicKey(info.machineData.publicKey) : undefined;

  const { data: machineStatus } = useReadContract({
    address: FLARE_TEE_MANAGER_ADDRESS,
    abi: flareTeeManagerAbi,
    functionName: "getTeeMachineStatus",
    args: teeId ? [teeId] : undefined,
    query: { enabled: !!teeId, refetchInterval: 30_000 },
  });

  const statusLabel =
    machineStatus !== undefined
      ? (MACHINE_STATUS_LABELS[Number(machineStatus)] ?? `#${machineStatus}`)
      : undefined;

  return (
    <section className="panel p-4">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-semibold">TEE verification</h2>
        {statusLabel && (
          <span
            className="badge"
            style={{
              background:
                statusLabel === "PRODUCTION"
                  ? "color-mix(in srgb, var(--green) 15%, transparent)"
                  : "color-mix(in srgb, var(--amber) 15%, transparent)",
              color: statusLabel === "PRODUCTION" ? "var(--green)" : "var(--amber)",
            }}
          >
            {statusLabel}
          </span>
        )}
      </div>

      {isLoading && (
        <p className="text-xs text-[var(--muted)]">Fetching TEE /info…</p>
      )}
      {error && (
        <p className="text-xs text-[var(--red)]">
          {error instanceof Error ? error.message : "TEE info unavailable"}
        </p>
      )}

      {info && (
        <div className="divide-y divide-[var(--border)]">
          <Row label="Extension ID">
            {BigInt(info.machineData.extensionId).toString()}
          </Row>
          <Row label="TEE machine">{teeId}</Row>
          <Row label="Code hash">{shortenHash(info.machineData.codeHash)}</Row>
          <Row label="Platform">
            {decodePlatform(info.machineData.platform)}
            {info.attestation === "magic_pass" ? " (simulated)" : ""}
          </Row>
          <Row label="Owner">{shortenHash(info.machineData.initialOwner)}</Row>
          <Row label="Contract">
            <a
              className="text-[var(--accent-soft)] hover:underline"
              href={`${EXPLORER_ADDRESS_URL}${SEALED_AUCTION_ADDRESS}`}
              target="_blank"
              rel="noreferrer"
            >
              {shortenHash(SEALED_AUCTION_ADDRESS)} ↗
            </a>
          </Row>
          <Row label="TeeManager">
            <a
              className="text-[var(--accent-soft)] hover:underline"
              href={`${EXPLORER_ADDRESS_URL}${FLARE_TEE_MANAGER_ADDRESS}`}
              target="_blank"
              rel="noreferrer"
            >
              {shortenHash(FLARE_TEE_MANAGER_ADDRESS)} ↗
            </a>
          </Row>
        </div>
      )}
    </section>
  );
}
