/**
 * The owner daily dispatch and its bounded resume.
 *
 * WHAT THIS MODULE OWNS
 *
 *   The orchestration of ONE bounded enqueue page, in the two shapes the
 *   contract has:
 *
 *     the DISPATCH  starts (or reopens) the current Kuwait capture day's
 *                   sweep and enqueues at most one page of twenty five
 *                   owner targets. It is what the daily scheduler calls.
 *     the RESUME    continues an ALREADY pending sweep and enqueues at
 *                   most one page. It is what a drain calls BEFORE it
 *                   claims, so a sweep larger than one page is finished by
 *                   later ticks instead of by an unbounded loop.
 *
 * WHY THE RESUME NEVER STARTS A SWEEP
 *
 *   The resume passes `p_start = false`, and the accepted SQL resumes only
 *   an already pending sweep. A drain tick can therefore never BEGIN
 *   collection by itself, and it never enqueues a page for a day nobody
 *   dispatched.
 *
 * WHY THE RESUME IS INSIDE THE DRAIN'S OWN BUDGET
 *
 *   The resume is charged against the SAME budget as the drain, and it
 *   leaves the drain's own write reserve behind. When the remaining
 *   budget is too small the resume is DEFERRED: the sweep stays pending,
 *   the drain proceeds with the work it already has, and the next tick
 *   runs the page. A deferred resume is not a failure and it is never
 *   reported as a completion.
 *
 * WHY THERE IS NO RECURSION
 *
 *   The resume is ONE statement and ONE page. There is no self-HTTP call,
 *   no waitUntil loop and no unbounded retry: the durable state in the
 *   sweep table is the continuation, and the next tick reads it.
 *
 * WHY NOTHING HERE CALLS A PROVIDER
 *
 *   The dispatcher makes ZERO Meta calls. It enqueues work and returns; the
 *   drain is what collects, behind its own permit.
 */

import {
  OwnerDailyEnqueueStoreError,
  type DailyEnqueueRefusalReason,
  type DailySweepStatus,
  type OwnerDailyEnqueueOutcome,
  type OwnerDailyEnqueueReceipt,
  type OwnerDailyEnqueueStore,
  type OwnerDailyStoreFailure,
} from "./dailyEnqueueStore.ts";

/**
 * The ceiling of one daily enqueue statement.
 *
 * It is a dependency ceiling, not a provider one: the statement is a single
 * bounded database call, and a slow database must not eat the drain's
 * provider budget.
 */
export const DAILY_ENQUEUE_CEILING_MS = 5_000;

/**
 * The reserve the drain keeps for its OWN writes and its audit.
 *
 * The resume is charged against the same budget, so it must leave this
 * much behind. The default mirrors the worker's write reserve; the caller
 * passes its own so the two can never drift apart.
 */
export const DAILY_ENQUEUE_WRITE_RESERVE_MS = 5_000;

/**
 * The smallest remaining budget that still allows a resume.
 *
 * The resume needs its own ceiling AND the write reserve behind it.
 */
export const DAILY_ENQUEUE_MIN_BUDGET_MS =
  DAILY_ENQUEUE_CEILING_MS + DAILY_ENQUEUE_WRITE_RESERVE_MS;

/** A stable, bounded log event. It never carries a credential or an owner. */
export interface OwnerDailyLogEvent {
  readonly event: string;
  readonly outcome?: string;
  readonly reasonCode?: string;
  /** A count of INSERTED rows, never of collected targets. */
  readonly enqueued?: number;
  readonly hasMore?: boolean;
  readonly sweepStatus?: string;
}

/** The ports of the owner daily enqueue. */
export interface OwnerDailyEnqueuePorts {
  readonly store: OwnerDailyEnqueueStore;
  /** The bounded log sink. */
  readonly log: (event: OwnerDailyLogEvent) => void;
}

/**
 * The budget the resume is charged against.
 *
 * It is structural on purpose: the worker's budget satisfies it without
 * this module importing the worker, so the two modules cannot form a
 * cycle.
 */
export interface DailyEnqueueBudget {
  remainingMs(): number;
}

/**
 * The outcome of the DISPATCH.
 *
 *   accepted        the statement ran; the sweep state is known.
 *   refused         the configuration refuses. It is a decision.
 *   indeterminate   the statement's outcome could not be read. It may have
 *                   committed, so it is never reported as a completion.
 */
export type OwnerDailyDispatchOutcome =
  | { readonly kind: "accepted"; readonly receipt: OwnerDailyEnqueueReceipt }
  | {
    readonly kind: "refused";
    readonly reason: DailyEnqueueRefusalReason;
    readonly capturedOn: string;
  }
  | { readonly kind: "indeterminate"; readonly reason: OwnerDailyStoreFailure };

/**
 * The outcome of the RESUME.
 *
 * The resume never throws: a bounded enqueue is not a reason to fail a
 * drain that already has work to do.
 */
export interface OwnerDailyResumeOutcome {
  /** Whether the statement was sent at all. */
  readonly attempted: boolean;
  /** Whether the resume was skipped because the budget was too small. */
  readonly deferred: boolean;
  /** Whether the statement's outcome could not be read. */
  readonly indeterminate: boolean;
  /** The rows THIS call inserted. */
  readonly enqueued: number;
  readonly hasMore: boolean;
  readonly sweepStatus: DailySweepStatus | null;
  readonly capturedOn: string | null;
}

type BoundedOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: "timeout" | "failed" };

/**
 * Runs one dependency inside a ceiling.
 *
 * The losing promise is always settled, so a dependency that fails after
 * the caller gave up can never become an unhandled rejection and can never
 * be mistaken for a result.
 */
