/**
 * One reconciler pass: finish due deferred Meta containers, then sweep stranded posts.
 *
 * Every minute, pg_cron calls this function. It leases the deferred platform_posts
 * rows that are due (claim_deferred_publishes), asks process-post to resume each
 * one, and then settles posts stuck in `processing` with nothing left to finish
 * (sweep_stale_processing_posts). Spec: docs/superpowers/specs/
 * 2026-10-29-hardening-followups-design.md, Part B2.
 */

export interface ClaimedRow {
  platform_post_id: string;
  post_id: string;
}

export interface ResumeOutcome {
  ok: boolean;
  /** process-post's answer: completed, failed, processing or skipped. */
  status?: string;
  error?: string;
}

export interface ReconcilePorts {
  claim(limit: number): Promise<ClaimedRow[]>;
  resume(row: ClaimedRow): Promise<ResumeOutcome>;
  sweep(): Promise<{ posts: number; rows_failed: number }>;
  log(level: "info" | "warn" | "error", message: string, metadata: Record<string, unknown>): Promise<void>;
}

export interface ReconcileSummary {
  claimed: number;
  resumed: Record<string, number>;
  resume_errors: number;
  swept_posts: number;
  swept_rows: number;
  sweep_error: string | null;
}

/** Rows finished per run; each resume can take most of a minute, and they run together. */
export const RESUMES_PER_RUN = 5;

export async function runReconcile(ports: ReconcilePorts, limit = RESUMES_PER_RUN): Promise<ReconcileSummary> {
  const claimed = await ports.claim(limit);

  const outcomes = await Promise.all(claimed.map(async (row) => {
    try {
      return await ports.resume(row);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }));

  const resumed: Record<string, number> = {};
  const failures: { platform_post_id: string; error: string }[] = [];
  outcomes.forEach((outcome, index) => {
    if (outcome.ok) {
      const key = outcome.status ?? "unknown";
      resumed[key] = (resumed[key] ?? 0) + 1;
    } else {
      failures.push({ platform_post_id: claimed[index].platform_post_id, error: (outcome.error ?? "unknown").slice(0, 300) });
    }
  });

  let swept = { posts: 0, rows_failed: 0 };
  let sweepError: string | null = null;
  try {
    swept = await ports.sweep();
  } catch (error) {
    sweepError = error instanceof Error ? error.message : String(error);
  }

  const summary: ReconcileSummary = {
    claimed: claimed.length,
    resumed,
    resume_errors: failures.length,
    swept_posts: swept.posts,
    swept_rows: swept.rows_failed,
    sweep_error: sweepError,
  };

  // A quiet minute leaves no row; anything that happened, or went wrong, does.
  if (failures.length > 0 || sweepError) {
    await ports.log("error", "Deferred publish reconcile hit errors", { ...summary, failures });
  } else if (claimed.length > 0 || swept.posts > 0) {
    await ports.log("info", "Deferred publishes reconciled", { ...summary });
  }
  return summary;
}
