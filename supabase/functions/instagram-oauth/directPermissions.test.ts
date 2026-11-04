import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

import type { MetaOAuthReceipt } from "../_shared/metaOAuthAttemptStore.ts";
import { type DirectPermissionEvidence, recordDirectInstagramPermissions } from "./directPermissions.ts";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const ACCOUNT_ID = "40e7f6d0-e762-4a00-b83e-aa8b56065458";
const CANONICAL_ID = "17841400000000001";
const READ_AT = new Date("2026-11-04T03:41:45.000Z");
const GRANTED = ["instagram_business_basic", "instagram_business_manage_insights"];

function receiptOf(overrides: Partial<MetaOAuthReceipt> = {}): MetaOAuthReceipt {
  return {
    attemptId: "attempt-1",
    selectionKey: "selection-1",
    flow: "instagram_direct",
    intent: "connect",
    platform: "instagram",
    platformUserId: CANONICAL_ID,
    instagramUserId: CANONICAL_ID,
    facebookPageId: null,
    facebookUserId: null,
    socialAccountId: ACCOUNT_ID,
    companionSocialAccountId: null,
    username: "pilot",
    operation: "created",
    loginKind: "direct",
    credentialId: null,
    credentialRevision: null,
    connectionVersion: 1,
    capabilityGeneration: 1,
    committedAt: "2026-11-04T03:41:44.419Z",
    ...overrides,
  } as MetaOAuthReceipt;
}

/** The projection the write returns, echoing what was written. */
function projectionOf(payload: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  return {
    social_account_id: ACCOUNT_ID,
    capability_present: true,
    login_kind: payload.login_kind,
    permission_read_state: payload.permission_read_state,
    scopes_authoritative: true,
    granted_scopes: payload.granted_scopes,
    scopes_read_at: payload.scopes_read_at,
    last_read_failed_at: null,
    last_read_error_code: null,
    credential_generation: payload.expected_credential_generation,
    credential_updated_at: "2026-11-04T03:41:44.419696+00:00",
    generation_reason: "reconnect",
    reconnected_at: "2026-11-04T03:41:44.419696+00:00",
    has_protected_credential: true,
    updated_at: "2026-11-04T03:41:45.000+00:00",
    ...overrides,
  };
}

type Answer = (payload: Record<string, unknown>) => unknown;

function recordWith(answer: Answer, receipt = receiptOf(), granted: string[] | null = GRANTED) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const evidence: DirectPermissionEvidence = { canonicalId: CANONICAL_ID, grantedPermissions: granted };
  const outcome = recordDirectInstagramPermissions({
    userId: USER_ID,
    receipt,
    evidence,
    now: () => READ_AT,
    rpc: (name, args) => {
      calls.push({ name, args });
      return Promise.resolve(answer(args.p_payload as Record<string, unknown>));
    },
  });
  return { outcome, calls };
}

const echo: Answer = (payload) => ({ data: projectionOf(payload), error: null });

Deno.test("the exchange's grant set is written once, fenced on the committed generation", async () => {
  const { outcome, calls } = recordWith(echo);

  assertEquals(await outcome, { status: "ok", insights_granted: true });
  // The SQL suite instagram_direct_collection_credential.sql (section E8)
  // replays this exact payload against the real write and the real reader.
  assertEquals(calls, [{
    name: "write_instagram_account_capability",
    args: {
      p_user_id: USER_ID,
      p_social_account_id: ACCOUNT_ID,
      p_payload: {
        login_kind: "direct",
        permission_read_state: "ok",
        granted_scopes: GRANTED,
        scopes_read_at: "2026-11-04T03:41:45.000Z",
        expected_credential_generation: 1,
      },
    },
  }]);
});

Deno.test("a grant set without the insights permission is recorded as read, not as granted", async () => {
  const { outcome, calls } = recordWith(echo, receiptOf(), ["instagram_business_basic"]);

  assertEquals(await outcome, { status: "ok", insights_granted: false });
  assertEquals(calls.length, 1);
});

Deno.test("an exchange without grant evidence writes nothing and stays unknown", async () => {
  const { outcome, calls } = recordWith(echo, receiptOf(), null);

  assertEquals(await outcome, { status: "unknown" });
  assertEquals(calls.length, 0);
});

Deno.test("evidence that is not bound to this direct commit is never written", async () => {
  const receipts: Array<[string, Partial<MetaOAuthReceipt>]> = [
    ["another platform", { platform: "facebook" }],
    ["another flow", { flow: "instagram_page_linked" as MetaOAuthReceipt["flow"] }],
    ["a page-linked commit", { loginKind: "page_linked" }],
    ["no account", { socialAccountId: null }],
    ["no capability generation", { capabilityGeneration: null }],
    ["another identity", { platformUserId: "17841400000000002" }],
  ];
  for (const [label, overrides] of receipts) {
    const { outcome, calls } = recordWith(echo, receiptOf(overrides));
    assertEquals(await outcome, { status: "unconfirmed" }, label);
    assertEquals(calls.length, 0, label);
  }
});

// A reconnect that committed a newer generation (ICG01), or a generation that
// opened after this evidence was read (ICG02), refuses the late write.
Deno.test("a write that lost to a newer generation is reported stale", async () => {
  for (const code of ["ICG01", "ICG02"]) {
    const { outcome, calls } = recordWith(() => ({
      data: null,
      error: { code, message: "stale credential generation: expected 1 live 2" },
    }));
    assertEquals(await outcome, { status: "stale" }, code);
    assertEquals(calls.length, 1, code);
  }
});

Deno.test("a write whose answer does not prove the evidence landed is unconfirmed", async () => {
  const answers: Array<[string, Answer]> = [
    ["another generation", (payload) => ({ data: projectionOf(payload, { credential_generation: 2 }), error: null })],
    ["another account", (payload) => ({
      data: projectionOf(payload, { social_account_id: "22222222-2222-4222-8222-222222222222" }),
      error: null,
    })],
    ["other scopes", (payload) => ({ data: projectionOf(payload, { granted_scopes: ["instagram_business_basic"] }), error: null })],
    ["not authoritative", (payload) => ({ data: projectionOf(payload, { scopes_authoritative: false }), error: null })],
    ["another read time", (payload) => ({
      data: projectionOf(payload, { scopes_read_at: "2026-11-04T03:00:00.000Z" }),
      error: null,
    })],
    ["still unknown", (payload) => ({ data: projectionOf(payload, { permission_read_state: "unknown" }), error: null })],
    ["a refusal that is not a fence", () => ({ data: null, error: { code: "ICG04", message: "bad timestamp" } })],
    ["no row", () => ({ data: null, error: null })],
    ["a malformed projection", () => ({ data: { social_account_id: ACCOUNT_ID }, error: null })],
  ];
  for (const [label, answer] of answers) {
    const { outcome, calls } = recordWith(answer);
    assertEquals(await outcome, { status: "unconfirmed" }, label);
    assertEquals(calls.length, 1, label);
  }
});

Deno.test("a write that failed in transport is never replayed", async () => {
  const { outcome, calls } = recordWith(() => {
    throw new Error("the request was aborted");
  });

  assertEquals(await outcome, { status: "unconfirmed" });
  assertEquals(calls.length, 1);
});
