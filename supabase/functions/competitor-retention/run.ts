/**
 * The bounded competitor-retention run.
 *
 * WHAT THIS MODULE OWNS
 *
 *   The orchestration of ONE invocation: how many slices are started, how
 *   much of the invocation's parent and child budget is left, when a new
 *   slice may be started, and what is reported when a slice fails.
 *
 * WHAT IT DOES NOT OWN
 *
 *   The SQL, the clock and the eligibility rule. They belong to
 *   `public.run_competitor_retention_batch` (migration M3). This module
 *   never decides which row is eligible, never moves the 90-day boundary
 *   and never carries an owner, a cutoff or a time of its own: the request
 *   it builds has exactly three fields, and there is no other way to call
 *   the batch.
 *
 * WHY THE CAPS ARE OVERALL AND NOT PER SLICE
 *
 *   The SQL caps every slice independently (1-50 parents, 1-500 children).
 *   That is not the invocation's budget. The invocation's budget is 50
 *   parents and 500 child rows IN TOTAL, so every slice is asked for the
 *   REMAINING budget and never for a fresh one. An hourly cron that asked
 *   for a fresh 50/500 every time would drain an unbounded backlog, which
 *   is not what the 90-day promise to a user is allowed to become.
 *
 * WHY A NEW SLICE NEEDS SIX SECONDS LEFT
 *
 *   A slice is a database call with a five second ceiling. Starting one
 *   with less than six seconds of the forty second budget left means
 *   starting work that cannot finish inside the budget. The run stops
 *   instead: the SQL rechecks the eligibility of every row it touches, so
 *   a partial invocation is progress and not a gap.
 *
 * WHY A NON-ENABLED SWITCH STOPS THE RUN
 *
 *   The switch is checked IN SQL, so a disabled, missing or malformed
 *   switch already mutates nothing there. This module checks it AGAIN,
 *   because the Edge wrapper has to fail closed on its own terms and not
 *   lean on the RPC's internal guard to stop it. A dry run is the one
 *   exception: a preview reads and mutates nothing either way, so it stays
 *   available while the cleanup is off.
 *
 * WHY A FAILED SLICE IS NEVER AN EMPTY ONE
 *
 *   A dropped connection, a timeout and an unreadable payload are three
 *   different facts, and none of them is "there was nothing to do". The
 *   run stops, reports the slices it did finish, and writes the reason to
 *   the audit. A caller that reads an empty result as a finished cleanup
 *   would be reading a failure as a success.
 */

/** The wall-clock budget of one invocation. */
export const RETENTION_BUDGET_MS = 40_000;

/** The parents one invocation may process, across all of its slices. */
export const RETENTION_PARENT_LIMIT = 50;

/** The child rows one invocation may delete, across all of its slices. */
export const RETENTION_CHILD_LIMIT = 500;

/** The ceiling of one database call. */
export const RETENTION_DEPENDENCY_TIMEOUT_MS = 5_000;

/** The reserve a new slice needs before it may be started. */
export const RETENTION_MIN_REMAINING_MS = 6_000;

/**
 * The state of the server-controlled switch, as the database reports it.
 * "missing" and "malformed" are not "disabled": an operator has to be able
 * to tell "the cleanup is off" apart from "the switch could not be read".
 */
export type RetentionSwitchState = "enabled" | "disabled" | "missing" | "malformed";

/**
 * The slice request. Three fields, and nothing else: there is no owner, no
 * cutoff, no time and no id. The clock and the eligibility rule are the
 * database's.
 */
export interface RetentionBatchRequest {
  readonly parentLimit: number;
  readonly childLimit: number;
  readonly dryRun: boolean;
}

/** One bounded slice, as the database reported it. */
export interface RetentionSlice {
  readonly switchState: RetentionSwitchState;
  readonly dryRun: boolean;
  readonly parentsConsidered: number;
  readonly parentsDeleted: number;
  readonly parentsProjected: number;
  readonly parentsSkippedLiveLease: number;
  readonly parentsSkippedIneligible: number;
  readonly childrenCounted: number;
  readonly childrenDeleted: number;
  readonly hasMore: boolean;
}

/**
 * The outcome of one slice. A failure carries a reason and no counts: a
 * failed read is never presented as an empty slice.
 */
export type RetentionBatchOutcome =
  | { readonly ok: true; readonly slice: RetentionSlice }
  | {
    readonly ok: false;
    readonly reason: "malformed_response" | "rpc_failed" | "dependency_timeout";
  };

/** Why the run stopped. Every exit has exactly one of these. */
export type RetentionStopReason =
  | "completed"
  | "budget_exhausted"
  | "time_budget"
  | "no_progress"
  | "switch_disabled"
  | "switch_missing"
  | "switch_malformed"
  | "malformed_response"
  | "rpc_failed"
  | "dependency_timeout";

/**
 * The audit of one invocation. Counts and reasons only: no handle, no
 * caption, no url, no id and no secret ever reaches this record.
 */
