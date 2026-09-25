// deno-lint-ignore-file no-import-prefix
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { describeProviderFailure, isBillingBlocked } from "./providerErrors.ts";

Deno.test("gateway billing block reads as a valid key that needs a card", () => {
  const body = JSON.stringify({ error: { type: "customer_verification_required", message: "AI Gateway requires a valid credit card" } });
  assertEquals(describeProviderFailure("Vercel AI Gateway", 403, body),
    "Key is valid — add a credit card to your Vercel team (AI Gateway) to enable requests");
});

Deno.test("isBillingBlocked recognises only the gateway verification 403", () => {
  assertEquals(isBillingBlocked(403, '{"error":{"type":"customer_verification_required"}}'), true);
  assertEquals(isBillingBlocked(403, '{"error":{"type":"forbidden"}}'), false);
  assertEquals(isBillingBlocked(401, "customer_verification_required"), false);
});

Deno.test("401 and generic 403 keep their existing messages", () => {
  assertEquals(describeProviderFailure("X", 401, "{}"), "Invalid API key");
  assertEquals(describeProviderFailure("X", 403, "{}"), "API key lacks required permissions");
});

Deno.test("429 balance errors and JSON messages are surfaced", () => {
  assertEquals(describeProviderFailure("X", 429, "insufficient_balance"),
    "API key is valid, but the account has insufficient balance. Please top up your account.");
  assertEquals(describeProviderFailure("X", 429, "{}"), "Rate limit exceeded");
  assertEquals(describeProviderFailure("X", 400, JSON.stringify({ error: { message: "bad model" } })), "X: bad model");
  assertEquals(describeProviderFailure("X", 500, "<html>"), "X API error: 500");
});

Deno.test("a 403 for exhausted credits says the key is valid, not that it lacks permissions", () => {
  const body = JSON.stringify({ code: "permission-denied", error: "Your team t1 has either used all available credits or reached its monthly spending limit." });
  assertEquals(describeProviderFailure("xAI", 403, body),
    "API key is valid, but the account has used its credits or reached its spending limit. Please top up your account.");
});
