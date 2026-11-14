// deno-lint-ignore-file no-import-prefix
import { assert, assertEquals, assertRejects } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  alertRowsToDegraded,
  buildAlertHtml,
  buildAlertMessage,
  buildAlertTitle,
  sendDegradedProviderAlert,
  type AdminMailer,
} from "./aiProviderAlert.ts";

const TITLE_CASES: Array<[string, string]> = [
  ["Anthropic", "AI provider needs attention: Anthropic"],
  ["", "AI provider needs attention: claude"],
];

Deno.test("the title names the provider, not its code", () => {
  for (const [displayName, expected] of TITLE_CASES) {
    assertEquals(
      buildAlertTitle({
        provider_code: "claude",
        display_name: displayName,
        auth_method: "oauth",
        status: "needs_relogin",
        reason: null,
        alert_id: null,
      }),
      expected,
    );
  }
});

Deno.test("the message names the credential kind and the sanitized reason", () => {
  assertEquals(
    buildAlertMessage({
      provider_code: "claude",
      display_name: "Anthropic",
      auth_method: "oauth",
      status: "needs_relogin",
      reason: "The subscription sign-in expired. Sign in again.",
      alert_id: null,
    }),
    "Anthropic (subscription) is needs re-login: The subscription sign-in expired. Sign in again.",
  );
});

Deno.test("a null reason still produces a readable message", () => {
  const message = buildAlertMessage({
    provider_code: "openrouter",
    display_name: "OpenRouter",
    auth_method: "api_key",
    status: "failed",
    reason: null,
    alert_id: null,
  });
  assert(message.includes("OpenRouter"));
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
  const sent: Array<{ to: string[]; subject: string; html: string; text?: string }> = [];
  const mailer: AdminMailer = {
    adminRecipients: async () => ["ops@example.com", "second@example.com"],
    send: async (message) => { sent.push(message); },
  };
  await sendDegradedProviderAlert(mailer, {
    provider_code: "openrouter",
    display_name: "OpenRouter",
    auth_method: "api_key",
    status: "failed",
    reason: "Invalid API key",
    alert_id: null,
  });
  assertEquals(sent.length, 1);
  assertEquals(sent[0].to, ["ops@example.com", "second@example.com"]);
  assertEquals(sent[0].subject, "AI provider needs attention: OpenRouter");
  // The plain text body is the message the spec describes.
  assertEquals(sent[0].text, "OpenRouter (API key) is failed: Invalid API key");
});

Deno.test("the alert carries the id of the break as the idempotency key", async () => {
  const options: Array<{ idempotencyKey?: string | null; signal?: AbortSignal }> = [];
  const mailer: AdminMailer = {
    adminRecipients: async () => ["ops@example.com"],
    send: async (message) => { options.push(message); },
  };
  await sendDegradedProviderAlert(mailer, {
    provider_code: "openrouter",
    display_name: "OpenRouter",
    auth_method: "api_key",
    status: "failed",
    reason: "Invalid API key",
    alert_id: "break-123",
  });
  // The id of the break is the mail provider's idempotency key: a claim that is
  // re-claimed after a run that died mid-send cannot mail the admin twice.
  assertEquals(options[0].idempotencyKey, "break-123");
});

Deno.test("the alert hands the send the signal that bounds it", async () => {
  let received: AbortSignal | undefined;
  const mailer: AdminMailer = {
    adminRecipients: async () => ["ops@example.com"],
    send: async (message) => { received = message.signal; },
  };
  const controller = new AbortController();
  await sendDegradedProviderAlert(mailer, {
    provider_code: "openrouter",
    display_name: "OpenRouter",
    auth_method: "api_key",
    status: "failed",
    reason: "Invalid API key",
    alert_id: null,
  }, controller.signal);
  assert(received === controller.signal);
});

Deno.test("missing admin addresses leave the event retryable without sending", async () => {
  let sent = false;
  const mailer: AdminMailer = {
    adminRecipients: async () => [],
    send: async () => { sent = true; },
  };
  await assertRejects(() => sendDegradedProviderAlert(mailer, {
    provider_code: "openrouter",
    display_name: "OpenRouter",
    auth_method: "api_key",
    status: "failed",
    reason: null,
    alert_id: null,
  }), Error, "No admin alert recipients");
  assertEquals(sent, false);
});

Deno.test("the html names the provider, the credential kind and the reason", () => {
  const html = buildAlertHtml([
    {
      provider_code: "openrouter",
      display_name: "OpenRouter",
      auth_method: "api_key",
      status: "failed",
      reason: "Invalid API key",
      alert_id: null,
    },
  ]);
  assert(html.includes("OpenRouter"));
  assert(html.includes("API key"));
  assert(html.includes("Invalid API key"));
  assert(html.includes("Failed"));
});

// The reason comes from a provider. It is not trusted to be plain text, so
// everything that reaches the markup goes through the escaper first.
Deno.test("a reason that carries markup is escaped", () => {
  const html = buildAlertHtml([
    {
      provider_code: "openrouter",
      display_name: "OpenRouter",
      auth_method: "api_key",
      status: "failed",
      reason: "<script>alert('x')</script>",
      alert_id: null,
    },
  ]);
  assert(!html.includes("<script>"));
  assert(html.includes("&lt;script&gt;"));
});

Deno.test("a provider name that carries markup is escaped", () => {
  const html = buildAlertHtml([
    {
      provider_code: "openrouter",
      display_name: "<b>OpenRouter</b>",
      auth_method: "api_key",
      status: "failed",
      reason: "Invalid API key",
      alert_id: null,
    },
  ]);
  assert(!html.includes("<b>OpenRouter</b>"));
  assert(html.includes("&lt;b&gt;OpenRouter&lt;/b&gt;"));
});