export interface RetentionAuditEvent {
  readonly event: "retention_run";
  readonly outcome: "completed" | "stopped" | "failed";
  readonly reason: RetentionStopReason;
  readonly dry_run: boolean;
  readonly switch_state: RetentionSwitchState | "unknown";
  readonly slices: number;
  readonly parents_processed: number;
  readonly parents_deleted: number;
  readonly children_counted: number;
  readonly children_deleted: number;
  readonly has_more: boolean;
  readonly duration_ms: number;
}

/** The ports the run needs. The database adapter implements them. */
export interface CompetitorRetentionPorts {
  /** One bounded slice. Never rejects: it reports the failure instead. */
  runBatch(request: RetentionBatchRequest): Promise<RetentionBatchOutcome>;
  /** The audit of this invocation. Best effort: it never changes the run. */
  logAudit(event: RetentionAuditEvent): Promise<void>;
}

/** What the invocation reports. */
export interface CompetitorRetentionReport {
  readonly dryRun: boolean;
  readonly slices: number;
  readonly parentsProcessed: number;
  readonly parentsDeleted: number;
  readonly parentsProjected: number;
  readonly parentsSkippedLiveLease: number;
  readonly parentsSkippedIneligible: number;
  readonly childrenCounted: number;
  readonly childrenDeleted: number;
  readonly hasMore: boolean;
  readonly switchState: RetentionSwitchState | "unknown";
  readonly stopReason: RetentionStopReason;
  readonly failed: boolean;
  readonly durationMs: number;
}

class DependencyTimeoutError extends Error {
  constructor() {
    super("the retention dependency did not answer in time");
    this.name = "DependencyTimeoutError";
  }
}

/**
 * A bounded wait. The work is never abandoned silently: the timer rejects
 * and the run reports the timeout, and a late answer is still consumed so
 * it cannot become an unhandled rejection.
 */
function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new DependencyTimeoutError()), timeoutMs);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * One slice, guarded. A throw, a timeout and an unknown shape are three
 * different failures, and none of them is an empty slice.
 */
async function callBatch(
  ports: CompetitorRetentionPorts,
  request: RetentionBatchRequest,
  timeoutMs: number,
): Promise<RetentionBatchOutcome> {
  let outcome: RetentionBatchOutcome;
  try {
    outcome = await withTimeout(ports.runBatch(request), timeoutMs);
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof DependencyTimeoutError ? "dependency_timeout" : "rpc_failed",
    };
  }

  if (!outcome || typeof outcome !== "object" || !("ok" in outcome)) {
    return { ok: false, reason: "malformed_response" };
  }
  if (!outcome.ok) {
    return {
      ok: false,
      reason: outcome.reason === "malformed_response" ||
          outcome.reason === "dependency_timeout"
        ? outcome.reason
        : "rpc_failed",
    };
  }
  return { ok: true, slice: outcome.slice };
}

/**
 * The counters one invocation accumulates. They are the run's only state,
 * and they are what the report and the audit are built from.
 */
interface RunState {
  slices: number;
  parentsProcessed: number;
  parentsDeleted: number;
  parentsProjected: number;
  parentsSkippedLiveLease: number;
  parentsSkippedIneligible: number;
  childrenCounted: number;
  childrenDeleted: number;
  hasMore: boolean;
  switchState: RetentionSwitchState | "unknown";
}

function newRunState(): RunState {
  return {
    slices: 0,
    parentsProcessed: 0,
    parentsDeleted: 0,
    parentsProjected: 0,
    parentsSkippedLiveLease: 0,
    parentsSkippedIneligible: 0,
    childrenCounted: 0,
    childrenDeleted: 0,
    hasMore: false,
    switchState: "unknown",
  };
}

/** Folds one slice's counters into the state of the invocation. */
function accumulate(state: RunState, slice: RetentionSlice): void {
  state.parentsProcessed += slice.parentsConsidered;
  state.parentsDeleted += slice.parentsDeleted;
  state.parentsProjected += slice.parentsProjected;
  state.parentsSkippedLiveLease += slice.parentsSkippedLiveLease;
  state.parentsSkippedIneligible += slice.parentsSkippedIneligible;
  state.childrenCounted += slice.childrenCounted;
  state.childrenDeleted += slice.childrenDeleted;
  state.hasMore = slice.hasMore;
  state.switchState = slice.switchState;
}

/** How the invocation ended. */
interface RunOutcome {
  readonly state: RunState;
  readonly stopReason: RetentionStopReason;
  readonly failed: boolean;
}

/**
 * The dry run.
 *
 * Exactly one slice: a preview reads the same candidates every time, so a
 * second preview would report the same rows and nothing else. The switch
 * does not stop a preview - it reads and mutates nothing either way.
 */
async function runDryRun(
  ports: CompetitorRetentionPorts,
  timeoutMs: number,
): Promise<RunOutcome> {
  const state = newRunState();
  const outcome = await callBatch(
    ports,
    { parentLimit: RETENTION_PARENT_LIMIT, childLimit: RETENTION_CHILD_LIMIT, dryRun: true },
    timeoutMs,
  );
  state.slices = 1;

  if (!outcome.ok) {
    return { state, stopReason: outcome.reason, failed: true };
  }
  accumulate(state, outcome.slice);
  return { state, stopReason: "completed", failed: false };
}

