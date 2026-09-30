import { afterEach, describe, expect, it, vi } from "vitest";
import {
  moveKeepingLocalWallClock,
  parseDatetimeLocal,
  resolveLocalWallClock,
} from "./wallClockMove";

describe("DST wall clock", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("refuses a local time that does not exist on the target day", () => {
    vi.stubEnv("TZ", "America/New_York");
    const source = new Date("2026-03-07T07:30:00.000Z");
    expect(source.getHours()).toBe(2);
    expect(source.getMinutes()).toBe(30);
    const moved = moveKeepingLocalWallClock(
      source.toISOString(),
      new Date(2026, 2, 8),
      new Date("2026-03-01T00:00:00.000Z").getTime(),
    );
    expect(moved).toEqual({ ok: false, reason: "nonexistent" });
  });

  it("uses the earlier instant when the local time repeats after a fall-back", () => {
    vi.stubEnv("TZ", "America/New_York");
    const source = new Date(2026, 10, 2, 1, 30, 0, 0);
    const moved = moveKeepingLocalWallClock(
      source.toISOString(),
      new Date(2026, 10, 1),
      new Date("2026-10-01T00:00:00.000Z").getTime(),
    );
    if (moved.ok === false) throw new Error(moved.reason);
    const chosen = new Date(moved.iso);
    const later = new Date(chosen.getTime() + 60 * 60 * 1000);
    expect(chosen.getHours()).toBe(1);
    expect(chosen.getMinutes()).toBe(30);
    expect(later.getHours()).toBe(1);
    expect(later.getMinutes()).toBe(30);
    expect(chosen.getTime()).toBeLessThan(later.getTime());
  });

  it("reports ambiguous: true for a repeated wall time during fall-back DST", () => {
    vi.stubEnv("TZ", "America/New_York");
    // In America/New_York, clocks fall back on Nov 1, 2026: 01:30 repeats.
    const resolved = resolveLocalWallClock(2026, 10, 1, 1, 30);
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.ambiguous).toBe(true);
    }

    const parsed = parseDatetimeLocal("2026-11-01T01:30");
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.ambiguous).toBe(true);
    }
  });

  it("refuses a nonexistent time in a spring-forward DST gap rather than silently shifting it", () => {
    // In Europe/London, clocks spring forward on the last Sunday of March 2027 (March 28, 2027).
    // At 01:00 GMT, clocks jump forward to 02:00 BST.
    // Therefore, 01:30 wall clock does not exist.
    vi.stubEnv("TZ", "Europe/London");
    const gapResolution = resolveLocalWallClock(2027, 2, 28, 1, 30);
    expect(gapResolution).toEqual({
      ok: false,
      reason: "nonexistent",
    });
  });
});

