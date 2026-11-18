/** A post's result row as the history page holds it: enough to tell what failed, and where. */
export interface RetryResultRow {
  platform: string;
  status: string | null;
  social_account_id?: string | null;
  response_data?: Record<string, unknown> | null;
}

/**
 * The publish outcomes that are not a proven failure.
 *
 * `uncertain` means the provider may already hold the publication: the result
 * row was lost, not the publication. `cancelled` means the attempt was
 * cancelled before the destination was reached. Neither may be retried
 * automatically, because a retry can publish a second time.
 *
 * The marker is written by the row itself, so it holds for every platform and
 * not only for YouTube. The database refuses the same rows in the one place
 * every retry path goes through; the page must not offer them either.
 */
const NON_RETRYABLE_OUTCOMES = new Set(["uncertain", "cancelled"]);

/**
 * Whether this result may not be published again.
 *
 * An `uncertain` outcome may already have been published, so a retry could
 * publish a second copy. A `cancelled` outcome belongs to an attempt the owner
 * stopped, so it is not republished either.
 */
export function hasNonRetryableOutcome(row: RetryResultRow): boolean {
  const outcome = row.response_data?.publish_outcome;
  return typeof outcome === "string" && NON_RETRYABLE_OUTCOMES.has(outcome);
}

/**
 * What a "retry failed" may publish to: the accounts of the failed rows, and their platforms.
 *
 * Without account ids, process-post publishes to every account the post selected, so a post that
 * went out on Facebook but failed on Instagram would be posted to Facebook a second time. A failed
 * row that names no account cannot be targeted, so it is left out, as the n8n/MCP retry does; with
 * no targetable row there is nothing to retry (empty lists).
 *
 * A result whose outcome is unknown or cancelled is left out as well: its account is not safe to
 * publish to again.
 */
export function failedRetryTargets(rows: RetryResultRow[] | undefined): { platforms: string[]; accountIds: string[] } {
  const targetable = (rows ?? []).filter((row) => row.status === "failed" && row.social_account_id && !hasNonRetryableOutcome(row));
  return {
    platforms: [...new Set(targetable.map((row) => row.platform))],
    accountIds: [...new Set(targetable.map((row) => row.social_account_id as string))],
  };
}
