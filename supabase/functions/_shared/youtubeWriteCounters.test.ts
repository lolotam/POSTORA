import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  checkCaptionUploadCounter,
  parseStrictRateLimitDecision,
  YOUTUBE_CAPTION_UPLOAD_DAILY_LIMIT,
  YOUTUBE_CAPTION_UPLOAD_UNIT_COST,
} from "./youtubeWriteCounters.ts";

const USER_ID = "0ee00001-0000-4000-8000-000000000001";

Deno.test("parseStrictRateLimitDecision validates strict rate-limit payloads and fails closed on malformed values", () => {
  assertEquals(YOUTUBE_CAPTION_UPLOAD_UNIT_COST, 400);
  assertEquals(YOUTUBE_CAPTION_UPLOAD_DAILY_LIMIT, {
    keyPrefix: "youtube-resources:caption-upload:day",
    limit: 2,
    windowSeconds: 86400,
  });

  assertEquals(parseStrictRateLimitDecision({ allowed: true, count: 1, retry_after: 0 }, 2), {
    allowed: true,
    count: 1,
    retryAfterSeconds: 0,
  });
  assertEquals(parseStrictRateLimitDecision({ allowed: true, count: 2, retryAfter: 0 }, 2), {
    allowed: true,
    count: 2,
    retryAfterSeconds: 0,
  });
  assertEquals(parseStrictRateLimitDecision({ allowed: false, count: 2, retry_after: 3600 }, 2), {
    allowed: false,
    count: 2,
    retryAfterSeconds: 3600,
  });

  const invalidPayloads: unknown[] = [
    null,
    undefined,
    "allowed",
    [],
    { allowed: "true", count: 1, retry_after: 0 },
    { allowed: true, count: 0, retry_after: 0 },
    { allowed: true, count: 3, retry_after: 0 },
    { allowed: true, count: 1.2, retry_after: 0 },
    { allowed: false, count: -1, retry_after: 0 },
    { allowed: true, count: 1, retry_after: -5 },
    { allowed: true, count: 1 },
  ];

  for (const payload of invalidPayloads) {
    assertEquals(parseStrictRateLimitDecision(payload, 2), null);
  }
});

Deno.test("checkCaptionUploadCounter allows counts 1..2 and refuses the 3rd attempt with rate_limited", async () => {
  const calls: Array<{ fn: string; params: Record<string, unknown> }> = [];
  let attempt = 0;

  const rpc = (fn: string, params: Record<string, unknown>) => {
    calls.push({ fn, params });
    attempt += 1;
    if (attempt <= 2) {
      return Promise.resolve({
        data: { allowed: true, count: attempt, retry_after: 0 },
        error: null,
      });
    }
    return Promise.resolve({
      data: { allowed: false, count: 2, retry_after: 1800 },
      error: null,
    });
  };

  assertEquals(await checkCaptionUploadCounter({ userId: USER_ID, rpc }), { ok: true });
  assertEquals(await checkCaptionUploadCounter({ userId: USER_ID, rpc }), { ok: true });
  assertEquals(await checkCaptionUploadCounter({ userId: USER_ID, rpc }), {
    ok: false,
    code: "rate_limited",
    retryAfterSeconds: 1800,
  });

  assertEquals(calls.length, 3);
  assertEquals(calls[0], {
    fn: "check_rate_limit",
    params: {
      p_endpoint: "youtube-resources:caption-upload:day",
      p_identifier: `user:${USER_ID}`,
      p_max_requests: 2,
      p_window_seconds: 86400,
    },
  });
});

Deno.test("checkCaptionUploadCounter clamps zero retry_after on refusal and fails closed on RPC error or malformed response", async () => {
  const zeroRetryRefusal = await checkCaptionUploadCounter({
    userId: USER_ID,
    rpc: () => Promise.resolve({ data: { allowed: false, count: 2, retry_after: 0 }, error: null }),
  });
  assertEquals(zeroRetryRefusal, {
    ok: false,
    code: "rate_limited",
    retryAfterSeconds: 1,
  });

  const failingRpcs = [
    () => Promise.resolve({ data: null, error: { message: "db unavailable" } }),
    () => Promise.reject(new Error("network failure")),
    () => Promise.resolve({ data: null, error: null }),
    () => Promise.resolve({ data: { allowed: true, count: 3, retry_after: 0 }, error: null }),
  ];

  for (const rpc of failingRpcs) {
    assertEquals(await checkCaptionUploadCounter({ userId: USER_ID, rpc }), {
      ok: false,
      code: "upstream_unavailable",
    });
  }
});
