/** A post's result row as the history page holds it: enough to tell what failed, and where. */
export interface RetryResultRow {
  platform: string;
  status: string | null;
  social_account_id?: string | null;
}

/**
 * What a "retry failed" may publish to: the platforms of the failed rows, and their accounts.
 *
 * Without a target, process-post publishes to every account the post selected, so a post that
 * went out on Facebook but failed on Instagram would be posted to Facebook a second time. The
 * accounts are sent only when every failed row names one; otherwise the platforms alone narrow
 * it as far as the rows allow.
 */
export function failedRetryTargets(rows: RetryResultRow[] | undefined): { platforms: string[]; accountIds: string[] } {
  const failed = (rows ?? []).filter((row) => row.status === "failed");
  const platforms = [...new Set(failed.map((row) => row.platform))];
  const accountIds = failed.every((row) => row.social_account_id)
    ? [...new Set(failed.map((row) => row.social_account_id as string))]
    : [];
  return { platforms, accountIds };
}
