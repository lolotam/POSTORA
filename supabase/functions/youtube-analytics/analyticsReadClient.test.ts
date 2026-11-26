import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createYouTubeAnalyticsReadClient } from "./analyticsReadClient.ts";
import {
  BAD_VIDEO_ID,
  DAILY,
  DAILY_MISSING_LAST_TWO,
  DAILY_MISSING_MIDDLE,
  DUPLICATE_VIDEO_ID,
  ERROR_400_UNSUPPORTED_QUERY,
  ERROR_401_AUTH,
  ERROR_403_API_NOT_CONFIGURED,
  ERROR_403_INSUFFICIENT_PERMISSIONS,
  ERROR_404_OTHER,
  ERROR_404_VIDEO_NOT_FOUND,
  ERROR_429_QUOTA,
  ERROR_503_BACKEND,
  EXPLICIT_NULL,
  FIXTURE_OTHER_VIDEO_ID,
  FIXTURE_VIDEO_ID,
  HEADER_MISMATCH,
  NEGATIVE_METRIC,
  NO_ROWS,
  OUT_OF_WINDOW_DAY,
  reportInput,
  TOP_VIDEOS,
  TOTALS,
  WRONG_WIDTH,
} from "./fixtures.ts";

interface RecordedRequest {
  url: URL;
  authorization: string | null;
  signal: AbortSignal | null | undefined;
}

function fakeFetch(...answers: Array<{ status: number; body: unknown } | Response | Error>) {
  const requests: RecordedRequest[] = [];
  const fetchImpl: typeof fetch = (input, init) => {
    requests.push({
      url: new URL(String(input)),
      authorization: new Headers(init?.headers).get("Authorization"),
      signal: init?.signal,
    });
    const answer = answers[Math.min(requests.length - 1, answers.length - 1)];
    if (answer instanceof Error) return Promise.reject(answer);
    if (answer instanceof Response) return Promise.resolve(answer);
    return Promise.resolve(Response.json(answer.body, { status: answer.status }));
  };
  return { fetchImpl, requests };
}

Deno.test("summary builds the exact structural query and maps all eight metrics", async () => {
  const { fetchImpl, requests } = fakeFetch({ status: 200, body: TOTALS });
  const result = await createYouTubeAnalyticsReadClient({ fetchImpl }).readSummary(
    "synthetic-token",
    reportInput(FIXTURE_VIDEO_ID),
  );
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.has_data, true);
    assertEquals(result.value.metrics.map((metric) => [metric.key, metric.unit, metric.value]), [
      ["views", "count", 11],
      ["watch_time", "minutes", 22],
      ["average_view_duration", "seconds", 3],
      ["subscribers_gained", "count", 4],
      ["subscribers_lost", "count", 1],
      ["likes", "count", 5],
      ["comments", "count", 2],
      ["shares", "count", 6],
    ]);
  }
  assertEquals(requests.length, 1);
  const url = requests[0].url;
  assertEquals(url.origin + url.pathname, "https://youtubeanalytics.googleapis.com/v2/reports");
  assertEquals(url.searchParams.get("ids"), "channel==UCfixturechannel000000001");
  assertEquals(url.searchParams.get("startDate"), "2026-11-11");
  assertEquals(url.searchParams.get("endDate"), "2026-11-17");
  assertEquals(url.searchParams.get("metrics"), "views,estimatedMinutesWatched,averageViewDuration,subscribersGained,subscribersLost,likes,comments,shares");
  assertEquals(url.searchParams.get("filters"), `video==${FIXTURE_VIDEO_ID}`);
  assertEquals(url.searchParams.get("dimensions"), null);
  assertEquals(requests[0].authorization, "Bearer synthetic-token");
  assert(requests[0].signal instanceof AbortSignal);
});

Deno.test("summary treats omitted, null and empty rows as no data, not zero", async () => {
  for (const body of [NO_ROWS, { ...NO_ROWS, rows: null }, { ...NO_ROWS, rows: [] }]) {
    const { fetchImpl } = fakeFetch({ status: 200, body });
    const result = await createYouTubeAnalyticsReadClient({ fetchImpl }).readSummary("t", reportInput());
    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value.has_data, false);
      assertEquals(result.value.metrics.length, 8);
      assertEquals(result.value.metrics.every((metric) => metric.value === null), true);
    }
  }
});

