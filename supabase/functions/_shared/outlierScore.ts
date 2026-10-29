/**
 * Canonical outlier scoring for Instagram insights and competitor tracking.
 *
 * This is the single implementation of the R3 contract (source spec
 * `docs/specs/2026-10-26-instagram-insights-and-competitor-tracking.md` §6
 * Phase 3, decisions D11–D14). It is deliberately runtime-neutral: no Deno
 * APIs, no Supabase client, no Node built-ins, no React, no `fetch`, no
 * locale-dependent date parsing. Only an unambiguous ISO-8601 instant is
 * accepted. The browser never imports it — the frontend
 * consumes the scores returned by the backend report reader, so the algorithm
 * cannot drift into a second implementation (ARCHITECTURE §22 canonical
 * contract rule, §4 dependency direction, plan §5.4).
 *
 * ## Caller preconditions
 *
 * `computeOutlierScores` scores ONE cohort per call. The caller groups before
 * it calls — one social account, one source (`graph_own` / official / `apify`)
 * and one metric basis (views, reach, interactions) per call:
 *
 * - Mixing cohorts inside one call silently blends incompatible units into a
 *   single median (plan §5.4: owner non-reels must not mix reach and
 *   interaction values; owner and competitor ratios are never comparable).
 * - The caller must select the latest snapshot per media before building
 *   `OutlierInput` rows, and must resolve the metric value per source
 *   (spec R3.2) before building them.
 *
 * The function itself separates `reel` from `non_reel`: the two formats never
 * share a baseline (D12).
 *
 * ## Baseline
 *
 * The baseline of an item is the most recent `baselineSize` (default 12)
 * same-format items that are strictly earlier in publication time, mature at
 * `now` (at least `minAgeHours`, default 48, old), and carry a usable value.
 * The median of that baseline is the divisor; `score = value / median`.
 *
 * - "Strictly earlier" means an equal publication instant is NOT an older
 *   candidate: an item never baselines against itself and siblings published
 *   at the same instant (D11).
 * - Candidates are ordered newest first with the item id as the tie-breaker,
 *   so the same cohort always produces the same baseline regardless of the
 *   order the caller happened to read the rows in.
 * - Unavailable (`null`), negative and non-finite values are excluded and do
 *   not consume the baseline budget. A median is therefore always computed
 *   over real measurements.
 *
 * ## Result semantics
 *
 * - `score` is `null` whenever no ratio could be produced. It is never
 *   `NaN` and never `Infinity` (plan §5.4, D14).
 * - `baselineSize` / `baselineMedian` describe the baseline that was actually
 *   used. They are `0` / `null` when no baseline was computed at all (the
 *   item's own value or publication was unusable, or the item is too young),
 *   and truthful — never zeroed to hide a problem — for `small_baseline` and
 *   for the zero-median case.
 *
 * ## Errors
 *
 * Invalid options are rejected with a `RangeError`. A malformed `now` is
 * rejected with a `TypeError` (not a `Date`) or a `RangeError` (an invalid
 * `Date`). A structurally broken input row (non-string id, unknown format,
 * `items` not an array) is rejected with a `TypeError`. Bad *data* inside an
 * otherwise well-formed row — an unusable value or an unparsable publication
 * instant — is never thrown: it is reported as `no_data`.
 */

export type OutlierFormat = "reel" | "non_reel";

export type OutlierInput = {
  id: string;
  format: OutlierFormat;
  publishedAt: string;
  value: number | null;
};

export type OutlierLabel =
  | "outlier"
  | "above"
  | "normal"
  | "below"
  | "too_early"
  | "no_data"
  | "small_baseline";

export type OutlierResult = {
  id: string;
  score: number | null;
  label: OutlierLabel;
  baselineMedian: number | null;
  baselineSize: number;
};

export type OutlierOptions = {
  /** Number of same-format historical items used for the median. Default 12. */
  baselineSize?: number;
  /** Minimum number of historical items required to score at all. Default 6. */
  minBaseline?: number;
  /** Minimum age of a scored item and of a baseline candidate, in hours. Default 48. */
  minAgeHours?: number;
};