/**
 * The live run.
 *
 * Slices are started until the backlog is empty, the budget is spent, the
 * time is too short to start another one, or a slice fails. Each slice is
 * asked for the REMAINING parent and child budget, never for a fresh one.
 */
async function runLive(
  ports: CompetitorRetentionPorts,
  options: {
    readonly remainingMs: () => number;
    readonly timeoutMs: number;
    readonly minRemainingMs: number;
  },
): Promise<RunOutcome> {
  const state = newRunState();

  while (true) {
    const parentBudget = RETENTION_PARENT_LIMIT - state.parentsProcessed;
    const childBudget = RETENTION_CHILD_LIMIT - state.childrenDeleted;
    if (parentBudget <= 0 || childBudget <= 0) {
      return { state, stopReason: "budget_exhausted", failed: false };
    }
    if (options.remainingMs() < options.minRemainingMs) {
      return { state, stopReason: "time_budget", failed: false };
    }

    const outcome = await callBatch(
      ports,
      { parentLimit: parentBudget, childLimit: childBudget, dryRun: false },
      options.timeoutMs,
    );
    state.slices += 1;

    if (!outcome.ok) {
      return { state, stopReason: outcome.reason, failed: true };
    }
    accumulate(state, outcome.slice);

    // The switch is checked in SQL as well. This is the Edge's own gate:
    // anything but "enabled" stops the run.
    if (outcome.slice.switchState !== "enabled") {
      const reason = `switch_${outcome.slice.switchState}` as RetentionStopReason;
      return { state, stopReason: reason, failed: false };
    }
    if (!outcome.slice.hasMore) {
      return { state, stopReason: "completed", failed: false };
    }

    // A slice that considered no parent changed nothing. Another call
    // would meet the same locks and the same rows, so the run stops
    // instead of burning the budget on identical calls.
    if (outcome.slice.parentsConsidered === 0) {
      return { state, stopReason: "no_progress", failed: false };
    }
  }
}

/**
 * One invocation of the bounded competitor-retention cleanup.
 *
 * A dry run takes exactly one slice; a live run keeps taking slices until
 * the backlog is empty, the budget is spent, the time is short or a slice
 * fails. Every exit is audited, and the audit never changes the outcome.
 */
export async function runCompetitorRetention(args: {
  dryRun: boolean;
  ports: CompetitorRetentionPorts;
  clock?: () => number;
  budgetMs?: number;
  dependencyTimeoutMs?: number;
  minRemainingMs?: number;
}): Promise<CompetitorRetentionReport> {
  const clock = args.clock ?? Date.now;
  const budgetMs = args.budgetMs ?? RETENTION_BUDGET_MS;
  const dependencyTimeoutMs = args.dependencyTimeoutMs ?? RETENTION_DEPENDENCY_TIMEOUT_MS;
  const minRemainingMs = args.minRemainingMs ?? RETENTION_MIN_REMAINING_MS;
  const started = clock();

  const outcome = args.dryRun
    ? await runDryRun(args.ports, dependencyTimeoutMs)
    : await runLive(args.ports, {
      remainingMs: () => budgetMs - (clock() - started),
      timeoutMs: dependencyTimeoutMs,
      minRemainingMs,
    });

  const durationMs = Math.max(0, clock() - started);
  const state = outcome.state;

  await writeAudit(args.ports, {
    event: "retention_run",
    outcome: outcome.failed ? "failed" : outcome.stopReason === "completed" ? "completed" : "stopped",
    reason: outcome.stopReason,
    dry_run: args.dryRun,
    switch_state: state.switchState,
    slices: state.slices,
    parents_processed: state.parentsProcessed,
    parents_deleted: state.parentsDeleted,
    children_counted: state.childrenCounted,
    children_deleted: state.childrenDeleted,
    has_more: state.hasMore,
    duration_ms: durationMs,
  });

  return {
    dryRun: args.dryRun,
    slices: state.slices,
    parentsProcessed: state.parentsProcessed,
    parentsDeleted: state.parentsDeleted,
    parentsProjected: state.parentsProjected,
    parentsSkippedLiveLease: state.parentsSkippedLiveLease,
    parentsSkippedIneligible: state.parentsSkippedIneligible,
    childrenCounted: state.childrenCounted,
    childrenDeleted: state.childrenDeleted,
    hasMore: state.hasMore,
    switchState: state.switchState,
    stopReason: outcome.stopReason,
    failed: outcome.failed,
    durationMs,
  };
}

/**
 * The audit is best effort and bounded: a log table that is unavailable
 * must never change what the run did or what the caller is told.
 */
async function writeAudit(
  ports: CompetitorRetentionPorts,
  event: RetentionAuditEvent,
): Promise<void> {
  try {
    await withTimeout(ports.logAudit(event), RETENTION_DEPENDENCY_TIMEOUT_MS);
  } catch {
    console.error("[competitor-retention] the audit write failed");
  }
}
