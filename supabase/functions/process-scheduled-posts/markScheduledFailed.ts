// deno-lint-ignore-file no-explicit-any

/**
 * Marks a scheduled post failed after the scheduler's call to process-post failed, but only while
 * nobody holds it: still due at the scheduled_at this run selected and still claimable. If
 * process-post claimed it before the call failed (a dropped connection while it publishes), it is
 * `processing` and process-post or the stale-processing sweeper settles it; a `completed` row must
 * never become `failed`. A row that carries a publish request is left queued too: the request query
 * skips it during its grace period, and a retry's failed results are already cleared, so `failed`
 * would leave nothing for the next run to pick up.
 *
 * `marked` is true only when the update confirmed a row; an update error leaves the state unknown.
 */
export async function markScheduledPostFailed(
  supabase: any,
  postId: string,
  scheduledAt: string,
): Promise<{ marked: boolean; error: string | null }> {
  const { data, error } = await supabase
    .from("posts")
    .update({ status: "failed" })
    .eq("id", postId)
    .eq("scheduled_at", scheduledAt)
    .in("status", ["pending", "scheduled"])
    .is("publish_requested_at", null)
    .select("id");
  if (error) return { marked: false, error: error.message };
  return { marked: (data ?? []).length > 0, error: null };
}