const DEFAULT_BASELINE_SIZE = 12;
const DEFAULT_MIN_BASELINE = 6;
const DEFAULT_MIN_AGE_HOURS = 48;
const MS_PER_HOUR = 3_600_000;

/** Label thresholds, inclusive at the boundary (D14). */
const OUTLIER_SCORE = 3;
const ABOVE_SCORE = 1.5;
const BELOW_SCORE = 0.5;

const KNOWN_OPTION_KEYS: readonly string[] = ["baselineSize", "minBaseline", "minAgeHours"];

const MONTH_LENGTHS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/**
 * ISO-8601 calendar date with an optional time and an optional numeric zone
 * or `Z`. A zone-less instant is read as UTC. Strings that do not match,
 * including prose and slash dates, are rejected rather than parsed.
 */
const ISO_INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})(?:[Tt ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?\s*(?:([Zz])|([+-])(\d{2})(?::?(\d{2}))?)?$/;

type ResolvedOptions = {
  baselineSize: number;
  minBaseline: number;
  minAgeMs: number;
};

type PreparedItem = {
  id: string;
  format: OutlierFormat;
  /** Publication instant in epoch milliseconds, or null when unparsable. */
  publishedMs: number | null;
  /** The usable measurement, or null when unavailable or invalid. */
  value: number | null;
};

type Candidate = {
  id: string;
  publishedMs: number;
  value: number;
};

/**
 * Score every item against the baseline of its own format.
 *
 * @param items One cohort: same account, source and metric basis. Reels and
 *   non-reels may be mixed; they are separated here.
 * @param now The instant the cohort is evaluated at. It is injected so the
 *   result is reproducible and testable; nothing in this module reads the
 *   clock itself.
 * @param opts Baseline size, minimum baseline and maturity window.
 * @returns One result per input item, in input order, carrying the item id.
 */
export function computeOutlierScores(
  items: OutlierInput[],
  now: Date,
  opts?: OutlierOptions,
): OutlierResult[] {
  const options = resolveOptions(opts);
  const nowMs = readNow(now);

  if (!Array.isArray(items)) {
    throw new TypeError("computeOutlierScores: items must be an array");
  }

  const prepared = items.map(prepareItem);
  const candidates = buildCandidatePools(prepared, nowMs, options);

  return prepared.map((item) =>
    scoreItem(item, candidates.get(item.format) ?? [], nowMs, options)
  );
}

function prepareItem(item: OutlierInput): PreparedItem {
  const row = item as unknown;
  if (!isRecord(row)) {
    throw new TypeError("computeOutlierScores: every item must be an object");
  }
  if (typeof row.id !== "string" || row.id.length === 0) {
    throw new TypeError("computeOutlierScores: every item needs a non-empty string id");
  }
  if (row.format !== "reel" && row.format !== "non_reel") {
    throw new TypeError(`computeOutlierScores: item "${row.id}" has an unsupported format`);
  }
  return {
    id: row.id,
    format: row.format,
    publishedMs: parsePublishedAt(row.publishedAt),
    value: usableValue(row.value),
  };
}

function scoreItem(
  item: PreparedItem,
  candidates: readonly Candidate[],
  nowMs: number,
  options: ResolvedOptions,
): OutlierResult {
  const publishedMs = item.publishedMs;
  const value = item.value;

  // An unusable measurement or an unparsable publication instant means the
  // item cannot be compared at all. This wins over every other label.
  if (publishedMs === null || value === null) {
    return { id: item.id, score: null, label: "no_data", baselineMedian: null, baselineSize: 0 };
  }

  // A future instant is younger than the maturity window, so it is reported
  // as too early rather than as a broken timestamp.
  if (nowMs - publishedMs < options.minAgeMs) {
    return { id: item.id, score: null, label: "too_early", baselineMedian: null, baselineSize: 0 };
  }

  const baseline = collectBaseline(item.id, publishedMs, candidates, options);
  baseline.sort((a, b) => a - b);
  const baselineSize = baseline.length;

  if (baselineSize < options.minBaseline) {
    // The baseline is too small to carry a comparison. Its real size and
    // median are still reported so the caller can show how far off it is.
    const smallMedian = baselineSize === 0 ? null : medianOf(baseline);
    return { id: item.id, score: null, label: "small_baseline", baselineMedian: smallMedian, baselineSize };
  }

  // At least `minBaseline` (>= 1) values, so the median exists.
  const baselineMedian = medianOf(baseline);

  // A zero median has no meaningful divisor. Infinity and NaN are not
  // answers, so the item is reported as having no data instead.
  if (baselineMedian === 0) {
    return { id: item.id, score: null, label: "no_data", baselineMedian: 0, baselineSize };
  }

  const score = ratioOf(value, baselineMedian);
  return {
    id: item.id,
    score,
    label: labelFor(score),
    baselineMedian,
    baselineSize,
  };
}

/**
 * The `baselineSize` most recent usable items that are strictly earlier than
 * the scored item.
 *
 * The candidate pool is ordered newest first, so walking it and taking the
 * first `baselineSize` eligible entries yields the most recent older items.
 * Unusable rows were already removed from the pool, so they never consume
 * the baseline budget.
 */
function collectBaseline(
  itemId: string,
  publishedMs: number,
  candidates: readonly Candidate[],
  options: ResolvedOptions,
): number[] {
  const values: number[] = [];
  for (const candidate of candidates) {
    // Not strictly earlier: the item itself and every sibling published at
    // the same instant are excluded.
    if (candidate.publishedMs >= publishedMs) continue;
    // Never the scored item itself, nor a second row for the same media.
    if (candidate.id === itemId) continue;
    values.push(candidate.value);
    if (values.length === options.baselineSize) break;
  }
  return values;
}

/**
 * Pool of items that may serve as baseline candidates, grouped by format and
 * ordered newest first with the id as the tie-breaker.
 *
 * Immature and future items are left out here. Because maturity is measured
 * from the same `now` as the scored item, an item that is strictly older than
 * a mature scored item is mature itself — the pool filter is what keeps
 * future items out of the history.
 */
function buildCandidatePools(
  prepared: readonly PreparedItem[],
  nowMs: number,
  options: ResolvedOptions,
): Map<OutlierFormat, Candidate[]> {
  const pools = new Map<OutlierFormat, Candidate[]>();
  for (const item of prepared) {
    if (item.publishedMs === null || item.value === null) continue;
    if (nowMs - item.publishedMs < options.minAgeMs) continue;
    const candidate: Candidate = {
      id: item.id,
      publishedMs: item.publishedMs,
      value: item.value,
    };
    const pool = pools.get(item.format);
    if (pool) pool.push(candidate);
    else pools.set(item.format, [candidate]);
  }
  for (const pool of pools.values()) {
    pool.sort((a, b) => {
      if (a.publishedMs !== b.publishedMs) return b.publishedMs - a.publishedMs;
      if (a.id === b.id) return 0;
      return a.id < b.id ? -1 : 1;
    });
  }
  return pools;
}

/** Median of a non-empty ascending list. Even counts take the midpoint. */
function medianOf(sorted: readonly number[]): number {
  const count = sorted.length;
  const mid = count >> 1;
  if (count % 2 === 1) return sorted[mid];
  const lower = sorted[mid - 1];
  const upper = sorted[mid];
  // The midpoint is computed without the intermediate sum: `(lower + upper)`
  // overflows to Infinity for values close to Number.MAX_VALUE.
  return lower + (upper - lower) / 2;
}

/**
 * `value / median`, always finite.
 *
 * The quotient overflows to Infinity when the median is denormal. Saturating
 * keeps the score finite and the classification honest: a quotient that
 * overflows is by definition far above the baseline.
 */
function ratioOf(value: number, median: number): number {
  const score = value / median;
  return Number.isFinite(score) ? score : Number.MAX_VALUE;
}

function labelFor(score: number): OutlierLabel {
  if (score >= OUTLIER_SCORE) return "outlier";
  if (score >= ABOVE_SCORE) return "above";
  if (score <= BELOW_SCORE) return "below";
  return "normal";
}

/** A usable measurement: a finite, non-negative number. Zero is a measurement. */
function usableValue(value: unknown): number | null {
  if (typeof value !== "number") return null;
  if (!Number.isFinite(value)) return null;
  if (value < 0) return null;
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  return month === 2 && isLeapYear(year) ? 29 : MONTH_LENGTHS[month - 1];
}

/**
 * Publication instant in epoch milliseconds, or null when the string is not a
 * supported instant.
 *
 * Only the ISO-8601 form above is accepted, and it is parsed with UTC
 * calendar fields so the result does not depend on the host timezone. A
 * zone-less instant is UTC. `Z` and numeric offsets, including a provider
 * `+0000`, are applied explicitly. Impossible calendar dates are rejected.
 * Anything else is null: `Date.parse` is not used, because prose and slash
 * dates are locale- and host-timezone-dependent and would move the 48-hour
 * maturity boundary between runtimes.
 */
function parsePublishedAt(raw: unknown): number | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;

  const match = ISO_INSTANT.exec(trimmed);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > daysInMonth(year, month)) return null;

  const hour = match[4] === undefined ? 0 : Number(match[4]);
  const minute = match[5] === undefined ? 0 : Number(match[5]);
  const second = match[6] === undefined ? 0 : Number(match[6]);
  const millisecond = match[7] === undefined ? 0 : Number(match[7].slice(0, 3).padEnd(3, "0"));
  if (hour > 23 || minute > 59 || second > 59) return null;

  const date = new Date(0);
  // setUTCFullYear avoids the two-digit-year remapping of Date.UTC.
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, millisecond);
  let epoch = date.getTime();

  if (match[8] === undefined && match[9] === undefined) {
    // No zone designator: read as UTC so the result is host independent.
  } else if (match[8] !== undefined) {
    // "Z" — already UTC.
  } else {
    const sign = match[9] === "+" ? 1 : -1;
    const offsetHours = Number(match[10]);
    const offsetMinutes = match[11] === undefined ? 0 : Number(match[11]);
    if (offsetHours > 23 || offsetMinutes > 59) return null;
    epoch -= sign * (offsetHours * 60 + offsetMinutes) * 60_000;
  }

  return Number.isFinite(epoch) ? epoch : null;
}