async function runBounded<T>(
  work: (signal: AbortSignal) => Promise<T>,
  ceilingMs: number,
  outer: AbortSignal | undefined,
): Promise<BoundedOutcome<T>> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeout = new Promise<{ readonly ok: false; readonly reason: "timeout" }>(
    (resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve({ ok: false, reason: "timeout" });
      }, Math.max(0, ceilingMs));
    },
  );

  const settled = Promise.resolve()
    .then(() => work(controller.signal))
    .then(
      (value) => ({ ok: true, value }) as const,
      (error: unknown) => ({ ok: false, reason: "failed", error }) as const,
    );

  try {
    return await Promise.race([settled, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * The DISPATCH.
 *
 * It STARTS (or reopens) the current day's sweep and enqueues at most one
 * page. It makes no provider call and it forces nothing: the rows it
 * inserts are ordinary jobs.
 */
export async function dispatchOwnerDailyEnqueue(
  ports: OwnerDailyEnqueuePorts,
  input: { readonly signal?: AbortSignal; readonly ceilingMs?: number } = {},
): Promise<OwnerDailyDispatchOutcome> {
  const ceiling = input.ceilingMs ?? DAILY_ENQUEUE_CEILING_MS;

  const outcome = await runBounded(
    (signal) => ports.store.enqueueDailyPage({ start: true, signal }),
    ceiling,
    input.signal,
  );

  if (!outcome.ok) {
    // The statement may have committed. The dispatch is never replayed in
    // the same invocation, and it is never reported as a completion.
    ports.log({ event: "owner_daily_enqueue_dispatch", outcome: "indeterminate" });
    return { kind: "indeterminate", reason: "rpc_failed" };
  }

  if (outcome.value.kind === "refused") {
    ports.log({
      event: "owner_daily_enqueue_dispatch",
      outcome: "refused",
      reasonCode: outcome.value.reason,
    });
    return {
      kind: "refused",
      reason: outcome.value.reason,
      capturedOn: outcome.value.capturedOn,
    };
  }

  const receipt = outcome.value.receipt;
  ports.log({
    event: "owner_daily_enqueue_dispatch",
    outcome: receipt.enqueued > 0 ? "enqueued" : "no_work",
    enqueued: receipt.enqueued,
    hasMore: receipt.hasMore,
    sweepStatus: receipt.sweepStatus,
  });

  return { kind: "accepted", receipt };
}

/**
 * The RESUME.
 *
 * It runs BEFORE the drain claims, inside the same budget, and it leaves
 * the drain's write reserve behind. It enqueues at most ONE page and it
 * never starts a sweep.
 */
export async function resumeOwnerDailyEnqueue(
  ports: OwnerDailyEnqueuePorts,
  budget: DailyEnqueueBudget,
  input: {
    readonly signal?: AbortSignal;
    readonly writeReserveMs?: number;
    readonly ceilingMs?: number;
  } = {},
): Promise<OwnerDailyResumeOutcome> {
  const writeReserveMs = input.writeReserveMs ?? DAILY_ENQUEUE_WRITE_RESERVE_MS;
  const ceiling = input.ceilingMs ?? DAILY_ENQUEUE_CEILING_MS;

  // The budget gate.
  //
  // The resume needs its own ceiling AND the drain's write reserve to be
  // left behind. When the budget is too small the resume is DEFERRED: the
  // sweep stays pending, the drain proceeds, and the next tick runs it.
  if (budget.remainingMs() < ceiling + writeReserveMs) {
    ports.log({ event: "owner_daily_enqueue_resume", outcome: "deferred" });
    return {
      attempted: false,
      deferred: true,
      indeterminate: false,
      enqueued: 0,
      hasMore: false,
      sweepStatus: null,
      capturedOn: null,
    };
  }

  const available = Math.min(ceiling, budget.remainingMs() - writeReserveMs);

  const outcome = await runBounded(
    (signal) => ports.store.enqueueDailyPage({ start: false, signal }),
    available,
    input.signal,
  );

  if (!outcome.ok) {
    // A timeout or a transport failure. The statement may have committed,
    // so the sweep state is unknown. The drain continues: the work it
    // already has is not this statement's business.
    ports.log({ event: "owner_daily_enqueue_resume", outcome: "indeterminate" });
    return {
      attempted: true,
      deferred: false,
      indeterminate: true,
      enqueued: 0,
      hasMore: false,
      sweepStatus: null,
      capturedOn: null,
    };
  }

  if (outcome.value.kind === "refused") {
    // The configuration refuses. The drain still claims what it already
    // has; the refusal is recorded and nothing is invented.
    ports.log({
      event: "owner_daily_enqueue_resume",
      outcome: "refused",
      reasonCode: outcome.value.reason,
    });
    return {
      attempted: true,
      deferred: false,
      indeterminate: false,
      enqueued: 0,
      hasMore: false,
      sweepStatus: null,
      capturedOn: outcome.value.capturedOn,
    };
  }

  const receipt = outcome.value.receipt;
  ports.log({
    event: "owner_daily_enqueue_resume",
    outcome: receipt.enqueued > 0 ? "enqueued" : "no_work",
    enqueued: receipt.enqueued,
    hasMore: receipt.hasMore,
    sweepStatus: receipt.sweepStatus,
  });

  return {
    attempted: true,
    deferred: false,
    indeterminate: false,
    enqueued: receipt.enqueued,
    hasMore: receipt.hasMore,
    sweepStatus: receipt.sweepStatus,
    capturedOn: receipt.capturedOn,
  };
}

/**
 * Reads the failure of a store call without importing its identity into
 * the caller's decision, so the caller stays independent of the adapter.
 */
export function readDailyStoreFailure(error: unknown): OwnerDailyStoreFailure | null {
  if (!(error instanceof OwnerDailyEnqueueStoreError)) return null;
  return error.failure;
}
