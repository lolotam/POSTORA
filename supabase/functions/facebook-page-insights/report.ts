import { ANALYTICS_CONTRACT_VERSION, analyticsSyncState, type AnalyticsPost, type AnalyticsReport } from "../_shared/analyticsContract.ts";
import { closedAnalyticsPeriods, type AnalyticsPeriodDays } from "../_shared/analyticsCalendar.ts";
import { analyticsDefinitions, ANALYTICS_PLATFORM_CONFIGURATION } from "../_shared/analyticsRegistry.ts";
import { parseAnalyticsReport } from "../_shared/analyticsSchema.ts";
import { AnalyticsCursorError, analyticsCursorScope, decodeAnalyticsCursor, createAnalyticsContinuation } from "../_shared/metaAnalyticsCursor.ts";
import { mapAnalyticsReads, latestRetryAt } from "../_shared/metaAnalyticsTransport.ts";
import { FacebookInsightsProvider, type FacebookPost } from "./provider.ts";
import { projectFacebookAccountMetric, projectFacebookPostMetric, facebookUnavailableReason, type FacebookMetricReply } from "./projection.ts";

type FacebookReportResult = { ok: true; report: AnalyticsReport; refusalReasons: string[] }
  | { ok: false; status: number; reason: string; message: string; needsReauth?: boolean; retryAt?: string | null };

async function accountMeasurements(provider: FacebookInsightsProvider, pageId: string, windows: ReturnType<typeof closedAnalyticsPeriods>) {
  const definitions = analyticsDefinitions("facebook", "account").filter((definition) => definition.capability === "available");
  const requests = definitions.flatMap((definition) => (["current", "previous"] as const).map((period) => ({ definition, period })));
  const replies = await mapAnalyticsReads(requests, async ({ definition, period }) => ({ key: definition.key, period,
    reply: await provider.metric({ pageId, metric: definition.providerMetric!, ...windows[period].period }) }));
  const observedAt = new Date().toISOString();
  return { replies, metrics: analyticsDefinitions("facebook", "account").map((definition) => projectFacebookAccountMetric({ definition,
    current: replies.find((entry) => entry.key === definition.key && entry.period === "current")?.reply,
    previous: replies.find((entry) => entry.key === definition.key && entry.period === "previous")?.reply, windows, observedAt })) };
}

async function postMeasurements(provider: FacebookInsightsProvider, selected: readonly FacebookPost[]) {
  const definitions = analyticsDefinitions("facebook", "post");
  const requests = selected.flatMap((post) => definitions.filter((definition) => definition.capability === "available").map((definition) => ({ post, definition })));
  const replies = await mapAnalyticsReads(requests, async ({ post, definition }) => ({ postId: post.id, key: definition.key,
    reply: await provider.postMetric(post.id, definition.providerMetric!) }));
  const observedAt = new Date().toISOString();
  const items: AnalyticsPost[] = selected.map((post) => ({ id: post.id, publishedAt: new Date(post.created_time).toISOString(),
    text: post.message ?? "", permalink: post.permalink_url ?? null, metrics: definitions.map((definition) => projectFacebookPostMetric(definition,
      replies.find((entry) => entry.postId === post.id && entry.key === definition.key)?.reply, observedAt)) }));
  return { replies, items };
}

export async function facebookPageReport(input: {
  provider: FacebookInsightsProvider; ownerId: string; accountId: string; pageId: string;
  days: AnalyticsPeriodDays; cursor: string | null; signingSecret: string; now: string;
}): Promise<FacebookReportResult> {
  const configuration = ANALYTICS_PLATFORM_CONFIGURATION.facebook;
  const windows = closedAnalyticsPeriods({ now: input.now, days: input.days, timezone: configuration.providerBucketTimezone! });
  const scope = analyticsCursorScope(input.ownerId, input.accountId, windows.current.period);
  let position;
  try { position = await decodeAnalyticsCursor(input.cursor, scope, input.signingSecret, "facebook"); }
  catch (error) {
    if (!(error instanceof AnalyticsCursorError)) throw error;
    return { ok: false, status: 400, reason: "invalid_cursor", message: "The analytics continuation is invalid for this account and period." };
  }
  const identity = await input.provider.identity();
  if (identity.error) return { ok: false, status: 200, reason: identity.error.reason, message: identity.error.message,
    needsReauth: identity.error.reason === "reauth_required", retryAt: identity.retryAt };
  if (identity.data.id !== input.pageId) return { ok: false, status: 200, reason: "wrong_account", needsReauth: true, message: "Reconnect the selected Facebook Page." };
  const listing = await input.provider.posts(input.pageId, position.after);
  const account = await accountMeasurements(input.provider, input.pageId, windows);
  const validPage = listing.data !== null && new Set(listing.data.data.map((post) => post.id)).size === listing.data.data.length;
  const selected = validPage ? listing.data!.data.filter((post) => Date.parse(post.created_time) >= Date.parse(windows.current.period.since)
    && Date.parse(post.created_time) < Date.parse(windows.current.period.until)) : [];
  const posts = await postMeasurements(input.provider, selected);
  const continuation = await createAnalyticsContinuation({ validPage, hasContinuation: validPage && listing.data?.paging?.next !== undefined,
    after: listing.data?.paging?.cursors?.after, reason: listing.error ? facebookUnavailableReason(listing.error.reason) : validPage ? null : "provider_error",
    position, scope, secret: input.signingSecret, namespace: "facebook" });
  const replies: FacebookMetricReply[] = [...account.replies, ...posts.replies].map((entry) => entry.reply);
  const refusalReasons: string[] = [...replies, listing].flatMap((reply) => reply.error ? [reply.error.reason] : []);
  if (continuation.reason) refusalReasons.push(continuation.reason);
  const incompletePosts = posts.items.some((post) => post.metrics.some((metric) => metric.definition.capability === "available" && metric.current.status !== "available"));
  const partial = replies.some((reply) => reply.error) || incompletePosts || continuation.truncated
    || account.metrics.some((metric) => metric.definition.capability === "available" && metric.current.status !== "available");
  const retryAt = latestRetryAt([...replies, listing].map((reply) => reply.retryAt));
  const generatedAt = new Date().toISOString();
  return { ok: true, refusalReasons: Array.from(new Set(refusalReasons)), report: parseAnalyticsReport({
    analyticsContractVersion: ANALYTICS_CONTRACT_VERSION, platform: "facebook", accountId: input.accountId, generatedAt,
    period: windows.current.period, previousPeriod: windows.previous.period, source: "live", metrics: account.metrics,
    posts: { items: posts.items, ...continuation, status: !validPage ? "unavailable" : continuation.truncated || incompletePosts ? "partial" : "available" },
    sync: analyticsSyncState({ now: generatedAt, staleAfterSeconds: configuration.staleAfterSeconds, collectedAt: null, asOf: null,
      retryAt, syncing: false, failedReason: null, partial: false }),
    truncated: continuation.truncated, lastPartialAt: partial ? generatedAt : null, retryAt,
  }) };
}
