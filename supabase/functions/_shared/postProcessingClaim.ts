/**
 * The compare-and-set that moves a post into `processing`.
 *
 * WHY A CLAIM AND NOT A PLAIN UPDATE
 * ----------------------------------
 * process-scheduled-posts SELECTs the due rows, refreshes tokens, and only
 * then invokes process-post -- tens of seconds later under load. In that
 * window a partner (or the UI) can unschedule the post, or move it to next
 * week, and get a 200. process-post used to write `status = 'processing'`
 * with a bare `.eq("id")`, so the post published anyway: a customer-visible
 * effect after the customer was told it would not happen.
 *
 * The scheduler now passes the `scheduled_at` it selected, and this claim
 * succeeds only if the row STILL carries it. Any change -- to NULL, or to a
 * different instant -- makes the claim match zero rows, and process-post
 * declines without touching a provider.
 *
 * A scheduler claim (a string expectation) also requires the row to still be
 * `pending` or `scheduled`. Scheduler runs are minute-apart cron ticks and a
 * slow run is still working through its list when the next one SELECTs the
 * same due rows; without the status guard both runs claimed the post and it
 * was published twice (2026-10-31, two posts, 16 s and 38 s apart). Only the
 * first claim moves the row to `processing`, so the second matches nothing.
 * Callers that pass no expectation (immediate publishes, retries of a
 * `failed` post) and the explicit-null TikTok review dispatch keep the
 * transition they always had, without a status guard.
 */
/** The statuses process-scheduled-posts selects; anything else is already taken. */
export const SCHEDULER_CLAIMABLE_STATUSES = ["pending", "scheduled"];

export interface PostProcessingClaim {
  claimed: boolean;
  error: string | null;
  /** Returned by the atomic transition; the image checkpoint uses it as the attempt fence. */
  processingStartedAt: string | null;
}

/** A request stamp takes precedence over any scheduled_at expectation, including null. */
export async function claimPostForProcessing(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  postId: string,
  expectedScheduledAt?: string | null,
  expectedPublishRequestedAt?: string,
): Promise<PostProcessingClaim> {
  // processing_started_at lets sweep_stale_processing_posts() tell a post stranded by a
  // killed worker from one claimed a minute ago.
  let transition = supabase
    .from("posts")
    .update({ status: "processing", processing_started_at: new Date().toISOString() })
    .eq("id", postId);

  if (typeof expectedPublishRequestedAt === "string") {
    transition = transition
      .eq("publish_requested_at", expectedPublishRequestedAt)
      .in("status", SCHEDULER_CLAIMABLE_STATUSES);
  } else if (expectedScheduledAt === null) {
    // PostgREST's `eq.null` matches nothing; NULL needs `is`.
    transition = transition.is("scheduled_at", null);
  } else if (expectedScheduledAt !== undefined) {
    transition = transition
      .eq("scheduled_at", expectedScheduledAt)
      .in("status", SCHEDULER_CLAIMABLE_STATUSES);
  }

  const { data, error } = await transition.select("id, processing_started_at");
  if (error) return { claimed: false, error: error.message ?? String(error), processingStartedAt: null };
  const claimed = (data ?? []).length > 0;
  return {
    claimed,
    error: null,
    processingStartedAt: claimed && typeof data[0]?.processing_started_at === "string" ? data[0].processing_started_at : null,
  };
}

/**
 * The processing claim of an agent action.
 *
 * WHY THIS IS NOT THE CLAIM ABOVE. The agent route (n8n / MCP) takes a lease
 * on the post it works on and publishes synchronously. The lease says who is
 * working on the post; it never moves the post to `processing`, and the
 * route decides which destinations to publish to from an application-side
 * snapshot of the results.
 *
 * That snapshot goes stale. Between the read and the worker that publishes, a
 * durable writer can mark a destination as one that may already hold the
 * publication. The snapshot cannot see it, so the publish goes out anyway and
 * the customer gets it twice.
 *
 * So the decision is the database's: this claim moves the post to
 * `processing` only while the lease is live AND every destination the caller
 * named is still safe to publish to, read under the lock of the post. A
 * refusal changes nothing, and it happens before any provider is touched.
 */
export interface ActionProcessingClaimRequest {
  postId: string;
  userId: string;
  actionClaimId: string;
  accountIds: string[];
}

