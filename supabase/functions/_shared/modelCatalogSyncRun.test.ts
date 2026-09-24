// deno-lint-ignore-file no-import-prefix no-explicit-any
import { assertEquals, assertRejects } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { runCatalogSync } from "./modelCatalogSyncRun.ts";

function fakeDb(state: { models: any[]; settings: any[]; keys?: any[] }) {
  const writes: Array<{ table: string; op: string; payload: unknown }> = [];
  const from = (table: string) => {
    const q: any = { _filters: {} as Record<string, unknown> };
    q.select = () => q;
    q.eq = (c: string, v: unknown) => { q._filters[c] = v; return q; };
    q.like = () => q;
    q.in = (c: string, v: unknown) => { q._filters[c] = v; return q; };
    q.maybeSingle = async () => {
      if (table === "ai_providers") return { data: { id: "prov", provider_code: q._filters.provider_code, api_endpoint: "https://x", api_key_env_var: "NONE" }, error: null };
      if (table === "provider_api_keys") return { data: (state.keys ?? [])[0] ?? null, error: null };
      return { data: null, error: null };
    };
    q.then = (resolve: any) => resolve({ data: table === "ai_models" ? state.models : state.settings, error: null });
    q.insert = async (p: unknown) => { writes.push({ table, op: "insert", payload: p }); return { error: null }; };
    q.update = (p: unknown) => { writes.push({ table, op: "update", payload: p }); return q; };
    q.upsert = async (p: unknown) => { writes.push({ table, op: "upsert", payload: p }); return { error: null }; };
    return q;
  };
  return { db: { from }, writes };
}

const vercelFetch = (async () =>
  new Response(JSON.stringify({ data: [
    { id: "openai/gpt-5.5", name: "GPT-5.5", type: "language" },
    { id: "typesafe-ai/jev", name: "JEV", type: "evaluation" },
  ] }), { status: 200 })) as typeof fetch;

Deno.test("runCatalogSync reports added, skipped and in-use models", async () => {
  const { db, writes } = fakeDb({
    models: [{ id: "9", model_id: "openai/old-default", is_active: true, capabilities: ["chat"], metadata: null }],
    settings: [{ key: "default_ai_model_chat", value: { provider_code: "vercel", model_id: "openai/old-default" } }],
  });
  const report = await runCatalogSync(db, "vercel", vercelFetch);
  assertEquals([report.added, report.updated, report.deactivated], [1, 0, 0]);
  assertEquals(report.kept_in_use, ["openai/old-default"]);
  assertEquals(report.skipped_by_type, { evaluation: 1 });
  assertEquals(writes.some((w) => w.table === "system_settings" && w.op === "upsert"), true);
});

Deno.test("runCatalogSync refuses unknown providers and empty catalogues", async () => {
  const { db } = fakeDb({ models: [], settings: [] });
  await assertRejects(() => runCatalogSync(db, "claude", vercelFetch), Error, "not syncable");
  const empty = (async () => new Response(JSON.stringify({ data: [] }), { status: 200 })) as typeof fetch;
  await assertRejects(() => runCatalogSync(db, "vercel", empty), Error, "empty model catalogue");
});
