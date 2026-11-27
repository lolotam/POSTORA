import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { YouTubeResourceErrorCode } from "./contracts.ts";
import { createYouTubeReadClient } from "./youtubeReadClient.ts";

const CHANNEL_ID = "UCfixturechannel000000001";

function fakeFetch(status: number, body: unknown) {
  const requests: Array<{ url: URL; authorization: string | null }> = [];
  const fetchImpl: typeof fetch = (input, init) => {
    requests.push({
      url: new URL(String(input)),
      authorization: new Headers(init?.headers).get("Authorization"),
    });
    return Promise.resolve(Response.json(body, { status }));
  };
  return { fetchImpl, requests };
}

function fakeFetchSequence(responses: Array<{ status: number; body: unknown }>) {
  const requests: Array<{ url: URL; authorization: string | null }> = [];
  const queue = [...responses];
  const fetchImpl: typeof fetch = (input, init) => {
    requests.push({
      url: new URL(String(input)),
      authorization: new Headers(init?.headers).get("Authorization"),
    });
    const next = queue.shift();
    if (!next) return Promise.reject(new TypeError("unexpected request"));
    return Promise.resolve(Response.json(next.body, { status: next.status }));
  };
  return { fetchImpl, requests };
}

function client(fetchImpl: typeof fetch) {
  return createYouTubeReadClient({
    fetchImpl,
    uploadsPlaylistIdFor: (channelId) => `UU${channelId.slice(2)}`,
  });
}

Deno.test("getChannel asks for the caller's own channel and maps the stored one", async () => {
  const token = crypto.randomUUID();
  const { fetchImpl, requests } = fakeFetch(200, {
    items: [{
      id: CHANNEL_ID,
      snippet: {
        title: "Fixture channel",
        description: "About",
        customUrl: "@fixture",
        publishedAt: "2020-01-01T00:00:00Z",
        country: "KW",
        thumbnails: { medium: { url: "https://yt3.example/medium.jpg" } },
      },
      statistics: { viewCount: "1200", subscriberCount: "34", hiddenSubscriberCount: false, videoCount: "7" },
      status: { privacyStatus: "public" },
    }],
  });
  const result = await client(fetchImpl).getChannel(token, { channelId: CHANNEL_ID });

  assertEquals(requests.length, 1);
  assertEquals(requests[0].url.pathname, "/youtube/v3/channels");
  assertEquals(requests[0].url.searchParams.get("mine"), "true");
  assertEquals(requests[0].url.searchParams.get("part"), "snippet,statistics,status");
  assertEquals(requests[0].authorization, `Bearer ${token}`);
  assertEquals(result, {
    ok: true,
    value: {
      id: CHANNEL_ID,
      title: "Fixture channel",
      description: "About",
      custom_url: "@fixture",
      thumbnail_url: "https://yt3.example/medium.jpg",
      published_at: "2020-01-01T00:00:00Z",
      country: "KW",
      privacy_status: "public",
      statistics: { view_count: 1200, subscriber_count: 34, subscriber_count_hidden: false, video_count: 7 },
    },
  });
});

Deno.test("getChannel reports reconnect_required when the grant no longer covers the stored channel", async () => {
  const { fetchImpl } = fakeFetch(200, { items: [{ id: "UCanotherchannel0000000002" }] });
  const result = await client(fetchImpl).getChannel("t", { channelId: CHANNEL_ID });
  assertEquals(result, { ok: false, code: "reconnect_required", unauthorized: false });
});

Deno.test("a hidden subscriber count is null, not zero", async () => {
  const { fetchImpl } = fakeFetch(200, {
    items: [{ id: CHANNEL_ID, statistics: { hiddenSubscriberCount: true, subscriberCount: "0" } }],
  });
  const result = await client(fetchImpl).getChannel("t", { channelId: CHANNEL_ID });
  assertEquals(result.ok && result.value.statistics, {
    view_count: null,
    subscriber_count: null,
    subscriber_count_hidden: true,
    video_count: null,
  });
});

