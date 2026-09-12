// deno-lint-ignore-file no-import-prefix
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { hashPartnerKey } from "../../_shared/partnerApiKeys.ts";
import { ACTION_SCOPES } from "../router.ts";
import { handleV1Request } from "../v1/router.ts";
import { PLATFORM_ACTION_SCOPES } from "./policy.ts";

const ID = "00000000-0000-4000-8000-000000000001";
const KEY = "pl_live_0123456789abcdef0123456789abcdef";
const CREATE = { name: "Tenant", connection_name: "Support",
  risk_consent: { accepted: true, accepted_by: "Admin", accepted_at: "2026-09-10T00:00:00Z", accepted_ip: "192.0.2.1" },
  consent_version: "direct-qr-v1" };

for (const [method, path, body, status, observed] of [
  ["POST", "/v1/platform/workspaces", CREATE, 201, "provision_partner_tenant"],
  ["GET", "/v1/platform/workspaces", null, 200, "estate.list"],
  ["GET", `/v1/platform/workspaces/${ID}`, null, 200, "estate.get"],
  ["POST", `/v1/platform/workspaces/${ID}/keys`, { name: "Key", scopes: ["messages:read"], account_id: ID }, 201, "issue_partner_key_in_estate"],
  ["DELETE", `/v1/platform/keys/${ID}`, null, 204, "revoke_partner_key_in_estate"],
] as const) {
  Deno.test(`${method} ${path} invokes the real platform handler through handleV1Request`, async () => {
    const calls: string[] = [];
    const hash = await hashPartnerKey(KEY);
    const admin = {
      auth: { admin: { createUser: () => Promise.resolve({ data: { user: { id: ID } }, error: null }) } },
      rpc(name: string) {
        calls.push(name);
        const data = name === "consume_partner_platform_rate" ? { allowed: true, remaining: 29, reset_seconds: 42 }
          : name === "provision_partner_tenant" ? { workspace_id: ID, account_id: ID, key_id: ID }
          : name === "issue_partner_key_in_estate" ? ID : true;
        return Promise.resolve({ data, error: null });
      },
      from(table: string) {
        return {
          select() { return this; },
          eq(column: string, value: unknown) { if (column === "key_hash") assertEquals(value, hash); return this; },
          is() { return this; }, order() { return this; }, limit() { return this; },
          insert: () => Promise.resolve({ error: null }),
          update() { return this; },
          maybeSingle() {
            if (table === "partner_platform_keys") return Promise.resolve({ data: {
              id: ID, principal_id: ID, key_prefix: KEY.slice(0, 12), environment: "production",
              scopes: Object.values(PLATFORM_ACTION_SCOPES).flat(), rate_limit_per_min: 30, revoked_at: null,
            }, error: null });
            if (table === "partner_provisioning_attempts") return Promise.resolve({ data: { id: ID }, error: null });
            if (table === "user_quotas") return Promise.resolve({ data: null, error: null });
            assertEquals(table, "partner_provisioned_workspaces"); calls.push("estate.get");
            return Promise.resolve({ data: { workspace_id: ID }, error: null });
          },
          then(resolve: (result: unknown) => unknown) {
            assertEquals(table, "partner_provisioned_workspaces"); calls.push("estate.list");
            return Promise.resolve({ data: [], error: null }).then(resolve);
          },
        };
      },
    };
    const res = await handleV1Request(new Request(`https://x${path}`, {
      method, headers: { authorization: `Bearer ${KEY}` }, ...(body ? { body: JSON.stringify(body) } : {}),
    }), path, "dispatch-test", () => admin);
    assertEquals(res.status, status);
    assertEquals(calls.includes(observed), true, `${observed} proves the handler executed`);
    assertEquals(res.headers.get("X-Postora-Request-Id"), "dispatch-test");
    assertEquals(res.headers.get("X-RateLimit-Remaining"), "29");
  });
}

Deno.test("an unmatched platform path returns 404 without constructing a Supabase client", async () => {
  let constructed = false;
  const res = await handleV1Request(new Request("https://x/v1/platform/unknown"),
    "/v1/platform/unknown", "unmatched", () => { constructed = true; throw new Error("no client"); });
  assertEquals(res.status, 404);
  assertEquals(constructed, false);
});

for (const [path, key, status] of [
  ["/v1/platform/workspaces", "pk_live_wrong_tier", 404],
  ["/v1/accounts", KEY, 404],
  ["/v1/usage", "", 401],
] as const) {
  Deno.test(`${path} preserves credential tier isolation`, async () => {
    let constructed = false;
    const res = await handleV1Request(new Request(`https://x${path}`, { headers: { "x-postora-key": key } }),
      path, "isolation", () => { constructed = true; return {}; });
    assertEquals(res.status, status);
    // The established workspace wrapper constructs its client before auth;
    // only the platform wrapper rejects a wrong-tier prefix before creation.
    assertEquals(constructed, !path.startsWith("/v1/platform/"));
  });
}

Deno.test("no platform action is also a workspace action", () => {
  for (const action of Object.keys(PLATFORM_ACTION_SCOPES)) assertEquals(Object.hasOwn(ACTION_SCOPES, action), false);
});
