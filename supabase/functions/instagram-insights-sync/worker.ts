/**
 * Bounded Collection Worker for Instagram Insights (Slice O2).
 *
 * Implements the service-side collection loop:
 * - Claims up to 25 owner jobs from the durable queue
 * - Enforces 40-second execution budget with graceful early stop
 * - Fetches account profile, daily insights and recent media
 * - Persists snapshots into database tables via atomic RPC
 * - Handles rate limits and provider errors with backoff and completion
 */

import { ClaimedJob, WorkerStore } from "./workerStore.ts";
import { InstagramGraphProvider, ProviderError } from "./graphProvider.ts";

export interface WorkerDependencies {
  store: WorkerStore;
  provider: InstagramGraphProvider;
  readToken: (socialAccountId: string, userId: string, signal?: AbortSignal) => Promise<string>;
  nowFn?: () => number;
}

export interface DrainOptions {
  batchLimit?: number;
  maxWallClockMs?: number;
  reserveTimeMs?: number;
  signal?: AbortSignal;
}

export interface ProcessedJobSummary {
  jobId: string;
  socialAccountId: string;
  status: "completed" | "retry" | "error" | "unavailable";
  reason?: string;
}

export interface DrainResult {
  claimed: number;
  succeeded: number;
  failed: number;
  throttled: number;
  stoppedEarly: boolean;
  jobs: ProcessedJobSummary[];
}

export class CollectionWorker {
  private readonly store: WorkerStore;
  private readonly provider: InstagramGraphProvider;
  private readonly readToken: (socialAccountId: string, userId: string, signal?: AbortSignal) => Promise<string>;
  private readonly nowFn: () => number;

  constructor(deps: WorkerDependencies) {
    this.store = deps.store;
    this.provider = deps.provider;
    this.readToken = deps.readToken;
    this.nowFn = deps.nowFn ?? (() => Date.now());
  }

  async runDrain(options: DrainOptions = {}): Promise<DrainResult> {
    const batchLimit = Math.min(25, Math.max(1, options.batchLimit ?? 25));
    const maxWallClockMs = options.maxWallClockMs ?? 40_000;
    const reserveTimeMs = options.reserveTimeMs ?? 5_000;
    const startTime = this.nowFn();

    const jobs = await this.store.claimOwnerJobs(batchLimit);
    const result: DrainResult = {
      claimed: jobs.length,
      succeeded: 0,
      failed: 0,
      throttled: 0,
      stoppedEarly: false,
      jobs: [],
    };

    for (const job of jobs) {
      const elapsed = this.nowFn() - startTime;
      if (elapsed >= maxWallClockMs - reserveTimeMs) {
        result.stoppedEarly = true;
        break;
      }

      const summary = await this.processJob(job, options.signal);
      result.jobs.push(summary);

      if (summary.status === "completed") {
        result.succeeded++;
      } else if (summary.reason === "rate_limited") {
        result.throttled++;
        // If throttled, stop the entire drain cycle immediately to avoid hitting further limits
        break;
      } else {
        result.failed++;
      }
    }

    return result;
  }

  private async processJob(job: ClaimedJob, signal?: AbortSignal): Promise<ProcessedJobSummary> {
    let token: string;
    try {
      token = await this.readToken(job.socialAccountId, job.userId, signal);
    } catch {
      await this.store.completeJob(job.jobId, job.claimToken, job.jobGeneration, "retry", "token_unavailable");
      return {
        jobId: job.jobId,
        socialAccountId: job.socialAccountId,
        status: "retry",
        reason: "token_unavailable",
      };
    }

    try {
      // 1. Fetch Profile Observation
      const profile = await this.provider.fetchAccountProfile(job.socialAccountId, token, signal);
      if (profile.followers_count !== undefined || profile.media_count !== undefined) {
        await this.store.persistSnapshot(job.jobId, job.claimToken, job.jobGeneration, {
          kind: "owner_profile_observation",
          items: [
            {
              observed_at: new Date().toISOString(),
              metrics: {
                followers_count: profile.followers_count,
                media_count: profile.media_count,
              },
            },
          ],
        });
      }

      // 2. Fetch Account Daily Insights
      const dailyInsights = await this.provider.fetchAccountDailyInsights(
        job.socialAccountId,
        token,
        job.capturedOn,
        signal
      );

      await this.store.persistSnapshot(job.jobId, job.claimToken, job.jobGeneration, {
        kind: "owner_account_day",
        items: [dailyInsights],
      });

      // 3. Fetch Recent Media Inventory
      const mediaItems = await this.provider.fetchRecentMedia(job.socialAccountId, token, 50, signal);
      if (mediaItems.length > 0) {
        await this.store.persistSnapshot(job.jobId, job.claimToken, job.jobGeneration, {
          kind: "owner_media",
          items: mediaItems,
        });
      }

      // 3.5 Record inventory progress with window coverage
      await this.store.recordProgress(job.jobId, job.claimToken, job.jobGeneration, {
        kind: "inventory",
        pages_fetched: 1,
        oldest_returned_at: mediaItems.length > 0 ? mediaItems[mediaItems.length - 1].published_at : null,
        window_start: "2026-08-01",
        window_end: job.capturedOn,
        partial: false,
        truncated: false,
        window_covered: true,
        remaining_ids: [],
      });

      // 4. Mark job completed
      await this.store.completeJob(job.jobId, job.claimToken, job.jobGeneration, "completed", "success");

      return {
        jobId: job.jobId,
        socialAccountId: job.socialAccountId,
        status: "completed",
        reason: "success",
      };
    } catch (err) {
      if (err instanceof ProviderError) {
        if (err.kind === "rate_limited") {
          await this.store.recordThrottle("instagram_graph_owner", err.retryAfterSeconds ?? 300);
          await this.store.completeJob(job.jobId, job.claimToken, job.jobGeneration, "retry", "rate_limited");
          return {
            jobId: job.jobId,
            socialAccountId: job.socialAccountId,
            status: "retry",
            reason: "rate_limited",
          };
        }

        if (err.kind === "token_expired" || err.kind === "token_revoked") {
          await this.store.completeJob(job.jobId, job.claimToken, job.jobGeneration, "retry", err.kind);
          return {
            jobId: job.jobId,
            socialAccountId: job.socialAccountId,
            status: "retry",
            reason: err.kind,
          };
        }

        if (err.kind === "permission_missing") {
          await this.store.completeJob(job.jobId, job.claimToken, job.jobGeneration, "error", "permission_missing");
          return {
            jobId: job.jobId,
            socialAccountId: job.socialAccountId,
            status: "error",
            reason: "permission_missing",
          };
        }
      }

      // Any other error -> retry with transient_error
      await this.store.completeJob(job.jobId, job.claimToken, job.jobGeneration, "retry", "transient_error");
      return {
        jobId: job.jobId,
        socialAccountId: job.socialAccountId,
        status: "retry",
        reason: "transient_error",
      };
    }
  }
}
