import { analyticsDayBucket, type AnalyticsDayBucket } from "../_shared/analyticsCalendar.ts";
import { analyticsDefinitions, ANALYTICS_PLATFORM_CONFIGURATION } from "../_shared/analyticsRegistry.ts";
import type { MetricDefinition } from "../_shared/analyticsContract.ts";
import { FacebookInsightsProvider } from "../facebook-page-insights/provider.ts";
import { ThreadsInsightsProvider } from "../threads-insights/provider.ts";
import { CollectionProviderRefused, CollectionVisitPaused, type CollectionProvider } from "./collectionProvider.ts";
import { AnalyticsWorkerDeadline, AnalyticsWorkerStopped } from "./deadline.ts";
import { facebookCollection } from "./facebookCollection.ts";
import { threadsCollection } from "./threadsCollection.ts";
import { CollectionThrottle, collectionBucketKey } from "./throttle.ts";
import type { AdmissionApp } from "./permissionProvider.ts";
import { OwnedAnalyticsStore, type AnalyticsClaim, type AnalyticsWorkerState, type CaptureRequest, type OwnedAnalyticsPlatform } from "./store.ts";

export type DrainCounts = { visited: number; collected: number; partial: number; refused: number };
export type DrainResult = { status: "complete" | "partial" | "disabled" | "unavailable"; counts: DrainCounts; reason: string | null };
type DrainInput = { platform: OwnedAnalyticsPlatform | "all"; store: OwnedAnalyticsStore; deadline: AnalyticsWorkerDeadline;
  app: (platform: OwnedAnalyticsPlatform) => AdmissionApp | null; fetch?: typeof fetch };
type PlannedCapture = { key: string; request: CaptureRequest; definitions: MetricDefinition[] };

function closedDays(job: AnalyticsClaim): AnalyticsDayBucket[] {
  const timezone = ANALYTICS_PLATFORM_CONFIGURATION[job.platform].providerBucketTimezone!;
  return [1, 2].map((offset) => {
    const date = new Date(`${job.due_on}T00:00:00.000Z`);
    date.setUTCDate(date.getUTCDate() - offset);
    return analyticsDayBucket(date.toISOString().slice(0, 10), timezone);
  });
}

async function capturePlan(job: AnalyticsClaim, state: AnalyticsWorkerState): Promise<PlannedCapture[]> {
  const account = analyticsDefinitions(job.platform, "account").filter((entry) => entry.capability === "available");
  const daily = account.filter((entry) => entry.windowKind === "day");
  const plans: PlannedCapture[] = closedDays(job).map((day) => ({ key: `account_day:${day.date}`,
    request: { kind: "account_day", subject_id: job.authority.platform_user_id, metrics: daily.map((entry) => entry.key), metric_date: day.date }, definitions: daily }));
  const profile = account.filter((entry) => entry.windowKind === "point_in_time");
  if (profile.length) plans.push({ key: "profile", request: { kind: "profile", subject_id: job.authority.platform_user_id,
    metrics: profile.map((entry) => entry.key) }, definitions: profile });
  const posts = analyticsDefinitions(job.platform, "post").filter((entry) => entry.capability === "available" && entry.windowKind === "lifetime");
  for (const id of state.checkpoint.post_ids) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(id));
    const key = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    plans.push({ key: `post:${key}`, request: { kind: "post", subject_id: id, metrics: posts.map((entry) => entry.key) }, definitions: posts });
  }
  return plans;
}

async function collectionProvider(input: DrainInput, job: AnalyticsClaim, throttle: CollectionThrottle): Promise<CollectionProvider> {
  const token = await input.store.collectionCredential(job);
  const options = { token, signal: input.deadline.signal, startedAt: input.deadline.startedAt, budgetMs: 35_000, maxCalls: 20,
    fetch: input.fetch, beforeRequest: async () => {
      await throttle.beforeRequest();
      if (await input.store.collectionCredential(job) !== token) throw new AnalyticsWorkerStopped("admission_refused", "MAH04");
      if (input.deadline.remainingMs < 15_000) throw new CollectionVisitPaused();
    }, afterResponse: (status: number, headers: Headers) => throttle.afterResponse(status, headers) };
  return job.platform === "facebook" ? facebookCollection(new FacebookInsightsProvider(options), job.authority.platform_user_id)
    : threadsCollection(new ThreadsInsightsProvider(options), job.authority.platform_user_id, closedDays(job)[0]);
}

async function inventory(input: DrainInput, job: AnalyticsClaim, provider: CollectionProvider): Promise<AnalyticsWorkerState> {
  let state = await input.store.workerState(job);
  for (let pageCount = 0; pageCount < 2 && !state.checkpoint.inventory_complete && !state.checkpoint.inventory_truncated; pageCount++) {
    if (input.deadline.remainingMs < 20_000) break;
    const reservation = await input.store.reservePage(job, state.checkpoint);
    const response = await provider.page(reservation.cursor);
    await input.store.commitPage(job, reservation, response);
    state = await input.store.workerState(job);
  }
  return state;
}

