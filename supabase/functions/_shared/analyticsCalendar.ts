export const ANALYTICS_PERIOD_DAYS = [7, 14, 30, 90] as const;
export type AnalyticsPeriodDays = typeof ANALYTICS_PERIOD_DAYS[number];
export type AnalyticsPeriod = { days: AnalyticsPeriodDays; since: string; until: string; timezone: string };
export type AnalyticsDayBucket = { date: string; since: string; until: string };
export type AnalyticsCalendarWindow = { period: AnalyticsPeriod; buckets: AnalyticsDayBucket[] };

function dateFormatter(timezone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone, calendar: "iso8601", numberingSystem: "latn", hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}

function civilParts(instant: number, formatter: Intl.DateTimeFormat): Record<string, number> {
  return Object.fromEntries(formatter.formatToParts(instant)
    .filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]));
}

function civilDate(instant: number, formatter: Intl.DateTimeFormat): string {
  const parts = civilParts(instant, formatter);
  return `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function shiftDate(date: string, days: number): string {
  const shifted = new Date(`${date}T00:00:00.000Z`);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}

/** Registered calendars have representable local midnights; an unsupported skipped day is refused. */
function midnight(date: string, formatter: Intl.DateTimeFormat): string {
  const target = Date.parse(`${date}T00:00:00.000Z`);
  let candidate = target;
  for (let attempt = 0; attempt < 4; attempt++) {
    const parts = civilParts(candidate, formatter);
    const wallClock = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    const adjustment = target - wallClock;
    if (adjustment === 0) return new Date(candidate).toISOString();
    candidate += adjustment;
  }
  throw new RangeError("The registered analytics calendar has no representable midnight");
}

/** A capture uses one real provider day, including 23/25-hour DST boundaries. */
export function analyticsDayBucket(date: string, timezone: string): AnalyticsDayBucket {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || new Date(`${date}T00:00:00.000Z`).toISOString().slice(0, 10) !== date) {
    throw new RangeError("Invalid analytics capture date");
  }
  const formatter = dateFormatter(timezone);
  return { date, since: midnight(date, formatter), until: midnight(shiftDate(date, 1), formatter) };
}

function calendarWindow(start: string, days: AnalyticsPeriodDays, timezone: string, formatter: Intl.DateTimeFormat): AnalyticsCalendarWindow {
  const buckets = Array.from({ length: days }, (_unused, index) => {
    const date = shiftDate(start, index);
    return { date, since: midnight(date, formatter), until: midnight(shiftDate(date, 1), formatter) };
  });
  return {
    period: { days, since: buckets[0].since, until: buckets[buckets.length - 1].until, timezone },
    buckets,
  };
}

/** All periods end at today's local midnight. Calendar dates, not fixed 86,400-second durations, advance days. */
export function closedAnalyticsPeriods(input: { now: string; days: AnalyticsPeriodDays; timezone: string }): {
  current: AnalyticsCalendarWindow; previous: AnalyticsCalendarWindow;
} {
  const instant = Date.parse(input.now);
  if (!Number.isFinite(instant)) throw new RangeError("Invalid analytics evaluation instant");
  const formatter = dateFormatter(input.timezone);
  const today = civilDate(instant, formatter);
  return {
    current: calendarWindow(shiftDate(today, -input.days), input.days, input.timezone, formatter),
    previous: calendarWindow(shiftDate(today, -2 * input.days), input.days, input.timezone, formatter),
  };
}

/** Validate a frozen report/cursor period without moving it forward when another page crosses midnight. */
export function analyticsWindowForPeriod(period: AnalyticsPeriod): AnalyticsCalendarWindow {
  const formatter = dateFormatter(period.timezone);
  const start = Date.parse(period.since);
  if (!Number.isFinite(start)) throw new RangeError("Invalid analytics period boundary");
  const reconstructed = calendarWindow(civilDate(start, formatter), period.days, period.timezone, formatter);
  if (reconstructed.period.since !== period.since || reconstructed.period.until !== period.until) {
    throw new RangeError("Analytics period does not match its registered calendar");
  }
  return reconstructed;
}
