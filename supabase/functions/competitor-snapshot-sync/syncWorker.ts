/**
 * The competitor collection worker.
 *
 * WHAT THIS MODULE OWNS
 *
 *   The orchestration: the bounded drain, the scheduled enqueue, the choice
 *   of a viewer, the provider call, the shared throttle, and the atomic
 *   result write. It owns no SQL, no HTTP and no request contract.
 *
 * THE BUDGET
 *
 *   The whole run has forty seconds, counted from before the claim. EVERY
 *   step is bounded, not only the provider call: the claim and the reads
 *   must leave the five second write reserve behind, a provider call is only
 *   started when at least thirteen seconds remain, and the write may use the
 *   reserve. Each step gets a signal that aborts at its deadline and is raced
 *   against it, so a store or transport that ignores the abort cannot keep
 *   the worker waiting. A step that misses its deadline abandons the job to
 *   its lease - it is never reported as stored, never retried and never
 *   described as recovered - and the run stops.
 *
 * THE CLAIM SIZE
 *
 *   The claim is always the production limit of fifty. The budget decides
 *   how many of those fifty are PROCESSED, not how many are claimed. A
 *   batch size of one or two would starve the rest of the queue and is not
 *   a production shape.
 *
 * WHY THE VIEWER IS CHOSEN FROM THE PROTECTED STATE
 *
 *   The candidates are read from the protected capability rows by the
 *   store. The shared selector then ranks them. The credential is resolved
 *   separately, through the protected credential adapter, and the
 *   generation that came with the token is compared with the generation
 *   the database captured when the viewer was attached. A reconnect
 *   between the two is refused before a provider call is spent.
 *
 * WHY THE ELIGIBLE CANDIDATE SET IS DECIDED BY THE DATABASE
 *
 *   The rollout policy decides which watchlist may be collected for and
 *   which viewer is approved for it, and SQL owns that decision. The
 *   worker therefore asks the job-scoped SQL to attach the candidate the
 *   shared selector picked, and it acts on the answer:
 *
 *     - a viewer the policy does not approve is EXCLUDED from the eligible
 *       set, and the selector runs again on the candidates that are left,
 *       so the existing ordering is kept INSIDE the eligible set and never
 *       outside it;
 *     - a target the policy does not admit refuses the work, and nothing
 *       is written.
 *
 *   There is no substitution: the candidate that the policy approved is the
 *   one that is used, and a failure of that candidate never reaches for
 *   another one.
 *
 * WHY A FAILED ATTEMPT IS STILL RECORDED
 *
 *   "There is no usable viewer" is a fact about the owner's account, and
 *   the owner has to be able to read it. The result write records it, sets
 *   the entry to error and leaves the job retryable. A weekly "the target
 *   is gone" verdict is reserved for the one outcome that PROVES the
 *   target cannot be analysed.
 *
 * WHY A ROLLOUT REFUSAL IS NEVER WRITTEN
 *
 *   A refusal of the rollout policy is not a fact about the target: it is
 *   a fact about the configuration. The job is abandoned to its lease, no
 *   result is written, no target is marked unavailable, no credential is
 *   revoked and no success time advances.
 */

import { pickBusinessDiscoveryViewer } from "../_shared/instagramDiscoveryViewer.ts";
import type { ViewerCandidate } from "../_shared/instagramDiscoveryViewer.ts";

import { type CompetitorServiceStore, CompetitorStoreError } from "./store.ts";
import {
  CompetitorProviderError,
  CompetitorProviderPermitError,
  type AttachedViewerContext,
  type ClaimedCompetitorJob,
  type CompetitorCapture,
  type CompetitorDrainSummary,
  type CompetitorProvider,
  type CompetitorProviderPermit,
  type CompetitorReasonCode,
  type CompetitorResultPayload,
  type CompetitorSource,
  type PaidFallbackPolicy,
  type PersistResultReceipt,
  type ProcessedCompetitorJob,
  type ResolvedViewerCredential,
} from "./types.ts";

/** The whole run, counted from before the first claim. */
export const WORKER_TOTAL_BUDGET_MS = 40_000;

/** The provider ceiling of one attempt: headers AND body. */
export const WORKER_PROVIDER_CEILING_MS = 8_000;

/** The reserve for the write, the release and the log. */
export const WORKER_WRITE_RESERVE_MS = 5_000;

/** The claim size. It is the production limit and it does not shrink. */
export const COMPETITOR_CLAIM_LIMIT = 50;

