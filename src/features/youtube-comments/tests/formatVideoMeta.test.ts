import { describe, expect, it } from "vitest";
import {
  formatCompactCount,
  formatExactCount,
  formatVideoDuration,
  validPublishDate,
} from "../domain/formatVideoMeta";

describe("formatVideoDuration", () => {
  it.each([
    ["PT9M19S", "9:19"],
    ["PT1H2M3S", "1:02:03"],
    ["PT45S", "0:45"],
    ["PT3M", "3:00"],
    ["P1DT2S", "24:00:02"],
  ])("formats %s as %s", (iso, expected) => {
    expect(formatVideoDuration(iso)).toBe(expected);
  });

  it.each([null, undefined, "", "PT0S", "P0DT0S", "PT", "not-a-duration", "PT-1S"])(
    "hides missing or malformed duration %s",
    (iso) => {
      expect(formatVideoDuration(iso)).toBeNull();
    },
  );
});

describe("video count formatting", () => {
  it.each([
    [1300, "1.3K"],
    [177, "177"],
    [0, "0"],
  ])("formats %i as a compact count", (count, expected) => {
    expect(formatCompactCount(count, "en")).toBe(expected);
  });

  it("formats exact counts with locale separators", () => {
    expect(formatExactCount(1300, "en")).toBe("1,300");
    expect(formatExactCount(0, "en")).toBe("0");
  });

  it.each([null, undefined, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "renders an em dash for unavailable count %s",
    (count) => {
      expect(formatCompactCount(count, "en")).toBe("\u2014");
      expect(formatExactCount(count, "en")).toBe("\u2014");
    },
  );

  it("falls back to English when the locale is invalid", () => {
    expect(formatExactCount(1300, "not-a-locale")).toBe("1,300");
  });
});

describe("validPublishDate", () => {
  it("accepts a valid timestamp and rejects missing or invalid dates", () => {
    expect(validPublishDate("2026-01-02T00:00:00Z")?.toISOString()).toBe("2026-01-02T00:00:00.000Z");
    expect(validPublishDate("not-a-date")).toBeNull();
    expect(validPublishDate(null)).toBeNull();
    expect(validPublishDate(undefined)).toBeNull();
  });
});
