import { pacificDateString } from "../_shared/pacificDay.ts";
import {
  YOUTUBE_ANALYTICS_DATE_PATTERN,
  YOUTUBE_ANALYTICS_TIME_ZONE,
  type YouTubeAnalyticsPeriodDays,
  type YouTubeAnalyticsRequestedWindow,
} from "./contracts.ts";

export { pacificDateString };

export function shiftIsoDate(isoDate: string, deltaDays: number): string {
  const [year, month, day] = isoDate.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + deltaDays));
  const yyyy = String(shifted.getUTCFullYear()).padStart(4, "0");
  const mm = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(shifted.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

export function isIsoCalendarDate(value: string): boolean {
  if (!YOUTUBE_ANALYTICS_DATE_PATTERN.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day;
}

export function reportingEndDate(now: Date): string {
  return shiftIsoDate(pacificDateString(now), -3);
}

export function acceptedWindowEndDates(now: Date): [string, string] {
  const current = reportingEndDate(now);
  return [current, shiftIsoDate(current, -1)];
}

export type ResolvedYouTubeAnalyticsWindow =
  | { ok: true; window: YouTubeAnalyticsRequestedWindow; days: string[] }
  | { ok: false; code: "invalid_request" | "window_stale" };

export function resolveRequestedWindow(input: {
  windowEnd: string;
  periodDays: YouTubeAnalyticsPeriodDays;
  now: Date;
}): ResolvedYouTubeAnalyticsWindow {
  if (!isIsoCalendarDate(input.windowEnd)) return { ok: false, code: "invalid_request" };
  if (!acceptedWindowEndDates(input.now).includes(input.windowEnd)) {
    return { ok: false, code: "window_stale" };
  }
  const startDate = shiftIsoDate(input.windowEnd, -(input.periodDays - 1));
  const days = Array.from(
    { length: input.periodDays },
    (_, index) => shiftIsoDate(startDate, index),
  );
  return {
    ok: true,
    window: {
      start_date: startDate,
      end_date: input.windowEnd,
      days: input.periodDays,
      time_zone: YOUTUBE_ANALYTICS_TIME_ZONE,
    },
    days,
  };
}

export function pacificBudgetBucketKey(kind: "data" | "analytics", now: Date): string {
  return `youtube-analytics:budget:${kind}:${pacificDateString(now)}`;
}
