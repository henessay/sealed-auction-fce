"use client";

/**
 * Shared card chrome. The rule these enforce: one bright button per card at
 * most, everything explanatory lives in a tooltip, not in a paragraph.
 */

/** Hoverable "why" marker — replaces the sentences that used to sit under buttons. */
export function InfoDot({ title }: { title: string }) {
  return (
    <span
      className="ml-1 cursor-help select-none text-[var(--muted)]"
      title={title}
      aria-label={title}
      role="img"
    >
      ⓘ
    </span>
  );
}

/** "You are the seller" / "You bid here" / "You won" — role at a glance. */
export function RoleBadge({ role }: { role: string | null }) {
  if (!role) return null;
  return (
    <span
      className="badge"
      style={{
        background: "color-mix(in srgb, var(--accent) 18%, transparent)",
        color: "var(--accent-soft)",
      }}
    >
      {role}
    </span>
  );
}

/** One sentence: what happens next and who is expected to act. */
export function StateLine({
  text,
  tone = "normal",
  info,
}: {
  text: string;
  tone?: "normal" | "muted" | "waiting";
  info?: string;
}) {
  const color =
    tone === "waiting"
      ? "var(--amber)"
      : tone === "muted"
        ? "var(--muted)"
        : "var(--text)";
  return (
    <p className="mt-2 text-sm" style={{ color }}>
      {text}
      {info && <InfoDot title={info} />}
    </p>
  );
}

export type ActionVariant = "primary" | "secondary";

/** A single action. No hint paragraph — the reason lives in the tooltip. */
export function ActionButton({
  label,
  title,
  onClick,
  variant = "primary",
  busy,
  disabledReason,
  className = "",
}: {
  label: string;
  title: string;
  onClick?: () => void;
  variant?: ActionVariant;
  busy?: boolean;
  disabledReason?: string;
  className?: string;
}) {
  return (
    <button
      className={`btn ${variant === "secondary" ? "btn-secondary" : ""} ${className}`}
      onClick={onClick}
      disabled={!!disabledReason || !!busy}
      title={disabledReason ?? title}
    >
      {busy ? "Working…" : label}
    </button>
  );
}

/** Collapsed drawer for protocol-open actions that are not this wallet's job. */
export function AdvancedRow({ children }: { children: React.ReactNode }) {
  return (
    <details className="mt-3 text-xs">
      <summary className="cursor-pointer text-[var(--muted)]">advanced</summary>
      <div className="mt-2">{children}</div>
    </details>
  );
}
