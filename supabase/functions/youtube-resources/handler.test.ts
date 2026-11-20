import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  createYouTubeResourcesHandler,
  type YouTubeResourceAccount,
  type YouTubeResourceRefusal,
  type YouTubeResourcesPorts,
  type YouTubeTokenResult,
} from "./handler.ts";
import {
  YOUTUBE_SCOPE,
  type YouTubeChannelDetails,
  type YouTubeVideoDetails,
  type YouTubeVideosPage,
} from "./contracts.ts";
import type { YouTubeReadResult } from "./youtubeReadClient.ts";
import { YOUTUBE_RESOURCE_REQUEST_EXAMPLES } from "./requestExamples.fixture.ts";

const ENDPOINT = "https://api.postora.cloud/functions/v1/youtube-resources";
const USER_ID = "0ee00001-0000-4000-8000-000000000001";
const ACCOUNT_ID = "0ee20001-0000-4000-8000-000000000021";
const FOREIGN_ACCOUNT_ID = "0ee20002-0000-4000-8000-000000000022";
const REQUEST_ID = "0ee90001-0000-4000-8000-000000000091";
const CHANNEL_ID = "UCfixturechannel000000001";

function pageOf(size: number, nextPageToken: string | null, total: number): YouTubeVideosPage {
  return {
    items: Array.from({ length: size }, (_, index) => ({
      id: `video${String(index).padStart(6, "0")}`,
      title: `Video ${index}`,
      thumbnail_url: null,
      published_at: null,
      privacy_status: "public",
      url: `https://www.youtube.com/watch?v=video${String(index).padStart(6, "0")}`,
    })),
    next_page_token: nextPageToken,
    total_results: total,
  };
}

const CHANNEL: YouTubeChannelDetails = {
  id: CHANNEL_ID,
  title: "Fixture channel",
  description: "",
  custom_url: null,
  thumbnail_url: null,
  published_at: null,
  country: null,
  privacy_status: "public",
  statistics: { view_count: 1, subscriber_count: 1, subscriber_count_hidden: false, video_count: 1 },
};

const VIDEO: YouTubeVideoDetails = {
  id: "videoAAAAAAA",
  channel_id: CHANNEL_ID,
  title: "First video",
  description: "",
  thumbnail_url: null,
  published_at: null,
  tags: [],
  category_id: null,
  default_language: null,
  duration_iso8601: "PT1M",
  privacy_status: "public",
  upload_status: "processed",
  made_for_kids: false,
  statistics: { view_count: 1, like_count: 0, comment_count: 0 },
  url: "https://www.youtube.com/watch?v=videoAAAAAAA",
};

function request(body: unknown, method = "POST"): Request {
  return new Request(ENDPOINT, {
    method,
    headers: { "content-type": "application/json" },
    body: method === "POST" ? JSON.stringify(body) : undefined,
  });
}

