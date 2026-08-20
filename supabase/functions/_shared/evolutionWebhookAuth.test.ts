import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { verifyEvolutionWebhookToken } from "./evolutionWebhookAuth.ts";

function encode(value: unknown): string {
  return btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function signedToken(key: string, payload: Record<string, unknown>): Promise<string> {
  const header = encode({ alg: "HS256", typ: "JWT" });
  const body = encode(payload);
  const signingInput = `${header}.${body}`;
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(signingInput));
  const encodedSignature = btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${signingInput}.${encodedSignature}`;
}

Deno.test("Evolution webhook auth accepts a signed, unexpired webhook token", async () => {
  const key = crypto.randomUUID();
  const token = await signedToken(key, { iat: 100, exp: 200, app: "evolution", action: "webhook" });
  assertEquals(await verifyEvolutionWebhookToken(token, key, 150), true);
});

Deno.test("Evolution webhook auth rejects invalid claims, expiry, and signatures", async () => {
  const key = crypto.randomUUID();
  const cases = [
    { iat: 100, exp: 200, app: "other", action: "webhook" },
    { iat: 100, exp: 150, app: "evolution", action: "webhook" },
    { iat: 100, exp: 200, app: "evolution", action: "webhook" },
  ];
  const valid = await signedToken(key, cases[2]);
  const tampered = `${valid.split(".")[0]}.${encode({ iat: 100, exp: 200, app: "evolution", action: "tampered" })}.${valid.split(".")[2]}`;
  assertEquals(await verifyEvolutionWebhookToken(await signedToken(key, cases[0]), key, 150), false);
  assertEquals(await verifyEvolutionWebhookToken(await signedToken(key, cases[1]), key, 150), false);
  assertEquals(await verifyEvolutionWebhookToken(tampered, key, 150), false);
});
