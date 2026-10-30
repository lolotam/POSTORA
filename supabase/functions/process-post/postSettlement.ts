/**
 * What a post looks like once a deferred account has been settled, for notifications.
 *
 * A resumed run settles one account's row; the settle RPC rolls the post up when the last
 * pending row becomes terminal. That run then has to tell the user about the whole post, not
 * just its own account, and has to do it even if the read that finds out hits a database
 * hiccup: the row is already settled, the reconciler will never come back to it, so a
 * notification dropped here is dropped for good.
 *
 * Review follow-up F7/F8: docs/superpowers/specs/2026-10-30-hardening-review-followups-design.md.
 */

export interface PlatformResultSummary {
  platform: string;
  status: string;
  platform_post_url?: string;
  error_message?: string;
}

/** A platform_posts row as the notification reads it. */
export interface PlatformRow {
  platform: string;
  status: string;
  platform_post_url: string | null;
  error_message: string | null;
}

type Read<T> = PromiseLike<{ data: T | null; error: { message: string } | null }>;

/** The two reads the outcome needs; index.ts backs them with the service-role client. */
export interface PostReader {
  postStatus(postId: string): Read<{ status: string }>;
  platformRows(postId: string): Read<PlatformRow[]>;
}

export interface ResultsSummary {
  results: PlatformResultSummary[];
  hasSuccess: boolean;
  hasFailed: boolean;
}

export type PostOutcome =
  | ({ kind: "terminal"; status: "completed" | "failed"; degraded: string | null } & ResultsSummary)
  | { kind: "in_progress" }
  | { kind: "unknown"; error: string };

/** One result per platform_posts row, so an Instagram story and reel are both reported. */
export function summarizeRows(rows: PlatformRow[]): ResultsSummary {
  const results = rows.map((row): PlatformResultSummary => ({
    platform: row.platform,
    status: row.status,
    ...(row.platform_post_url ? { platform_post_url: row.platform_post_url } : {}),
    ...(row.error_message ? { error_message: row.error_message } : {}),
  }));
  return {
    results,
    hasSuccess: results.some((result) => result.status === "success"),
    hasFailed: results.some((result) => result.status === "failed"),
  };
}

export interface WebhookResultEntry {
  status: string;
  post_url: string | null;
}

export interface WebhookResultListEntry extends WebhookResultEntry {
  platform: string;
  error_message: string | null;
}

/** Which of several rows for one platform speaks for it in the legacy map. */
const STATUS_RANK: Record<string, number> = { success: 3, pending: 2, failed: 1 };

/**
 * The results part of the post.completed / post.failed webhook.
 *
 * `platform_results` is the legacy map, one entry per platform, which every existing consumer
 * (the n8n alert templates, Make) reads with Object.entries. Instagram can have several rows
 * (story, reel, feed), so the entry must not be whichever row came last: a live story would be
 * overwritten by a failed reel. A success speaks for the platform, then a pending row, then a
 * failure, and the link is the speaking row's own.
 *
 * `platform_results_list` is additive: one entry per row, nothing collapsed, for consumers that
 * need the story and the reel apart.
 */
export function buildWebhookResults(results: PlatformResultSummary[]): {
  platform_results: Record<string, WebhookResultEntry>;
  platform_results_list: WebhookResultListEntry[];
} {
  const legacy: Record<string, WebhookResultEntry> = {};
  const rank: Record<string, number> = {};
  for (const result of results) {
    const thisRank = STATUS_RANK[result.status] ?? 0;
    const current = legacy[result.platform];
    if (!current || thisRank > rank[result.platform]) {
      legacy[result.platform] = { status: result.status, post_url: result.platform_post_url || null };
      rank[result.platform] = thisRank;
    } else if (thisRank === rank[result.platform] && !current.post_url && result.platform_post_url) {
      current.post_url = result.platform_post_url;
    }
  }
  return {
    platform_results: legacy,
    platform_results_list: results.map((result) => ({
      platform: result.platform,
      status: result.status,
      post_url: result.platform_post_url || null,
      error_message: result.error_message || null,
    })),
  };
}

const RETRY_DELAY_MS = 250;

/** Reads once and, on an error or a throw, once more. Returns the last answer. */
async function readWithOneRetry<T>(
  read: () => Read<T>,
  sleep: (ms: number) => Promise<void>,
): Promise<{ data: T | null; error: string | null }> {
  let last: { data: T | null; error: string | null } = { data: null, error: "not read" };
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const { data, error } = await read();
      last = { data, error: error?.message ?? null };
    } catch (caught) {
      last = { data: null, error: caught instanceof Error ? caught.message : String(caught) };
    }
    if (!last.error) return last;
    if (attempt === 1) await sleep(RETRY_DELAY_MS);
  }
  return last;
}

/**
 * Where a post stands after a deferred account was settled, and the results to tell the user
 * about. Each read is retried once. A read that still fails is never read as "not finished":
 *   - the post row unreadable but its rows readable: terminal when no row is pending, with
 *     the status derived as the stale-post sweeper derives it (any success is completed);
 *   - the rows unreadable but the post terminal: terminal, reporting `fallback` (this run's
 *     own account) and saying so in `degraded`;
 *   - neither readable: `unknown`, which the caller must log, not swallow.
 */
export async function readPostOutcome(
  reader: PostReader,
  postId: string,
  fallback: ResultsSummary,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<PostOutcome> {
  const post = await readWithOneRetry(() => reader.postStatus(postId), sleep);
  const rows = await readWithOneRetry(() => reader.platformRows(postId), sleep);
  const rowSummary = rows.data && rows.data.length > 0 ? summarizeRows(rows.data) : null;

  if (!post.error && post.data) {
    if (post.data.status !== "completed" && post.data.status !== "failed") return { kind: "in_progress" };
    const status = post.data.status;
    return rowSummary
      ? { kind: "terminal", status, degraded: null, ...rowSummary }
      : { kind: "terminal", status, degraded: `platform rows unreadable (${rows.error ?? "none found"}); reporting this run's account only`, ...fallback };
  }

  const postProblem = post.error ?? "post not found";
  if (rowSummary && rows.data) {
    if (rows.data.some((row) => row.status === "pending")) return { kind: "in_progress" };
    return {
      kind: "terminal",
      status: rowSummary.hasSuccess ? "completed" : "failed",
      degraded: `post status unreadable (${postProblem}); derived from its platform rows`,
      ...rowSummary,
    };
  }
  return { kind: "unknown", error: `post: ${postProblem}; platform rows: ${rows.error ?? "none found"}` };
}

/** The system_logs row for a settled deferred account whose post could not be read afterwards. */
export function unreadableOutcomeLog(userId: string, postId: string, platformPostId: string | null, error: string) {
  return {
    level: "error",
    category: "post",
    source: "process-post",
    message: "A deferred account was settled but the post could not be read afterwards; its completion notifications were NOT sent",
    user_id: userId,
    metadata: { post_id: postId, platform_post_id: platformPostId, error },
  };
}
