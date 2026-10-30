import { describe, expect, it } from "vitest";

import {
  UNAVAILABLE_VALUE,
  formatCount,
  formatGrowth,
  formatObservedAt,
  formatOutlierScore,
  formatPercent,
  formatQuota,
  formatSignedCount,
  formatWeekly,
} from "../domain/formatters";

describe("competitor tracking formatters", () => {
  describe("the unavailable rule", () => {
    it("never turns a null count into a zero", () => {
      expect(formatCount(null)).toBe(UNAVAILABLE_VALUE);
      expect(formatCount(undefined)).toBe(UNAVAILABLE_VALUE);
      expect(formatCount(Number.NaN)).toBe(UNAVAILABLE_VALUE);
    });

    it("still shows a real zero", () => {
      expect(formatCount(0)).toBe("0");
      expect(formatSignedCount(0)).toBe("0");
      expect(formatPercent(0)).toBe("0.0%");
    });

    it("never turns a null delta or percentage into a zero", () => {
      expect(formatSignedCount(null)).toBe(UNAVAILABLE_VALUE);
      expect(formatPercent(null)).toBe(UNAVAILABLE_VALUE);
      expect(formatOutlierScore(null)).toBe(UNAVAILABLE_VALUE);
    });
  });

  describe("the growth comparison", () => {
    it("shows the signed delta and the percentage of a comparable comparison", () => {
      const formatted = formatGrowth(
        {
          absolute: 120,
          percent: 0.66,
          interval_days: 7,
          reason: null,
          baseline_at: "2026-10-22T04:00:00+00:00",
          observed_at: "2026-10-29T04:00:00+00:00",
        },
        "en-US",
      );

      expect(formatted.available).toBe(true);
      expect(formatted.text).toBe("+120 (0.7%)");
      expect(formatted.intervalDays).toBe(7);
      expect(formatted.reason).toBeNull();
    });

    it("keeps a negative change negative", () => {
      const formatted = formatGrowth(
        {
          absolute: -50,
          percent: -1.4,
          interval_days: 30,
          reason: null,
          baseline_at: "2026-09-29T04:00:00+00:00",
          observed_at: "2026-10-29T04:00:00+00:00",
        },
        "en-US",
      );

      expect(formatted.available).toBe(true);
      expect(formatted.text).toBe("-50 (-1.4%)");
    });

    it("shows the unavailable placeholder and the server's reason", () => {
      const formatted = formatGrowth({
        absolute: null,
        percent: null,
        interval_days: null,
        reason: "zero_baseline",
        baseline_at: null,
        observed_at: "2026-10-29T04:00:00+00:00",
      });

      expect(formatted.available).toBe(false);
      expect(formatted.text).toBe(UNAVAILABLE_VALUE);
      expect(formatted.reason).toBe("zero_baseline");
    });
  });

  describe("the weekly inventory", () => {
    it("publishes a rate only when the coverage proves the window", () => {
      const formatted = formatWeekly({
        observed_count: 3,
        posts_per_week: 3,
        interval_start: "2026-10-23T04:00:00+00:00",
        interval_end: "2026-10-29T04:00:00+00:00",
        coverage: "complete",
        reason: null,
      });

      expect(formatted.rateAvailable).toBe(true);
      expect(formatted.observedText).toBe("3");
      expect(formatted.postsPerWeekText).toBe("3.0");
    });

    it("returns the rate as a number only, including for an Arabic locale", () => {
      const formatted = formatWeekly(
        {
          observed_count: 3,
          posts_per_week: 3,
          interval_start: "2026-10-23T04:00:00+00:00",
          interval_end: "2026-10-29T04:00:00+00:00",
          coverage: "complete",
          reason: null,
        },
        "ar",
      );

      expect(formatted.postsPerWeekText).toBe("3.0");
    });

    it("never extrapolates a rate from a partial or unknown window", () => {
      const partial = formatWeekly({
        observed_count: 3,
        posts_per_week: null,
        interval_start: null,
        interval_end: null,
        coverage: "partial",
        reason: "ordering_unverified",
      });
      const unknown = formatWeekly({
        observed_count: 0,
        posts_per_week: null,
        interval_start: null,
        interval_end: null,
        coverage: "unknown",
        reason: null,
      });

      expect(partial.rateAvailable).toBe(false);
      expect(partial.postsPerWeekText).toBe(UNAVAILABLE_VALUE);
      expect(partial.observedText).toBe("3");
      expect(unknown.rateAvailable).toBe(false);
      expect(unknown.observedText).toBe("0");
    });
  });

  describe("the quota", () => {
    it("treats a missing quota as an unavailable limit, never as unlimited", () => {
      const formatted = formatQuota(null);

      expect(formatted.available).toBe(false);
      expect(formatted.unlimited).toBe(false);
      expect(formatted.limit).toBeNull();
      expect(formatted.remaining).toBeNull();
    });

    it("keeps an unlimited quota unlimited and publishes no number", () => {
      const formatted = formatQuota({
        max_tracked_competitors: -1,
        unlimited: true,
        tracked_active: 42,
        remaining: null,
      });

      expect(formatted.available).toBe(true);
      expect(formatted.unlimited).toBe(true);
      expect(formatted.limit).toBeNull();
      expect(formatted.remaining).toBeNull();
      expect(formatted.used).toBe(42);
    });

    it("publishes the resolved limit and the remaining slots", () => {
      const formatted = formatQuota({
        max_tracked_competitors: 5,
        unlimited: false,
        tracked_active: 2,
        remaining: 3,
      });

      expect(formatted.limit).toBe(5);
      expect(formatted.remaining).toBe(3);
    });
  });

  describe("the instants", () => {
    it("shows an unavailable placeholder for a missing instant", () => {
      expect(formatObservedAt(null)).toBe(UNAVAILABLE_VALUE);
      expect(formatObservedAt("")).toBe(UNAVAILABLE_VALUE);
    });

    it("renders an instant in the capture timezone", () => {
      const formatted = formatObservedAt("2026-10-29T04:00:00+00:00", "en-US");

      expect(formatted).not.toBe(UNAVAILABLE_VALUE);
      expect(formatted).toContain("2026");
    });
  });
});
