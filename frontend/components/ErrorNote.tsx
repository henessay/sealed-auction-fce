"use client";

import type { FriendlyError } from "@/lib/errors";

/**
 * One human sentence, with the provider/contract dump tucked behind a toggle.
 * Nothing in the UI should print a raw error without going through this.
 */
export function ErrorNote({
  error,
  className = "",
}: {
  error: FriendlyError | null;
  className?: string;
}) {
  if (!error) return null;
  const color = error.transient ? "var(--amber)" : "var(--red)";
  return (
    <div className={`mt-2 text-xs ${className}`}>
      <p style={{ color }}>{error.message}</p>
      {error.details && error.details !== error.message && (
        <details className="mt-1">
          <summary className="cursor-pointer text-[var(--muted)]">
            Details
          </summary>
          <pre className="mono mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all text-[var(--muted)]">
            {error.details}
          </pre>
        </details>
      )}
    </div>
  );
}
