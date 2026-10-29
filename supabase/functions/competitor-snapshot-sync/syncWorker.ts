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
 * WHY A FAILED ATTEMPT IS STILL RECORDED
 *
 *   "There is no usable viewer" is a fact about the owner's account, and
 *   the owner has to be able to read it. The result write records it, sets
 *   the entry to error and leaves the job retryable. A weekly "the target
 *   is gone" verdict is reserved for the one outcome that PROVES the
 *   target cannot be analysed.
 */

import { pickBusinessDiscoveryViewer } from "../_shared/instagramDiscoveryViewer.ts";

import { type CompetitorServiceStore, CompetitorStoreError } from "./store.ts";
import {
  CompetitorProviderError,
  type ClaimedCompetitorJob,
  type CompetitorCapture,
  type CompetitorDrainSummary,
  type CompetitorProvider,
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
  const viewer = pickBusinessDiscoveryViewer(ordered);

  if (!viewer) {
    return await handleMissingViewer(context);
  }

  const attached = await read(context, (signal) =>
    ports.store.attachViewerContext({
      jobId: job.jobId,
      claimToken: job.claimToken,
      jobGeneration: job.jobGeneration,
      viewerSocialAccountId: viewer.id,
      signal,
    })
  );

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
        signal,
      })
    );
    capture = outcome.capture;
    usagePercent = outcome.usagePercent;
  } catch (error) {
    if (error instanceof BudgetExceededError) throw error;
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
 * The no-viewer path.
 *
 * The paid fallback is used only when the injected policy authorises it.
 * Otherwise the entry is recorded as an error with a stable reason and the
 * job stays retryable.
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
  });

  context.ports.log({
    event: "competitor_capture",
    jobId: context.job.jobId,
    watchlistId: context.job.watchlistId,
    outcome: "completed",
    source,
    mediaCount: receipt.mediaCount,
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
