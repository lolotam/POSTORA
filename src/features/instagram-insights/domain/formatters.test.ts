import { describe, expect, it } from "vitest";
import {
  formatCompactNumber,
  formatEngagementRate,
  formatMetricNumber,
  formatOutlierBadge,
  formatReasonExplanation,
  formatSyncStatus,
  getOutlierVariant,
} from "./formatters";
import type { OutlierLabel, OwnerReportEngagementRate } from "./types";

describe("formatters domain logic", () => {
  describe("getOutlierVariant and formatOutlierBadge", () => {
    it("assigns success variant to outlier and above", () => {
      expect(getOutlierVariant("outlier")).toBe("success");
      expect(getOutlierVariant("above")).toBe("success");
      expect(formatOutlierBadge("outlier", 2.5)).toEqual({
        text: "🌟 2.5x Outlier",
        variant: "success",
      });
      expect(formatOutlierBadge("above", 1.4)).toEqual({
        text: "▲ 1.4x Above",
        variant: "success",
      });
    });

    it("handles null score gracefully", () => {
      expect(formatOutlierBadge("outlier", null)).toEqual({
        text: "🌟 Outlier",
        variant: "success",
      });
      expect(formatOutlierBadge("normal", null)).toEqual({
        text: "Normal",
        variant: "secondary",
      });
    });

    it("handles non-finite scores as null", () => {
      expect(formatOutlierBadge("above", Number.NaN)).toEqual({
        text: "▲ Above",
        variant: "success",
      });
      expect(formatOutlierBadge("above", Number.POSITIVE_INFINITY)).toEqual({
        text: "▲ Above",
        variant: "success",
      });
    });

    it("formats warning for below", () => {
      expect(getOutlierVariant("below")).toBe("warning");
      expect(formatOutlierBadge("below", 0.4)).toEqual({
        text: "▼ 0.4x Below",
        variant: "warning",
      });
    });

    it("formats outline for uncalculated states", () => {
      const labels: OutlierLabel[] = ["too_early", "small_baseline", "no_data"];
      for (const label of labels) {
        expect(getOutlierVariant(label)).toBe("outline");
        const badge = formatOutlierBadge(label, null);
        expect(badge.variant).toBe("outline");
      }
    });
  });

  describe("formatMetricNumber", () => {
    it("returns dash for null, undefined, or non-finite numbers", () => {
      expect(formatMetricNumber(null)).toBe("—");
      expect(formatMetricNumber(undefined)).toBe("—");
      expect(formatMetricNumber(Number.NaN)).toBe("—");
      expect(formatMetricNumber(Number.POSITIVE_INFINITY)).toBe("—");
    });

    it("formats zero as a real measurement", () => {
      expect(formatMetricNumber(0)).toBe("0");
    });

    it("formats positive numbers with locale formatting", () => {
      expect(formatMetricNumber(12500)).toMatch(/12[,.]500/);
    });
  });

  describe("formatCompactNumber", () => {
    it("returns dash for null/undefined", () => {
      expect(formatCompactNumber(null)).toBe("—");
      expect(formatCompactNumber(undefined)).toBe("—");
    });

    it("formats small numbers directly", () => {
      expect(formatCompactNumber(0)).toBe("0");
      expect(formatCompactNumber(850)).toBe("850");
    });

    it("formats thousands with K", () => {
      expect(formatCompactNumber(1000)).toBe("1K");
      expect(formatCompactNumber(2400)).toBe("2.4K");
    });

    it("formats millions with M", () => {
      expect(formatCompactNumber(1000000)).toBe("1M");
      expect(formatCompactNumber(3500000)).toBe("3.5M");
    });
  });

  describe("formatEngagementRate", () => {
    it("returns dash when rate or value is null/undefined", () => {
      expect(formatEngagementRate(null)).toBe("—");
      expect(formatEngagementRate(undefined)).toBe("—");
      const nullRate: OwnerReportEngagementRate = {
        value: null,
        unit: "percent",
        denominatorMetric: "reach",
        numeratorMetrics: ["likes", "comments", "saved", "shares"],
      };
      expect(formatEngagementRate(nullRate)).toBe("—");
    });

    it("formats valid rate to two decimal places with percent sign", () => {
      const rate: OwnerReportEngagementRate = {
        value: 3.456,
        unit: "percent",
        denominatorMetric: "reach",
        numeratorMetrics: ["likes", "comments", "saved", "shares"],
      };
      expect(formatEngagementRate(rate)).toBe("3.46%");
    });
  });

  describe("formatSyncStatus", () => {
    it("returns expected labels and variants", () => {
      expect(formatSyncStatus("ok")).toEqual({ label: "Up to date", variant: "success" });
      expect(formatSyncStatus("partial")).toEqual({ label: "Partially synced", variant: "warning" });
      expect(formatSyncStatus("error")).toEqual({ label: "Sync error", variant: "destructive" });
      expect(formatSyncStatus("never")).toEqual({ label: "Never synced", variant: "outline" });
    });
  });

  describe("formatReasonExplanation", () => {
    it("returns null for ok or null reason", () => {
      expect(formatReasonExplanation(null)).toBeNull();
      expect(formatReasonExplanation("ok")).toBeNull();
    });

    it("returns human explanation for error/status codes", () => {
      expect(formatReasonExplanation("never_synced")).toBe("Initial collection has not started yet.");
      expect(formatReasonExplanation("scope_missing")).toContain("permissions are missing");
      expect(formatReasonExplanation("reauth_required")).toContain("reconnect this Instagram account");
      expect(formatReasonExplanation("throttled")).toContain("rate limit reached");
      expect(formatReasonExplanation("provider_unavailable")).toContain("temporary service issue");
    });
  });
});
