// deno-lint-ignore-file no-import-prefix no-explicit-any
import { assertEquals, assertRejects } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { memoizeRetryable, resolveVercelKey, toVideoSnapshot } from "./vercelGateway.ts";

Deno.test("pending maps to running with a poll delay", () => {
  const s = toVideoSnapshot({ status: "pending" });
  assertEquals([s.state, s.pollAfterSeconds, s.outputUrl], ["running", 10, null]);
});

Deno.test("completed with a hosted url maps to succeeded with that url", () => {
  const s = toVideoSnapshot({ status: "completed", videos: [{ type: "url", url: "https://cdn/x.mp4", mediaType: "video/mp4" }] });
  assertEquals([s.state, s.outputUrl, s.outputBase64], ["succeeded", "https://cdn/x.mp4", null]);
});

Deno.test("completed with inline bytes carries base64 for archiving", () => {
  const b64 = toVideoSnapshot({ status: "completed", videos: [{ type: "base64", data: "AAAA", mediaType: "video/mp4" }] });
  assertEquals([b64.state, b64.outputBase64, b64.outputMediaType], ["succeeded", "AAAA", "video/mp4"]);
  const bin = toVideoSnapshot({ status: "completed", videos: [{ type: "binary", data: new Uint8Array([0, 0, 0]) }] });
  assertEquals([bin.outputBase64, bin.outputMediaType], ["AAAA", "video/mp4"]);
});

Deno.test("error and empty completions map to failed", () => {
  assertEquals(toVideoSnapshot({ status: "error", error: "boom" }).error, "boom");
  assertEquals(toVideoSnapshot({ status: "completed", videos: [] }).state, "failed");
});

Deno.test("resolveVercelKey prefers env, then provider_api_keys", async () => {
  const db = { from: () => { const q: any = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: { api_key: "db-key" } }) }; return q; } };
  Deno.env.delete("AI_GATEWAY_API_KEY");
  assertEquals(await resolveVercelKey(db), "db-key");
  Deno.env.set("AI_GATEWAY_API_KEY", "env-key");
  assertEquals(await resolveVercelKey(db), "env-key");
  Deno.env.delete("AI_GATEWAY_API_KEY");
});

Deno.test("memoizeRetryable retries after a rejected load, then memoizes success", async () => {
  let calls = 0;
  const load = memoizeRetryable(() => {
    calls++;
    return calls === 1 ? Promise.reject(new Error("boom")) : Promise.resolve(`ok-${calls}`);
  });

  await assertRejects(() => load(), Error, "boom");
  assertEquals(calls, 1);

  // A retry after the failure calls fn() again instead of re-throwing the stale rejection.
  assertEquals(await load(), "ok-2");
  assertEquals(calls, 2);

  // Once it has succeeded, the result is memoized: fn() is not called a third time.
  assertEquals(await load(), "ok-2");
  assertEquals(calls, 2);
});
