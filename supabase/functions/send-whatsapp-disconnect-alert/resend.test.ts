import { assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { sendDisconnectAlerts, type SendAlertsDeps } from "./handler.ts";
import { RESEND_ENDPOINT, sendResendEmail } from "./resend.ts";

const EMAIL = {
  to: ["owner@example.invalid"],
  subject: "Your WhatsApp account needs to be reconnected",
  html: "<p>hello</p>",
  idempotencyKey: "whatsapp-disconnect:acc-1:episode-1:user",
};

const OPTIONS = {
  apiKey: "resend_test_key",
  from: "Postora <notifications@postora.cloud>",
  // The retry wait is zeroed so the test does not spend real time on it.
  retryDelayMs: 0,
  sleep: () => Promise.resolve(),
};

interface RecordedCall {
  url: string;
  headers: Record<string, string>;
  body: string;
  signal: AbortSignal | null | undefined;
}

function recorder(
  responses: Array<() => Response | Promise<Response>>,
): { calls: RecordedCall[]; fetcher: typeof fetch } {
  const calls: RecordedCall[] = [];
  let index = 0;
  const fetcher = ((_url: string | URL | Request, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({
      url: String(_url),
      headers,
      body: String(init?.body ?? ""),
      signal: init?.signal,
    });
    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    return Promise.resolve(next());
  }) as unknown as typeof fetch;
  return { calls, fetcher };
}

const ok = () => new Response(JSON.stringify({ id: "res-1" }), { status: 200 });

function timeoutError(): never {
  const error = new Error("The operation was aborted due to timeout");
  error.name = "TimeoutError";
  throw error;
}

Deno.test("a successful send is one request that carries the idempotency key", async () => {
  const { calls, fetcher } = recorder([ok]);

  await sendResendEmail(EMAIL, { ...OPTIONS, fetcher });

  assertEquals(calls.length, 1);
  assertEquals(calls[0].url, RESEND_ENDPOINT);
  assertEquals(calls[0].headers["Idempotency-Key"], EMAIL.idempotencyKey);
});

Deno.test("every attempt carries an explicit timeout signal", async () => {
  const { calls, fetcher } = recorder([ok]);

  await sendResendEmail(EMAIL, { ...OPTIONS, fetcher, timeoutMs: 10_000 });

  assertEquals(calls.length, 1);
  assertEquals(calls[0].signal instanceof AbortSignal, true);
  assertEquals(calls[0].signal?.aborted, false);
});

Deno.test("a timeout is retried once with the same idempotency key", async () => {
  // Without the retry the owner would never hear about the outage: the run ends on a
  // transient provider failure. The key is unchanged, so the retry is the same email.
  const { calls, fetcher } = recorder([timeoutError, ok]);

  await sendResendEmail(EMAIL, { ...OPTIONS, fetcher });

  assertEquals(calls.length, 2);
  assertEquals(calls[0].headers["Idempotency-Key"], EMAIL.idempotencyKey);
  assertEquals(calls[1].headers["Idempotency-Key"], EMAIL.idempotencyKey);
  assertEquals(calls[1].body, calls[0].body);
});

Deno.test("a server error is retried once and then succeeds", async () => {
  const { calls, fetcher } = recorder([
    () => new Response("upstream is unwell", { status: 503 }),
    ok,
  ]);

  await sendResendEmail(EMAIL, { ...OPTIONS, fetcher });

  assertEquals(calls.length, 2);
  assertEquals(calls[1].headers["Idempotency-Key"], EMAIL.idempotencyKey);
});

Deno.test("a rate limit is retried once and then succeeds", async () => {
  const { calls, fetcher } = recorder([
    () => new Response("slow down", { status: 429 }),
    ok,
  ]);

  await sendResendEmail(EMAIL, { ...OPTIONS, fetcher });

  assertEquals(calls.length, 2);
});

Deno.test("a client error is not retried", async () => {
  // A rejected request fails the same way on a second attempt; retrying it only
  // delays the report.
  const { calls, fetcher } = recorder([
    () => new Response("invalid recipient", { status: 422 }),
  ]);

  await assertRejects(() => sendResendEmail(EMAIL, { ...OPTIONS, fetcher }));

  assertEquals(calls.length, 1);
});

Deno.test("a persistent failure gives up after the bounded number of attempts", async () => {
  const { calls, fetcher } = recorder([
    () => new Response("upstream is unwell", { status: 500 }),
  ]);

  await assertRejects(() => sendResendEmail(EMAIL, { ...OPTIONS, fetcher }));

  assertEquals(calls.length, 2);
});

Deno.test("a 409 on our own idempotency key counts as accepted", async () => {
  // Resend accepted the first request and the mark then failed. The retry carries the
  // same key and a body that changed in the meantime, and Resend answers 409. The mail
  // is out, so this is a success: failing here would send a second copy on the next
  // run, and reporting "not sent" would tell the owner about the same outage twice.
  const { calls, fetcher } = recorder([
    () =>
      new Response(
        JSON.stringify({ name: "invalid_idempotent_request", message: "Key already used" }),
        { status: 409 },
      ),
  ]);

  await sendResendEmail(EMAIL, { ...OPTIONS, fetcher });

  assertEquals(calls.length, 1);
});

Deno.test("a 409 marks the recipient as sent", async () => {
  // The whole chain: the provider conflict must reach the mark, because that mark is
  // what stops the next run from emailing the owner about the same outage again.
  const { fetcher } = recorder([
    () =>
      new Response(
        JSON.stringify({ name: "concurrent_idempotent_requests", message: "in flight" }),
        { status: 409 },
      ),
  ]);

  const marks: Array<{ accountId: string; kind: string; episodeId: string }> = [];
  const deps: SendAlertsDeps = {
    async loadAccount() {
      return {
        id: "acc-1",
        user_id: "user-1",
        platform_username: "Postora Store",
        platform_user_id: "96566600001",
      };
    },
    async loadOwnerProfile() {
      return { email: "owner@example.invalid", full_name: "Owner", email_notifications_enabled: true };
    },
    async loadAdmins() {
      return [];
    },
    async isGlobalEmailEnabled() {
      return true;
    },
    async isAdminAlertEnabled() {
      return false;
    },
    async claim() {
      return "episode-1";
    },
    async send(payload) {
      await sendResendEmail(payload, { ...OPTIONS, fetcher });
    },
    async mark(accountId, kind, episodeId) {
      marks.push({ accountId, kind, episodeId });
      return true;
    },
  };

  const summary = await sendDisconnectAlerts(deps, "acc-1");

  assertEquals(summary.ownerSent, true);
  assertEquals(summary.failed, []);
  assertEquals(marks, [{ accountId: "acc-1", kind: "user", episodeId: "episode-1" }]);
});
