import { assertEquals } from "jsr:@std/assert@1";
import { createYouTubeBenchmarkReadClient } from "./benchmarkReadClient.ts";

const BOUND_BEARER = "bound-fixture-123";
const CHANNEL_ID = "UC_x5XG1OV2P6uZZ5FSM9Ttw";
const UPLOADS_ID = "UU_x5XG1OV2P6uZZ5FSM9Ttw";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function channelPayload(overrides: Record<string, unknown> = {}) {
  return {
    kind: "youtube#channelListResponse",
    items: [
      {
        id: CHANNEL_ID,
        snippet: {
          title: "Google for Developers",
          thumbnails: {
            medium: { url: "https://i.ytimg.com/channel/medium.jpg" },
          },
        },
        statistics: {
          viewCount: "123456",
          subscriberCount: "98765",
          hiddenSubscriberCount: false,
          videoCount: "420",
        },
        contentDetails: {
          relatedPlaylists: {
            uploads: UPLOADS_ID,
          },
        },
        ...overrides,
      },
    ],
  };
}

Deno.test("lookupChannel spends 3 units for handle with uploads and preserves upload order", async () => {
  const urls: string[] = [];
  let debits = 0;

  const client = createYouTubeBenchmarkReadClient({
    fetchImpl: (input) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("/channels?")) {
        return Promise.resolve(jsonResponse(channelPayload()));
      }
      if (url.includes("/playlistItems?")) {
        return Promise.resolve(jsonResponse({
          kind: "youtube#playlistItemListResponse",
          items: [
            { contentDetails: { videoId: "vid_second1" } },
            { contentDetails: { videoId: "vid_first01" } },
          ],
        }));
      }
      if (url.includes("/videos?")) {
        return Promise.resolve(jsonResponse({
          kind: "youtube#videoListResponse",
          items: [
            {
              id: "vid_first01",
              snippet: {
                channelId: CHANNEL_ID,
                title: "First",
                publishedAt: "2026-11-20T10:00:00Z",
              },
              statistics: { viewCount: "100", likeCount: "10", commentCount: "2" },
            },
            {
              id: "vid_foreign",
              snippet: {
                channelId: "UC_otherChannel0000000000",
                title: "Foreign",
                publishedAt: "2026-11-21T10:00:00Z",
              },
              statistics: { viewCount: "999" },
            },
            {
              id: "vid_second1",
              snippet: {
                channelId: CHANNEL_ID,
                title: "Second",
                publishedAt: "not-a-date",
              },
              statistics: { viewCount: "200", likeCount: "bad", commentCount: "5" },
            },
          ],
        }));
      }
      throw new Error(`unexpected URL: ${url}`);
    },
  });

  const outcome = await client.lookupChannel({
    accessToken: BOUND_BEARER,
    input: "@GoogleDevelopers",
    debitUnit: () => {
      debits += 1;
      return Promise.resolve({ allowed: true });
    },
  });

  assertEquals(debits, 3);
  assertEquals(urls.length, 3);
  assertEquals(urls[0].includes("forHandle=%40GoogleDevelopers"), true);
  assertEquals(outcome, {
    kind: "channel",
    unitsSpent: 3,
    channel: {
      input: "@googledevelopers",
      status: "found",
      channel_id: CHANNEL_ID,
      title: "Google for Developers",
      thumbnail_url: "https://i.ytimg.com/channel/medium.jpg",
      subscriber_count: 98765,
      subscriber_count_hidden: false,
      view_count: 123456,
      video_count: 420,
      recent_videos: [
        {
          id: "vid_second1",
          title: "Second",
          published_at: null,
          view_count: 200,
          like_count: null,
          comment_count: 5,
        },
        {
          id: "vid_first01",
          title: "First",
          published_at: "2026-11-20T10:00:00Z",
          view_count: 100,
          like_count: 10,
          comment_count: 2,
        },
      ],
    },
  });
});

