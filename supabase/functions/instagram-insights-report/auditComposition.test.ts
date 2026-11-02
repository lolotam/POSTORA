import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const API = "http://127.0.0.1:9";
const SERVICE = "synthetic-report-audit-service";
const OWNER = "a1000000-0000-4000-8000-000000000001";
const previous = new Map(["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"].map((key) => [key, Deno.env.get(key)]));
Deno.env.set("SUPABASE_URL", API);
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", SERVICE);
const { handler: instagram } = await import("./index.ts");
const { handler: owned } = await import("../meta-owned-analytics-report/index.ts");

Deno.test("anonymous report refusals share bounded audit slots while authenticated events stay individual", async () => {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  const slots = new Set<string>();
  let individual = 0;
  Date.now = () => Date.parse("2026-11-02T10:00:20Z");
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    assertEquals(new URL(request.url).pathname, "/rest/v1/system_logs");
    const row = await request.json();
    if (row.id) {
      assertEquals(request.headers.get("prefer")?.includes("resolution=ignore-duplicates"), true);
      assertEquals(row.metadata.coalesced, true);
      slots.add(row.id);
    } else { individual++; }
    return new Response(null, { status: 201 });
  };
  try {
    for (const handler of [instagram, owned]) {
      const response = () => handler(new Request(API, { method: "POST", body: JSON.stringify({
        platform: "threads", accountId: OWNER, analyticsContractVersion: 1,
      }) }));
      for (const result of await Promise.all(Array.from({ length: 20 }, response))) assertEquals(result.status, 401);
    }
    assertEquals(slots.size, 2, "Each endpoint retains one refusal slot for the minute");
    for (let index = 0; index < 2; index++) {
      const response = await instagram(new Request(API, { method: "POST", headers: { Authorization: `Bearer ${SERVICE}` },
        body: JSON.stringify({ user_id: OWNER }) }));
      assertEquals(response.status, 400);
    }
    assertEquals(individual, 2, "Authenticated invalid requests must not share an anonymous slot");
    Date.now = () => Date.parse("2026-11-02T10:01:20Z");
    assertEquals((await instagram(new Request(API, { method: "POST" }))).status, 401);
    assertEquals(slots.size, 3, "A later minute gets a new bounded slot");
  } finally {
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
    for (const [key, value] of previous) {
      if (value === undefined) Deno.env.delete(key); else Deno.env.set(key, value);
    }
  }
});
