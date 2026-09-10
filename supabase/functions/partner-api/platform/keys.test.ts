// deno-lint-ignore-file no-import-prefix
import { assertEquals, assertMatch } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { hashPartnerKey } from "../../_shared/partnerApiKeys.ts";
import { issueWorkspaceKey, revokeWorkspaceKey } from "./keys.ts";

const ID = "00000000-0000-4000-8000-000000000001";
const AUTHED = {
  record: { id: "platform-key", principalId: "principal", keyPrefix: "pl_live_", scopes: [], rateLimitPerMin: 30, expiresAt: null, revokedAt: null },
  requestId: "key-test", rateHeaders: {},
};
const BODY = { name: "Support", scopes: ["messages:read"], account_id: ID };
function request(body: unknown = BODY) {
  return new Request("https://x/v1/platform/workspaces/keys", { method: "POST", body: JSON.stringify(body) });
}

Deno.test("issuance uses the atomic estate RPC and persists only the generated digest", async () => {
  let persisted: Record<string, unknown> = {};
  const admin = { rpc(name: string, args: Record<string, unknown>) {
    assertEquals(name, "issue_partner_key_in_estate");
    persisted = args;
    return Promise.resolve({ data: ID, error: null });
  } };
  const res = await issueWorkspaceKey(request(), { ...AUTHED, admin }, { id: ID });
  assertEquals(res.status, 201);
  assertEquals(res.headers.get("Cache-Control"), "no-store");
  const body = await res.json();
  assertMatch(body.key, /^pk_live_/);
  assertEquals(persisted, {
    p_principal_id: "principal", p_workspace_id: ID, p_social_account_id: ID,
    p_key_name: BODY.name, p_key_prefix: body.key_prefix, p_key_hash: await hashPartnerKey(body.key),
    p_scopes: BODY.scopes, p_environment: "production", p_platform_key_id: "platform-key", p_request_id: "key-test",
  });
  assertEquals(JSON.stringify(persisted).includes(body.key), false);
});

for (const [label, body] of [
  ["missing account", { name: "n", scopes: ["messages:read"] }],
  ["platform scope", { ...BODY, scopes: ["platform:keys.manage"] }],
  ["future platform scope", { ...BODY, scopes: ["platform:future"] }],
  ["mixed malformed scopes", { ...BODY, scopes: ["messages:read", 7] }],
  ["legacy scope", { ...BODY, scopes: ["whatsapp:template.send"] }],
  ["null JSON", null],
  ["array JSON", []],
] as const) {
  Deno.test(`key issuance rejects ${label} before database access`, async () => {
    const res = await issueWorkspaceKey(request(body), { ...AUTHED, admin: {} }, { id: ID });
    assertEquals(res.status, 400);
    assertEquals((await res.json()).error.code, "invalid_request");
  });
}

for (const [label, error, status, code] of [
  ["workspace or account outside estate", { code: "P0002" }, 404, "resource_not_found"],
  ["RPC outage", { code: "57014" }, 500, "internal_error"],
] as const) {
  Deno.test(`key issuance maps ${label} without exposing SQL`, async () => {
    const admin = { rpc: () => Promise.resolve({ data: ID, error }) };
    const res = await issueWorkspaceKey(request(), { ...AUTHED, admin }, { id: ID });
    assertEquals(res.status, status);
    assertEquals((await res.json()).error.code, code);
  });
}

Deno.test("revocation returns 204 once; an already-revoked key answers resource_not_found", async () => {
  let revoked = false;
  const admin = { rpc(name: string, args: Record<string, unknown>) {
    assertEquals(name, "revoke_partner_key_in_estate");
    assertEquals(args, { p_principal_id: "principal", p_key_id: ID,
      p_reason: "revoked via platform API", p_platform_key_id: "platform-key", p_request_id: "key-test" });
    const changed = !revoked;
    revoked = true;
    return Promise.resolve({ data: changed, error: null });
  } };
  const first = await revokeWorkspaceKey(request(), { ...AUTHED, admin }, { id: ID });
  assertEquals(first.status, 204);
  assertEquals(await first.text(), "");
  assertEquals(first.headers.get("X-Postora-Request-Id"), "key-test");
  const second = await revokeWorkspaceKey(request(), { ...AUTHED, admin }, { id: ID });
  assertEquals(second.status, 404);
  assertEquals((await second.json()).error.code, "resource_not_found");
});

for (const [label, result, status, code] of [
  ["outside estate", { data: false, error: null }, 404, "resource_not_found"],
  ["failed RPC", { data: true, error: { code: "57014" } }, 500, "internal_error"],
] as const) {
  Deno.test(`revocation refuses ${label}`, async () => {
    const res = await revokeWorkspaceKey(request(), {
      ...AUTHED, admin: { rpc: () => Promise.resolve(result) },
    }, { id: ID });
    assertEquals(res.status, status);
    assertEquals((await res.json()).error.code, code);
  });
}
