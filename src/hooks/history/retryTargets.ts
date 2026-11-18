/** A post's result row as the history page holds it: enough to tell what failed, and where. */
export interface RetryResultRow {
  platform: string;
  status: string | null;
  social_account_id?: string | null;
  response_data?: Record<string, unknown> | null;
}

/** A cancelled or possibly published destination must not be sent again. */
export function nonRetryableOutcome(row: RetryResultRow): "uncertain" | "cancelled" | undefined {
  const outcome = row.response_data?.publish_outcome;
  if (outcome === "uncertain" || outcome === "cancelled") return outcome;
  const deferred = row.response_data?.deferred;
  if (row.platform === "threads" && deferred && typeof deferred === "object" &&
    "media_type" in deferred && deferred.media_type === "IMAGE" &&
    "publish_outcome" in deferred && deferred.publish_outcome === "uncertain") {
    return "uncertain";
  }
}

export function hasNonRetryableOutcome(row: RetryResultRow): boolean {
  return nonRetryableOutcome(row) !== undefined;
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
  const protectedAccountIds = new Set(rows?.filter((row) =>
    hasNonRetryableOutcome(row) || row.status === "pending" ||
    (row.status === "success" && row.platform !== "instagram")
  ).map((row) => row.social_account_id));
  const targetable = (rows ?? []).filter((row) =>
    row.status === "failed" && row.social_account_id && !protectedAccountIds.has(row.social_account_id)
  );
  return {
    platforms: [...new Set(targetable.map((row) => row.platform))],
    accountIds: [...new Set(targetable.map((row) => row.social_account_id as string))],
  };
}
