/** Quota bar arithmetic. Thresholds are the spec's: warning at 80%, critical at 95%. */
export type QuotaTone = "ok" | "warning" | "critical";

/** Whole percent used, capped at 100; null when the key has no quota. */
export function quotaPercent(used: number, limit: number | null): number | null {
  if (limit === null) return null;
  if (limit <= 0) return used > 0 ? 100 : 0;
  return Math.min(100, Math.round((used / limit) * 100));
}

export function quotaTone(percent: number | null): QuotaTone {
  if (percent === null) return "ok";
  if (percent >= 95) return "critical";
  if (percent >= 80) return "warning";
  return "ok";
}
