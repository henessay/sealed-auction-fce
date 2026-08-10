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
import { friendlyError } from "@/lib/errors";
import { fetchTeeInfo, teeAddressFromPublicKey } from "@/lib/tee/proxy";
import { ErrorNote } from "./ErrorNote";

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
    refetchInterval: 60_000,
  });

  const teeId = info ? teeAddressFromPublicKey(info.machineData.publicKey) : undefined;

  const { data: machineStatus, error: statusError } = useReadContract({
    address: FLARE_TEE_MANAGER_ADDRESS,
    abi: flareTeeManagerAbi,
    functionName: "getTeeMachineStatus",
    args: teeId ? [teeId] : undefined,
    query: { enabled: !!teeId, refetchInterval: 60_000, retry: false },
  });

  // The lookup reverts for an unknown teeId — that is the signature of a
  // restarted container whose fresh key was never registered on-chain.
  const unregistered = !!teeId && !!statusError;
  const statusLabel = unregistered
    ? "UNREGISTERED"
    : machineStatus !== undefined
      ? (MACHINE_STATUS_LABELS[Number(machineStatus)] ?? `#${machineStatus}`)
      : undefined;
  const healthy = statusLabel === "PRODUCTION";

  return (
    <section className="panel p-4" id="verify">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-semibold">TEE verification</h2>
        {statusLabel && (
          <span
            className="badge"
            style={{
              background: `color-mix(in srgb, ${
                healthy ? "var(--green)" : unregistered ? "var(--red)" : "var(--amber)"
              } 15%, transparent)`,
              color: healthy
                ? "var(--green)"
                : unregistered
                  ? "var(--red)"
                  : "var(--amber)",
            }}
          >
            {statusLabel}
          </span>
        )}
      </div>

      {unregistered && (
        <p className="mb-2 text-xs text-[var(--red)]">
          The live TEE key is not a registered machine — instructions will never
          be answered. Re-run <span className="mono">post-build.sh</span> and
          pause the stale machine(s).
        </p>
      )}

      {isLoading && (
        <p className="text-xs text-[var(--muted)]">Fetching TEE /info…</p>
      )}
      <ErrorNote
        error={
          error ? friendlyError(error, "The TEE proxy did not answer.") : null
        }
        className="mt-0"
      />

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
