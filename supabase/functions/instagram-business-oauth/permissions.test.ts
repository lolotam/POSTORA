import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { MetaOAuthReceipt } from "../_shared/metaOAuthAttemptStore.ts";
import { refreshPageLinkedInstagramPermissions } from "./permissions.ts";

const START = "2026-11-02T10:00:00.000Z";
const receipt: MetaOAuthReceipt = {
  attemptId: "attempt", selectionKey: "instagram_page_linked:ig:ig", flow: "instagram_page_linked", intent: "reconnect",
  platform: "instagram", platformUserId: "ig", instagramUserId: "ig", facebookPageId: "page", facebookUserId: "fb",
  socialAccountId: "account", companionSocialAccountId: null, username: "synthetic", operation: "reconnected", loginKind: "page_linked",
  credentialId: "credential", credentialRevision: 3, connectionVersion: 2, capabilityGeneration: 7, committedAt: "2026-11-02T09:59:59Z",
};

function fixture(options: {
  credential?: Record<string, unknown>;
  response?: (url: URL, index: number) => Response | Promise<Response>;
  writer?: (payload: Record<string, unknown>) => unknown;
} = {}) {
  const writes: Record<string, unknown>[] = [];
  const requests: URL[] = [];
  const rpc = async (name: string, args: Record<string, unknown>) => {
    if (args.p_user_id !== "owner" || args.p_social_account_id !== "account") throw new Error("Unexpected RPC ownership");
    if (name === "read_facebook_user_account_credential") return { error: null, data: {
      found: true, social_account_id: "account", platform: "instagram", credential_id: "credential", credential_kind: "facebook_user",
      token: "synthetic-user-token", token_expires_at: null, revision: 3, capability_generation: 7, connection_version: 2,
      ...options.credential,
    } };
    if (name !== "write_instagram_account_capability") throw new Error("Unexpected RPC");
    const payload = args.p_payload as Record<string, unknown>;
    writes.push(payload);
    return options.writer ? options.writer(payload) : { error: null, data: {
      social_account_id: "account", capability_present: true, login_kind: "page_linked",
      permission_read_state: payload.permission_read_state, scopes_authoritative: payload.permission_read_state === "ok",
      granted_scopes: payload.granted_scopes ?? [], scopes_read_at: payload.scopes_read_at ?? null,
      last_read_failed_at: payload.read_failed_at ?? null, last_read_error_code: payload.read_error_code ?? null,
      credential_generation: 7, credential_updated_at: "2026-11-02T09:59:59Z", generation_reason: "oauth_lifecycle_commit",
      reconnected_at: "2026-11-02T09:59:59Z", has_protected_credential: false, updated_at: START,
    } };
  };
  const fetcher: typeof fetch = async (input) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    assertEquals(url.origin, "https://graph.facebook.com");
    assertEquals(url.pathname, "/v22.0/me/permissions");
    assertEquals(url.searchParams.get("access_token"), "synthetic-user-token");
    requests.push(url);
    return options.response?.(url, requests.length - 1) ?? Response.json({ data: [{ permission: "instagram_manage_insights", status: "granted" }] });
  };
  return { writes, requests, run: () => refreshPageLinkedInstagramPermissions({ userId: "owner", receipt, rpc, fetcher, now: () => new Date(START) }) };
}

Deno.test("a protected reconnect reads actual grants and persists the captured generation and read-start evidence", async () => {
  const test = fixture();
  assertEquals(await test.run(), { status: "ok", insights_granted: true });
  assertEquals(test.writes, [{ login_kind: "page_linked", expected_credential_generation: 7,
    permission_read_state: "ok", granted_scopes: ["instagram_manage_insights"], scopes_read_at: START }]);
});

