import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  createYouTubeResourcesHandler,
  YOUTUBE_RESOURCES_MAX_BODY_BYTES,
  type YouTubeCaptionPort,
  type YouTubeResourceAccount,
  type YouTubeResourceRefusal,
  type YouTubeEditPort,
  type YouTubeResourcesPorts,
  type YouTubeThumbnailPort,
  type YouTubeTokenResult,
} from "./handler.ts";
import { validateCaptionUploadInput } from "./captionFile.ts";
import {
  YOUTUBE_SCOPE,
  type YouTubeChannelDetails,
  type YouTubePlaylistsPage,
  type YouTubeVideoDetails,
  type YouTubeVideosPage,
} from "./contracts.ts";
import type { YouTubeReadResult } from "./youtubeReadClient.ts";
import { EditFailure, type EditSnapshot } from "./editLifecycle.ts";
import type { CategoryListResult, YouTubeCategoryClient } from "./categoryClient.ts";
import { createConnectedEditPort } from "./editComposition.ts";
import type { YouTubeEditProvider } from "./editProvider.ts";
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
      description: `Description ${index}`,
      duration_iso8601: "PT1M30S",
      statistics: { view_count: 10 + index, like_count: 2, comment_count: 1 },
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
  playlistResults?: Array<YouTubeReadResult<YouTubePlaylistsPage>>;
  rateLimit?: { allowed: boolean; retryAfterSeconds: number };
  tokenError?: boolean;
  rateLimitError?: boolean;
  edit?: YouTubeEditPort;
  thumbnail?: YouTubeThumbnailPort;
  captions?: YouTubeCaptionPort;
  categories?: YouTubeCategoryClient;
} = {}) {
  const accessToken = crypto.randomUUID() + crypto.randomUUID();
  const refreshToken = crypto.randomUUID() + crypto.randomUUID();
  const calls = { auth: 0, load: 0, tokens: 0, channel: 0, uploads: 0, video: 0, rateLimit: 0 };
  let playlistCalls = 0;
  const forceFlags: boolean[] = [];
  const uploadInputs: Array<{ channelId: string; pageSize: number; pageToken?: string }> = [];
  const videoInputs: Array<{ channelId: string; videoId: string }> = [];
  const playlistInputs: Array<{ channelId: string; pageToken?: string }> = [];
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
        if (overrides.tokenError) return Promise.reject(new Error("token store unavailable"));
        forceFlags.push(options.force);
        const queued = overrides.tokenResults?.[calls.tokens];
        calls.tokens++;
        return Promise.resolve(queued ?? { ok: true, accessToken, minted: false });
      },
    },
    edit: overrides.edit,
    thumbnail: overrides.thumbnail,
    captions: overrides.captions,
    categories: overrides.categories ?? {
      list: (_token, input): Promise<CategoryListResult> => {
        const arabic = typeof input.locale === "string" && input.locale.startsWith("ar");
        return Promise.resolve({
          ok: true,
          region: typeof input.region === "string" ? input.region.toUpperCase() : "US",
          locale: arabic ? "ar" : "en",
          value: [
            { id: "22", name: arabic ? "الأشخاص والمدونات" : "People & Blogs", label: arabic ? "\u206822\u2069 (الأشخاص والمدونات)" : "\u206822\u2069 (People & Blogs)", assignable: true },
            { id: "30", name: arabic ? "الأفلام" : "Movies", label: arabic ? "\u206830\u2069 (الأفلام)" : "\u206830\u2069 (Movies)", assignable: false },
          ],
        });
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
      listPlaylists: (_token, input) => {
        playlistInputs.push(input);
        const queued = overrides.playlistResults?.[playlistCalls];
        playlistCalls++;
        return Promise.resolve(
          queued ?? {
            ok: true,
            value: {
              items: [{
                id: "PLfixtureplaylist001",
                title: "My Playlist",
                privacy_status: "public",
                thumbnail_url: null,
              }],
              next_page_token: "PL_NEXT",
            },
          },
        );
      },
    },
    rateLimit: {
      check: () => {
        calls.rateLimit++;
        if (overrides.rateLimitError) return Promise.reject(new Error("rate limit read failed"));
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
    playlistInputs,
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

Deno.test("categories is owner-bound and returns the provider's regional catalog", async () => {
  const { handler, calls } = fixture();
  const response = await handler(request({
    operation: "categories", account_id: ACCOUNT_ID, region: "sa", locale: "ar-EG",
  }));
  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.data.region, "SA");
  assertEquals(body.data.locale, "ar");
  assertEquals(body.data.source, "provider");
  assertEquals(body.data.categories.length, 2);
  assertEquals(body.data.categories.find((c: { id: string }) => c.id === "30").assignable, false);
  assertEquals(body.data.categories.find((c: { id: string }) => c.id === "22").label, "\u206822\u2069 (الأشخاص والمدونات)");
  assertEquals(calls.load, 1);
  assertEquals(calls.tokens, 1);
  assertEquals(calls.video, 0);

  const anonymous = fixture({ authenticated: false });
  assertEquals((await anonymous.handler(request({ operation: "categories", account_id: ACCOUNT_ID }))).status, 401);
});

Deno.test("a failed provider catalog read is a typed refusal with a retry hint", async () => {
  const failing = fixture({
    categories: {
      list: () => Promise.resolve({ ok: false, code: "quota_exceeded", retryAfterSeconds: 900 }),
    },
  });
  const response = await failing.handler(request({
    operation: "categories", account_id: ACCOUNT_ID, region: "US", locale: "en",
  }));
  assertEquals(response.status, 429);
  const body = await response.json();
  assertEquals(body.error, "quota_exceeded");
  assertEquals(body.retry_after_seconds, 900);
});

Deno.test("edit capability is available for native all-scopes accounts", async () => {
  const { handler } = fixture();
  const response = await handler(request({ operation: "capabilities", account_id: ACCOUNT_ID }));
  const body = await response.json();

  assertEquals(body.data.capabilities.edit_metadata, {
    state: "available",
  });
  assertEquals(body.data.capabilities.browse, { state: "available" });
});

Deno.test("edit operations are refused before any provider or token call", async () => {
  for (const operation of ["edit_snapshot", "update_video"] as const) {
    const { handler, calls, logs } = fixture();
    const body = operation === "edit_snapshot"
      ? { operation, account_id: ACCOUNT_ID, video_id: "videoAAAAAAA" }
      : {
        operation,
        account_id: ACCOUNT_ID,
        video_id: "videoAAAAAAA",
        base_revision: "base",
        changes: { title: "A new title" },
      };
    const response = await handler(request(body));

    assertEquals(response.status, 403);
    assertEquals((await response.json()).error, "write_not_enabled");
    assertEquals(calls.tokens, 0);
    assertEquals(calls.channel, 0);
    assertEquals(calls.uploads, 0);
    assertEquals(calls.video, 0);
    assertEquals(calls.rateLimit, 0);
    assertEquals(logs.map((entry) => [entry.operation, entry.code]), [
      [operation, "write_not_enabled"],
    ]);
  }
});

Deno.test("an injected edit port drives the real handler snapshot response", async () => {
  const snapshot: EditSnapshot = {
    revision: "rev-1",
    fetchedAt: "2026-11-22T10:00:00.000Z",
    videoId: "videoAAAAAAA",
    channelId: CHANNEL_ID,
    values: {
      title: "Old", description: "", tags: [], categoryId: "22", privacyStatus: "private",
      embeddable: false, license: "youtube", publicStatsViewable: false,
      selfDeclaredMadeForKids: false, containsSyntheticMedia: false,
      defaultLanguage: null, publishAt: null,
    },
    restrictions: { scheduleProtected: false, unknownFieldsBlocked: false },
  };
  const { handler } = fixture({
    edit: {
      snapshot: () => Promise.resolve(snapshot),
      update: () => Promise.resolve({ snapshot, verified: true }),
    },
  });
  const result = await handler(request({ operation: "edit_snapshot", account_id: ACCOUNT_ID, video_id: "videoAAAAAAA" }));
  assertEquals(result.status, 200);
  const body = await result.json();
  assertEquals(body.data.revision, "rev-1");
  assertEquals(body.data.values.selfDeclaredMadeForKids, false);
  // An update goes through the same seam and reports verification truthfully.
  const saved = await handler(request({
    operation: "update_video",
    account_id: ACCOUNT_ID,
    video_id: "videoAAAAAAA",
    base_revision: "rev-1",
    changes: { title: "New" },
  }));
  assertEquals(saved.status, 200);
  assertEquals((await saved.json()).data.revision, "rev-1");
});

Deno.test("handler maps edit conflicts and unknown verification results", async () => {
  const conflict = fixture({
    edit: {
      snapshot: () => Promise.reject(new EditFailure("edit_conflict", "stale")),
      update: () => Promise.reject(new EditFailure("edit_conflict", "stale")),
      failureCode: (error) => error instanceof EditFailure ? error.code : null,
    },
  });
  const conflictResponse = await conflict.handler(request({
    operation: "update_video", account_id: ACCOUNT_ID, video_id: "videoAAAAAAA",
    base_revision: "stale", changes: { title: "New" },
  }));
  assertEquals(conflictResponse.status, 409);
  assertEquals((await conflictResponse.json()).error, "edit_conflict");

  const snapshot: EditSnapshot = {
    revision: "rev-1", fetchedAt: "2026-11-22T10:00:00.000Z", videoId: "videoAAAAAAA",
    channelId: CHANNEL_ID,
    values: {
      title: "Old", description: "", tags: [], categoryId: "22", privacyStatus: "private",
      embeddable: false, license: "youtube", publicStatsViewable: false,
      selfDeclaredMadeForKids: false, containsSyntheticMedia: false,
      defaultLanguage: null, publishAt: null,
    },
    restrictions: { scheduleProtected: false, unknownFieldsBlocked: false },
  };
  const unknown = fixture({
    edit: {
      snapshot: () => Promise.resolve(snapshot),
      update: () => Promise.resolve({ snapshot, verified: false }),
    },
  });
  const unknownResponse = await unknown.handler(request({
    operation: "update_video", account_id: ACCOUNT_ID, video_id: "videoAAAAAAA",
    base_revision: "rev-1", changes: { title: "New" },
  }));
  assertEquals(unknownResponse.status, 502);
  assertEquals((await unknownResponse.json()).error, "outcome_unknown");
});

Deno.test("the approved synthetic composition drives a real connected snapshot and save through the handler", async () => {
  let providerVideo = {
    id: "videoAAAAAAA",
    etag: '"etag-1"',
    snippet: {
      channelId: CHANNEL_ID,
      title: "Original",
      description: "Body",
      tags: [],
      categoryId: "22",
      defaultLanguage: "ar",
    },
    status: { privacyStatus: "private", embeddable: false, selfDeclaredMadeForKids: false },
  };
  const writes: Array<{ part: string; etag: string; body: Record<string, unknown> }> = [];
  const provider: YouTubeEditProvider = {
    getVideo: (_token, input) => Promise.resolve(
      input.videoId === providerVideo.id && providerVideo.snippet.channelId === input.channelId
        ? { ok: true as const, value: providerVideo }
        : { ok: false as const, code: "not_found" as const },
    ),
    updateVideo: (_token, input) => {
      writes.push({ part: input.plan.parts.join(","), etag: input.plan.ifMatch, body: input.plan.body });
      // The fake provider applies the conditional write, so the same-ID reread
      // can verify the intended field values.
      providerVideo = {
        ...providerVideo,
        snippet: { ...providerVideo.snippet, ...(input.plan.body.snippet as typeof providerVideo.snippet) },
      };
      return Promise.resolve({ ok: true as const, id: input.videoId });
    },
  };
  const connected = createConnectedEditPort({
    enabled: true,
    provider,
    categories: {
      list: () => Promise.resolve({
        ok: true as const,
        region: "US",
        locale: "en" as const,
        value: [{ id: "22", name: "People & Blogs", label: "\u206822\u2069 (People & Blogs)", assignable: true }],
      }),
    },
    tokens: {
      get: () => Promise.resolve({ ok: true as const, accessToken: "fixture-token", minted: false }),
    },
    accounts: {
      load: ({ accountId, userId }) => Promise.resolve({
        id: accountId, userId, channelId: CHANNEL_ID, authProvider: null,
        needsReauth: false, accessToken: "fixture-token", refreshToken: null,
        tokenExpiresAt: null, accountMetadata: null,
      }),
    },
    clock: { now: () => new Date("2026-11-22T10:00:00.000Z") },
    writeGuard: {
      authorizeWrite: () => Promise.resolve({ ok: true as const }),
      stillBound: () => Promise.resolve(true),
    },
  });
  const { handler } = fixture({ edit: connected });

  const snapshotResponse = await handler(request({
    operation: "edit_snapshot", account_id: ACCOUNT_ID, video_id: "videoAAAAAAA",
  }));
  assertEquals(snapshotResponse.status, 200);
  const snapshotBody = await snapshotResponse.json();
  const revision = snapshotBody.data.revision as string;
  assertEquals(typeof revision, "string");

  const saved = await handler(request({
    operation: "update_video", account_id: ACCOUNT_ID, video_id: "videoAAAAAAA",
    base_revision: revision, changes: { title: "Renamed" },
  }));
  assertEquals(saved.status, 200);
  const savedBody = await saved.json();
  assertEquals(savedBody.data.values.title, "Renamed");
  assertEquals(savedBody.data.revision !== revision, true);
  assertEquals(writes.length, 1);
  assertEquals(writes[0].etag, '"etag-1"');
  assertEquals(writes[0].part, "snippet");
  assertEquals((writes[0].body.snippet as Record<string, unknown>).title, "Renamed");
});

Deno.test("edit_snapshot and update_video are gated by admit() before editPort is called", async () => {
  const cases: Array<{
    name: string;
    overrides: Parameters<typeof fixture>[0];
    expectedStatus: number;
    expectedCode: string;
    expectedRetryAfter?: number;
  }> = [
    {
      name: "composio",
      overrides: { account: { authProvider: "composio" } },
      expectedStatus: 409,
      expectedCode: "provider_unsupported",
    },
    {
      name: "reconnect required",
      overrides: { account: { needsReauth: true } },
      expectedStatus: 409,
      expectedCode: "reconnect_required",
    },
    {
      name: "read rate limit",
      overrides: { rateLimit: { allowed: false, retryAfterSeconds: 33 } },
      expectedStatus: 429,
      expectedCode: "rate_limited",
      expectedRetryAfter: 33,
    },
  ];

  for (const testCase of cases) {
    for (const operation of ["edit_snapshot", "update_video"] as const) {
      let portCalled = 0;
      const { handler } = fixture({
        ...testCase.overrides,
        edit: {
          snapshot: () => {
            portCalled += 1;
            throw new Error("should not run");
          },
          update: () => {
            portCalled += 1;
            throw new Error("should not run");
          },
        },
      });
      const body = operation === "edit_snapshot"
        ? { operation, account_id: ACCOUNT_ID, video_id: "videoAAAAAAA" }
        : {
          operation,
          account_id: ACCOUNT_ID,
          video_id: "videoAAAAAAA",
          base_revision: "rev-1",
          changes: { title: "Renamed" },
        };
      const response = await handler(request(body));
      assertEquals(response.status, testCase.expectedStatus, `${testCase.name} (${operation})`);
      const json = await response.json();
      assertEquals(json.error, testCase.expectedCode, `${testCase.name} (${operation})`);
      if (testCase.expectedRetryAfter !== undefined) {
        assertEquals(json.retry_after_seconds, testCase.expectedRetryAfter, `${testCase.name} (${operation})`);
      }
      assertEquals(portCalled, 0, `${testCase.name} (${operation}) must not call editPort`);
    }
  }
});

Deno.test("edit_snapshot and update_video refuse missing_scope when force-ssl is absent even if readonly is granted", async () => {
  let portCalled = 0;
  const { handler, calls } = fixture({
    account: { accountMetadata: { granted_scopes: [YOUTUBE_SCOPE.readonly] } },
    edit: {
      snapshot: () => {
        portCalled += 1;
        throw new Error("should not run");
      },
      update: () => {
        portCalled += 1;
        throw new Error("should not run");
      },
    },
  });
  for (const body of [
    { operation: "edit_snapshot", account_id: ACCOUNT_ID, video_id: "videoAAAAAAA" },
    { operation: "update_video", account_id: ACCOUNT_ID, video_id: "videoAAAAAAA", base_revision: "rev-1", changes: { title: "Renamed" } },
  ]) {
    const response = await handler(request(body));
    assertEquals(response.status, 403);
    assertEquals((await response.json()).error, "missing_scope");
  }
  assertEquals(portCalled, 0);
  assertEquals(calls.rateLimit, 0);
});

Deno.test("handler maps rate_limited EditFailure to HTTP 429 with retry_after_seconds", async () => {
  const { handler } = fixture({
    edit: {
      snapshot: () => Promise.reject(new EditFailure("rate_limited", "slow down", { retryAfterSeconds: 75 })),
      update: () => Promise.reject(new EditFailure("rate_limited", "slow down", { retryAfterSeconds: 75 })),
      failureCode: (error) => error instanceof EditFailure ? error.code : null,
      retryAfterSeconds: (error) => error instanceof EditFailure ? error.retryAfterSeconds : undefined,
    },
  });
  const response = await handler(request({
    operation: "update_video",
    account_id: ACCOUNT_ID,
    video_id: "videoAAAAAAA",
    base_revision: "rev-1",
    changes: { title: "New" },
  }));
  assertEquals(response.status, 429);
  const body = await response.json();
  assertEquals(body.error, "rate_limited");
  assertEquals(body.retry_after_seconds, 75);
});

Deno.test("edit requests with unknown keys or empty changes are invalid", async () => {
  const { handler } = fixture();
  const unknownKey = await handler(request({
    operation: "edit_snapshot",
    account_id: ACCOUNT_ID,
    video_id: "videoAAAAAAA",
    raw_google_part: "snippet",
  }));
  assertEquals(unknownKey.status, 400);

  const emptyChanges = await handler(request({
    operation: "update_video",
    account_id: ACCOUNT_ID,
    video_id: "videoAAAAAAA",
    base_revision: "base",
    changes: {},
  }));
  assertEquals(emptyChanges.status, 400);
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

Deno.test("refusals after the body parse carry the requested operation in the log", async () => {
  const { handler, logs } = fixture();
  const foreign = await handler(request({ operation: "channel", account_id: FOREIGN_ACCOUNT_ID }));
  assertEquals(foreign.status, 404);
  assertEquals(logs.map((entry) => entry.operation), ["channel"]);
  const unknownOperation = await handler(request({ operation: "bogus", account_id: ACCOUNT_ID }));
  assertEquals(unknownOperation.status, 400);
  // An arbitrary operation string is never echoed into the log.
  assertEquals(logs[1].operation, "unknown");
  assertEquals(logs[1].code, "invalid_request");
});

Deno.test("a malformed body is logged with the unknown operation", async () => {
  const { handler, logs } = fixture();
  const response = await handler(rawRequest("{not json"));
  assertEquals(response.status, 400);
  assertEquals(logs.map((entry) => entry.operation), ["unknown"]);
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

Deno.test("the categories read is rate limited before any token or provider call", async () => {
  let categoryCalls = 0;
  const { handler, calls } = fixture({
    rateLimit: { allowed: false, retryAfterSeconds: 60 },
    categories: {
      list: () => {
        categoryCalls += 1;
        return Promise.resolve({ ok: true as const, value: [], region: "US", locale: "en" as const });
      },
    },
  });
  const response = await handler(request({ operation: "categories", account_id: ACCOUNT_ID }));
  assertEquals(response.status, 429);
  assertEquals((await response.json()).error, "rate_limited");
  assertEquals(categoryCalls, 0);
  assertEquals(calls.tokens, 0);
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
  assertEquals(body.data.items[0].description, "Description 0");
  assertEquals(body.data.items[0].duration_iso8601, "PT1M30S");
  assertEquals(body.data.items[0].statistics, { view_count: 10, like_count: 2, comment_count: 1 });
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

Deno.test("a channel with zero uploads answers 200 with the empty page", async () => {
  // The read client maps Google's 404 playlistNotFound to this empty page; the
  // handler relays it as success and must not turn it into an error.
  const { handler } = fixture({
    uploadResults: [{ ok: true, value: { items: [], next_page_token: null, total_results: 0 } }],
  });
  const response = await handler(request({ operation: "videos", account_id: ACCOUNT_ID }));
  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.data, { items: [], next_page_token: null, total_results: 0 });
  assertEquals(body.freshness.source, "provider");
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

Deno.test("a throwing token store is an internal error and leaks nothing", async () => {
  const { handler, calls } = fixture({ tokenError: true });
  const response = await handler(request(CHANNEL_REQUEST));
  assertEquals(response.status, 500);
  const text = await response.text();
  assertEquals(text.includes("token store unavailable"), false);
  assertEquals(JSON.parse(text), { error: "internal_error", request_id: REQUEST_ID });
  assertEquals(calls.channel, 0);
});

Deno.test("a throwing rate limiter is an internal error", async () => {
  const { handler } = fixture({ rateLimitError: true });
  const response = await handler(request(CHANNEL_REQUEST));
  assertEquals(response.status, 500);
  const text = await response.text();
  assertEquals(text.includes("rate limit read failed"), false);
  assertEquals(JSON.parse(text).error, "internal_error");
});

Deno.test("a row without a stored channel is reconnect_required before any token read", async () => {
  const { handler, calls } = fixture({ account: { channelId: null } });
  const response = await handler(request(CHANNEL_REQUEST));
  assertEquals(response.status, 409);
  assertEquals((await response.json()).error, "reconnect_required");
  assertEquals([calls.tokens, calls.channel, calls.rateLimit], [0, 0, 0]);
});

Deno.test("the single forced-refresh repeat also covers the videos operation", async () => {
  const { handler, calls, forceFlags } = fixture({
    uploadResults: [{ ok: false, code: "reconnect_required", unauthorized: true }],
  });
  const response = await handler(request({ operation: "videos", account_id: ACCOUNT_ID }));
  assertEquals(response.status, 200);
  assertEquals(forceFlags, [false, true]);
  assertEquals(calls.uploads, 2);
});

Deno.test("the single forced-refresh repeat also covers the video operation", async () => {
  const { handler, calls, forceFlags } = fixture({
    videoResults: [{ ok: false, code: "reconnect_required", unauthorized: true }],
  });
  const response = await handler(request(VIDEO_REQUEST));
  assertEquals(response.status, 200);
  assertEquals(forceFlags, [false, true]);
  assertEquals(calls.video, 2);
});

Deno.test("playlists operation pages through admit and providerRead, and shares 401 refresh and invalid_cursor", async () => {
  const { handler, calls, forceFlags, playlistInputs } = fixture({
    playlistResults: [
      { ok: false, code: "reconnect_required", unauthorized: true },
      {
        ok: true,
        value: {
          items: [{ id: "PLfixtureplaylist001", title: "My Playlist", privacy_status: "public", thumbnail_url: null }],
          next_page_token: "NEXT_CURSOR",
        },
      },
    ],
  });
  const response = await handler(request({ operation: "playlists", account_id: ACCOUNT_ID, page_token: "P1" }));
  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.data.next_page_token, "NEXT_CURSOR");
  assertEquals(body.data.items.length, 1);
  assertEquals(forceFlags, [false, true]);
  assertEquals(playlistInputs.length, 2);
  assertEquals(playlistInputs, [{ channelId: CHANNEL_ID, pageToken: "P1" }, { channelId: CHANNEL_ID, pageToken: "P1" }]);

  const badCursor = fixture({
    playlistResults: [{ ok: false, code: "invalid_cursor", unauthorized: false }],
  });
  const cursorResp = await badCursor.handler(request({ operation: "playlists", account_id: ACCOUNT_ID, page_token: "bad" }));
  assertEquals(cursorResp.status, 400);
  assertEquals((await cursorResp.json()).error, "invalid_cursor");

  const composio = fixture({ account: { authProvider: "composio" } });
  const composioResp = await composio.handler(request({ operation: "playlists", account_id: ACCOUNT_ID }));
  assertEquals(composioResp.status, 409);
  assertEquals((await composioResp.json()).error, "provider_unsupported");
  assertEquals(composio.playlistInputs.length, 0);
});

const MEDIA_FILE_ID = "0ee30001-0000-4000-8000-000000000031";

Deno.test("set_thumbnail validates request shape and refuses when port is disabled", async () => {
  const { handler, logs } = fixture();
  const badMedia = await handler(request({
    operation: "set_thumbnail",
    account_id: ACCOUNT_ID,
    video_id: "videoAAAAAAA",
    media_file_id: "not-a-uuid",
  }));
  assertEquals(badMedia.status, 400);
  assertEquals((await badMedia.json()).error, "invalid_request");
  assertEquals(logs[0].operation, "set_thumbnail");

  const badVideo = await handler(request({
    operation: "set_thumbnail",
    account_id: ACCOUNT_ID,
    video_id: "../etc",
    media_file_id: MEDIA_FILE_ID,
  }));
  assertEquals(badVideo.status, 400);

  const extraKey = await handler(request({
    operation: "set_thumbnail",
    account_id: ACCOUNT_ID,
    video_id: "videoAAAAAAA",
    media_file_id: MEDIA_FILE_ID,
    extra: true,
  }));
  assertEquals(extraKey.status, 400);

  const disabled = await handler(request({
    operation: "set_thumbnail",
    account_id: ACCOUNT_ID,
    video_id: "videoAAAAAAA",
    media_file_id: MEDIA_FILE_ID,
  }));
  assertEquals(disabled.status, 403);
  assertEquals((await disabled.json()).error, "write_not_enabled");
});

Deno.test("set_thumbnail runs admit() before calling the thumbnail port", async () => {
  let portCalls = 0;
  const thumbnail: YouTubeThumbnailPort = {
    setThumbnail: () => {
      portCalls += 1;
      return Promise.resolve({ ok: true, value: { video_id: "videoAAAAAAA", applied: true } });
    },
  };

  const composio = fixture({ account: { authProvider: "composio" }, thumbnail });
  const composioResp = await composio.handler(request({
    operation: "set_thumbnail",
    account_id: ACCOUNT_ID,
    video_id: "videoAAAAAAA",
    media_file_id: MEDIA_FILE_ID,
  }));
  assertEquals(composioResp.status, 409);
  assertEquals((await composioResp.json()).error, "provider_unsupported");
  assertEquals(portCalls, 0);

  const rateLimited = fixture({ rateLimit: { allowed: false, retryAfterSeconds: 45 }, thumbnail });
  const limitedResp = await rateLimited.handler(request({
    operation: "set_thumbnail",
    account_id: ACCOUNT_ID,
    video_id: "videoAAAAAAA",
    media_file_id: MEDIA_FILE_ID,
  }));
  assertEquals(limitedResp.status, 429);
  assertEquals(await limitedResp.json(), {
    error: "rate_limited",
    request_id: REQUEST_ID,
    retry_after_seconds: 45,
  });
  assertEquals(portCalls, 0);
});

Deno.test("set_thumbnail returns success envelope and maps port error codes", async () => {
  const okFixture = fixture({
    thumbnail: {
      setThumbnail: ({ videoId }) => Promise.resolve({ ok: true, value: { video_id: videoId, applied: true } }),
    },
  });
  const okResp = await okFixture.handler(request({
    operation: "set_thumbnail",
    account_id: ACCOUNT_ID,
    video_id: "videoAAAAAAA",
    media_file_id: MEDIA_FILE_ID,
  }));
  assertEquals(okResp.status, 200);
  assertEquals(await okResp.json(), {
    schema_version: 1,
    request_id: REQUEST_ID,
    freshness: { fetched_at: "2026-11-20T10:00:00.000Z", source: "provider" },
    data: { video_id: "videoAAAAAAA", applied: true },
  });

  const errorCases: Array<{
    result: Awaited<ReturnType<YouTubeThumbnailPort["setThumbnail"]>>;
    status: number;
    body: Record<string, unknown>;
  }> = [
    {
      result: { ok: false, code: "media_not_usable" },
      status: 400,
      body: { error: "media_not_usable", request_id: REQUEST_ID },
    },
    {
      result: { ok: false, code: "thumbnail_not_allowed" },
      status: 403,
      body: { error: "thumbnail_not_allowed", request_id: REQUEST_ID },
    },
    {
      result: { ok: false, code: "outcome_unknown" },
      status: 502,
      body: { error: "outcome_unknown", request_id: REQUEST_ID },
    },
    {
      result: { ok: false, code: "rate_limited", retryAfterSeconds: 90 },
      status: 429,
      body: { error: "rate_limited", request_id: REQUEST_ID, retry_after_seconds: 90 },
    },
    {
      result: { ok: false, code: "quota_exceeded" },
      status: 429,
      body: { error: "quota_exceeded", request_id: REQUEST_ID },
    },
  ];

  for (const testCase of errorCases) {
    const errFixture = fixture({
      thumbnail: { setThumbnail: () => Promise.resolve(testCase.result) },
    });
    const resp = await errFixture.handler(request({
      operation: "set_thumbnail",
      account_id: ACCOUNT_ID,
      video_id: "videoAAAAAAA",
      media_file_id: MEDIA_FILE_ID,
    }));
    assertEquals(resp.status, testCase.status);
    assertEquals(await resp.json(), testCase.body);
  }
});

Deno.test("body cap accepts normal 300-byte request and rejects > 1.5 MiB body before parsing", async () => {
  const f = fixture();
  const smallBody = JSON.stringify({ operation: "capabilities", account_id: ACCOUNT_ID });
  const okResp = await f.handler(rawRequest(smallBody));
  assertEquals(okResp.status, 200);

  const overCap = JSON.stringify({
    operation: "upload_caption",
    account_id: ACCOUNT_ID,
    video_id: "videoAAAAAAA",
    language: "en",
    name: "Oversize",
    format: "vtt",
    content: "a".repeat(YOUTUBE_RESOURCES_MAX_BODY_BYTES + 1024),
  });
  const badResp = await f.handler(rawRequest(overCap));
  assertEquals(badResp.status, 400);
  assertEquals(await badResp.json(), { error: "invalid_request", request_id: `${REQUEST_ID}-2` });
  assertEquals(f.calls.load, 1);

  const brokenStream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(new Error("client disconnected mid-stream"));
    },
  });
  const brokenReq = new Request(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: brokenStream,
    duplex: "half",
  } as RequestInit);
  const brokenResp = await f.handler(brokenReq);
  assertEquals(brokenResp.status, 400);
  assertEquals(await brokenResp.json(), { error: "invalid_request", request_id: `${REQUEST_ID}-3` });
});

Deno.test("upload_caption passes ~500 KiB Arabic caption through 1.5 MiB body cap and rejects ~300k Arabic chars as caption_invalid", async () => {
  let portCalls = 0;
  const f = fixture({
    captions: {
      listCaptions: () => Promise.resolve({ ok: true, value: { video_id: "videoAAAAAAA", items: [] } }),
      uploadCaption: (input) => {
        portCalls += 1;
        const checked = validateCaptionUploadInput({
          language: input.language,
          name: input.name,
          format: input.format,
          content: input.content,
        });
        if (!checked.ok) {
          return Promise.resolve({ ok: false, code: "caption_invalid" });
        }
        return Promise.resolve({
          ok: true,
          value: {
            video_id: input.videoId,
            track: {
              id: "cap-ar-1",
              language: input.language,
              name: input.name,
              track_kind: "standard",
              is_draft: false,
              status: "serving",
              last_updated: "2026-11-27T10:00:00Z",
            },
          },
        });
      },
    },
  });

  const prefix = "1\n00:00:01,000 --> 00:00:02,000\n";
  // ~250,000 Arabic chars = ~500 KiB UTF-8 bytes (< 512 KiB limit)
  const validArabic = `${prefix}${"م".repeat(250_000)}`;
  const okResp = await f.handler(request({
    operation: "upload_caption",
    account_id: ACCOUNT_ID,
    video_id: "videoAAAAAAA",
    language: "ar",
    name: "Arabic 500 KiB",
    format: "srt",
    content: validArabic,
  }));
  assertEquals(okResp.status, 200);
  assertEquals(portCalls, 1);

  // ~300,000 Arabic chars = ~600 KiB UTF-8 bytes (< 1.5 MiB body cap, > 512 KiB caption cap)
  const oversizeArabic = `${prefix}${"م".repeat(300_000)}`;
  const invalidResp = await f.handler(request({
    operation: "upload_caption",
    account_id: ACCOUNT_ID,
    video_id: "videoAAAAAAA",
    language: "ar",
    name: "Arabic 600 KiB",
    format: "srt",
    content: oversizeArabic,
  }));
  assertEquals(invalidResp.status, 400);
  assertEquals(await invalidResp.json(), { error: "caption_invalid", request_id: `${REQUEST_ID}-2` });
  assertEquals(portCalls, 2);
});

Deno.test("captions and upload_caption gate on admit() before calling port and map all error codes", async () => {
  let portCalls = 0;
  const composioFixture = fixture({
    account: { authProvider: "composio" },
    captions: {
      listCaptions: () => {
        portCalls += 1;
        return Promise.resolve({ ok: true, value: { video_id: "videoAAAAAAA", items: [] } });
      },
      uploadCaption: () => {
        portCalls += 1;
        return Promise.resolve({ ok: false, code: "caption_invalid" });
      },
    },
  });
  const composioResp = await composioFixture.handler(request({
    operation: "captions",
    account_id: ACCOUNT_ID,
    video_id: "videoAAAAAAA",
  }));
  assertEquals(composioResp.status, 409);
  assertEquals(await composioResp.json(), { error: "provider_unsupported", request_id: REQUEST_ID });
  assertEquals(portCalls, 0);

  const noPortFixture = fixture();
  const noPortResp = await noPortFixture.handler(request({
    operation: "captions",
    account_id: ACCOUNT_ID,
    video_id: "videoAAAAAAA",
  }));
  assertEquals(noPortResp.status, 403);
  assertEquals(await noPortResp.json(), { error: "write_not_enabled", request_id: REQUEST_ID });

  const errorCases: Array<{
    result: Awaited<ReturnType<YouTubeCaptionPort["uploadCaption"]>>;
    status: number;
    body: Record<string, unknown>;
  }> = [
    { result: { ok: false, code: "caption_invalid" }, status: 400, body: { error: "caption_invalid", request_id: REQUEST_ID } },
    { result: { ok: false, code: "caption_conflict" }, status: 409, body: { error: "caption_conflict", request_id: REQUEST_ID } },
    { result: { ok: false, code: "outcome_unknown" }, status: 502, body: { error: "outcome_unknown", request_id: REQUEST_ID } },
    {
      result: { ok: false, code: "rate_limited", retryAfterSeconds: 60 },
      status: 429,
      body: { error: "rate_limited", request_id: REQUEST_ID, retry_after_seconds: 60 },
    },
    { result: { ok: false, code: "quota_exceeded" }, status: 429, body: { error: "quota_exceeded", request_id: REQUEST_ID } },
  ];

  for (const testCase of errorCases) {
    const errFixture = fixture({
      captions: {
        listCaptions: () => Promise.resolve({ ok: true, value: { video_id: "videoAAAAAAA", items: [] } }),
        uploadCaption: () => Promise.resolve(testCase.result),
      },
    });
    const resp = await errFixture.handler(request({
      operation: "upload_caption",
      account_id: ACCOUNT_ID,
      video_id: "videoAAAAAAA",
      language: "en",
      name: "English",
      format: "vtt",
      content: "WEBVTT\n\n00:01.000 --> 00:02.000\nHello",
    }));
    assertEquals(resp.status, testCase.status);
    assertEquals(await resp.json(), testCase.body);
  }
});
