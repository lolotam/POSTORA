import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createYouTubeAnalyticsReadClient } from "./analyticsReadClient.ts";
import {
  BAD_VIDEO_ID,
  DAILY,
  DAILY_MISSING_LAST_TWO,
  DAILY_MISSING_MIDDLE,
  DEVICES,
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
  GEOGRAPHY,
  HEADER_MISMATCH,
  NEGATIVE_METRIC,
  NEGATIVE_NET_TOP_VIDEOS,
  NEGATIVE_NET_TOTALS,
  NO_ROWS,
  OUT_OF_WINDOW_DAY,
  reportInput,
  RETENTION,
  TOP_VIDEOS,
  TOTALS,
  TRAFFIC_SOURCES,
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

Deno.test("summary accepts negative net likes, comments and shares", async () => {
  const { fetchImpl } = fakeFetch({ status: 200, body: NEGATIVE_NET_TOTALS });
  const result = await createYouTubeAnalyticsReadClient({ fetchImpl }).readSummary("t", reportInput());
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.metrics.map((metric) => [metric.key, metric.value]), [
      ["views", 59],
      ["watch_time", 10],
      ["average_view_duration", 14],
      ["subscribers_gained", 0],
      ["subscribers_lost", 1],
      ["likes", -2],
      ["comments", -1],
      ["shares", -3],
    ]);
  }
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
  assertEquals(params.get("startIndex"), "1");
});

Deno.test("top videos forwards the requested start index", async () => {
  const { fetchImpl, requests } = fakeFetch({ status: 200, body: TOP_VIDEOS });
  await createYouTubeAnalyticsReadClient({ fetchImpl }).readTopVideos("t", { ...reportInput(), startIndex: 11 });
  assertEquals(requests[0].url.searchParams.get("startIndex"), "11");
});

Deno.test("top videos accepts a negative net likes value", async () => {
  const { fetchImpl } = fakeFetch({ status: 200, body: NEGATIVE_NET_TOP_VIDEOS });
  const result = await createYouTubeAnalyticsReadClient({ fetchImpl }).readTopVideos("t", reportInput());
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.rows[0].metrics.map((metric) => [metric.key, metric.value]), [
      ["watch_time", 20],
      ["views", 10],
      ["likes", -1],
      ["subscribers_gained", 2],
    ]);
  }
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
        {
          id: FIXTURE_VIDEO_ID,
          snippet: {
            channelId: "UCfixturechannel000000001",
            title: "Synthetic title",
            publishedAt: "2026-11-01T12:00:00Z",
            thumbnails: { medium: { url: "https://i.ytimg.com/vi/videoAAAAAAA/mqdefault.jpg" } },
          },
        },
        { id: FIXTURE_OTHER_VIDEO_ID, snippet: { channelId: "UCanother", title: "Not admitted" } },
      ],
    },
  });
  const client = createYouTubeAnalyticsReadClient({ fetchImpl });
  assertEquals(await client.lookupVideoTitles("t", {
    channelId: "UCfixturechannel000000001",
    videoIds: [FIXTURE_VIDEO_ID, FIXTURE_OTHER_VIDEO_ID],
  }), {
    ok: true,
    value: {
      titles: { [FIXTURE_VIDEO_ID]: "Synthetic title" },
      details: {
        [FIXTURE_VIDEO_ID]: {
          published_at: "2026-11-01T12:00:00Z",
          thumbnail_url: "https://i.ytimg.com/vi/videoAAAAAAA/mqdefault.jpg",
        },
      },
    },
  });
  assertEquals(requests[0].url.searchParams.get("id"), `${FIXTURE_VIDEO_ID},${FIXTURE_OTHER_VIDEO_ID}`);
  assertEquals(requests[0].url.searchParams.get("part"), "snippet");
  assertEquals(await client.lookupVideoTitles("t", {
    channelId: "UCfixturechannel000000001",
    videoIds: ["bad/id"],
  }), { ok: false, code: "upstream_unavailable" });
  assertEquals(requests.length, 1);
});

Deno.test("title lookup nulls invalid dates and unsafe thumbnails without another provider call", async () => {
  const { fetchImpl, requests } = fakeFetch({
    status: 200,
    body: {
      items: [{
        id: FIXTURE_VIDEO_ID,
        snippet: {
          channelId: "UCfixturechannel000000001",
          title: "Synthetic title",
          publishedAt: "not-a-date",
          thumbnails: {
            medium: { url: "http://i.ytimg.com/vi/videoAAAAAAA/mqdefault.jpg" },
            high: { url: "https://i.ytimg.com/vi/videoAAAAAAA/hqdefault.jpg" },
          },
        },
      }],
    },
  });
  const result = await createYouTubeAnalyticsReadClient({ fetchImpl }).lookupVideoTitles("t", {
    channelId: "UCfixturechannel000000001",
    videoIds: [FIXTURE_VIDEO_ID],
  });
  assertEquals(result, {
    ok: true,
    value: {
      titles: { [FIXTURE_VIDEO_ID]: "Synthetic title" },
      details: { [FIXTURE_VIDEO_ID]: { published_at: null, thumbnail_url: null } },
    },
  });
  assertEquals(requests.length, 1);
});

