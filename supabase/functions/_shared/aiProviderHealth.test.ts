// deno-lint-ignore-file no-import-prefix
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  classifyApiKeyFailure,
  classifyOAuthFailure,
  deriveRunId,
  planHealthTargets,
  sanitizeReason,
  sliceHealthChunk,
  summarizeHealthResults,
  type HealthResult,
} from "./aiProviderHealth.ts";

Deno.test("health reasons never echo unrelated credentials or customer diagnostics", () => {
  for (const status of [400, 402, 403, 408, 422, 429, 500, 503]) {
    const out = classifyApiKeyFailure(status, '{"message":"Bearer other-token customer-private api_key=encoded%2Bkey"}', "known-key");
    assert(!/other-token|customer-private|encoded|Bearer/.test(out.reason));
  }
});

Deno.test("the target list holds one row per credential kind and never a provider without one", () => {
  const targets = planHealthTargets(
    [{ provider_code: "claude", name: "Claude" }, { provider_code: "openai", name: "OpenAI" }],
    [{ oauth_provider: "anthropic", provider_code: "claude", name: "Claude" },
     { oauth_provider: "openai-codex", provider_code: "openai", name: "OpenAI" }],
  );
  assertEquals(targets.map((t) => `${t.provider_code}:${t.auth_method}`), [
    "claude:api_key", "openai:api_key", "claude:oauth", "openai:oauth",
  ]);
  assertEquals(targets[2].oauth_provider, "anthropic");
});

Deno.test("the chunk takes the first targets that are still missing, not an offset", () => {
  const targets = planHealthTargets(
    Array.from({ length: 7 }, (_, i) => ({ provider_code: `p${i}`, name: `P${i}` })), []);
  // The first chunk takes the first six of what is left.
  const first = sliceHealthChunk(targets, 1);
  assertEquals(first.slice.length, 6);
  assertEquals(first.done, false);
  assertEquals(first.nextChunk, 2);
  // The next call re-plans: the six that are done are not in the list any more,
  // so the chunk takes the one that is left.
  const remaining = targets.slice(6);
  const second = sliceHealthChunk(remaining, 2);
  assertEquals(second.slice.length, 1);
  assertEquals(second.done, true);
  assertEquals(second.nextChunk, null);
});

Deno.test("a chunk never walks past a target when the list changed under it", () => {
  // A provider was added before the second call.
  const afterAddition = planHealthTargets(
    [...Array.from({ length: 3 }, (_, i) => ({ provider_code: `p${i}`, name: `P${i}` })),
     { provider_code: "p3", name: "P3" }], []);
  const first = sliceHealthChunk(afterAddition, 1);
  assertEquals(first.slice.map((t) => t.provider_code), ["p0", "p1", "p2", "p3"]);
  assertEquals(first.done, true);
  // The three that are done are not in the list any more, so the next chunk starts
  // at the target that was added: nothing is skipped and nothing is done twice.
  const second = sliceHealthChunk(afterAddition.slice(3), 2);
  assertEquals(second.slice.map((t) => t.provider_code), ["p3"]);
  assertEquals(second.done, true);
});

Deno.test("an invalid api key is a failure with a fixed sentence and no key", () => {
  const out = classifyApiKeyFailure(401, '{"error":{"message":"Incorrect API key provided: sk-live-ABCDEF"}}', "sk-live-ABCDEF");
  assertEquals(out.status, "failed");
  assert(!out.reason.includes("sk-live-ABCDEF"));
});

Deno.test("a provider that echoes the key back has it redacted", () => {
  const out = classifyApiKeyFailure(500, '{"error":{"message":"upstream rejected sk-live-ABCDEF"}}', "sk-live-ABCDEF");
  assert(!out.reason.includes("sk-live-ABCDEF"));
  assertEquals(out.reason, "The provider request failed (HTTP 500).");
});

Deno.test("a rate limit is a failure, not a re-login", () => {
  assertEquals(classifyApiKeyFailure(429, '{"error":{"type":"rate_limit"}}').reason, "Rate limit exceeded");
});

Deno.test("a probe that timed out says so instead of quoting an HTTP status", () => {
  assertEquals(classifyApiKeyFailure(504, "").reason, "The provider did not answer in time.");
});

Deno.test("an expired oauth refresh needs a re-login", () => {
  const out = classifyOAuthFailure("reauth_required");
  assertEquals(out.status, "needs_relogin");
  assert(out.reason.length > 0);
  assert(!/token|secret|bearer/i.test(out.reason));
});

Deno.test("the sanitizer removes the key and the authorization header and truncates", () => {
  const out = sanitizeReason('bad key sk-live-ABCDEF with Authorization: Bearer sk-live-ABCDEF', "sk-live-ABCDEF");
  assert(!out.includes("sk-live-ABCDEF"));
  assert(out.length <= 500);
});

Deno.test("the summary counts every status", () => {
  const base: HealthResult = {
    provider_code: "claude", auth_method: "api_key", display_name: "Claude",
    status: "connected", reason: null, models_added: 1, models_updated: 0,
    models_deactivated: 0, latency_ms: 12, checked_at: "2026-11-13T00:00:00Z",
  };
  assertEquals(summarizeHealthResults([
    base,
    { ...base, status: "failed" },
    { ...base, status: "needs_relogin" },
  ]), { total: 3, connected: 1, failed: 1, needs_relogin: 1 });
});

Deno.test("the daily run id is stable for a day and the manual one follows its token", () => {
  const day = new Date("2026-11-13T03:05:00Z");
  assertEquals(
    deriveRunId("daily", "cron", day),
    deriveRunId("daily", "cron", new Date("2026-11-13T03:26:00Z")),
  );
  assert(deriveRunId("daily", "cron", day) !== deriveRunId("daily", "cron", new Date("2026-11-14T03:05:00Z")));
  assert(deriveRunId("manual", "token-a", day) !== deriveRunId("manual", "token-b", day));
});

Deno.test("the run id is a real uuid, because the column it lands in is a uuid", () => {
  // ai_provider_health.run_id and cron_run_leases.holder are both uuid columns, so a
  // shape that only looks like a uuid would fail at the database, not here.
  const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  assert(UUID_V4.test(deriveRunId("daily", "cron", new Date("2026-11-13T03:05:00Z"))));
  assert(UUID_V4.test(deriveRunId("manual", "token-a", new Date("2026-11-13T03:05:00Z"))));
  // Pinned: the SQL proof in supabase/tests/ai_provider_health.sql feeds this exact
  // string to a uuid column, so a change to the derivation must change it there too.
  assertEquals(deriveRunId("daily", "cron", new Date("2026-11-13T03:05:00Z")), "13ed6566-d364-4712-8464-88a5cd647da0");
  assertEquals(deriveRunId("manual", "token-a", new Date("2026-11-13T03:05:00Z")), "a28cdbaa-b588-45a6-8688-6739b78868cc");
});
