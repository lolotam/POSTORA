import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

import {
  effectiveYoutubePrivacy,
  hasYoutubeScheduleRequest,
  resolveYoutubePublishAt,
  YOUTUBE_PUBLISH_AT_MIN_LEAD_MS,
  type YoutubePublishAtInvalidReason,
} from "./youtubePublishOptions.ts";

const NOW = new Date("2026-11-27T10:00:00.000Z");

Deno.test("hasYoutubeScheduleRequest is false only for undefined, null, and empty string", () => {
  const absentCases: Array<Record<string, unknown> | null | undefined> = [
    undefined,
    null,
    {},
    { youtube_publish_at: undefined },
    { youtube_publish_at: null },
    { youtube_publish_at: "" },
  ];
  for (const metadata of absentCases) {
    assertEquals(hasYoutubeScheduleRequest(metadata), false);
  }

  const presentCases: unknown[] = [
    "2026-12-01T12:00:00Z",
    "   ",
    0,
    1700000000,
    false,
    {},
    [],
  ];
  for (const value of presentCases) {
    assertEquals(hasYoutubeScheduleRequest({ youtube_publish_at: value }), true);
  }
});

Deno.test("resolveYoutubePublishAt accepts valid RFC 3339 timestamps within bounds and normalises to UTC ISO", () => {
  const exactMin = new Date(NOW.getTime() + YOUTUBE_PUBLISH_AT_MIN_LEAD_MS).toISOString();
  const exactMax = new Date(NOW.getTime());
  exactMax.setUTCFullYear(exactMax.getUTCFullYear() + 2);

  const validCases: Array<[string, string]> = [
    ["2026-11-27T10:15:00Z", exactMin],
    ["2026-11-27T13:15:00+03:00", "2026-11-27T10:15:00.000Z"],
    [exactMax.toISOString(), exactMax.toISOString()],
  ];

  for (const [input, expected] of validCases) {
    assertEquals(resolveYoutubePublishAt(input, NOW), {
      ok: true,
      publishAt: expected,
    });
  }
});

Deno.test("resolveYoutubePublishAt rejects invalid, out-of-window, and wrong-type values with exact reasons", () => {
  const tooSoon = new Date(NOW.getTime() + YOUTUBE_PUBLISH_AT_MIN_LEAD_MS - 1000).toISOString();
  const tooFarDate = new Date(NOW.getTime());
  tooFarDate.setUTCFullYear(tooFarDate.getUTCFullYear() + 2);
  const tooFar = new Date(tooFarDate.getTime() + 1).toISOString();

  const invalidCases: Array<[unknown, YoutubePublishAtInvalidReason]> = [
    [NOW.toISOString(), "expired"],
    ["2026-11-27T09:59:59Z", "expired"],
    [tooSoon, "too_soon"],
    [tooFar, "too_far"],
    ["2026-12-01T12:00:00", "malformed"],
    ["2026-02-30T12:00:00Z", "malformed"],
    ["2026-02-29T12:00:00Z", "malformed"],
    ["2026-11-27T25:00:00Z", "malformed"],
    ["2026-11-27T12:00:00+25:00", "malformed"],
    ["   ", "malformed"],
    ["not-a-date", "malformed"],
    [1700000000, "wrong_type"],
    [true, "wrong_type"],
    [{}, "wrong_type"],
    [[], "wrong_type"],
    [null, "wrong_type"],
  ];

  for (const [input, reason] of invalidCases) {
    assertEquals(resolveYoutubePublishAt(input, NOW), { ok: false, reason });
  }
});

Deno.test("effectiveYoutubePrivacy preserves visibility when unscheduled and forces private when scheduled", () => {
  assertEquals(effectiveYoutubePrivacy(undefined), "private");
  assertEquals(effectiveYoutubePrivacy({ youtube_visibility: "public" }), "public");
  assertEquals(
    effectiveYoutubePrivacy({ youtube_visibility: "unlisted", youtube_publish_at: null }),
    "unlisted",
  );
  assertEquals(
    effectiveYoutubePrivacy({ youtube_visibility: "public", youtube_publish_at: "" }),
    "public",
  );

  for (const publishAt of [
    "2026-12-01T12:00:00Z",
    "2020-01-01T00:00:00Z",
    "not-a-date",
    "   ",
    1700000000,
  ]) {
    assertEquals(
      effectiveYoutubePrivacy({ youtube_visibility: "public", youtube_publish_at: publishAt }),
      "private",
    );
    assertEquals(
      effectiveYoutubePrivacy({ youtube_visibility: "unlisted", youtube_publish_at: publishAt }),
      "private",
    );
  }
});
