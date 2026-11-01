import {
  ANALYTICS_CONTRACT_VERSION, ANALYTICS_METRIC_KEYS, ANALYTICS_PLATFORMS, UNAVAILABLE_REASONS,
  metricDelta, summarizeDailyMetricValues,
  type AnalyticsMetricDelta, type AnalyticsMetricResult, type AnalyticsPost, type AnalyticsReport,
  type AnalyticsSyncState, type MetricCoverage, type MetricDefinition, type MetricValue, type AnalyticsBoundaryObservations,
} from "./analyticsContract.ts";
import {
  ANALYTICS_PERIOD_DAYS, analyticsWindowForPeriod,
  type AnalyticsDayBucket, type AnalyticsPeriod,
} from "./analyticsCalendar.ts";
import { ANALYTICS_METRIC_REGISTRY, ANALYTICS_PLATFORM_CONFIGURATION } from "./analyticsRegistry.ts";

type ContractSchema = {
  type?: "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";
  const?: string | number | boolean | null;
  enum?: readonly (string | number)[];
  properties?: Record<string, ContractSchema>;
  required?: string[];
  additionalProperties?: false;
  items?: ContractSchema;
  oneOf?: ContractSchema[];
  minimum?: number;
  minLength?: number;
  maxItems?: number;
  pattern?: string;
  format?: "date-time" | "iana-timezone" | "https-url";
  "x-less-than"?: readonly [string, string][];
};

function objectSchema<T>(properties: { [Key in keyof T]-?: ContractSchema }, comparisons?: readonly [string, string][]): ContractSchema {
  return { type: "object", properties, required: Object.keys(properties), additionalProperties: false,
    ...(comparisons ? { "x-less-than": comparisons } : {}) };
}
const text: ContractSchema = { type: "string" };
const count: ContractSchema = { type: "integer", minimum: 0 };
const finite: ContractSchema = { type: "number" };
const instant: ContractSchema = { type: "string", format: "date-time" };
const nullSchema: ContractSchema = { type: "null" };
const nullable = (schema: ContractSchema): ContractSchema => ({ oneOf: [schema, nullSchema] });
const array = (items: ContractSchema): ContractSchema => ({ type: "array", items });
const literal = (value: string | number | boolean | null): ContractSchema => ({ const: value });
const reason: ContractSchema = { enum: UNAVAILABLE_REASONS };
const unavailable = objectSchema<Extract<MetricValue, { status: "unavailable" }>>({ status: literal("unavailable"), reason });
const available = objectSchema<Extract<MetricValue, { status: "available" }>>({ status: literal("available"), value: finite });
const coverage = objectSchema<MetricCoverage>({ availableDays: { type: "integer", minimum: 1 }, expectedDays: { type: "integer", minimum: 1 } }, [["availableDays", "expectedDays"]]);
const metricValue: ContractSchema = { oneOf: [available, unavailable,
  objectSchema<Extract<MetricValue, { status: "partial" }>>({ status: literal("partial"), value: finite, coverage })] };
const completeMetric: ContractSchema = { oneOf: [available, unavailable] };
const period = objectSchema<AnalyticsPeriod>({ days: { enum: ANALYTICS_PERIOD_DAYS }, since: instant, until: instant,
  timezone: { type: "string", format: "iana-timezone" } });