Deno.test("an explicit provider null stays null", async () => {
  const { fetchImpl } = fakeFetch({ status: 200, body: EXPLICIT_NULL });
  const result = await createYouTubeAnalyticsReadClient({ fetchImpl }).readSummary("t", reportInput());
  assertEquals(result.ok && result.value.metrics[0].value, null);
  assertEquals(result.ok && result.value.has_data, true);
});

for (const [name, body] of [
  ["header mismatch", HEADER_MISMATCH],
  ["wrong width", WRONG_WIDTH],
  ["negative metric", NEGATIVE_METRIC],
  ["multiple summary rows", { ...TOTALS, rows: [...TOTALS.rows, ...TOTALS.rows] }],
  ["string metric", { ...TOTALS, rows: [["11", 22, 3, 4, 1, 5, 2, 6]] }],
  ["boolean metric", { ...TOTALS, rows: [[true, 22, 3, 4, 1, 5, 2, 6]] }],
  ["missing rows cell", { ...TOTALS, rows: [[11, 22, 3, 4, 1, 5, 2]] }],
] as const) {
  Deno.test(`summary rejects ${name} as upstream_unavailable`, async () => {
    const { fetchImpl } = fakeFetch({ status: 200, body });
    assertEquals(await createYouTubeAnalyticsReadClient({ fetchImpl }).readSummary("t", reportInput()), {
      ok: false,
      code: "upstream_unavailable",
    });
  });
}

Deno.test("daily uses day dimension and sort and preserves sparse coverage without filling zeroes", async () => {
  const { fetchImpl, requests } = fakeFetch({ status: 200, body: DAILY_MISSING_MIDDLE });
  const result = await createYouTubeAnalyticsReadClient({ fetchImpl }).readDaily("t", reportInput());
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.rows.map((row) => row.day), [
      "2026-11-11",
      "2026-11-12",
      "2026-11-13",
      "2026-11-15",
      "2026-11-16",
      "2026-11-17",
    ]);
    assertEquals(result.value.coverage, {
      first_day: "2026-11-11",
      last_day: "2026-11-17",
      days_returned: 6,
      days_missing: 1,
    });
    assertEquals(result.value.rows.some((row) => row.day === "2026-11-14"), false);
  }
  assertEquals(requests[0].url.searchParams.get("dimensions"), "day");
  assertEquals(requests[0].url.searchParams.get("sort"), "day");
  assertEquals(requests[0].url.searchParams.get("metrics"), "views,estimatedMinutesWatched,subscribersGained,subscribersLost");
});

Deno.test("daily missing its last two days reports observed first and last days only", async () => {
  const { fetchImpl } = fakeFetch({ status: 200, body: DAILY_MISSING_LAST_TWO });
  const result = await createYouTubeAnalyticsReadClient({ fetchImpl }).readDaily("t", reportInput());
  assertEquals(result.ok && result.value.coverage, {
    first_day: "2026-11-11",
    last_day: "2026-11-15",
    days_returned: 5,
    days_missing: 2,
  });
});

Deno.test("daily sorts provider rows and handles missing rows as empty coverage", async () => {
  const reversed = { ...DAILY, rows: [...DAILY.rows].reverse() };
  const { fetchImpl, requests } = fakeFetch(
    { status: 200, body: reversed },
    { status: 200, body: { columnHeaders: DAILY.columnHeaders } },
  );
  const client = createYouTubeAnalyticsReadClient({ fetchImpl });
  const sorted = await client.readDaily("t", reportInput());
  assertEquals(sorted.ok && sorted.value.rows[0].day, "2026-11-11");
  const empty = await client.readDaily("t", reportInput());
  assertEquals(empty.ok && empty.value, {
    rows: [],
    coverage: { first_day: null, last_day: null, days_returned: 0, days_missing: 7 },
  });
  assertEquals(requests.length, 2);
});

