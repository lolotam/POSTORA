/**
 * The bounded OWNER collection worker.
 *
 * WHAT THIS MODULE OWNS
 *
 *   The orchestration: the bounded drain, the claim, the bound-context check,
 *   the trusted capability, the protected credential read, the provider
 *   calls, the truthful inventory progress, the shared throttle and the
 *   fenced result writes. It owns no SQL, no HTTP and no request contract.
 *
 * THE STEPS OF ONE VISIT
 *
 *   A visit of ONE claimed job is a sequence of named steps, and every step
 *   either CONTINUES the visit with the state it produced or ENDS it with
 *   the outcome of the job. It never does both, so the orchestrator reads
 *   the outcome of a step in exactly one place:
 *
 *     readJobContext     the bound context and the truth of this visit;
 *     readTarget         the target account row;
 *     resolveCredential  the trusted capability, the credential, the bucket;
 *     checkThrottle      the shared window this credential is in;
 *     planOwedDays       the days this job owes, planned before the attempt;
 *     collectDays        the profile and the daily observations;
 *     sweepInventory     the media inventory;
 *     drainMediaQueue    the media insights, the bounded continuation;
 *     finalize           the truth of the inventory and the outcome.
 *
 *   The order IS the contract: the credential is resolved before the
 *   provider is used, the days are planned before they are collected, and
 *   the truth of the visit is recorded before the outcome that describes
 *   it.
 *
 *   The rate limit has ONE path as well: the checkpoint of the visit goes
 *   first, then the throttle record - job-scoped when the provider refused
 *   this job, shared when the usage budget of the bucket is nearly spent -
 *   and then the outcome. The media loop, the provider failure path, the
 *   shared window and the end of the visit all come through it, so they
 *   cannot drift.
 *
 * THE BUDGET
 *
 *   The whole run has forty seconds, counted from before the claim. EVERY
 *   step is bounded, not only the provider call: the claim and the reads
 *   must leave the five second write reserve behind, a provider call is only
 *   started when at least thirteen seconds remain, a media insights call is
 *   only started when at least four seconds plus the reserve remain, and
 *   the writes may use the reserve. Each step gets a signal that aborts at
 *   its deadline and is raced against it, so a store or transport that
 *   ignores the abort cannot keep the worker waiting.
 *
 *   A step that misses its deadline, or a store call that fails, ABANDONS
 *   the job to its lease: nothing is reported as stored and the lease is left
 *   to expire. A store failure whose outcome is UNKNOWN also stops the run.
 *
 *   A store failure the DATABASE itself refused is different: the fence
 *   raised, so the statement did not commit, and the condition belongs to
 *   that one job. The job is abandoned to its lease and the run continues
 *   with the next claimed owner.
 *
 *   An abandonment is never described as a recovery and never described as
 *   stored.
 *
 * THE BOUND CONTEXT
 *
 *   The accepted SQL refuses EVERY provider result write - progress,
 *   snapshot, completion and throttle parking - unless the job carries a
 *   captured viewer context whose credential generation and login kind are
 *   still live. For an OWNER job that context is captured by the claim
 *   itself: `claim_instagram_collection_jobs` binds the target account, its
 *   live credential generation and its login kind onto the claimed
 *   generation. `attach_instagram_collection_job_viewer_context` REFUSES an
 *   owner job ("an owner job is bound to its own account"), so this worker
 *   verifies the captured context instead of attaching one, and it refuses
 *   to spend a provider call when the resolved protected credential no
 *   longer carries the generation the context captured.
 *
 * THE LOGIN KINDS
 *
 *   The TRUSTED capability decides how an owner is collected, and the
 *   adapter and the token are chosen together from it. A page-linked
 *   account is collected through graph.facebook.com with the protected
 *   Facebook User credential. A direct account is collected through
 *   graph.instagram.com with the operational token the fenced direct
 *   reader returns. A host and a token never come from different logins.
 *
 * ONE JOB NEVER STALLS THE OTHERS
 *
 *   A condition that belongs to ONE job - a missing context, a target that
 *   is gone, a credential that was replaced, a shared bucket that is still
 *   throttled for that credential, a write the database refused because the
 *   lease or the generation moved on - ends that job and lets the run
 *   continue with the next claimed job. Only a condition that belongs to
 *   EVERYONE stops the run: a provider rate limit or a nearly spent usage
 *   budget that was actually observed on a response, the run budget, the
 *   outer abort, or a store failure whose outcome is unknown.
 *
 * THE DAYS THIS JOB OWES
 *
 *   The capture day is never a daily measurement: it is still running in
 *   Kuwait while the worker runs. The job therefore owes the LAST COMPLETED
 *   Kuwait day (D-1) as its primary observation and the day before it (D-2)
 *   as its correction observation. The capture day itself never changes:
 *   the daily snapshot carries its own provider date, metric date and
 *   period, and the accepted SQL upserts it per (account, metric date).
 *
 *   Both days are planned before the first attempt, through the accepted
 *   operations contract, so a day that does not fit the budget survives the
 *   visit that planned it: a `pending` operation keeps the job claimable
 *   and keeps a `completed` completion refused until the day is collected.
 *
 * THE MEDIA CONTINUATION
 *
 *   The media inside the ninety day window are ordered by publication time
 *   descending with a stable media-id tie-break, and the ones that still
 *   owe their insights are kept in the accepted checkpoint as a queue. The
 *   queue is RESUMED on a later visit: it is never rebuilt as "the newest
 *   few". One visit collects the insights of at most five media, one after
 *   the other, and a media leaves the queue only after its snapshot was
 *   persisted.
 *
 *   A media that FAILED goes to the BACK of that queue. A media that keeps
 *   its place at the head would block every media behind it for as long as
 *   it keeps failing, and the queue would never drain.
 *
 *   A DEFINITIVE refusal of ONE media closes that media and only that
 *   media: the provider answers with a Graph error object of code 10 or
 *   100, which is its own statement that this media has no insights to
 *   give. The item is written as `unavailable`, it leaves the queue, and
 *   the JOB is not closed by it. A refusal of the ACCOUNT endpoints - the
 *   profile, the account insights and the media list - is a different
 *   thing: it closes the job, because the data is not obtainable with that
 *   credential at all.
 *
 * THE END OF A CONTINUATION
 *
 *   A job that keeps coming back must stop coming back. The capture day
 *   may be continued on the capture day itself and on the next Kuwait day;
 *   after that the continuation would cross into the next capture day's
 *   job, so the job is finished with a terminal outcome
 *   (`unavailable`, reason `continuation_expired`) and the work that is
 *   still owed is recorded as the gap it is.
 *
 *   A day the provider answered with NO metric is not a failure and not an
 *   open question: the answer was well formed and it was empty, so the day
 *   is collected with null metrics - the truthful availability - and the
 *   job does not keep it.
 *
 * THE THROTTLE
 *
 *   A provider rate limit parks the job: the job-scoped throttle record
 *   releases the lease and puts the job into a fenced retry. A parked job is
 *   NOT completed afterwards - a parked job and a completed job are two
 *   different states - and the run stops.
 *
 *   A nearly spent usage budget is a SHARED bucket state: it is recorded
 *   against the bucket alone, the collected job is completed as a partial,
 *   and the run stops so the next worker sees the window.
 *
 * THE TRUTH OF THE INVENTORY
 *
 *   The progress record says what the provider actually returned: how many
 *   pages were fetched, whether the sweep was truncated at the page cap,
 *   the oldest publication instant that came back, whether the ninety day
 *   window was covered, and which work is still owed. A truncated inventory
 *   is not a full success, and the accepted SQL refuses a `completed`
 *   completion for one.
 */

import {
  InstagramGraphProvider,
  MEDIA_INSIGHT_ATTEMPT_TIMEOUT_MS,
  OwnerProviderError,
  USAGE_STOP_PERCENT,
  type MediaSweepStop,
  type OwnerAccountDay,
  type OwnerMediaInsights,
  type OwnerMediaSweep,
  type OwnerProfileObservation,
  type OwnerProviderResult,
} from "./graphProvider.ts";
import { InstagramDirectGraphProvider } from "./directGraphProvider.ts";
import {
  OwnerWorkerStoreError,
  type OwnerCapability,
  type OwnerCollectionServiceStore,
  type OwnerInventoryProgressPayload,
  type OwnerMediaInventoryRow,
  type OwnerSnapshotPayload,
  type OwnerTarget,
} from "./workerStore.ts";
import type { ClaimedOwnerJob } from "./receipts.ts";

/** The whole run, counted from before the first claim. */
export const WORKER_TOTAL_BUDGET_MS = 40_000;

/** The provider ceiling of one attempt: headers AND body. */
export const WORKER_PROVIDER_CEILING_MS = 8_000;

/** The reserve for the writes and the log. */
export const WORKER_WRITE_RESERVE_MS = 5_000;

/** The claim size. It is the production limit and it does not shrink. */
export const OWNER_CLAIM_LIMIT = 25;

/**
 * The shared throttle window recorded when the provider throttles without a
 * deadline of its own, or when the usage budget is nearly spent.
 */
export const THROTTLE_WINDOW_MS = 15 * 60_000;

/** The length of the media inventory window, in days. */
export const MEDIA_WINDOW_DAYS = 90;

/** The pages one attempt fetches before it stops and resumes later. */
export const MEDIA_PAGES_PER_ATTEMPT = 2;

/**
 * The media whose insights one visit collects.
 *
 * It is a ceiling and not a promise: a media call is only started when it
 * fits the remaining budget and the write reserve.
 */
export const MEDIA_INSIGHTS_PER_VISIT = 5;

/**
 * The size of the pending queue the accepted checkpoint accepts.
 *
 * The accepted SQL refuses more than five hundred remaining ids, so the
 * queue is capped and the cap is recorded as a gap rather than hidden.
 */
export const MEDIA_QUEUE_LIMIT = 500;

/**
 * The durable gap: the queue could not hold every media of the window.
 *
 * It is the one gap reason that survives a later visit: the media beyond the
 * cap are never queued, so the limitation is part of the report and not a
 * state of this visit only.
 */
const MEDIA_QUEUE_CAPPED = "media_queue_capped";

/**
 * The gap of a continuation that outlived its capture day.
 *
 * The work that is still owed is not lost and not hidden: the checkpoint
 * carries it, and the window that is not covered is stated.
 */
const CONTINUATION_EXPIRED = "continuation_expired";

/**
 * The item-level reason of a media the provider refused for good.
 *
 * It belongs to the ITEM, not to the job: the media is closed, the job is
 * not. The accepted SQL stores the item's state - `unavailable` - and has
 * no column for the reason of one item, so the reason lives in the worker's
 * bounded log.
 */
