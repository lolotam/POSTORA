import { assertEquals, assertThrows } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { analyticsWindowForPeriod, closedAnalyticsPeriods } from "./analyticsCalendar.ts";

Deno.test("closed calendar days handle spring/fall DST, leap day and year rollover", async (test) => {
  for (const fixture of [
    { now: "2026-03-10T03:00:00Z", timezone: "America/Los_Angeles", start: "2026-03-02T08:00:00.000Z", end: "2026-03-09T07:00:00.000Z", hours: 167 },
    { now: "2026-11-03T03:00:00Z", timezone: "America/Los_Angeles", start: "2026-10-26T07:00:00.000Z", end: "2026-11-02T08:00:00.000Z", hours: 169 },
    { now: "2024-03-03T12:00:00Z", timezone: "UTC", start: "2024-02-25T00:00:00.000Z", end: "2024-03-03T00:00:00.000Z", hours: 168 },
    { now: "2026-01-03T12:00:00Z", timezone: "Asia/Kuwait", start: "2025-12-26T21:00:00.000Z", end: "2026-01-02T21:00:00.000Z", hours: 168 },
  ]) {
    await test.step(fixture.now + fixture.timezone, () => {
      const windows = closedAnalyticsPeriods({ now: fixture.now, days: 7, timezone: fixture.timezone });
      assertEquals(windows.current.period.since, fixture.start);
      assertEquals(windows.current.period.until, fixture.end);
      assertEquals((Date.parse(fixture.end) - Date.parse(fixture.start)) / 3_600_000, fixture.hours);
      assertEquals(windows.current.buckets.length, 7);
      assertEquals(windows.previous.period.until, windows.current.period.since);
      assertEquals(analyticsWindowForPeriod(windows.current.period), windows.current);
    });
  }
});

Deno.test("calendar boundaries refuse shifted periods and unsupported timezone/day representations", () => {
  const windows = closedAnalyticsPeriods({ now: "2026-11-01T04:00:00Z", days: 7, timezone: "America/Los_Angeles" });
  assertThrows(() => analyticsWindowForPeriod({ ...windows.current.period, since: "2026-10-24T00:00:00.000Z" }), RangeError);
  assertThrows(() => closedAnalyticsPeriods({ now: "invalid", days: 7, timezone: "UTC" }), RangeError);
  assertThrows(() => closedAnalyticsPeriods({ now: "2026-11-01T00:00:00Z", days: 7, timezone: "invalid/timezone" }), RangeError);
  assertThrows(() => closedAnalyticsPeriods({ now: "2011-12-31T12:00:00Z", days: 7, timezone: "Pacific/Apia" }), RangeError);
});
