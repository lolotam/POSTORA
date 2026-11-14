import { assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  ReportStore,
  type ReportStoreClient,
  toMediaSnapshotRow,
  toAccountDailyRow,
  toProfileObservationRow,
  parseFreshness,
  parseCompleteness,
} from "./reportStore.ts";
import { OwnerReportContractError } from "./contracts.ts";
import { ReportHistoryUnavailableError } from "./readHistory.ts";

const OWNER_ID = "8f14e45f-ceea-4e7a-9b1c-2d3e4f5a6b7c";
const ACCOUNT_ID = "a1b2c3d4-e5f6-4a1b-8c2d-3e4f5a6b7c8d";

const readiness: import("../_shared/ownerAnalyticsReadiness.ts").OwnerAnalyticsReadiness = {
  collection: { contract_version: 2, state: "not_enabled", reason_code: "collection_not_eligible", reason_source: "rollout_policy",
    observed_at: "2026-11-14T09:00:00Z", next_action: "contact_support", reconnect_can_help: false, retry_at: null, support_correlation_id: "fixture-correlation" },
  connection: { state: "unverified", reason_code: "bootstrap_required" }, permission: { state: "unknown", observed_at: null, missing_scopes: [] },
  last_attempt: { state: "partial", reason_code: "scope_missing", observed_at: "2026-11-05T09:00:00Z" },
};

Deno.test("excluded account retains live readiness independently of history, zero measurements and genuine partial data", async () => {
  for (const [value, count, state] of [[null, 0, "empty"], [0, 1, "partial"], [3, 1, "partial"]] as const) {
    const client = createMockClient({ readiness, job: { status: "partial", reason_code: "scope_missing", last_attempt_at: "2026-11-05T09:00:00Z", inventory: { partial: true } },
      daily: [{ id: "day", user_id: OWNER_ID, social_account_id: ACCOUNT_ID, metric_date: "2026-11-12", provider_date: "2026-11-12",
        captured_at: "2026-11-13T09:00:00Z", status: "ok", views: value }] });
    const report = await new ReportStore(client as unknown as ReportStoreClient).loadReportData(ACCOUNT_ID, OWNER_ID,
      { periodDays: 7, limit: 20, cursor: null }, new Date("2026-11-14T09:00:00Z"));
    assertEquals(report.collection, readiness.collection);
    assertEquals(report.permission?.state, "unknown");
    assertEquals(report.last_attempt?.reason_code, "scope_missing");
    assertEquals(report.freshness.reason, null);
    assertEquals(report.data?.state, state);
    assertEquals(report.data?.observation_count, count);
    assertEquals(report.freshness.status, count === 0 ? "never" : "partial");
  }
});

Deno.test("attempt-only history is never partial and missing capability never means denied scopes", () => {
  const freshness = parseFreshness({ status: "retry", last_attempt_at: "2026-11-05T12:00:00Z", reason_code: "capability_missing" });
  assertEquals(freshness.status, "never");
  assertEquals(freshness.reason, "unknown");
});

Deno.test("failed snapshot reads and malformed readiness never turn into empty successful reports", async () => {
  for (const options of [{ accountError: new Error("synthetic database timeout") }, { readiness: null },
    { readiness: { ...readiness, collection: { ...readiness.collection, reason_code: "permission_missing" } } }]) {
    const store = new ReportStore(createMockClient(options) as unknown as ReportStoreClient);
    await assertRejects(() => store.loadReportData(ACCOUNT_ID, OWNER_ID, { periodDays: 7, limit: 20, cursor: null }), ReportHistoryUnavailableError);
  }
});

