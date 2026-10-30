/**
 * The growth projection of the competitor tracking report.
 *
 * WHAT THIS MODULE OWNS
 *
 *   * The validation of the RAW growth projection the SQL reader returned.
 *   * The mapping of that projection onto the public §5 growth object.
 *   * The BASELINE POLICY - the approved maximum staleness of a follower
 *     baseline - and the assertion that the SQL window agrees with it.
 *
 * THE POLICY LIVES HERE, ON THE SERVER
 *
 *   Spec §11 (resolved 2026-10-30): S = 3 days = 259200 seconds. The
 *   baseline B of a D-day comparison must satisfy
 *
 *       cutoff - S <= B.captured_at <= cutoff
 *
 *   `maxStalenessSeconds` is a SERVER constant. It is never read from the
 *   request, never read from the browser, and never taken from the payload.
 *   A client that asks for a wider tolerance is asking for a number it is
 *   not allowed to choose.
 *
 *   The SQL reader selects the baseline directly by the same indexed cutoff,
 *   with the same three-day window. This module ASSERTS that agreement: the
 *   baseline the database returned is checked against the server's own
 *   window, and a baseline outside it is reported as `stale_baseline` rather
 *   than silently used. That is what makes the policy a server decision and
 *   not a restatement of whatever the database happened to do.
 *
 * THE REASON VOCABULARY
 *
 *   The SQL reader names the cases with its own words; §5 names them for the
 *   public DTO. The translation happens HERE, once:
 *
 *     SQL `no_comparable_baseline`  ->  DTO `missing_baseline`
 *
 *   Two reasons exist only on this side of the boundary:
 *
 *     `baseline_policy_unset`  the server has no approved staleness policy,
 *                              so no comparison may be published at all.
 *     `stale_baseline`         the database returned a baseline that lies
 *                              outside the approved staleness window.
 *
 * NULL IS UNAVAILABLE, NEVER ZERO
 *
 *   A refused comparison produces null outputs and an explicit reason. It
 *   never produces 0, 0% or Infinity.
 */

import {
  CompetitorReportContractError,
  isRecord,
  parseInstant,
  readCount,
  readFiniteNumber,
  readOptionalInstant,
  type CompetitorReportGrowth,
  type CompetitorReportGrowthReason,
  type CompetitorReportPeriodDays,
  type RawGrowth,
} from "./contracts.ts";

/* -------------------------------------------------------------------------- */
/* The baseline policy                                                           */
/* -------------------------------------------------------------------------- */

/**
 * The approved maximum staleness of a follower baseline, in seconds.
 *
 * Spec §11 (resolved 2026-10-30): S = 3 days. The SQL reader uses the same
 * window; `assertBaselineWindow` below checks that the two agree.
 */
export const COMPETITOR_REPORT_MAX_STALENESS_SECONDS = 259_200;

/** The policy the server applies when a comparison is published. */
export const COMPETITOR_REPORT_BASELINE_POLICY = {
  maxStalenessSeconds: COMPETITOR_REPORT_MAX_STALENESS_SECONDS,
} as const;

/** The seconds of one day. */
const SECONDS_PER_DAY = 86_400;

/**
 * The policy shape.
 *
 * `null` means "no approved policy", and that is NOT the same as a policy
 * with a zero tolerance: an unconfigured policy publishes no comparison at
 * all, with the reason `baseline_policy_unset`.
 */
export type BaselinePolicy = {
  readonly maxStalenessSeconds: number;
};

/**
 * Validates a policy.
 *
 * A negative, non-integer or non-finite tolerance is a configuration
 * mistake, and it is refused rather than clamped: a clamped tolerance would
 * silently publish a comparison under a policy nobody approved.
 */
