import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { pacificDateString, YOUTUBE_PACIFIC_TIME_ZONE } from "./pacificDay.ts";

Deno.test("pacificDateString uses America/Los_Angeles across UTC midnight and DST transitions", () => {
  assertEquals(YOUTUBE_PACIFIC_TIME_ZONE, "America/Los_Angeles");

  // Winter (PST = UTC-8): 2026-01-15T07:59:59Z is 2026-01-14 23:59:59 PST
  assertEquals(pacificDateString(new Date("2026-01-15T07:59:59Z")), "2026-01-14");
  assertEquals(pacificDateString(new Date("2026-01-15T08:00:00Z")), "2026-01-15");

  // Spring forward (2026-03-08 02:00 PST -> 03:00 PDT = UTC-7):
  // 2026-03-09T06:59:59Z is 2026-03-08 23:59:59 PDT
  assertEquals(pacificDateString(new Date("2026-03-09T06:59:59Z")), "2026-03-08");
  assertEquals(pacificDateString(new Date("2026-03-09T07:00:00Z")), "2026-03-09");

  // Fall back (2026-11-01 02:00 PDT -> 01:00 PST = UTC-8):
  // 2026-11-02T07:59:59Z is 2026-11-01 23:59:59 PST
  assertEquals(pacificDateString(new Date("2026-11-02T07:59:59Z")), "2026-11-01");
  assertEquals(pacificDateString(new Date("2026-11-02T08:00:00Z")), "2026-11-02");
});
