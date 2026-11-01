import { describe, expect, it } from "vitest";
import { reportFixture } from "../tests/reportFixture";
import { dailyMetricSeries, summarizeDailyMetric } from "./dailyMetrics";

function weekReport() {
  return reportFixture({
    request: { periodDays: 7, limit: 20, cursor: null },
    accountDaily: Array.from({ length: 7 }, (_, index) => ({
      id: `daily-${index}`, metricDate: `2026-10-${23 + index}`, providerDate: `2026-10-${23 + index}`,
      capturedAt: "2026-10-29T00:00:00Z", status: "ok", views: 10, totalInteractions: 2, reach: 8,
    })),
  });
}

describe("daily account measurements", () => {
  it("sums additive metrics only across the authoritative date window", () => {
    const report = weekReport();
    expect(summarizeDailyMetric(report, "views")).toEqual({ status: "available", value: 70, availableDays: 7, expectedDays: 7 });
    expect(summarizeDailyMetric(report, "totalInteractions").value).toBe(14);
  });

  it("measures coverage per metric even when every row is present", () => {
    const report = weekReport();
    report.account.daily[0].views = null;
    expect(summarizeDailyMetric(report, "views")).toEqual({ status: "partial", value: 60, availableDays: 6, expectedDays: 7 });
    expect(summarizeDailyMetric(report, "totalInteractions").status).toBe("available");
  });

  it("leaves missing and failed days as gaps rather than zero", () => {
    const report = weekReport();
    report.account.daily.shift();
    report.account.daily[0].status = "error";
    expect(summarizeDailyMetric(report, "views")).toEqual({ status: "partial", value: 50, availableDays: 5, expectedDays: 7 });
    expect(dailyMetricSeries(report).slice(0, 2)).toEqual([
      { date: "2026-10-23", views: null, reach: null, totalInteractions: null },
      { date: "2026-10-24", views: null, reach: null, totalInteractions: null },
    ]);
  });

  it.each(["missing", "zero"] as const)("distinguishes %s measurements", (kind) => {
    const report = weekReport();
    report.account.daily.forEach((row) => { row.views = kind === "zero" ? 0 : null; });
    expect(summarizeDailyMetric(report, "views")).toEqual({
      status: kind === "zero" ? "available" : "unavailable",
      value: kind === "zero" ? 0 : null,
      availableDays: kind === "zero" ? 7 : 0, expectedDays: 7,
    });
  });
});