Deno.test("counter strings that are not plain digits are absent data, not zero", async () => {
  const { fetchImpl } = fakeFetch(200, {
    items: [{
      id: CHANNEL_ID,
      statistics: {
        viewCount: "1e3",
        subscriberCount: " ",
        videoCount: "0x10",
      },
    }],
  });
  const result = await client(fetchImpl).getChannel("t", { channelId: CHANNEL_ID });
  assertEquals(result.ok && result.value.statistics, {
    view_count: null,
    subscriber_count: null,
    subscriber_count_hidden: false,
    video_count: null,
  });
});

Deno.test("a plain digit string and a real number still count", async () => {
  const { fetchImpl } = fakeFetch(200, {
    items: [
      { id: CHANNEL_ID, statistics: { viewCount: "123", videoCount: 7 } },
    ],
  });
  const result = await client(fetchImpl).getChannel("t", { channelId: CHANNEL_ID });
  assertEquals(result.ok && result.value.statistics, {
    view_count: 123,
    subscriber_count: null,
    subscriber_count_hidden: false,
    video_count: 7,
  });
});

const GOOGLE_ERRORS: Array<[string, number, unknown, YouTubeResourceErrorCode, boolean]> = [
  ["scope", 403, { error: { message: "secret provider text", errors: [{ reason: "insufficientPermissions" }] } }, "missing_scope", false],
  ["quota", 403, { error: { errors: [{ reason: "quotaExceeded" }] } }, "quota_exceeded", false],
  ["expired token", 401, { error: { errors: [{ reason: "authError" }] } }, "reconnect_required", true],
  ["not found", 404, { error: {} }, "not_found", false],
  ["forbidden", 403, { error: { errors: [{ reason: "forbidden" }] } }, "not_found", false],
  ["server error", 503, null, "upstream_unavailable", false],
];

for (const [name, status, body, code, unauthorized] of GOOGLE_ERRORS) {
  Deno.test(`a Google ${name} answer becomes ${code} without provider text`, async () => {
    const { fetchImpl } = fakeFetch(status, body);
    const result = await client(fetchImpl).getChannel("t", { channelId: CHANNEL_ID });
    assertEquals(result, { ok: false, code, unauthorized });
    assertEquals(JSON.stringify(result).includes("secret provider text"), false);
  });
}

Deno.test("a network failure is upstream_unavailable", async () => {
  const fetchImpl: typeof fetch = () => Promise.reject(new TypeError("connection refused to https://internal"));
  const result = await client(fetchImpl).getChannel("t", { channelId: CHANNEL_ID });
  assertEquals(result, { ok: false, code: "upstream_unavailable", unauthorized: false });
});

Deno.test("a body that is not the documented shape is upstream_unavailable, not an empty channel", async () => {
  const { fetchImpl } = fakeFetch(200, { items: "not-an-array" });
  const result = await client(fetchImpl).getChannel("t", { channelId: CHANNEL_ID });
  assertEquals(result, { ok: false, code: "upstream_unavailable", unauthorized: false });
});

