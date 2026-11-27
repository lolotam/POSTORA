import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  createYouTubeCaptionPort,
  type YouTubeCaptionCompositionDeps,
} from "./captionComposition.ts";
import { YOUTUBE_SCOPE, type YouTubeVideoDetails } from "./contracts.ts";
import type { YouTubeResourceAccount } from "./handler.ts";

const USER_ID = "0ee00001-0000-4000-8000-000000000001";
const ACCOUNT_ID = "0ee20001-0000-4000-8000-000000000021";
const CHANNEL_ID = "UCfixturechannel000000001";
const VIDEO_ID = "videoAAAAAAA";
const BOUND_BEARER = "bound-fixture-123";

const VALID_VTT = "WEBVTT\n\n00:00:01.000 --> 00:00:02.500\nمرحبا بكم\n";

const VIDEO_DETAILS: YouTubeVideoDetails = {
  id: VIDEO_ID,
  channel_id: CHANNEL_ID,
  title: "Fixture Video",
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
  url: `https://www.youtube.com/watch?v=${VIDEO_ID}`,
};

function makeAccount(overrides: Partial<YouTubeResourceAccount> = {}): YouTubeResourceAccount {
  return {
    id: ACCOUNT_ID,
    userId: USER_ID,
    channelId: CHANNEL_ID,
    channelTitle: "Fixture channel",
    authProvider: null,
    needsReauth: false,
    accessToken: BOUND_BEARER,
    refreshToken: "refresh-fixture-123",
    tokenExpiresAt: "2026-12-01T00:00:00Z",
    accountMetadata: {
      granted_scopes: [YOUTUBE_SCOPE.readonly, YOUTUBE_SCOPE.force_ssl],
    },
    ...overrides,
  };
}

function makeHarness(overrides: {
  listCounter?: Awaited<ReturnType<YouTubeCaptionCompositionDeps["writeLimits"]["checkCaptionListCounter"]>>;
  uploadCounter?: Awaited<ReturnType<YouTubeCaptionCompositionDeps["writeLimits"]["checkCaptionUploadCounter"]>>;
  budgetResult?: Awaited<ReturnType<YouTubeCaptionCompositionDeps["writeLimits"]["debitWriteBudget"]>>;
  stillBound?: boolean;
  getVideoResult?: Awaited<ReturnType<YouTubeCaptionCompositionDeps["youtube"]["getVideo"]>>;
  fetchResponse?: () => Promise<Response>;
} = {}) {
  const order: string[] = [];
  const debits: number[] = [];
  const requests: Array<{ url: string; method: string; contentType: string | null; body: string | null }> = [];

  const port = createYouTubeCaptionPort({
    writeLimits: {
      checkCaptionListCounter: () => {
        order.push("listCounter");
        return Promise.resolve(overrides.listCounter ?? { ok: true });
      },
      checkCaptionUploadCounter: () => {
        order.push("uploadCounter");
        return Promise.resolve(overrides.uploadCounter ?? { ok: true });
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
        return Promise.resolve({ ok: true, accessToken: BOUND_BEARER, minted: false });
      },
    },
    youtube: {
      getVideo: () => {
        order.push("getVideo");
        return Promise.resolve(overrides.getVideoResult ?? { ok: true, value: VIDEO_DETAILS });
      },
    },
    fetchImpl: (input, init) => {
      order.push("fetch");
      const headers = new Headers(init?.headers);
      requests.push({
        url: String(input),
        method: init?.method ?? "GET",
        contentType: headers.get("Content-Type"),
        body: typeof init?.body === "string" ? init.body : null,
      });
      if (overrides.fetchResponse) return overrides.fetchResponse();
      if ((init?.method ?? "GET") === "GET") {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              items: [
                {
                  id: "cap-1",
                  snippet: {
                    language: "ar",
                    name: "Arabic",
                    trackKind: "standard",
                    isDraft: false,
                    status: "serving",
                    lastUpdated: "2026-11-27T10:00:00Z",
                  },
                },
              ],
            }),
            { status: 200 },
          ),
        );
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            id: "cap-new-1",
            snippet: {
              language: "ar",
              name: "Arabic",
              trackKind: "standard",
              isDraft: false,
              status: "serving",
              lastUpdated: "2026-11-27T10:05:00Z",
            },
          }),
          { status: 200 },
        ),
      );
    },
  });

  return { port, order, debits, requests };
}

