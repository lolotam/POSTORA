// Generic background job worker.
//
// One job at a time, one claim token per job, one deadline per chunk. Every write the worker
// makes is fenced by that token, so a worker whose lease expired cannot overwrite the result
// of the worker that took over. Nothing here knows what a job does: the handlers do.

export const BACKGROUND_JOBS_LIMITS = {
  /** Mirrors the sweep in 20261108120000_background_jobs.sql. */
  lease: "3 minutes",
  tickBudgetMs: 50_000,
  workerLifetimeMs: 150_000,
  minRemainingToClaimMs: 60_000,
  chunkBudgetMs: 40_000,
  writeReserveMs: 5_000,
} as const;

/** The job's own default. A job with attempts left is reclaimed before the sweep gives up on it. */
export const BACKGROUND_JOBS_MAX_ATTEMPTS = 3;

export interface ClaimedJob {
  id: string;
  user_id: string;
  kind: string;
  payload: Record<string, unknown>;
  attempts: number;
  claim_token: string;
}

export type JobOutcome =
  | { kind: "done"; result: Record<string, unknown> }
  | {
    kind: "continue";
    payload?: Record<string, unknown>;
    progress: Record<string, unknown>;
    runAfterMs?: number;
  }
  | { kind: "failed"; error: string; retryable: boolean };

export type JobHandler = (job: ClaimedJob, deadlineMs: number) => Promise<JobOutcome>;

export interface BackgroundJobsWorkerPorts {
  now(): number;
  workerStartedAtMs: number;
  handlers: Record<string, JobHandler>;
  claim(kinds: string[], lease: string): Promise<ClaimedJob | null>;
  continueJob(job: ClaimedJob, outcome: Extract<JobOutcome, { kind: "continue" }>): Promise<boolean>;
  complete(
    job: ClaimedJob,
    status: "succeeded" | "failed",
    result: Record<string, unknown> | null,
    error: string | null,
  ): Promise<boolean>;
  log(
    level: "info" | "error",
    userId: string,
    message: string,
    metadata: Record<string, unknown>,
  ): Promise<void>;
}

export interface BackgroundJobsWorkerSummary {
  claimed: number;
  done: number;
  continued: number;
  failed: number;
  lost: number;
}

/**
 * Only a short code reaches a log row or the job's error column. A handler that returns free
 * text could carry a phone number or a provider token, and this row is read by support.
 */
export function safeErrorCode(error: string): string {
  return /^[a-z0-9_]{1,64}$/.test(error) ? error : "unknown_error";
}

export async function runBackgroundJobsWorker(
  ports: BackgroundJobsWorkerPorts,
): Promise<BackgroundJobsWorkerSummary> {
  const L = BACKGROUND_JOBS_LIMITS;
  const tickStartedAt = ports.now();
  const kinds = Object.keys(ports.handlers);
  const summary: BackgroundJobsWorkerSummary = {
    claimed: 0,
    done: 0,
    continued: 0,
    failed: 0,
    lost: 0,
  };

  while (ports.now() - tickStartedAt < L.tickBudgetMs) {
    // Never lease a job the worker cannot finish inside its own lifetime.
    if (ports.workerStartedAtMs + L.workerLifetimeMs - ports.now() < L.minRemainingToClaimMs) break;

    const job = await ports.claim(kinds, L.lease);
    if (!job) break;
    summary.claimed++;

    const deadlineMs = Math.min(
      ports.now() + L.chunkBudgetMs,
      ports.workerStartedAtMs + L.workerLifetimeMs - L.writeReserveMs,
    );

    let outcome: JobOutcome;
    try {
      outcome = await ports.handlers[job.kind](job, deadlineMs);
    } catch {
      // A handler must persist dispatch intent before provider mutations. A reclaimed
      // handler reloads that state; an exception alone never proves a send did not happen.
      outcome = { kind: "failed", error: "handler_failed", retryable: true };
    }

    if (outcome.kind === "done") {
      const ok = await ports.complete(job, "succeeded", outcome.result, null);
      if (ok) summary.done++;
      else summary.lost++;
      await ports.log(ok ? "info" : "error", job.user_id, "background job finished", {
        job_id: job.id,
        kind: job.kind,
        outcome: "done",
      });
      continue;
    }

    if (outcome.kind === "continue") {
      const ok = await ports.continueJob(job, outcome);
      if (ok) summary.continued++;
      else summary.lost++;
      await ports.log(ok ? "info" : "error", job.user_id, "background job continues", {
        job_id: job.id,
        kind: job.kind,
        outcome: "continue",
      });
      continue;
    }

    const error = safeErrorCode(outcome.error);
    if (outcome.retryable && job.attempts < BACKGROUND_JOBS_MAX_ATTEMPTS) {
      // The job stays running on purpose: the lease expires and the job is reclaimed with
      // attempts + 1. After the last attempt the sweep exhausts it.
      await ports.log("error", job.user_id, "background job failed and will be retried", {
        job_id: job.id,
        kind: job.kind,
        outcome: "failed",
        error,
        attempts: job.attempts,
      });
      continue;
    }

    const ok = await ports.complete(job, "failed", null, error);
    if (ok) summary.failed++;
    else summary.lost++;
    await ports.log("error", job.user_id, "background job failed", {
      job_id: job.id,
      kind: job.kind,
      outcome: "failed",
      error,
    });
  }

  return summary;
}