Deno.test("listUploads pages the channel's own uploads playlist", async () => {
  const { fetchImpl, requests } = fakeFetch(200, {
    nextPageToken: "CAUQAA",
    pageInfo: { totalResults: 60 },
    items: [
      {
        snippet: {
          title: "First video",
          publishedAt: "2026-11-01T00:00:00Z",
          resourceId: { videoId: "videoAAAAAAA" },
          thumbnails: { default: { url: "https://i.ytimg.example/a.jpg" } },
        },
        contentDetails: { videoId: "videoAAAAAAA", videoPublishedAt: "2026-10-31T00:00:00Z" },
        status: { privacyStatus: "unlisted" },
      },
      { snippet: { title: "Item without a video id" } },
    ],
  });
  const result = await client(fetchImpl).listUploads("t", {
    channelId: CHANNEL_ID,
    pageSize: 25,
    pageToken: "CAoQAA",
  });

  assertEquals(requests[0].url.pathname, "/youtube/v3/playlistItems");
  assertEquals(requests[0].url.searchParams.get("playlistId"), `UU${CHANNEL_ID.slice(2)}`);
  assertEquals(requests[0].url.searchParams.get("maxResults"), "25");
  assertEquals(requests[0].url.searchParams.get("pageToken"), "CAoQAA");
  assertEquals(requests[0].url.searchParams.get("part"), "snippet,contentDetails,status");
  assertEquals(requests.length, 2);
  assertEquals(requests[1].url.pathname, "/youtube/v3/videos");
  assertEquals(requests[1].url.searchParams.get("part"), "snippet,contentDetails,statistics,status");
  assertEquals(requests[1].url.searchParams.get("id"), "videoAAAAAAA");
  assertEquals(result, {
    ok: true,
    value: {
      items: [{
        id: "videoAAAAAAA",
        title: "First video",
        thumbnail_url: "https://i.ytimg.example/a.jpg",
        published_at: "2026-10-31T00:00:00Z",
        privacy_status: "unlisted",
        url: "https://www.youtube.com/watch?v=videoAAAAAAA",
        description: null,
        duration_iso8601: null,
        statistics: { view_count: null, like_count: null, comment_count: null },
      }],
      next_page_token: "CAUQAA",
      total_results: 60,
    },
  });
});

Deno.test("the first page sends no pageToken and the last page has none to give", async () => {
  const { fetchImpl, requests } = fakeFetch(200, { items: [] });
  const result = await client(fetchImpl).listUploads("t", { channelId: CHANNEL_ID, pageSize: 50 });
  assertEquals(requests[0].url.searchParams.has("pageToken"), false);
  assertEquals(requests.length, 1);
  assertEquals(result, { ok: true, value: { items: [], next_page_token: null, total_results: null } });
});

Deno.test("a 400 on a request that carried a page token is invalid_cursor", async () => {
  const { fetchImpl } = fakeFetch(400, { error: { errors: [{ reason: "invalidPageToken" }] } });
  const result = await client(fetchImpl).listUploads("t", { channelId: CHANNEL_ID, pageSize: 25, pageToken: "bad" });
  assertEquals(result, { ok: false, code: "invalid_cursor", unauthorized: false });
});

Deno.test("a 400 without a page token is upstream_unavailable", async () => {
  const { fetchImpl } = fakeFetch(400, { error: {} });
  const result = await client(fetchImpl).listUploads("t", { channelId: CHANNEL_ID, pageSize: 25 });
  assertEquals(result, { ok: false, code: "upstream_unavailable", unauthorized: false });
});

Deno.test("a page of placeholders without video ids keeps the cursor and empties the list", async () => {
  const { fetchImpl } = fakeFetch(200, {
    nextPageToken: "NEXTTOKEN",
    pageInfo: { totalResults: 2 },
    items: [
      { snippet: { title: "Placeholder one" } },
      { snippet: { title: "Placeholder two" } },
    ],
  });
  const result = await client(fetchImpl).listUploads("t", { channelId: CHANNEL_ID, pageSize: 25 });
  assertEquals(result, {
    ok: true,
    value: { items: [], next_page_token: "NEXTTOKEN", total_results: 2 },
  });
});

