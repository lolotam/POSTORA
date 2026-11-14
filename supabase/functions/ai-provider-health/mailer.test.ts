import { assert, assertEquals, assertRejects } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createAdminMailer } from "./mailer.ts";

Deno.test("Resend retries carry the same event key, a production sender and cancellation", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = Deno.env.get("RESEND_API_KEY");
  const originalFrom = Deno.env.get("RESEND_FROM_EMAIL");
  const requests: RequestInit[] = [];
  globalThis.fetch = (async (_url, init) => {
    requests.push(init ?? {});
    return new Response('{"id":"accepted-email"}');
  }) as typeof fetch;
  Deno.env.set("RESEND_API_KEY", ["fixture", "resend", "key"].join("-"));
  try {
    const mailer = createAdminMailer({} as never);
    const signal = new AbortController().signal;
    for (const sender of [undefined, "Postora Ops <ops@postora.cloud>"]) {
      if (sender) Deno.env.set("RESEND_FROM_EMAIL", sender);
      else Deno.env.delete("RESEND_FROM_EMAIL");
      for (let retry = 0; retry < 2; retry++) {
        await mailer.send({ to: ["admin@example.com"], subject: "Provider failed", html: "<p>Failed</p>", text: "Failed",
          idempotencyKey: "health-event-123", signal,
        });
      }
      const request = requests.at(-1)!;
      assertEquals(JSON.parse(String(request.body)).from, sender ?? "Postora Alerts <admin@postora.cloud>");
      assertEquals(new Headers(request.headers).get("Idempotency-Key"), "health-event-123");
      assert(request.signal instanceof AbortSignal);
    }
    assertEquals(requests[0].body, requests[1].body);
    Deno.env.set("RESEND_FROM_EMAIL", "Postora <notifications@resend.dev>");
    await assertRejects(() => mailer.send({ to: ["admin@example.com"], subject: "x", html: "x", text: "x",
      idempotencyKey: "health-event-123",
    }), Error, "verified sending domain");
    assertEquals(requests.length, 4);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) Deno.env.delete("RESEND_API_KEY");
    else Deno.env.set("RESEND_API_KEY", originalKey);
    if (originalFrom === undefined) Deno.env.delete("RESEND_FROM_EMAIL");
    else Deno.env.set("RESEND_FROM_EMAIL", originalFrom);
  }
});