function rawRequest(body: string): Request {
  return new Request(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

function fixture(overrides: {
  authenticated?: boolean;
  authUserId?: unknown;
  account?: Partial<YouTubeResourceAccount>;
  loadError?: boolean;
  slowLog?: boolean;
  tokenResults?: YouTubeTokenResult[];
  channelResults?: Array<YouTubeReadResult<YouTubeChannelDetails>>;
  uploadResults?: Array<YouTubeReadResult<YouTubeVideosPage>>;
  videoResults?: Array<YouTubeReadResult<YouTubeVideoDetails>>;
  rateLimit?: { allowed: boolean; retryAfterSeconds: number };
} = {}) {
  const accessToken = crypto.randomUUID() + crypto.randomUUID();
  const refreshToken = crypto.randomUUID() + crypto.randomUUID();
  const calls = { auth: 0, load: 0, tokens: 0, channel: 0, uploads: 0, video: 0, rateLimit: 0 };
  const forceFlags: boolean[] = [];
  const uploadInputs: Array<{ channelId: string; pageSize: number; pageToken?: string }> = [];
  const videoInputs: Array<{ channelId: string; videoId: string }> = [];
  const logs: YouTubeResourceRefusal[] = [];
  let minted = 0;
  const account: YouTubeResourceAccount = {
    id: ACCOUNT_ID,
    userId: USER_ID,
    channelId: CHANNEL_ID,
    channelTitle: "Fixture channel",
    authProvider: null,
    needsReauth: false,
    accessToken,
    refreshToken,
    tokenExpiresAt: "2099-01-01T00:00:00.000Z",
    accountMetadata: {
      granted_scopes: [YOUTUBE_SCOPE.readonly, YOUTUBE_SCOPE.upload, YOUTUBE_SCOPE.force_ssl],
    },
    ...overrides.account,
  };
  const ports: YouTubeResourcesPorts = {
    auth: {
      authenticate: () => {
        calls.auth++;
        if (overrides.authenticated === false) return Promise.reject(new Error("unauthorized"));
        if ("authUserId" in overrides) {
          return Promise.resolve({ userId: overrides.authUserId as string });
        }
        return Promise.resolve({ userId: USER_ID });
      },
    },
    accounts: {
      load: ({ accountId, userId }) => {
        calls.load++;
        if (overrides.loadError) return Promise.reject(new Error("account_read_failed"));
        return Promise.resolve(accountId === ACCOUNT_ID && userId === USER_ID ? account : null);
      },
    },
    clock: { now: () => new Date("2026-11-20T10:00:00.000Z") },
    ids: {
      requestId: () => {
        minted++;
        return minted === 1 ? REQUEST_ID : `${REQUEST_ID}-${minted}`;
      },
    },
    log: {
      refusal: (entry) => {
        if (overrides.slowLog) {
          return new Promise<void>((resolve) =>
            setTimeout(() => {
              logs.push(entry);
              resolve();
            }, 0)
          );
        }
        logs.push(entry);
        return Promise.resolve();
      },
    },
    tokens: {
      get: (_account, options) => {
        forceFlags.push(options.force);
        const queued = overrides.tokenResults?.[calls.tokens];
        calls.tokens++;
        return Promise.resolve(queued ?? { ok: true, accessToken, minted: false });
      },
    },
    youtube: {
      getChannel: () => {
        const queued = overrides.channelResults?.[calls.channel];
        calls.channel++;
        return Promise.resolve(queued ?? { ok: true, value: CHANNEL });
      },
      listUploads: (_token, input) => {
        uploadInputs.push(input);
        const queued = overrides.uploadResults?.[calls.uploads];
        calls.uploads++;
        return Promise.resolve(queued ?? { ok: true, value: pageOf(25, "CAUQAA", 60) });
      },
      getVideo: (_token, input) => {
        videoInputs.push(input);
        const queued = overrides.videoResults?.[calls.video];
        calls.video++;
        return Promise.resolve(queued ?? { ok: true, value: VIDEO });
      },
    },
    rateLimit: {
      check: () => {
        calls.rateLimit++;
        return Promise.resolve(overrides.rateLimit ?? { allowed: true, retryAfterSeconds: 0 });
      },
    },
  };
  return {
    handler: createYouTubeResourcesHandler(ports),
    calls,
    forceFlags,
    logs,
    uploadInputs,
    videoInputs,
    accessToken,
    refreshToken,
  };
}

Deno.test("a request without a valid user is refused before any account read", async () => {
  const { handler, calls, logs } = fixture({ authenticated: false });
  const response = await handler(request({ operation: "capabilities", account_id: ACCOUNT_ID }));
  assertEquals(response.status, 401);
  assertEquals(await response.json(), { error: "unauthorized", request_id: REQUEST_ID });
  assertEquals(calls.load, 0);
  assertEquals(logs, []);
});

Deno.test("an authenticate result without a user id is refused as unauthorized before any account read", async () => {
  const { handler, calls, logs } = fixture({ authUserId: undefined as unknown as string });
  const response = await handler(request({ operation: "capabilities", account_id: ACCOUNT_ID }));
  assertEquals(response.status, 401);
  assertEquals(await response.json(), { error: "unauthorized", request_id: REQUEST_ID });
  assertEquals(calls.load, 0);
  assertEquals(logs, []);
});

Deno.test("an authenticate result with a non-UUID user id is refused as unauthorized before any account read", async () => {
  const { handler, calls, logs } = fixture({ authUserId: "not-a-uuid" });
  const response = await handler(request({ operation: "capabilities", account_id: ACCOUNT_ID }));
  assertEquals(response.status, 401);
  assertEquals(await response.json(), { error: "unauthorized", request_id: REQUEST_ID });
  assertEquals(calls.load, 0);
  assertEquals(logs, []);
});

Deno.test("a body that names a user is refused by the strict schema", async () => {
  const { handler, calls } = fixture();
  const response = await handler(
    request({ operation: "capabilities", account_id: ACCOUNT_ID, user_id: USER_ID }),
  );
  assertEquals(response.status, 400);
  assertEquals((await response.json()).error, "invalid_request");
  assertEquals(calls.load, 0);
});

Deno.test("another owner's account and an unknown account get the same answer", async () => {
  const { handler } = fixture();
  const foreign = await handler(request({ operation: "capabilities", account_id: FOREIGN_ACCOUNT_ID }));
  const unknown = await handler(
    request({ operation: "capabilities", account_id: "0ee20009-0000-4000-8000-000000000029" }),
  );
  assertEquals(foreign.status, 404);
  assertEquals(unknown.status, 404);
  const { request_id: foreignId, ...foreignRest } = await foreign.json();
  const { request_id: unknownId, ...unknownRest } = await unknown.json();
  assertEquals(foreignId !== unknownId, true);
  assertEquals(foreignRest, unknownRest);
  assertEquals(foreignRest, { error: "not_found" });
});

Deno.test("capabilities answers from the database and never returns a credential", async () => {
  const { handler, accessToken, refreshToken } = fixture();
  const response = await handler(request({ operation: "capabilities", account_id: ACCOUNT_ID }));
  assertEquals(response.status, 200);
  const text = await response.text();
  assertEquals(text.includes(accessToken), false);
  assertEquals(text.includes(refreshToken), false);
  const body = JSON.parse(text);
  assertEquals(body.schema_version, 1);
  assertEquals(body.request_id, REQUEST_ID);
  assertEquals(body.freshness, { fetched_at: "2026-11-20T10:00:00.000Z", source: "database" });
  assertEquals(body.data.account_id, ACCOUNT_ID);
  assertEquals(body.data.capabilities.browse, { state: "available" });
});

Deno.test("a failed account read is an internal error, not a not_found", async () => {
  const { handler, logs } = fixture({ loadError: true });
  const response = await handler(request({ operation: "capabilities", account_id: ACCOUNT_ID }));
  assertEquals(response.status, 500);
  assertEquals((await response.json()).error, "internal_error");
  assertEquals(logs.map((entry) => entry.code), ["internal_error"]);
});

Deno.test("only POST is served", async () => {
  const { handler, calls } = fixture();
  const response = await handler(request(null, "GET"));
  assertEquals(response.status, 405);
  assertEquals(calls.auth, 0);
});

Deno.test("a method refusal writes no log row", async () => {
  const { handler, logs } = fixture();
  const response = await handler(request(null, "GET"));
  assertEquals(response.status, 405);
  assertEquals(logs, []);
});

Deno.test("a refusal row lands before the response promise resolves", async () => {
  const { handler, logs } = fixture({ slowLog: true });
  const response = await handler(request({ operation: "capabilities", account_id: FOREIGN_ACCOUNT_ID }));
  assertEquals(response.status, 404);
  // The log port resolves on a later macrotask; seeing the row here proves the
  // handler awaited the write instead of firing and forgetting.
  assertEquals(logs.map((entry) => entry.code), ["not_found"]);
});

Deno.test("a not_found refusal writes exactly one row with the code and the request id", async () => {
  const { handler, logs } = fixture();
  const response = await handler(request({ operation: "capabilities", account_id: FOREIGN_ACCOUNT_ID }));
  assertEquals(response.status, 404);
  assertEquals(logs, [{
    operation: "capabilities",
    code: "not_found",
    userId: USER_ID,
    accountId: FOREIGN_ACCOUNT_ID,
    requestId: REQUEST_ID,
  }]);
});

Deno.test("malformed JSON is an invalid_request and is logged", async () => {
  const { handler, logs } = fixture();
  const response = await handler(rawRequest("{not json"));
  assertEquals(response.status, 400);
  assertEquals((await response.json()).error, "invalid_request");
  assertEquals(logs.map((entry) => entry.code), ["invalid_request"]);
});

Deno.test("a preflight is answered with 204 and the restricted CORS headers", async () => {
  const { handler, calls } = fixture();
  const response = await handler(new Request(ENDPOINT, { method: "OPTIONS" }));
  assertEquals(response.status, 204);
  assertEquals(response.headers.get("access-control-allow-origin"), "https://postora.cloud");
  assertEquals(response.headers.get("vary"), "Origin");
  assertEquals(calls.auth, 0);
  assertEquals(calls.load, 0);
});

Deno.test("a composio row answers with browse unsupported and upload unknown", async () => {
  const { handler } = fixture({
    account: {
      authProvider: "composio",
      accessToken: null,
      refreshToken: null,
      accountMetadata: {},
    },
  });
  const response = await handler(request({ operation: "capabilities", account_id: ACCOUNT_ID }));
  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.data.provider, "composio");
  assertEquals(body.data.connection, "ok");
  assertEquals(body.data.capabilities.browse, { state: "unavailable", reason: "provider_unsupported" });
  assertEquals(body.data.capabilities.upload, { state: "unknown" });
});

const CHANNEL_REQUEST = { operation: "channel", account_id: ACCOUNT_ID };

Deno.test("channel returns the provider answer with provider freshness and no credential", async () => {
  const { handler, accessToken, calls } = fixture();
  const response = await handler(request(CHANNEL_REQUEST));
  assertEquals(response.status, 200);
  const text = await response.text();
  assertEquals(text.includes(accessToken), false);
  const body = JSON.parse(text);
  assertEquals(body.freshness.source, "provider");
  assertEquals(body.data, CHANNEL);
  assertEquals(calls, { auth: 1, load: 1, tokens: 1, channel: 1, uploads: 0, video: 0, rateLimit: 1 });
});

Deno.test("a foreign account never reaches the token store or the provider", async () => {
  const { handler, calls } = fixture();
  const response = await handler(request({ operation: "channel", account_id: FOREIGN_ACCOUNT_ID }));
  assertEquals(response.status, 404);
  assertEquals([calls.tokens, calls.channel, calls.rateLimit], [0, 0, 0]);
});

Deno.test("a composio account is provider_unsupported and never reaches the native client", async () => {
  const { handler, calls } = fixture({ account: { authProvider: "composio", accountMetadata: {} } });
  const response = await handler(request(CHANNEL_REQUEST));
  assertEquals(response.status, 409);
  assertEquals((await response.json()).error, "provider_unsupported");
  assertEquals([calls.tokens, calls.channel], [0, 0]);
});

Deno.test("an account flagged for reauth is reconnect_required before any provider call", async () => {
  const { handler, calls } = fixture({ account: { needsReauth: true } });
  const response = await handler(request(CHANNEL_REQUEST));
  assertEquals(response.status, 409);
  assertEquals((await response.json()).error, "reconnect_required");
  assertEquals([calls.tokens, calls.channel], [0, 0]);
});

Deno.test("recorded scopes without readonly are missing_scope before any provider call", async () => {
  const { handler, calls } = fixture({
    account: { accountMetadata: { granted_scopes: [YOUTUBE_SCOPE.upload] } },
  });
  const response = await handler(request(CHANNEL_REQUEST));
  assertEquals(response.status, 403);
  assertEquals((await response.json()).error, "missing_scope");
  assertEquals([calls.tokens, calls.channel], [0, 0]);
});

Deno.test("an account whose scopes were never recorded is allowed to try", async () => {
  const { handler, calls } = fixture({ account: { accountMetadata: {} } });
  const response = await handler(request(CHANNEL_REQUEST));
  assertEquals(response.status, 200);
  assertEquals(calls.channel, 1);
});

Deno.test("the per-user limit answers rate_limited with a retry hint and spends no quota", async () => {
  const { handler, calls } = fixture({ rateLimit: { allowed: false, retryAfterSeconds: 120 } });
  const response = await handler(request(CHANNEL_REQUEST));
  assertEquals(response.status, 429);
  assertEquals(await response.json(), {
    error: "rate_limited",
    request_id: REQUEST_ID,
    retry_after_seconds: 120,
  });
  assertEquals([calls.tokens, calls.channel], [0, 0]);
});

Deno.test("a 401 on a stored token forces one refresh and one repeat", async () => {
  const { handler, calls, forceFlags } = fixture({
    channelResults: [{ ok: false, code: "reconnect_required", unauthorized: true }],
  });
  const response = await handler(request(CHANNEL_REQUEST));
  assertEquals(response.status, 200);
  assertEquals(forceFlags, [false, true]);
  assertEquals(calls.channel, 2);
});

Deno.test("a second 401 is reconnect_required and is not repeated again", async () => {
  const denied = { ok: false as const, code: "reconnect_required" as const, unauthorized: true };
  const { handler, calls } = fixture({ channelResults: [denied, denied] });
  const response = await handler(request(CHANNEL_REQUEST));
  assertEquals(response.status, 409);
  assertEquals((await response.json()).error, "reconnect_required");
  assertEquals(calls.channel, 2);
});

Deno.test("a 401 on a token this request just minted is not repeated", async () => {
  const fresh = crypto.randomUUID();
  const { handler, calls } = fixture({
    tokenResults: [{ ok: true, accessToken: fresh, minted: true }],
    channelResults: [{ ok: false, code: "reconnect_required", unauthorized: true }],
  });
  const response = await handler(request(CHANNEL_REQUEST));
  assertEquals(response.status, 409);
  assertEquals(calls.channel, 1);
});

Deno.test("a token that cannot be obtained maps to its stable code", async () => {
  const { handler, calls } = fixture({ tokenResults: [{ ok: false, code: "upstream_unavailable" }] });
  const response = await handler(request(CHANNEL_REQUEST));
  assertEquals(response.status, 502);
  assertEquals((await response.json()).error, "upstream_unavailable");
  assertEquals(calls.channel, 0);
});

Deno.test("a provider quota refusal is quota_exceeded", async () => {
  const { handler } = fixture({
    channelResults: [{ ok: false, code: "quota_exceeded", unauthorized: false }],
  });
  const response = await handler(request(CHANNEL_REQUEST));
  assertEquals(response.status, 429);
  assertEquals((await response.json()).error, "quota_exceeded");
});

Deno.test("videos defaults to 25 per page for the stored channel", async () => {
  const { handler, uploadInputs } = fixture();
  const response = await handler(request({ operation: "videos", account_id: ACCOUNT_ID }));
  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.data.items.length, 25);
  assertEquals(body.data.next_page_token, "CAUQAA");
  assertEquals(uploadInputs, [{ channelId: CHANNEL_ID, pageSize: 25 }]);
});

