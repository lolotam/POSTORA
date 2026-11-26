import type { YouTubeAnalyticsMetric } from "./types";

export const EMPTY_ANALYTICS_VALUE = "—";

export function formatCount(value: number | null, locale = "en"): string {
  return value === null ? EMPTY_ANALYTICS_VALUE : new Intl.NumberFormat(locale).format(value);
}

export function formatMinutes(value: number | null, locale = "en"): string {
  if (value === null) return EMPTY_ANALYTICS_VALUE;
  const totalMinutes = Math.floor(value);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0
    ? `${new Intl.NumberFormat(locale).format(hours)}h ${new Intl.NumberFormat(locale).format(minutes)}m`
    : `${new Intl.NumberFormat(locale).format(value)}m`;
}

export function formatSeconds(value: number | null): string {
  if (value === null) return EMPTY_ANALYTICS_VALUE;
  const wholeSeconds = Math.floor(value);
  const hours = Math.floor(wholeSeconds / 3600);
  const minutes = Math.floor((wholeSeconds % 3600) / 60);
  const seconds = wholeSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

export function formatAnalyticsDate(value: string | null, locale = "en"): string {
  if (value === null) return EMPTY_ANALYTICS_VALUE;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(parsed.getTime())
    ? EMPTY_ANALYTICS_VALUE
    : new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" }).format(parsed);
}

export function formatMetric(metric: YouTubeAnalyticsMetric | undefined, locale = "en"): string {
  if (!metric) return EMPTY_ANALYTICS_VALUE;
  if (metric.unit === "minutes") return formatMinutes(metric.value, locale);
  if (metric.unit === "seconds") return formatSeconds(metric.value);
  return formatCount(metric.value, locale);
}

export function startDateForWindow(endDate: string, periodDays: number): string {
  const date = new Date(`${endDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - periodDays + 1);
  return date.toISOString().slice(0, 10);
}
