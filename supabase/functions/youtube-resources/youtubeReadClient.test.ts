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
