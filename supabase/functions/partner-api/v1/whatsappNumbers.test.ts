// deno-lint-ignore-file no-import-prefix
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { handleRequest } from "../index.ts";
import { decodeCursor } from "./pagination.ts";

const ID = "22222222-2222-4222-8222-222222222222";
const OTHER = "11111111-1111-4111-8111-111111111111";
const ROW = {
  id: ID, workspace_id: "ws-1", platform: "whatsapp", platform_user_id: "15550001111",
  platform_username: "Support", connection_mode: "evolution_qr", account_metadata: {},
  is_active: true, connected_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-10T00:00:00Z",
};

function database(opts: { entitled?: boolean; scopes?: string[]; failTable?: string } = {}) {
  const reads: URL[] = [];
  const writes: Array<{ table: string; row: Record<string, unknown> }> = [];
  const admin = createClient("https://database.example", "test-key", {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const table = url.pathname.split("/").at(-1)!;
      if (table === "consume_partner_rate_v2") {
        return Promise.resolve(Response.json({ allowed: true, remaining: 59, reset_seconds: 42 }));
      }
      if (init?.method === "POST") {
        assert(["system_logs", "partner_api_usage"].includes(table), `unexpected write to ${table}`);
        writes.push({ table, row: JSON.parse(String(init.body)) });
        return Promise.resolve(new Response(null, { status: 201 }));
      }
      reads.push(url);
      if (table === opts.failTable) {
        return Promise.resolve(Response.json({ code: "57014", message: "private database failure" }, { status: 500 }));
      }
      const rows: Record<string, unknown[]> = {
        partner_api_keys: [{
          id: "key-1", workspace_id: "ws-1", social_account_id: OTHER,
          key_prefix: "pk_live_test", scopes: opts.scopes ?? ["whatsapp:numbers.read"],
          rate_limit_per_min: 60, monthly_quota: null, expires_at: null, revoked_at: null,
        }],
        partner_provisioned_workspaces: [{ owner_user_id: "owner-1" }],
        app_settings: [{ key: "feature_msg_whatsapp", value: opts.entitled ?? true }],
        user_feature_overrides: [],
        partner_api_key_accounts: [{ social_account_id: ID }],
        social_accounts: url.searchParams.get("id")?.startsWith("eq.") ? [ROW] :
          [ROW, { ...ROW, id: OTHER }],
      };
      assert(Object.hasOwn(rows, table), `unexpected read of ${table}`);
      return Promise.resolve(Response.json(rows[table]));
    } },
  });
  return { admin, reads, writes };
}

function request(suffix = "") {
  return new Request(`https://partner.example/functions/v1/partner-api/v1/whatsapp/numbers${suffix}`, {
    headers: { "x-postora-key": "pk_live_test" },
  });
}

Deno.test("number route returns a page, cursor and request id through authentication and binding", async () => {
  const client = database();
  const res = await handleRequest(request("?limit=1"), () => client.admin);
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.data.map((number: { account_id: string }) => number.account_id), [ID]);
  assertEquals(decodeCursor(body.next_cursor), { timestamp: ROW.updated_at, id: ID });
  assertEquals(body.request_id, res.headers.get("X-Postora-Request-Id"));
  assertEquals(res.headers.get("X-RateLimit-Remaining"), "59");
  assertEquals(client.reads.map((url) => url.pathname.split("/").at(-1)), [
    "partner_api_keys", "partner_provisioned_workspaces", "app_settings",
    "user_feature_overrides", "partner_api_key_accounts", "social_accounts",
  ]);
  const binding = client.reads.find((url) => url.pathname.endsWith("/partner_api_key_accounts"))!;
  assertEquals(binding.searchParams.get("key_id"), "eq.key-1");
  assertEquals(binding.searchParams.get("workspace_id"), "eq.ws-1");
  const accounts = client.reads.at(-1)!;
  assertEquals(accounts.searchParams.get("id"), `in.(${ID})`);
  assertEquals(accounts.searchParams.get("workspace_id"), "eq.ws-1");
  assertEquals(accounts.searchParams.get("limit"), "2");
  assertEquals(client.writes.find((write) => write.table === "partner_api_usage")?.row.billable, false);
});

for (const [suffix, action] of [["", "list_whatsapp_numbers"], [`/${ID}`, "get_whatsapp_number"]]) {
  Deno.test(`${action}: disabled feature returns logged 403 before binding or account reads`, async () => {
    const client = database({ entitled: false });
    const res = await handleRequest(request(suffix), () => client.admin);
    assertEquals(res.status, 403);
    const body = await res.json();
    assertEquals(body.error.code, "feature_not_entitled");
    assert(!client.reads.some((url) => /\/(social_accounts|partner_api_key_accounts)$/.test(url.pathname)));
    const log = client.writes.find((write) => write.table === "system_logs")!;
    assertEquals((log.row.metadata as Record<string, unknown>).action, action);
    const ledger = client.writes.find((write) => write.table === "partner_api_usage")!;
    assertEquals(ledger.row.action, action);
    assertEquals(ledger.row.error_code, "feature_not_entitled");
  });
}

Deno.test("unbound number returns a logged 404 without querying the requested account", async () => {
  const client = database();
  const res = await handleRequest(request(`/${OTHER}`), () => client.admin);
  assertEquals(res.status, 404);
  assertEquals((await res.json()).error.code, "resource_not_found");
  assert(!client.reads.some((url) => url.pathname.endsWith("/social_accounts")));
  assertEquals(client.writes.find((write) => write.table === "partner_api_usage")?.row.error_code, "resource_not_found");
});

Deno.test("bound item renders its phone number and request id", async () => {
  const client = database();
  const res = await handleRequest(request(`/${ID}`), () => client.admin);
  assertEquals(res.status, 200);
  assertEquals(await res.json(), {
    account_id: ID, phone_number: "15550001111", display_name: "Support",
    connection_mode: "evolution_qr", status: "connected", connected_at: ROW.connected_at,
    request_id: res.headers.get("X-Postora-Request-Id"),
  });
});

for (const suffix of ["", `/${ID}`]) {
  Deno.test(`legacy WhatsApp scopes cannot authorize number read ${suffix || "collection"}`, async () => {
    const client = database({ scopes: ["whatsapp:template.send", "whatsapp:templates.read", "whatsapp:webhooks.manage"] });
    const res = await handleRequest(request(suffix), () => client.admin);
    assertEquals(res.status, 403);
    assertEquals((await res.json()).error.code, "insufficient_scope");
    assertEquals(client.reads.length, 1);
  });
}

for (const failTable of ["partner_provisioned_workspaces", "partner_api_key_accounts", "social_accounts"]) {
  Deno.test(`number read failure in ${failTable} is a logged sanitized 500`, async () => {
    const client = database({ failTable });
    const res = await handleRequest(request(), () => client.admin);
    assertEquals(res.status, 500);
    const body = await res.json();
    assertEquals(body.error.code, "internal_error");
    assert(!JSON.stringify(body).includes("private database failure"));
    assertEquals(client.writes.find((write) => write.table === "partner_api_usage")?.row.error_code, "internal_error");
  });
}

Deno.test("invalid pagination is logged and refused before the account read", async () => {
  const client = database();
  const res = await handleRequest(request("?cursor=broken"), () => client.admin);
  assertEquals(res.status, 400);
  assertEquals((await res.json()).error.code, "invalid_request");
  assert(!client.reads.some((url) => url.pathname.endsWith("/social_accounts")));
  assertEquals(client.writes.find((write) => write.table === "partner_api_usage")?.row.error_code, "invalid_request");
});
