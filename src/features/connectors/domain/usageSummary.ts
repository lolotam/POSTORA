/**
 * The usage line shown under a connector (spec §9.1), computed from the rows
 * `workspace_connector_usage` returns. Pure: no I/O, no React.
 */
export interface UsageRow {
  tool_id: string;
  calls: number;
  failures: number;
  p50_latency_ms: number | null;
  last_used_at: string | null;
}

/** "142 calls · 30 d · p50 640 ms", or "No calls in 30 d". */
export function formatUsageLine(row: UsageRow | undefined, days: number): string {
  if (!row || row.calls <= 0) return `No calls in ${days} d`;
  const parts = [`${row.calls} ${row.calls === 1 ? "call" : "calls"}`, `${days} d`];
  if (row.p50_latency_ms !== null) parts.push(`p50 ${row.p50_latency_ms} ms`);
  return parts.join(" · ");
}

/**
 * Folds several per-tool rows into one line's worth of numbers — what a
 * connection card needs, since one connection can back several tools.
 * Counts add up; the median does not. A median of medians is not a median, so
 * it is reported only when a single row contributed and is null otherwise
 * rather than invented.
 */
export function aggregateUsage(rows: readonly UsageRow[]): UsageRow | undefined {
  if (rows.length === 0) return undefined;
  if (rows.length === 1) return rows[0];
  let calls = 0;
  let failures = 0;
  let lastUsedAt: string | null = null;
  for (const row of rows) {
    calls += row.calls;
    failures += row.failures;
    if (row.last_used_at && (lastUsedAt === null || row.last_used_at > lastUsedAt)) {
      lastUsedAt = row.last_used_at;
    }
  }
  return { tool_id: rows[0].tool_id, calls, failures, p50_latency_ms: null, last_used_at: lastUsedAt };
}

/** The usage rows belonging to one connector type — a connection card spans
 *  a type, not a tool. Pure, so it belongs here and not in the adapter. */
export function usageRowsForType<T extends UsageRow & { connector_type: string }>(
  rows: readonly T[] | undefined,
  connectorType: string,
): T[] {
  return (rows ?? []).filter((row) => row.connector_type === connectorType);
}
