// deno-lint-ignore-file no-import-prefix
import { assertEquals, assertRejects } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { type CatalogDb, runCatalogSync } from "./modelCatalogSyncRun.ts";

type Write = { table: string; op: string; payload: unknown; options?: unknown };
type Result = { data: unknown; error: { message: string } | null };

function fakeDb(state: { models: unknown[]; settings: unknown[]; settingsUpsertError?: string }) {
  const writes: Write[] = [];
  const db: CatalogDb = {
    from: (table: string) => {
      const filters: Record<string, unknown> = {};
      const list = (): Result => ({ data: table === "ai_models" ? state.models : state.settings, error: null });
      const single = (): Result => {
        if (table === "ai_providers") {
          return { data: { id: "prov", provider_code: filters.provider_code, api_key_env_var: "NONE" }, error: null };
        }
        return { data: null, error: null };
      };
      const query = Object.assign(Promise.resolve(list()), {
        eq: (column: string, value: string) => { filters[column] = value; return query; },
        like: () => query,
        maybeSingle: () => Promise.resolve(single()),
      });
      return {
        select: () => query,
        upsert: (payload: unknown, options: { onConflict: string }) => {
          writes.push({ table, op: "upsert", payload, options });
          const failed = table === "system_settings" && state.settingsUpsertError;
          return Promise.resolve({ error: failed ? { message: state.settingsUpsertError! } : null });
        },
      };
    },
  };
  return { db, writes };
}

const catalogue = (data: unknown[]) =>
  (async () => new Response(JSON.stringify({ data }), { status: 200 })) as typeof fetch;

const vercelFetch = catalogue([
  { id: "openai/gpt-5.5", name: "GPT-5.5", type: "language" },
  { id: "typesafe-ai/jev", name: "JEV", type: "evaluation" },
]);

/** An ai_models row exactly as the sync would have written openai/gpt-5.5. */
const syncedRow = (overrides: Record<string, unknown> = {}) => ({
  id: "1", model_id: "openai/gpt-5.5", name: "GPT-5.5", description: null, is_active: true,
  capabilities: ["chat"], context_limit: null, cost_per_1m_input_tokens: null, cost_per_1m_output_tokens: null,
  metadata: {}, ...overrides,
});

const modelUpserts = (writes: Write[]) => writes.filter((w) => w.table === "ai_models");
const upsertedRows = (writes: Write[]) => modelUpserts(writes).flatMap((w) => w.payload as Record<string, unknown>[]);

Deno.test("runCatalogSync reports added, skipped and in-use models", async () => {
  const { db, writes } = fakeDb({
    models: [{ ...syncedRow({ id: "9", model_id: "openai/old-default" }) }],
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
  await assertRejects(() => runCatalogSync(db, "vercel", catalogue([])), Error, "empty model catalogue");
});

Deno.test("an unchanged row is not written and is not counted as updated", async () => {
  const { db, writes } = fakeDb({ models: [syncedRow()], settings: [] });
  const report = await runCatalogSync(db, "vercel", vercelFetch);
  assertEquals(report.updated, 0);
  assertEquals(modelUpserts(writes).length, 0);
});

Deno.test("costs the NUMERIC(10,4) column rounded are not a change", async () => {
  const priced = catalogue([{ id: "openai/gpt-5.5", name: "GPT-5.5", type: "language", pricing: { input: "0.00000123456" } }]);
  const { db, writes } = fakeDb({ models: [syncedRow({ cost_per_1m_input_tokens: 1.2346 })], settings: [] });
  assertEquals((await runCatalogSync(db, "vercel", priced)).updated, 0);
  assertEquals(modelUpserts(writes).length, 0);
});

Deno.test("inserts, changed rows and deactivations go out in one upsert on provider_id,model_id", async () => {
  const { db, writes } = fakeDb({
    models: [
      syncedRow({ name: "Old name" }),
      syncedRow({ id: "2", model_id: "openai/gone", name: "Gone", metadata: { tags: ["x"] } }),
    ],
    settings: [],
  });
  const report = await runCatalogSync(db, "vercel", catalogue([
    { id: "openai/gpt-5.5", name: "GPT-5.5", type: "language" },
    { id: "openai/new", name: "New", type: "language" },
  ]));
  assertEquals([report.added, report.updated, report.deactivated], [1, 1, 1]);
  const upserts = modelUpserts(writes);
  assertEquals(upserts.length, 1);
  assertEquals(upserts[0].options, { onConflict: "provider_id,model_id" });
  const rows = upsertedRows(writes);
  assertEquals(rows.map((r) => [r.model_id, r.is_active]), [["openai/new", true], ["openai/gpt-5.5", true], ["openai/gone", false]]);
  assertEquals(rows[1].name, "GPT-5.5");
  assertEquals(rows[2].metadata, { tags: ["x"], sync_deactivated: true });
  // PostgREST bulk upserts need one column set; admin_params is never part of it.
  for (const row of rows) assertEquals(Object.keys(row).sort(), Object.keys(rows[0]).sort());
  assertEquals(rows.some((r) => "admin_params" in r), false);
});

Deno.test("a row a previous sync switched off is reactivated when the catalogue lists it again", async () => {
  const { db, writes } = fakeDb({ models: [syncedRow({ is_active: false, metadata: { sync_deactivated: true } })], settings: [] });
  const report = await runCatalogSync(db, "vercel", vercelFetch);
  assertEquals(report.updated, 1);
  const [row] = upsertedRows(writes);
  assertEquals([row.is_active, row.metadata], [true, { sync_deactivated: false }]);
});

Deno.test("capabilities an admin added outside the managed set survive a sync", async () => {
  const { db, writes } = fakeDb({ models: [syncedRow({ capabilities: ["chat", "search", "agent"], name: "Old" })], settings: [] });
  await runCatalogSync(db, "vercel", vercelFetch);
  const [row] = upsertedRows(writes);
  assertEquals(row.capabilities, ["agent", "chat", "search"]);
});

Deno.test("malformed default-model settings are skipped and a failed timestamp write throws", async () => {
  const settings = [
    { key: "default_ai_model_bad", value: "{not json" },
    { key: "default_ai_model_chat", value: JSON.stringify({ provider_code: "vercel", model_id: "openai/old" }) },
  ];
  const ok = fakeDb({ models: [syncedRow({ id: "9", model_id: "openai/old" })], settings });
  assertEquals((await runCatalogSync(ok.db, "vercel", vercelFetch)).kept_in_use, ["openai/old"]);
  const failing = fakeDb({ models: [], settings: [], settingsUpsertError: "denied" });
  await assertRejects(() => runCatalogSync(failing.db, "vercel", vercelFetch), Error, "system_settings write failed");
});
