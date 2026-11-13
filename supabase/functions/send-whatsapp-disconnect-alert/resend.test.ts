import { assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { sendDisconnectAlerts, type SendAlertsDeps } from "./handler.ts";
import { RESEND_ENDPOINT, ResendSendError, sendResendEmail } from "./resend.ts";

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

/** A conflict that names itself the way the provider does. */
const conflict = (name: string) =>
  new Response(JSON.stringify({ name, message: "conflict" }), {
    status: 409,
    headers: { "Content-Type": "application/json" },
  });

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

Deno.test("a conflict that says the first request is still in flight is retried and then sent", async () => {
  // `concurrent_idempotent_requests` means the first request with this key is still
  // being processed. The retry carries the same key and the same body, so it is the
  // very same email and not a second copy.
  const { calls, fetcher } = recorder([
    () => conflict("concurrent_idempotent_requests"),
    ok,
  ]);

  await sendResendEmail(EMAIL, { ...OPTIONS, fetcher });

  assertEquals(calls.length, 2);
  assertEquals(calls[0].headers["Idempotency-Key"], EMAIL.idempotencyKey);
  assertEquals(calls[1].headers["Idempotency-Key"], EMAIL.idempotencyKey);
  assertEquals(calls[1].body, calls[0].body);
});

Deno.test("an in-flight conflict on every attempt fails the send", async () => {
  // The first request never settles. Retrying within the attempt budget is not enough,
  // so the send fails instead of pretending the mail went out.
  const { calls, fetcher } = recorder([() => conflict("concurrent_idempotent_requests")]);

  const error = await assertRejects(() => sendResendEmail(EMAIL, { ...OPTIONS, fetcher }));

  assertEquals(error instanceof ResendSendError, true);
  assertEquals((error as ResendSendError).code, "idempotency_in_flight");
  assertEquals((error as ResendSendError).status, 409);
  assertEquals(calls.length, 2);
});

Deno.test("an invalid idempotent request fails the send and is not retried", async () => {
  // `invalid_idempotent_request` means the key was already used with a different
  // payload: the provider will never accept this body, so a retry cannot help.
  const { calls, fetcher } = recorder([() => conflict("invalid_idempotent_request")]);

  const error = await assertRejects(() => sendResendEmail(EMAIL, { ...OPTIONS, fetcher }));

  assertEquals(error instanceof ResendSendError, true);
  assertEquals((error as ResendSendError).code, "invalid_idempotent_request");
  assertEquals((error as ResendSendError).status, 409);
  assertEquals(calls.length, 1);
});

Deno.test("a conflict whose name is provider text does not keep that text", async () => {
  // The body name is not a contract. An address or a sentence in it must not become
  // the error code: errorCode copies a string code into the log.
  const leaked = "retry refused for owner@example.invalid because the payload changed";
  const { calls, fetcher } = recorder([() => conflict(leaked)]);

  const error = await assertRejects(
    () => sendResendEmail(EMAIL, { ...OPTIONS, fetcher }),
    ResendSendError,
  );

  assertEquals(error.code, "idempotency_conflict");
  assertEquals(error.status, 409);
  assertEquals(error.message.includes(leaked), false);
  assertEquals(error.message.includes("owner@example.invalid"), false);
  assertEquals(calls.length, 1);
});

Deno.test("a conflict with an unreadable body fails the send", async () => {
  // The body carries no name, so the conflict cannot be classified. An unclassified
  // conflict is a failure: it is never evidence that the mail went out.
  const { calls, fetcher } = recorder([() => new Response("conflict", { status: 409 })]);

  const error = await assertRejects(() => sendResendEmail(EMAIL, { ...OPTIONS, fetcher }));

  assertEquals(error instanceof ResendSendError, true);
  assertEquals((error as ResendSendError).code, "idempotency_conflict");
  assertEquals(calls.length, 1);
});

Deno.test("an in-flight conflict that clears on the retry marks the recipient as sent", async () => {
  // The whole chain: the conflict is retried inside the send, and the mail that goes
  // out reaches the mark. That mark is what stops the next run from emailing the owner
  // about the same outage again.
  const { fetcher } = recorder([() => conflict("concurrent_idempotent_requests"), ok]);

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
      return { episodeId: "episode-1", payload: null };
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

Deno.test("a conflict that never clears leaves the recipient unmarked", async () => {
  // The conflict is permanent for this run, so the mail is not out: the owner is not
  // marked as told, and the failure is reported instead.
  const { fetcher } = recorder([() => conflict("invalid_idempotent_request")]);

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
      return { episodeId: "episode-1", payload: null };
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

  assertEquals(summary.ownerSent, false);
  assertEquals(summary.failed, ["acc-1"]);
  assertEquals(marks, []);
});