Deno.test("lookupChannel returns not_found for 1 unit only when 2xx channels.list has 0 items", async () => {
  let debits = 0;
  let calls = 0;
  const client = createYouTubeBenchmarkReadClient({
    fetchImpl: () => {
      calls += 1;
      return Promise.resolve(jsonResponse({ kind: "youtube#channelListResponse", items: [] }));
    },
  });

  const outcome = await client.lookupChannel({
    accessToken: BOUND_BEARER,
    input: "@MissingChannel",
    debitUnit: () => {
      debits += 1;
      return Promise.resolve({ allowed: true });
    },
  });

  assertEquals(calls, 1);
  assertEquals(debits, 1);
  assertEquals(outcome, {
    kind: "channel",
    unitsSpent: 1,
    channel: {
      input: "@missingchannel",
      status: "not_found",
      channel_id: null,
      title: null,
      thumbnail_url: null,
      subscriber_count: null,
      subscriber_count_hidden: false,
      view_count: null,
      video_count: null,
      recent_videos: [],
    },
  });
});

Deno.test("lookupChannel skips videos.list and spends 2 units when uploads playlist is empty or 404", async () => {
  for (const step2Response of [
    () => jsonResponse({ kind: "youtube#playlistItemListResponse", items: [] }),
    () => jsonResponse({ error: { errors: [{ reason: "playlistNotFound" }] } }, 404),
  ]) {
    let debits = 0;
    const urls: string[] = [];
    const client = createYouTubeBenchmarkReadClient({
      fetchImpl: (input) => {
        const url = String(input);
        urls.push(url);
        if (url.includes("/channels?")) {
          return Promise.resolve(jsonResponse(channelPayload()));
        }
        if (url.includes("/playlistItems?")) {
          return Promise.resolve(step2Response());
        }
        throw new Error(`videos.list must not be called: ${url}`);
      },
    });

    const outcome = await client.lookupChannel({
      accessToken: BOUND_BEARER,
      input: CHANNEL_ID,
      debitUnit: () => {
        debits += 1;
        return Promise.resolve({ allowed: true });
      },
    });

    assertEquals(debits, 2);
    assertEquals(urls.length, 2);
    assertEquals(outcome.kind, "channel");
    if (outcome.kind === "channel") {
      assertEquals(outcome.unitsSpent, 2);
      assertEquals(outcome.channel.status, "found");
      assertEquals(outcome.channel.error, undefined);
      assertEquals(outcome.channel.recent_videos, []);
    }
  }
});

Deno.test("lookupChannel never maps quota, 403, 404, 429, 5xx, timeout, or malformed JSON to not_found", async () => {
  const failureCases: Array<{
    name: string;
    responder: () => Promise<Response>;
    expectedError: "quota_exceeded" | "reconnect_required" | "upstream_unavailable";
  }> = [
    {
      name: "403 quotaExceeded",
      responder: () =>
        Promise.resolve(jsonResponse({ error: { errors: [{ reason: "quotaExceeded" }] } }, 403)),
      expectedError: "quota_exceeded",
    },
    {
      name: "429 rate limited",
      responder: () => Promise.resolve(jsonResponse({}, 429)),
      expectedError: "quota_exceeded",
    },
    {
      name: "403 insufficientPermissions",
      responder: () =>
        Promise.resolve(
          jsonResponse({ error: { errors: [{ reason: "insufficientPermissions" }] } }, 403),
        ),
      expectedError: "reconnect_required",
    },
    {
      name: "404 on channels.list",
      responder: () => Promise.resolve(jsonResponse({}, 404)),
      expectedError: "upstream_unavailable",
    },
    {
      name: "503 upstream",
      responder: () => Promise.resolve(jsonResponse({}, 503)),
      expectedError: "upstream_unavailable",
    },
    {
      name: "malformed json",
      responder: () => Promise.resolve(new Response("not-json", { status: 200 })),
      expectedError: "upstream_unavailable",
    },
    {
      name: "network throw",
      responder: () => Promise.reject(new DOMException("Timed out", "TimeoutError")),
      expectedError: "upstream_unavailable",
    },
  ];

  for (const testCase of failureCases) {
    const client = createYouTubeBenchmarkReadClient({ fetchImpl: testCase.responder });
    const outcome = await client.lookupChannel({
      accessToken: BOUND_BEARER,
      input: "@SomeChannel",
    });
    assertEquals(outcome.kind, "channel", testCase.name);
    if (outcome.kind === "channel") {
      assertEquals(outcome.channel.status, "unavailable", testCase.name);
      assertEquals(outcome.channel.error, testCase.expectedError, testCase.name);
    }
  }
});

