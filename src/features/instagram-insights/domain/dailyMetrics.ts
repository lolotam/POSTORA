import type { OwnerReport } from "./types";
import { summarizeDailyMetricValues } from "@/features/analytics-contract";

type DailyMetric = "views" | "totalInteractions";
type DailyReport = {
  account: Pick<OwnerReport["account"], "daily">;
  period: Pick<OwnerReport["period"], "metricDateStart" | "metricDateEnd">;
};
export type DailyMetricSummary = {
  status: "available" | "partial" | "unavailable";
  value: number | null;
  availableDays: number;
  expectedDays: number;
};

export function dailyMetricSeries(report: DailyReport) {
  const rows = new Map(report.account.daily.map((row) => [row.metricDate, row]));
  const series = [];
  const day = new Date(`${report.period.metricDateStart}T00:00:00Z`);
  for (; day.toISOString().slice(0, 10) <= report.period.metricDateEnd; day.setUTCDate(day.getUTCDate() + 1)) {
    const date = day.toISOString().slice(0, 10);
    const row = rows.get(date);
    const measurement = (metric: "reach" | DailyMetric) =>
      row?.status === "ok" && row[metric] !== null && Number.isFinite(row[metric]) ? row[metric] : null;
    series.push({ date, reach: measurement("reach"), views: measurement("views"), totalInteractions: measurement("totalInteractions") });
  }
  return series;
}

// Only additive metrics may use this path; unique reach requires a provider period total.
export function summarizeDailyMetric(report: OwnerReport, metric: DailyMetric): DailyMetricSummary {
  const series = dailyMetricSeries(report);
  const summary = summarizeDailyMetricValues({
    aggregation: "sum",
    days: series.map((day) => ({ date: day.date, metric: day[metric] === null
      ? { status: "unavailable", reason: "not_collected" } : { status: "available", value: day[metric] } })),
  });
  return {
    status: summary.status,
    value: summary.status === "unavailable" ? null : summary.value,
    availableDays: summary.status === "available" ? series.length : summary.status === "partial" ? summary.coverage.availableDays : 0,
    expectedDays: series.length,
  };
}