export function assertBaselinePolicy(policy: BaselinePolicy | null): BaselinePolicy | null {
  if (policy === null) return null;
  if (!isRecord(policy)) {
    throw new CompetitorReportContractError(
      "REPORT_UNAVAILABLE",
      "the baseline policy must be an object",
    );
  }
  const seconds = policy.maxStalenessSeconds;
  if (
    typeof seconds !== "number" ||
    !Number.isFinite(seconds) ||
    !Number.isInteger(seconds) ||
    seconds < 0
  ) {
    throw new CompetitorReportContractError(
      "REPORT_UNAVAILABLE",
      "the baseline policy must carry a non-negative whole number of seconds",
    );
  }
  return { maxStalenessSeconds: seconds };
}

/* -------------------------------------------------------------------------- */
/* The SQL reason vocabulary                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The reasons the SQL reader itself produces.
 *
 * They are a closed set. An unknown reason is a broken payload and the read
 * fails closed - it is never passed through as a free-form string.
 */
const SQL_GROWTH_REASONS = [
  "first_observation",
  "no_comparable_baseline",
  "source_changed",
  "unavailable_metric",
  "zero_baseline",
] as const;

type SqlGrowthReason = (typeof SQL_GROWTH_REASONS)[number];

/** The translation onto the public vocabulary of §5. */
const PUBLIC_REASON_BY_SQL_REASON: Record<SqlGrowthReason, CompetitorReportGrowthReason> = {
  first_observation: "first_observation",
  no_comparable_baseline: "missing_baseline",
  source_changed: "source_changed",
  unavailable_metric: "unavailable_metric",
  zero_baseline: "zero_baseline",
};

/* -------------------------------------------------------------------------- */
/* The mapping                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Reads the raw growth payload of one period and maps it onto the public
 * growth object.
 *
 * @param raw The raw growth object of the SQL projection.
 * @param periodDays The period this object must describe (7 or 30).
 * @param policy The approved baseline policy, or null when none is
 *   configured.
 * @throws CompetitorReportContractError when the payload is malformed.
 */
export function mapGrowth(
  raw: unknown,
  periodDays: CompetitorReportPeriodDays,
  policy: BaselinePolicy | null,
): CompetitorReportGrowth {
  const context = `growth.${periodDays}`;
  if (!isRecord(raw)) {
    throw new CompetitorReportContractError(
      "REPORT_UNAVAILABLE",
      `${context} must be an object`,
    );
  }

  const payload = readRawGrowth(raw, context);

  if (payload.period_days !== null && payload.period_days !== periodDays) {
    throw new CompetitorReportContractError(
      "REPORT_UNAVAILABLE",
      `${context}.period_days does not describe the requested period`,
    );
  }

  const sqlReason = readSqlReason(payload.reason, context);
  const publicReason = sqlReason === null ? null : PUBLIC_REASON_BY_SQL_REASON[sqlReason];

  // A refused comparison carries no numbers, and a comparable one carries
  // both. A payload that says otherwise is inconsistent and is refused.
  if (publicReason !== null) {
    if (payload.absolute !== null || payload.percent !== null) {
      throw new CompetitorReportContractError(
        "REPORT_UNAVAILABLE",
        `${context} carries numbers for a refused comparison`,
      );
    }
  } else {
    if (payload.absolute === null || payload.percent === null) {
      throw new CompetitorReportContractError(
        "REPORT_UNAVAILABLE",
        `${context} is comparable but carries no numbers`,
      );
    }
    if (payload.baseline_at === null || payload.observed_at === null) {
      throw new CompetitorReportContractError(
        "REPORT_UNAVAILABLE",
        `${context} is comparable but carries no endpoints`,
      );
    }
  }

  const growth: CompetitorReportGrowth = {
    absolute: payload.absolute,
    percent: payload.percent,
    baseline_at: payload.baseline_at,
    observed_at: payload.observed_at,
    interval_days: payload.interval_days,
    reason: publicReason,
  };

  if (publicReason !== null) return growth;

  // A comparable comparison is still subject to the SERVER's policy. The
  // database's window is checked against the approved staleness here.
  return applyBaselinePolicy(growth, periodDays, policy, context);
}