function createMockClient(options: {
  account?: Record<string, unknown> | null;
  accountError?: Error | null;
  media?: Record<string, unknown>[];
  daily?: Record<string, unknown>[];
  profiles?: Record<string, unknown>[];
  periodTotals?: Record<string, unknown>[];
  readiness?: unknown;
  job?: Record<string, unknown>;
}) {
  return {
    rpc: () => {
      const result = { data: { account_id: ACCOUNT_ID, owner_id: OWNER_ID, media: options.media ?? [], daily: options.daily ?? [], profiles: options.profiles ?? [], period_totals: options.periodTotals ?? [], collection: options.job ?? null, ...(options.readiness === undefined ? {} : { readiness: options.readiness }) },
        error: options.account === null ? { code: "MAH02", message: "Not found" } : options.accountError ?? null };
      return { abortSignal: () => Promise.resolve(result) };
    },
    from: (table: string) => {
      const history = table === "ig_media_insight_snapshots" ? options.media ?? []
        : table === "ig_account_insight_daily" ? options.daily ?? []
        : table === "ig_account_profile_observations" ? options.profiles ?? [] : [];
      const builder = {
        select: (_columns: string) => builder,
        eq: (_column: string, _value: unknown) => builder,
        gt: (_column: string, _value: unknown) => builder,
        lte: (_column: string, _value: unknown) => builder,
        order: (_column: string, _options: unknown) => builder,
        limit: (_count: number) => builder,
        abortSignal: (_signal: AbortSignal) => builder,
        maybeSingle: () => Promise.resolve({
          data: table === "social_accounts" ? options.account === undefined
            ? { id: ACCOUNT_ID, user_id: OWNER_ID, platform: "instagram" } : options.account : null,
          error: table === "social_accounts" ? options.accountError ?? null : null,
        }),
        then: (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) =>
          Promise.resolve({ data: history, count: history.length, error: null }).then(resolve, reject),
      };
      return builder;
    },
  };
}
Deno.test("toMediaSnapshotRow converts snake_case db columns cleanly", () => {
  const row = toMediaSnapshotRow({
    id: "snap-01",
    user_id: OWNER_ID,
    social_account_id: ACCOUNT_ID,
    ig_media_id: "m-100",
    published_at: "2026-10-28T12:00:00Z",
    captured_at: "2026-10-28T14:00:00Z",
    captured_on: "2026-10-28",
    status: "ok",
    views: "500",
    reach: 400,
  });

  assertEquals(row.id, "snap-01");
  assertEquals(row.ownerId, OWNER_ID);
  assertEquals(row.socialAccountId, ACCOUNT_ID);
  assertEquals(row.mediaId, "m-100");
  assertEquals(row.views, 500);
  assertEquals(row.reach, 400);
});

Deno.test("parseFreshness maps database job status cleanly", () => {
  const fresh = parseFreshness({
    status: "completed",
    last_attempt_at: "2026-10-28T12:00:00Z",
    last_success_at: "2026-10-28T12:00:00Z",
    inventory: { partial: false, truncated: false },
  });

  assertEquals(fresh.status, "ok");
  assertEquals(fresh.lastSuccessAt, "2026-10-28T12:00:00Z");
  assertEquals(fresh.truncated, false);

  const never = parseFreshness(null);
  assertEquals(never.status, "never");
  assertEquals(never.reason, "never_synced");
});

// PR #367 review: a partial visit that still owed history stored
// "daily_observation_pending", which the report refused as an unknown reason.
Deno.test("a worker reason outside the report vocabulary still yields a valid report reason", () => {
  for (const [stored, expected] of [
    ["daily_observation_pending", "baseline_history_incomplete"],
    ["period_reach_pending", "baseline_history_incomplete"],
    ["rate_limited", "throttled"],
    ["token_invalid", "reauth_required"],
    ["inventory_incomplete", "inventory_truncated"],
    ["scope_missing", "scope_missing"],
    ["continuation_expired", "unknown"],
    [null, null],
  ] as const) {
    const freshness = parseFreshness({ status: "partial", last_attempt_at: "2026-10-28T12:00:00Z", reason_code: stored });
    assertEquals(freshness.reason, expected, String(stored));
  }
});