Deno.test("title lookup rejects non-ytimg thumbnail hosts", async () => {
  const { fetchImpl } = fakeFetch({
    status: 200,
    body: {
      items: [{
        id: FIXTURE_VIDEO_ID,
        snippet: {
          channelId: "UCfixturechannel000000001",
          publishedAt: "2026-11-01T12:00:00Z",
          thumbnails: { default: { url: "https://ytimg.com.attacker.example/image.jpg" } },
        },
      }],
    },
  });
  const result = await createYouTubeAnalyticsReadClient({ fetchImpl }).lookupVideoTitles("t", {
    channelId: "UCfixturechannel000000001",
    videoIds: [FIXTURE_VIDEO_ID],
  });
  assertEquals(result.ok && result.value.details[FIXTURE_VIDEO_ID], {
    published_at: "2026-11-01T12:00:00Z",
    thumbnail_url: null,
  });
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

for (const spec of [
  {
    kind: "traffic_sources" as const,
    dimension: "traffic_source" as const,
    googleDimension: "insightTrafficSourceType",
    fixture: TRAFFIC_SOURCES,
    expectedMaxResults: null,
    badKey: "yt-search",
    duplicateKey: "YT_SEARCH",
    maxRows: 40,
    makeKey: (i: number) => `SOURCE_${i}`,
  },
  {
    kind: "geography" as const,
    dimension: "country" as const,
    googleDimension: "country",
    fixture: GEOGRAPHY,
    expectedMaxResults: "25",
    badKey: "EGY",
    duplicateKey: "EG",
    maxRows: 25,
    makeKey: (i: number) => `${String.fromCharCode(65 + Math.floor(i / 26))}${String.fromCharCode(65 + (i % 26))}`,
  },
  {
    kind: "devices" as const,
    dimension: "device" as const,
    googleDimension: "deviceType",
    fixture: DEVICES,
    expectedMaxResults: null,
    badKey: "mobile",
    duplicateKey: "MOBILE",
    maxRows: 20,
    makeKey: (i: number) => `DEVICE_${i}`,
  },
]) {
  Deno.test(`breakdown ${spec.kind} builds the exact query and maps rows`, async () => {
    const { fetchImpl, requests } = fakeFetch({ status: 200, body: spec.fixture });
    const result = await createYouTubeAnalyticsReadClient({ fetchImpl }).readBreakdown("t", spec.kind, reportInput());
    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value.dimension, spec.dimension);
      assertEquals(result.value.has_data, true);
      assertEquals(result.value.rows.length, 2);
      assertEquals(result.value.rows[0].key, spec.fixture.rows[0][0]);
      assertEquals(result.value.rows[0].metrics.map((metric) => [metric.key, metric.value]), [
        ["views", spec.fixture.rows[0][1] as number],
        ["watch_time", spec.fixture.rows[0][2] as number],
      ]);
    }
    const params = requests[0].url.searchParams;
    assertEquals(params.get("dimensions"), spec.googleDimension);
    assertEquals(params.get("metrics"), "views,estimatedMinutesWatched");
    assertEquals(params.get("sort"), "-views");
    assertEquals(params.get("maxResults"), spec.expectedMaxResults);
  });

  Deno.test(`breakdown ${spec.kind} treats omitted, null and empty rows as has_data: false`, async () => {
    for (const body of [
      { columnHeaders: spec.fixture.columnHeaders },
      { columnHeaders: spec.fixture.columnHeaders, rows: null },
      { columnHeaders: spec.fixture.columnHeaders, rows: [] },
    ]) {
      const { fetchImpl } = fakeFetch({ status: 200, body });
      const result = await createYouTubeAnalyticsReadClient({ fetchImpl }).readBreakdown("t", spec.kind, reportInput());
      assertEquals(result, {
        ok: true,
        value: { dimension: spec.dimension, rows: [], has_data: false },
      });
    }
  });

  for (const [name, body] of [
    ["header mismatch", { columnHeaders: [{ name: "wrong" }, ...spec.fixture.columnHeaders.slice(1)], rows: spec.fixture.rows }],
    ["bad key", { ...spec.fixture, rows: [[spec.badKey, 10, 5]] }],
    ["duplicate key", { ...spec.fixture, rows: [[spec.duplicateKey, 10, 5], [spec.duplicateKey, 5, 2]] }],
    ["negative metric", { ...spec.fixture, rows: [[spec.duplicateKey, -1, 5]] }],
    ["too many rows", {
      ...spec.fixture,
      rows: Array.from({ length: spec.maxRows + 1 }, (_, i) => [spec.makeKey(i), 10, 5]),
    }],
  ] as const) {
    Deno.test(`breakdown ${spec.kind} rejects ${name}`, async () => {
      const { fetchImpl } = fakeFetch({ status: 200, body });
      assertEquals(await createYouTubeAnalyticsReadClient({ fetchImpl }).readBreakdown("t", spec.kind, reportInput()), {
        ok: false,
        code: "upstream_unavailable",
      });
    });
  }
}