for (const [name, body] of [
  ["out-of-window day", OUT_OF_WINDOW_DAY],
  ["duplicate day", { ...DAILY, rows: [DAILY.rows[0], DAILY.rows[0]] }],
  ["wrong width", { ...DAILY, rows: [["2026-11-11", 1, 2]] }],
  ["negative metric", { ...DAILY, rows: [["2026-11-11", -1, 2, 3, 0]] }],
] as const) {
  Deno.test(`daily rejects ${name}`, async () => {
    const { fetchImpl } = fakeFetch({ status: 200, body });
    assertEquals(await createYouTubeAnalyticsReadClient({ fetchImpl }).readDaily("t", reportInput()), {
      ok: false,
      code: "upstream_unavailable",
    });
  });
}

Deno.test("top videos uses the single documented metric list and accepts string IDs", async () => {
  const { fetchImpl, requests } = fakeFetch({ status: 200, body: TOP_VIDEOS });
  const result = await createYouTubeAnalyticsReadClient({ fetchImpl }).readTopVideos("t", reportInput());
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.rows.map((row) => row.videoId), [FIXTURE_VIDEO_ID, FIXTURE_OTHER_VIDEO_ID]);
    assertEquals(result.value.rows[0].metrics.map((metric) => metric.key), [
      "watch_time",
      "views",
      "likes",
      "subscribers_gained",
    ]);
  }
  const params = requests[0].url.searchParams;
  assertEquals(params.get("dimensions"), "video");
  assertEquals(params.get("metrics"), "estimatedMinutesWatched,views,likes,subscribersGained");
  assertEquals(params.get("sort"), "-views");
  assertEquals(params.get("maxResults"), "10");
});

Deno.test("top videos missing rows is empty and needs no title call", async () => {
  const { fetchImpl, requests } = fakeFetch({ status: 200, body: { columnHeaders: TOP_VIDEOS.columnHeaders } });
  const result = await createYouTubeAnalyticsReadClient({ fetchImpl }).readTopVideos("t", reportInput());
  assertEquals(result, { ok: true, value: { rows: [] } });
  assertEquals(requests.length, 1);
});

for (const [name, body] of [
  ["bad video ID", BAD_VIDEO_ID],
  ["duplicate video ID", DUPLICATE_VIDEO_ID],
  ["negative metric", { ...TOP_VIDEOS, rows: [[FIXTURE_VIDEO_ID, -1, 10, 4, 2]] }],
  ["wrong width", { ...TOP_VIDEOS, rows: [[FIXTURE_VIDEO_ID, 20, 10]] }],
  ["too many rows", { ...TOP_VIDEOS, rows: Array.from({ length: 11 }, (_, i) => [`video${String(i).padStart(7, "0")}`, 1, 1, 1, 1]) }],
] as const) {
  Deno.test(`top videos rejects ${name}`, async () => {
    const { fetchImpl } = fakeFetch({ status: 200, body });
    assertEquals(await createYouTubeAnalyticsReadClient({ fetchImpl }).readTopVideos("t", reportInput()), {
      ok: false,
      code: "upstream_unavailable",
    });
  });
}

Deno.test("ownership succeeds only for the admitted channel", async () => {
  const { fetchImpl, requests } = fakeFetch({
    status: 200,
    body: { items: [{ id: FIXTURE_VIDEO_ID, snippet: { channelId: "UCfixturechannel000000001" } }] },
  });
  const result = await createYouTubeAnalyticsReadClient({ fetchImpl }).lookupVideoOwnership("t", {
    channelId: "UCfixturechannel000000001",
    videoId: FIXTURE_VIDEO_ID,
  });
  assertEquals(result, { ok: true, value: { owned: true } });
  assertEquals(requests[0].url.origin + requests[0].url.pathname, "https://www.googleapis.com/youtube/v3/videos");
  assertEquals(requests[0].url.searchParams.get("part"), "snippet");
  assertEquals(requests[0].url.searchParams.get("id"), FIXTURE_VIDEO_ID);
});

