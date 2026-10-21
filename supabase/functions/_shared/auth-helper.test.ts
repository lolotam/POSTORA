import { assertEquals, assertRejects } from "jsr:@std/assert@1";

const SERVICE_KEY = "test-service-role-key-not-a-real-secret";
Deno.env.set("SUPABASE_URL", "http://127.0.0.1:9");
Deno.env.set("SUPABASE_ANON_KEY", "test-anon-key");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", SERVICE_KEY);
const { serviceRoleCallerUserId } = await import("./auth-helper.ts");

const USER_ID = "8f14e45f-ceea-4e7a-9b1c-2d3e4f5a6b7c";

function request(authorization: string | null, body: unknown): Request {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (authorization !== null) headers.set("Authorization", authorization);
  return new Request("http://localhost/fn", { method: "POST", headers, body: JSON.stringify(body) });
}

Deno.test("a service-role call returns the user_id from the body", async () => {
  const req = request(`Bearer ${SERVICE_KEY}`, { user_id: USER_ID, action: "x" });

  assertEquals(await serviceRoleCallerUserId(req), USER_ID);
  // The body was read from a clone, so the handler can still parse it itself.
  assertEquals(await req.json(), { user_id: USER_ID, action: "x" });
});

Deno.test("a non-service bearer returns null without reading the body", async () => {
  const req = request("Bearer some.user.jwt", { user_id: USER_ID });

  assertEquals(await serviceRoleCallerUserId(req), null);
  assertEquals(req.bodyUsed, false);
});

Deno.test("a missing Authorization header returns null", async () => {
  const req = request(null, { user_id: USER_ID });

  assertEquals(await serviceRoleCallerUserId(req), null);
});

Deno.test("a service-role call without user_id is rejected", async () => {
  const req = request(`Bearer ${SERVICE_KEY}`, { action: "x" });

  await assertRejects(() => serviceRoleCallerUserId(req));
});

Deno.test("a service-role call with a non-UUID user_id is rejected", async () => {
  const req = request(`Bearer ${SERVICE_KEY}`, { user_id: "not-a-uuid" });

  await assertRejects(() => serviceRoleCallerUserId(req));
});

Deno.test("a service-role call with a non-JSON body is rejected", async () => {
  const req = new Request("http://localhost/fn", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${SERVICE_KEY}` },
    body: "not json",
  });

  await assertRejects(() => serviceRoleCallerUserId(req));
});