Deno.test("listCaptions runs capability -> counter -> ownership -> 50-unit debit -> GET captions", async () => {
  const harness = makeHarness();
  const result = await harness.port.listCaptions({
    account: makeAccount(),
    userId: USER_ID,
    videoId: VIDEO_ID,
  });

  assertEquals(result, {
    ok: true,
    value: {
      video_id: VIDEO_ID,
      items: [
        {
          id: "cap-1",
          language: "ar",
          name: "Arabic",
          track_kind: "standard",
          is_draft: false,
          status: "serving",
          last_updated: "2026-11-27T10:00:00Z",
        },
      ],
    },
  });
  assertEquals(harness.order, ["listCounter", "token", "getVideo", "debit:50", "fetch"]);
  assertEquals(harness.debits, [50]);
  assertEquals(harness.requests[0].url, `https://www.googleapis.com/youtube/v3/captions?part=snippet&videoId=${VIDEO_ID}`);
});

Deno.test("listCaptions refuses missing_scope, counter limit, and foreign video with zero budget debit", async () => {
  const missingScope = makeHarness();
  const r1 = await missingScope.port.listCaptions({
    account: makeAccount({ accountMetadata: { granted_scopes: [YOUTUBE_SCOPE.readonly] } }),
    userId: USER_ID,
    videoId: VIDEO_ID,
  });
  assertEquals(r1, { ok: false, code: "missing_scope" });
  assertEquals(missingScope.order, []);

  const rateLimited = makeHarness({
    listCounter: { ok: false, code: "rate_limited", retryAfterSeconds: 300 },
  });
  const r2 = await rateLimited.port.listCaptions({
    account: makeAccount(),
    userId: USER_ID,
    videoId: VIDEO_ID,
  });
  assertEquals(r2, { ok: false, code: "rate_limited", retryAfterSeconds: 300 });
  assertEquals(rateLimited.order, ["listCounter"]);

  const foreignVideo = makeHarness({
    getVideoResult: { ok: false, code: "not_found", unauthorized: false },
  });
  const r3 = await foreignVideo.port.listCaptions({
    account: makeAccount(),
    userId: USER_ID,
    videoId: VIDEO_ID,
  });
  assertEquals(r3, { ok: false, code: "not_found" });
  assertEquals(foreignVideo.debits, []);
  assertEquals(foreignVideo.requests.length, 0);

  const budgetRefused = makeHarness({
    budgetResult: { ok: false, code: "quota_exceeded", retryAfterSeconds: 600 },
  });
  const r4 = await budgetRefused.port.listCaptions({
    account: makeAccount(),
    userId: USER_ID,
    videoId: VIDEO_ID,
  });
  assertEquals(r4, { ok: false, code: "quota_exceeded", retryAfterSeconds: 600 });
  assertEquals(budgetRefused.order, ["listCounter", "token", "getVideo", "debit:50"]);
  assertEquals(budgetRefused.requests.length, 0);
});

Deno.test("uploadCaption runs capability -> format check -> counter -> ownership -> 400-unit debit -> stillBound -> multipart POST", async () => {
  const harness = makeHarness();
  const result = await harness.port.uploadCaption({
    account: makeAccount(),
    userId: USER_ID,
    videoId: VIDEO_ID,
    language: "ar",
    name: "Arabic",
    format: "vtt",
    content: VALID_VTT,
  });

  assertEquals(result, {
    ok: true,
    value: {
      video_id: VIDEO_ID,
      track: {
        id: "cap-new-1",
        language: "ar",
        name: "Arabic",
        track_kind: "standard",
        is_draft: false,
        status: "serving",
        last_updated: "2026-11-27T10:05:00Z",
      },
    },
  });
  assertEquals(harness.order, ["uploadCounter", "token", "getVideo", "debit:400", "stillBound", "fetch"]);
  assertEquals(harness.debits, [400]);

  const req = harness.requests[0];
  assertEquals(
    req.url,
    "https://www.googleapis.com/upload/youtube/v3/captions?part=snippet&uploadType=multipart",
  );
  assertEquals(req.method, "POST");
  assertStringIncludes(req.contentType ?? "", "multipart/related; boundary=postora-caption-");
  assertStringIncludes(req.body ?? "", "Content-Type: application/json; charset=UTF-8");
  assertStringIncludes(req.body ?? "", JSON.stringify({ snippet: { videoId: VIDEO_ID, language: "ar", name: "Arabic", isDraft: false } }));
  assertStringIncludes(req.body ?? "", "Content-Type: text/vtt; charset=UTF-8");
  assertStringIncludes(req.body ?? "", VALID_VTT);
});