Deno.test("getVideo returns the details of a video of the bound channel", async () => {
  const { fetchImpl, requests } = fakeFetch(200, {
    items: [{
      id: "videoAAAAAAA",
      snippet: {
        channelId: CHANNEL_ID,
        title: "First video",
        description: "Body",
        publishedAt: "2026-10-31T00:00:00Z",
        tags: ["one", "two"],
        categoryId: "22",
        defaultLanguage: "ar",
        thumbnails: { high: { url: "https://i.ytimg.example/high.jpg" } },
      },
      contentDetails: { duration: "PT4M13S" },
      statistics: { viewCount: "10", likeCount: "2", commentCount: "1" },
      status: { privacyStatus: "public", uploadStatus: "processed", madeForKids: false },
    }],
  });
  const result = await client(fetchImpl).getVideo("t", { channelId: CHANNEL_ID, videoId: "videoAAAAAAA" });

  assertEquals(requests[0].url.pathname, "/youtube/v3/videos");
  assertEquals(requests[0].url.searchParams.get("id"), "videoAAAAAAA");
  assertEquals(result, {
    ok: true,
    value: {
      id: "videoAAAAAAA",
      channel_id: CHANNEL_ID,
      title: "First video",
      description: "Body",
      thumbnail_url: "https://i.ytimg.example/high.jpg",
      published_at: "2026-10-31T00:00:00Z",
      tags: ["one", "two"],
      category_id: "22",
      default_language: "ar",
      duration_iso8601: "PT4M13S",
      privacy_status: "public",
      upload_status: "processed",
      made_for_kids: false,
      statistics: { view_count: 10, like_count: 2, comment_count: 1 },
      url: "https://www.youtube.com/watch?v=videoAAAAAAA",
    },
  });
});

Deno.test("a video of another channel and an absent video are the same not_found", async () => {
  const foreign = fakeFetch(200, { items: [{ id: "videoBBBBBBB", snippet: { channelId: "UCanotherchannel0000000002" } }] });
  const absent = fakeFetch(200, { items: [] });
  const input = { channelId: CHANNEL_ID, videoId: "videoBBBBBBB" };
  assertEquals(
    await client(foreign.fetchImpl).getVideo("t", input),
    await client(absent.fetchImpl).getVideo("t", input),
  );
  assertEquals(await client(absent.fetchImpl).getVideo("t", input), {
    ok: false,
    code: "not_found",
    unauthorized: false,
  });
});

Deno.test("a 404 on the derived uploads playlist is an empty page, not not_found", async () => {
  // A newly created channel has no uploads playlist yet: Google answers 404
  // playlistNotFound. The playlist id is derived from the stored channel id, so
  // this answer cannot be steered by the caller.
  const { fetchImpl } = fakeFetch(404, { error: { errors: [{ reason: "playlistNotFound" }] } });
  const result = await client(fetchImpl).listUploads("t", { channelId: CHANNEL_ID, pageSize: 25 });
  assertEquals(result, { ok: true, value: { items: [], next_page_token: null, total_results: 0 } });
});

Deno.test("a Google 404 on channels and videos is still not_found", async () => {
  const notFoundBody = { error: { errors: [{ reason: "playlistNotFound" }] } };
  const channel = fakeFetch(404, notFoundBody);
  const video = fakeFetch(404, notFoundBody);
  assertEquals(
    await client(channel.fetchImpl).getChannel("t", { channelId: CHANNEL_ID }),
    { ok: false, code: "not_found", unauthorized: false },
  );
  assertEquals(
    await client(video.fetchImpl).getVideo("t", { channelId: CHANNEL_ID, videoId: "videoAAAAAAA" }),
    { ok: false, code: "not_found", unauthorized: false },
  );
});


const UPLOADS_WITH_TWO_VIDEOS = {
  nextPageToken: "NEXTTOKEN",
  pageInfo: { totalResults: 3 },
  items: [
    {
      snippet: { title: "Owned A", resourceId: { videoId: "videoAAAAAAA" } },
      contentDetails: { videoId: "videoAAAAAAA", videoPublishedAt: "2026-11-01T00:00:00Z" },
    },
    {
      snippet: { title: "Owned B", resourceId: { videoId: "videoBBBBBBB" } },
      contentDetails: { videoId: "videoBBBBBBB" },
      status: { privacyStatus: "unlisted" },
    },
  ],
};

