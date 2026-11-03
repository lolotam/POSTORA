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

const OWNER_ID = "8f14e45f-ceea-4e7a-9b1c-2d3e4f5a6b7c";
const ACCOUNT_ID = "a1b2c3d4-e5f6-4a1b-8c2d-3e4f5a6b7c8d";

function createMockClient(options: {
  account?: Record<string, unknown> | null;
  accountError?: Error | null;
  media?: Record<string, unknown>[];
  daily?: Record<string, unknown>[];
  profiles?: Record<string, unknown>[];
}) {
  return {
    rpc: () => {
      const result = { data: { account_id: ACCOUNT_ID, owner_id: OWNER_ID, media: options.media ?? [], daily: options.daily ?? [], profiles: options.profiles ?? [], collection: null },
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

Deno.test("parseCompleteness determines coverage from inventory flags", () => {
  const covered = parseCompleteness(
    { inventory: { window_covered: true, truncated: false } },
    []
  );
  assertEquals(covered.coverage, "complete");
  assertEquals(covered.baselineHistoryComplete, true);
  assertEquals(covered.inventoryTruncated, false);
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
