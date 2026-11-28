import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  checkCaptionListCounter,
  checkCaptionUploadCounter,
  checkPlaylistCreateCounter,
  checkUserWriteCounters,
  debitWriteBudget,
  parseStrictRateLimitDecision,
  YOUTUBE_CAPTION_LIST_DAILY_LIMIT,
  YOUTUBE_CAPTION_UPLOAD_DAILY_LIMIT,
  YOUTUBE_EDIT_BURST_LIMIT,
  YOUTUBE_EDIT_DAILY_LIMIT,
  YOUTUBE_PLAYLIST_CREATE_DAILY_LIMIT,
  YOUTUBE_PLAYLIST_CREATE_UNIT_COST,
  YOUTUBE_THUMBNAIL_SET_UNIT_COST,
} from "./writeLimits.ts";

const USER_ID = "0ee00001-0000-4000-8000-000000000001";

Deno.test("parseStrictRateLimitDecision accepts valid snake_case and camelCase payloads and rejects malformed ones", () => {
  assertEquals(parseStrictRateLimitDecision({ allowed: true, count: 1, retry_after: 0 }, 10), {
    allowed: true,
    count: 1,
    retryAfterSeconds: 0,
  });
  assertEquals(parseStrictRateLimitDecision({ allowed: false, count: 10, retryAfter: 120 }, 10), {
    allowed: false,
    count: 10,
    retryAfterSeconds: 120,
  });

  const malformed: unknown[] = [
    null,
    undefined,
    [],
    "ok",
    { allowed: "true", count: 1, retry_after: 0 },
    { allowed: true, count: 0, retry_after: 0 },
    { allowed: true, count: 11, retry_after: 0 },
    { allowed: true, count: 1.5, retry_after: 0 },
    { allowed: false, count: -1, retry_after: 0 },
    { allowed: true, count: 1, retry_after: -1 },
    { allowed: true, count: 1 },
  ];
  for (const item of malformed) {
    assertEquals(parseStrictRateLimitDecision(item, 10), null);
  }
});

Deno.test("checkUserWriteCounters checks burst then daily and passes on valid counts", async () => {
  const calls: Array<{ fn: string; params: Record<string, unknown> }> = [];
  const result = await checkUserWriteCounters({
    userId: USER_ID,
    rpc: (fn, params) => {
      calls.push({ fn, params });
      return Promise.resolve({ data: { allowed: true, count: 1, retry_after: 0 }, error: null });
    },
  });

  assertEquals(result, { ok: true });
  assertEquals(calls, [
    {
      fn: "check_rate_limit",
      params: {
        p_endpoint: YOUTUBE_EDIT_BURST_LIMIT.keyPrefix,
        p_identifier: `user:${USER_ID}`,
        p_max_requests: YOUTUBE_EDIT_BURST_LIMIT.limit,
        p_window_seconds: YOUTUBE_EDIT_BURST_LIMIT.windowSeconds,
      },
    },
    {
      fn: "check_rate_limit",
      params: {
        p_endpoint: YOUTUBE_EDIT_DAILY_LIMIT.keyPrefix,
        p_identifier: `user:${USER_ID}`,
        p_max_requests: YOUTUBE_EDIT_DAILY_LIMIT.limit,
        p_window_seconds: YOUTUBE_EDIT_DAILY_LIMIT.windowSeconds,
      },
    },
  ]);
});

Deno.test("checkUserWriteCounters refuses on burst without calling daily", async () => {
  const calls: string[] = [];
  const result = await checkUserWriteCounters({
    userId: USER_ID,
    rpc: (_fn, params) => {
      calls.push(`${String(params.p_endpoint)}:${String(params.p_identifier)}`);
      return Promise.resolve({ data: { allowed: false, count: 10, retry_after: 42 }, error: null });
    },
  });

  assertEquals(result, { ok: false, code: "rate_limited", retryAfterSeconds: 42 });
  assertEquals(calls, [`${YOUTUBE_EDIT_BURST_LIMIT.keyPrefix}:user:${USER_ID}`]);
});

Deno.test("checkUserWriteCounters refuses on daily counter", async () => {
  let step = 0;
  const result = await checkUserWriteCounters({
    userId: USER_ID,
    rpc: () => {
      step += 1;
      if (step === 1) {
        return Promise.resolve({ data: { allowed: true, count: 2, retry_after: 0 }, error: null });
      }
      return Promise.resolve({ data: { allowed: false, count: 50, retry_after: 0 }, error: null });
    },
  });

  assertEquals(result, { ok: false, code: "rate_limited", retryAfterSeconds: 1 });
});

Deno.test("checkUserWriteCounters fails closed as upstream_unavailable on RPC error, throw, or malformed payload", async () => {
  const badRpcs = [
    () => Promise.resolve({ data: null, error: { message: "down" } }),
    () => Promise.reject(new Error("timeout")),
    () => Promise.resolve({ data: null, error: null }),
    () => Promise.resolve({ data: { allowed: true, count: 99, retry_after: 0 }, error: null }),
  ];

  for (const rpc of badRpcs) {
    const result = await checkUserWriteCounters({ userId: USER_ID, rpc });
    assertEquals(result, { ok: false, code: "upstream_unavailable" });
  }
});

