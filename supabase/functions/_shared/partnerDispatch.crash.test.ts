// deno-lint-ignore-file no-import-prefix
// ============================================================================
// The D13 Stage 1 crash-test gate (deliverables 3.2 + 3.3).
//
// Inject a REAL control-flow abort — worker.terminate(), not a thrown
// exception — at each of two points in the REAL dispatch path, then retry
// with the SAME Idempotency-Key and count how many times the provider was
// actually invoked.
//
//   immediately BEFORE the provider invocation:
//     retry makes ZERO additional provider calls
//     (and this test is simultaneously the 3.2 ORDERING PROOF: the retry
//      refuses to send BECAUSE it finds the committed intent row — if the
//      intent were not durably committed before the fetch, the retry would
//      dispatch and providerCalls would become 1)
//
//   immediately AFTER the provider invocation returns:
//     retry makes ZERO additional provider calls and the record is
//     `indeterminate`
//
// Why a terminated worker and not a thrown error: the production code CATCHES
// fetch errors and runs cleanup (markIndeterminate et al.) — the D13 window
// is precisely the crash where NO cleanup runs. An injected exception would
// pass these tests even without any of this deliverable's work. A terminated
// worker's suspended awaits never resume and no catch block executes — the
// in-process semantics of process death.
//
// Durable state is a file the stub writes synchronously after every
// operation (partnerDispatchDurableStub.ts): a completed write is a commit,
// visible to the retry exactly as a committed row would be to another
// connection. The claim-side lease mechanics (why attempt 2 holds a takeover
// claim at all) are SQL-proven in supabase/tests/partner_api_test.sql; here
// the takeover claim's RESULT is modelled by seeding the claim row and
// minting attempt 2's token into it, exactly what claim_partner_idempotency
// does on an expired lease.
// ============================================================================
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";

import { dispatchPartnerTemplate } from "./partnerDispatch.ts";
import { createDispatchHarness } from "./partnerDispatchDurableStub.ts";
import type { CrashRunMessage } from "./partnerDispatchCrashWorker.ts";

const WORKER_URL = new URL("./partnerDispatchCrashWorker.ts", import.meta.url).href;
const IDEMPOTENCY_KEY = "crash-gate-key";

/** Watchdog so a broken worker fails the test instead of hanging it. */
function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`timeout waiting for ${what}`)), ms)
    ),
  ]);
}

/**
 * Runs attempt 1 in a real worker and TERMINATES it at the injected point.
 * Resolves once the worker is dead. Fails the test if dispatch completed or
 * threw instead of aborting (a caught exception is a simulated crash).
 */
async function runAttemptAndTerminate(
  statePath: string,
  abortPoint: "before" | "after",
  attemptToken: string,
): Promise<void> {
  const worker = new Worker(WORKER_URL, { type: "module" });
  const done = new Promise<void>((resolve, reject) => {
    worker.onmessage = (ev: MessageEvent) => {
      const msg = ev.data as { type: string; outcome?: string; message?: string };
      if (msg?.type === "abort-now") {
        // The injection fired. Kill the worker NOW, while it is parked on
        // its timer: real control-flow abort, no cleanup.
        worker.terminate();
        resolve();
      } else if (msg?.type === "completed-unexpectedly") {
        reject(new Error(`crash injection failed: dispatch completed with ${msg.outcome}`));
      } else if (msg?.type === "threw-unexpectedly") {
        reject(new Error(`crash injection degraded into a CAUGHT error: ${msg.message}`));
      }
    };
    worker.onerror = (ev: ErrorEvent) => reject(new Error(`worker error: ${ev.message}`));
  });

  const run: CrashRunMessage = {
    type: "run",
    statePath,
    abortPoint,
    idempotencyKey: IDEMPOTENCY_KEY,
    attemptToken,
  };
  worker.postMessage(run);
  await withTimeout(done, 30_000, `worker abort (${abortPoint})`);
}