const MEDIA_INSIGHTS_UNAVAILABLE = "media_insights_unavailable";

/**
 * The Graph error codes that are a refusal of ONE media.
 *
 * Meta answers a media it will never answer - a media without insights, a
 * media it has no permission to read - with a Graph error object of code 10
 * or 100. The refusal is about that media, and it is permanent.
 */
const DEFINITIVE_MEDIA_GRAPH_CODES: ReadonlySet<number> = new Set([10, 100]);

/**
 * The number of Kuwait days a capture day may be continued for.
 *
 * The capture day itself and the next Kuwait day are the continuation of the
 * same capture. On the day after that the continuation would cross into the
 * next capture day's job, and the job is finished instead.
 */
export const CONTINUATION_MAX_AGE_DAYS = 1;

/**
 * The offset of Asia/Kuwait, in hours.
 *
 * The days of this worker are KUWAIT days: the capture day is still running
 * in Kuwait while the worker runs, and the window of a capture day is
 * counted in the same calendar.
 */
const KUWAIT_OFFSET_MS = 3 * 60 * 60 * 1000;

/**
 * The permission an Instagram-login account needs to read its insights.
 *
 * Meta documents the Instagram API with Instagram Login as
 * `instagram_business_basic` plus `instagram_business_manage_insights`
 * (https://developers.facebook.com/documentation/instagram-platform/api-reference/instagram-user/insights).
 */
export const DIRECT_INSIGHTS_SCOPE = "instagram_business_manage_insights";

/**
 * The stable reason codes.
 *
 * They are lower-case snake_case because the accepted SQL validates them as
 * such, and they carry no provider text: the raw provider message never
 * becomes a reason code, a stored `last_reason_code`, a log line or a
 * client response.
 */
export type OwnerReasonCode =
  /** The provider rejected the credential (Meta code 190). */
  | "token_invalid"
  /** The provider refused the permission (Meta codes 10 and 200). */
  | "scope_missing"
  /** The provider is rate limiting, or the usage budget is nearly spent. */
  | "rate_limited"
  /** The provider failed in a way that is worth retrying. */
  | "provider_error"
  /** The credential or the captured context changed under the attempt. */
  | "credential_changed"
  /**
   * The database's own fence refused the write: the lease or the job
   * generation moved on, so the statement did not commit and the job is
   * abandoned to its lease.
   */
  | "stale_claim"
  /** The account owns no usable protected credential. */
  | "credential_unavailable"
  /**
   * The account logs in with Instagram directly and its TRUSTED capability
   * says so POSITIVELY: the insights permission is missing from an
   * authoritative scope set. The data is not obtainable with this
   * connection, so the job is closed with a stable, non-looping outcome.
   *
   * It is NOT the answer for a direct account that merely has an unknown
   * scope set: an unknown set is not a denial.
   */
  | "direct_login_unsupported"
  /** The media inventory did not cover the window. */
  | "inventory_incomplete"
  /** The media inventory cannot be completed for this account. */
  | "inventory_unavailable"
  /**
   * The continuation of this capture day outlived the capture day.
   *
   * It is terminal: the work that is still owed is recorded as a gap, and
   * the next capture day's job owns the window from now on.
   */
  | "continuation_expired"
  /** A daily observation is still owed. */
  | "daily_observation_pending"
  /** The insights of one or more media are still owed. */
  | "media_insights_pending"
  /** The job carries no bound connection context. */
  | "context_missing"
  /** The target account row is gone. */
  | "target_missing"
  /** A store call failed or a step ran out of budget. Nothing was stored. */
  | "storage_error"
  /** A step did not finish inside the run budget. */
  | "deadline_exceeded";

/** The outcome of one processed job. */
export type OwnerJobOutcome =
  | "completed"
  | "partial"
  | "retry"
  | "unavailable"
  | "abandoned";

/** One processed job. */
export interface ProcessedOwnerJob {
  readonly jobId: string;
  readonly socialAccountId: string;
  readonly outcome: OwnerJobOutcome;
  readonly reasonCode: OwnerReasonCode | null;
}

/** The summary of one drain. */
export interface OwnerDrainSummary {
  readonly claimed: number;
  readonly processed: number;
  readonly completed: number;
  readonly partial: number;
  readonly retried: number;
  readonly unavailable: number;
  readonly abandoned: number;
  readonly stoppedEarly: boolean;
  readonly jobs: readonly ProcessedOwnerJob[];
}

/** A stable, bounded log event. It never carries a credential. */
export interface OwnerWorkerLogEvent {
  readonly event: string;
  readonly jobId?: string;
  readonly socialAccountId?: string;
  readonly outcome?: string;
  readonly reasonCode?: string;
  readonly usagePercent?: number;
  readonly durationMs?: number;
  /** A count of media, never the media themselves. */
  readonly mediaCount?: number;
}

/**
 * The provider surface the worker collects through.
 *
 * Both adapters implement it: the Facebook-login one and the
 * Instagram-login one. The adapter is chosen from the TRUSTED login kind,
 * never from a flag the caller supplies, so the host and the token always
 * belong to the same login.
 */
export interface OwnerCollectionProvider {
  fetchAccountProfile(input: {
    readonly igUserId: string;
    readonly token: string;
    readonly signal: AbortSignal;
  }): Promise<OwnerProviderResult<OwnerProfileObservation>>;
  fetchAccountDay(input: {
    readonly igUserId: string;
    readonly token: string;
    readonly date: string;
    readonly signal: AbortSignal;
  }): Promise<OwnerProviderResult<OwnerAccountDay>>;
  fetchMediaInsights(input: {
    readonly igMediaId: string;
    readonly token: string;
    readonly mediaProductType: string | null;
    readonly mediaType: string | null;
    readonly signal: AbortSignal;
  }): Promise<OwnerProviderResult<OwnerMediaInsights>>;
  fetchMediaWindow(input: {
    readonly igUserId: string;
    readonly token: string;
    readonly windowStart: string;
    readonly windowEnd: string;
    readonly cursor: string | null;
    readonly maxPages: number;
    readonly pageSize?: number;
    readonly signal: AbortSignal;
  }): Promise<OwnerProviderResult<OwnerMediaSweep>>;
}

/** The ports of the owner collection worker. */
export interface OwnerWorkerPorts {
  readonly store: OwnerCollectionServiceStore;
  /** The Facebook-login provider. */
  readonly provider: InstagramGraphProvider;
  /** The Instagram-login provider. It is a different host and a different token. */
  readonly directProvider: InstagramDirectGraphProvider;
  /**
   * The shared throttle bucket key of a protected credential.
   *
   * It is a digest of the app and the protected credential's id (never the
   * token), because Meta meters a User token per app and every account bound
   * to that grant shares it.
   */
  readonly bucketKeyFor: (credentialId: string) => Promise<string>;
  /** The clock. Injectable so the budget is testable. */
  readonly now: () => number;
  /**
   * The whole-run budget in milliseconds.
   *
   * It defaults to the forty second production budget. The shipped
   * composition does NOT override it; the override exists so a test can
   * exercise the deadline without waiting forty seconds.
   */
  readonly budgetMs?: number;
  /** The bounded log sink. */
  readonly log: (event: OwnerWorkerLogEvent) => void;
}

/** The budget of one run. */
export interface OwnerWorkerBudget {
  readonly startedAt: number;
  readonly totalMs: number;
  remainingMs(): number;
  /** True when there is still enough time to start a provider call. */
  canStartProviderCall(): boolean;
}

export function createOwnerWorkerBudget(
  now: () => number,
  totalMs: number = WORKER_TOTAL_BUDGET_MS,
): OwnerWorkerBudget {
  const startedAt = now();
  return {
    startedAt,
    totalMs,
    remainingMs: () => totalMs - (now() - startedAt),
    canStartProviderCall: () =>
      totalMs - (now() - startedAt) >=
        WORKER_PROVIDER_CEILING_MS + WORKER_WRITE_RESERVE_MS,
  };
}

/** A step that did not finish inside its share of the budget. */
export class BudgetExceededError extends Error {
  constructor() {
    super("The collection step did not finish inside the budget.");
    this.name = "BudgetExceededError";
  }
}

/**
 * Runs one step inside the remaining budget minus `reserveMs`.
 *
 * The step receives a signal that aborts at that deadline (or when the outer
 * signal aborts) and is raced against it, so a store or transport that
 * ignores the abort cannot keep the worker waiting. A late settlement is
 * consumed. It is exported so the guard can be exercised on its own.
 */
