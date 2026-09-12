// deno-lint-ignore-file no-import-prefix
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { getWhatsAppNumber, listWhatsAppNumbers } from "./whatsappNumberOps.ts";
import { decodeCursor } from "../partner-api/v1/pagination.ts";

const ID = "11111111-1111-4111-8111-111111111111";
const ROW = {
  id: ID, workspace_id: "ws-1", platform: "whatsapp",
  platform_user_id: "15550001111", platform_username: "Support",
  connection_mode: "evolution_qr", account_metadata: { display_name: "Help desk" },
  is_active: true, connected_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-10T00:00:00Z",
};
const CTX = { workspaceId: "ws-1", accountIds: [ID], requestId: "req-1" };

// Use the actual Supabase query builder; mock only the HTTP boundary. The
// requests below pin SQL scoping and keyset syntax without a fake builder
// silently accepting a wrong column or a non-composing .or() chain.
function database(reply: (url: URL) => Response) {
  const queries: URL[] = [];
  const admin = createClient("https://database.example", "test-key", {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (input) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      queries.push(url);
      return Promise.resolve(reply(url));
    } },
  });
  return { admin, queries };
}

function json(rows: unknown, status = 200): Response {
  return new Response(JSON.stringify(rows), { status, headers: { "Content-Type": "application/json" } });
}

Deno.test("number listing scopes the database read to bound WhatsApp accounts in the workspace", async () => {
  const client = database((url) => {
    assertEquals(url.pathname, "/rest/v1/social_accounts");
    assertEquals(url.searchParams.get("workspace_id"), "eq.ws-1");
    assertEquals(url.searchParams.get("platform"), "eq.whatsapp");
    assertEquals(url.searchParams.get("id"), `in.(${ID})`);
    assertEquals(url.searchParams.get("order"), "updated_at.desc,id.desc");
    assertEquals(url.searchParams.get("limit"), "21");
    assert(!url.searchParams.get("select")!.includes("access_token"));
    return json([ROW]);
  });
  const result = await listWhatsAppNumbers({ ...CTX, admin: client.admin });
  assert(result.ok);
  assertEquals(result.numbers.map((number) => number.account_id), [ID]);
  assertEquals(client.queries.length, 1);
});

Deno.test("empty bindings return an empty page without reading any accounts", async () => {
  const client = database(() => { throw new Error("unexpected database read"); });
  assertEquals(await listWhatsAppNumbers({ ...CTX, accountIds: [], admin: client.admin }), {
    ok: true, numbers: [], nextCursor: null,
  });
  assertEquals(client.queries, []);
});

for (const scenario of [
  { name: "Direct QR label is never the phone number", row: ROW, phone: "15550001111", status: "connected", nameValue: "Help desk" },
  { name: "Cloud API exposes display_phone_number rather than Meta's id", row: { ...ROW, connection_mode: "cloud_api", platform_user_id: "meta-opaque-id", account_metadata: { display_phone_number: "+1 555 000 2222" } }, phone: "+1 555 000 2222", status: "connected", nameValue: "Support" },
  { name: "coexistence exposes display_phone_number rather than Meta's id", row: { ...ROW, connection_mode: "coexistence", platform_user_id: "meta-opaque-id", account_metadata: { display_phone_number: "+1 555 000 3333" } }, phone: "+1 555 000 3333", status: "connected", nameValue: "Support" },
  { name: "unpaired placeholder remains pending", row: { ...ROW, platform_user_id: `pending_${ID}`, is_active: false }, phone: null, status: "pending", nameValue: "Help desk" },
  { name: "active placeholder remains pending until identity resolves", row: { ...ROW, platform_user_id: `pending_${ID}` }, phone: null, status: "pending", nameValue: "Help desk" },
  { name: "resolved inactive number remains visible as disconnected", row: { ...ROW, is_active: false }, phone: "15550001111", status: "disconnected", nameValue: "Help desk" },
  { name: "missing Meta display number never falls back to opaque id", row: { ...ROW, connection_mode: "cloud_api", account_metadata: {} }, phone: null, status: "connected", nameValue: "Support" },
] as const) {
  Deno.test(scenario.name, async () => {
    const client = database(() => json([scenario.row]));
    const result = await listWhatsAppNumbers({ ...CTX, admin: client.admin });
    assert(result.ok);
    assertEquals(result.numbers[0], {
      account_id: ID, phone_number: scenario.phone, display_name: scenario.nameValue,
      connection_mode: scenario.row.connection_mode, status: scenario.status, connected_at: ROW.connected_at,
    });
  });
}

Deno.test("failed list and item reads return failures, never empty success or not found", async () => {
  const client = database(() => json({ code: "57014", message: "statement timeout" }, 500));
  const ctx = { ...CTX, admin: client.admin };
  assertEquals(await listWhatsAppNumbers(ctx), { ok: false, reason: "read_failed" });
  assertEquals(await getWhatsAppNumber(ctx, ID), { ok: false, reason: "read_failed" });
});

Deno.test("unbound item is refused before any database request", async () => {
  const client = database(() => { throw new Error("must not query an unbound id"); });
  assertEquals(await getWhatsAppNumber({ ...CTX, admin: client.admin }, "elsewhere"), {
    ok: false, reason: "not_found",
  });
  assertEquals(client.queries, []);
});

Deno.test("item read constrains workspace and platform and distinguishes absent rows", async () => {
  const client = database((url) => {
    assertEquals(url.searchParams.get("workspace_id"), "eq.ws-1");
    assertEquals(url.searchParams.get("platform"), "eq.whatsapp");
    assertEquals(url.searchParams.get("id"), `eq.${ID}`);
    return json(client.queries.length === 1 ? [ROW] : []);
  });
  const ctx = { ...CTX, admin: client.admin };
  const result = await getWhatsAppNumber(ctx, ID);
  assert(result.ok);
  assertEquals(result.number.phone_number, "15550001111");
  assertEquals(await getWhatsAppNumber(ctx, ID), { ok: false, reason: "not_found" });
});

Deno.test("two pages with identical updated_at neither repeat nor drop rows at the boundary", async () => {
  const ids = ["44444444-4444-4444-8444-444444444444", "33333333-3333-4333-8333-333333333333", ID];
  const rows = ids.map((id) => ({ ...ROW, id }));
  const client = database((url) => {
    assertEquals(url.searchParams.get("order"), "updated_at.desc,id.desc");
    assertEquals(url.searchParams.get("limit"), "3");
    assertEquals(url.searchParams.get("id"), `in.(${ids.join(",")})`);
    assertEquals(url.searchParams.get("workspace_id"), "eq.ws-1");
    if (client.queries.length === 1) {
      assertEquals(url.searchParams.getAll("or"), []);
      return json(rows);
    }
    // PR #35 regression: the complete timestamp/id disjunction in ONE group.
    assertEquals(url.searchParams.getAll("or"), [
      `(updated_at.lt.${ROW.updated_at},and(updated_at.eq.${ROW.updated_at},id.lt.${ids[1]}))`,
    ]);
    return json([rows[2]]);
  });
  const ctx = { ...CTX, accountIds: ids, admin: client.admin };
  const first = await listWhatsAppNumbers(ctx, { limit: 2, cursor: null });
  assert(first.ok && first.nextCursor);
  const cursor = decodeCursor(first.nextCursor);
  assertEquals(cursor, { timestamp: ROW.updated_at, id: ids[1] });
  const second = await listWhatsAppNumbers(ctx, { limit: 2, cursor });
  assert(second.ok);
  assertEquals([...first.numbers, ...second.numbers].map((number) => number.account_id), ids);
  assertEquals(second.nextCursor, null);
});
