import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { toRateLimitDecision } from "./rateLimit.ts";

Deno.test("an allowed result lets the request through", () => {
  assertEquals(toRateLimitDecision({ allowed: true, count: 3, remaining: 27, retry_after: 0 }, 600), {
    allowed: true,
    retryAfterSeconds: 0,
  });
});

Deno.test("a refusal reads the wait from the database's snake_case key", () => {
  assertEquals(toRateLimitDecision({ allowed: false, count: 30, remaining: 0, retry_after: 240 }, 600), {
    allowed: false,
    retryAfterSeconds: 240,
  });
});

Deno.test("a refusal also accepts the camelCase key of the TypeScript type", () => {
  assertEquals(toRateLimitDecision({ allowed: false, retryAfter: 90 }, 600), {
    allowed: false,
    retryAfterSeconds: 90,
  });
});

Deno.test("a refusal without a usable wait falls back to the whole window", () => {
  assertEquals(toRateLimitDecision({ allowed: false }, 600), { allowed: false, retryAfterSeconds: 600 });
});

Deno.test("an unreadable result keeps the helper's fail-open behaviour", () => {
  assertEquals(toRateLimitDecision(null, 600), { allowed: true, retryAfterSeconds: 0 });
});