Deno.test("listUploads batches enrichment, truncates descriptions and ignores foreign channel entries", async () => {
  const { fetchImpl, requests } = fakeFetchSequence([
    { status: 200, body: UPLOADS_WITH_TWO_VIDEOS },
    {
      status: 200,
      body: {
        items: [
          {
            id: "videoAAAAAAA",
            snippet: { channelId: CHANNEL_ID, description: "x".repeat(600) },
            contentDetails: { duration: "PT4M13S" },
            statistics: { viewCount: "120", likeCount: "8", commentCount: "3" },
            status: { privacyStatus: "private" },
          },
          {
            id: "videoBBBBBBB",
            snippet: { channelId: "UCforeign", description: "not admitted" },
            contentDetails: { duration: "PT1M" },
            statistics: { viewCount: "999" },
          },
          { id: "videoCCCCCCC", snippet: { channelId: CHANNEL_ID, description: "not requested" } },
        ],
      },
    },
  ]);
  const result = await client(fetchImpl).listUploads("t", { channelId: CHANNEL_ID, pageSize: 25 });
  assertEquals(requests.length, 2);
  assertEquals(requests[1].url.searchParams.get("id"), "videoAAAAAAA,videoBBBBBBB");
  assertEquals(result, {
    ok: true,
    value: {
      items: [
        {
          id: "videoAAAAAAA",
          title: "Owned A",
          thumbnail_url: null,
          published_at: "2026-11-01T00:00:00Z",
          privacy_status: "private",
          url: "https://www.youtube.com/watch?v=videoAAAAAAA",
          description: "x".repeat(500),
          duration_iso8601: "PT4M13S",
          statistics: { view_count: 120, like_count: 8, comment_count: 3 },
        },
        {
          id: "videoBBBBBBB",
          title: "Owned B",
          thumbnail_url: null,
          published_at: null,
          privacy_status: "unlisted",
          url: "https://www.youtube.com/watch?v=videoBBBBBBB",
          description: null,
          duration_iso8601: null,
          statistics: { view_count: null, like_count: null, comment_count: null },
        },
      ],
      next_page_token: "NEXTTOKEN",
      total_results: 3,
    },
  });
});

for (const [name, status, body, expectedClass] of [
  ["401", 401, { error: { errors: [{ reason: "authError" }] } }, "unauthorized"],
  ["403", 403, { error: { errors: [{ reason: "insufficientPermissions" }] } }, "scope_missing"],
  ["500", 500, { error: { errors: [{ reason: "backendError" }] } }, "upstream"],
  ["bad schema", 200, { items: "bad" }, "upstream"],
] as const) {
  Deno.test(`listUploads enrichment ${name} degrades to nulls without losing the page`, async () => {
    const { fetchImpl } = fakeFetchSequence([
      { status: 200, body: UPLOADS_WITH_TWO_VIDEOS },
      { status, body },
    ]);
    const warnings: unknown[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args); };
    try {
      const result = await client(fetchImpl).listUploads("t", { channelId: CHANNEL_ID, pageSize: 25 });
      assertEquals(result.ok, true);
      if (result.ok) {
        assertEquals(result.value.next_page_token, "NEXTTOKEN");
        for (const item of result.value.items) {
          assertEquals(item.description, null);
          assertEquals(item.duration_iso8601, null);
          assertEquals(item.statistics, { view_count: null, like_count: null, comment_count: null });
        }
      }
      assertEquals(warnings, [[{ event: "youtube_resources_enrichment_degraded", class: expectedClass }]]);
    } finally {
      console.warn = originalWarn;
    }
  });
}

Deno.test("listUploads enrichment network failure degrades without marking the token unauthorized", async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = () => {
    calls += 1;
    return calls === 1
      ? Promise.resolve(Response.json(UPLOADS_WITH_TWO_VIDEOS))
      : Promise.reject(new TypeError("offline"));
  };
  const originalWarn = console.warn;
  const warnings: unknown[] = [];
  console.warn = (...args: unknown[]) => { warnings.push(args); };
  try {
    const result = await client(fetchImpl).listUploads("t", { channelId: CHANNEL_ID, pageSize: 25 });
    assertEquals(result.ok, true);
    assertEquals(result.ok && result.value.items[0].statistics, { view_count: null, like_count: null, comment_count: null });
    assertEquals(warnings, [[{ event: "youtube_resources_enrichment_degraded", class: "network" }]]);
  } finally {
    console.warn = originalWarn;
  }
});