Deno.test("parseCompleteness determines coverage from inventory flags", () => {
  const covered = parseCompleteness(
    { inventory: { window_covered: true, truncated: false } },
    []
  );
  assertEquals(covered.coverage, "complete");
  assertEquals(covered.baselineHistoryComplete, true);
  assertEquals(covered.inventoryTruncated, false);
  const pending = toMediaSnapshotRow({ id: "pending", ig_media_id: "pending-media", media_product_type: "FEED", status: "pending",
    published_at: "2026-10-25T10:00:00Z", captured_at: "2026-10-25T11:00:00Z", captured_on: "2026-10-25" });
  assertEquals(parseCompleteness({ inventory: { window_covered: true } }, [pending]).coverage, "partial");
  const completed = { ...pending, id: "complete", status: "ok" as const };
  assertEquals(parseCompleteness({ inventory: { window_covered: true } }, [pending, completed]).coverage, "complete");
  assertEquals(parseCompleteness({ inventory: { window_covered: true } }, [pending], []).coverage, "complete", "outside the requested window");
});

Deno.test("ReportStore refuses cross-owner account with ACCOUNT_MISMATCH", async () => {
  const client = createMockClient({ account: null });
  const store = new ReportStore(client as unknown as ReportStoreClient);

  await assertRejects(
    () =>
      store.loadReportData(
        ACCOUNT_ID,
        OWNER_ID,
        { periodDays: 30, limit: 20, cursor: null },
        new Date("2026-10-29T00:00:00Z")
      ),
    OwnerReportContractError
  );
});

Deno.test("ReportStore loads data and produces valid OwnerReport DTO", async () => {
  const media = [
    {
      id: "snap-1",
      user_id: OWNER_ID,
      social_account_id: ACCOUNT_ID,
      ig_media_id: "m1",
      published_at: "2026-10-25T10:00:00Z",
      captured_at: "2026-10-25T12:00:00Z",
      captured_on: "2026-10-25",
      capture_timezone: "Asia/Kuwait",
      media_product_type: "REELS",
      media_type: "VIDEO",
      status: "ok",
      views: 1200,
      reach: 900,
      likes: 80,
      comments: 10,
    },
  ];

  const daily = [
    {
      id: "dly-1",
      user_id: OWNER_ID,
      social_account_id: ACCOUNT_ID,
      metric_date: "2026-10-25",
      provider_date: "2026-10-25",
      period_start: "2026-10-24T21:00:00Z",
      period_end: "2026-10-25T21:00:00Z",
      provider_timezone: "Asia/Kuwait",
      status: "ok",
      captured_at: "2026-10-26T00:00:00Z",
      reach: 450,
      views: 890,
      accounts_engaged: 35,
      total_interactions: 12,
    },
  ];

  const profiles = [
    {
      id: "prof-1",
      user_id: OWNER_ID,
      social_account_id: ACCOUNT_ID,
      observed_at: "2026-10-25T12:00:00Z",
      observed_on: "2026-10-25",
      capture_timezone: "Asia/Kuwait",
      status: "ok",
      followers_count: 1500,
      media_count: 55,
    },
  ];

  const client = createMockClient({ media, daily, profiles });
  const store = new ReportStore(client as unknown as ReportStoreClient);

  const report = await store.loadReportData(
    ACCOUNT_ID,
    OWNER_ID,
    { periodDays: 30, limit: 20, cursor: null },
    new Date("2026-10-29T00:00:00Z")
  );

  assertEquals(report.schemaVersion, 1);
  assertEquals(report.scope.ownerId, OWNER_ID);
  assertEquals(report.scope.socialAccountId, ACCOUNT_ID);
  assertEquals(report.media.page.items.length, 1);
  assertEquals(report.media.page.items[0].mediaId, "m1");
  assertEquals(report.account.daily.length, 1);
  assertEquals(report.account.profiles.length, 1);
});

