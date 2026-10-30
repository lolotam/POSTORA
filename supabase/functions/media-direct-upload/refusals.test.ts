import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import type { LogEntry } from "../_shared/logging.ts";
import { readUploadLimits, refuse } from "./refusals.ts";

function settingsDb(answer: { data: unknown; error: unknown }): SupabaseClient {
  const query = { select: () => query, eq: () => query, maybeSingle: () => Promise.resolve(answer) };
  return { from: () => query } as unknown as SupabaseClient;
}

Deno.test("the admin's limits are read as set", async () => {
  const limits = await readUploadLimits(settingsDb({ data: { value: { image_max_mb: 10, video_max_mb: 100 } }, error: null }));
  assertEquals(limits, { image_max_mb: 10, video_max_mb: 100 });
});

Deno.test("an absent row means the defaults", async () => {
  assertEquals(await readUploadLimits(settingsDb({ data: null, error: null })), { image_max_mb: 20, video_max_mb: 500 });
});

Deno.test("a failed read is not the defaults", async () => {
  assertEquals(await readUploadLimits(settingsDb({ data: null, error: { message: "timeout" } })), null);
});

Deno.test("a refusal writes a log row and answers with its status, body and headers", async () => {
  const logged: LogEntry[] = [];
  const db = {} as SupabaseClient;
  const response = await refuse(
    new Request("https://x.test", { method: "POST" }),
    db,
    "user-1",
    { status: 429, reason: "rate_limited", body: { success: false }, headers: { "Retry-After": "120" }, metadata: { size: 5 } },
    (_db, entry) => { logged.push(entry); return Promise.resolve(); },
  );

  assertEquals(response.status, 429);
  assertEquals(response.headers.get("Retry-After"), "120");
  assertEquals(await response.json(), { success: false });
  assertEquals(logged.length, 1);
  assertEquals(logged[0].level, "warn");
  assertEquals(logged[0].source, "media-direct-upload");
  assertEquals(logged[0].user_id, "user-1");
  assertEquals(logged[0].metadata, { reason: "rate_limited", status: 429, size: 5 });
});

Deno.test("a server-side refusal is logged as an error", async () => {
  const logged: LogEntry[] = [];
  await refuse(new Request("https://x.test"), {} as SupabaseClient, null, { status: 503, reason: "limits_unavailable", body: {} }, (_db, entry) => {
    logged.push(entry);
    return Promise.resolve();
  });
  assertEquals(logged[0].level, "error");
  assertEquals(logged[0].user_id, undefined);
});

Deno.test("a refusal with no admin client (an unauthenticated caller) writes nothing", async () => {
  let writes = 0;
  const response = await refuse(
    new Request("https://x.test", { method: "POST" }),
    null,
    null,
    { status: 401, reason: "unauthenticated", body: { success: false, error: "Authentication failed." } },
    () => {
      writes++;
      return Promise.resolve();
    },
  );
  assertEquals(response.status, 401);
  assertEquals(await response.json(), { success: false, error: "Authentication failed." });
  assertEquals(writes, 0);
});
