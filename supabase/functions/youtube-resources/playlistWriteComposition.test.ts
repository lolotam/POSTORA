import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { YOUTUBE_SCOPE } from "./contracts.ts";
import type { YouTubeResourceAccount, YouTubeTokenResult } from "./handler.ts";
import {
  createYouTubePlaylistWritePort,
  validatePlaylistCreateInput,
  type YouTubePlaylistWriteCompositionDeps,
} from "./playlistWriteComposition.ts";

const USER_ID = "0ee00001-0000-4000-8000-000000000001";
const ACCOUNT_ID = "0ee20001-0000-4000-8000-000000000021";
const CHANNEL_ID = "UCfixturechannel000000001";
const BOUND_BEARER = "yt-access";
const PLAYLIST_ID = "PLfixtureplaylist001";

function makeAccount(overrides: Partial<YouTubeResourceAccount> = {}): YouTubeResourceAccount {
  return {
    id: ACCOUNT_ID,
    userId: USER_ID,
    channelId: CHANNEL_ID,
    channelTitle: "Fixture channel",
    authProvider: null,
    needsReauth: false,
    accessToken: BOUND_BEARER,
    refreshToken: "yt-refresh",
    tokenExpiresAt: "2026-12-01T00:00:00Z",
    accountMetadata: {
      granted_scopes: [YOUTUBE_SCOPE.readonly, YOUTUBE_SCOPE.force_ssl],
    },
    ...overrides,
  };
}

function makeHarness(overrides: {
  counterResult?: Awaited<ReturnType<YouTubePlaylistWriteCompositionDeps["writeLimits"]["checkPlaylistCreateCounter"]>>;
  budgetResult?: Awaited<ReturnType<YouTubePlaylistWriteCompositionDeps["writeLimits"]["debitWriteBudget"]>>;
  tokenResult?: YouTubeTokenResult;
  stillBound?: boolean;
  fetchResponse?: () => Promise<Response>;
} = {}) {
  const order: string[] = [];
  const debits: number[] = [];
  const requests: Array<{
    url: string;
    method: string;
    headers: Headers;
    body: string | null;
    redirect: RequestRedirect | undefined;
  }> = [];

  const port = createYouTubePlaylistWritePort({
    writeLimits: {
      checkPlaylistCreateCounter: () => {
        order.push("counter");
        return Promise.resolve(overrides.counterResult ?? { ok: true });
      },
      debitWriteBudget: (units) => {
        order.push(`debit:${units}`);
        debits.push(units);
        return Promise.resolve(overrides.budgetResult ?? { ok: true, count: units });
      },
    },
    stillBound: () => {
      order.push("stillBound");
      return Promise.resolve(overrides.stillBound ?? true);
    },
    tokens: {
      get: () => {
        order.push("token");
        return Promise.resolve(overrides.tokenResult ?? { ok: true, accessToken: BOUND_BEARER, minted: false });
      },
    },
    fetchImpl: (input, init) => {
      order.push("fetch");
      requests.push({
        url: String(input),
        method: init?.method ?? "GET",
        headers: new Headers(init?.headers),
        body: typeof init?.body === "string" ? init.body : null,
        redirect: init?.redirect,
      });
      if (overrides.fetchResponse) return overrides.fetchResponse();
      return Promise.resolve(
        new Response(
          JSON.stringify({
            id: PLAYLIST_ID,
            snippet: {
              channelId: CHANNEL_ID,
              title: "Tutorials",
              description: "Step by step guides",
              thumbnails: {
                medium: { url: "https://i.ytimg.com/vi/abc/mqdefault.jpg" },
              },
            },
            status: {
              privacyStatus: "unlisted",
            },
          }),
          { status: 200 },
        ),
      );
    },
  });

  return { port, order, debits, requests };
}

