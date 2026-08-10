"use client";

import { useEffect, useRef, useState } from "react";
import { isAddress } from "viem";

import { EXPLORER_ADDRESS_URL, USDT0_ADDRESS } from "@/lib/config";
import { shortenAddress } from "@/lib/format";
import {
  PAY_TOKEN_PRESETS,
  type PayTokenPresetId,
  useFxrpAddress,
  useTokenMeta,
} from "@/lib/tokens";

/**
 * Faucet-style pay-token selector. FXRP is the default and is resolved on
 * chain, so nobody has to paste a token address to run the demo.
 */
export function PayTokenPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (address: string) => void;
}) {
  const [preset, setPreset] = useState<PayTokenPresetId>("FXRP");
  const [custom, setCustom] = useState("");
  const { data: fxrpAddress, isLoading: fxrpLoading } = useFxrpAddress();
  const meta = useTokenMeta(value);

  // Keep the parent in sync without making onChange an effect dependency.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (preset === "FXRP") {
      if (fxrpAddress) onChangeRef.current(fxrpAddress);
    } else if (preset === "USDT0") {
      onChangeRef.current(USDT0_ADDRESS);
    } else {
      onChangeRef.current(custom.trim());
    }
  }, [preset, fxrpAddress, custom]);

  const active = PAY_TOKEN_PRESETS.find((p) => p.id === preset)!;
  const resolving = preset === "FXRP" && fxrpLoading;

  return (
    <div>
      <p className="mb-2 text-xs text-[var(--muted)]">Pay token</p>
      <div className="flex flex-wrap gap-2">
        {PAY_TOKEN_PRESETS.map((option) => (
          <button
            key={option.id}
            type="button"
            className={`btn ${preset === option.id ? "" : "btn-secondary"}`}
            onClick={() => setPreset(option.id)}
          >
            {option.label}
          </button>
        ))}
      </div>

      {preset === "CUSTOM" && (
        <input
          className="input mt-2"
          placeholder="ERC-20 token address (0x…)"
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
        />
      )}

      <p className="mt-2 text-xs text-[var(--muted)]">{active.hint}</p>

      <div className="mt-1 text-xs">
        {resolving ? (
          <span className="text-[var(--muted)]">Resolving FXRP…</span>
        ) : isAddress(value) ? (
          <span>
            <span className="font-semibold text-[var(--text)]">
              {meta.data?.symbol ?? "…"}
            </span>
            {meta.data && (
              <span className="text-[var(--muted)]">
                {" "}
                · {meta.data.decimals} decimals
              </span>
            )}{" "}
            <a
              className="mono text-[var(--accent-soft)] hover:underline"
              href={`${EXPLORER_ADDRESS_URL}${value}`}
              target="_blank"
              rel="noreferrer"
            >
              {shortenAddress(value)}
            </a>
            {meta.isError && (
              <span className="text-[var(--red)]"> · not an ERC-20?</span>
            )}
          </span>
        ) : (
          <span className="text-[var(--muted)]">No token selected</span>
        )}
      </div>
    </div>
  );
}
