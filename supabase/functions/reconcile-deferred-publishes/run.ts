/**
 * One reconciler pass: finish due deferred Meta containers, then sweep stranded posts.
 *
 * Every minute, pg_cron calls this function. It leases the deferred platform_posts
 * rows that are due (claim_deferred_publishes), asks process-post to resume each
 * one, and then settles posts stuck in `processing` with nothing left to finish
 * (sweep_stale_processing_posts). Spec: docs/superpowers/specs/
 * 2026-10-29-hardening-followups-design.md, Part B2.
 */

export type ClaimedRow =
  | { kind?: "deferred_publish"; platform_post_id: string; post_id: string; candidate_id?: never }
  | { kind: "notification_only"; platform_post_id?: null; post_id: string; attempt_started_at: string; candidate_id: string; claim_id: string }
  /**
   * A YouTube upload that a worker left half written.
   *
   * `candidate_id` is the upload session and `claim_id` is the claim token.
   * The session URI is NOT here: it stays in the private session table and is
   * read by the worker with the token.
   */
  | { kind: "youtube_upload_continuation"; platform_post_id?: null; post_id: string; attempt_started_at: string; candidate_id: string; claim_id: string };

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/**
 * Whether a row the claim returned is one this reconciler can act on.
 *
 * The claim is the boundary with the database, so a row that does not have the
 * shape its kind promises is refused rather than acted on. A row that claims
 * to be a continuation without a token, or that carries a public row id it
 * should not have, is refused: acting on it would dispatch a body the worker
 * cannot use.
 */
export function isWellFormedClaimRow(row: unknown): row is ClaimedRow {
  if (!row || typeof row !== "object") return false;
  const candidate = row as Record<string, unknown>;
  if (!nonEmptyString(candidate.post_id)) return false;
  if (candidate.kind === "notification_only" || candidate.kind === "youtube_upload_continuation") {
    return nonEmptyString(candidate.candidate_id) &&
      nonEmptyString(candidate.claim_id) &&
      nonEmptyString(candidate.attempt_started_at) &&
      candidate.platform_post_id == null;
  }
  return candidate.kind === "deferred_publish" && nonEmptyString(candidate.platform_post_id);
}

/**
 * The body the reconciler sends to process-post for one claimed row.
 *
 * The YouTube continuation carries the session id and the claim token and
 * nothing else. The session URI is a credential: it stays in the private
 * session table, where the worker reads it with the token, so it never
 * travels in this body.
 */
export function resumePayload(row: ClaimedRow): Record<string, unknown> {
  if (row.kind === "notification_only") {
    return {
      post_id: row.post_id,
      notification_only: true,
      attempt_started_at: row.attempt_started_at,
      candidate_id: row.candidate_id,
      notification_claim_id: row.claim_id,
    };
  }
  if (row.kind === "youtube_upload_continuation") {
    return {
      post_id: row.post_id,
      resume_youtube_upload_session_id: row.candidate_id,
      resume_youtube_upload_lease_token: row.claim_id,
      attempt_started_at: row.attempt_started_at,
    };
  }
  return {
    post_id: row.post_id,
    resume_platform_post_id: row.platform_post_id,
  };
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
      const row = claimed[index];
      const targetId = row.platform_post_id || row.candidate_id || row.post_id;
      failures.push({ platform_post_id: targetId, error: (outcome.error ?? "unknown").slice(0, 300) });
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
