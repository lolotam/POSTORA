/**
 * Per-user limits for BYO Higgsfield generation.
 *
 * A BYO connection bypasses plan quota because the user pays Higgsfield directly —
 * but unmetered is not unlimited. Postora still carries the database growth, the
 * polling work, and the MCP concurrency, so these caps exist independently of quota.
 *
 * Shared by `generate-image` and `generate-video` so the two cannot drift.
 */

/** BYO jobs a user may start per rolling hour. */
const BYO_JOBS_PER_HOUR = 10;

/** BYO jobs a user may have in flight at once. */
const BYO_CONCURRENT_JOBS = 2;

export async function checkByoGenerationLimits(
  db: { from: (table: string) => any },
  userId: string,
): Promise<{ allowed: true } | { allowed: false; error: string }> {
  const hour = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const [recentResult, runningResult] = await Promise.all([
    db
      .from("ai_generation_jobs")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("credential_source", "byo")
      .gte("created_at", hour),
    db
      .from("ai_generation_jobs")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("credential_source", "byo")
      .in("status", ["queued", "running"]),
  ]);

  // Fail closed. A failed count returns `count: null` alongside an error, and
  // coalescing that to 0 would silently disable throttling for exactly as long as
  // the database is unhealthy — which is when an unbounded retry loop is most
  // likely to be hammering it. Deny instead, and say so.
  if (recentResult.error || runningResult.error) {
    console.error(
      "[higgsfield-rate-limit] count query failed:",
      recentResult.error?.message ?? runningResult.error?.message,
    );
    return { allowed: false, error: "Could not verify generation limits. Please retry." };
  }

  if ((recentResult.count ?? 0) >= BYO_JOBS_PER_HOUR) {
    return { allowed: false, error: "BYO generation hourly limit reached" };
  }
  if ((runningResult.count ?? 0) >= BYO_CONCURRENT_JOBS) {
    return { allowed: false, error: "Too many concurrent generations" };
  }
  return { allowed: true };
}