Deno.test("uploadCaption rejects bad caption file with zero counter, zero ownership, zero budget, and zero fetch", async () => {
  const harness = makeHarness();
  const result = await harness.port.uploadCaption({
    account: makeAccount(),
    userId: USER_ID,
    videoId: VIDEO_ID,
    language: "ar",
    name: "Bad",
    format: "vtt",
    content: "not a valid vtt file",
  });

  assertEquals(result, { ok: false, code: "caption_invalid" });
  assertEquals(harness.order, []);
  assertEquals(harness.debits, []);
  assertEquals(harness.requests.length, 0);
});

Deno.test("uploadCaption rejects foreign video id and lost stillBound with zero upload", async () => {
  const foreignVideo = makeHarness({
    getVideoResult: { ok: false, code: "not_found", unauthorized: false },
  });
  const r1 = await foreignVideo.port.uploadCaption({
    account: makeAccount(),
    userId: USER_ID,
    videoId: VIDEO_ID,
    language: "ar",
    name: "Arabic",
    format: "vtt",
    content: VALID_VTT,
  });
  assertEquals(r1, { ok: false, code: "not_found" });
  assertEquals(foreignVideo.debits, []);
  assertEquals(foreignVideo.requests.length, 0);

  const unbound = makeHarness({ stillBound: false });
  const r2 = await unbound.port.uploadCaption({
    account: makeAccount(),
    userId: USER_ID,
    videoId: VIDEO_ID,
    language: "ar",
    name: "Arabic",
    format: "vtt",
    content: VALID_VTT,
  });
  assertEquals(r2, { ok: false, code: "reconnect_required" });
  assertEquals(unbound.requests.length, 0);

  const budgetRefused = makeHarness({
    budgetResult: { ok: false, code: "quota_exceeded", retryAfterSeconds: 900 },
  });
  const r3 = await budgetRefused.port.uploadCaption({
    account: makeAccount(),
    userId: USER_ID,
    videoId: VIDEO_ID,
    language: "ar",
    name: "Arabic",
    format: "vtt",
    content: VALID_VTT,
  });
  assertEquals(r3, { ok: false, code: "quota_exceeded", retryAfterSeconds: 900 });
  assertEquals(budgetRefused.order, ["uploadCounter", "token", "getVideo", "debit:400"]);
  assertEquals(budgetRefused.requests.length, 0);
});

Deno.test("uploadCaption maps 409 caption_conflict and never retries on timeout/5xx/bad 2xx JSON", async () => {
  const conflict = makeHarness({
    fetchResponse: () => Promise.resolve(new Response(JSON.stringify({}), { status: 409 })),
  });
  assertEquals(
    await conflict.port.uploadCaption({
      account: makeAccount(),
      userId: USER_ID,
      videoId: VIDEO_ID,
      language: "ar",
      name: "Arabic",
      format: "vtt",
      content: VALID_VTT,
    }),
    { ok: false, code: "caption_conflict" },
  );
  assertEquals(conflict.requests.length, 1);

  const server500 = makeHarness({
    fetchResponse: () => Promise.resolve(new Response("", { status: 500 })),
  });
  assertEquals(
    await server500.port.uploadCaption({
      account: makeAccount(),
      userId: USER_ID,
      videoId: VIDEO_ID,
      language: "ar",
      name: "Arabic",
      format: "vtt",
      content: VALID_VTT,
    }),
    { ok: false, code: "outcome_unknown" },
  );
  assertEquals(server500.requests.length, 1);

  const thrown = makeHarness({
    fetchResponse: () => Promise.reject(new Error("timeout")),
  });
  assertEquals(
    await thrown.port.uploadCaption({
      account: makeAccount(),
      userId: USER_ID,
      videoId: VIDEO_ID,
      language: "ar",
      name: "Arabic",
      format: "vtt",
      content: VALID_VTT,
    }),
    { ok: false, code: "outcome_unknown" },
  );
  assertEquals(thrown.requests.length, 1);

  const bad200 = makeHarness({
    fetchResponse: () => Promise.resolve(new Response("not-json", { status: 200 })),
  });
  assertEquals(
    await bad200.port.uploadCaption({
      account: makeAccount(),
      userId: USER_ID,
      videoId: VIDEO_ID,
      language: "ar",
      name: "Arabic",
      format: "vtt",
      content: VALID_VTT,
    }),
    { ok: false, code: "outcome_unknown" },
  );
  assertEquals(bad200.requests.length, 1);
});