export async function boundedStep<T>(
  budget: OwnerWorkerBudget,
  reserveMs: number,
  outer: AbortSignal | undefined,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const available = budget.remainingMs() - reserveMs;
  if (available <= 0 || outer?.aborted) throw new BudgetExceededError();

  const controller = new AbortController();
  const onOuterAbort = () => controller.abort();
  outer?.addEventListener("abort", onOuterAbort, { once: true });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    const expire = () => {
      controller.abort();
      reject(new BudgetExceededError());
    };
    timer = setTimeout(expire, available);
    controller.signal.addEventListener("abort", expire, { once: true });
  });
  deadline.catch(() => undefined);

  let pending: Promise<T>;
  try {
    pending = Promise.resolve(work(controller.signal));
  } catch (error) {
    pending = Promise.reject(error);
  }
  pending.catch(() => undefined);

  try {
    return await Promise.race([pending, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    outer?.removeEventListener("abort", onOuterAbort);
  }
}

// ---------------------------------------------------------------------------
// The drain
// ---------------------------------------------------------------------------

/**
 * The bounded drain.
 *
 * It claims the production limit, processes as many of those jobs as the
 * budget allows, and leaves the rest to be recovered after their lease.
 */
export async function runOwnerDrain(
  ports: OwnerWorkerPorts,
  input: { readonly signal?: AbortSignal } = {},
): Promise<OwnerDrainSummary> {
  const budget = createOwnerWorkerBudget(ports.now, ports.budgetMs ?? WORKER_TOTAL_BUDGET_MS);

  const summary: {
    claimed: number;
    processed: number;
    completed: number;
    partial: number;
    retried: number;
    unavailable: number;
    abandoned: number;
    stoppedEarly: boolean;
    jobs: ProcessedOwnerJob[];
  } = {
    claimed: 0,
    processed: 0,
    completed: 0,
    partial: 0,
    retried: 0,
    unavailable: 0,
    abandoned: 0,
    stoppedEarly: false,
    jobs: [],
  };

  let jobs: ClaimedOwnerJob[];
  try {
    // The claim is bounded too: it must leave the write reserve behind.
    jobs = await boundedStep(
      budget,
      WORKER_WRITE_RESERVE_MS,
      input.signal,
      (signal) => ports.store.claimOwnerJobs({ limit: OWNER_CLAIM_LIMIT, signal }),
    );
  } catch {
    // Whether the claim committed is unknown. Any job it leased is recovered
    // when that lease expires; nothing is invented here.
    ports.log({ event: "owner_claim_abandoned", outcome: "abandoned" });
    summary.stoppedEarly = true;
    return summary;
  }

  summary.claimed = jobs.length;

  for (const job of jobs) {
    if (input.signal?.aborted || !budget.canStartProviderCall()) {
      // The remaining jobs keep their leases and are recovered when the
      // lease expires. They are never dropped.
      summary.stoppedEarly = true;
      break;
    }

    const processed = await processClaimedJob(ports, job, budget, input.signal);
    summary.jobs.push(processed.job);

    if (processed.job.outcome === "abandoned") {
      summary.abandoned += 1;
    } else {
      summary.processed += 1;
      if (processed.job.outcome === "completed") summary.completed += 1;
      else if (processed.job.outcome === "partial") summary.partial += 1;
      else if (processed.job.outcome === "unavailable") summary.unavailable += 1;
      else summary.retried += 1;
    }

    if (processed.stopRun) {
      summary.stoppedEarly = true;
      break;
    }
  }

  return summary;
}

/** One processed job, and whether the run must stop after it. */
interface JobStep {
  readonly job: ProcessedOwnerJob;
  readonly stopRun: boolean;
}

interface JobContext {
  readonly ports: OwnerWorkerPorts;
  readonly job: ClaimedOwnerJob;
  readonly budget: OwnerWorkerBudget;
  readonly outer: AbortSignal | undefined;
  readonly startedAt: number;
}

/**
 * The truth of ONE visit, as far as the visit knows it.
 *
 * It is one object because every exit has to be able to record it: the days
 * that were collected, the media that still owe their insights, the cursor
 * the next visit resumes from and the coverage of the window. A visit that
 * stops half way records what it did, so the next visit does not ask for it
 * again.
 */
interface OwnerVisitState {
  /** The days this job owes, planned before the first attempt. */
  owedDays: string[];
  /** The days that were collected, with their metrics or without them. */
  collectedDays: string[];
  /** The media that still owe their insights, in the order they are owed. */
  mediaQueue: string[];
  /** The cursor the next visit resumes the media sweep from. */
  cursor: string | null;
  /** The pages the media sweep fetched so far. */
  pagesFetched: number;
  /** The oldest publication instant the provider returned. */
  oldestReturnedAt: string | null;
  /** The start of the media window. */
  windowStart: string;
  /** The end of the media window. */
  windowEnd: string;
  /** True when the media inventory was cut short. */
  truncated: boolean;
  /** True when the media window was covered. */
  windowCovered: boolean;
  /** The gap of this visit, when there is one. */
  gapReason: string | null;
  /** Why the media sweep stopped, when it ran. */
  sweepStopped: MediaSweepStop | null;
  /** The highest usage percentage the provider reported. */
  usagePercent: number;
  /** True when the usage budget is nearly spent. */
  usageStop: boolean;
}

/**
 * Processes one claimed job.
 *
 * Every exit either writes a verified outcome or abandons the job to its
 * lease. The two are never mixed.
 */
async function processClaimedJob(
  ports: OwnerWorkerPorts,
  job: ClaimedOwnerJob,
  budget: OwnerWorkerBudget,
  outer: AbortSignal | undefined,
): Promise<JobStep> {
  const context: JobContext = {
    ports,
    job,
    budget,
    outer,
    startedAt: ports.now(),
  };

  try {
    return await collect(context);
  } catch (error) {
    // A DEFINITIVE refusal of THIS job: the database's own fence raised, so
    // the statement did not commit and the condition belongs to this job
    // alone. The job is abandoned to its lease and the run continues with the
    // next claimed owner: one reconnecting account must not stall every
    // other owner in the run.
    const refusal = definitivePerJobRefusal(error);
    if (refusal !== null) {
      return await abandon(context, refusal);
    }

    // A store failure, a refused write or a step that ran out of budget. The
    // outcome is unknown, so nothing is reported as stored and the run stops.
    const reasonCode: OwnerReasonCode = error instanceof BudgetExceededError
      ? "deadline_exceeded"
      : "storage_error";
    ports.log({
      event: "owner_job_abandoned",
      jobId: job.jobId,
      socialAccountId: job.socialAccountId,
      outcome: "abandoned",
      reasonCode,
      durationMs: ports.now() - context.startedAt,
    });
    return {
      job: {
        jobId: job.jobId,
        socialAccountId: job.socialAccountId,
        outcome: "abandoned",
        reasonCode,
      },
      stopRun: true,
    };
  }
}

/**
 * The store failures that are a DEFINITIVE refusal of ONE job.
 *
 * `stale_claim` and `credential_changed` are raised by the database's own
 * fence: the lease moved on, or the connection was replaced under the
 * attempt. The statement did not commit, so nothing is reported as stored,
 * and the condition belongs to this job alone - the run continues with the
 * next claimed owner.
 *
 * Every other failure keeps the run-ending behaviour: the outcome of the
 * statement is unknown, so the run stops rather than repeating a write that
 * may already have committed.
 */
function definitivePerJobRefusal(error: unknown): OwnerReasonCode | null {
  if (!(error instanceof OwnerWorkerStoreError)) return null;
  if (error.failure === "stale_claim") return "stale_claim";
  if (error.failure === "credential_changed") return "credential_changed";
  return null;
}

function result(
  context: JobContext,
  outcome: OwnerJobOutcome,
  reasonCode: OwnerReasonCode | null,
): ProcessedOwnerJob {
  return {
    jobId: context.job.jobId,
    socialAccountId: context.job.socialAccountId,
    outcome,
    reasonCode,
  };
}

/** A read step: it must leave the write reserve behind. */
function read<T>(context: JobContext, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  return boundedStep(context.budget, WORKER_WRITE_RESERVE_MS, context.outer, work);
}

/** A write step: it may use the reserve, and it is never retried. */
function write<T>(context: JobContext, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  return boundedStep(context.budget, 0, context.outer, work);
}

/**
 * A provider step.
 *
 * It must leave the write reserve behind, its signal aborts at that
 * deadline, and it is raced so an abort-ignoring transport cannot outlive it.
 */
function providerStep<T>(
  context: JobContext,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  return boundedStep(context.budget, WORKER_WRITE_RESERVE_MS, context.outer, work);
}

/**
 * True when another media insights call still fits.
 *
 * A media call is bounded to four seconds and it must leave the write
 * reserve behind, so it is only started while that much time is left. The
 * forty second run is shared by every claimed job.
 */
function canStartMediaInsightCall(context: JobContext): boolean {
  return context.budget.remainingMs() >=
    MEDIA_INSIGHT_ATTEMPT_TIMEOUT_MS + WORKER_WRITE_RESERVE_MS;
}

/**
 * The bound context of an owner job.
 *
 * The claim binds the target account itself, so the captured viewer must be
 * the target and the captured generation must be present. A job whose context
 * is missing cannot be written at all: the accepted SQL refuses every
 * provider result write without one.
 */
function verifyBoundContext(job: ClaimedOwnerJob): boolean {
  const context = job.context;
  if (context.viewerSocialAccountId === null) return false;
  if (context.credentialGeneration === null) return false;
  if (context.loginKind === null) return false;
  return context.viewerSocialAccountId.toLowerCase() === job.socialAccountId.toLowerCase();
}

/** The ninety day media window of a capture day. */
function mediaWindowStart(capturedOn: string): string {
  const parsed = new Date(`${capturedOn}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return capturedOn;
  parsed.setUTCDate(parsed.getUTCDate() - MEDIA_WINDOW_DAYS);
  return parsed.toISOString().slice(0, 10);
}

/**
 * The day before the given calendar day.
 *
 * The days are counted in Asia/Kuwait, and the capture day is never one of
 * them: the capture day is still running while the worker runs.
 */
function previousDay(day: string): string {
  const parsed = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return day;
  parsed.setUTCDate(parsed.getUTCDate() - 1);
  return parsed.toISOString().slice(0, 10);
}

/**
 * The Kuwait calendar day of an instant.
 *
 * The days of this worker are KUWAIT days, because the capture day is still
 * running in Kuwait while the worker runs.
 */
function kuwaitDayOf(instantMs: number): string {
  return new Date(instantMs + KUWAIT_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * The number of days from one calendar day to another.
 *
 * Both days are `YYYY-MM-DD`, so they are counted at UTC midnight and the
 * answer is a whole number of days.
 */
function daysBetween(from: string, to: string): number {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end)) return 0;
  return Math.round((end - start) / 86_400_000);
}

/**
 * True when the continuation of this capture day has outlived the capture
 * day.
 *
 * The capture day may be continued on the capture day itself and on the next
 * Kuwait day. After that the continuation would cross into the next capture
 * day's job, and the job is finished instead of coming back.
 */
function continuationExpired(capturedOn: string, nowMs: number): boolean {
  const age = daysBetween(capturedOn, kuwaitDayOf(nowMs));
  return age > CONTINUATION_MAX_AGE_DAYS;
}

/**
 * The token that names a planned daily observation inside the queue.
 *
 * The queue of the accepted checkpoint holds the work that is still owed.
 * A daily observation and a media id are both owed work, and the token is
 * how the two are told apart.
 */
function accountDayToken(day: string): string {
  return `account_day:${day}`;
}

const ACCOUNT_DAY_TOKEN = /^account_day:(\d{4}-\d{2}-\d{2})$/;

/** The day a queue token names, or null when it names a media. */
function plannedDayFromToken(token: string): string | null {
  const match = ACCOUNT_DAY_TOKEN.exec(token);
  return match === null ? null : match[1]!;
}

/**
 * The operation key the accepted SQL gives a daily observation.
 *
 * The snapshot writer builds the very same key, so writing the snapshot is
 * what closes the planned operation.
 */
function accountDayOperationKey(day: string): string {
  return `account_day:${day}:interactions`;
}

/**
 * Orders the media of one sweep.
 *
 * The publication time decides, and the media id breaks a tie, so the order
 * of the queue is stable between visits.
 */
function compareMediaItems(
  left: { readonly published_at: string; readonly ig_media_id: string },
  right: { readonly published_at: string; readonly ig_media_id: string },
): number {
  if (left.published_at !== right.published_at) {
    return left.published_at < right.published_at ? 1 : -1;
  }
  if (left.ig_media_id === right.ig_media_id) return 0;
  return left.ig_media_id < right.ig_media_id ? -1 : 1;
}

/**
 * The insight metrics a stored media row already carries.
 *
 * They are carried into the next inventory write, so the accepted upsert
 * writes the SAME values back instead of nulling them. Only the metrics
 * the accepted `owner_media` whitelist can store are carried; the public
 * counts are not, because the sweep reports them again.
 */
function carriedInsightMetrics(
  row: OwnerMediaInventoryRow | undefined,
): Record<string, number> {
  if (row === undefined) return {};

  const carried: Record<string, number> = {};
  const entries: ReadonlyArray<readonly [string, number | null]> = [
    ["views", row.views],
    ["reach", row.reach],
    ["likes", row.likes],
    ["comments", row.comments],
    ["saved", row.saved],
    ["shares", row.shares],
    ["total_interactions", row.totalInteractions],
    ["follows", row.follows],
    ["profile_visits", row.profileVisits],
    ["replies", row.replies],
    ["ig_reels_avg_watch_time_ms", row.igReelsAvgWatchTimeMs],
  ];

  for (const [name, value] of entries) {
    if (value === null) continue;
    carried[name] = value;
  }
  return carried;
}

/**
 * True when the media owes nothing for this capture day.
 *
 * A stored insight metric is proof that the insights were collected. A
 * stored 'unavailable' status is the provider's own documented statement
 * that this media type has no insights at all, and it is terminal too.
 *
 * A row that exists but carries no insight metric was INVENTORIED and not
 * collected: Meta documents that an empty insights answer means the data
 * does not exist yet or is not available yet, so it is not evidence that the
 * media will never have insights. Such a media is queued again, and the
 * re-read is idempotent: it never corrupts a stored metric.
 */
function isCollectedMedia(row: OwnerMediaInventoryRow | undefined): boolean {
  if (row === undefined) return false;
  if (row.status === "unavailable") return true;
  return Object.keys(carriedInsightMetrics(row)).length > 0;
}

// ---------------------------------------------------------------------------
// The steps of ONE visit
// ---------------------------------------------------------------------------

/**
 * The result of ONE step of a visit.
 *
 * A step either CONTINUES the visit with the state it produced, or it ENDS
 * the visit with the outcome of the job. It never does both, so the
 * orchestrator reads the outcome of a step in exactly one place.
 */
type StepResult<T> =
  | { readonly kind: "continue"; readonly state: T }
  | { readonly kind: "end"; readonly step: JobStep };

/**
 * The provider, the token and the bucket of ONE visit.
 *
 * The adapter and the token are chosen TOGETHER, from the TRUSTED login
 * kind. A page-linked account is collected through graph.facebook.com with
 * the protected Facebook User credential; a direct account is collected
 * through graph.instagram.com with the operational token the fenced direct
 * reader returns. A host and a token never come from different logins.
 */
interface VisitCredential {
  readonly provider: OwnerCollectionProvider;
  /** The token. It is never logged, returned or serialised. */
  readonly token: string;
  /** The shared throttle bucket key of this credential. */
  readonly bucketKey: string;
}

/**
 * The visit of ONE claimed job.
 *
 * The visit is a sequence of steps, and every step either continues the
 * visit with the state it produced or ends it with the outcome of the job:
 *
 *   readJobContext    the bound context and the truth of this visit;
 *   readTarget        the target account row;
 *   resolveCredential the trusted capability, the credential and the bucket;
 *   checkThrottle     the shared window this credential is in;
 *   planOwedDays      the days this job owes, planned before the attempt;
 *   collectDays       the profile and the daily observations;
 *   sweepInventory    the media inventory;
 *   drainMediaQueue   the media insights, the bounded continuation;
 *   finalize          the truth of the inventory and the outcome.
 *
 * The order IS the contract: the credential is resolved before the
 * provider is used, the days are planned before they are collected, and the
 * truth of the visit is recorded before the outcome that describes it.
 */
async function collect(context: JobContext): Promise<JobStep> {
  const contextStep = await readJobContext(context);
  if (contextStep.kind === "end") return contextStep.step;
  const visit = contextStep.state;

  const targetStep = await readTarget(context);
  if (targetStep.kind === "end") return targetStep.step;

  const credentialStep = await resolveCredential(context, visit);
  if (credentialStep.kind === "end") return credentialStep.step;
  const credential = credentialStep.state;

  const throttleStep = await checkThrottle(context, credential);
  if (throttleStep.kind === "end") return throttleStep.step;

  const planStep = await planOwedDays(context, visit);
  if (planStep.kind === "end") return planStep.step;

  const daysStep = await collectDays(context, visit, targetStep.state, credential);
  if (daysStep.kind === "end") return daysStep.step;

  const sweepStep = await sweepInventory(context, visit, targetStep.state, credential);
  if (sweepStep.kind === "end") return sweepStep.step;

  const queueStep = await drainMediaQueue(context, visit, credential);
  if (queueStep.kind === "end") return queueStep.step;

  return await finalize(context, visit, credential);
}

/**
 * The truth of ONE visit, as the claim carries it.
 *
 * It is the state every step works on, and EVERY exit records it: the days
 * that were collected, the media that still owe their insights, the cursor
 * the next visit resumes from and the coverage of the window. A visit that
 * stops half way records what it did, so the next visit does not ask for it
 * again.
 */
function createVisitState(job: ClaimedOwnerJob): OwnerVisitState {
  const checkpoint = job.checkpoint;

  const visit: OwnerVisitState = {
    owedDays: [],
    collectedDays: [],
    mediaQueue: [],
    cursor: checkpoint.cursor,
    pagesFetched: checkpoint.pagesFetched,
    oldestReturnedAt: checkpoint.oldestReturnedAt,
    windowStart: checkpoint.windowStart ?? mediaWindowStart(job.capturedOn),
    windowEnd: checkpoint.windowEnd ?? job.capturedOn,
    truncated: checkpoint.truncated,
    windowCovered: checkpoint.windowCovered,
    gapReason: checkpoint.gapReason,
    sweepStopped: checkpoint.windowCovered ? "window_covered" : null,
    usagePercent: 0,
    usageStop: false,
  };

  // The queue of the work that is still owed, as the claim carries it.
  const queuedTokens = [...checkpoint.remainingIds];
  const queuedDays: string[] = [];
  for (const token of queuedTokens) {
    const day = plannedDayFromToken(token);
    if (day !== null && !queuedDays.includes(day)) queuedDays.push(day);
  }
  visit.owedDays = queuedDays;
  visit.mediaQueue = queuedTokens.filter((token) => plannedDayFromToken(token) === null);

  return visit;
}

/**
 * The bound context of this visit, and the truth it starts from.
 *
 * A job without a captured context cannot be written at all: the accepted
 * SQL refuses every provider result write without one. Such a job is
 * abandoned to its lease and the run continues - one unusable job must not
 * stall every other owner.
 *
 * A job that keeps coming back must stop coming back, so a continuation
 * that outlived its capture day is finished here, before a provider call is
 * spent on a capture day that has moved on.
 */
async function readJobContext(
  context: JobContext,
): Promise<StepResult<OwnerVisitState>> {
  const { ports, job } = context;

  if (!verifyBoundContext(job)) {
    // Nothing can be written for this job, so there is nothing to record.
    // The lease is left to expire and the job is recovered later - but the
    // RUN continues: one unusable job must not stall every other owner.
    ports.log({
      event: "owner_job_abandoned",
      jobId: job.jobId,
      socialAccountId: job.socialAccountId,
      outcome: "abandoned",
      reasonCode: "context_missing",
      durationMs: ports.now() - context.startedAt,
    });
    return {
      kind: "end",
      step: { job: result(context, "abandoned", "context_missing"), stopRun: false },
    };
  }

  const visit = createVisitState(job);

  if (continuationExpired(job.capturedOn, context.startedAt)) {
    return { kind: "end", step: await expireContinuation(context, visit) };
  }

  return { kind: "continue", state: visit };
}

/**
 * The target account of this visit.
 *
 * The account row is gone: the job cannot be collected for an account that
 * is not there. It is abandoned to its lease and the run continues.
 */
async function readTarget(context: JobContext): Promise<StepResult<OwnerTarget>> {
  const { ports, job } = context;

  const target = await read(context, (signal) =>
    ports.store.readOwnerTarget({
      socialAccountId: job.socialAccountId,
      userId: job.userId,
      signal,
    })
  );

  if (!target) {
    ports.log({
      event: "owner_job_abandoned",
      jobId: job.jobId,
      socialAccountId: job.socialAccountId,
      outcome: "abandoned",
      reasonCode: "target_missing",
      durationMs: ports.now() - context.startedAt,
    });
    return {
      kind: "end",
      step: { job: result(context, "abandoned", "target_missing"), stopRun: false },
    };
  }

  return { kind: "continue", state: target };
}

/**
 * The trusted capability, the credential and the bucket of this visit.
 *
 * The capability is read BEFORE the protected credential, because a
 * direct-login account has no protected Facebook User credential at all.
 *
 * Every refusal here belongs to THIS job alone: the job is abandoned to its
 * lease, and the run continues with the next claimed owner.
 */
async function resolveCredential(
  context: JobContext,
  visit: OwnerVisitState,
): Promise<StepResult<VisitCredential>> {
  const { ports, job } = context;

  let capability;
  try {
    capability = await read(context, (signal) =>
      ports.store.readOwnerCapability({
        userId: job.userId,
        socialAccountId: job.socialAccountId,
        signal,
      })
    );
  } catch (error) {
    if (error instanceof OwnerWorkerStoreError && error.failure === "credential_missing") {
      return {
        kind: "end",
        step: await persistFailure(context, "retry", "credential_unavailable"),
      };
    }
    throw error;
  }

  if (capability.loginKind === "direct") {
    return await resolveDirectCredential(context, visit, capability);
  }
  return await resolveProtectedCredential(context, capability);
}

/**
 * The operational token of a DIRECT Instagram login.
 *
 * It comes from the fenced direct reader and from nowhere else. The account
 * row's `access_token` is never read by this worker.
 *
 * The scope set is authoritative only when the permission read succeeded. An
 * unknown scope set is NOT a denial, so it never closes the job: only a
 * positively missing permission does.
 */
async function resolveDirectCredential(
  context: JobContext,
  visit: OwnerVisitState,
  capability: OwnerCapability,
): Promise<StepResult<VisitCredential>> {
  const { ports, job } = context;

  if (
    capability.scopesAuthoritative &&
    !capability.grantedScopes.includes(DIRECT_INSIGHTS_SCOPE)
  ) {
    // The data is not obtainable with this connection. The checkpoint is
    // written before the terminal outcome, so the work that is still owed
    // is on the record and not only in this run.
    await recordVisitProgress(context, visit);
    return {
      kind: "end",
      step: await persistFailure(context, "unavailable", "direct_login_unsupported"),
    };
  }

  if (capability.credentialGeneration !== job.context.credentialGeneration) {
    // The connection was replaced after the claim. No provider call is
    // spent on a token whose generation no longer matches the connection,
    // and no write is attempted: every result write is fenced on that same
    // generation.
    return { kind: "end", step: await abandon(context, "credential_changed") };
  }

  let directCredential;
  try {
    directCredential = await read(context, (signal) =>
      ports.store.resolveDirectOwnerCredential({
        jobId: job.jobId,
        claimToken: job.claimToken,
        jobGeneration: job.jobGeneration,
        expectedCredentialGeneration: capability.credentialGeneration,
        socialAccountId: job.socialAccountId,
        signal,
      })
    );
  } catch (error) {
    if (error instanceof OwnerWorkerStoreError) {
      if (error.failure === "credential_missing") {
        return {
          kind: "end",
          step: await persistFailure(context, "retry", "credential_unavailable"),
        };
      }
      if (error.failure === "credential_changed") {
        return { kind: "end", step: await abandon(context, "credential_changed") };
      }
    }
    throw error;
  }

  if (directCredential.credentialGeneration !== capability.credentialGeneration) {
    return { kind: "end", step: await abandon(context, "credential_changed") };
  }

  // The bucket key is a digest of the app, the account and the credential
  // generation. It is never the token, and it is never a fabricated
  // Facebook credential id: a direct account has none.
  const bucketKey = await read(context, async (signal) => {
    void signal;
    return await ports.directProvider.bucketKey(
      job.socialAccountId,
      directCredential.credentialGeneration,
    );
  });

  return {
    kind: "continue",
    state: {
      provider: ports.directProvider,
      token: directCredential.accessToken,
      bucketKey,
    },
  };
}

/**
 * The protected Facebook User credential of a page-linked account.
 *
 * The protected credential adapter is the only authority for that token:
 * the account row's `access_token` is never read.
 */
async function resolveProtectedCredential(
  context: JobContext,
  capability: OwnerCapability,
): Promise<StepResult<VisitCredential>> {
  const { ports, job } = context;

  let credential;
  try {
    credential = await read(context, (signal) =>
      ports.store.resolveOwnerCredential({
        userId: job.userId,
        socialAccountId: job.socialAccountId,
        signal,
      })
    );
  } catch (error) {
    if (error instanceof OwnerWorkerStoreError) {
      if (error.failure === "credential_missing") {
        return {
          kind: "end",
          step: await persistFailure(context, "retry", "credential_unavailable"),
        };
      }
      if (error.failure === "credential_changed") {
        return { kind: "end", step: await abandon(context, "credential_changed") };
      }
    }
    throw error;
  }

  if (credential.capabilityGeneration !== capability.credentialGeneration) {
    // The connection was replaced between the two reads. No provider call
    // is spent on a token whose generation no longer matches the connection.
    return { kind: "end", step: await abandon(context, "credential_changed") };
  }

  if (credential.capabilityGeneration !== job.context.credentialGeneration) {
    // The connection was replaced after the claim. The captured context no
    // longer matches the live credential, so no provider call is spent on it
    // and no write is attempted: every result write is fenced on that same
    // generation. The job is abandoned to its lease and is re-claimed with
    // the new context.
    return { kind: "end", step: await abandon(context, "credential_changed") };
  }

  // The bucket key is a digest of two non-secret values. It is still a
  // step: a runtime without SHA-256 must fail inside the budget rather than
  // hang the worker.
  const bucketKey = await read(context, async (signal) => {
    void signal;
    return await ports.bucketKeyFor(credential.credentialId);
  });

  return {
    kind: "continue",
    state: {
      provider: ports.provider,
      token: credential.token,
      bucketKey,
    },
  };
}

/**
 * The shared window this credential is in.
 *
 * The shared bucket says THIS credential is still throttled. No provider
 * call is made, the job waits for the window instead of polling it, and the
 * run continues with the next owner: another credential has its own bucket.
 */
async function checkThrottle(
  context: JobContext,
  credential: VisitCredential,
): Promise<StepResult<null>> {
  const { ports } = context;

  const bucket = await read(context, (signal) =>
    ports.store.readThrottleBucket({ bucketKey: credential.bucketKey, signal })
  );

  if (bucket?.throttledUntil && new Date(bucket.throttledUntil).getTime() > ports.now()) {
    // The shared bucket says THIS credential is still throttled. No provider
    // call is made, the job waits for the window instead of polling it, and
    // the run continues with the next owner: another credential has its own
    // bucket. There is no progress to record: nothing was collected.
    return {
      kind: "end",
      step: await stopForThrottle(context, credential.bucketKey, {
        scope: "waiting",
        usagePercent: bucket.usagePercent,
        throttledUntil: bucket.throttledUntil,
      }),
    };
  }

  if (!context.budget.canStartProviderCall()) {
    throw new BudgetExceededError();
  }

  return { kind: "continue", state: null };
}

/**
 * The days this job owes.
 *
 * The capture day is never collected: it is still running in Kuwait. The
 * job owes the last completed Kuwait day and the day before it.
 *
 * The plan is recorded BEFORE the first attempt. A `pending` operation
 * keeps the job claimable and keeps a `completed` completion refused until
 * the day is collected, so a day that does not fit this visit's budget is
 * resumed instead of being dropped.
 */
async function planOwedDays(
  context: JobContext,
  visit: OwnerVisitState,
): Promise<StepResult<null>> {
  const { ports, job } = context;
  const checkpoint = job.checkpoint;

  const primaryDay = previousDay(job.capturedOn);
  const correctionDay = previousDay(primaryDay);

  const queuedTokens = [...checkpoint.remainingIds];
  const queuedDays = visit.owedDays;

  const freshJob = checkpoint.pagesFetched === 0 && checkpoint.cursor === null &&
    !checkpoint.windowCovered && queuedTokens.length === 0;

  const owedDays: string[] = [];
  if (freshJob) {
    owedDays.push(primaryDay, correctionDay);
  } else {
    for (const day of queuedDays) owedDays.push(day);
  }
  for (const day of [primaryDay, correctionDay]) {
    if (owedDays.includes(day)) continue;
    // A day whose operation is still open in the accepted operations
    // contract is owed even when the queue does not name it.
    if (job.pendingOperations.includes(accountDayOperationKey(day))) owedDays.push(day);
  }
  visit.owedDays = owedDays;

  if (owedDays.length === 0) {
    return { kind: "continue", state: null };
  }

  await write(context, (signal) =>
    ports.store.recordProgress({
      jobId: job.jobId,
      claimToken: job.claimToken,
      jobGeneration: job.jobGeneration,
      payload: {
        kind: "operations",
        items: owedDays.map((day) => ({
          operation_key: accountDayOperationKey(day),
          operation_kind: "account_day" as const,
          state: "pending" as const,
          provider_date: day,
          query_kind: "interactions",
        })),
      },
      signal,
    })
  );

  // The queue names the planned days too, so the checkpoint itself says
  // which daily observations are still owed. The sweep state of the
  // checkpoint is carried over unchanged: this write only plans work.
  const plannedQueue = mergeQueue(owedDays.map(accountDayToken), queuedTokens);
  await recordVisitProgress(context, visit, {
    cursor: checkpoint.cursor,
    partial: checkpoint.partial || plannedQueue.length > 0,
    truncated: checkpoint.truncated,
    windowCovered: checkpoint.windowCovered,
    gapReason: checkpoint.gapReason,
    remainingIds: plannedQueue,
  });

  return { kind: "continue", state: null };
}

/**
 * The profile observation and the daily observations of this visit.
 *
 * They run BEFORE the media continuation: they are small, and the day that
 * does not fit is resumed on the next visit.
 */
async function collectDays(
  context: JobContext,
  visit: OwnerVisitState,
  target: OwnerTarget,
  credential: VisitCredential,
): Promise<StepResult<null>> {
  const { ports, job } = context;
  const provider = credential.provider;
  const token = credential.token;

  // --- The profile observation ------------------------------------------
  let profileCounts: { followers_count: number | null; media_count: number | null } | null = null;

  try {
    const profile = await providerStep(context, (signal) =>
      provider.fetchAccountProfile({
        igUserId: target.platformUserId,
        token: token,
        signal,
      })
    );
    visit.usagePercent = Math.max(visit.usagePercent, profile.usagePercent);
    profileCounts = profile.value;
    visit.usageStop = visit.usagePercent >= USAGE_STOP_PERCENT;
  } catch (error) {
    if (error instanceof BudgetExceededError) throw error;
    return {
      kind: "end",
      step: await handleProviderFailure(context, credential.bucketKey, error, visit),
    };
  }

  if (profileCounts !== null) {
    const profilePayload: OwnerSnapshotPayload = {
      kind: "owner_profile_observation",
      items: [
        {
          observed_at: new Date(ports.now()).toISOString(),
          status: "ok",
          metrics: {
            ...(profileCounts.followers_count === null
              ? {}
              : { followers_count: profileCounts.followers_count }),
            ...(profileCounts.media_count === null
              ? {}
              : { media_count: profileCounts.media_count }),
          },
        },
      ],
    };
    await write(context, (signal) =>
      ports.store.persistSnapshot({
        jobId: job.jobId,
        claimToken: job.claimToken,
        jobGeneration: job.jobGeneration,
        payload: profilePayload,
        signal,
      })
    );
  }

  // --- The daily observations --------------------------------------------
  for (const day of visit.owedDays) {
    // The usage budget is nearly spent: no further provider call is made.
    if (visit.usageStop) break;
    if (!context.budget.canStartProviderCall()) break;

    let dayValue: Awaited<
      ReturnType<InstagramGraphProvider["fetchAccountDay"]>
    >["value"];

    try {
      const answer = await providerStep(context, (signal) =>
        provider.fetchAccountDay({
          igUserId: target.platformUserId,
          token: token,
          date: day,
          signal,
        })
      );
      visit.usagePercent = Math.max(visit.usagePercent, answer.usagePercent);
      visit.usageStop = visit.usagePercent >= USAGE_STOP_PERCENT;
      dayValue = answer.value;
    } catch (error) {
      if (error instanceof BudgetExceededError) throw error;
      return {
        kind: "end",
        step: await handleProviderFailure(context, credential.bucketKey, error, visit),
      };
    }

    const accountDayPayload: OwnerSnapshotPayload = {
      kind: "owner_account_day",
      items: [
        {
          provider_date: dayValue.provider_date,
          metric_date: dayValue.metric_date,
          query_kind: dayValue.query_kind,
          period_start: dayValue.period_start,
          period_end: dayValue.period_end,
          provider_timezone: dayValue.provider_timezone,
          // A well formed answer with no metric is a FACT about that day, not
          // a failure: the provider says there is nothing to report, and the
          // row says so truthfully. The day is collected either way, so the
          // job does not keep it and does not come back for it.
          status: Object.keys(dayValue.metrics).length > 0 ? "ok" : "unavailable",
          metrics: { ...dayValue.metrics },
        },
      ],
    };
    await write(context, (signal) =>
      ports.store.persistSnapshot({
        jobId: job.jobId,
        claimToken: job.claimToken,
        jobGeneration: job.jobGeneration,
        payload: accountDayPayload,
        signal,
      })
    );

    visit.collectedDays.push(day);

    if (visit.usageStop) break;
  }

  return { kind: "continue", state: null };
}

/**
 * The media inventory of this visit.
 *
 * The sweep is the truth of the window: how many pages were fetched,
 * whether it was truncated, whether the window was covered and where the
 * next visit resumes.
 */
async function sweepInventory(
  context: JobContext,
  visit: OwnerVisitState,
  target: OwnerTarget,
  credential: VisitCredential,
): Promise<StepResult<null>> {
  const { ports, job } = context;
  const provider = credential.provider;
  const token = credential.token;
  const checkpoint = job.checkpoint;

  const resuming = checkpoint.pagesFetched > 0 && !checkpoint.windowCovered;

  // The sweep resumes from the cursor of the last visit, unless the window
  // was already covered.
  visit.cursor = resuming ? checkpoint.cursor : null;

  if (visit.windowCovered || visit.usageStop) {
    return { kind: "continue", state: null };
  }

  let sweepValue: Awaited<
    ReturnType<InstagramGraphProvider["fetchMediaWindow"]>
  >["value"];

  try {
    const sweep = await providerStep(context, (signal) =>
      provider.fetchMediaWindow({
        igUserId: target.platformUserId,
        token: token,
        windowStart: visit.windowStart,
        windowEnd: visit.windowEnd,
        cursor: visit.cursor,
        maxPages: MEDIA_PAGES_PER_ATTEMPT,
        signal,
      })
    );
    visit.usagePercent = Math.max(visit.usagePercent, sweep.usagePercent);
    visit.usageStop = visit.usagePercent >= USAGE_STOP_PERCENT;
    sweepValue = sweep.value;
  } catch (error) {
    if (error instanceof BudgetExceededError) throw error;
    return {
      kind: "end",
      step: await handleProviderFailure(context, credential.bucketKey, error, visit),
    };
  }

  visit.pagesFetched += sweepValue.pagesFetched;
  visit.truncated = sweepValue.truncated;
  visit.windowCovered = sweepValue.windowCovered;
  visit.cursor = sweepValue.nextCursor;
  visit.sweepStopped = sweepValue.stopped;

  if (
    sweepValue.oldestReturnedAt !== null &&
    (visit.oldestReturnedAt === null ||
      sweepValue.oldestReturnedAt < visit.oldestReturnedAt)
  ) {
    visit.oldestReturnedAt = sweepValue.oldestReturnedAt;
  }

  if (sweepValue.items.length > 0) {
    // The rows this capture day already stores for the discovered media.
    //
    // The accepted upsert writes the EXCLUDED columns, so a metric that
    // is not in the payload is NULLed. An inventory write for a media
    // whose insights were already collected would therefore wipe them.
    // The stored metrics are read back and carried over, and the stored
    // status is carried over with them.
    const existing = await read(context, (signal) =>
      ports.store.readOwnerMediaInventory({
        socialAccountId: job.socialAccountId,
        capturedOn: job.capturedOn,
        mediaIds: sweepValue.items.map((item) => item.ig_media_id),
        signal,
      })
    );
    const existingById = new Map(existing.map((row) => [row.igMediaId, row]));

    const mediaPayload: OwnerSnapshotPayload = {
      kind: "owner_media",
      items: sweepValue.items.map((item) => {
        const stored = existingById.get(item.ig_media_id);
        return {
          ig_media_id: item.ig_media_id,
          ...(item.media_product_type === null
            ? {}
            : { media_product_type: item.media_product_type }),
          ...(item.media_type === null ? {} : { media_type: item.media_type }),
          ...(item.thumbnail_url === null ? {} : { thumbnail_url: item.thumbnail_url }),
          ...(item.caption === null ? {} : { caption: item.caption }),
          ...(item.permalink === null ? {} : { permalink: item.permalink }),
          published_at: item.published_at,
          // A media whose insights were positively established as
          // unavailable keeps that status: an inventory write must not
          // turn a terminal media back into an open one.
          status: stored?.status === "unavailable" ? "unavailable" : "ok",
          metrics: {
            ...(item.like_count_public === null
              ? {}
              : { like_count_public: item.like_count_public }),
            ...(item.comments_count_public === null
              ? {}
              : { comments_count_public: item.comments_count_public }),
            ...carriedInsightMetrics(stored),
          },
        };
      }),
    };
    await write(context, (signal) =>
      ports.store.persistSnapshot({
        jobId: job.jobId,
        claimToken: job.claimToken,
        jobGeneration: job.jobGeneration,
        payload: mediaPayload,
        signal,
      })
    );

    // The discovered media join the queue. The sweep walks the feed newest
    // first, so the new media are older than the ones already queued and
    // they are appended in their own order.
    //
    // A media that is already in the queue is not queued twice, and a
    // media whose insights were already collected for this capture day is
    // not queued again: it owes nothing, and re-queuing it would spend a
    // provider call on a media the database already knows.
    const discovered = [...sweepValue.items].sort(compareMediaItems);
    for (const item of discovered) {
      if (visit.mediaQueue.includes(item.ig_media_id)) continue;
      if (isCollectedMedia(existingById.get(item.ig_media_id))) continue;
      visit.mediaQueue.push(item.ig_media_id);
    }
  }

  if (visit.mediaQueue.length > MEDIA_QUEUE_LIMIT) {
    visit.mediaQueue = visit.mediaQueue.slice(0, MEDIA_QUEUE_LIMIT);
    visit.gapReason = MEDIA_QUEUE_CAPPED;
  }

  return { kind: "continue", state: null };
}

/**
 * The media insights of this visit: the bounded continuation.
 *
 * At most five media per visit, one after the other, and a media leaves
 * the queue only after its snapshot was persisted.
 *
 * A media that FAILED goes to the BACK of the queue, so it never blocks the
 * media behind it. A DEFINITIVE refusal of ONE media closes that media and
 * only that media.
 */
async function drainMediaQueue(
  context: JobContext,
  visit: OwnerVisitState,
  credential: VisitCredential,
): Promise<StepResult<null>> {
  const { ports, job } = context;
  const provider = credential.provider;
  const token = credential.token;

  const candidates = visit.mediaQueue.slice(0, MEDIA_INSIGHTS_PER_VISIT);
  let droppedMedia = 0;

  if (candidates.length > 0) {
    const inventory = await read(context, (signal) =>
      ports.store.readOwnerMediaInventory({
        socialAccountId: job.socialAccountId,
        capturedOn: job.capturedOn,
        mediaIds: candidates,
        signal,
      })
    );

    const byId = new Map(inventory.map((row) => [row.igMediaId, row]));

    for (const mediaId of candidates) {
      if (!canStartMediaInsightCall(context)) break;

      const row = byId.get(mediaId);
      if (row === undefined) {
        // The inventory row of this media is gone. It cannot be collected,
        // and it is not owed any more: the queue says what is left.
        droppedMedia += 1;
        visit.mediaQueue = visit.mediaQueue.filter((id) => id !== mediaId);
        continue;
      }

      let insights: Awaited<
        ReturnType<InstagramGraphProvider["fetchMediaInsights"]>
      >["value"];

      try {
        const answer = await providerStep(context, (signal) =>
          provider.fetchMediaInsights({
            igMediaId: mediaId,
            token: token,
            mediaProductType: row.mediaProductType,
            mediaType: row.mediaType,
            signal,
          })
        );
        visit.usagePercent = Math.max(visit.usagePercent, answer.usagePercent);
        visit.usageStop = visit.usagePercent >= USAGE_STOP_PERCENT;
        insights = answer.value;
      } catch (error) {
        if (error instanceof BudgetExceededError) throw error;
        if (error instanceof OwnerProviderError) {
          if (error.kind === "rate_limited") {
            // The provider is throttling: the progress of this visit is
            // recorded FIRST, then the job is parked and the run stops,
            // because a rate limit is a condition of everyone.
            return {
              kind: "end",
              step: await stopForThrottle(context, credential.bucketKey, {
                scope: "parked",
                visit,
                usagePercent: error.usagePercent,
                throttledUntil: error.throttledUntil,
              }),
            };
          }
          if (error.kind === "token_invalid") {
            // The credential is dead. The progress of this visit is recorded
            // first, so the next visit does not ask for it again.
            await recordVisitProgress(context, visit);
            return {
              kind: "end",
              step: await persistFailure(context, "retry", "token_invalid"),
            };
          }
          if (isDefinitiveMediaRefusal(error)) {
            // The provider refuses THIS media and will refuse it again. The
            // item is closed, and only the item: the job keeps the work it
            // has left.
            await closeMediaItem(context, visit, mediaId, row);
            continue;
          }
        }
        // A timeout, a transport failure, a malformed answer and a refusal
        // of the account's permission are NOT evidence that the media has no
        // insights. The media goes to the BACK of the queue, so it never
        // blocks the media behind it, and it is collected on a later visit.
        moveToBackOfQueue(visit, mediaId);
        continue;
      }

      const mediaPayload: OwnerSnapshotPayload = {
        kind: "owner_media",
        items: [
          {
            ig_media_id: mediaId,
            ...(row.mediaProductType === null ? {} : { media_product_type: row.mediaProductType }),
            ...(row.mediaType === null ? {} : { media_type: row.mediaType }),
            ...(row.thumbnailUrl === null ? {} : { thumbnail_url: row.thumbnailUrl }),
            ...(row.caption === null ? {} : { caption: row.caption }),
            ...(row.permalink === null ? {} : { permalink: row.permalink }),
            published_at: row.publishedAt,
            status: "ok",
            metrics: {
              ...(row.likeCountPublic === null
                ? {}
                : { like_count_public: row.likeCountPublic }),
              ...(row.commentsCountPublic === null
                ? {}
                : { comments_count_public: row.commentsCountPublic }),
              ...insights.metrics,
            },
          },
        ],
      };
      await write(context, (signal) =>
        ports.store.persistSnapshot({
          jobId: job.jobId,
          claimToken: job.claimToken,
          jobGeneration: job.jobGeneration,
          payload: mediaPayload,
          signal,
        })
      );

      // Only now is the media out of the queue.
      visit.mediaQueue = visit.mediaQueue.filter((id) => id !== mediaId);

      if (visit.usageStop) break;
    }
  }

  if (droppedMedia > 0) {
    ports.log({
      event: "owner_media_inventory_missing",
      jobId: job.jobId,
      socialAccountId: job.socialAccountId,
      mediaCount: droppedMedia,
      durationMs: ports.now() - context.startedAt,
    });
  }

  return { kind: "continue", state: null };
}

/**
 * The truth of the inventory and the outcome of this visit.
 *
 * The progress of this visit is recorded BEFORE the outcome, so the next
 * visit resumes from it instead of asking for the same work again.
 */
async function finalize(
  context: JobContext,
  visit: OwnerVisitState,
  credential: VisitCredential,
): Promise<JobStep> {
  const { ports, job } = context;

  const pendingDays = visit.owedDays.filter((day) => !visit.collectedDays.includes(day));
  const remainingIds = mergeQueue(
    pendingDays.map(accountDayToken),
    visit.mediaQueue,
  );

  // A covered window is never a truncated one.
  if (visit.windowCovered) visit.truncated = false;

  if (visit.sweepStopped === "unusable_cursor") {
    // The provider's pagination cannot be followed. The window can never be
    // covered for this account, and a retry would fetch exactly the same
    // page. The outcome is terminal and says why.
    //
    // A sweep that stopped for a RATE LIMIT or for the usage budget is NOT
    // this case: it is temporary, and the job stays resumable.
    visit.gapReason = "inventory_cursor_unusable";
    await recordVisitProgress(context, visit, {
      cursor: null,
      partial: true,
      truncated: true,
      windowCovered: false,
      gapReason: visit.gapReason,
      remainingIds,
    });
    return await persistFailure(context, "unavailable", "inventory_unavailable");
  }

  const nearlySpent = visit.usagePercent >= USAGE_STOP_PERCENT;

  if (nearlySpent) {
    // The usage budget is nearly spent. The shared bucket carries the
    // window, the job is left partial and the run stops, so the next worker
    // sees the window before it spends a provider call.
    return await stopForThrottle(context, credential.bucketKey, {
      scope: "usage",
      visit,
      usagePercent: visit.usagePercent,
    });
  }

  // The progress of this visit is recorded BEFORE the outcome, so the next
  // visit resumes from it instead of asking for the same work again.
  await recordVisitProgress(context, visit, { remainingIds });

  // The shared bucket carries the usage the provider reported.
  if (visit.usagePercent > 0) {
    await writeThrottle(context, credential.bucketKey, {
      scope: "shared",
      usagePercent: Math.round(visit.usagePercent),
      throttledUntil: null,
    });
  }

  if (pendingDays.length > 0) {
    // A daily observation is still owed. The job stays claimable and it is
    // completed again on the next visit.
    return await persistFailure(context, "partial", "daily_observation_pending");
  }
  if (visit.mediaQueue.length > 0) {
    // The insights of some media are still owed. The job stays claimable and
    // the queue is resumed on the next visit.
    return await persistFailure(context, "partial", "media_insights_pending");
  }
  if (!visit.windowCovered) {
    return await persistFailure(context, "partial", "inventory_incomplete");
  }

  await write(context, (signal) =>
    ports.store.completeJob({
      jobId: job.jobId,
      claimToken: job.claimToken,
      jobGeneration: job.jobGeneration,
      outcome: "completed",
      reasonCode: null,
      signal,
    })
  );

  ports.log({
    event: "owner_capture",
    jobId: job.jobId,
    socialAccountId: job.socialAccountId,
    outcome: "completed",
    durationMs: ports.now() - context.startedAt,
  });

  return { job: result(context, "completed", null), stopRun: nearlySpent };
}

/**
 * The queue of the work that is still owed.
 *
 * The daily observations come first: they are small, and the media
 * continuation is what waits for the next visit.
 */
function mergeQueue(...groups: readonly (readonly string[])[]): string[] {
  const merged: string[] = [];
  for (const group of groups) {
    for (const entry of group) {
      if (merged.includes(entry)) continue;
      merged.push(entry);
    }
  }
  return merged;
}

function inventoryProgress(input: {
  readonly cursor: string | null;
  readonly pagesFetched: number;
  readonly oldestReturnedAt: string | null;
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly partial: boolean;
  readonly truncated: boolean;
  readonly windowCovered: boolean;
  readonly gapReason: string | null;
  readonly remainingIds?: readonly string[];
}): OwnerInventoryProgressPayload {
  return {
    kind: "inventory",
    cursor: input.cursor,
    remaining_ids: [...(input.remainingIds ?? [])],
    pages_fetched: input.pagesFetched,
    oldest_returned_at: input.oldestReturnedAt,
    window_start: input.windowStart,
    window_end: input.windowEnd,
    partial: input.partial,
    truncated: input.truncated,
    window_covered: input.windowCovered,
    gap_reason: input.gapReason,
  };
}

/**
 * The throttle record of a bucket.
 *
 * It is the ONE place that writes a throttle, and it decides the SCOPE:
 *
 *   - a JOB-SCOPED record carries the job, its claim token and its
 *     generation. It parks THIS job: the accepted SQL releases the lease
 *     and puts the job into a fenced retry. A parked job is NOT a completed
 *     job.
 *   - a SHARED record carries no job. It is the state of the bucket alone,
 *     and it parks no job: another account with its own credential is not
 *     held up by it.
 */
async function writeThrottle(
  context: JobContext,
  bucketKey: string,
  input: {
    readonly scope: "job" | "shared";
    readonly usagePercent: number | null;
    readonly throttledUntil: string | null;
  },
): Promise<void> {
  const { ports, job } = context;

  await write(context, (signal) =>
    ports.store.recordThrottle({
      bucketKey,
      usagePercent: input.usagePercent,
      throttledUntil: input.throttledUntil,
      ...(input.scope === "job"
        ? {
          jobId: job.jobId,
          claimToken: job.claimToken,
          jobGeneration: job.jobGeneration,
        }
        : {}),
      signal,
    })
  );
}

/**
 * The ONE rate-limit path.
 *
 * A provider rate limit, a credential that is already inside a shared
 * window and a nearly spent usage budget are the same condition for the
 * worker: no provider call may be spent until the window is over. They
 * differ in what happens to the JOB, and the scope says which:
 *
 *   - "parked": the provider refused THIS job. The checkpoint of the visit
 *     goes first, the job-scoped throttle record parks the job - it
 *     releases the lease and puts the job into a fenced retry - and the run
 *     stops, because a rate limit is a condition of everyone. A parked job
 *     is NOT completed afterwards.
 *   - "waiting": the shared window of this credential is still open. No
 *     provider call was made, so there is no progress to record; the
 *     job-scoped throttle record parks the job and the run CONTINUES with
 *     the next owner, because another credential has its own bucket.
 *   - "usage": the usage budget of the bucket is nearly spent. The
 *     checkpoint goes first, the SHARED throttle record carries the window
 *     and parks no job, the collected job is completed as a partial, and
 *     the run stops so the next worker sees the window.
 *
 * The order never changes where it applies: the CHECKPOINT of the visit
 * goes first, so the next visit resumes from what was really collected;
 * then the THROTTLE RECORD; then the OUTCOME.
 *
 * The media loop, the provider failure path, the shared window and the end
 * of the visit all come here, so they cannot drift.
 */
type ThrottleInput =
  | {
    readonly scope: "parked";
    readonly visit: OwnerVisitState;
    readonly usagePercent: number;
    /** The provider's own deadline, when it gave one. */
    readonly throttledUntil: Date | null;
  }
  | {
    readonly scope: "waiting";
    readonly usagePercent: number | null;
    readonly throttledUntil: string | null;
  }
  | {
    readonly scope: "usage";
    readonly visit: OwnerVisitState;
    readonly usagePercent: number;
  };

async function stopForThrottle(
  context: JobContext,
  bucketKey: string,
  input: ThrottleInput,
): Promise<JobStep> {
  const { ports, job } = context;

  if (input.scope === "waiting") {
    // Nothing was collected, so there is no progress to record.
    await writeThrottle(context, bucketKey, {
      scope: "job",
      usagePercent: input.usagePercent,
      throttledUntil: input.throttledUntil,
    });

    ports.log({
      event: "owner_capture",
      jobId: job.jobId,
      socialAccountId: job.socialAccountId,
      outcome: "retry",
      reasonCode: "rate_limited",
      durationMs: ports.now() - context.startedAt,
    });

    return { job: result(context, "retry", "rate_limited"), stopRun: false };
  }

  // The checkpoint of the visit. It goes first: the job-scoped throttle
  // record releases the lease, so a later write would be refused.
  await recordVisitProgress(context, input.visit);

  if (input.scope === "usage") {
    // The shared window is used, so the bucket really blocks the next
    // request.
    const until = new Date(ports.now() + THROTTLE_WINDOW_MS);
    await writeThrottle(context, bucketKey, {
      scope: "shared",
      usagePercent: Math.round(input.usagePercent),
      throttledUntil: until.toISOString(),
    });

    ports.log({
      event: "owner_usage_stop",
      jobId: job.jobId,
      socialAccountId: job.socialAccountId,
      outcome: "usage_stop",
      usagePercent: input.usagePercent,
      durationMs: ports.now() - context.startedAt,
    });

    return await persistFailure(context, "partial", "rate_limited", true);
  }

  // "parked": without the provider's own deadline the shared window is
  // used, so the bucket really blocks the next request.
  const until = input.throttledUntil ?? new Date(ports.now() + THROTTLE_WINDOW_MS);
  await writeThrottle(context, bucketKey, {
    scope: "job",
    usagePercent: Math.round(input.usagePercent),
    throttledUntil: until.toISOString(),
  });

  ports.log({
    event: "owner_capture",
    jobId: job.jobId,
    socialAccountId: job.socialAccountId,
    outcome: "retry",
    reasonCode: "rate_limited",
    usagePercent: input.usagePercent,
    durationMs: ports.now() - context.startedAt,
  });

  return { job: result(context, "retry", "rate_limited"), stopRun: true };
}

/**
 * The provider failure path.
 *
 * A throttle is recorded against the SHARED bucket AND parks this job, which
 * releases the lease. The parked job is not completed afterwards: a parked
 * job and a completed job are two different states.
 *
 * The progress of the visit is recorded BEFORE the outcome in every case:
 * the days that were collected stay collected, the media that still owe
 * their insights stay in the queue, and the next visit resumes from there
 * instead of asking for the same work again.
 */
async function handleProviderFailure(
  context: JobContext,
  bucketKey: string,
  error: unknown,
  visit: OwnerVisitState,
): Promise<JobStep> {
  if (!(error instanceof OwnerProviderError)) {
    await recordVisitProgress(context, visit);
    return await persistFailure(context, "retry", "provider_error");
  }

  if (error.kind === "rate_limited") {
    // The checkpoint goes first, then the job-scoped throttle record, then
    // the outcome: the ONE rate-limit path.
    return await stopForThrottle(context, bucketKey, {
      scope: "parked",
      visit,
      usagePercent: error.usagePercent,
      throttledUntil: error.throttledUntil,
    });
  }

  if (error.kind === "token_invalid") {
    await recordVisitProgress(context, visit);
    return await persistFailure(context, "retry", "token_invalid");
  }

  if (error.kind === "scope_missing") {
    // The provider refused the permission for this ACCOUNT. That is a
    // terminal, classified outcome: the data is not obtainable with this
    // credential, and the reason code says why.
    //
    // The days that were collected before the refusal stay collected, and
    // the checkpoint says what is still owed.
    await recordVisitProgress(context, visit);
    return await persistFailure(context, "unavailable", "scope_missing");
  }

  await recordVisitProgress(context, visit);
  return await persistFailure(context, "retry", "provider_error");
}

/**
 * The inventory progress of one visit.
 *
 * The truth it carries is the truth of the visit: the pages that were
 * fetched, the cursor the next visit resumes from, the days that are still
 * owed, the media that still owe their insights and whether the window was
 * covered.
 */
function visitProgress(
  visit: OwnerVisitState,
  overrides: {
    readonly cursor?: string | null;
    readonly partial?: boolean;
    readonly truncated?: boolean;
    readonly windowCovered?: boolean;
    readonly gapReason?: string | null;
    readonly remainingIds?: readonly string[];
  } = {},
): OwnerInventoryProgressPayload {
  const pendingDays = visit.owedDays.filter((day) => !visit.collectedDays.includes(day));
  const remainingIds = overrides.remainingIds ??
    mergeQueue(pendingDays.map(accountDayToken), visit.mediaQueue);
  const truncated = overrides.truncated ?? visit.truncated;
  const windowCovered = overrides.windowCovered ?? visit.windowCovered;
  const gapReason = overrides.gapReason !== undefined
    ? overrides.gapReason
    : visit.gapReason === MEDIA_QUEUE_CAPPED
    ? MEDIA_QUEUE_CAPPED
    : truncated
    ? (visit.gapReason ?? "inventory_truncated")
    : remainingIds.length > 0
    ? (visit.gapReason ?? "collection_continues")
    : visit.usageStop
    ? "usage_stop"
    : null;

  return inventoryProgress({
    cursor: overrides.cursor !== undefined
      ? overrides.cursor
      : truncated
      ? visit.cursor
      : null,
    pagesFetched: visit.pagesFetched,
    oldestReturnedAt: visit.oldestReturnedAt,
    windowStart: visit.windowStart,
    windowEnd: visit.windowEnd,
    partial: overrides.partial ?? (remainingIds.length > 0 || !windowCovered),
    truncated,
    windowCovered,
    gapReason,
    remainingIds,
  });
}

/**
 * Records the truth of one visit in the accepted checkpoint.
 *
 * It is a write, and it is fenced by the claim like every other write: a
 * refused write throws, and the caller abandons the job to its lease.
 */
async function recordVisitProgress(
  context: JobContext,
  visit: OwnerVisitState,
  overrides: {
    readonly cursor?: string | null;
    readonly partial?: boolean;
    readonly truncated?: boolean;
    readonly windowCovered?: boolean;
    readonly gapReason?: string | null;
    readonly remainingIds?: readonly string[];
  } = {},
): Promise<void> {
  const { ports, job } = context;
  const payload = visitProgress(visit, overrides);

  await write(context, (signal) =>
    ports.store.recordProgress({
      jobId: job.jobId,
      claimToken: job.claimToken,
      jobGeneration: job.jobGeneration,
      payload,
      signal,
    })
  );
}

/**
 * Moves a media to the BACK of the queue of the media that owe insights.
 *
 * A media that keeps its place at the head of the queue blocks every media
 * behind it for as long as it keeps failing, and the queue never drains.
 */
function moveToBackOfQueue(visit: OwnerVisitState, mediaId: string): void {
  visit.mediaQueue = [
    ...visit.mediaQueue.filter((id) => id !== mediaId),
    mediaId,
  ];
}

/**
 * True when the provider refused ONE media and will refuse it again.
 *
 * Meta answers a media it will never answer with a Graph error object of
 * code 10 ("not enough viewers for the media to show insights") or of code
 * 100. The refusal is about that media alone: it says nothing about the
 * account and nothing about the other media.
 */
function isDefinitiveMediaRefusal(error: OwnerProviderError): boolean {
  return error.graphCode !== null &&
    DEFINITIVE_MEDIA_GRAPH_CODES.has(error.graphCode);
}

/**
 * Closes ONE media that the provider refuses for good.
 *
 * The item is written as `unavailable`, which is the provider's own
 * statement that this media has no insights to give, and it leaves the
 * queue. The JOB is not closed by it: the other media are still owed and
 * the account is still collectable.
 *
 * The item-level reason has no column in the accepted SQL - the media
 * snapshot carries a status and the media operation carries a state - so it
 * is recorded in the bounded log of this worker.
 */
async function closeMediaItem(
  context: JobContext,
  visit: OwnerVisitState,
  mediaId: string,
  row: OwnerMediaInventoryRow,
): Promise<void> {
  const { ports, job } = context;

  const payload: OwnerSnapshotPayload = {
    kind: "owner_media",
    items: [
      {
        ig_media_id: mediaId,
        ...(row.mediaProductType === null ? {} : { media_product_type: row.mediaProductType }),
        ...(row.mediaType === null ? {} : { media_type: row.mediaType }),
        ...(row.thumbnailUrl === null ? {} : { thumbnail_url: row.thumbnailUrl }),
        ...(row.caption === null ? {} : { caption: row.caption }),
        ...(row.permalink === null ? {} : { permalink: row.permalink }),
        published_at: row.publishedAt,
        // The provider refuses this media: its insights are unavailable, and
        // the row says so. The insight metrics stay null: the provider
        // never reported them.
        status: "unavailable",
        metrics: {
          ...(row.likeCountPublic === null
            ? {}
            : { like_count_public: row.likeCountPublic }),
          ...(row.commentsCountPublic === null
            ? {}
            : { comments_count_public: row.commentsCountPublic }),
        },
      },
    ],
  };

  await write(context, (signal) =>
    ports.store.persistSnapshot({
      jobId: job.jobId,
      claimToken: job.claimToken,
      jobGeneration: job.jobGeneration,
      payload,
      signal,
    })
  );

  // The closed media leaves the queue: it owes nothing any more.
  visit.mediaQueue = visit.mediaQueue.filter((id) => id !== mediaId);

  ports.log({
    event: "owner_media_insights_unavailable",
    jobId: job.jobId,
    socialAccountId: job.socialAccountId,
    outcome: "unavailable",
    reasonCode: MEDIA_INSIGHTS_UNAVAILABLE,
    durationMs: ports.now() - context.startedAt,
  });
}

/**
 * Finishes a continuation that outlived its capture day.
 *
 * The terminal outcome is `unavailable` with the reason `continuation_
 * expired`, and the checkpoint carries the truthful gap: the window is not
 * covered, the gap says why, and the work that is still owed is listed.
 */
async function expireContinuation(
  context: JobContext,
  visit: OwnerVisitState,
): Promise<JobStep> {
  const { ports, job } = context;

  ports.log({
    event: "owner_continuation_expired",
    jobId: job.jobId,
    socialAccountId: job.socialAccountId,
    outcome: "unavailable",
    reasonCode: CONTINUATION_EXPIRED,
    durationMs: ports.now() - context.startedAt,
  });

  await recordVisitProgress(context, visit, {
    cursor: visit.cursor,
    partial: true,
    truncated: visit.truncated,
    windowCovered: false,
    gapReason: CONTINUATION_EXPIRED,
  });

  return await persistFailure(context, "unavailable", "continuation_expired");
}

/**
 * Abandons one job to its lease.
 *
 * The job is recovered when its lease expires, and the run continues with
 * the next claimed job: the condition belongs to this job alone.
 */
async function abandon(
  context: JobContext,
  reasonCode: OwnerReasonCode,
): Promise<JobStep> {
  context.ports.log({
    event: "owner_job_abandoned",
    jobId: context.job.jobId,
    socialAccountId: context.job.socialAccountId,
    outcome: "abandoned",
    reasonCode,
    durationMs: context.ports.now() - context.startedAt,
  });
  return { job: result(context, "abandoned", reasonCode), stopRun: false };
}

/**
 * Writes one failure outcome.
 *
 * A failed, refused or late write throws, and the caller abandons the job to
 * its lease: it is never reported as stored and never retried.
 *
 * `stopRun` is set by the outcomes that must not be followed by another
 * provider call: a nearly spent usage budget and a parked job.
 */
async function persistFailure(
  context: JobContext,
  outcome: "retry" | "partial" | "unavailable",
  reasonCode: OwnerReasonCode,
  stopRun = false,
): Promise<JobStep> {
  const { ports, job } = context;

  await write(context, (signal) =>
    ports.store.completeJob({
      jobId: job.jobId,
      claimToken: job.claimToken,
      jobGeneration: job.jobGeneration,
      outcome,
      reasonCode,
      signal,
    })
  );

  ports.log({
    event: "owner_capture",
    jobId: job.jobId,
    socialAccountId: job.socialAccountId,
    outcome,
    reasonCode,
    durationMs: ports.now() - context.startedAt,
  });

  return { job: result(context, outcome, reasonCode), stopRun };
}