Deno.test("validatePlaylistCreateInput enforces title, UTF-8 description bytes, angle brackets, and privacyStatus", () => {
  assertEquals(
    validatePlaylistCreateInput({ title: "  My Playlist  ", description: "Desc", privacyStatus: "private" }),
    {
      ok: true,
      value: { title: "My Playlist", description: "Desc", privacyStatus: "private" },
    },
  );
  assertEquals(
    validatePlaylistCreateInput({ title: "A".repeat(150), privacyStatus: "public" }),
    {
      ok: true,
      value: { title: "A".repeat(150), description: "", privacyStatus: "public" },
    },
  );
  // 2500 Arabic chars = 5000 UTF-8 bytes (exact limit)
  assertEquals(
    validatePlaylistCreateInput({
      title: "قائمة التشغيل",
      description: "م".repeat(2500),
      privacyStatus: "unlisted",
    }).ok,
    true,
  );

  const invalidCases: Array<{ name: string; input: { title: unknown; description?: unknown; privacyStatus: unknown } }> = [
    { name: "empty title", input: { title: "   ", privacyStatus: "private" } },
    { name: "title > 150 chars", input: { title: "a".repeat(151), privacyStatus: "private" } },
    { name: "title with <", input: { title: "Bad <title", privacyStatus: "private" } },
    { name: "title with >", input: { title: "Bad >title", privacyStatus: "private" } },
    { name: "title with \\n", input: { title: "Line 1\nLine 2", privacyStatus: "private" } },
    { name: "title with \\r", input: { title: "Line 1\rLine 2", privacyStatus: "private" } },
    { name: "title with NUL", input: { title: "Bad\0title", privacyStatus: "private" } },
    { name: "description > 5000 UTF-8 bytes (Arabic 2501 chars = 5002 bytes)", input: { title: "Valid", description: "م".repeat(2501), privacyStatus: "private" } },
    { name: "description with <", input: { title: "Valid", description: "no <script>", privacyStatus: "private" } },
    { name: "description with >", input: { title: "Valid", description: "a > b", privacyStatus: "private" } },
    { name: "description with NUL", input: { title: "Valid", description: "bad\0desc", privacyStatus: "private" } },
    { name: "invalid privacyStatus", input: { title: "Valid", privacyStatus: "friends_only" } },
  ];

  for (const testCase of invalidCases) {
    assertEquals(
      validatePlaylistCreateInput(testCase.input),
      { ok: false, code: "invalid_request" },
      testCase.name,
    );
  }
});

Deno.test("step 2: createPlaylist refuses capability states before any validation, counter, budget, token, or fetch call", async () => {
  const cases: Array<{
    name: string;
    account: YouTubeResourceAccount;
    expectedCode: string;
  }> = [
    {
      name: "composio provider -> provider_unsupported",
      account: makeAccount({ authProvider: "composio", accountMetadata: {} }),
      expectedCode: "provider_unsupported",
    },
    {
      name: "needsReauth -> reconnect_required",
      account: makeAccount({ needsReauth: true }),
      expectedCode: "reconnect_required",
    },
    {
      name: "readonly + upload without force_ssl -> missing_scope",
      account: makeAccount({ accountMetadata: { granted_scopes: [YOUTUBE_SCOPE.readonly, YOUTUBE_SCOPE.upload] } }),
      expectedCode: "missing_scope",
    },
    {
      name: "unknown scopes (empty recorded list) -> missing_scope",
      account: makeAccount({ accountMetadata: {} }),
      expectedCode: "missing_scope",
    },
    {
      name: "null channelId -> reconnect_required",
      account: makeAccount({ channelId: null }),
      expectedCode: "reconnect_required",
    },
  ];

  for (const testCase of cases) {
    const harness = makeHarness();
    const result = await harness.port.createPlaylist({
      account: testCase.account,
      userId: USER_ID,
      title: "Tutorials",
      privacyStatus: "private",
    });
    assertEquals(result, { ok: false, code: testCase.expectedCode as never }, testCase.name);
    assertEquals(harness.order, [], testCase.name);
    assertEquals(harness.debits, [], testCase.name);
    assertEquals(harness.requests.length, 0, testCase.name);
  }
});

Deno.test("step 3: createPlaylist refuses invalid fields with zero counter, budget, token, stillBound, or provider calls", async () => {
  const badInputs: Array<{
    name: string;
    title: string;
    description?: string;
  }> = [
    { name: "empty title", title: "   " },
    { name: "title > 150 chars", title: "x".repeat(151) },
    { name: "title with angle bracket", title: "Playlist <1>" },
    { name: "title with newline", title: "Line1\nLine2" },
    { name: "description > 5000 UTF-8 bytes", title: "Valid", description: "م".repeat(2501) },
    { name: "description with angle bracket", title: "Valid", description: "Check > here" },
  ];

  for (const bad of badInputs) {
    const harness = makeHarness();
    const result = await harness.port.createPlaylist({
      account: makeAccount(),
      userId: USER_ID,
      title: bad.title,
      description: bad.description,
      privacyStatus: "private",
    });
    assertEquals(result, { ok: false, code: "invalid_request" }, bad.name);
    assertEquals(harness.order, [], bad.name);
    assertEquals(harness.debits, [], bad.name);
    assertEquals(harness.requests.length, 0, bad.name);
  }
});