Deno.test("a stored period total reaches the report as the period's exact reach", async () => {
  const periodTotals = [{
    id: "tot-1",
    user_id: OWNER_ID,
    social_account_id: ACCOUNT_ID,
    metric: "reach",
    period_days: 7,
    since_date: "2026-10-22",
    until_date: "2026-10-28",
    status: "ok",
    value: 777,
    captured_at: "2026-10-29T00:00:00Z",
  }];
  const store = new ReportStore(createMockClient({ periodTotals }) as unknown as ReportStoreClient);

  // 00:00Z on the 29th is 03:00 in Kuwait: the 28th is the last closed day.
  const report = await store.loadReportData(
    ACCOUNT_ID,
    OWNER_ID,
    { periodDays: 7, limit: 20, cursor: null },
    new Date("2026-10-29T00:00:00Z"),
  );

  assertEquals(report.account.periodReach, {
    status: "available",
    value: 777,
    sinceDate: "2026-10-22",
    untilDate: "2026-10-28",
    capturedAt: "2026-10-29T00:00:00.000Z",
  });
});

Deno.test("all time displays media older than any day-count period", async () => {
  const media = [{
    id: "snap-old",
    user_id: OWNER_ID,
    social_account_id: ACCOUNT_ID,
    ig_media_id: "m-old",
    published_at: "2025-01-10T10:00:00Z",
    captured_at: "2026-10-25T12:00:00Z",
    captured_on: "2026-10-25",
    capture_timezone: "Asia/Kuwait",
    media_product_type: "FEED",
    media_type: "IMAGE",
    status: "ok",
    reach: 90,
    likes: 8,
  }];
  const store = new ReportStore(createMockClient({ media }) as unknown as ReportStoreClient);
  const load = (periodDays: 365 | "all") =>
    store.loadReportData(ACCOUNT_ID, OWNER_ID, { periodDays, limit: 20, cursor: null }, new Date("2026-10-29T00:00:00Z"));

  assertEquals((await load(365)).media.page.items.length, 0);
  assertEquals((await load("all")).media.page.items.map((item) => item.mediaId), ["m-old"]);
});

Deno.test("readiness evidence uses resolved supported captures before pagination and independent of period", async () => {
  const live = { ...readiness, collection: { ...readiness.collection, state: "syncing", reason_code: "awaiting_first_capture", reason_source: "data", next_action: "wait" },
    connection: { state: "verified", reason_code: null },
    permission: { state: "verified", observed_at: "2026-11-14T08:00:00Z", missing_scopes: [] } };
  const row = { id: "old", user_id: OWNER_ID, social_account_id: ACCOUNT_ID, ig_media_id: "media", published_at: "2026-11-10T09:00:00Z",
    captured_at: "2026-11-12T09:00:00Z", captured_on: "2026-11-12", capture_timezone: "UTC", media_product_type: "REELS", media_type: "VIDEO", status: "ok", views: 0 };
  const load = (media: Record<string, unknown>[], periodDays: 1 | 7 = 7, cursor: { publishedAt: string; mediaId: string } | null = null) =>
    new ReportStore(createMockClient({ media, readiness: live }) as unknown as ReportStoreClient).loadReportData(ACCOUNT_ID, OWNER_ID,
      { periodDays, limit: 1, cursor }, new Date("2026-11-14T09:00:00Z"));
  for (const extra of [
    { ...row, id: "new", captured_at: "2026-11-13T09:00:00Z", status: "unavailable", views: null },
  ]) assertEquals((await load([row, extra])).data?.observation_count, 0, "superseded numbers are not displayed evidence");
  for (const extra of [ { media_product_type: "STORY" }, { media_type: "AD", media_product_type: "AD" }, { published_at: "2026-11-15T09:00:00Z" } ]) {
    const report = await load([{ ...row, ...extra }]);
    assertEquals(report.data?.state, "empty");
    assertEquals(report.collection?.reason_code, "awaiting_first_capture");
  }
  const first = await load([row, { ...row, id: "second", ig_media_id: "second", published_at: "2026-11-09T09:00:00Z", views: null }]);
  const next = await load([row, { ...row, id: "second", ig_media_id: "second", published_at: "2026-11-09T09:00:00Z", views: null }], 7, first.media.page.nextCursor);
  assertEquals(next.data, first.data, "period evidence does not change on an empty-valued page");
  assertEquals((await load([row], 1)).collection?.reason_code, "ready", "account has captured outside the selected window");
  assertEquals((await load([row], 1)).data?.state, "empty");
});