const day = objectSchema<AnalyticsDayBucket>({ date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" }, since: instant, until: instant });
const definitionFields: { [Key in keyof MetricDefinition]: ContractSchema } = {
  key: { enum: ANALYTICS_METRIC_KEYS }, platform: { enum: ANALYTICS_PLATFORMS }, level: { enum: ["account", "post"] },
  providerMetric: nullable(text), apiVersion: { type: "string", pattern: "^v[0-9]{1,2}\\.0$" },
  unit: { enum: ["count", "accounts", "percent"] }, windowKind: { enum: ["day", "period_total", "lifetime", "point_in_time"] },
  aggregation: { enum: ["sum", "last", "not_summable"] }, providerBucketTimezone: nullable({ type: "string", format: "iana-timezone" }),
  definitionKey: { type: "string", minLength: 1 }, minimumPermission: nullable(text),
  capability: { enum: ["unverified", "available", "not_offered"] }, evidenceRef: nullable(text), verifiedAt: nullable(instant),
  exactPeriodVerified: { type: "boolean" },
};
const definition: ContractSchema = { oneOf: [
  objectSchema<MetricDefinition>({ ...definitionFields, capability: literal("unverified"), evidenceRef: nullSchema, verifiedAt: nullSchema }),
  objectSchema<MetricDefinition>({ ...definitionFields, capability: literal("available"), providerMetric: { type: "string", minLength: 1 },
    minimumPermission: { type: "string", minLength: 1 }, evidenceRef: { type: "string", minLength: 1 }, verifiedAt: instant }),
  objectSchema<MetricDefinition>({ ...definitionFields, capability: literal("not_offered"), evidenceRef: { type: "string", minLength: 1 }, verifiedAt: instant }),
] };
const deltaFields: { [Key in keyof AnalyticsMetricDelta]: ContractSchema } = {
  status: literal("available"), absolute: finite, percentage: finite, reason: nullSchema,
};
const delta: ContractSchema = { oneOf: [objectSchema<AnalyticsMetricDelta>(deltaFields),
  objectSchema<AnalyticsMetricDelta>({ ...deltaFields, status: literal("unavailable"), percentage: nullSchema, reason: literal("zero_baseline") }),
  objectSchema<AnalyticsMetricDelta>({ status: literal("unavailable"), absolute: nullSchema, percentage: nullSchema,
    reason: { enum: [...UNAVAILABLE_REASONS, "incomplete_period"] } }),
] };
const boundaryObservation = objectSchema<AnalyticsBoundaryObservations["start"]>({ observedAt: instant, value: count });
const boundaries = objectSchema<AnalyticsBoundaryObservations>({ start: boundaryObservation, end: boundaryObservation });
const metricResult = objectSchema<AnalyticsMetricResult>({ definition, current: metricValue, previous: metricValue, delta,
  observedAt: nullable(instant), previousObservedAt: nullable(instant),
  boundaryObservations: objectSchema<AnalyticsMetricResult["boundaryObservations"]>({ current: nullable(boundaries), previous: nullable(boundaries) }),
  trend: array({ ...day, properties: { ...day.properties, metric: completeMetric }, required: [...day.required!, "metric"] }) });
const syncFields: { [Key in keyof AnalyticsSyncState]: ContractSchema } = {
  status: { enum: ["syncing", "partial"] }, reason: nullSchema,
  asOf: nullable(instant), collectedAt: nullable(instant), retryAt: nullable(instant),
};
const sync: ContractSchema = { oneOf: [objectSchema<AnalyticsSyncState>(syncFields),
  objectSchema<AnalyticsSyncState>({ ...syncFields, status: { enum: ["fresh", "stale"] }, collectedAt: instant }),
  objectSchema<AnalyticsSyncState>({ ...syncFields, status: literal("failed"), reason }),
  objectSchema<AnalyticsSyncState>({ ...syncFields, status: literal("never_synced"), asOf: nullSchema, collectedAt: nullSchema }),
] };
const post = objectSchema<AnalyticsPost>({ id: { type: "string", minLength: 1 }, publishedAt: instant, text,
  permalink: nullable({ type: "string", format: "https-url" }), metrics: array(metricResult) });
const postsFields = { items: array(post), nextCursor: nullable(text), truncated: { type: "boolean" } as ContractSchema,
  status: { enum: ["available", "partial", "unavailable"] } as ContractSchema, reason: nullable(reason) };
const posts: ContractSchema = { oneOf: [
  objectSchema<AnalyticsReport["posts"]>({ ...postsFields, status: literal("available"), nextCursor: nullSchema, truncated: literal(false), reason: nullSchema }),
  objectSchema<AnalyticsReport["posts"]>({ ...postsFields, status: literal("partial") }),
  objectSchema<AnalyticsReport["posts"]>({ ...postsFields, status: literal("unavailable"), items: { ...array(post), maxItems: 0 },
    nextCursor: nullSchema, truncated: literal(true), reason }),
] };

/** The serialized schema is the validator's actual input, shared unchanged by browser and Deno. */
export const ANALYTICS_REPORT_SCHEMA = objectSchema<AnalyticsReport>({
  analyticsContractVersion: literal(ANALYTICS_CONTRACT_VERSION), platform: { enum: ANALYTICS_PLATFORMS },
  accountId: { type: "string", pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$" }, generatedAt: instant, period, previousPeriod: period,
  source: { enum: ["live", "persisted"] }, metrics: array(metricResult), posts, sync,
  truncated: { type: "boolean" }, lastPartialAt: nullable(instant), retryAt: nullable(instant),
});

function formatted(value: string, format: ContractSchema["format"]): boolean {
  if (format === "date-time") {
    if (!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value)) return false;
    const date = new Date(`${value.slice(0, 10)}T00:00:00Z`);
    return Number.isFinite(Date.parse(value)) && Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value.slice(0, 10);
  }
  try {
    if (format === "iana-timezone") { new Intl.DateTimeFormat("en", { timeZone: value }); return true; }
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password
      && !["access_token", "refresh_token", "apikey", "api_key", "token", "authorization", "secret"].some((key) => url.searchParams.has(key));
  } catch (error) { if (error instanceof RangeError || error instanceof TypeError) return false; throw error; }
}

function matches(value: unknown, schema: ContractSchema): boolean {
  if (schema.oneOf) return schema.oneOf.filter((variant) => matches(value, variant)).length === 1;
  if ("const" in schema) return value === schema.const;
  if (schema.enum) return schema.enum.some((option) => value === option);
  if (schema.type === "null") return value === null;
  if (schema.type === "number" || schema.type === "integer") return typeof value === "number" && Number.isFinite(value)
    && (schema.type !== "integer" || Number.isSafeInteger(value)) && (schema.minimum === undefined || value >= schema.minimum);
  if (schema.type === "boolean") return typeof value === "boolean";
  if (schema.type === "string") return typeof value === "string" && (schema.minLength === undefined || value.length >= schema.minLength)
    && (!schema.pattern || new RegExp(schema.pattern).test(value)) && (!schema.format || formatted(value, schema.format));
  if (schema.type === "array") return Array.isArray(value) && (schema.maxItems === undefined || value.length <= schema.maxItems)
    && value.every((item) => matches(item, schema.items!));
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return schema.required!.every((key) => Object.prototype.hasOwnProperty.call(record, key)) && Object.keys(record).every((key) => schema.properties![key] && matches(record[key], schema.properties![key]))
    && (schema["x-less-than"] ?? []).every(([left, right]) => typeof record[left] === "number" && typeof record[right] === "number" && record[left] < record[right]);
}

function metricSemantics(metric: AnalyticsMetricResult, platform: AnalyticsReport["platform"], level: MetricDefinition["level"]): boolean {
  const expected = ANALYTICS_METRIC_REGISTRY.find((entry) => entry.platform === platform && entry.level === level && entry.key === metric.definition.key);
  // Evidence can be refreshed during a rolling deployment without changing a metric's meaning.
  if (!expected || (Object.keys(expected) as (keyof MetricDefinition)[]).some((key) =>
    key !== "evidenceRef" && key !== "verifiedAt" && expected[key] !== metric.definition[key])) return false;
  if (expected.capability !== "available") return [metric.current, metric.previous].every((value) =>
    value.status === "unavailable" && value.reason === (expected.capability === "unverified" ? "capability_unverified" : "not_offered"));
  return !(expected.windowKind === "period_total" && !expected.exactPeriodVerified || expected.windowKind === "day" && expected.aggregation === "not_summable")
    || metric.current.status === "unavailable" && metric.previous.status === "unavailable";
}

function sameFields<T extends object>(actual: T, expected: T): boolean {
  return (Object.keys(expected) as (keyof T)[]).every((key) => actual[key] === expected[key]);
}

function sameMeasurement(actual: MetricValue, expected: MetricValue): boolean {
  if (actual.status !== expected.status) return false;
  if (actual.status === "unavailable" && expected.status === "unavailable") return actual.reason === expected.reason;
  if (actual.status === "available" && expected.status === "available") return actual.value === expected.value;
  return actual.status === "partial" && expected.status === "partial" && actual.value === expected.value
    && sameFields(actual.coverage, expected.coverage);
}

function measurementSemantics(metric: AnalyticsMetricResult, report: AnalyticsReport): boolean {
  const observations = [[metric.current, metric.observedAt], [metric.previous, metric.previousObservedAt]] as const;
  if (observations.some(([value, observedAt]) => observedAt !== null && Date.parse(observedAt) > Date.parse(report.generatedAt)
    || value.status !== "unavailable" && (
    observedAt === null
    || metric.definition.unit !== "percent" && (!Number.isSafeInteger(value.value) || value.value < 0 && metric.definition.key !== "follower_change")
    || value.status === "partial" && (value.coverage.expectedDays !== report.period.days
      || metric.definition.windowKind !== "day" || metric.definition.aggregation !== "sum")))) return false;
  if (!sameFields(metric.delta, metricDelta(metric.current, metric.previous))) return false;
  if (report.source === "live" && (metric.definition.windowKind === "point_in_time" || metric.definition.level === "post")
    && metric.previous.status !== "unavailable") return false;
  if (metric.trend.length && (metric.definition.level !== "account" || metric.definition.windowKind !== "day")) return false;
  if (metric.trend.some((point) => point.metric.status === "available"
    && (!Number.isSafeInteger(point.metric.value) || point.metric.value < 0))) return false;
  if (metric.definition.windowKind === "day" && metric.definition.aggregation === "sum") {
    if (metric.current.status !== "unavailable" && !metric.trend.length) return false;
    if (metric.trend.length) {
      const aggregate = summarizeDailyMetricValues({ aggregation: "sum", days: metric.trend });
      if (!sameMeasurement(metric.current, aggregate)) return false;
    }
  }
  // Boundary samples belong only to persisted derived follower changes.
  if (metric.definition.key !== "follower_change" || report.source === "live") {
    return metric.boundaryObservations.current === null && metric.boundaryObservations.previous === null;
  }
  return observations.every(([measurement], index) => {
    const boundary = index === 0 ? report.period : report.previousPeriod;
    const samples = index === 0 ? metric.boundaryObservations.current : metric.boundaryObservations.previous;
    if (measurement.status !== "available") return samples === null;
    if (!samples || Date.parse(samples.end.observedAt) <= Date.parse(samples.start.observedAt) || measurement.value !== samples.end.value - samples.start.value) return false;
    return ([[samples.start, boundary.since], [samples.end, boundary.until]] as const).every(([sample, end]) => {
      const age = Date.parse(end) - Date.parse(sample.observedAt);
      return age >= 0 && age <= 86_400_000;
    });
  });
}

function syncSemantics(report: AnalyticsReport): boolean {
  if (report.source === "live") return report.sync.status === "never_synced";
  const { sync } = report;
  if (sync.collectedAt && Date.parse(sync.collectedAt) > Date.parse(report.generatedAt)
    || sync.asOf && (!sync.collectedAt || Date.parse(sync.asOf) > Date.parse(sync.collectedAt))) return false;
  if (sync.status !== "fresh" && sync.status !== "stale") return true;
  const age = Date.parse(report.generatedAt) - Date.parse(sync.collectedAt!);
  const stale = age > ANALYTICS_PLATFORM_CONFIGURATION[report.platform].staleAfterSeconds * 1000;
  return sync.asOf !== null && sync.status === (stale ? "stale" : "fresh");
}

/** Parse provider-independent responses at the transport boundary; missing and malformed fields never become zeros. */
export function parseAnalyticsReport(value: unknown): AnalyticsReport {
  if (!matches(value, ANALYTICS_REPORT_SCHEMA)) throw new TypeError("Invalid analytics contract response");
  const report = value as AnalyticsReport;
  const window = analyticsWindowForPeriod(report.period);
  analyticsWindowForPeriod(report.previousPeriod);
  const pinned = ANALYTICS_PLATFORM_CONFIGURATION[report.platform].providerBucketTimezone;
  if (pinned !== null && pinned !== report.period.timezone || report.previousPeriod.timezone !== report.period.timezone
    || report.previousPeriod.days !== report.period.days || report.previousPeriod.until !== report.period.since
    || Date.parse(report.period.until) > Date.parse(report.generatedAt)) throw new TypeError("Invalid analytics period context");
  const completeDefinitions = (metrics: AnalyticsMetricResult[], level: MetricDefinition["level"]) => metrics.length === ANALYTICS_METRIC_KEYS.length
    && new Set(metrics.map((metric) => metric.definition.key)).size === metrics.length
    && metrics.every((metric) => metricSemantics(metric, report.platform, level));
  if (!completeDefinitions(report.metrics, "account") || new Set(report.posts.items.map((post) => post.id)).size !== report.posts.items.length
    || report.posts.items.some((post) => !completeDefinitions(post.metrics, "post"))) throw new TypeError("Invalid analytics metric definitions");
  if (report.metrics.some((metric) => metric.trend.length && (metric.trend.length !== window.buckets.length
    || metric.trend.some((point, index) => point.date !== window.buckets[index].date || point.since !== window.buckets[index].since || point.until !== window.buckets[index].until)))) {
    throw new TypeError("Invalid analytics trend calendar");
  }
  if (!syncSemantics(report) || report.truncated !== report.posts.truncated
    || [...report.metrics, ...report.posts.items.flatMap((post) => post.metrics)].some((metric) => !measurementSemantics(metric, report))
    || report.posts.items.some((post) => Date.parse(post.publishedAt) < Date.parse(report.period.since)
      || Date.parse(post.publishedAt) >= Date.parse(report.period.until))) throw new TypeError("Invalid analytics measurement context");
  return report;
}