Deno.test("step 4: createPlaylist refuses on counter limit with retryAfterSeconds and zero budget or provider calls", async () => {
  const harness = makeHarness({
    counterResult: { ok: false, code: "rate_limited", retryAfterSeconds: 1800 },
  });
  const result = await harness.port.createPlaylist({
    account: makeAccount(),
    userId: USER_ID,
    title: "Tutorials",
    privacyStatus: "private",
  });
  assertEquals(result, { ok: false, code: "rate_limited", retryAfterSeconds: 1800 });
  assertEquals(harness.order, ["counter"]);
  assertEquals(harness.debits, []);
  assertEquals(harness.requests.length, 0);
});

Deno.test("step 5: createPlaylist refuses on budget exhaustion or unreadable budget with quota_exceeded and zero token, stillBound, or provider calls", async () => {
  const harness = makeHarness({
    budgetResult: { ok: false, code: "quota_exceeded", retryAfterSeconds: 900 },
  });
  const result = await harness.port.createPlaylist({
    account: makeAccount(),
    userId: USER_ID,
    title: "Tutorials",
    privacyStatus: "private",
  });
  assertEquals(result, { ok: false, code: "quota_exceeded", retryAfterSeconds: 900 });
  assertEquals(harness.order, ["counter", "debit:50"]);
  assertEquals(harness.debits, [50]);
  assertEquals(harness.requests.length, 0);

  const unreadableBudget = makeHarness({
    budgetResult: { ok: false, code: "upstream_unavailable" },
  });
  const unreadableResult = await unreadableBudget.port.createPlaylist({
    account: makeAccount(),
    userId: USER_ID,
    title: "Tutorials",
    privacyStatus: "private",
  });
  assertEquals(unreadableResult, { ok: false, code: "quota_exceeded" });
  assertEquals(unreadableBudget.order, ["counter", "debit:50"]);
  assertEquals(unreadableBudget.debits, [50]);
  assertEquals(unreadableBudget.requests.length, 0);
});

Deno.test("step 6: createPlaylist refuses on token failure or stillBound=false with zero provider calls", async () => {
  const tokenFailed = makeHarness({
    tokenResult: { ok: false, code: "reconnect_required" },
  });
  assertEquals(
    await tokenFailed.port.createPlaylist({
      account: makeAccount(),
      userId: USER_ID,
      title: "Tutorials",
      privacyStatus: "private",
    }),
    { ok: false, code: "reconnect_required" },
  );
  assertEquals(tokenFailed.order, ["counter", "debit:50", "token"]);
  assertEquals(tokenFailed.requests.length, 0);

  const unbound = makeHarness({ stillBound: false });
  assertEquals(
    await unbound.port.createPlaylist({
      account: makeAccount(),
      userId: USER_ID,
      title: "Tutorials",
      privacyStatus: "private",
    }),
    { ok: false, code: "reconnect_required" },
  );
  assertEquals(unbound.order, ["counter", "debit:50", "token", "stillBound"]);
  assertEquals(unbound.requests.length, 0);
});

Deno.test("steps 7 & 8: createPlaylist executes single POST in spec order and returns normalized playlist item", async () => {
  const harness = makeHarness();
  const result = await harness.port.createPlaylist({
    account: makeAccount(),
    userId: USER_ID,
    title: "  Tutorials  ",
    description: "Step by step guides",
    privacyStatus: "unlisted",
  });

  assertEquals(result, {
    ok: true,
    value: {
      playlist: {
        id: PLAYLIST_ID,
        title: "Tutorials",
        privacy_status: "unlisted",
        thumbnail_url: "https://i.ytimg.com/vi/abc/mqdefault.jpg",
      },
    },
  });
  assertEquals(harness.order, ["counter", "debit:50", "token", "stillBound", "fetch"]);
  assertEquals(harness.debits, [50]);
  assertEquals(harness.requests.length, 1);
  assertEquals(
    harness.requests[0].url,
    "https://www.googleapis.com/youtube/v3/playlists?part=snippet,status",
  );
  assertEquals(harness.requests[0].method, "POST");
  assertEquals(harness.requests[0].redirect, "manual");
  assertEquals(harness.requests[0].headers.get("Authorization"), `Bearer ${BOUND_BEARER}`);
  assertEquals(
    JSON.parse(harness.requests[0].body ?? "{}"),
    {
      snippet: { title: "Tutorials", description: "Step by step guides" },
      status: { privacyStatus: "unlisted" },
    },
  );
});