/** The page size of the due-target read. */
export const DUE_TARGET_PAGE_LIMIT = 50;

/**
 * The most due-target pages one scheduled enqueue walks. Walking the pages
 * inside one run is what keeps the first page from starving the rest: an
 * entry that is already enqueued is still "due" until it is collected, so a
 * run that always read only the first page would re-enqueue the same fifty
 * entries forever. A run that stops early returns the cursor to resume from.
 */
export const MAX_DUE_TARGET_PAGES = 20;

/** The usage percentage at which the provider work stops. */
export const USAGE_STOP_PERCENT = 80;

/**
 * The shared throttle window recorded when the provider throttles without a
 * deadline of its own, or when the usage budget is nearly spent. It matches
 * the accepted fifteen minute enqueue throttle window.
 */
export const THROTTLE_WINDOW_MS = 15 * 60_000;

/** A stable, bounded log event. It never carries a credential. */
export interface CompetitorWorkerLogEvent {
  readonly event: string;
  readonly jobId?: string;
  readonly watchlistId?: string;
  readonly outcome?: string;
  readonly reasonCode?: string;
  readonly source?: string;
  readonly mediaCount?: number;
  readonly usagePercent?: number;
  readonly durationMs?: number;
  /**
   * Whether the capture reached the end of the target's feed without a
   * cap. It is the operational answer to "was this a full inventory", and
   * it is deliberately NOT the same question as the weekly coverage, which
   * also needs a verified provider order.
   */
  readonly coverageComplete?: boolean;
}

export interface CompetitorWorkerPorts {
  readonly store: CompetitorServiceStore;
  /** The official Business Discovery adapter. */
  readonly officialProvider: CompetitorProvider;
  /**
   * The paid fallback policy.
   *
   * Scheduled paid work is deferred, so the shipped composition injects a
   * disabled policy. The worker never decides this for itself.
   */
  readonly paidFallback: PaidFallbackPolicy;
  /**
   * The shared throttle bucket key of a protected credential.
   *
   * It is a digest of the app and the protected credential's id (never the
   * token), because Meta meters a User token per app and every Page of that
   * grant shares it. The database never receives a credential.
   */
  readonly bucketKeyFor: (credentialId: string) => Promise<string>;
  /** The clock. Injectable so the budget is testable. */
  readonly now: () => number;
  /**
   * The whole-run budget in milliseconds.
   *
   * It defaults to the forty second production budget. The shipped
   * composition does NOT override it, so production always runs with the
   * documented budget; the override exists so a test can exercise the
   * deadline without waiting forty seconds.
   */
  readonly budgetMs?: number;
  /** The bounded log sink. */
  readonly log: (event: CompetitorWorkerLogEvent) => void;
}

/** The result of one scheduled enqueue pass. */
export interface CompetitorEnqueueSummary {
  readonly targets: number;
  readonly owners: number;
  readonly enqueued: number;
  readonly nextCursor: { readonly dueAt: string; readonly id: string } | null;
}

/** The budget of one run. */
export interface WorkerBudget {
  readonly startedAt: number;
  readonly totalMs: number;
  remainingMs(): number;
  /** True when there is still enough time to start a provider call. */
  canStartProviderCall(): boolean;
}

