import { assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { OpeninaryVideoError } from "./openinaryVideoTransform.ts";
import { identifyVideoCaller } from "./videoCaller.ts";

const req = new Request("https://example.test", { method: "POST" });
const signedInAs = (userId: string) => () => Promise.resolve({ userId });
const rejected = () => Promise.reject(new Error("Unauthorized: invalid or expired token"));

Deno.test("identity is the authenticated user, never the body's claim", async () => {
  assertEquals(await identifyVideoCaller(req, undefined, signedInAs("u1")), "u1");
  assertEquals(await identifyVideoCaller(req, "u1", signedInAs("u1")), "u1");
});

Deno.test("a body user_id that is not the caller is forbidden", async () => {
  const error = await assertRejects(() => identifyVideoCaller(req, "victim", signedInAs("attacker")), OpeninaryVideoError);
  assertEquals(error.code, "FORBIDDEN");
  assertEquals(error.status, 403);
});

Deno.test("a missing or invalid token is unauthorized, with a message that reveals nothing", async () => {
  const error = await assertRejects(() => identifyVideoCaller(req, "u1", rejected), OpeninaryVideoError);
  assertEquals(error.code, "UNAUTHORIZED");
  assertEquals(error.status, 401);
});

Deno.test("authentication is asked without a body user id, so a service-role bearer is refused", async () => {
  let asked: string | null | undefined = "unset";
  await identifyVideoCaller(req, "u1", (_req, bodyUserId) => { asked = bodyUserId; return Promise.resolve({ userId: "u1" }); });
  assertEquals(asked, null);
});
