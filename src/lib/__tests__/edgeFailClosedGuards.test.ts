import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";

const sources = {
  verifyMfaReset: "supabase/functions/verify-mfa-reset/index.ts",
  stripeWebhook: "supabase/functions/stripe-webhook/index.ts",
  tiktokWebhook: "supabase/functions/tiktok-webhook/index.ts",
  tiktokWebhookHandler: "supabase/functions/tiktok-webhook/handler.ts",
  whatsappWebhook: "supabase/functions/whatsapp-webhook/index.ts",
} as const;

function readSource(relativePath: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), relativePath), "utf8");
}

it("verify-mfa-reset has no always-true TOTP verifier", () => {
  expect(readSource(sources.verifyMfaReset)).not.toMatch(
    /function\s+verifyTOTPCode[\s\S]*?return\s+true/,
  );
});

it("verify-mfa-reset has no format-only 6-digit code fallback", () => {
  expect(readSource(sources.verifyMfaReset)).not.toContain("/^\\d{6}$/");
});

it("verify-mfa-reset cannot update users", () => {
  expect(readSource(sources.verifyMfaReset)).not.toContain("updateUserById");
});

it("verify-mfa-reset does not disclose a missing user", () => {
  expect(readSource(sources.verifyMfaReset)).not.toContain("User not found");
});

it("verify-mfa-reset does not disclose missing MFA enrollment", () => {
  expect(readSource(sources.verifyMfaReset)).not.toContain(
    "does not have MFA enabled",
  );
});

it("stripe-webhook requires its signing secret", () => {
  expect(readSource(sources.stripeWebhook)).toContain("STRIPE_WEBHOOK_SECRET");
});

it("stripe-webhook constructs events through Stripe verification", () => {
  expect(readSource(sources.stripeWebhook)).toContain(
    "stripe.webhooks.constructEvent",
  );
});

it("stripe-webhook never parses the raw body as unsigned JSON", () => {
  expect(readSource(sources.stripeWebhook)).not.toContain("JSON.parse(body)");
});

it("stripe-webhook never parses a request directly as unsigned JSON", () => {
  expect(readSource(sources.stripeWebhook)).not.toMatch(/JSON\.parse\(await\s+req/);
});

it("stripe-webhook has no development signature bypass", () => {
  expect(readSource(sources.stripeWebhook)).not.toContain("Development mode");
});

it("tiktok-webhook reads the configured webhook secret", () => {
  expect(readSource(sources.tiktokWebhook)).toContain("TIKTOK_WEBHOOK_SECRET");
});

it("tiktok-webhook checks the Authorization header", () => {
  expect(readSource(sources.tiktokWebhookHandler)).toMatch(
    /headers\.get\(["']Authorization["']\)/i,
  );
});

it("tiktok-webhook does not serialize the full request body into logs", () => {
  expect(readSource(sources.tiktokWebhook)).not.toContain("JSON.stringify(body");
  expect(readSource(sources.tiktokWebhookHandler)).not.toContain("JSON.stringify(body");
});

it("whatsapp-webhook reads the Meta signature header", () => {
  expect(readSource(sources.whatsappWebhook)).toContain("x-hub-signature-256");
});

it("whatsapp-webhook computes an HMAC SHA-256 signature", () => {
  expect(readSource(sources.whatsappWebhook)).toMatch(
    /crypto\.subtle[\s\S]*?HMAC[\s\S]*?SHA-256/,
  );
});

it("whatsapp-webhook reads the raw request body once", () => {
  expect(readSource(sources.whatsappWebhook).match(/req\.text\(\)/g)).toHaveLength(1);
});

it("whatsapp-webhook processing catch does not acknowledge fake success", () => {
  const source = readSource(sources.whatsappWebhook);
  // Heuristic: the named POST-processing catch must not return success nearby.
  expect(source).not.toMatch(
    /catch\s*(?:\([^)]*\))?\s*\{[\s\S]{0,150}Webhook processing failed[\s\S]{0,300}success: true/,
  );
});
