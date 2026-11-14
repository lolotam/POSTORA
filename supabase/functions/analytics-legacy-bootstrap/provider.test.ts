import { assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { BootstrapFailure, verifyLegacyAuthority } from "./provider.ts";

const token = () => ["synthetic", crypto.randomUUID()].join("-");
const capture = () => ({ token: token(), login_kind: "page_linked" as const, platform: "instagram" as const,
  platform_user_id: "178001", page_id: "100001", provider_user_id: null });
const app = { id: "200001", secret: token() };
function provider(responses: unknown[]): typeof fetch {
  return async () => Response.json(responses.shift());
}
function validResponses(): unknown[] {
  return [{ data: { is_valid: true, type: "USER", app_id: app.id, user_id: "300001",
    expires_at: Math.floor(Date.now() / 1000) + 3600, data_access_expires_at: Math.floor(Date.now() / 1000) + 3600 } },
    { id: "300001" }, { data: [{ id: "100001" }] }, { id: "100001", instagram_business_account: { id: "178001" } }];
}
Deno.test("legacy Page token is never installed as a User grant; wrong app and wrong identities refuse", async () => {
  for (const mutation of ["type", "app_id", "user_id", "page", "instagram"] as const) {
    const replies = validResponses();
    if (mutation === "page") replies[2] = { data: [{ id: "100002" }] };
    else if (mutation === "instagram") replies[3] = { id: "100001", instagram_business_account: { id: "178002" } };
    else (replies[0] as { data: Record<string, unknown> }).data[mutation] = "wrong";
    await assertRejects(() => verifyLegacyAuthority({ capture: capture(), app, fetcher: provider(replies),
      deadline: Date.now() + 10_000, beforeRequest: async () => {} }), BootstrapFailure);
  }
});
Deno.test("complete same-owner Page and linked IG proof returns identifiers only", async () => {
  const verified = await verifyLegacyAuthority({ capture: capture(), app, fetcher: provider(validResponses()),
    deadline: Date.now() + 10_000, beforeRequest: async () => {} });
  assertEquals(verified.provider_user_id, "300001");
  assertEquals(verified.instagram_user_id, "178001");
  assertEquals(Object.hasOwn(verified, "token"), false);
});
Deno.test("partial or foreign-host Page pagination cannot establish authority", async () => {
  for (const next of ["https://evil.invalid/me/accounts", "https://graph.facebook.com/v22.0/me/accounts?after=x",
    "https://graph.facebook.com/v22.0/me/feed?after=x&fields=access_token"]) {
    const replies = validResponses();
    const requested: URL[] = [];
    replies[2] = { data: [{ id: "100001" }], paging: { next, cursors: { after: "x" } } };
    replies.splice(3, 0, { data: [], paging: { next, cursors: { after: "x" } } });
    await assertRejects(() => verifyLegacyAuthority({ capture: capture(), app, fetcher: async (request) => {
      requested.push(new URL(String(request)));
      return Response.json(replies.shift());
    },
      deadline: Date.now() + 10_000, beforeRequest: async () => {} }), BootstrapFailure);
    assertEquals(requested.length >= 3, true);
    for (const url of requested) {
      assertEquals(url.origin, "https://graph.facebook.com");
      assertEquals(["/v22.0/debug_token", "/v22.0/me", "/v22.0/me/accounts"].includes(url.pathname), true);
      if (url.pathname.endsWith("/accounts")) assertEquals(url.searchParams.get("fields"), "id");
    }
  }
});

Deno.test("legacy direct identity uses the Instagram host and requires supported reconnect when app proof is unavailable", async () => {
  let calls = 0;
  const direct = { ...capture(), login_kind: "direct" as const, page_id: null };
  const error = await assertRejects(() => verifyLegacyAuthority({ capture: direct, app, deadline: Date.now() + 10_000,
    beforeRequest: async () => {}, fetcher: async (request) => {
      calls++;
      assertEquals(new URL(String(request)).hostname, "graph.instagram.com");
      return Response.json({ id: "178001", user_id: "178001" });
    } }), BootstrapFailure);
  assertEquals((error as BootstrapFailure).reason, "direct_verification_unsupported");
  assertEquals(calls, 1);
});

Deno.test("invalid token, permission denial, foreign app and throttling keep distinct sanitized reasons", async () => {
  for (const [response, status, expected] of [
    [{ data: { is_valid: false } }, 200, "token_invalid"],
    [{ error: { code: 190 } }, 400, "token_invalid"],
    [{ error: { code: 200 } }, 403, "permission_missing"],
    [{ error: { code: 100, message: "token did not match the viewing app" } }, 500, "app_mismatch"],
    [{ error: { code: 4 } }, 429, "rate_limited"],
  ] as const) {
    const error = await assertRejects(() => verifyLegacyAuthority({ capture: capture(), app, deadline: Date.now() + 1000,
      beforeRequest: async () => {}, fetcher: async () => Response.json(response, { status }) }), BootstrapFailure);
    assertEquals((error as BootstrapFailure).reason, expected);
    assertEquals(error.message, expected);
  }
});
Deno.test("Page enumeration must complete within four pages even when the exact Page appeared first", async () => {
  const replies = validResponses().slice(0, 2);
  for (let page = 0; page < 4; page++) replies.push({ data: [{ id: String(100001 + page) }],
    paging: { next: "https://graph.facebook.com/v22.0/me/accounts", cursors: { after: `page_${page}` } } });
  let requests = 0;
  await assertRejects(() => verifyLegacyAuthority({ capture: capture(), app, deadline: Date.now() + 1000,
    beforeRequest: async () => { requests++; }, fetcher: provider(replies) }), BootstrapFailure);
  assertEquals(requests, 6);
});
Deno.test("provider headers and body share the request deadline even if a fetcher ignores cancellation", async () => {
  const started = Date.now();
  await assertRejects(() => verifyLegacyAuthority({ capture: capture(), app, deadline: started + 30,
    beforeRequest: async () => {}, fetcher: () => new Promise(() => {}) }), BootstrapFailure);
  assertEquals(Date.now() - started < 500, true);
});
