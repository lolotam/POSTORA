import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { formatAnalyticsDate, formatCount, formatMinutes, formatSeconds, startDateForWindow } from "../domain/format";
import { buildTrendSeries } from "../domain/trendSeries";
import { ANALYTICS_PURPOSE_TEXT } from "../domain/purposeText";
import { ANALYTICS_PURPOSE_VERSION, YOUTUBE_ANALYTICS_DAILY_METRICS } from "../domain/types";
import { requestedWindow, WINDOW_END } from "./fixtures";

describe("analytics formatting", () => {
  it("keeps null explicit and formats units", () => {
    expect(formatCount(null)).toBe("—");
    expect(formatCount(1234, "en")).toBe("1,234");
    expect(formatCount(0, "en")).toBe("0");
    expect(formatCount(-2, "en")).toBe("-2");
    expect(formatMinutes(null)).toBe("—");
    expect(formatMinutes(125)).toBe("2h 5m");
    expect(formatMinutes(12.5)).toBe("12.5m");
    expect(formatSeconds(null)).toBe("—");
    expect(formatSeconds(65)).toBe("1:05");
    expect(formatSeconds(3661)).toBe("1h 1m");
    expect(formatAnalyticsDate(null)).toBe("—");
    expect(formatAnalyticsDate("not-a-date")).toBe("—");
    expect(startDateForWindow(WINDOW_END, 7)).toBe("2026-11-11");
  });
});

describe("daily trend series", () => {
  it("builds every requested day and never substitutes zero for a missing row or metric", () => {
    const points = buildTrendSeries(requestedWindow(), [{
      day: "2026-11-12",
      metrics: YOUTUBE_ANALYTICS_DAILY_METRICS.map((definition) => ({ key: definition.key, unit: definition.unit, value: definition.key === "views" ? 5 : null })),
    }]);
    expect(points).toHaveLength(7);
    expect(points[0]).toEqual({ day: "2026-11-11", views: null, watch_time: null, subscribers_gained: null, subscribers_lost: null });
    expect(points[1]).toEqual({ day: "2026-11-12", views: 5, watch_time: null, subscribers_gained: null, subscribers_lost: null });
    expect(points.at(-1)?.day).toBe(WINDOW_END);
    expect(points.flatMap((point) => Object.values(point))).not.toContain(0);
  });

  it("keeps an explicit provider zero while missing days remain null", () => {
    const points = buildTrendSeries(requestedWindow(7), [{
      day: WINDOW_END,
      metrics: [{ key: "subscribers_lost", unit: "count", value: 0 }],
    }]);
    expect(points.at(-1)?.subscribers_lost).toBe(0);
    expect(points.at(-1)?.views).toBeNull();
  });
});

const PINNED_PURPOSE_DIGESTS: Record<number, { en: string; ar: string }> = {
  1: {
    en: "1c30c0f2b02e8c2978ea7f2263fe15bb84b4201553d9ffde32dba9b5f81ca422",
    ar: "a51ea364e48978289d428b404867e9b425083d3bb0c17e0af031264f4e0dc0a1",
  },
};

describe("Analytics Purpose Clause version guard", () => {
  it("pins every English and Arabic purpose string to the purpose version", () => {
    const localized = ANALYTICS_PURPOSE_TEXT[ANALYTICS_PURPOSE_VERSION as 1];
    const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
    expect(PINNED_PURPOSE_DIGESTS[ANALYTICS_PURPOSE_VERSION]).toEqual({
      en: digest(localized.en),
      ar: digest(localized.ar),
    });
  });
});
