// deno-lint-ignore-file no-import-prefix
import {
  assertEquals,
  assertRejects,
  assertThrows,
} from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  assertActionAuthorized,
  authenticatePartnerKey,
  PartnerAuthError,
} from "../_shared/partnerApiKeys.ts";
import { satisfyingScopesFor } from "./router.ts";

const WS_A_KEY = {
  id: "key-a", workspace_id: "ws-a", social_account_id: "acct-a",
  key_prefix: "pk_live_aaaa", scopes: ["whatsapp:template.send"],
  rate_limit_per_min: 60, monthly_quota: null, expires_at: null, revoked_at: null,
};

function stubClient(row: unknown) {
  return {
    from() {
      return {
        select() { return this; },
        eq() { return this; },
        maybeSingle() { return Promise.resolve({ data: row, error: null }); },
      };
    },
  // deno-lint-ignore no-explicit-any
  } as any;
}

Deno.test("the target account comes from the key row, not the request body", async () => {
  const record = await authenticatePartnerKey(stubClient(WS_A_KEY), "pk_live_whatever");
  assertEquals(record.workspaceId, "ws-a");
  assertEquals(record.socialAccountId, "acct-a");
  // This is the point worth asserting: PartnerKeyRecord exposes no way for a
  // caller to name a different account, so partner-api has nothing to trust
  // from the request. Whether the pairing is legal at all is enforced by the
  // composite FK and proven in Task 9, not here.
});

Deno.test("a send-only key cannot read templates", () => {
  const record = {
    id: "key-a", workspaceId: "ws-a", socialAccountId: "acct-a",
    keyPrefix: "pk_live_aaaa", scopes: ["whatsapp:template.send"],
    rateLimitPerMin: 60, monthlyQuota: null, expiresAt: null, revokedAt: null,
  };
  const error = assertThrows(
    () => assertActionAuthorized(record, "list_templates", satisfyingScopesFor("list_templates")!),
    PartnerAuthError,
  );
  assertEquals(error.code, "insufficient_scope");
  assertEquals(error.status, 403);
});

Deno.test("a read-only key cannot send", () => {
  const record = {
    id: "key-b", workspaceId: "ws-b", socialAccountId: "acct-b",
    keyPrefix: "pk_live_bbbb", scopes: ["whatsapp:templates.read"],
    rateLimitPerMin: 60, monthlyQuota: null, expiresAt: null, revokedAt: null,
  };
  const error = assertThrows(
    () => assertActionAuthorized(record, "send_template", satisfyingScopesFor("send_template")!),
    PartnerAuthError,
  );
  assertEquals(error.code, "insufficient_scope");
});

Deno.test("a revoked key is rejected even with correct scopes", async () => {
  const revoked = { ...WS_A_KEY, revoked_at: "2026-08-01T00:00:00Z" };
  const error = await assertRejects(
    () => authenticatePartnerKey(stubClient(revoked), "pk_live_whatever"),
    PartnerAuthError,
  );
  assertEquals(error.code, "key_revoked");
});

Deno.test("an unknown key is indistinguishable from a malformed one", async () => {
  const unknown = await assertRejects(
    () => authenticatePartnerKey(stubClient(null), "pk_live_unknown"),
    PartnerAuthError,
  );
  const malformed = await assertRejects(
    () => authenticatePartnerKey(stubClient(null), "not-a-key"),
    PartnerAuthError,
  );
  // Identical code and status: keys are not enumerable by probing.
  assertEquals(unknown.code, malformed.code);
  assertEquals(unknown.status, malformed.status);
});
