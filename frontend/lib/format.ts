export function shortenAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function shortenHash(hash: string): string {
  return `${hash.slice(0, 10)}…${hash.slice(-6)}`;
}

/** Human countdown like "4m 12s"; empty string once past. */
export function formatCountdown(deadlineSec: number, nowMs: number): string {
  const remaining = Math.floor(deadlineSec - nowMs / 1000);
  if (remaining <= 0) return "";
  const h = Math.floor(remaining / 3600);
  const m = Math.floor((remaining % 3600) / 60);
  const s = remaining % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export function formatDeadline(deadlineSec: number): string {
  return new Date(deadlineSec * 1000).toLocaleString("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
  });
}