Deno.test("sixty uploads are reachable in three pages", async () => {
  const { handler, uploadInputs } = fixture({
    uploadResults: [
      { ok: true, value: pageOf(25, "PAGE2", 60) },
      { ok: true, value: pageOf(25, "PAGE3", 60) },
      { ok: true, value: pageOf(10, null, 60) },
    ],
  });
  let token: string | null = null;
  let total = 0;
  for (let page = 0; page < 3; page++) {
    const response = await handler(request({
      operation: "videos",
      account_id: ACCOUNT_ID,
      ...(token ? { page_token: token } : {}),
    }));
    const body = await response.json();
    total += body.data.items.length;
    token = body.data.next_page_token;
  }
  assertEquals(total, 60);
  assertEquals(token, null);
  assertEquals(uploadInputs.map((input) => input.pageToken), [undefined, "PAGE2", "PAGE3"]);
});

Deno.test("a page size above fifty and a malformed token are refused before any provider call", async () => {
  const { handler, calls } = fixture();
  const tooLarge = await handler(request({ operation: "videos", account_id: ACCOUNT_ID, page_size: 51 }));
  const badToken = await handler(request({
    operation: "videos",
    account_id: ACCOUNT_ID,
    // Google cursors are opaque; only the 256-character cap is enforced, so a
    // malformed cursor here is one that is too long.
    page_token: "a".repeat(257),
  }));
  assertEquals([tooLarge.status, badToken.status], [400, 400]);
  assertEquals([calls.load, calls.uploads], [0, 0]);
});

