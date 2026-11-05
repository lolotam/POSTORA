import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { decideDisconnect, revokeFacebookGrant, type DisconnectPorts } from "./disconnect.ts";

const APP = { appId: "123", appSecret: "app-secret-must-not-leak" };
const ACCOUNT = "a0000000-0000-4000-8000-000000000001";
const CREDENTIAL = "c0000000-0000-4000-8000-000000000001";

function ports(overrides: Partial<DisconnectPorts>, calls: Request[] = []): DisconnectPorts {
  return {
    readBinding: async () => ({ credential_id: CREDENTIAL }),
    countGrantMembers: async () => 1,
    readProviderUserId: async () => "fb-user-9",
    fetch: async (input, init) => {
      calls.push(new Request(input, init));
      return Response.json(true);
    },
    ...overrides,
  };
}

Deno.test("revoke sends DELETE /{facebook-user-id}/permissions with the app access token only", async () => {
  const calls: Request[] = [];
  const revoked = await revokeFacebookGrant(async (input, init) => { calls.push(new Request(input, init)); return Response.json(true); }, APP, "fb-user-9");
  assertEquals(revoked, true);
  assertEquals(calls.length, 1);
  assertEquals(calls[0].method, "DELETE");
  const url = new URL(calls[0].url);
  assertEquals(url.origin + url.pathname, "https://graph.facebook.com/v22.0/fb-user-9/permissions");
  assertEquals(url.searchParams.get("access_token"), "123|app-secret-must-not-leak");
});

Deno.test("a Graph refusal or a non-true body is a failed revoke, not a thrown error", async () => {
  for (const reply of [() => Response.json({ error: { code: 100 } }, { status: 400 }), () => Response.json(false), () => { throw new TypeError("network"); }]) {
    const revoked = await revokeFacebookGrant(async () => reply(), APP, "fb-user-9");
    assertEquals(revoked, false);
  }
});

Deno.test("an account without a binding is removed without any Graph call", async () => {
  const calls: Request[] = [];
  const outcome = await decideDisconnect(ports({ readBinding: async () => null }, calls), APP, ACCOUNT);
  assertEquals(outcome, { revoked: false, reason: "no_binding" });
  assertEquals(calls, []);
});

Deno.test("a grant with no member left is removed without any Graph call", async () => {
  const calls: Request[] = [];
  const outcome = await decideDisconnect(ports({ countGrantMembers: async () => 0 }, calls), APP, ACCOUNT);
  assertEquals(outcome, { revoked: false, reason: "no_binding" });
  assertEquals(calls, []);
});

Deno.test("a grant shared with a sibling account is left alone", async () => {
  const calls: Request[] = [];
  const outcome = await decideDisconnect(ports({ countGrantMembers: async () => 2 }, calls), APP, ACCOUNT);
  assertEquals(outcome, { revoked: false, reason: "grant_shared" });
  assertEquals(calls, []);
});

Deno.test("the last member of a grant de-authorizes the app", async () => {
  const calls: Request[] = [];
  const outcome = await decideDisconnect(ports({}, calls), APP, ACCOUNT);
  assertEquals(outcome, { revoked: true, reason: null });
  assertEquals(calls.length, 1);
  assertEquals(new URL(calls[0].url).pathname, "/v22.0/fb-user-9/permissions");
});

Deno.test("a credential without a provider user id cannot be revoked and says so", async () => {
  const outcome = await decideDisconnect(ports({ readProviderUserId: async () => null }), APP, ACCOUNT);
  assertEquals(outcome, { revoked: false, reason: "credential_missing" });
});

Deno.test("a failed Graph revoke is reported, the removal still proceeds", async () => {
  const outcome = await decideDisconnect(ports({ fetch: async () => Response.json({ error: {} }, { status: 500 }) }), APP, ACCOUNT);
  assertEquals(outcome, { revoked: false, reason: "revoke_failed" });
});