function readNow(now: Date): number {
  if (!isDateLike(now)) {
    throw new TypeError("computeOutlierScores: now must be a Date");
  }
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) {
    throw new RangeError("computeOutlierScores: now must be a valid Date");
  }
  return nowMs;
}

function isDateLike(value: unknown): value is Date {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Date).getTime === "function"
  );
}

function resolveOptions(opts: OutlierOptions | undefined): ResolvedOptions {
  if (opts === undefined) {
    return {
      baselineSize: DEFAULT_BASELINE_SIZE,
      minBaseline: DEFAULT_MIN_BASELINE,
      minAgeMs: DEFAULT_MIN_AGE_HOURS * MS_PER_HOUR,
    };
  }

  const raw = opts as unknown;
  if (!isRecord(raw)) {
    throw new RangeError("computeOutlierScores: opts must be an object");
  }
  for (const key of Object.keys(raw)) {
    if (!KNOWN_OPTION_KEYS.includes(key)) {
      throw new RangeError(`computeOutlierScores: unknown option "${key}"`);
    }
  }

  const baselineSize = readPositiveIntegerOption("baselineSize", raw.baselineSize, DEFAULT_BASELINE_SIZE);
  const minBaseline = readPositiveIntegerOption("minBaseline", raw.minBaseline, DEFAULT_MIN_BASELINE);
  const minAgeHours = readNonNegativeNumberOption("minAgeHours", raw.minAgeHours, DEFAULT_MIN_AGE_HOURS);

  if (minBaseline > baselineSize) {
    throw new RangeError(
      `computeOutlierScores: minBaseline (${minBaseline}) cannot exceed baselineSize (${baselineSize})`,
    );
  }

  const minAgeMs = minAgeHours * MS_PER_HOUR;
  if (!Number.isFinite(minAgeMs)) {
    throw new RangeError("computeOutlierScores: minAgeHours is too large");
  }

  return { baselineSize, minBaseline, minAgeMs };
}

function readPositiveIntegerOption(name: string, value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new RangeError(`computeOutlierScores: ${name} must be a positive integer`);
  }
  return value;
}

function readNonNegativeNumberOption(name: string, value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new RangeError(
      `computeOutlierScores: ${name} must be a finite, non-negative number`,
    );
  }
  return value;
}