Deno.test("step 8: 2xx with wrong channelId, invalid playlist id, non-JSON, 3xx redirect, or network throw returns outcome_unknown after single POST", async () => {
  const wrongChannel = makeHarness({
    fetchResponse: () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            id: PLAYLIST_ID,
            snippet: { channelId: "UCotherchannel999999999", title: "Tutorials" },
            status: { privacyStatus: "private" },
          }),
          { status: 200 },
        ),
      ),
  });
  assertEquals(
    await wrongChannel.port.createPlaylist({
      account: makeAccount(),
      userId: USER_ID,
      title: "Tutorials",
      privacyStatus: "private",
    }),
    { ok: false, code: "outcome_unknown" },
  );
  assertEquals(wrongChannel.requests.length, 1);

  const badId = makeHarness({
    fetchResponse: () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            id: "bad/id",
            snippet: { channelId: CHANNEL_ID, title: "Tutorials" },
            status: { privacyStatus: "private" },
          }),
          { status: 200 },
        ),
      ),
  });
  assertEquals(
    await badId.port.createPlaylist({
      account: makeAccount(),
      userId: USER_ID,
      title: "Tutorials",
      privacyStatus: "private",
    }),
    { ok: false, code: "outcome_unknown" },
  );
  assertEquals(badId.requests.length, 1);

  const invalidJson = makeHarness({
    fetchResponse: () => Promise.resolve(new Response("not-json", { status: 200 })),
  });
  assertEquals(
    await invalidJson.port.createPlaylist({
      account: makeAccount(),
      userId: USER_ID,
      title: "Tutorials",
      privacyStatus: "private",
    }),
    { ok: false, code: "outcome_unknown" },
  );
  assertEquals(invalidJson.requests.length, 1);

  const redirect302 = makeHarness({
    fetchResponse: () => Promise.resolve(new Response(null, { status: 302 })),
  });
  assertEquals(
    await redirect302.port.createPlaylist({
      account: makeAccount(),
      userId: USER_ID,
      title: "Tutorials",
      privacyStatus: "private",
    }),
    { ok: false, code: "outcome_unknown" },
  );
  assertEquals(redirect302.requests.length, 1);

  const thrown = makeHarness({
    fetchResponse: () => Promise.reject(new DOMException("The operation timed out.", "TimeoutError")),
  });
  assertEquals(
    await thrown.port.createPlaylist({
      account: makeAccount(),
      userId: USER_ID,
      title: "Tutorials",
      privacyStatus: "private",
    }),
    { ok: false, code: "outcome_unknown" },
  );
  assertEquals(thrown.requests.length, 1);
});

Deno.test("step 8: non-2xx responses classify 400, 401 (without retry), 403 quota/scope, 404, 429, and 5xx", async () => {
  const statusCases: Array<{
    name: string;
    status: number;
    body?: unknown;
    expected: string;
  }> = [
    { name: "400 -> invalid_request", status: 400, expected: "invalid_request" },
    { name: "401 -> reconnect_required (no retry)", status: 401, expected: "reconnect_required" },
    {
      name: "403 quotaExceeded -> quota_exceeded",
      status: 403,
      body: { error: { errors: [{ reason: "quotaExceeded" }] } },
      expected: "quota_exceeded",
    },
    {
      name: "403 insufficientPermissions -> missing_scope",
      status: 403,
      body: { error: { errors: [{ reason: "insufficientPermissions" }] } },
      expected: "missing_scope",
    },
    {
      name: "403 forbidden -> missing_scope",
      status: 403,
      body: { error: { errors: [{ reason: "forbidden" }] } },
      expected: "missing_scope",
    },
    { name: "404 -> not_found", status: 404, expected: "not_found" },
    { name: "429 -> quota_exceeded", status: 429, expected: "quota_exceeded" },
    { name: "503 -> outcome_unknown", status: 503, expected: "outcome_unknown" },
  ];

  for (const testCase of statusCases) {
    const harness = makeHarness({
      fetchResponse: () =>
        Promise.resolve(
          new Response(testCase.body !== undefined ? JSON.stringify(testCase.body) : "", {
            status: testCase.status,
          }),
        ),
    });
    const result = await harness.port.createPlaylist({
      account: makeAccount(),
      userId: USER_ID,
      title: "Tutorials",
      privacyStatus: "private",
    });
    assertEquals(result, { ok: false, code: testCase.expected as never }, testCase.name);
    assertEquals(harness.requests.length, 1, testCase.name);
  }
});
