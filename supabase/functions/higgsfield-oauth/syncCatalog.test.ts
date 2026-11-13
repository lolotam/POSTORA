import { assertEquals, assertRejects } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { syncHiggsfieldCatalog } from "./syncCatalog.ts";

function fixture(failure?: "read" | "write") {
  const rows = [
    { id: "api-current", model_id: "current", auth_method: "api_key", is_active: false },
    { id: "api-old", model_id: "old", auth_method: "api_key", is_active: true },
    { id: "oauth-old", model_id: "old", auth_method: "oauth", is_active: true },
  ];
  const transport = (async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const reply = (data: unknown, status = 200) => new Response(JSON.stringify(data), {
      status, headers: { "content-type": "application/json" },
    });
    if (url.pathname.endsWith("ai_providers")) return reply({ id: "provider" });
    if (method === "POST") {
      const row = JSON.parse(String(init?.body));
      assertEquals(url.searchParams.get("on_conflict"), "provider_id,model_id,auth_method");
      const existing = rows.find((r) => r.model_id === row.model_id && r.auth_method === row.auth_method);
      if (existing) Object.assign(existing, row);
      else rows.push({ ...row, id: "oauth-current" });
      return new Response(null, { status: 201 });
    }
    if (failure === "read" && method === "GET" || failure === "write" && method === "PATCH") {
      return reply({ message: "database failed" }, 503);
    }
    const selected = rows.filter((row) =>
      url.searchParams.get("auth_method") === `eq.${row.auth_method}` &&
      (!url.searchParams.has("is_active") || String(row.is_active) === url.searchParams.get("is_active")?.slice(3)) &&
      (!url.searchParams.has("id") || url.searchParams.get("id")?.includes(row.id)));
    if (method === "PATCH") {
      for (const row of selected) Object.assign(row, JSON.parse(String(init?.body)));
      return new Response(null, { status: 204 });
    }
    return reply(selected);
  }) as typeof fetch;
  return { rows, db: createClient("https://database.example.test", "fixture-key", { global: { fetch: transport } }) };
}

const explore = async () => [{ id: "current", name: "Current model" }];

Deno.test("Higgsfield subscription sync preserves API-key copies and deactivates only stale OAuth rows", async () => {
  const { db, rows } = fixture();
  const report = await syncHiggsfieldCatalog(db, explore);
  assertEquals(report.deactivated, 1);
  assertEquals(rows.find((r) => r.id === "api-current")?.is_active, false);
  assertEquals(rows.find((r) => r.id === "api-old")?.is_active, true);
  assertEquals(rows.find((r) => r.id === "oauth-old")?.is_active, false);
  assertEquals(rows.find((r) => r.id === "oauth-current")?.is_active, true);
});

for (const failure of ["read", "write"] as const) {
  Deno.test(`Higgsfield cleanup ${failure} failure cannot return successful counts`, async () => {
    const { db } = fixture(failure);
    await assertRejects(() => syncHiggsfieldCatalog(db, explore), Error, `cleanup ${failure} failed`);
  });
}
