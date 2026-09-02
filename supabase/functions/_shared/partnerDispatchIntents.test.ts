// deno-lint-ignore-file no-import-prefix
// Unit tests for the dispatch-intent data access (3.2/3.3/3.4) over the
// semantics-faithful stub. The DATABASE enforcement of the same rules (the
// UNIQUE natural key, the transition guard, the CHECKs, the tenancy trigger)
// is proven against real Postgres by supabase/tests/partner_api_dispatch_intents.sql.
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";

import {
  isDispatchIntentId,
  markIntentFailed,
  markIntentSent,
  reconcileDispatchIntentByEcho,
  recordDispatchIntent,
  takeoverIntentToIndeterminate,
} from "./partnerDispatchIntents.ts";
import { createDispatchHarness } from "./partnerDispatchDurableStub.ts";

function seeded() {
  const h = createDispatchHarness(null);
  return h;
}

const base = {
  keyId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "ws-1",
  socialAccountId: "acct-1",
  idempotencyKey: "ik-1",
  summary: { recipient_phone: "96512345678", template_name: "t_v1", template_language: "ar" },
};

Deno.test("recordDispatchIntent records a fresh intent with a generated correlator id", async () => {
  const h = seeded();
  const result = await recordDispatchIntent(h.admin, base);
  assertEquals(result.status, "recorded");
  if (result.status !== "recorded") throw new Error("unreachable");
  assertEquals(isDispatchIntentId(result.intentId), true);
  const row = h.read().intents[0];
  assertEquals(row.state, "intended");
  assertEquals(row.request_summary, base.summary);
});

Deno.test("recordDispatchIntent reports the existing row on conflict (the takeover check)", async () => {
  const h = seeded();
  await recordDispatchIntent(h.admin, base);
  // Same (key_id, idempotency_key): the natural key conflicts. The previous
  // attempt's row is returned, never overwritten.
  const second = await recordDispatchIntent(h.admin, base);
  assertEquals(second.status, "existing");
  if (second.status !== "existing") throw new Error("unreachable");
  assertEquals(second.row.state, "intended");
  assertEquals(h.read().intents.length, 1);
});

Deno.test("takeoverIntentToIndeterminate compare-and-sets intended -> indeterminate", async () => {
  const h = seeded();
  const first = await recordDispatchIntent(h.admin, base);
  if (first.status !== "recorded") throw new Error("unreachable");
  const state = await takeoverIntentToIndeterminate(h.admin, first.intentId);
  assertEquals(state, "indeterminate");
  assertEquals(h.read().intents[0].state, "indeterminate");
});

Deno.test("takeoverIntentToIndeterminate loses the CAS gracefully and reports the row's real state", async () => {
  const h = seeded();
  const first = await recordDispatchIntent(h.admin, base);
  if (first.status !== "recorded") throw new Error("unreachable");
  // A webhook reconciled the row between the takeover's read and its CAS.
  await reconcileDispatchIntentByEcho(h.admin, first.intentId, "wamid.RACE");
  const state = await takeoverIntentToIndeterminate(h.admin, first.intentId);
  assertEquals(state, "reconciled_sent", "the takeover must react to reality, not its stale read");
  assertEquals(h.read().intents[0].state, "reconciled_sent");
});

Deno.test("markIntentSent records the wamid and the replayable body; a lost CAS is silent", async () => {
  const h = seeded();
  const first = await recordDispatchIntent(h.admin, base);
  if (first.status !== "recorded") throw new Error("unreachable");
  const body = { success: true, message_id: "wamid.X", state: "accepted_by_meta", recorded_in_inbox: true };
  await markIntentSent(h.admin, first.intentId, "wamid.X", 200, body);
  const row = h.read().intents[0];
  assertEquals(row.state, "sent");
  assertEquals(row.wamid, "wamid.X");
  assertEquals(row.response_body, body);

  // Second mark (webhook won the race): silent no-op, row already moved on.
  await reconcileDispatchIntentByEcho(h.admin, first.intentId, "wamid.X");
  await markIntentSent(h.admin, first.intentId, "wamid.X", 200, body);
  assertEquals(h.read().intents[0].state, "reconciled_sent");
});