export function createWorkerBudget(
  now: () => number,
  totalMs: number = WORKER_TOTAL_BUDGET_MS,
): WorkerBudget {
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

/**
 * Races a promise against the remaining budget.
 *
 * The losing promise is always settled: a late rejection is consumed, so
 * a transport that ignores the abort cannot become an unhandled rejection
 * and cannot be mistaken for a result.
 *
 * It is exported so the guard can be exercised on its own. The production
 * budget is not configurable through it.
 */
export async function raceWithBudget<T>(
  work: Promise<T>,
  budget: WorkerBudget,
): Promise<{ readonly ok: true; readonly value: T } | { readonly ok: false }> {
  const remaining = budget.remainingMs();
  if (remaining <= 0) return { ok: false };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ readonly ok: false }>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false }), remaining);
  });

  // The late outcome is consumed here.
  work.then(
    () => undefined,
    () => undefined,
  );

  try {
    return await Promise.race([
      work.then((value) => ({ ok: true, value }) as const),
      timeout,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * The scheduled enqueue.
 *
 * It reads the due watchlist entries through the bounded, ordered, paged
 * database read, groups them by owner and asks the durable enqueue to
 * create one job per entry. It never scans an unbounded queue.
 */
export async function runCompetitorEnqueue(
  ports: CompetitorWorkerPorts,
  input: {
    readonly limit: number;
    readonly cursor: { readonly dueAt: string; readonly id: string } | null;
    readonly signal?: AbortSignal;
  },
): Promise<CompetitorEnqueueSummary> {
  const pageLimit = Math.min(Math.max(1, input.limit), DUE_TARGET_PAGE_LIMIT);
  const owners = new Set<string>();
  let cursor = input.cursor;
  let targetCount = 0;
  let enqueued = 0;

  for (let page = 0; page < MAX_DUE_TARGET_PAGES; page += 1) {
    if (input.signal?.aborted) break;

    const targets = await ports.store.listDueTargets({
      limit: pageLimit,
      cursor,
      signal: input.signal,
    });

    const byOwner = new Map<string, string[]>();
    for (const target of targets) {
      const existing = byOwner.get(target.userId);
      if (existing) existing.push(target.watchlistId);
      else byOwner.set(target.userId, [target.watchlistId]);
      owners.add(target.userId);
    }

    for (const [ownerId, watchlistIds] of byOwner) {
      const outcome = await ports.store.enqueueService({
        ownerId,
        watchlistIds,
        signal: input.signal,
      });
      enqueued += outcome.accepted;
    }

    targetCount += targets.length;

    if (targets.length < pageLimit) {
      // The last page: the whole due list was walked.
      cursor = null;
      break;
    }

    const last = targets[targets.length - 1]!;
    cursor = { dueAt: last.dueAt, id: last.watchlistId };
  }

  ports.log({
    event: "competitor_enqueue",
    outcome: "enqueued",
    mediaCount: enqueued,
  });

  // A non-null cursor means the walk stopped before the end of the due list;
  // the caller resumes from it.
  return {
    targets: targetCount,
    owners: owners.size,
    enqueued,
    nextCursor: cursor,
  };
}

/**
 * The bounded drain.
 *
 * It claims the production limit, processes as many of those jobs as the
 * budget allows, and leaves the rest to be recovered after their lease.
 *
 * A job whose step could not finish inside the budget, or whose store call
 * failed, is ABANDONED: nothing is reported as stored, the lease is left to
 * expire, and the run stops, because a slow or failing database is not a
 * reason to keep spending provider calls.
 */
export async function runCompetitorDrain(
  ports: CompetitorWorkerPorts,
  input: { readonly signal?: AbortSignal },
): Promise<CompetitorDrainSummary> {
  const budget = createWorkerBudget(ports.now, ports.budgetMs ?? WORKER_TOTAL_BUDGET_MS);

  const summary: {
    claimed: number;
    processed: number;
    completed: number;
    unavailable: number;
    retried: number;
    abandoned: number;
    stoppedEarly: boolean;
    jobs: ProcessedCompetitorJob[];
  } = {
    claimed: 0,
    processed: 0,
    completed: 0,
    unavailable: 0,
    retried: 0,
    abandoned: 0,
    stoppedEarly: false,
    jobs: [],
  };

  let jobs: ClaimedCompetitorJob[];
  try {
    // The claim is bounded too: it must leave the write reserve behind.
    jobs = await boundedStep(
      budget,
      WORKER_WRITE_RESERVE_MS,
      input.signal,
      (signal) => ports.store.claimCompetitorJobs({ limit: COMPETITOR_CLAIM_LIMIT, signal }),
    );
  } catch {
    // Whether the claim committed is unknown. Any job it leased is recovered
    // when that lease expires; nothing is invented here.
    ports.log({ event: "competitor_claim_abandoned", outcome: "abandoned" });
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
  readonly job: ProcessedCompetitorJob;
  readonly stopRun: boolean;
}

/**
 * Processes one claimed job.
 *
 * Every exit either writes a verified outcome or abandons the job to its
 * lease. The two are never mixed.
 */
async function processClaimedJob(
  ports: CompetitorWorkerPorts,
  job: ClaimedCompetitorJob,
  budget: WorkerBudget,
  outer: AbortSignal | undefined,
): Promise<JobStep> {
  const context: JobContext = {
    ports,
    job,
    budget,
    outer,
    startedAt: ports.now(),
    username: "",
  };

  try {
    return await collect(context);
  } catch (error) {
    // A store failure, a refused write or a step that ran out of budget. The
    // outcome is unknown, so nothing is reported as stored and the run stops.
    const reasonCode: CompetitorReasonCode = error instanceof BudgetExceededError
      ? "deadline_exceeded"
      : "storage_error";
    ports.log({
      event: "competitor_job_abandoned",
      jobId: job.jobId,
      watchlistId: job.watchlistId,
      outcome: "abandoned",
      reasonCode,
      durationMs: ports.now() - context.startedAt,
    });
    return {
      job: result(context, "abandoned", null, reasonCode, 0),
      stopRun: true,
    };
  }
}

interface JobContext {
  readonly ports: CompetitorWorkerPorts;
  readonly job: ClaimedCompetitorJob;
  readonly budget: WorkerBudget;
  readonly outer: AbortSignal | undefined;
  readonly startedAt: number;
  username: string;
}

function result(
  context: JobContext,
  outcome: ProcessedCompetitorJob["outcome"],
  source: CompetitorSource | null,
  reasonCode: CompetitorReasonCode | null,
  mediaCount: number,
): ProcessedCompetitorJob {
  return {
    jobId: context.job.jobId,
    watchlistId: context.job.watchlistId,
    username: context.username,
    outcome,
    source,
    reasonCode,
    mediaCount,
  };
}

/** A read or attach step: it must leave the write reserve behind. */
function read<T>(context: JobContext, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  return boundedStep(context.budget, WORKER_WRITE_RESERVE_MS, context.outer, work);
}

/** A write step: it may use the reserve, and it is never retried. */
function write<T>(context: JobContext, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  return boundedStep(context.budget, 0, context.outer, work);
}

async function collect(context: JobContext): Promise<JobStep> {
  const { ports, job } = context;

  const target = await read(context, (signal) =>
    ports.store.readWatchlistTarget({ watchlistId: job.watchlistId, userId: job.userId, signal })
  );
  if (!target) {
    // The watchlist row is gone. The job row cascades with it, so this is
    // not reachable in a consistent database; the lease is left to expire
    // rather than guessed at.
    throw new CompetitorStoreError("not_found");
  }
  context.username = target.username;

  const candidates = await read(context, (signal) =>
    ports.store.listViewerCandidates({ userId: job.userId, signal })
  );

  // The stable tie-break happens BEFORE the shared selector is called: the
  // selector orders by the connection time and leaves equal times in the
  // order it received them, so the input order has to be stable.
  const ordered = [...candidates].sort((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0
  );

  if (ordered.length === 0) {
    // There is no viewer candidate at all. That is a fact about the owner's
    // account, and the paid fallback policy decides what happens next -
    // exactly as it did before the rollout controls.
    return await handleMissingViewer(context);
  }

  // The ELIGIBLE candidate set is decided by the database, and the shared
  // selector orders INSIDE it. A candidate the policy does not approve is
  // excluded and the next one is offered; there is no substitution, and
  // the credential of the approved viewer is the only one that is read.
  const eligible = await resolveEligibleViewer(context, ordered);
  if (eligible.kind === "refused") {
    return await handleAdmissionRefusal(context, eligible);
  }

  const { viewer, attached } = eligible;

  let credential: ResolvedViewerCredential;
  try {
    credential = await read(context, (signal) =>
      ports.store.resolveViewerCredential({
        userId: job.userId,
        socialAccountId: viewer.id,
        signal,
      })
    );
  } catch (error) {
    if (error instanceof CompetitorStoreError && error.failure === "stale_claim") {
      return await persistFailure(context, "retry", "credential_changed",
        "The Instagram connection changed during the collection.");
    }
    throw error;
  }

  if (credential.capabilityGeneration !== attached.credentialGeneration) {
    // The connection was replaced between the attach and the credential
    // read. No provider call is spent on a token whose generation no
    // longer matches the captured context.
    return await persistFailure(context, "retry", "credential_changed",
      "The Instagram connection changed during the collection.");
  }

  // The shared bucket follows the credential that Meta meters: the app and
  // the Facebook User credential, which every Page of that grant shares.
  const bucketKey = await ports.bucketKeyFor(credential.credentialId);

  const bucket = await read(context, (signal) =>
    ports.store.readThrottleBucket({ bucketKey, signal })
  );
  if (bucket?.throttledUntil && new Date(bucket.throttledUntil).getTime() > ports.now()) {
    // The shared bucket says this credential is still throttled. No provider
    // call is made; other owners' credentials are unaffected.
    return await persistFailure(context, "retry", "rate_limited",
      "The provider is throttling this collection.");
  }

  if (!context.budget.canStartProviderCall()) {
    throw new BudgetExceededError();
  }

  let capture: CompetitorCapture;
  let usagePercent: number;
  try {
    const outcome = await providerStep(context, (signal) =>
      ports.officialProvider.fetch({
        username: target.username,
        viewerIgUserId: viewer.platform_user_id,
        token: credential.token,
        // The permit travels with the request and is asked again by the
        // adapter immediately before every request that leaves the process:
        // every attempt, every retry and every page of the feed.
        permit: visitPermit(context, viewer.id),
        signal,
      })
    );
    capture = outcome.capture;
    usagePercent = outcome.usagePercent;

    // The capture must be filed under the source of the adapter that
    // produced it. A capture that claims another source is not trusted and
    // it is never stored as an official one: the source decides who may
    // read the row and which rules apply to it.
    if (capture.source !== "official") {
      return await persistFailure(context, "retry", "provider_error",
        "The provider returned a capture from an unexpected source.");
    }
  } catch (error) {
    if (error instanceof BudgetExceededError) throw error;
    if (error instanceof CompetitorProviderPermitError) {
      // The request was never authorized. It is not a provider failure and
      // it is never retried.
      return await handlePermitFailure(context, error);
    }
    return await handleProviderFailure(context, bucketKey, error);
  }

  const stored = await persistCapture(context, "official", capture);

  // The shared bucket is recorded for every provider response, including a
  // successful one. A nearly spent budget is recorded as a throttle window,
  // so every later worker sees it and stops before its own request.
  const nearlySpent = usagePercent >= USAGE_STOP_PERCENT;
  if (usagePercent > 0) {
    await write(context, (signal) =>
      ports.store.recordThrottle({
        bucketKey,
        usagePercent: Math.round(usagePercent),
        throttledUntil: nearlySpent
          ? new Date(ports.now() + THROTTLE_WINDOW_MS).toISOString()
          : null,
        signal,
      })
    );
  }

  if (nearlySpent) {
    ports.log({
      event: "competitor_usage_stop",
      jobId: job.jobId,
      watchlistId: job.watchlistId,
      outcome: "usage_stop",
      usagePercent,
    });
  }

  return { job: stored, stopRun: nearlySpent };
}

/**
 * The eligible viewer of this job, and the one that is used.
 *
 * The shared selector orders the candidates, and the DATABASE decides which
 * of them is eligible. A candidate the policy does not approve is excluded
 * and the selector runs again on the candidates that are left, so the
 * existing ordering is kept inside the eligible set and never outside it.
 */
type EligibleViewer =
  | {
    readonly kind: "eligible";
    readonly viewer: ViewerCandidate;
    readonly attached: AttachedViewerContext;
  }
  | {
    readonly kind: "refused";
    readonly reasonCode: CompetitorReasonCode;
    readonly stopRun: boolean;
    readonly auditFailed: boolean;
  };

/**
 * Asks the database which candidate is eligible, and binds that one.
 *
 * The attachment is the JOB-SCOPED admission decision, and it happens
 * BEFORE the credential is resolved: no token is read for a target the
 * policy does not admit, and no token is read for a viewer the policy does
 * not approve.
 *
 * There is no substitution. The candidate the policy approved is the one
 * that is used, and a failure of that candidate never reaches for another
 * one.
 */
async function resolveEligibleViewer(
  context: JobContext,
  candidates: readonly ViewerCandidate[],
): Promise<EligibleViewer> {
  let remaining = [...candidates];

  while (remaining.length > 0) {
    const viewer = pickBusinessDiscoveryViewer(remaining);
    if (!viewer) break;

    const decision = await read(context, (signal) =>
      context.ports.store.attachViewerContext({
        jobId: context.job.jobId,
        claimToken: context.job.claimToken,
        jobGeneration: context.job.jobGeneration,
        viewerSocialAccountId: viewer.id,
        signal,
      })
    );

    if (decision.kind === "attached") {
      return { kind: "eligible", viewer, attached: decision.context };
    }

    if (decision.kind === "not_approved" || decision.kind === "already_bound") {
      // The candidate is excluded from the eligible set. The next one is
      // offered, and only the candidate the policy approves may be used.
      remaining = remaining.filter((candidate) => candidate.id !== viewer.id);
      continue;
    }

    return {
      kind: "refused",
      reasonCode: admissionRefusalReason(decision),
      // A configuration that cannot be read, and a gate that cannot be
      // read, leave the outcome UNKNOWN: the run stops. A refusal of one
      // target belongs to that target alone.
      stopRun: decision.kind === "configuration_unavailable" ||
        decision.kind === "unavailable",
      auditFailed: !decision.auditStored,
    };
  }

  // Every candidate the policy knows was excluded. The work is refused and
  // nothing is written.
  //
  // The refusal is audited here, in a separate bounded call: the accepted
  // SQL refuses by RAISING, so its own audit row did not commit with the
  // refusal. The per-candidate exclusions are excluded rows and not
  // refusal events, so they produce no row of their own.
  const auditStored = await context.ports.store.auditAdmissionRefusal({
    jobId: context.job.jobId,
    reasonCode: "collection_not_eligible",
  });

  return {
    kind: "refused",
    reasonCode: "collection_not_eligible",
    stopRun: false,
    auditFailed: !auditStored,
  };
}

/**
 * The stable reason of one admission refusal.
 *
 * It is a CLOSED mapping: the reason code is one this contract knows, and
 * it never carries a driver message.
 */
function admissionRefusalReason(
  decision: Exclude<
    Awaited<ReturnType<CompetitorServiceStore["attachViewerContext"]>>,
    { readonly kind: "attached" } | { readonly kind: "not_approved" } |
      { readonly kind: "already_bound" }
  >,
): CompetitorReasonCode {
  if (decision.kind === "target_not_eligible") return "collection_not_eligible";
  if (decision.kind === "configuration_unavailable") return "collection_unavailable";
  if (decision.kind === "viewer_unusable") return "viewer_unavailable";
  if (decision.kind === "stale_claim") return "credential_changed";
  return "collection_unavailable";
}

/**
 * The refusal of the admission gate.
 *
 * A refusal is a condition of ONE job: the policy does not admit this
 * target, so the job is abandoned to its lease and the run continues with
 * the next claimed competitor. No later request is sent and NOTHING is
 * written: a rollout refusal never marks a target unavailable, never
 * revokes a credential and never advances a success.
 */
async function handleAdmissionRefusal(
  context: JobContext,
  refusal: {
    readonly reasonCode: CompetitorReasonCode;
    readonly stopRun: boolean;
    readonly auditFailed: boolean;
  },
): Promise<JobStep> {
  const { ports, job } = context;

  ports.log({
    event: "competitor_admission_refused",
    jobId: job.jobId,
    watchlistId: job.watchlistId,
    outcome: "abandoned",
    reasonCode: refusal.reasonCode,
    durationMs: ports.now() - context.startedAt,
  });

  if (refusal.auditFailed) {
    // The refusal row did not commit. The work stops and the audit failure
    // is reported: a row that did not commit is never reported as stored.
    ports.log({
      event: "competitor_admission_audit_failed",
      jobId: job.jobId,
      watchlistId: job.watchlistId,
      outcome: "abandoned",
      reasonCode: "collection_unavailable",
      durationMs: ports.now() - context.startedAt,
    });
  }

  return {
    job: result(context, "abandoned", null, refusal.reasonCode, 0),
    // A refusal whose audit did not commit stops the work: a row that did
    // not commit is never reported as a stored row, and the run may not
    // repeat work whose refusal was never recorded.
    stopRun: refusal.stopRun || refusal.auditFailed,
  };
}

/**
 * The per-request admission permit of ONE job.
 *
 * It asks the accepted SQL for a FRESH permit immediately before every
 * provider request. The call names the job, its claim token and its
 * generation and NOTHING else, so the database derives the owner, the
 * target and the viewer from the live fenced job - a caller can never
 * redirect the request to another account.
 *
 * A refused permit is a refusal. A permit that could not be read is
 * UNAVAILABLE: the outcome of the decision is unknown, and an unknown
 * outcome is never permission.
 */
function visitPermit(
  context: JobContext,
  viewerSocialAccountId: string,
): CompetitorProviderPermit {
  const { ports, job } = context;

  return async (signal: AbortSignal): Promise<void> => {
    const decision = await ports.store.authorizeProviderCall({
      jobId: job.jobId,
      claimToken: job.claimToken,
      jobGeneration: job.jobGeneration,
      targetId: job.watchlistId,
      viewerSocialAccountId,
      signal,
    });

    if (decision.kind === "allowed") return;

    if (decision.kind === "refused") {
      throw new CompetitorProviderPermitError("refused", decision.reasonCode);
    }

    throw new CompetitorProviderPermitError(
      "unavailable",
      decision.reasonCode,
      !decision.auditStored,
    );
  };
}

/**
 * The refusal of the per-request admission gate.
 *
 * A REFUSED permit is a condition of ONE job: the policy no longer admits
 * this target, so the job is abandoned to its lease and the run continues
 * with the next claimed competitor. No later request is sent and NOTHING
 * is written.
 *
 * An UNAVAILABLE permit - the gate could not be read, or its refusal could
 * not be audited - is a condition of the RUN: the outcome is unknown, so
 * the run stops rather than repeating work that may already have happened.
 */
async function handlePermitFailure(
  context: JobContext,
  error: CompetitorProviderPermitError,
): Promise<JobStep> {
  const { ports, job } = context;

  const configurationRefusal = error.reasonCode === "collection_disabled" ||
    error.reasonCode === "settings_unavailable";
  const stopRun = error.kind === "unavailable" || configurationRefusal;
  const reasonCode: CompetitorReasonCode = stopRun
    ? "collection_unavailable"
    : "collection_not_eligible";

  // The log carries the reason the DATABASE gave, verbatim. It is one of
  // the closed reason codes of the accepted SQL: never provider text, never
  // a policy list and never a credential.
  ports.log({
    event: "competitor_provider_call_refused",
    jobId: job.jobId,
    watchlistId: job.watchlistId,
    outcome: "abandoned",
    reasonCode: error.reasonCode,
    durationMs: ports.now() - context.startedAt,
  });

  if (error.auditFailed) {
    // The refusal row did not commit. The work stops and the audit failure
    // is reported: a row that did not commit is never reported as stored.
    ports.log({
      event: "competitor_provider_call_audit_failed",
      jobId: job.jobId,
      watchlistId: job.watchlistId,
      outcome: "abandoned",
      reasonCode: "collection_unavailable",
      durationMs: ports.now() - context.startedAt,
    });
  }

  return { job: result(context, "abandoned", null, reasonCode, 0), stopRun };
}

/**
 * The no-viewer path.
 *
 * The paid fallback is used only when the injected policy authorises it.
 * Otherwise the entry is recorded as an error with a stable reason and the
 * job stays retryable.
 *
 * WHY THE PAID PATH IS NOT PERMIT-GUARDED
 *
 *   The permit requires a BOUND viewer: the accepted SQL refuses a
 *   competitor permit for a job that has no viewer context. The paid
 *   fallback is exactly the path with no viewer, so no permit can be
 *   obtained there. It is guarded by the injected policy instead, and the
 *   shipped composition injects a DISABLED one: the paid adapter is built
 *   but unreachable. The rollout policy still decides the TARGET: the
 *   claim only hands out admitted watchlists, and a policy refusal of a
 *   candidate never reaches this path.
 */
async function handleMissingViewer(context: JobContext): Promise<JobStep> {
  const policy = context.ports.paidFallback;

  if (!policy.enabled || !policy.provider) {
    return await persistFailure(context, "retry", policy.refusalReason,
      "No usable Instagram viewer is connected for this owner.");
  }

  const paid = policy.provider;
  const outcome = await providerStep(context, (signal) =>
    paid.capture({ username: context.username, signal })
  );

  if (outcome.status === "completed") {
    return { job: await persistCapture(context, "apify", outcome.capture), stopRun: false };
  }

  return await persistFailure(context, "retry", outcome.reason,
    "The paid fallback did not produce a usable capture.");
}

/**
 * The provider failure path.
 *
 * A throttle is recorded against the SHARED bucket AND parks this job,
 * which releases the lease. The parked job is not completed afterwards: a
 * parked job and a completed job are two different states.
 */
async function handleProviderFailure(
  context: JobContext,
  bucketKey: string,
  error: unknown,
): Promise<JobStep> {
  const { ports, job } = context;

  if (error instanceof CompetitorProviderPermitError) {
    // The request was not authorized. It is not a provider failure: it is
    // never retried and it never becomes a stored outcome.
    return await handlePermitFailure(context, error);
  }

  if (!(error instanceof CompetitorProviderError)) {
    return await persistFailure(context, "retry", "provider_error",
      "The provider request failed.");
  }

  if (error.kind === "rate_limited") {
    // Without the provider's own deadline the accepted throttle window is
    // used, so the shared bucket really blocks the next request.
    const until = error.throttledUntil ?? new Date(ports.now() + THROTTLE_WINDOW_MS);
    await write(context, (signal) =>
      ports.store.recordThrottle({
        bucketKey,
        usagePercent: Math.round(error.usagePercent),
        throttledUntil: until.toISOString(),
        jobId: job.jobId,
        claimToken: job.claimToken,
        jobGeneration: job.jobGeneration,
        signal,
      })
    );

    ports.log({
      event: "competitor_capture",
      jobId: job.jobId,
      watchlistId: job.watchlistId,
      outcome: "rate_limited",
      reasonCode: "rate_limited",
      usagePercent: error.usagePercent,
      durationMs: ports.now() - context.startedAt,
    });

    return { job: result(context, "retry", null, "rate_limited", 0), stopRun: true };
  }

  // Only the provider's typed "target unavailable" verdict opens the weekly
  // gate. A token, scope or transport failure is about the VIEWER.
  if (error.kind === "target_unavailable") {
    return await persistFailure(context, "unavailable", "target_unavailable",
      "The provider could not analyse this target.");
  }

  const reason: CompetitorReasonCode = error.kind === "token_invalid"
    ? "token_invalid"
    : error.kind === "scope_missing"
    ? "scope_missing"
    : "provider_error";
  return await persistFailure(context, "retry", reason,
    "The provider could not analyse this target.");
}

async function persistCapture(
  context: JobContext,
  source: CompetitorSource,
  capture: CompetitorCapture,
): Promise<ProcessedCompetitorJob> {
  const receipt = await persistOutcome(context, {
    outcome: "completed",
    source,
    profile: {
      metrics: {
        followers_count: capture.profile.followers_count,
        media_count: capture.profile.media_count,
      },
    },
    media: capture.media.map((item) => ({
      ig_media_id: item.ig_media_id,
      media_product_type: item.media_product_type,
      media_type: item.media_type,
      thumbnail_url: item.thumbnail_url,
      caption: item.caption,
      permalink: item.permalink,
      published_at: item.published_at,
      metrics: {
        like_count: item.like_count,
        comments_count: item.comments_count,
        view_count: item.view_count,
      },
    })),
    // The coverage travels with the payload because only the provider
    // knows what it observed. The worker never infers it: a sorted array
    // is not a verified order, and a capped window is not a complete feed.
    coverage: {
      capture_started_at: capture.coverage.captureStartedAt,
      capture_ended_at: capture.coverage.captureEndedAt,
      oldest_returned_at: capture.coverage.oldestReturnedAt,
      ordering_verified: capture.coverage.orderingVerified,
      cursor_present: capture.coverage.cursorPresent,
      exhausted: capture.coverage.exhausted,
      truncated: capture.coverage.truncated,
      gap_reason: capture.coverage.gapReason,
    },
  });

  context.ports.log({
    event: "competitor_capture",
    jobId: context.job.jobId,
    watchlistId: context.job.watchlistId,
    outcome: "completed",
    source,
    mediaCount: receipt.mediaCount,
    coverageComplete: receipt.coverage?.inventoryComplete ?? false,
    durationMs: context.ports.now() - context.startedAt,
  });

  return result(context, "completed", source, null, receipt.mediaCount);
}

async function persistFailure(
  context: JobContext,
  outcome: "retry" | "unavailable",
  reasonCode: CompetitorReasonCode,
  message: string,
): Promise<JobStep> {
  await persistOutcome(context, { outcome, reason_code: reasonCode, error_message: message });

  context.ports.log({
    event: "competitor_capture",
    jobId: context.job.jobId,
    watchlistId: context.job.watchlistId,
    outcome,
    reasonCode,
    durationMs: context.ports.now() - context.startedAt,
  });

  return { job: result(context, outcome, null, reasonCode, 0), stopRun: false };
}

/**
 * Writes one outcome.
 *
 * The store verifies the receipt against this request. A failed, refused or
 * late write throws, and the caller abandons the job to its lease: it is
 * never reported as stored and never retried.
 */
async function persistOutcome(
  context: JobContext,
  payload: CompetitorResultPayload,
): Promise<PersistResultReceipt> {
  const { job } = context;
  return await write(context, (signal) =>
    context.ports.store.persistResult({
      jobId: job.jobId,
      claimToken: job.claimToken,
      jobGeneration: job.jobGeneration,
      payload,
      signal,
    })
  );
}

/**
 * A provider step. It must leave the write reserve behind, its signal aborts
 * at that deadline, and it is raced so an abort-ignoring transport cannot
 * outlive it.
 */
function providerStep<T>(
  context: JobContext,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  return boundedStep(context.budget, WORKER_WRITE_RESERVE_MS, context.outer, work);
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
  budget: WorkerBudget,
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
