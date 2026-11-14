import { assert, assertEquals, assertRejects } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { syncHiggsfieldCatalog } from "./syncCatalog.ts";

function fixture(failure?: "read" | "write") {
  const model = (id: string, model_id: string, extra: Record<string, unknown> = {}) => ({
    id, provider_id: "provider", model_id, name: model_id, description: null,
    capabilities: ["video"], metadata: {}, context_limit: null,
    cost_per_1m_input_tokens: null, cost_per_1m_output_tokens: null,
    auth_method: "api_key", is_active: true, ...extra,
  });
  const rows: Array<Record<string, unknown>> = [
    model("api-current", "current", { name: "Curated name", capabilities: ["video", "agent"],
      metadata: { admin_note: "keep" }, context_limit: 123, cost_per_1m_input_tokens: 4 }),
    model("api-old", "old"),
    model("api-custom", "custom", { capabilities: ["tts"] }),
    model("api-default", "default"),
    model("api-disabled", "disabled", { is_active: false }),
    model("oauth-old", "old", { auth_method: "oauth" }),
  ];
  const requests: string[] = [];
  let holder: string | null = null;
  const transport = (async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const op = url.pathname.split("/").pop() ?? "";
    requests.push(`${method} ${op}`);
    const reply = (data: unknown, status = 200) => new Response(JSON.stringify(data), {
      status, headers: { "content-type": "application/json" },
    });
    if (op === "acquire_cron_run_lease") {
      if (holder) return reply(false);
      holder = JSON.parse(String(init?.body)).p_holder;
      return reply(true);
    }
    if (op === "release_cron_run_lease") { holder = null; return reply(true); }
    if (op === "write_ai_health_catalog") {
      const args = JSON.parse(String(init?.body));
      assertEquals(args.p_holder, holder);
      if (failure === "write") return reply({ message: "database failed" }, 400);
      // Atomic boundary: all rows are submitted together and no table write is permitted.
      for (const row of args.p_rows as Array<Record<string, unknown>>) {
        assertEquals(row.auth_method, "api_key");
        const existing = rows.find((r) => r.model_id === row.model_id && r.auth_method === row.auth_method);
        if (existing) Object.assign(existing, row);
        else rows.push({ ...row, id: "api-new" });
      }
      return reply(null);
    }
    assertEquals(method, "GET", "catalogue rows must be written only in the fenced transaction");
    if (op === "ai_providers") return reply({ id: "provider" });
    if (op === "system_settings") return reply([{ value: { provider_code: "higgsfield", model_id: "default" } }]);
    if (failure === "read") return reply({ message: "database failed" }, 400);
    return reply(rows.filter((row) => url.searchParams.get("auth_method") === `eq.${row.auth_method}`));
  }) as typeof fetch;
  return { rows, requests, db: createClient("https://database.example.test", ["test", "key", "not", "secret"].join("-"), { global: { fetch: transport } }) };
}

const explore = async () => [{ id: "current", parameters: { duration: 5 } }, { id: "fresh" }, { id: "disabled" }];

Deno.test("Higgsfield sync atomically merges the api_key catalogue and preserves admin and OAuth state", async () => {
  const { db, rows, requests } = fixture();
  const report = await syncHiggsfieldCatalog(db, explore);
  assertEquals(report.deactivated, 1);
  const current = rows.find((r) => r.id === "api-current")!;
  assertEquals(current.name, "Curated name");
  assertEquals(current.capabilities, ["agent", "image", "video"]);
  assertEquals(current.metadata, { admin_note: "keep", parameters: { duration: 5 } });
  assertEquals(current.context_limit, 123);
  assertEquals(current.cost_per_1m_input_tokens, 4);
  assertEquals(rows.find((r) => r.id === "api-new")?.auth_method, "api_key");
  assertEquals(rows.find((r) => r.id === "api-old")?.is_active, false);
  assertEquals(rows.find((r) => r.id === "api-custom")?.is_active, true);
  assertEquals(rows.find((r) => r.id === "api-default")?.is_active, true);
  assertEquals(rows.find((r) => r.id === "api-disabled")?.is_active, false);
  assertEquals(rows.find((r) => r.id === "oauth-old")?.is_active, true);
  assertEquals(requests.filter((r) => r === "POST write_ai_health_catalog").length, 1);
});

for (const failure of ["read", "write"] as const) {
  Deno.test(`Higgsfield catalogue ${failure} failure leaves all catalogue rows unchanged`, async () => {
    const { db, rows, requests } = fixture(failure);
    const before = structuredClone(rows);
    await assertRejects(() => syncHiggsfieldCatalog(db, explore));
    assertEquals(rows, before);
    assert(requests.includes("POST release_cron_run_lease"));
  });
}

Deno.test("overlapping Higgsfield refresh refuses before discovery and releases its lease", async () => {
  const { db } = fixture();
  let begin!: () => void;
  let finish!: () => void;
  const started = new Promise<void>((resolve) => { begin = resolve; });
  const pending = new Promise<void>((resolve) => { finish = resolve; });
  const first = syncHiggsfieldCatalog(db, async () => { begin(); await pending; return explore(); });
  await started;
  try {
    await assertRejects(() => syncHiggsfieldCatalog(db, async () => { throw new Error("must not discover"); }), Error, "already running");
  } finally { finish(); await first; }
  await syncHiggsfieldCatalog(db, explore);
});

Deno.test('round5 health holder reuses its lease and syncs only api_key catalogue', async () => {
  const { db, rows, requests } = fixture();
  const holder = crypto.randomUUID();
  await db.rpc('acquire_cron_run_lease', { p_job: 'ai-provider-health', p_holder: holder, p_ttl: '120 seconds' });
  const report = await syncHiggsfieldCatalog(db, explore, { leaseHolder: holder, signal: AbortSignal.timeout(1000) });
  assertEquals(report.activated, 1);
  assertEquals(requests.filter((r) => r === 'POST acquire_cron_run_lease').length, 1);
  assertEquals(requests.includes('POST release_cron_run_lease'), false);
  assertEquals(rows.find((r) => r.id === 'oauth-old')?.is_active, true);
});


for (const malformed of [null, {}, { items: 'invalid' }, [{ name: 'missing id' }]]) {
  Deno.test(`malformed capability catalogue ${JSON.stringify(malformed)} cannot deactivate models`, async () => {
    const { db, rows, requests } = fixture();
    const before = structuredClone(rows);
    await assertRejects(() => syncHiggsfieldCatalog(db, async capability => capability === 'video' ? malformed : [{ id: 'current' }]));
    assertEquals(rows, before);
    assertEquals(requests.includes('POST write_ai_health_catalog'), false);
  });
}
