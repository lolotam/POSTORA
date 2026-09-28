import { describe, expect, it } from "vitest";
import { moveKeepingLocalWallClock } from "./wallClockMove";

describe("DST wall clock", () => {
  it("refuses a local time that does not exist on the target day", () => {
    const previous = process.env.TZ;
    process.env.TZ = "America/New_York";
    try {
      const source = new Date("2026-03-07T07:30:00.000Z");
      expect(source.getHours()).toBe(2);
      expect(source.getMinutes()).toBe(30);
      const moved = moveKeepingLocalWallClock(
        source.toISOString(),
        new Date(2026, 2, 8),
        new Date("2026-03-01T00:00:00.000Z").getTime(),
      );
      expect(moved).toEqual({ ok: false, reason: "nonexistent" });
    } finally {
      process.env.TZ = previous;
    }
  });

  it("uses the earlier instant when the local time repeats after a fall-back", () => {
    const previous = process.env.TZ;
    process.env.TZ = "America/New_York";
    try {
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
    } finally {
      process.env.TZ = previous;
    }
  });
});