Deno.test("a cursor Google rejects is invalid_cursor", async () => {
  const { handler } = fixture({
    uploadResults: [{ ok: false, code: "invalid_cursor", unauthorized: false }],
  });
  const response = await handler(request({ operation: "videos", account_id: ACCOUNT_ID, page_token: "STALE" }));
  assertEquals(response.status, 400);
  assertEquals((await response.json()).error, "invalid_cursor");
});

Deno.test("a failed listing is an error, never an empty page", async () => {
  const { handler } = fixture({
    uploadResults: [{ ok: false, code: "upstream_unavailable", unauthorized: false }],
  });
  const response = await handler(request({ operation: "videos", account_id: ACCOUNT_ID }));
  assertEquals(response.status, 502);
  assertEquals("data" in (await response.json()), false);
});

const VIDEO_REQUEST = { operation: "video", account_id: ACCOUNT_ID, video_id: "videoAAAAAAA" };

Deno.test("video reads the details against the stored channel", async () => {
  const { handler, videoInputs } = fixture();
  const response = await handler(request(VIDEO_REQUEST));
  assertEquals(response.status, 200);
  assertEquals((await response.json()).data, VIDEO);
  assertEquals(videoInputs, [{ channelId: CHANNEL_ID, videoId: "videoAAAAAAA" }]);
});

