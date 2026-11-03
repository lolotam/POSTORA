import type { AnalyticsReport } from "../_shared/analyticsContract.ts";
import { assembleStoredAnalytics } from "./assemble.ts";
import { storedReportCursor, storedReportPosition, type StoredReportScope } from "./cursor.ts";
import { PersistedReportRefused, readStoredAnalytics, type StoredAnalyticsRpc } from "./store.ts";

export async function persistedOwnedAnalyticsReport(input: { scope: StoredReportScope; cursor: string | null; secret: string;
  now: string; rpc: StoredAnalyticsRpc; signal: AbortSignal }): Promise<AnalyticsReport> {
  const { windows, after } = await storedReportPosition(input);
  const stored = await readStoredAnalytics({ ...input.scope, rpc: input.rpc, request: { since: windows.current.period.since, until: windows.current.period.until, limit: 25,
    ...(after ? { expected_revision: after.revision, after_published_at: after.publishedAt, after_id: after.postId } : {}) }, signal: input.signal });
  if (Date.parse(stored.since) !== Date.parse(windows.current.period.since) || Date.parse(stored.until) !== Date.parse(windows.current.period.until)
    || Date.parse(stored.previous_since) !== Date.parse(windows.previous.period.since) || stored.timezone !== windows.current.period.timezone) throw new PersistedReportRefused("invalid_contract", 503);
  const hasMore = stored.posts.length > 25;
  const last = stored.posts[24]?.post;
  if (hasMore && stored.revision === null) throw new PersistedReportRefused("invalid_contract", 503);
  const nextCursor = hasMore ? await storedReportCursor({ scope: input.scope, period: windows.current.period, revision: stored.revision!,
    publishedAt: last.published_at, postId: last.platform_post_id, secret: input.secret }) : null;
  return assembleStoredAnalytics({ stored, windows, generatedAt: new Date().toISOString(), nextCursor, hasMore });
}