/**
 * Applies the server's baseline policy to a comparable comparison.
 *
 * Without a policy nothing is published. A baseline outside the approved
 * staleness window is published as `stale_baseline`. A baseline that lies
 * AFTER the cutoff is not a baseline at all and is published as
 * `missing_baseline`.
 */
function applyBaselinePolicy(
  growth: CompetitorReportGrowth,
  periodDays: CompetitorReportPeriodDays,
  policy: BaselinePolicy | null,
  context: string,
): CompetitorReportGrowth {
  if (policy === null) {
    return {
      ...growth,
      absolute: null,
      percent: null,
      reason: "baseline_policy_unset",
    };
  }

  const observedMs = parseInstant(growth.observed_at, "observed_at", context);
  const baselineMs = parseInstant(growth.baseline_at, "baseline_at", context);
  const cutoffMs = observedMs - periodDays * SECONDS_PER_DAY * 1000;
  const stalenessSeconds = (cutoffMs - baselineMs) / 1000;

  if (stalenessSeconds < 0) {
    // The baseline is newer than the cutoff: it is not a baseline.
    return {
      ...growth,
      absolute: null,
      percent: null,
      reason: "missing_baseline",
    };
  }

  if (stalenessSeconds > policy.maxStalenessSeconds) {
    return {
      ...growth,
      absolute: null,
      percent: null,
      reason: "stale_baseline",
    };
  }

  return growth;
}

/* -------------------------------------------------------------------------- */
/* The raw reader                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Reads the raw growth payload.
 *
 * Every number is checked: a count must be a safe integer, a measurement
 * must be finite. An unsafe or non-finite number is refused rather than
 * rounded, because a rounded follower count is a wrong follower count.
 */
function readRawGrowth(raw: Record<string, unknown>, context: string): RawGrowth {
  const reason = raw.reason;
  if (reason !== undefined && reason !== null && typeof reason !== "string") {
    throw new CompetitorReportContractError(
      "REPORT_UNAVAILABLE",
      `${context}.reason must be a string`,
    );
  }

  const periodDays = readCount(raw.period_days, "period_days", context);
  const observedAt = readOptionalInstant(raw.observed_at, "observed_at", context);
  const baselineAt = readOptionalInstant(raw.baseline_at, "baseline_at", context);

  // A baseline is only meaningful with the observed end beside it. The other
  // way round is normal: an observation without a baseline is the common
  // `missing_baseline` case.
  if (baselineAt !== null && observedAt === null) {
    throw new CompetitorReportContractError(
      "REPORT_UNAVAILABLE",
      `${context} carries a baseline without an observation`,
    );
  }

  return {
    period_days: periodDays,
    reason: typeof reason === "string" ? reason : null,
    observed_at: observedAt,
    observed_followers: readCount(raw.observed_followers, "observed_followers", context),
    observed_source: typeof raw.observed_source === "string" ? raw.observed_source : null,
    baseline_at: baselineAt,
    baseline_followers: readCount(raw.baseline_followers, "baseline_followers", context),
    interval_days: readFiniteNumber(raw.interval_days, "interval_days", context),
    interval_seconds: readFiniteNumber(raw.interval_seconds, "interval_seconds", context),
    absolute: readCount(raw.absolute, "absolute", context),
    percent: readFiniteNumber(raw.percent, "percent", context),
  };
}

/**
 * Reads the SQL reason.
 *
 * An unknown reason is refused. A reason the reader never produces is a
 * payload this module does not understand, and publishing it verbatim would
 * hand the frontend a string it has no translation for.
 */
function readSqlReason(reason: string | null, context: string): SqlGrowthReason | null {
  if (reason === null) return null;
  const known = (SQL_GROWTH_REASONS as readonly string[]).includes(reason);
  if (!known) {
    throw new CompetitorReportContractError(
      "REPORT_UNAVAILABLE",
      `${context}.reason is not a known reason`,
    );
  }
  return reason as SqlGrowthReason;
}