Deno.test("lookupChannel preserves found channel stats when step 2 or step 3 fails", async () => {
  const client = createYouTubeBenchmarkReadClient({
    fetchImpl: (input) => {
      const url = String(input);
      if (url.includes("/channels?")) {
        return Promise.resolve(jsonResponse(channelPayload({
          statistics: {
            viewCount: "5000",
            subscriberCount: "999",
            hiddenSubscriberCount: true,
            videoCount: "12",
          },
        })));
      }
      return Promise.resolve(jsonResponse({ error: { errors: [{ reason: "dailyLimitExceeded" }] } }, 403));
    },
  });

  const outcome = await client.lookupChannel({
    accessToken: BOUND_BEARER,
    input: "@HiddenSubs",
  });

  assertEquals(outcome, {
    kind: "channel",
    unitsSpent: 2,
    channel: {
      input: "@hiddensubs",
      status: "found",
      error: "quota_exceeded",
      channel_id: CHANNEL_ID,
      title: "Google for Developers",
      thumbnail_url: "https://i.ytimg.com/channel/medium.jpg",
      subscriber_count: null,
      subscriber_count_hidden: true,
      view_count: 5000,
      video_count: 12,
      recent_videos: [],
    },
  });
});

Deno.test("lookupChannel makes 0 Google calls when budget debit refuses before step 1", async () => {
  let fetchCalls = 0;
  const client = createYouTubeBenchmarkReadClient({
    fetchImpl: () => {
      fetchCalls += 1;
      return Promise.resolve(jsonResponse(channelPayload()));
    },
  });

  const outcome = await client.lookupChannel({
    accessToken: BOUND_BEARER,
    input: "@GoogleDevelopers",
    debitUnit: () => Promise.resolve({ allowed: false, code: "quota_exceeded" }),
  });

  assertEquals(fetchCalls, 0);
  assertEquals(outcome, {
    kind: "channel",
    unitsSpent: 0,
    channel: {
      input: "@googledevelopers",
      status: "unavailable",
      error: "quota_exceeded",
      channel_id: null,
      title: null,
      thumbnail_url: null,
      subscriber_count: null,
      subscriber_count_hidden: false,
      view_count: null,
      video_count: null,
      recent_videos: [],
    },
  });
});

Deno.test("lookupChannel returns unauthorized on HTTP 401 and rejects non-ytimg thumbnails", async () => {
  const client401 = createYouTubeBenchmarkReadClient({
    fetchImpl: () => Promise.resolve(jsonResponse({}, 401)),
  });
  assertEquals(
    await client401.lookupChannel({ accessToken: BOUND_BEARER, input: "@GoogleDevelopers" }),
    { kind: "unauthorized", unitsSpent: 1 },
  );

  const clientUnsafeThumb = createYouTubeBenchmarkReadClient({
    fetchImpl: (input) => {
      const url = String(input);
      if (url.includes("/channels?")) {
        return Promise.resolve(jsonResponse(channelPayload({
          snippet: {
            title: "Evil Thumb",
            thumbnails: {
              medium: { url: "https://ytimg.com.attacker.example/a.jpg" },
              high: { url: "http://i.ytimg.com/insecure.jpg" },
            },
          },
        })));
      }
      return Promise.resolve(jsonResponse({ kind: "youtube#playlistItemListResponse", items: [] }));
    },
  });
  const outcome = await clientUnsafeThumb.lookupChannel({
    accessToken: BOUND_BEARER,
    input: "@EvilThumb",
  });
  assertEquals(outcome.kind, "channel");
  if (outcome.kind === "channel") {
    assertEquals(outcome.channel.thumbnail_url, null);
  }
});
