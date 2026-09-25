// deno-lint-ignore-file no-import-prefix
import { assertEquals, assertRejects } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { CatalogSyncError, type CatalogDb, runCatalogSync, syncFailureMessage } from "./modelCatalogSyncRun.ts";

type Write = { table: string; op: string; payload: unknown; options?: unknown };
type Result = { data: unknown; error: { message: string } | null };

function fakeDb(state: { models: unknown[]; settings: unknown[]; settingsUpsertError?: string; providerReadError?: string }) {
  const writes: Write[] = [];
  const db: CatalogDb = {
    from: (table: string) => {
      const filters: Record<string, unknown> = {};
      const list = (): Result => ({ data: table === "ai_models" ? state.models : state.settings, error: null });
      const single = (): Result => {
        if (table === "ai_providers") {
          if (state.providerReadError) return { data: null, error: { message: state.providerReadError } };
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
  assertEquals([report.added, report.updated, report.deactivated], [2, 0, 0]);
  assertEquals(report.kept_in_use, ["openai/old-default"]);
  assertEquals(report.skipped_by_type, {});
  assertEquals(writes.some((w) => w.table === "system_settings" && w.op === "upsert"), true);
});

Deno.test("runCatalogSync refuses unknown providers and empty catalogues", async () => {
  const { db } = fakeDb({ models: [], settings: [] });
  await assertRejects(() => runCatalogSync(db, "not-a-real-provider", vercelFetch), Error, "not syncable");
  await assertRejects(() => runCatalogSync(db, "vercel", catalogue([])), Error, "empty model catalogue");
});

Deno.test("an unchanged row is not written and is not counted as updated", async () => {
  const { db, writes } = fakeDb({ models: [syncedRow()], settings: [] });
  const fetch = catalogue([{ id: "openai/gpt-5.5", name: "GPT-5.5", type: "language" }]);
  const report = await runCatalogSync(db, "vercel", fetch);
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
  const fetch = catalogue([{ id: "openai/gpt-5.5", name: "GPT-5.5", type: "language" }]);
  const report = await runCatalogSync(db, "vercel", fetch);
  assertEquals(report.updated, 1);
  const [row] = upsertedRows(writes);
  assertEquals([row.is_active, row.metadata], [true, { sync_deactivated: false }]);
});

Deno.test("capabilities an admin added outside the managed set survive a sync", async () => {
  const { db, writes } = fakeDb({ models: [syncedRow({ capabilities: ["chat", "search", "agent"], name: "Old" })], settings: [] });
  const fetch = catalogue([{ id: "openai/gpt-5.5", name: "GPT-5.5", type: "language" }]);
  await runCatalogSync(db, "vercel", fetch);
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

Deno.test("a failed ai_providers read is reported as a read failure, not a missing provider", async () => {
  const { db, writes } = fakeDb({ models: [], settings: [], providerReadError: "statement timeout" });
  const err = await assertRejects(() => runCatalogSync(db, "vercel", vercelFetch), Error);
  assertEquals(err.message, "ai_providers read failed");
  assertEquals(writes.length, 0);
});

Deno.test("the intentional upstream refusals are CatalogSyncErrors", async () => {
  const { db } = fakeDb({ models: [], settings: [] });
  const failing = (async () => new Response("", { status: 503 })) as typeof fetch;
  await assertRejects(() => runCatalogSync(db, "not-a-real-provider", vercelFetch), CatalogSyncError, "not syncable");
  await assertRejects(() => runCatalogSync(db, "vercel", catalogue([])), CatalogSyncError, "empty model catalogue");
  await assertRejects(() => runCatalogSync(db, "vercel", failing), CatalogSyncError, "vercel /models returned HTTP 503");
});

Deno.test("syncFailureMessage shows CatalogSyncErrors and hides every other failure", async (t) => {
  const cases: Array<[string, unknown, string]> = [
    ["an upstream HTTP failure", new CatalogSyncError("vercel /models returned HTTP 503"), "vercel /models returned HTTP 503"],
    ["a missing key", new CatalogSyncError("API key DEEPSEEK_API_KEY not configured"), "API key DEEPSEEK_API_KEY not configured"],
    ["a database write error", new Error("ai_models upsert failed: duplicate key value violates unique constraint"), "Model sync failed; see server logs"],
    ["a non-Error throw", "boom", "Model sync failed; see server logs"],
  ];
  for (const [name, err, expected] of cases) {
    await t.step(name, () => assertEquals(syncFailureMessage(err), expected));
  }
});

Deno.test("a failed settings write is not a user-facing CatalogSyncError", async () => {
  const { db } = fakeDb({ models: [], settings: [], settingsUpsertError: "permission denied for table system_settings" });
  const err = await assertRejects(() => runCatalogSync(db, "vercel", vercelFetch), Error);
  assertEquals(err instanceof CatalogSyncError, false);
});

// --- Task 3: per-provider request specs, new syncable providers, dry run ---

/** fakeDb's ai_providers row always names this env var; resolveProviderKey reads it via Deno.env. */
const KEY_ENV = "NONE";

function withEnv<T>(name: string, value: string | undefined, run: () => Promise<T>): Promise<T> {
  const prior = Deno.env.get(name);
  if (value === undefined) Deno.env.delete(name);
  else Deno.env.set(name, value);
  return run().finally(() => {
    if (prior === undefined) Deno.env.delete(name);
    else Deno.env.set(name, prior);
  });
}

function recordingFetch(body: unknown, status = 200) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const fetchImpl = ((url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), headers: { ...(init?.headers as Record<string, string> ?? {}) } });
    return Promise.resolve(new Response(JSON.stringify(body), { status }));
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const claudeBody = { data: [{ id: "claude-sonnet-5", display_name: "Claude Sonnet 5", max_input_tokens: 200000 }] };
const geminiBody = { models: [{ name: "models/gemini-3-pro", displayName: "Gemini 3 Pro", supportedGenerationMethods: ["generateContent"] }] };

Deno.test("claude requests /v1/models with x-api-key and anthropic-version, no Authorization", () =>
  withEnv(KEY_ENV, "test-anthropic-key", async () => {
    const { db } = fakeDb({ models: [], settings: [] });
    const { fetchImpl, calls } = recordingFetch(claudeBody);
    const report = await runCatalogSync(db, "claude", fetchImpl);
    assertEquals(calls.length, 1);
    assertEquals(calls[0].url, "https://api.anthropic.com/v1/models?limit=1000");
    assertEquals(calls[0].headers["x-api-key"], "test-anthropic-key");
    assertEquals(calls[0].headers["anthropic-version"], "2023-06-01");
    assertEquals("Authorization" in calls[0].headers, false);
    assertEquals(report.added, 1);
    assertEquals(report.dry_run, false);
  }));

Deno.test("gemini puts the key in the URL query string, sends no auth header, and reads body.models", () =>
  withEnv(KEY_ENV, "test-gemini-key", async () => {
    const { db } = fakeDb({ models: [], settings: [] });
    const { fetchImpl, calls } = recordingFetch(geminiBody);
    const report = await runCatalogSync(db, "gemini", fetchImpl);
    assertEquals(calls.length, 1);
    assertEquals(calls[0].url, "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000&key=test-gemini-key");
    assertEquals(calls[0].headers, {});
    assertEquals(report.added, 1);
  }));

const bearerProviders: Array<[string, string, unknown]> = [
  ["openai", "https://api.openai.com/v1/models", { data: [{ id: "gpt-5.5" }] }],
  ["zai", "https://api.z.ai/api/paas/v4/models", { data: [{ id: "glm-5.3" }] }],
  ["minimax", "https://api.minimax.io/v1/models", { data: [{ id: "minimax-m3" }] }],
  ["xai", "https://api.x.ai/v1/models", { data: [{ id: "grok-5" }] }],
];

for (const [providerCode, url, body] of bearerProviders) {
  Deno.test(`${providerCode} requests ${url} with a Bearer key`, () =>
    withEnv(KEY_ENV, "test-bearer-key", async () => {
      const { db } = fakeDb({ models: [], settings: [] });
      const { fetchImpl, calls } = recordingFetch(body);
      const report = await runCatalogSync(db, providerCode, fetchImpl);
      assertEquals(calls.length, 1);
      assertEquals(calls[0].url, url);
      assertEquals(calls[0].headers.Authorization, "Bearer test-bearer-key");
      assertEquals(report.added, 1);
    }));
}

Deno.test("a dry run reports the plan but writes nothing", () =>
  withEnv(KEY_ENV, "test-anthropic-key", async () => {
    const { db, writes } = fakeDb({ models: [], settings: [] });
    const { fetchImpl } = recordingFetch(claudeBody);
    const report = await runCatalogSync(db, "claude", fetchImpl, { dryRun: true });
    assertEquals(report.added, 1);
    assertEquals(report.dry_run, true);
    assertEquals(writes.some((w) => w.table === "ai_models"), false);
    assertEquals(writes.some((w) => w.table === "system_settings" && (w.payload as { key?: string }).key?.startsWith("model_catalog_synced_at_")), false);
  }));

Deno.test("a Gemini HTTP failure never puts the key in the error message", () =>
  withEnv(KEY_ENV, "super-secret-gemini-key", async () => {
    const { db } = fakeDb({ models: [], settings: [] });
    const { fetchImpl } = recordingFetch({}, 400);
    const err = await assertRejects(() => runCatalogSync(db, "gemini", fetchImpl), CatalogSyncError);
    assertEquals(err.message, "gemini /models returned HTTP 400");
    assertEquals(err.message.includes("super-secret-gemini-key"), false);
  }));
