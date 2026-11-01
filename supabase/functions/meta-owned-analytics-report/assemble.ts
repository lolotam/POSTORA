import { analyticsDefinitions, ANALYTICS_PLATFORM_CONFIGURATION } from "../_shared/analyticsRegistry.ts";
import { analyticsSyncState, isAnalyticsAccountMetricIncomplete, isAnalyticsMetricMeasurable, metricDelta, summarizeDailyMetricValues,
  unavailableMetric, type AnalyticsMetricResult, type AnalyticsReport, type MetricDefinition, type MetricValue, type UnavailableReason } from "../_shared/analyticsContract.ts";
import { normalizeAnalyticsPermalink, parseAnalyticsReport } from "../_shared/analyticsSchema.ts";
import type { AnalyticsCalendarWindow } from "../_shared/analyticsCalendar.ts";
import { PersistedReportRefused, type StoredAnalyticsCell, type StoredAnalyticsSnapshot } from "./store.ts";

type CompleteMetric = Exclude<MetricValue, { status: "partial" }>;
type Measurement = { metric: MetricValue; observedAt: string | null; series: CompleteMetric[] };

function latestInstant(instants: readonly string[]): string | null {
  return instants.reduce<string | null>((latest, instant) => latest === null || Date.parse(instant) > Date.parse(latest) ? instant : latest, null);
}
function exactCell(cells: readonly StoredAnalyticsCell[], key: string): StoredAnalyticsCell | null {
  const matching = cells.filter((cell) => cell.metric_key === key);
  if (matching.length > 1) throw new PersistedReportRefused("invalid_contract", 503);
  return matching[0] ?? null;
}
function cellMetric(cell: StoredAnalyticsCell | null, definition: MetricDefinition): CompleteMetric {
  if (!cell) return unavailableMetric("not_collected");
  if (cell.status === "unavailable") {
    if (cell.value !== null || cell.reason === null) throw new PersistedReportRefused("invalid_contract", 503);
    return unavailableMetric(cell.reason);
  }
  if (cell.value === null || cell.reason !== null) throw new PersistedReportRefused("invalid_contract", 503);
  if (cell.api_version !== definition.apiVersion || cell.provider_metric !== definition.providerMetric
    || cell.source_ref !== (definition.platform === "facebook" ? "meta_graph_v25" : "threads_graph_v1")) return unavailableMetric("capability_unverified");
  if (cell.window_kind !== definition.windowKind) return unavailableMetric("window_mismatch");
  return { status: "available", value: cell.value };
}

function dailyMeasurement(definition: MetricDefinition, stored: StoredAnalyticsSnapshot, window: AnalyticsCalendarWindow): Measurement {
  const observations: string[] = [];
  const series = window.buckets.map((expected) => {
    const rows = stored.daily.filter((row) => row.bucket.metric_date === expected.date);
    if (rows.length > 1) throw new PersistedReportRefused("invalid_contract", 503);
    const row = rows[0];
    if (!row) return unavailableMetric("not_collected");
    const cell = exactCell(row.metrics, definition.key);
    if (row.bucket.provider_timezone !== window.period.timezone || Date.parse(row.bucket.period_start) !== Date.parse(expected.since)
      || Date.parse(row.bucket.period_end) !== Date.parse(expected.until) || cell && (cell.provider_timezone !== window.period.timezone
        || Date.parse(cell.window_since ?? "") !== Date.parse(expected.since) || Date.parse(cell.window_until ?? "") !== Date.parse(expected.until))) return unavailableMetric("window_mismatch");
    const metric = cellMetric(cell, definition);
    if (cell) observations.push(cell.observed_at);
    return metric;
  });
  const metric = definition.aggregation === "last" ? series[series.length - 1]
    : summarizeDailyMetricValues({ aggregation: definition.aggregation === "sum" ? "sum" : "not_summable",
      days: window.buckets.map((bucket, index) => ({ date: bucket.date, metric: series[index] })) });
  const final = definition.aggregation === "last" ? exactCell(stored.daily.find((row) => row.bucket.metric_date === window.buckets[window.buckets.length - 1].date)?.metrics ?? [], definition.key) : null;
  return { metric, series, observedAt: definition.aggregation === "last" ? final?.observed_at ?? null : latestInstant(observations) };
}

function boundaryMeasurement(definition: MetricDefinition, stored: StoredAnalyticsSnapshot, window: AnalyticsCalendarWindow, position: "current" | "previous"): Measurement {
  if (position === "current") {
    const cell = exactCell(stored.profile_current, definition.key);
    return { metric: cellMetric(cell, definition), observedAt: cell?.observed_at ?? null, series: [] };
  }
  const cell = exactCell(stored.profile_boundaries.filter((sample) => Date.parse(sample.boundary) === Date.parse(window.period.until)), definition.key);
  const age = cell ? Date.parse(window.period.until) - Date.parse(cell.observed_at) : NaN;
  const metric = !cell || age > 86_400_000 ? unavailableMetric("not_collected") : age < 0 ? unavailableMetric("window_mismatch") : cellMetric(cell, definition);
  return { metric, observedAt: cell?.observed_at ?? null, series: [] };
}