Deno.test("crash gate: abort BEFORE the provider invocation -> retry makes ZERO additional provider calls", async () => {
  const dir = await Deno.makeTempDir({ prefix: "d13_crash_before_" });
  const statePath = `${dir.replace(/\\/g, "/")}/state.json`;

  // Attempt 1: a live claim (as claim_partner_idempotency returns for a
  // fresh request), then dispatch dies before the fetch.
  const seed = createDispatchHarness(statePath);
  seed.seedClaim("attempt-1-token", seed.record.id, IDEMPOTENCY_KEY);
  await runAttemptAndTerminate(statePath, "before", "attempt-1-token");

  const afterCrash = createDispatchHarness(statePath).read();
  // The transport was never invoked.
  assertEquals(afterCrash.providerCalls, 0, "the crashed attempt must not have called the provider");
  // THE ORDERING PROOF (3.2): the intent row was COMMITTED before the
  // provider call. It is in durable storage although the fetch never
  // happened — if the implementation wrote the intent after (or only
  // alongside) the call, this row would be absent and the retry below
  // would dispatch.
  assertEquals(afterCrash.intents.length, 1, "the intent row must be durably present before the fetch");
  assertEquals(afterCrash.intents[0].state, "intended");
  assertEquals(afterCrash.idempotency[0].state, "processing", "no cleanup ran (that is what a crash is)");

  // Attempt 2: SAME Idempotency-Key. The takeover claim's result is modelled
  // (fresh token minted into the processing row — what the RPC does on an
  // expired lease), then the real dispatch path runs with a counting fetcher.
  const retry = createDispatchHarness(statePath);
  retry.simulateTakeoverClaim("attempt-2-token");
  const result = await dispatchPartnerTemplate({
    admin: retry.admin,
    record: retry.record,
    ctx: retry.ctx,
    idempotencyKey: IDEMPOTENCY_KEY,
    attemptToken: "attempt-2-token",
    input: { recipientPhone: "96512345678", templateName: "crash_gate_v1", templateLanguage: "ar" },
    fetcher: retry.countingFetcher(),
  });

  const final = retry.read();
  assertEquals(
    final.providerCalls,
    0,
    "PROVIDER-CALL COUNT: the takeover must make ZERO additional provider calls (a second real message is the bug D13 exists to prevent)",
  );
  assertEquals(result.outcome, "indeterminate", "the takeover must refuse with the typed indeterminate verdict");
  assertEquals(final.intents[0].state, "indeterminate", "the intent record must resolve to indeterminate");
  assertEquals(final.idempotency[0].state, "indeterminate", "the request record must be non-resendable");
});

Deno.test("crash gate: abort AFTER the provider invocation returns -> ZERO additional provider calls, record indeterminate", async () => {
  const dir = await Deno.makeTempDir({ prefix: "d13_crash_after_" });
  const statePath = `${dir.replace(/\\/g, "/")}/state.json`;

  const seed = createDispatchHarness(statePath);
  seed.seedClaim("attempt-1-token", seed.record.id, IDEMPOTENCY_KEY);
  await runAttemptAndTerminate(statePath, "after", "attempt-1-token");

  const afterCrash = createDispatchHarness(statePath).read();
  // The provider WAS called exactly once by the crashed attempt, and the
  // invocation count itself survived the crash (it was persisted before the
  // call began). The wamid-containing response arrived but was never
  // processed: the intent is still `intended` and the claim still
  // `processing` — exactly the D13 window.
  assertEquals(afterCrash.providerCalls, 1, "the crashed attempt called the provider exactly once");
  assertEquals(afterCrash.intents[0].state, "intended");
  assertEquals(afterCrash.idempotency[0].state, "processing");

  // Attempt 2, same key, takeover claim.
  const retry = createDispatchHarness(statePath);
  retry.simulateTakeoverClaim("attempt-2-token");
  const result = await dispatchPartnerTemplate({
    admin: retry.admin,
    record: retry.record,
    ctx: retry.ctx,
    idempotencyKey: IDEMPOTENCY_KEY,
    attemptToken: "attempt-2-token",
    input: { recipientPhone: "96512345678", templateName: "crash_gate_v1", templateLanguage: "ar" },
    fetcher: retry.countingFetcher(),
  });

  const final = retry.read();
  assertEquals(
    final.providerCalls,
    1,
    "PROVIDER-CALL COUNT: exactly one call across BOTH attempts — the retry added zero",
  );
  assertEquals(result.outcome, "indeterminate");
  assertEquals(final.intents[0].state, "indeterminate", "the record must be indeterminate (invariant 1)");
  assertEquals(final.idempotency[0].state, "indeterminate");
});

Deno.test("crash gate: a NEVER-dispatched request is resolvable (crash between the claim and the intent insert)", async () => {
  // The complement of the two crash cases: the attempt died before the
  // intent existed, so no evidence of a possible send exists and the retry
  // may — and must — dispatch. This is what keeps at-most-once from
  // wedging every crashed request forever.
  const dir = await Deno.makeTempDir({ prefix: "d13_never_" });
  const statePath = `${dir.replace(/\\/g, "/")}/state.json`;

  const harness = createDispatchHarness(statePath);
  harness.seedClaim("attempt-2-token", harness.record.id, IDEMPOTENCY_KEY);

  const result = await dispatchPartnerTemplate({
    admin: harness.admin,
    record: harness.record,
    ctx: harness.ctx,
    idempotencyKey: IDEMPOTENCY_KEY,
    attemptToken: "attempt-2-token",
    input: { recipientPhone: "96512345678", templateName: "crash_gate_v1", templateLanguage: "ar" },
    fetcher: harness.countingFetcher(),
  });

  const final = harness.read();
  assertEquals(result.outcome, "sent");
  assertEquals(final.providerCalls, 1, "a never-dispatched request resolves with exactly one provider call");
  assertEquals(final.intents.length, 1);
  assertEquals(final.intents[0].state, "sent");
  assertEquals(final.idempotency[0].state, "completed");
  assertEquals(final.idempotency[0].http_status, 200);
  // The send carried the intent id as its correlator (3.4): this is the
  // value a status webhook must echo back for reconciliation to fire.
  const sentBody = JSON.parse(final.requestBodies[0]) as Record<string, unknown>;
  assertEquals(typeof sentBody.biz_opaque_callback_data, "string");
  assertEquals(sentBody.biz_opaque_callback_data, final.intents[0].id);
});
