import {
  ANALYTICS_CONTRACT_VERSION, analyticsSyncState, isAnalyticsAccountMetricIncomplete,
  type AnalyticsPost, type AnalyticsReport, type UnavailableReason,
} from "../_shared/analyticsContract.ts";
import { closedAnalyticsPeriods, type AnalyticsPeriod, type AnalyticsPeriodDays } from "../_shared/analyticsCalendar.ts";
import { ANALYTICS_PLATFORM_CONFIGURATION, analyticsDefinitions } from "../_shared/analyticsRegistry.ts";
import { parseAnalyticsReport, normalizeAnalyticsPermalink } from "../_shared/analyticsSchema.ts";
import {
  AnalyticsCursorError, analyticsCursorScope, decodeAnalyticsCursor, type AnalyticsCursorPosition,
} from "./analyticsCursor.ts";
import { createAnalyticsContinuation } from "../_shared/metaAnalyticsCursor.ts";
import { projectThreadsAccountMetric, projectThreadsPostMetric, threadsUnavailableReason } from "./analyticsProjection.ts";
import { latestRetryAt, loadPostMetrics, type ThreadsInsightsProvider } from "./provider.ts";

const PAGE_LIMIT = 10;
const PROFILE_METRICS = ["views", "likes", "replies", "reposts", "quotes", "followers_count"] as const;
type UnifiedRefusal = {
  ok: false; status: number; reason: string; message: string; retryAt?: string | null; needsReauth?: boolean;
};
type UnifiedResult = { ok: true; report: AnalyticsReport; refusalReasons: string[] } | UnifiedRefusal;

async function projectPosts(provider: ThreadsInsightsProvider, listing: Awaited<ReturnType<ThreadsInsightsProvider["recentPosts"]>>, period: AnalyticsPeriod) {
  const page = listing.data;
  const validPage = page !== null && page.data.length <= PAGE_LIMIT && new Set(page.data.map((post) => post.id)).size === page.data.length;
  const selected = validPage ? page.data.filter((post) => {
    const publishedAt = Date.parse(post.timestamp);
    return publishedAt >= Date.parse(period.since) && publishedAt < Date.parse(period.until);
  }) : [];
  const replies = await loadPostMetrics(provider, selected);
  const items: AnalyticsPost[] = replies.map(({ post, insights }) => ({
    id: post.id, publishedAt: new Date(post.timestamp).toISOString(), text: post.text ?? "", permalink: normalizeAnalyticsPermalink(post.permalink),
    metrics: analyticsDefinitions("threads", "post").map((definition) => projectThreadsPostMetric(definition, insights, new Date().toISOString())),
  }));
  return { validPage, items, replies,
    incomplete: items.some((post) => post.metrics.some((metric) => metric.definition.capability === "available" && metric.current.status !== "available")) };
}

async function continuation(input: {
  listing: Awaited<ReturnType<ThreadsInsightsProvider["recentPosts"]>>; validPage: boolean;
  position: AnalyticsCursorPosition; scope: ReturnType<typeof analyticsCursorScope>; secret: string;
}) {
  const reason: UnavailableReason | null = input.listing.error ? threadsUnavailableReason(input.listing.error) : input.validPage ? null : "provider_error";
  const hasContinuation = input.validPage && input.listing.data?.paging?.next !== undefined;
  return await createAnalyticsContinuation({ validPage: input.validPage, hasContinuation, after: input.listing.data?.paging?.cursors?.after,
    reason, position: input.position, scope: input.scope, secret: input.secret, namespace: "threads" });
}

export async function unifiedThreadsReport(input: {
  provider: ThreadsInsightsProvider; ownerId: string; accountId: string; providerUserId: string;
  days: AnalyticsPeriodDays; cursor: string | null; signingSecret: string; now: string;
}): Promise<UnifiedResult> {
  const configuration = ANALYTICS_PLATFORM_CONFIGURATION.threads;
  const windows = closedAnalyticsPeriods({ now: input.now, days: input.days, timezone: configuration.providerBucketTimezone! });
  const scope = analyticsCursorScope(input.ownerId, input.accountId, windows.current.period);
  let position: AnalyticsCursorPosition;
  try { position = await decodeAnalyticsCursor(input.cursor, scope, input.signingSecret); }
  catch (error) {
    if (!(error instanceof AnalyticsCursorError)) throw error;
    return { ok: false, status: 400, reason: "invalid_cursor", message: "The analytics continuation is invalid or no longer matches this account and period." };
  }
  const identity = await input.provider.identity();
  if (identity.error) return {
    ok: false, status: 200, reason: identity.error.reason, message: identity.error.message, retryAt: identity.retryAt,
    needsReauth: threadsUnavailableReason(identity.error) === "reauth_required",
  };
  if (identity.data.id !== input.providerUserId) {
    return { ok: false, status: 200, reason: "wrong_account", message: "Reconnect the selected Threads account.", needsReauth: true };
  }
  const profile = (period: typeof windows.current.period) => input.provider.profile({ userId: input.providerUserId,
    metrics: PROFILE_METRICS, since: Date.parse(period.since) / 1000, until: Date.parse(period.until) / 1000 });
  const [current, previous, listing] = await Promise.all([
    profile(windows.current.period), profile(windows.previous.period),
    input.provider.recentPosts(input.providerUserId, { after: position.after, limit: PAGE_LIMIT }),
  ]);
  const observedAt = new Date().toISOString();
  const metrics = analyticsDefinitions("threads", "account").map((definition) =>
    projectThreadsAccountMetric({ definition, current, previous, windows, observedAt }));
  const posts = await projectPosts(input.provider, listing, windows.current.period);
  const { nextCursor, truncated, reason: pageReason } = await continuation({ listing, validPage: posts.validPage, position, scope, secret: input.signingSecret });
  const allReplies = [current, previous, listing, ...posts.replies.map((reply) => reply.insights)];
  const refusalReasons: string[] = allReplies.flatMap((reply) => reply.error ? [reply.error.reason] : []);
  const pageStatus = !posts.validPage ? "unavailable" : truncated || posts.incomplete ? "partial" : "available";
  if (pageReason) refusalReasons.push(pageReason);
  const retryAt = latestRetryAt(allReplies.map((reply) => reply.retryAt));
  const partial = Boolean(current.error || previous.error || pageReason || truncated || posts.incomplete
    || metrics.some(isAnalyticsAccountMetricIncomplete));
  return { ok: true, refusalReasons: Array.from(new Set(refusalReasons)), report: parseAnalyticsReport({
    analyticsContractVersion: ANALYTICS_CONTRACT_VERSION, platform: "threads", accountId: input.accountId,
    generatedAt: new Date().toISOString(), period: windows.current.period, previousPeriod: windows.previous.period, source: "live",
    metrics, posts: { items: posts.items, nextCursor, truncated, status: pageStatus, reason: pageReason },
    sync: analyticsSyncState({ now: input.now, staleAfterSeconds: configuration.staleAfterSeconds,
      collectedAt: null, asOf: null, retryAt, syncing: false, failedReason: null, partial: false }),
    truncated, lastPartialAt: partial ? observedAt : null, retryAt,
  }) };
}
