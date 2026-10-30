import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { SVIX_TOLERANCE_SECONDS, verifySvixSignature } from "./svixSignature.ts";

const SIGNING = "whsec_" + btoa("fixture-signing-bytes-0123456789");
const NOW = 1_800_000_000_000;
const TS = String(NOW / 1000);
const BODY = JSON.stringify({ type: "email.received", data: { email_id: "e-1" } });

async function sign(id: string, ts: string, body: string, secret = SIGNING): Promise<string> {
  const bytes = Uint8Array.from(atob(secret.slice(6)), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("raw", bytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${ts}.${body}`));
  return btoa(String.fromCharCode(...new Uint8Array(mac)));
}

Deno.test("a correctly signed delivery is accepted, also when it lists several signatures", async () => {
  const good = await sign("msg_1", TS, BODY);
  assertEquals(await verifySvixSignature(BODY, { svixId: "msg_1", svixTimestamp: TS, svixSignature: `v1,${good}` }, SIGNING, NOW), { ok: true });
  const listed = `v1,${btoa("not-it")} v1,${good}`;
  assertEquals(await verifySvixSignature(BODY, { svixId: "msg_1", svixTimestamp: TS, svixSignature: listed }, SIGNING, NOW), { ok: true });
});

Deno.test("a fresh timestamp alone is never enough: a wrong signature, body or secret is refused", async () => {
  const good = await sign("msg_1", TS, BODY);
  const refused = { ok: false, reason: "no_match" } as const;
  assertEquals(await verifySvixSignature(BODY, { svixId: "msg_1", svixTimestamp: TS, svixSignature: `v1,${btoa("forged")}` }, SIGNING, NOW), refused);
  assertEquals(await verifySvixSignature(BODY + " ", { svixId: "msg_1", svixTimestamp: TS, svixSignature: `v1,${good}` }, SIGNING, NOW), refused);
  assertEquals(await verifySvixSignature(BODY, { svixId: "msg_2", svixTimestamp: TS, svixSignature: `v1,${good}` }, SIGNING, NOW), refused);
  const other = "whsec_" + btoa("another-fixture-signing-bytes!!");
  assertEquals(await verifySvixSignature(BODY, { svixId: "msg_1", svixTimestamp: TS, svixSignature: `v1,${good}` }, other, NOW), refused);
  assertEquals(await verifySvixSignature(BODY, { svixId: "msg_1", svixTimestamp: TS, svixSignature: `v2,${good}` }, SIGNING, NOW), refused);
});

Deno.test("missing headers, a malformed or stale timestamp and an unusable secret are refused", async () => {
  const good = await sign("msg_1", TS, BODY);
  assertEquals(await verifySvixSignature(BODY, { svixId: null, svixTimestamp: TS, svixSignature: `v1,${good}` }, SIGNING, NOW), { ok: false, reason: "missing_headers" });
  assertEquals(await verifySvixSignature(BODY, { svixId: "msg_1", svixTimestamp: "soon", svixSignature: `v1,${good}` }, SIGNING, NOW), { ok: false, reason: "bad_timestamp" });
  const old = String(NOW / 1000 - SVIX_TOLERANCE_SECONDS - 1);
  const oldSig = await sign("msg_1", old, BODY);
  assertEquals(await verifySvixSignature(BODY, { svixId: "msg_1", svixTimestamp: old, svixSignature: `v1,${oldSig}` }, SIGNING, NOW), { ok: false, reason: "stale_timestamp" });
  assertEquals(await verifySvixSignature(BODY, { svixId: "msg_1", svixTimestamp: TS, svixSignature: `v1,${good}` }, "whsec_%%%", NOW), { ok: false, reason: "bad_secret" });
});
