/** A post's result row as the history page holds it: enough to tell what failed, and where. */
export interface RetryResultRow {
  platform: string;
  status: string | null;
  social_account_id?: string | null;
}

/**
 * What a "retry failed" may publish to: the accounts of the failed rows, and their platforms.
 *
 * Without account ids, process-post publishes to every account the post selected, so a post that
 * went out on Facebook but failed on Instagram would be posted to Facebook a second time. A failed
 * row that names no account cannot be targeted, so it is left out, as the n8n/MCP retry does; with
 * no targetable row there is nothing to retry (empty lists).
 */
export function failedRetryTargets(rows: RetryResultRow[] | undefined): { platforms: string[]; accountIds: string[] } {
  const targetable = (rows ?? []).filter((row) => row.status === "failed" && row.social_account_id);
  return {
    platforms: [...new Set(targetable.map((row) => row.platform))],
    accountIds: [...new Set(targetable.map((row) => row.social_account_id as string))],
  };
}