Deno.test("a video the provider layer rejects as foreign is the same 404 as an unknown account", async () => {
  const { handler } = fixture({
    videoResults: [{ ok: false, code: "not_found", unauthorized: false }],
  });
  const foreignVideo = await handler(request(VIDEO_REQUEST));
  const foreignAccount = await handler(request({ ...VIDEO_REQUEST, account_id: FOREIGN_ACCOUNT_ID }));
  assertEquals(foreignVideo.status, 404);
  // The status and the body are the same; only the request id differs between two requests.
  const { request_id: videoId, ...videoRest } = await foreignVideo.json();
  const { request_id: accountId, ...accountRest } = await foreignAccount.json();
  assertEquals(videoId !== accountId, true);
  assertEquals(videoRest, accountRest);
  assertEquals(videoRest, { error: "not_found" });
});

Deno.test("a malformed video id is refused before any account read", async () => {
  const { handler, calls } = fixture();
  const response = await handler(request({ ...VIDEO_REQUEST, video_id: "../channels?mine=true" }));
  assertEquals(response.status, 400);
  assertEquals([calls.load, calls.video], [0, 0]);
});

for (const [name, body] of Object.entries(YOUTUBE_RESOURCE_REQUEST_EXAMPLES)) {
  Deno.test(`the handler accepts the shared ${name} request example`, async () => {
    const { handler } = fixture();
    const response = await handler(request(body));
    assertEquals(response.status, 200);
  });
}
