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