Deno.test("an empty or explicitly denied successful permission read is authoritative denial", async () => {
  for (const data of [[], [{ permission: "instagram_manage_insights", status: "declined" }], [{ permission: "instagram_manage_insights", status: "expired" }]]) {
    const test = fixture({ response: () => Response.json({ data }) });
    assertEquals(await test.run(), { status: "ok", insights_granted: false });
    assertEquals(test.writes[0].granted_scopes, []);
    assertEquals(test.writes[0].permission_read_state, "ok");
  }
});

Deno.test("permission pagination reconstructs the trusted URL and never follows a supplied next URL", async () => {
  const test = fixture({ response: (url, index) => index === 0 ? Response.json({
    data: [{ permission: "instagram_basic", status: "granted" }],
    paging: { next: "https://never-follow.invalid/private", cursors: { after: "page_2" } },
  }) : Response.json({ data: [{ permission: "instagram_manage_insights", status: "granted" }] }) });
  assertEquals(await test.run(), { status: "ok", insights_granted: true });
  assertEquals(test.requests.map((url) => url.searchParams.get("after")), [null, "page_2"]);
  assertEquals(test.writes[0].granted_scopes, ["instagram_basic", "instagram_manage_insights"]);
});

Deno.test("failed, malformed, oversized and incomplete provider reads record failure rather than empty grants", async () => {
  const responses = [
    () => Response.json({ error: { code: 190, message: "provider-secret" } }, { status: 400 }),
    () => Response.json({}),
    () => Response.json({ data: [{ permission: "instagram_manage_insights", status: "unexpected" }] }),
    () => Response.json({ data: [{ permission: "instagram_manage_insights", status: ["granted"] }] }),
    () => Response.json({ data: [{ permission: "instagram_basic", status: "granted" }], paging: { next: "https://untrusted.invalid" } }),
    () => new Response(" ".repeat(65_537)),
    () => { throw new TypeError("private-network-error"); },
  ];
  for (const response of responses) {
    const test = fixture({ response });
    assertEquals(await test.run(), { status: "failed" });
    assertEquals(test.writes, [{ login_kind: "page_linked", expected_credential_generation: 7,
      permission_read_state: "failed", read_failed_at: START, read_error_code: "permission_read_failed" }]);
  }
});

Deno.test("a missing or moved protected authority refuses before any provider request or capability write", async () => {
  for (const credential of [{ found: false }, { revision: 4 }, { capability_generation: 8 }, { connection_version: 3 }, { credential_id: "other" }, { platform: "facebook" }]) {
    const test = fixture({ credential });
    assertEquals(await test.run(), { status: "stale" });
    assertEquals(test.requests, []);
    assertEquals(test.writes, []);
  }
});

Deno.test("a late result retains the captured generation and never retries a stale capability write", async () => {
  for (const code of ["ICG01", "ICG02"]) {
    const test = fixture({ writer: () => ({ data: null, error: { code, message: "private-sql-error" } }) });
    assertEquals(await test.run(), { status: "stale" });
    assertEquals(test.writes.length, 1);
    assertEquals(test.writes[0].expected_credential_generation, 7);
  }
});

Deno.test("an ambiguous capability write cannot confirm usable insights or replay the account commit", async () => {
  for (const writer of [() => ({ data: {} }), () => ({ data: null, error: null }), () => ({ data: {}, error: null }), () => { throw new Error("private-sql-error"); }]) {
    const test = fixture({ writer });
    assertEquals(await test.run(), { status: "unconfirmed" });
    assertEquals(test.writes.length, 1);
  }
});

Deno.test("duplicate and over-budget permission pages never publish a partial grant", async () => {
  for (const duplicate of [true, false]) {
    const test = fixture({ response: (_url, index) => Response.json({
      data: [{ permission: duplicate ? "instagram_basic" : `scope_${index}`, status: "granted" }],
      paging: { next: "https://untrusted.invalid", cursors: { after: `page_${index + 1}` } },
    }) });
    assertEquals(await test.run(), { status: "failed" });
    assertEquals(test.requests.length, duplicate ? 2 : 4);
    assertEquals(test.writes[0].granted_scopes, undefined);
  }
});
