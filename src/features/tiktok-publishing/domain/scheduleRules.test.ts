import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveLocalWallClock } from "@/features/scheduled";
import {
  AMBIGUOUS_TIME_NOTE,
  formatInZone,
  shortcutInstant,
  validateScheduledAt,
} from "./scheduleRules";

vi.mock("@/features/scheduled", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/scheduled")>();
  return {
    ...actual,
    resolveLocalWallClock: vi.fn(actual.resolveLocalWallClock),
  };
});

describe("scheduleRules", () => {
  const FAR_OFF_DATE = new Date("1995-12-17T03:24:00.000Z");

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FAR_OFF_DATE);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  describe("shortcutInstant - in_1_hour", () => {
    it("is exactly +3600000 ms from the provided now", () => {
      const now = new Date("2026-09-30T14:00:00.000Z");
      const result = shortcutInstant("in_1_hour", now, "UTC");

      expect(result).toEqual({
        ok: true,
        iso: "2026-09-30T15:00:00.000Z",
        resolution: null,
      });
    });
  });

  describe("shortcutInstant - tomorrow_9", () => {
    it("computes tomorrow 09:00 in the local zone", () => {
      vi.stubEnv("TZ", "Asia/Kuwait");
      const now = new Date("2026-09-30T14:00:00.000Z");
      const result = shortcutInstant("tomorrow_9", now, "Asia/Kuwait");

      expect(result).toEqual({
        ok: true,
        iso: "2026-10-01T06:00:00.000Z",
        resolution: null,
      });
    });

    it("returns nonexistent reason and explanation when 09:00 falls into a spring-forward gap", () => {
      vi.mocked(resolveLocalWallClock).mockReturnValueOnce({
        ok: false,
        reason: "nonexistent",
      });
      const now = new Date("2026-09-30T14:00:00.000Z");
      const result = shortcutInstant("tomorrow_9", now, "UTC");

      expect(result).toEqual({
        ok: false,
        reason: "nonexistent",
        resolution: "09:00 does not exist on that day in this time zone because clocks spring forward.",
      });
    });

    it("includes AMBIGUOUS_TIME_NOTE when 09:00 repeats during fall-back DST", () => {
      const repeatedDate = new Date("2026-10-01T09:00:00.000Z");
      vi.mocked(resolveLocalWallClock).mockReturnValueOnce({
        ok: true,
        when: repeatedDate,
        ambiguous: true,
      });
      const now = new Date("2026-09-30T14:00:00.000Z");
      const result = shortcutInstant("tomorrow_9", now, "UTC");

      expect(result).toEqual({
        ok: true,
        iso: repeatedDate.toISOString(),
        resolution: AMBIGUOUS_TIME_NOTE,
      });
    });
  });

  describe("shortcutInstant - invalid inputs", () => {
    it("returns invalid verdict on malformed timeZone or invalid Date", () => {
      const invalidZoneResult = shortcutInstant("tomorrow_9", new Date("2026-09-30T14:00:00.000Z"), "Invalid/Zone_Name");
      expect(invalidZoneResult).toEqual({
        ok: false,
        reason: "invalid",
        resolution: null,
      });

      const invalidDateResult = shortcutInstant("in_1_hour", new Date("invalid"), "UTC");
      expect(invalidDateResult).toEqual({
        ok: false,
        reason: "invalid",
        resolution: null,
      });
    });
  });

  describe("validateScheduledAt", () => {
    const now = new Date("2026-10-01T12:00:00.000Z");

    it("returns 'past' when scheduled instant is before or equal to now", () => {
      expect(validateScheduledAt("2026-10-01T11:59:59.999Z", now)).toBe("past");
      expect(validateScheduledAt("2026-10-01T12:00:00.000Z", now)).toBe("past");
    });

    it("returns 'ok' when scheduled instant is strictly in the future", () => {
      expect(validateScheduledAt("2026-10-01T12:00:00.001Z", now)).toBe("ok");
      expect(validateScheduledAt("2026-10-02T12:00:00.000Z", now)).toBe("ok");
    });

    it("returns 'invalid' for unparseable dates or invalid now", () => {
      expect(validateScheduledAt("not-an-iso-string", now)).toBe("invalid");
      expect(validateScheduledAt("2026-10-02T12:00:00.000Z", new Date("invalid"))).toBe("invalid");
    });
  });

  describe("formatInZone", () => {
    it("formats valid ISO timestamp containing expected local hour and differing from UTC", () => {
      const instant = "2026-10-02T06:00:00.000Z";
      const formattedKuwait = formatInZone(instant, "Asia/Kuwait");
      const formattedUtc = formatInZone(instant, "UTC");

      expect(formattedKuwait).toMatch(/9:00/);
      expect(formattedUtc).toMatch(/6:00/);
      expect(formattedKuwait).not.toBe(formattedUtc);
    });

    it("returns empty string for invalid timestamp or invalid timeZone", () => {
      expect(formatInZone("invalid-iso", "UTC")).toBe("");
      expect(formatInZone("2026-10-02T06:00:00.000Z", "Invalid/Zone")).toBe("");
    });
  });
});