function accountMeasurement(definition: MetricDefinition, stored: StoredAnalyticsSnapshot, window: AnalyticsCalendarWindow, position: "current" | "previous"): Measurement {
  if (definition.capability !== "available") return { metric: unavailableMetric(definition.capability === "unverified" ? "capability_unverified" : "not_offered"), observedAt: null, series: [] };
  if (definition.windowKind === "day") return dailyMeasurement(definition, stored, window);
  if (definition.windowKind === "point_in_time") return boundaryMeasurement(definition, stored, window, position);
  if (!definition.exactPeriodVerified) return { metric: unavailableMetric("window_mismatch"), observedAt: null, series: [] };
  const cell = exactCell(stored.period_totals.filter((total) => total.level === "account" && Date.parse(total.window_since ?? "") === Date.parse(window.period.since)
    && Date.parse(total.window_until ?? "") === Date.parse(window.period.until)), definition.key);
  return { metric: cellMetric(cell, definition), observedAt: cell?.observed_at ?? null, series: [] };
}

function accountMetric(definition: MetricDefinition, stored: StoredAnalyticsSnapshot, windows: { current: AnalyticsCalendarWindow; previous: AnalyticsCalendarWindow }): AnalyticsMetricResult {
  const current = accountMeasurement(definition, stored, windows.current, "current");
  const previous = accountMeasurement(definition, stored, windows.previous, "previous");
  return { definition, current: current.metric, previous: previous.metric, delta: metricDelta(current.metric, previous.metric),
    observedAt: current.observedAt, previousObservedAt: previous.observedAt, boundaryObservations: { current: null, previous: null },
    trend: current.series.map((metric, index) => ({ ...windows.current.buckets[index], metric })) };
}
function postMetric(definition: MetricDefinition, cells: readonly StoredAnalyticsCell[]): AnalyticsMetricResult {
  const cell = definition.capability === "available" ? exactCell(cells, definition.key) : null;
  const current = definition.capability === "available" ? cellMetric(cell, definition)
    : unavailableMetric(definition.capability === "unverified" ? "capability_unverified" : "not_offered");
  const previous = unavailableMetric(definition.capability === "available" ? "not_collected" : definition.capability === "unverified" ? "capability_unverified" : "not_offered");
  return { definition, current, previous, delta: metricDelta(current, previous), observedAt: cell?.observed_at ?? null,
    previousObservedAt: null, boundaryObservations: { current: null, previous: null }, trend: [] };
}
function connectionFailure(stored: StoredAnalyticsSnapshot): UnavailableReason | null {
  if (!stored.health.active || stored.health.needs_reauth || stored.health.token_expired) return "reauth_required";
  const job = stored.collection.latest;
  if (["reauth_required", "permission_missing"].includes(job?.reason_code ?? "")) return job!.reason_code as UnavailableReason;
  return job?.state === "failed" && job.reason_code !== "inventory_truncated" ? "provider_error" : null;
}

export function assembleStoredAnalytics(input: { stored: StoredAnalyticsSnapshot; windows: { current: AnalyticsCalendarWindow; previous: AnalyticsCalendarWindow };
  generatedAt: string; nextCursor: string | null; hasMore: boolean }): AnalyticsReport {
  const { stored, windows } = input;
  const metrics = analyticsDefinitions(stored.platform, "account").map((definition) => accountMetric(definition, stored, windows));
  const posts = stored.posts.slice(0, 25).map(({ post, metrics: cells }) => ({ id: post.platform_post_id, publishedAt: post.published_at,
    text: post.post_text, permalink: normalizeAnalyticsPermalink(post.permalink), metrics: analyticsDefinitions(stored.platform, "post").map((definition) => postMetric(definition, cells)) }));
  const incompleteCells = posts.some((post) => post.metrics.some((metric) => isAnalyticsMetricMeasurable(metric.definition) && metric.current.status !== "available"));
  const cells = [...stored.daily.flatMap((day) => day.metrics), ...stored.posts.flatMap((post) => post.metrics), ...stored.profile_boundaries, ...stored.profile_current, ...stored.period_totals];
  const collectedAt = latestInstant(cells.map((cell) => cell.collected_at));
  const asOf = collectedAt ? new Date(Math.min(Date.parse(windows.current.period.until), Date.parse(collectedAt))).toISOString() : null;
  const incompleteInventory = !stored.inventory.complete || stored.inventory.truncated;
  const truncated = input.hasMore || incompleteInventory;
  const reason = incompleteInventory ? "not_collected" as const : null;
  const partial = (collectedAt !== null || stored.collection.latest !== null) && (incompleteInventory || incompleteCells
    || metrics.some(isAnalyticsAccountMetricIncomplete) || ["partial", "retry"].includes(stored.collection.latest?.state ?? ""));
  return parseAnalyticsReport({ analyticsContractVersion: 1, platform: stored.platform, accountId: stored.account_id, generatedAt: input.generatedAt,
    period: windows.current.period, previousPeriod: windows.previous.period, source: "persisted", metrics,
    posts: { items: posts, nextCursor: input.nextCursor, truncated, status: truncated || incompleteCells ? "partial" : "available", reason },
    sync: analyticsSyncState({ now: input.generatedAt, staleAfterSeconds: ANALYTICS_PLATFORM_CONFIGURATION[stored.platform].staleAfterSeconds,
      collectedAt, asOf, retryAt: stored.collection.latest?.retry_at ?? null, syncing: stored.collection.syncing, failedReason: connectionFailure(stored), partial }),
    truncated, lastPartialAt: stored.collection.last_partial_at, retryAt: stored.collection.latest?.retry_at ?? null });
}