Deno.test("debitWriteBudget wraps weighted budget debit and maps allowed/refused/error", async () => {
  const ok = await debitWriteBudget({
    units: YOUTUBE_THUMBNAIL_SET_UNIT_COST,
    now: new Date("2026-11-27T12:00:00Z"),
    rpc: () => Promise.resolve({ data: { allowed: true, count: 50, retry_after: 0 }, error: null }),
  });
  assertEquals(ok, { ok: true, count: 50 });

  const refused = await debitWriteBudget({
    units: YOUTUBE_THUMBNAIL_SET_UNIT_COST,
    now: new Date("2026-11-27T12:00:00Z"),
    rpc: () => Promise.resolve({ data: { allowed: false, count: 3980, retry_after: 300 }, error: null }),
  });
  assertEquals(refused, { ok: false, code: "quota_exceeded", retryAfterSeconds: 300 });

  const broken = await debitWriteBudget({
    units: YOUTUBE_THUMBNAIL_SET_UNIT_COST,
    now: new Date("2026-11-27T12:00:00Z"),
    rpc: () => Promise.resolve({ data: null, error: { message: "db error" } }),
  });
  assertEquals(broken, { ok: false, code: "upstream_unavailable" });
});

Deno.test("checkCaptionListCounter and checkCaptionUploadCounter use the 4-param RPC contract and fail closed", async () => {
  const calls: Array<{ fn: string; params: Record<string, unknown> }> = [];
  const rpc = (fn: string, params: Record<string, unknown>) => {
    calls.push({ fn, params });
    return Promise.resolve({ data: { allowed: true, count: 1, retry_after: 0 }, error: null });
  };

  assertEquals(await checkCaptionListCounter({ userId: USER_ID, rpc }), { ok: true });
  assertEquals(await checkCaptionUploadCounter({ userId: USER_ID, rpc }), { ok: true });
  assertEquals(calls, [
    {
      fn: "check_rate_limit",
      params: {
        p_endpoint: YOUTUBE_CAPTION_LIST_DAILY_LIMIT.keyPrefix,
        p_identifier: `user:${USER_ID}`,
        p_max_requests: YOUTUBE_CAPTION_LIST_DAILY_LIMIT.limit,
        p_window_seconds: YOUTUBE_CAPTION_LIST_DAILY_LIMIT.windowSeconds,
      },
    },
    {
      fn: "check_rate_limit",
      params: {
        p_endpoint: YOUTUBE_CAPTION_UPLOAD_DAILY_LIMIT.keyPrefix,
        p_identifier: `user:${USER_ID}`,
        p_max_requests: YOUTUBE_CAPTION_UPLOAD_DAILY_LIMIT.limit,
        p_window_seconds: YOUTUBE_CAPTION_UPLOAD_DAILY_LIMIT.windowSeconds,
      },
    },
  ]);

  const refusedList = await checkCaptionListCounter({
    userId: USER_ID,
    rpc: () => Promise.resolve({ data: { allowed: false, count: 10, retry_after: 90 }, error: null }),
  });
  assertEquals(refusedList, { ok: false, code: "rate_limited", retryAfterSeconds: 90 });

  const brokenUpload = await checkCaptionUploadCounter({
    userId: USER_ID,
    rpc: () => Promise.resolve({ data: { allowed: true, count: 9, retry_after: 0 }, error: null }),
  });
  assertEquals(brokenUpload, { ok: false, code: "upstream_unavailable" });
});

Deno.test("checkPlaylistCreateCounter allows 1..5 per day, refuses 6th with rate_limited, and fails closed on RPC error or malformed response", async () => {
  assertEquals(YOUTUBE_PLAYLIST_CREATE_UNIT_COST, 50);
  assertEquals(YOUTUBE_PLAYLIST_CREATE_DAILY_LIMIT, {
    keyPrefix: "youtube-resources:playlist-create:day",
    limit: 5,
    windowSeconds: 86400,
  });

  const calls: Array<{ fn: string; params: Record<string, unknown> }> = [];
  for (let count = 1; count <= 5; count += 1) {
    const decision = await checkPlaylistCreateCounter({
      userId: USER_ID,
      rpc: (fn, params) => {
        calls.push({ fn, params });
        return Promise.resolve({ data: { allowed: true, count, retry_after: 0 }, error: null });
      },
    });
    assertEquals(decision, { ok: true });
  }
  assertEquals(calls[0], {
    fn: "check_rate_limit",
    params: {
      p_endpoint: "youtube-resources:playlist-create:day",
      p_identifier: `user:${USER_ID}`,
      p_max_requests: 5,
      p_window_seconds: 86400,
    },
  });

  const sixth = await checkPlaylistCreateCounter({
    userId: USER_ID,
    rpc: () => Promise.resolve({ data: { allowed: false, count: 5, retry_after: 3600 }, error: null }),
  });
  assertEquals(sixth, { ok: false, code: "rate_limited", retryAfterSeconds: 3600 });

  const failClosedCases = [
    () => Promise.resolve({ data: null, error: { message: "db outage" } }),
    () => Promise.reject(new Error("rpc timeout")),
    () => Promise.resolve({ data: null, error: null }),
    () => Promise.resolve({ data: { allowed: true, count: 6, retry_after: 0 }, error: null }),
    () => Promise.resolve({ data: { allowed: true, count: 0, retry_after: 0 }, error: null }),
  ];

  for (const rpc of failClosedCases) {
    const result = await checkPlaylistCreateCounter({ userId: USER_ID, rpc });
    assertEquals(result, { ok: false, code: "upstream_unavailable" });
  }
});
