/**
 * The pure formatters of the competitor tracking feature.
 *
 * WHAT THIS MODULE OWNS
 *
 *   The presentation-ready shape of every value the report carries: the
 *   numbers, the instants, the quota and the three "is this available"
 *   decisions the UI has to make.
 *
 * THE ONE RULE
 *
 *   NULL IS UNAVAILABLE, NEVER ZERO. A missing follower count is
 *   unavailable, not zero. A refused growth comparison is unavailable,
 *   not 0%. An incomplete week is unknown, not "posted zero".
 *
 *   The formatters therefore never substitute a number for a null. They
 *   return the unavailable placeholder, and they return the REASON so the
 *   UI can explain the absence in the owner's language instead of
 *   guessing.
 *
 * WHY THERE IS NO ANALYTICS HERE
 *
 *   These functions format what the server computed. They never compute
 *   a growth rate, never score an outlier and never extrapolate a weekly
 *   rate. A formatter that multiplied two numbers would be a SECOND
 *   growth algorithm, and the architecture test refuses that.
 */

/**
 * The placeholder for a value the server could not provide.
 *
 * It is a dash, not a zero and not the word "unknown": the reason, when
 * there is one, is rendered next to it.
 */
export const UNAVAILABLE_VALUE = "—";

/** The timezone the report's instants are displayed in. */
export const COMPETITOR_DISPLAY_TIMEZONE = "Asia/Kuwait";

function numberFormatter(
  locale: string | undefined,
  options: Intl.NumberFormatOptions,
): Intl.NumberFormat {
  return new Intl.NumberFormat(locale, options);
}

/**
 * A count. Null is unavailable.
 */
export function formatCount(
  value: number | null | undefined,
  locale?: string,
): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return UNAVAILABLE_VALUE;
  }
  return numberFormatter(locale, {}).format(value);
}

/**
 * A signed count. A negative delta keeps its sign; null is unavailable.
 */
export function formatSignedCount(
  value: number | null | undefined,
  locale?: string,
): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return UNAVAILABLE_VALUE;
  }
  return numberFormatter(locale, { signDisplay: "exceptZero" }).format(value);
}

/**
 * A percentage. The server's number is used verbatim - the formatter
 * never recomputes it.
 */
export function formatPercent(
  value: number | null | undefined,
  locale?: string,
): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return UNAVAILABLE_VALUE;
  }
  return `${numberFormatter(locale, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(value)}%`;
}

/**
 * An instant, displayed in the capture timezone. Null is unavailable.
 */
export function formatObservedAt(
  instant: string | null | undefined,
  locale?: string,
): string {
  if (instant === null || instant === undefined || instant.trim() === "") {
    return UNAVAILABLE_VALUE;
  }
  const epoch = Date.parse(instant);
  if (!Number.isFinite(epoch)) return UNAVAILABLE_VALUE;
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: COMPETITOR_DISPLAY_TIMEZONE,
  }).format(new Date(epoch));
}

/**
 * The outlier score. A null score is unavailable - a neutral label with
 * no score is not a score of zero.
 */
export function formatOutlierScore(
  score: number | null | undefined,
  locale?: string,
): string {
  if (score === null || score === undefined || !Number.isFinite(score)) {
    return UNAVAILABLE_VALUE;
  }
  return `${numberFormatter(locale, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(score)}×`;
}

/**
 * The displayable shape of one growth comparison.
 *
 * `available` is true only when the server published a comparison. The
 * `reason` is the server's own explanation of why it did not, and the UI
 * shows it instead of inventing one.
 */
export type FormattedGrowth = {
  available: boolean;
  text: string;
  absolute: number | null;
  percent: number | null;
  reason: string | null;
  intervalDays: number | null;
  baselineAt: string | null;
  observedAt: string | null;
};

/**
 * Formats one growth comparison.
 *
 * A comparable comparison shows the signed delta and the percentage. An
 * unavailable one shows the placeholder and carries the server's reason.
 */
export function formatGrowth(
  growth: {
    absolute: number | null;
    percent: number | null;
    interval_days: number | null;
    reason: string | null;
    baseline_at: string | null;
    observed_at: string | null;
  },
  locale?: string,
): FormattedGrowth {
  const available =
    growth.absolute !== null &&
    growth.percent !== null &&
    growth.reason === null &&
    growth.observed_at !== null;

  const text = available
    ? `${formatSignedCount(growth.absolute, locale)} (${formatPercent(growth.percent, locale)})`
    : UNAVAILABLE_VALUE;

  return {
    available,
    text,
    absolute: growth.absolute,
    percent: growth.percent,
    reason: growth.reason,
    intervalDays: growth.interval_days,
    baselineAt: growth.baseline_at,
    observedAt: growth.observed_at,
  };
}

/**
 * The displayable shape of the weekly posting rate.
 *
 * `rateAvailable` is true only when the coverage PROVES the window. A
 * partial or unknown window never carries an extrapolated rate, so the
 * observed count is shown on its own.
 */
export type FormattedWeekly = {
  rateAvailable: boolean;
  observedCount: number;
  observedText: string;
  postsPerWeek: number | null;
  postsPerWeekText: string;
  coverage: "complete" | "partial" | "unknown";
  reason: string | null;
  intervalStart: string | null;
  intervalEnd: string | null;
};

/**
 * Formats the weekly inventory.
 */
export function formatWeekly(
  weekly: {
    observed_count: number;
    posts_per_week: number | null;
    interval_start: string | null;
    interval_end: string | null;
    coverage: "complete" | "partial" | "unknown";
    reason: string | null;
  },
  locale?: string,
): FormattedWeekly {
  const rateAvailable = weekly.coverage === "complete" && weekly.posts_per_week !== null;

  return {
    rateAvailable,
    observedCount: weekly.observed_count,
    observedText: formatCount(weekly.observed_count, locale),
    postsPerWeek: weekly.posts_per_week,
    postsPerWeekText: rateAvailable
      ? `${numberFormatter(locale, {
          minimumFractionDigits: 1,
          maximumFractionDigits: 1,
        }).format(weekly.posts_per_week as number)}/week`
      : UNAVAILABLE_VALUE,
    coverage: weekly.coverage,
    reason: weekly.reason,
    intervalStart: weekly.interval_start,
    intervalEnd: weekly.interval_end,
  };
}

/**
 * The displayable shape of the owner's quota.
 *
 * `available` is false when the quota could not be read at all. The UI
 * then says "limit unavailable" instead of inventing a free allowance.
 */
export type FormattedQuota = {
  available: boolean;
  unlimited: boolean;
  used: number | null;
  limit: number | null;
  remaining: number | null;
};

/**
 * Formats the quota. A null quota is an unavailable quota, never an
 * unlimited one.
 */
export function formatQuota(
  quota: {
    max_tracked_competitors: number | null;
    unlimited: boolean;
    tracked_active: number;
    remaining: number | null;
  } | null,
): FormattedQuota {
  if (quota === null) {
    return {
      available: false,
      unlimited: false,
      used: null,
      limit: null,
      remaining: null,
    };
  }

  return {
    available: true,
    unlimited: quota.unlimited,
    used: quota.tracked_active,
    limit: quota.unlimited ? null : quota.max_tracked_competitors,
    remaining: quota.unlimited ? null : quota.remaining,
  };
}
