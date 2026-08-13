// deno-lint-ignore-file no-import-prefix
import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  claimIdempotency,
  completeIdempotency,
  hashRequest,
} from "./partnerApiIdempotency.ts";

/**
 * Stubs the RPC, because that is now the whole interface. These tests cover
 * ONLY the outcome mapping — they deliberately do not claim to test claim
 * semantics, which live in SQL and are tested for real in Task 9.
 */
function stubRpc(outcome: string, extra: Record<string, unknown> = {}) {
  return {
    rpc() {
      return Promise.resolve({ data: [{ outcome, ...extra }], error: null });
    },
  // deno-lint-ignore no-explicit-any
  } as any;
}

Deno.test("hashRequest is stable for equal bodies and differs for different ones", async () => {
  const a = await hashRequest({ to: "965123", template: "invoice_due" });
  const b = await hashRequest({ to: "965123", template: "invoice_due" });
  const c = await hashRequest({ to: "965999", template: "invoice_due" });
  assertEquals(a, b);
  assertEquals(a === c, false);
});

Deno.test("hashRequest ignores key order but not key content", async () => {
  const a = await hashRequest({ to: "965123", template: "x" });
  const b = await hashRequest({ template: "x", to: "965123" });
  assertEquals(a, b);
});

Deno.test("hashRequest distinguishes bodies that differ only deep inside", async () => {
  // The regression guard: a replacer-based canonicalizer collapses both of
  // these to [{}], so a 99.000 KWD invoice would replay a 12.500 KWD send.
  const cheap = await hashRequest({
    template_components: [{ type: "body", parameters: [{ type: "text", text: "12.500" }] }],
  });
  const dear = await hashRequest({
    template_components: [{ type: "body", parameters: [{ type: "text", text: "99.000" }] }],
  });
  assertEquals(cheap === dear, false);
});

Deno.test("hashRequest accepts null and undefined without throwing", async () => {
  await hashRequest(null);
  await hashRequest(undefined);
});

Deno.test("claimIdempotency maps each RPC outcome to its ClaimResult", async () => {
  assertEquals(
    (await claimIdempotency(stubRpc("claimed"), "k", "i", "h")).outcome,
    "claimed",
  );
  assertEquals(
    (await claimIdempotency(stubRpc("conflict"), "k", "i", "h")).outcome,
    "conflict",
  );
  assertEquals(
    (await claimIdempotency(stubRpc("in_progress"), "k", "i", "h")).outcome,
    "in_progress",
  );
  assertEquals(
    (await claimIdempotency(stubRpc("indeterminate"), "k", "i", "h")).outcome,
    "indeterminate",
  );
});

Deno.test("claimIdempotency carries the stored response through a replay", async () => {
  const result = await claimIdempotency(
    stubRpc("replay", { http_status: 200, response_body: { message_id: "wamid.X" } }),
    "k", "i", "h",
  );
  assertEquals(result.outcome, "replay");
  if (result.outcome === "replay") {
    assertEquals(result.httpStatus, 200);
    assertEquals((result.body as Record<string, unknown>).message_id, "wamid.X");
  }
});

Deno.test("claimIdempotency treats an unrecognized outcome as in_progress", async () => {
  // Fail closed: an unknown outcome must never be read as permission to send.
  assertEquals(
    (await claimIdempotency(stubRpc("something_new"), "k", "i", "h")).outcome,
    "in_progress",
  );
});

Deno.test("claimIdempotency surfaces an RPC error instead of sending anyway", async () => {
  const client = {
    rpc() { return Promise.resolve({ data: null, error: { message: "boom" } }); },
  // deno-lint-ignore no-explicit-any
  } as any;
  await assertRejects(() => claimIdempotency(client, "k", "i", "h"), Error);
});

Deno.test("completeIdempotency throws when the settle write fails", async () => {
  // The chain is update().eq(key_id).eq(idempotency_key).eq(state).eq(attempt_token),
  // so the stub must stay chainable and resolve only when awaited.
  const client = {
    from() {
      const chain: Record<string, unknown> = {
        update() { return chain; },
        eq() { return chain; },
        then(resolve: (v: unknown) => void) {
          resolve({ error: { message: "db down" } });
        },
      };
      return chain;
    },
  // deno-lint-ignore no-explicit-any
  } as any;
  // A silently dropped settle leaves the row `processing`; it must be loud.
  await assertRejects(
    () => completeIdempotency(client, "k", "i", "token-1", 200, { ok: true }),
    Error,
  );
});