Deno.test("playlistItems 401 remains unauthorized while enrichment failures never are", async () => {
  const { fetchImpl, requests } = fakeFetch(401, { error: { errors: [{ reason: "authError" }] } });
  const result = await client(fetchImpl).listUploads("t", { channelId: CHANNEL_ID, pageSize: 25 });
  assertEquals(result, { ok: false, code: "reconnect_required", unauthorized: true });
  assertEquals(requests.length, 1);
});

Deno.test("listUploads normalizes unparseable publishedAt values to null", async () => {
  const { fetchImpl } = fakeFetchSequence([
    {
      status: 200,
      body: {
        items: [{
          snippet: { title: "Bad date", publishedAt: "not-a-date", resourceId: { videoId: "videoAAAAAAA" } },
          contentDetails: { videoId: "videoAAAAAAA", videoPublishedAt: "not-a-date" },
        }],
      },
    },
    { status: 200, body: { items: [] } },
  ]);
  const result = await client(fetchImpl).listUploads("t", { channelId: CHANNEL_ID, pageSize: 25 });
  assertEquals(result.ok && result.value.items[0].published_at, null);
});

Deno.test("listPlaylists pages owned playlists and drops foreign-channel or malformed items", async () => {
  const { fetchImpl, requests } = fakeFetch(200, {
    nextPageToken: "NEXT_PL",
    items: [
      {
        id: "PLownedplaylist001",
        snippet: {
          channelId: CHANNEL_ID,
          title: "Owned Playlist",
          thumbnails: { medium: { url: "https://i.ytimg.com/vi/abc/mqdefault.jpg" } },
        },
        status: { privacyStatus: "public" },
      },
      {
        id: "PLforeignplaylist2",
        snippet: { channelId: "UCanotherchannel000000002", title: "Foreign Playlist" },
        status: { privacyStatus: "unlisted" },
      },
      {
        id: "bad/id",
        snippet: { channelId: CHANNEL_ID, title: "Bad Id" },
        status: { privacyStatus: "private" },
      },
    ],
  });

  const result = await client(fetchImpl).listPlaylists("token-pl", {
    channelId: CHANNEL_ID,
    pageToken: "PAGE_1",
  });

  assertEquals(requests.length, 1);
  assertEquals(requests[0].url.pathname, "/youtube/v3/playlists");
  assertEquals(requests[0].url.searchParams.get("part"), "snippet,status");
  assertEquals(requests[0].url.searchParams.get("mine"), "true");
  assertEquals(requests[0].url.searchParams.get("maxResults"), "50");
  assertEquals(requests[0].url.searchParams.get("pageToken"), "PAGE_1");
  assertEquals(requests[0].authorization, "Bearer token-pl");
  assertEquals(result, {
    ok: true,
    value: {
      items: [{
        id: "PLownedplaylist001",
        title: "Owned Playlist",
        privacy_status: "public",
        thumbnail_url: "https://i.ytimg.com/vi/abc/mqdefault.jpg",
      }],
      next_page_token: "NEXT_PL",
    },
  });
});

Deno.test("listPlaylists maps 400 with pageToken to invalid_cursor and 401 to unauthorized", async () => {
  const badCursor = fakeFetch(400, { error: { errors: [{ reason: "invalidPageToken" }] } });
  const cursorResult = await client(badCursor.fetchImpl).listPlaylists("t", {
    channelId: CHANNEL_ID,
    pageToken: "stale",
  });
  assertEquals(cursorResult, { ok: false, code: "invalid_cursor", unauthorized: false });

  const unauth = fakeFetch(401, { error: { errors: [{ reason: "authError" }] } });
  const unauthResult = await client(unauth.fetchImpl).listPlaylists("t", { channelId: CHANNEL_ID });
  assertEquals(unauthResult, { ok: false, code: "reconnect_required", unauthorized: true });
});