export interface ActionProcessingClaim {
  claimed: boolean;
  error: string | null;
  /** Why the claim was refused, in the vocabulary of the database. */
  reason: string | null;
  /** The destinations that refused, and why each of them refused. */
  blocked: Array<{ account_id: string; reason: string }>;
  processingStartedAt: string | null;
}

/**
 * The reasons the database refuses with, in words the caller can read.
 *
 * The reasons name what happened, never whose: a customer identifier has no
 * place in a message that is written to a log and read by an operator.
 */
const ACTION_CLAIM_REFUSAL_REASON: Record<string, string> = {
  claim_not_live: "the action that asked for this publish no longer holds the post",
  not_terminal: "the post is not finished, so it cannot be published again",
  no_targets: "the accounts this retry named are not the owner's",
  targets_not_admissible: "a destination of this post is not safe to publish to again",
};

const ACTION_CLAIM_BLOCKED_REASON: Record<string, string> = {
  publish_outcome_protected: "the outcome of the last attempt there is unknown or was cancelled",
  threads_deferred_uncertain: "a deferred Threads image of this post may already be on the profile",
  youtube_upload_in_flight: "a YouTube upload of this post may already have created a video",
  publish_in_flight: "a publish of this post is still going out",
  already_published: "that account already published this post",
};

function readBlockedDestinations(value: unknown): Array<{ account_id: string; reason: string }> {
  if (!Array.isArray(value)) return [];
  const blocked: Array<{ account_id: string; reason: string }> = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const row = entry as { account_id?: unknown; reason?: unknown };
    if (typeof row.account_id !== "string" || typeof row.reason !== "string") continue;
    blocked.push({ account_id: row.account_id, reason: row.reason });
  }
  return blocked;
}

/**
 * The one call the agent claim makes.
 *
 * The client is narrowed to the call this module makes, so the claim can be
 * handed a plain stub in a test and the real client in production.
 */
interface ActionProcessingClaimRpc {
  rpc(
    name: string,
    args: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: { message: string } | null }>;
}

/**
 * The claim that an agent action makes before it publishes.
 *
 * The lease the route holds is the identity of the run: the database checks
 * that the lease is the exact claim on the post and that it has not run out,
 * so a run that lost its lease, or a run that never had one, publishes
 * nothing.
 */
export async function claimPostForActionProcessing(
  supabase: ActionProcessingClaimRpc,
  request: ActionProcessingClaimRequest,
): Promise<ActionProcessingClaim> {
  const { data, error } = await supabase.rpc("claim_post_action_processing", {
    p_post_id: request.postId,
    p_user_id: request.userId,
    p_action_claim_id: request.actionClaimId,
    p_target_account_ids: request.accountIds,
  });
  if (error) {
    return {
      claimed: false,
      error: error.message ?? String(error),
      reason: null,
      blocked: [],
      processingStartedAt: null,
    };
  }
  const result = (data ?? {}) as {
    status?: unknown;
    reason?: unknown;
    blocked?: unknown;
    processing_started_at?: unknown;
  };
  if (result.status !== "claimed") {
    return {
      claimed: false,
      error: null,
      reason: typeof result.reason === "string" ? result.reason : "refused",
      blocked: readBlockedDestinations(result.blocked),
      processingStartedAt: null,
    };
  }
  return {
    claimed: true,
    error: null,
    reason: null,
    blocked: [],
    // The instant is the one the database stored, read back as it was written:
    // rounding it to milliseconds would make it a different instant than the
    // row carries, and the fences that compare the two would not match.
    processingStartedAt: typeof result.processing_started_at === "string"
      ? result.processing_started_at
      : null,
  };
}

/** The sentence a refusal is reported with. */
export function actionProcessingRefusalMessage(claim: ActionProcessingClaim): string {
  const blocked = claim.blocked
    .map((entry) => ACTION_CLAIM_BLOCKED_REASON[entry.reason] ?? entry.reason)
    .join("; ");
  if (blocked) {
    return `The post was not published: ${blocked}.`;
  }
  const reason = claim.reason ? ACTION_CLAIM_REFUSAL_REASON[claim.reason] ?? claim.reason : "the claim was refused";
  return `The post was not published: ${reason}.`;
}
