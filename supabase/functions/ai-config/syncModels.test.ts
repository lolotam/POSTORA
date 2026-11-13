import { assert, assertEquals, assertRejects } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { type CatalogDb, CatalogSyncError } from "../_shared/modelCatalogSyncRun.ts";
import { syncModels } from "./syncModels.ts";

function fixture(busy = false, fail = false, releaseRejects = false) {
  const calls: Array<{ name: string; body: Record<string, unknown> }> = [];
  const transport = (async (input, init) => {
    const url = new URL(String(input));
    const name = url.pathname.split("/").pop()!;
    let data: unknown = [];
    let status = 200;
    if (url.pathname.includes("/rpc/")) {
      calls.push({ name, body: JSON.parse(String(init?.body)) });
      if (releaseRejects && name === "release_cron_run_lease") throw new Error("offline");
      data = name === "acquire_cron_run_lease" ? !busy : true;
    } else if (name === "ai_providers") {
      data = fail ? { message: "storage unavailable" } : { id: "provider", api_key_env_var: "NONE" };
      if (fail) status = 503;
    }
    return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { calls, db: createClient("https://database.example.test", "fixture-key", { global: { fetch: transport } }) as unknown as CatalogDb };
}

Deno.test("manual sync-models cannot enter while health owns the lease", async () => {
  const { db, calls } = fixture(true);
  await assertRejects(() => syncModels(db, "openrouter", false), CatalogSyncError, "already running");
  assertEquals(calls.map((c) => c.name), ["acquire_cron_run_lease"]);
});

Deno.test("manual sync-models fences catalogue and timestamp with its acquired holder", async () => {
  const { db, calls } = fixture();
  const upstream = (async () => new Response(JSON.stringify({ data: [{ id: "openai/gpt-4o", name: "GPT", context_length: 128000, architecture: { output_modalities: ["text"] } }] }))) as typeof fetch;
  await syncModels(db, "openrouter", false, upstream);
  assertEquals(calls.map((c) => c.name), ["acquire_cron_run_lease", "write_ai_health_catalog", "release_cron_run_lease"]);
  const holder = calls[0].body.p_holder;
  assert(typeof holder === "string");
  assertEquals(calls[0].body.p_job, "ai-provider-health");
  assertEquals(calls[1].body.p_holder, holder);
  assertEquals(calls[2].body.p_holder, holder);
  assertEquals(calls[1].body.p_stamp_key, "model_catalog_synced_at_openrouter_api_key");
});

Deno.test("failed manual catalogue read releases the health lease", async () => {
  const { db, calls } = fixture(false, true);
  await assertRejects(() => syncModels(db, "openrouter", false), Error, "read failed");
  assertEquals(calls.map((c) => c.name), ["acquire_cron_run_lease", "release_cron_run_lease"]);
});

Deno.test('round5 release transport rejection preserves committed sync result', async () => {
  const { db } = fixture(false, false, true);
  const upstream = (async () => new Response(JSON.stringify({ data: [{ id: 'openai/gpt-4o', name: 'GPT', architecture: { output_modalities: ['text'] } }] }))) as typeof fetch;
  const result = await syncModels(db, 'openrouter', false, upstream);
  assertEquals(result.added, 1);
});
