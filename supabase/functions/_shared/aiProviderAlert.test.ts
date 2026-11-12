// deno-lint-ignore-file no-import-prefix
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  alertRowsToDegraded,
  buildAlertHtml,
  buildAlertMessage,
  buildAlertTitle,
  sendDegradedProviderAlert,
  type AdminMailer,
} from "./aiProviderAlert.ts";

Deno.test("the title names the provider", () => {
  assertEquals(
    buildAlertTitle({ provider_code: "claude", auth_method: "oauth", status: "needs_relogin", reason: null }),
    "AI provider needs attention: claude",
  );
});

Deno.test("the message names the credential kind and the sanitized reason", () => {
  assertEquals(
    buildAlertMessage({ provider_code: "claude", auth_method: "oauth", status: "needs_relogin", reason: "The subscription sign-in expired. Sign in again." }),
    "claude (subscription) needs re-login: The subscription sign-in expired. Sign in again.",
  );
});

Deno.test("a null reason still produces a readable message", () => {
  const message = buildAlertMessage({ provider_code: "openrouter", auth_method: "api_key", status: "failed", reason: null });
  assert(message.includes("openrouter"));
  assert(message.includes("API key"));
});

Deno.test("the claim rows become degraded providers", () => {
  const rows = alertRowsToDegraded([
    { provider_code: "claude", auth_method: "oauth", status: "needs_relogin", reason: "x", previous_status: "connected" },
  ]);
  assertEquals(rows.length, 1);
  assertEquals(rows[0].auth_method, "oauth");
});

Deno.test("the alert reaches the admins and nobody else", async () => {
  const sent: Array<{ to: string[]; subject: string; html: string }> = [];
  const mailer: AdminMailer = {
    adminRecipients: async () => ["ops@example.com", "second@example.com"],
    send: async (to, subject, html) => { sent.push({ to, subject, html }); },
  };
  await sendDegradedProviderAlert(mailer, {
    provider_code: "openrouter",
    auth_method: "api_key",
    status: "failed",
    reason: "Invalid API key",
  });
  assertEquals(sent.length, 1);
  assertEquals(sent[0].to, ["ops@example.com", "second@example.com"]);
  assertEquals(sent[0].subject, "AI provider needs attention: openrouter");
});

Deno.test("with no admin address there is nobody to tell and nothing is sent", async () => {
  let sent = false;
  const mailer: AdminMailer = {
    adminRecipients: async () => [],
    send: async () => { sent = true; },
  };
  await sendDegradedProviderAlert(mailer, {
    provider_code: "openrouter",
    auth_method: "api_key",
    status: "failed",
    reason: null,
  });
  assertEquals(sent, false);
});

Deno.test("the html names the provider, the credential kind and the reason", () => {
  const html = buildAlertHtml([
    { provider_code: "openrouter", auth_method: "api_key", status: "failed", reason: "Invalid API key" },
  ]);
  assert(html.includes("openrouter"));
  assert(html.includes("API key"));
  assert(html.includes("Invalid API key"));
  assert(html.includes("Failed"));
});