for (const [name, status, body, code] of [
  ["200 unowned", 200, { items: [{ id: FIXTURE_VIDEO_ID, snippet: { channelId: "UCanother" } }] }, "video_not_found"],
  ["200 missing ID", 200, { items: [] }, "video_not_found"],
  ["200 omitted snippet.channelId", 200, { items: [{ id: FIXTURE_VIDEO_ID, snippet: {} }] }, "upstream_unavailable"],
  ["404 videoNotFound", 404, ERROR_404_VIDEO_NOT_FOUND, "video_not_found"],
  ["404 other reason", 404, ERROR_404_OTHER, "upstream_unavailable"],
  ["malformed 200", 200, {}, "upstream_unavailable"],
] as const) {
  Deno.test(`ownership maps ${name} without confusing failure with absence`, async () => {
    const { fetchImpl } = fakeFetch({ status, body });
    assertEquals(await createYouTubeAnalyticsReadClient({ fetchImpl }).lookupVideoOwnership("t", {
      channelId: "UCfixturechannel000000001",
      videoId: FIXTURE_VIDEO_ID,
    }), { ok: false, code });
  });
}

Deno.test("title lookup validates IDs and accepts titles only from the admitted channel", async () => {
  const { fetchImpl, requests } = fakeFetch({
    status: 200,
    body: {
      items: [
        { id: FIXTURE_VIDEO_ID, snippet: { channelId: "UCfixturechannel000000001", title: "Synthetic title" } },
        { id: FIXTURE_OTHER_VIDEO_ID, snippet: { channelId: "UCanother", title: "Not admitted" } },
      ],
    },
  });
  const client = createYouTubeAnalyticsReadClient({ fetchImpl });
  assertEquals(await client.lookupVideoTitles("t", {
    channelId: "UCfixturechannel000000001",
    videoIds: [FIXTURE_VIDEO_ID, FIXTURE_OTHER_VIDEO_ID],
  }), { ok: true, value: { titles: { [FIXTURE_VIDEO_ID]: "Synthetic title" } } });
  assertEquals(requests[0].url.searchParams.get("id"), `${FIXTURE_VIDEO_ID},${FIXTURE_OTHER_VIDEO_ID}`);
  assertEquals(await client.lookupVideoTitles("t", {
    channelId: "UCfixturechannel000000001",
    videoIds: ["bad/id"],
  }), { ok: false, code: "upstream_unavailable" });
  assertEquals(requests.length, 1);
});

for (const [name, status, body, code] of [
  ["unsupported query", 400, ERROR_400_UNSUPPORTED_QUERY, "upstream_unavailable"],
  ["API not enabled", 403, ERROR_403_API_NOT_CONFIGURED, "upstream_unavailable"],
  ["insufficient permissions", 403, ERROR_403_INSUFFICIENT_PERMISSIONS, "missing_scope"],
  ["quota", 429, ERROR_429_QUOTA, "quota_exceeded"],
  ["auth", 401, ERROR_401_AUTH, "unauthorized"],
  ["backend", 503, ERROR_503_BACKEND, "upstream_unavailable"],
  ["other 404", 404, ERROR_404_OTHER, "upstream_unavailable"],
] as const) {
  Deno.test(`provider classifier maps ${name} without exposing provider text`, async () => {
    const { fetchImpl } = fakeFetch({ status, body });
    const result = await createYouTubeAnalyticsReadClient({ fetchImpl }).readSummary("t", reportInput());
    assertEquals(result, { ok: false, code });
    assertEquals(JSON.stringify(result).includes("synthetic provider text"), false);
  });
}

Deno.test("network failures and malformed JSON are upstream_unavailable, while empty 401 stays unauthorized", async () => {
  const network = fakeFetch(new TypeError("offline"));
  assertEquals(await createYouTubeAnalyticsReadClient({ fetchImpl: network.fetchImpl }).readSummary("t", reportInput()), {
    ok: false,
    code: "upstream_unavailable",
  });
  const malformed = fakeFetch(new Response("not-json", { status: 200, headers: { "content-type": "application/json" } }));
  assertEquals(await createYouTubeAnalyticsReadClient({ fetchImpl: malformed.fetchImpl }).readSummary("t", reportInput()), {
    ok: false,
    code: "upstream_unavailable",
  });
  const empty401 = fakeFetch(new Response("", { status: 401 }));
  assertEquals(await createYouTubeAnalyticsReadClient({ fetchImpl: empty401.fetchImpl }).readSummary("t", reportInput()), {
    ok: false,
    code: "unauthorized",
  });
});
