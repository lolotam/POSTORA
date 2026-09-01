import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.208.0/assert/mod.ts";
import { postWebhook, validateWebhookTarget } from "./webhookSecurity.ts";

Deno.test("postWebhook rejects an internal redirect without requesting it", async () => {
  const requestedUrls: string[] = [];
  await assertRejects(
    () =>
      postWebhook("https://hooks.example.com/start", {}, (input) => {
        requestedUrls.push(String(input));
        return Promise.resolve(
          new Response(null, {
            status: 302,
            headers: { location: "https://127.0.0.1/internal" },
          }),
        );
      }),
    Error,
  );
  assertEquals(requestedUrls, ["https://hooks.example.com/start"]);
});

Deno.test("postWebhook aborts an unresponsive hop", async () => {
  let receivedSignal: AbortSignal | undefined;
  await assertRejects(
    () =>
      postWebhook("https://hooks.example.com/slow", {}, (_input, init) => {
        receivedSignal = init?.signal ?? undefined;
        return new Promise((_resolve, reject) => {
          receivedSignal?.addEventListener("abort", () =>
            reject(receivedSignal?.reason));
        });
      }, { timeoutMs: 1 }),
    DOMException,
    "Webhook request timed out",
  );
  assertEquals(receivedSignal instanceof AbortSignal, true);
});

Deno.test("validateWebhookTarget accepts public HTTPS targets", () => {
  assertEquals(validateWebhookTarget("https://hooks.example.com/events"), null);
  assertEquals(validateWebhookTarget("https://8.8.8.8/events"), null);
});

Deno.test("validateWebhookTarget rejects malformed and non-HTTPS targets", () => {
  for (
    const webhookUrl of [
      "not a url",
      "http://hooks.example.com",
      "ftp://hooks.example.com",
    ]
  ) {
    assertEquals(validateWebhookTarget(webhookUrl) !== null, true, webhookUrl);
  }
});

Deno.test("validateWebhookTarget rejects localhost and internal hostnames", () => {
  for (
    const webhookUrl of [
      "https://localhost/hooks",
      "https://localhost./hooks",
      "https://localhost../hooks",
      "https://api.localhost/hooks",
      "https://api.localhost./hooks",
      "https://service.internal/hooks",
      "https://intranet/hooks",
    ]
  ) {
    assertEquals(validateWebhookTarget(webhookUrl) !== null, true, webhookUrl);
  }
});

Deno.test("validateWebhookTarget rejects unsafe IPv4 targets", () => {
  for (
    const webhookUrl of [
      "https://127.0.0.1/hooks",
      "https://127.0.0.1./hooks",
      "https://127.0.0.1../hooks",
      "https://10.0.0.1/hooks",
      "https://172.16.0.1/hooks",
      "https://192.168.0.1/hooks",
      "https://192.168.0.1.../hooks",
      "https://169.254.169.254/hooks",
      "https://224.0.0.1/hooks",
      "https://240.0.0.1/hooks",
      "https://192.0.2.1/hooks",
      "https://192.31.196.1/hooks",
      "https://192.52.193.1/hooks",
      "https://192.88.99.1/hooks",
      "https://192.175.48.1/hooks",
    ]
  ) {
    assertEquals(validateWebhookTarget(webhookUrl) !== null, true, webhookUrl);
  }
});

Deno.test("validateWebhookTarget rejects unsafe IPv6 targets", () => {
  for (
    const webhookUrl of [
      "https://[::1]/hooks",
      "https://[fc00::1]/hooks",
      "https://[fd00::1]/hooks",
      "https://[fe80::1]/hooks",
      "https://[ff02::1]/hooks",
      "https://[2001:db8::1]/hooks",
      "https://[::ffff:127.0.0.1]/hooks",
      "https://[::127.0.0.1]/hooks",
      "https://[::7f00:1]/hooks",
      "https://[::ffff:0:127.0.0.1]/hooks",
    ]
  ) {
    assertEquals(validateWebhookTarget(webhookUrl) !== null, true, webhookUrl);
  }
});
