import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { signJobToken, verifyJobToken, type JobTokenPayload } from "./aiImageToken.ts";

const SECRET = "test-signing-key";
const NOW = 1_800_000_000_000;
const HOUR = 60 * 60 * 1000;

const payload: JobTokenPayload = {
  prediction: "pred-1",
  staged: "postora.cloud/postora/user-a/ai-tmp/x.png",
  operation: "upscale",
  area: "upscaled",
  issuedAt: NOW,
  meta: { scale: 4, target_resolution: "4k", original_url: null },
};

const verify = (token: string, over: Partial<Parameters<typeof verifyJobToken>[0]> = {}) =>
  verifyJobToken({ secret: SECRET, userId: "user-a", token, maxAgeMs: HOUR, now: NOW + 1000, ...over });

Deno.test("a token verifies for the user it was issued to and returns what it carries", async () => {
  const token = await signJobToken(SECRET, "user-a", payload);
  assertEquals(await verify(token), { ok: true, payload });
});

Deno.test("another user cannot redeem it", async () => {
  const token = await signJobToken(SECRET, "user-a", payload);
  assertEquals(await verify(token, { userId: "user-b" }), { ok: false, reason: "forged" });
});

Deno.test("a token signed with another secret is forged", async () => {
  const token = await signJobToken("another-signing-key", "user-a", payload);
  assertEquals(await verify(token), { ok: false, reason: "forged" });
});

Deno.test("changing the payload (e.g. pointing at another prediction or file) breaks the signature", async () => {
  const token = await signJobToken(SECRET, "user-a", payload);
  const [, mac] = token.split(".");
  const tampered = btoa(JSON.stringify({ ...payload, prediction: "pred-2" })).replace(/=+$/, "");
  assertEquals(await verify(`${tampered}.${mac}`), { ok: false, reason: "forged" });
  const other = await signJobToken(SECRET, "user-a", { ...payload, staged: "postora.cloud/postora/user-b/ai-tmp/y.png" });
  assertEquals(await verify(`${other.split(".")[0]}.${mac}`), { ok: false, reason: "forged" });
});

Deno.test("garbage is malformed, not an error", async () => {
  for (const token of ["", "abc", "a.b.c", ".", "a.", ".b", "%%%.%%%"]) {
    const result = await verify(token);
    assertEquals(result.ok, false, token);
    assertEquals(result.ok === false && ["malformed", "forged"].includes(result.reason), true, token);
  }
});

Deno.test("an old token is expired, and still hands back its payload so the staged input can be removed", async () => {
  const token = await signJobToken(SECRET, "user-a", payload);
  assertEquals(await verify(token, { now: NOW + HOUR + 1 }), { ok: false, reason: "expired", payload });
  assertEquals((await verify(token, { now: NOW + HOUR })).ok, true);
});
