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
 * The status is deliberately NOT part of the predicate: retrying a `failed`
 * post through process-post is a supported path, and a status guard here
 * would break it. Callers that pass no expectation (immediate publishes,
 * retries) keep the unconditional transition they always had.
 */
export interface PostProcessingClaim {
  claimed: boolean;
  error: string | null;
}

export async function claimPostForProcessing(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  postId: string,
  expectedScheduledAt?: string | null,
): Promise<PostProcessingClaim> {
  // processing_started_at lets sweep_stale_processing_posts() tell a post stranded by a
  // killed worker from one claimed a minute ago.
  let transition = supabase
    .from("posts")
    .update({ status: "processing", processing_started_at: new Date().toISOString() })
    .eq("id", postId);

  if (expectedScheduledAt === null) {
    // PostgREST's `eq.null` matches nothing; NULL needs `is`.
    transition = transition.is("scheduled_at", null);
  } else if (expectedScheduledAt !== undefined) {
    transition = transition.eq("scheduled_at", expectedScheduledAt);
  }

  const { data, error } = await transition.select("id");
  if (error) return { claimed: false, error: error.message ?? String(error) };
  return { claimed: (data ?? []).length > 0, error: null };
}