Deno.test("retention builds the exact query and maps points", async () => {
  const { fetchImpl, requests } = fakeFetch({ status: 200, body: RETENTION });
  const result = await createYouTubeAnalyticsReadClient({ fetchImpl }).readRetention("t", {
    ...reportInput(),
    videoId: FIXTURE_VIDEO_ID,
  });
  assertEquals(result, {
    ok: true,
    value: {
      has_data: true,
      points: [
        { ratio: 0.01, watch_ratio: 1.0, relative_performance: 0.5 },
        { ratio: 0.5, watch_ratio: 0.72, relative_performance: 0.61 },
        { ratio: 1.0, watch_ratio: 0.41, relative_performance: 0.55 },
      ],
    },
  });
  const params = requests[0].url.searchParams;
  assertEquals(params.get("dimensions"), "elapsedVideoTimeRatio");
  assertEquals(params.get("metrics"), "audienceWatchRatio,relativeRetentionPerformance");
  assertEquals(params.get("filters"), `video==${FIXTURE_VIDEO_ID}`);
  assertEquals(params.get("sort"), "elapsedVideoTimeRatio");
});

Deno.test("retention treats omitted, null and empty rows as has_data: false", async () => {
  for (const body of [
    { columnHeaders: RETENTION.columnHeaders },
    { columnHeaders: RETENTION.columnHeaders, rows: null },
    { columnHeaders: RETENTION.columnHeaders, rows: [] },
  ]) {
    const { fetchImpl } = fakeFetch({ status: 200, body });
    assertEquals(
      await createYouTubeAnalyticsReadClient({ fetchImpl }).readRetention("t", {
        ...reportInput(),
        videoId: FIXTURE_VIDEO_ID,
      }),
      { ok: true, value: { points: [], has_data: false } },
    );
  }
});

Deno.test("retention accepts null watch_ratio and relative_performance", async () => {
  const { fetchImpl } = fakeFetch({
    status: 200,
    body: { columnHeaders: RETENTION.columnHeaders, rows: [[0.5, null, null]] },
  });
  assertEquals(
    await createYouTubeAnalyticsReadClient({ fetchImpl }).readRetention("t", {
      ...reportInput(),
      videoId: FIXTURE_VIDEO_ID,
    }),
    {
      ok: true,
      value: {
        has_data: true,
        points: [{ ratio: 0.5, watch_ratio: null, relative_performance: null }],
      },
    },
  );
});

for (const [name, body] of [
  ["header mismatch", { columnHeaders: [{ name: "wrong" }, ...RETENTION.columnHeaders.slice(1)], rows: RETENTION.rows }],
  ["ratio zero", { ...RETENTION, rows: [[0, 1.0, 0.5]] }],
  ["ratio above 1", { ...RETENTION, rows: [[1.01, 1.0, 0.5]] }],
  ["non-ascending ratio", { ...RETENTION, rows: [[0.5, 0.8, 0.5], [0.5, 0.7, 0.5]] }],
  ["descending ratio", { ...RETENTION, rows: [[0.6, 0.8, 0.5], [0.4, 0.7, 0.5]] }],
  ["negative watch_ratio", { ...RETENTION, rows: [[0.5, -0.1, 0.5]] }],
  ["relative_performance above 1", { ...RETENTION, rows: [[0.5, 0.8, 1.1]] }],
  ["negative relative_performance", { ...RETENTION, rows: [[0.5, 0.8, -0.1]] }],
  ["wrong row width", { ...RETENTION, rows: [[0.5, 0.8]] }],
  ["too many points", {
    ...RETENTION,
    rows: Array.from({ length: 101 }, (_, i) => [(i + 1) / 101, 0.5, 0.5]),
  }],
] as const) {
  Deno.test(`retention rejects ${name}`, async () => {
    const { fetchImpl } = fakeFetch({ status: 200, body });
    assertEquals(
      await createYouTubeAnalyticsReadClient({ fetchImpl }).readRetention("t", {
        ...reportInput(),
        videoId: FIXTURE_VIDEO_ID,
      }),
      { ok: false, code: "upstream_unavailable" },
    );
  });
}