Deno.test("markIntentFailed records a proven non-delivery with its replay body", async () => {
  const h = seeded();
  const first = await recordDispatchIntent(h.admin, base);
  if (first.status !== "recorded") throw new Error("unreachable");
  const body = { success: false, error: { code: "template_not_approved", message: "nope", retryable: false } };
  await markIntentFailed(h.admin, first.intentId, 422, body);
  const row = h.read().intents[0];
  assertEquals(row.state, "failed");
  assertEquals(row.http_status, 422);
  assertEquals(row.response_body, body);
});

Deno.test("reconcileDispatchIntentByEcho resolves intended, indeterminate and sent — never failed", async () => {
  for (const from of ["intended", "indeterminate", "sent"] as const) {
    const h = seeded();
    const key = `ik-${from}`;
    const first = await recordDispatchIntent(h.admin, { ...base, idempotencyKey: key });
    if (first.status !== "recorded") throw new Error("unreachable");
    if (from === "indeterminate") await takeoverIntentToIndeterminate(h.admin, first.intentId);
    if (from === "sent") {
      await markIntentSent(h.admin, first.intentId, "wamid.PRIOR", 200, {});
    }
    await reconcileDispatchIntentByEcho(h.admin, first.intentId, "wamid.ECHO");
    const row = h.read().intents[0];
    assertEquals(row.state, "reconciled_sent", `from ${from}`);
    assertEquals(row.wamid, "wamid.ECHO");
  }

  // A proven non-delivery cannot produce a status; a "positive" signal for a
  // failed row must leave it untouched.
  const h = seeded();
  const first = await recordDispatchIntent(h.admin, base);
  if (first.status !== "recorded") throw new Error("unreachable");
  await markIntentFailed(h.admin, first.intentId, 422, {});
  await reconcileDispatchIntentByEcho(h.admin, first.intentId, "wamid.SUSPECT");
  assertEquals(h.read().intents[0].state, "failed");
});

Deno.test("isDispatchIntentId accepts UUIDs and rejects everything a webhook might echo", () => {
  assertEquals(isDispatchIntentId("33333333-3333-4333-8333-333333333333"), true);
  assertEquals(isDispatchIntentId("33333333-3333-4333-8333-333333333333".toUpperCase()), true);
  assertEquals(isDispatchIntentId(undefined), false);
  assertEquals(isDispatchIntentId(null), false);
  assertEquals(isDispatchIntentId(123), false);
  assertEquals(isDispatchIntentId("wamid.HBGja0lQ7rBWcYIkwF7ZL1A"), false);
  assertEquals(isDispatchIntentId(""), false);
  // An .eq() with this string would be a Postgres cast error, not an empty
  // result — the guard exists so garbage echoes are ignorable.
  assertEquals(isDispatchIntentId("not-a-uuid"), false);
});

Deno.test("settle and reconcile log RPC failures instead of throwing (Phase 6: the RPC is the whole settle)", async () => {
  // The provider has ALREADY accepted the message by the time these run, so
  // a database failure here must not surface as an exception -- the caller
  // would fall into its indeterminate branch and report a delivered message
  // as failed. The wrappers absorb the error and log it; the intent row
  // stays `intended`, and the echo reconciliation (which emits the same
  // occurrence id) is the recovery path.
  // deno-lint-ignore no-explicit-any
  const failing: any = {
    rpc: (_name: string, _params: unknown) =>
      Promise.resolve({ data: null, error: { message: "db down" } }),
  };
  // Reaching the end of this test IS the assertion: neither call may reject.
  await markIntentSent(failing, "44444444-4444-4444-8444-444444444444", "wamid.X", 200, {});
  await reconcileDispatchIntentByEcho(failing, "44444444-4444-4444-8444-444444444444", "wamid.X");

  // CONTROL: the same wrappers against a working stub DO drive the state
  // machine, so the passing test above cannot be "the wrappers call nothing".
  const h = seeded();
  const first = await recordDispatchIntent(h.admin, base);
  if (first.status !== "recorded") throw new Error("unreachable");
  await markIntentSent(h.admin, first.intentId, "wamid.Y", 200, {});
  assertEquals(h.read().intents[0].state, "sent");
  await reconcileDispatchIntentByEcho(h.admin, first.intentId, "wamid.Y");
  assertEquals(h.read().intents[0].state, "reconciled_sent");
});
