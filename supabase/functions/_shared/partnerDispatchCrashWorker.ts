// TEST SUPPORT — the worker script for the D13 crash gate. NOT a test file.
//
// Spawned as a module worker by partnerDispatch.crash.test.ts. Runs the REAL
// dispatchPartnerTemplate (the production path partner-api/index.ts calls)
// against the file-backed durable stub, and — at the injected abort point —
// signals the parent and parks on a 60s timer. The parent then TERMINATES
// this worker: a real control-flow abort. No catch block runs, no cleanup
// write happens, and the durable state file contains exactly what a killed
// process would have committed — nothing more.
//
// If the injection fails to fire, dispatchPartnerTemplate returns normally
// and this script says so, which fails the test: a crash test that never
// crashed proves nothing.

import { dispatchPartnerTemplate } from "./partnerDispatch.ts";
import { createDispatchHarness } from "./partnerDispatchDurableStub.ts";

export interface CrashRunMessage {
  type: "run";
  statePath: string;
  /** "before": abort immediately before the provider invocation.
   *  "after":  abort immediately after it returns. */
  abortPoint: "before" | "after";
  idempotencyKey: string;
  attemptToken: string;
}

// deno check resolves this file against the MAIN window scope, where `self`
// lacks the worker globals; at runtime it IS a DedicatedWorkerGlobalScope.
const scope = self as unknown as {
  onmessage: ((ev: MessageEvent) => void) | null;
  postMessage(message: unknown): void;
};

scope.onmessage = async (ev: MessageEvent) => {
  const msg = ev.data as CrashRunMessage;
  if (msg?.type !== "run") return;

  const harness = createDispatchHarness(msg.statePath);
  try {
    const result = await dispatchPartnerTemplate({
      admin: harness.admin,
      record: harness.record,
      ctx: harness.ctx,
      idempotencyKey: msg.idempotencyKey,
      attemptToken: msg.attemptToken,
      input: {
        recipientPhone: "96512345678",
        templateName: "crash_gate_v1",
        templateLanguage: "ar",
      },
      fetcher: harness.abortingFetcher(
        msg.abortPoint,
        () => scope.postMessage({ type: "abort-now" }),
      ),
    });
    scope.postMessage({ type: "completed-unexpectedly", outcome: result.outcome });
  } catch (err) {
    // An abort that turns into an exception is a SIMULATED crash — the
    // production catch blocks ran. Fail the test.
    scope.postMessage({ type: "threw-unexpectedly", message: String(err) });
  }
};