async function captureVisit(input: DrainInput, job: AnalyticsClaim, provider: CollectionProvider, state: AnalyticsWorkerState): Promise<boolean> {
  const plans = await capturePlan(job, state);
  const operations = new Map(state.operations.map((operation) => [operation.operation_key, operation]));
  const accepted = new Set(state.operations.filter((operation) => ["success", "unavailable"].includes(operation.state)).map((operation) => operation.operation_key));
  const pending = plans.filter((plan) => !accepted.has(plan.key)).sort((left, right) =>
    Date.parse(operations.get(left.key)?.last_requested_at ?? "1970-01-01T00:00:00Z") - Date.parse(operations.get(right.key)?.last_requested_at ?? "1970-01-01T00:00:00Z"));
  for (const plan of pending.slice(0, 8)) {
    if (input.deadline.remainingMs < 20_000) break;
    const capture = await input.store.reserveCapture(job, plan.key, plan.request);
    const post = capture.kind === "post" ? await provider.post(capture.subject_id) : {};
    const reply = await provider.metrics(capture, plan.definitions);
    const metrics = reply.cells;
    const receivedAt = new Date().toISOString();
    await input.store.persistCapture(job, capture.capture_id, { metrics, ...post, received_at: receivedAt, observed_at: receivedAt });
    if (reply.refusal) throw reply.refusal;
    if (Object.values(metrics).every((cell) => cell.status === "available" || ["not_offered", "outside_retention"].includes(cell.reason))) accepted.add(plan.key);
  }
  return state.checkpoint.inventory_complete && !state.checkpoint.inventory_truncated && plans.every((plan) => accepted.has(plan.key));
}

async function collectJob(input: DrainInput, job: AnalyticsClaim): Promise<"success" | "partial" | "refused" | "rate_limited"> {
  const app = input.app(job.platform);
  if (!app) throw new AnalyticsWorkerStopped("configuration_unavailable");
  const throttle = new CollectionThrottle(input.store, await collectionBucketKey(job, app.id), input.deadline);
  try {
    const provider = await collectionProvider(input, job, throttle);
    const state = await inventory(input, job, provider);
    const complete = await captureVisit(input, job, provider, state);
    await input.store.complete(job, complete ? "success" : "partial", complete ? null : state.checkpoint.inventory_truncated ? "inventory_truncated" : "collection_incomplete",
      complete ? null : new Date(Date.now() + 60_000).toISOString());
    return complete ? "success" : "partial";
  } catch (error) {
    if (error instanceof CollectionVisitPaused) {
      await input.store.complete(job, "partial", "visit_budget", new Date(Date.now() + 60_000).toISOString());
      return "partial";
    }
    if (!(error instanceof CollectionProviderRefused)) throw error;
    const retry = error.reason === "rate_limited";
    const now = Date.now();
    const persistedRetry = retry ? await throttle.refuse(error.retryAt) : null;
    const retryAt = new Date(Math.min(now + 86_000_000, Math.max(now + 60_000, Date.parse(persistedRetry ?? "") || 0))).toISOString();
    const terminal = error.reason === "reauth_required" || error.reason === "permission_missing";
    await input.store.complete(job, retry ? "retry" : terminal ? "failed" : "partial", error.reason,
      retry ? retryAt : terminal ? null : new Date(Date.now() + 60_000).toISOString());
    return retry ? "rate_limited" : "refused";
  }
}

/** Receipts describe acknowledged job outcomes; failed reads never look like an empty queue. */
export async function drainOwnedAnalytics(input: DrainInput): Promise<DrainResult> {
  const counts: DrainCounts = { visited: 0, collected: 0, partial: 0, refused: 0 };
  try {
    const platforms = input.platform === "all" ? ["facebook", "threads"] as const : [input.platform];
    const active: OwnedAnalyticsPlatform[] = [];
    for (const platform of platforms) if ((await input.store.nextDispatch(platform, false)).state !== "disabled") active.push(platform);
    if (!active.length) return { status: "disabled", counts, reason: null };
    const exhausted = new Set<OwnedAnalyticsPlatform>();
    while (counts.visited < 50 && input.deadline.remainingMs >= 25_000 && exhausted.size < active.length) {
        const candidates = active.filter((platform) => !exhausted.has(platform));
        const job = await input.store.claim(candidates.length === 2 ? "all" : candidates[0]);
        if (!job) { for (const platform of candidates) exhausted.add(platform); break; }
        counts.visited++;
        let outcome: Awaited<ReturnType<typeof collectJob>>;
        try { outcome = await collectJob(input, job); }
        catch (error) {
          if (!(error instanceof AnalyticsWorkerStopped) || !["MAH02", "MAH03", "MAH04"].includes(error.sqlstate ?? "")) throw error;
          counts.refused++;
          continue;
        }
        if (outcome === "rate_limited") { counts.partial++; return { status: "partial", counts, reason: "rate_limited" }; }
        counts[outcome === "success" ? "collected" : outcome]++;
    }
    return { status: exhausted.size === active.length && !counts.partial && !counts.refused ? "complete" : "partial", counts, reason: null };
  } catch (error) {
    const refused = error instanceof AnalyticsWorkerStopped && ["MAH02", "MAH03", "MAH04"].includes(error.sqlstate ?? "");
    return { status: refused ? "partial" : "unavailable", counts, reason: refused ? "collection_changed"
      : error instanceof AnalyticsWorkerStopped ? error.reason : "storage_unavailable" };
  }
}
