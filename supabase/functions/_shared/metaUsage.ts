/**
 * Reads the usage percentage out of the two Meta usage headers.
 *
 * Both headers are read and the highest percentage wins. The parser walks
 * the whole document, so a nested business or use-case object is found
 * wherever it sits.
 */
export function parseMetaUsagePercent(headers: Headers): number {
  return Math.max(
    readUsageHeader(headers.get("x-app-usage")),
    readUsageHeader(headers.get("x-business-use-case-usage")),
  );
}

function readUsageHeader(raw: string | null): number {
  if (!raw) return 0;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // A header that is not JSON is not evidence of usage.
    return 0;
  }

  return collectUsagePercentages(parsed, 0);
}

function collectUsagePercentages(value: unknown, into: number): number {
  if (Array.isArray(value)) {
    let highest = into;
    for (const entry of value) {
      highest = collectUsagePercentages(entry, highest);
    }
    return highest;
  }

  if (typeof value !== "object" || value === null) return into;

  const record = value as Record<string, unknown>;
  let highest = into;

  for (const key of ["call_count", "total_time", "total_cputime"]) {
    const candidate = record[key];
    if (typeof candidate !== "number" || !Number.isFinite(candidate)) continue;
    highest = Math.max(highest, Math.min(100, Math.max(0, candidate)));
  }

  for (const nested of Object.values(record)) {
    if (nested !== null && typeof nested === "object") {
      highest = collectUsagePercentages(nested, highest);
    }
  }

  return highest;
}
