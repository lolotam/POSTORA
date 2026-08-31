// deno-lint-ignore-file no-import-prefix
import {
  assertEquals,
  assertNotEquals,
  assertRejects,
  assertThrows,
} from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  assertActionAuthorized,
  authenticatePartnerKey,
  generatePartnerKey,
  hashPartnerKey,
  PartnerAuthError,
} from "./partnerApiKeys.ts";

const ACTIVE_ROW = {
  id: "key-1",
  workspace_id: "ws-1",
  social_account_id: "acct-1",
  key_prefix: "pk_live_abcd",
  scopes: ["whatsapp:template.send"],
  rate_limit_per_min: 60,
  monthly_quota: 1000,
  expires_at: null,
  revoked_at: null,
};

/**
 * Stub of the supabase-js query chain that actually HONOURS the filter.
 *
 * A stub that returns its row regardless of the `.eq()` argument would pass
 * even if authenticatePartnerKey looked up the wrong column or the plaintext
 * key instead of its hash. Recording the filter and matching on it is what
 * makes these assertions mean something.
 */
function stubClient(row: Record<string, unknown> | null, expectedHash?: string) {
  const filters: Record<string, unknown> = {};
  let table = "";
  return {
    from(name: string) {
      table = name;
      return {
        select() { return this; },
        eq(column: string, value: unknown) { filters[column] = value; return this; },
        maybeSingle() {
          if (table !== "partner_api_keys") {
            return Promise.resolve({ data: null, error: null });
          }
          // The module must query by key_hash, never by the raw key.
          if (expectedHash !== undefined && filters.key_hash !== expectedHash) {
            return Promise.resolve({ data: null, error: null });
          }
          return Promise.resolve({ data: row, error: null });
        },
      };
    },
  // deno-lint-ignore no-explicit-any
  } as any;
}

Deno.test("generatePartnerKey produces a pk_live_ key whose prefix and hash match", async () => {
  const { key, prefix, hash } = await generatePartnerKey();
  assertEquals(key.startsWith("pk_live_"), true);
  assertEquals(prefix, key.slice(0, 12));
  assertEquals(hash, await hashPartnerKey(key));
});

Deno.test("generatePartnerKey never repeats a key", async () => {
  const first = await generatePartnerKey();
  const second = await generatePartnerKey();
  assertNotEquals(first.key, second.key);
});

Deno.test("authenticatePartnerKey returns the record for an active key", async () => {
  const record = await authenticatePartnerKey(stubClient(ACTIVE_ROW), "pk_live_whatever");
  assertEquals(record.id, "key-1");
  assertEquals(record.workspaceId, "ws-1");
  assertEquals(record.socialAccountId, "acct-1");
});

Deno.test("authenticatePartnerKey looks the key up by its hash, never the plaintext", async () => {
  const key = "pk_live_whatever";
  const hash = await hashPartnerKey(key);
  // The stub only yields a row when filtered on exactly this hash, so a module
  // that queried `.eq("key_hash", key)` would get null and this would fail.
  const record = await authenticatePartnerKey(stubClient(ACTIVE_ROW, hash), key);
  assertEquals(record.id, "key-1");
});

Deno.test("authenticatePartnerKey rejects an unknown key as invalid_key", async () => {
  const error = await assertRejects(
    () => authenticatePartnerKey(stubClient(null), "pk_live_nope"),
    PartnerAuthError,
  );
  assertEquals(error.code, "invalid_key");
  assertEquals(error.status, 401);
});

Deno.test("authenticatePartnerKey rejects a revoked key as key_revoked", async () => {
  const revoked = { ...ACTIVE_ROW, revoked_at: "2026-01-01T00:00:00Z" };
  const error = await assertRejects(
    () => authenticatePartnerKey(stubClient(revoked), "pk_live_whatever"),
    PartnerAuthError,
  );
  assertEquals(error.code, "key_revoked");
  assertEquals(error.status, 401);
});

Deno.test("authenticatePartnerKey rejects an expired key", async () => {
  const expired = { ...ACTIVE_ROW, expires_at: "2020-01-01T00:00:00Z" };
  const error = await assertRejects(
    () => authenticatePartnerKey(stubClient(expired), "pk_live_whatever",
      new Date("2026-08-13T00:00:00Z")),
    PartnerAuthError,
  );
  assertEquals(error.code, "key_expired");
});

Deno.test("assertActionAuthorized accepts any satisfying scope and rejects a key holding none", () => {
  const record = {
    id: "key-1", workspaceId: "ws-1", socialAccountId: "acct-1",
    keyPrefix: "pk_live_abcd", scopes: ["whatsapp:template.send"],
    rateLimitPerMin: 60, monthlyQuota: null, expiresAt: null, revokedAt: null,
  };
  // Either vocabulary satisfies the action (D3): the key holds the legacy
  // string, and a key holding messages:send would pass the same check.
  assertActionAuthorized(record, "send_template", ["whatsapp:template.send", "messages:send"]);

  const error = assertThrows(
    () => assertActionAuthorized(record, "list_templates", ["whatsapp:templates.read", "templates:read"]),
    PartnerAuthError,
  );
  assertEquals(error.code, "insufficient_scope");
  assertEquals(error.status, 403);
  // The refusal names the action, not the scopes that would have worked:
  // listing those tells a stolen-key holder what to ask the victim to add.
  assertEquals(error.message.includes("templates:read"), false);
});

Deno.test("an empty satisfying set refuses every key, however scoped", () => {
  // whatsapp:webhooks.manage authorises nothing (D3 R3), so any action whose
  // satisfying set is empty must REFUSE rather than fall through to a
  // permissive default.
  const record = {
    id: "key-2", workspaceId: "ws-1", socialAccountId: "acct-1",
    keyPrefix: "pk_live_abcd", scopes: ["whatsapp:webhooks.manage", "messages:send"],
    rateLimitPerMin: 60, monthlyQuota: null, expiresAt: null, revokedAt: null,
  };
  const error = assertThrows(
    () => assertActionAuthorized(record, "nothing_grants_this", []),
    PartnerAuthError,
  );
  assertEquals(error.code, "insufficient_scope");
});
