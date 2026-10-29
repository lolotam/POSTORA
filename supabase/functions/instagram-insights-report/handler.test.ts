import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createInstagramInsightsReportHandler } from "./handler.ts";
import { ReportStore } from "./reportStore.ts";
import { OwnerReportContractError, type OwnerReport } from "./contracts.ts";

const OWNER_ID = "8f14e45f-ceea-4e7a-9b1c-2d3e4f5a6b7c";
const ACCOUNT_ID = "a1b2c3d4-e5f6-4a1b-8c2d-3e4f5a6b7c8d";

const MOCK_REPORT: OwnerReport = {
  schemaVersion: 1,
  source: "graph_own",
  scope: { ownerId: OWNER_ID, socialAccountId: ACCOUNT_ID, platform: "instagram" },
  generatedAt: "2026-10-29T00:00:00.000Z",
  period: {
    days: 30,
    windowStart: "2026-09-29T00:00:00.000Z",
    windowEnd: "2026-10-29T00:00:00.000Z",
    metricDateStart: "2026-09-29",
    metricDateEnd: "2026-10-29",
  },
  account: {
    daily: [],
    profiles: [],
    latestProfileObservation: null,
  },
  media: {
    page: {
      items: [],
      limit: 20,
      returned: 0,
      hasMore: false,
      nextCursor: null,
    },
    coverage: {
      received: 0,
      inWindow: 0,
      reel: 0,
      nonReel: 0,
      excludedStory: 0,
      excludedUnsupported: 0,
      excludedUnknown: 0,
      excludedNoCapture: 0,
      excludedFuture: 0,
    },
  },
  freshness: {
    status: "ok",
    lastAttemptAt: "2026-10-28T12:00:00Z",
    lastSuccessAt: "2026-10-28T12:00:00Z",
    lastPartialAt: null,
    partial: false,
    truncated: false,
    retryAt: null,
    reason: null,
  },
  completeness: {
    baselineHistoryComplete: true,
    inventoryTruncated: false,
    coverage: "complete",
    oldestMediaPublishedAt: null,
    newestMediaPublishedAt: null,
  },
  lagNote: "provider_data_may_lag_up_to_48h",
};

function createFakeStore(behavior: {
  notFound?: boolean;
  contractError?: OwnerReportContractError;
  unexpectedError?: boolean;
} = {}) {
  return {
    loadReportData: (
      _socialAccountId: string,
      _userId: string,
      _request: unknown,
      _now: unknown
    ): Promise<OwnerReport> => {
      if (behavior.notFound) {
        return Promise.reject(
          new OwnerReportContractError("ACCOUNT_MISMATCH", "Instagram account not found")
        );
      }
      if (behavior.contractError) {
        return Promise.reject(behavior.contractError);
      }
      if (behavior.unexpectedError) {
        return Promise.reject(new Error("Database disconnected"));
      }
      return Promise.resolve(MOCK_REPORT);
    },
  } as unknown as ReportStore;
}

Deno.test("handler answers OPTIONS preflight with 200 and CORS headers", async () => {
  const handler = createInstagramInsightsReportHandler({
    authenticate: () => Promise.resolve({ userId: OWNER_ID, isServiceRole: false }),
    store: createFakeStore(),
  });

  const res = await handler(new Request("https://example.com/report", { method: "OPTIONS" }));
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("Access-Control-Allow-Origin"), "*");
});

Deno.test("handler refuses unsupported methods with 405", async () => {
  const handler = createInstagramInsightsReportHandler({
    authenticate: () => Promise.resolve({ userId: OWNER_ID, isServiceRole: false }),
    store: createFakeStore(),
  });

  const res = await handler(new Request("https://example.com/report", { method: "DELETE" }));
  assertEquals(res.status, 405);
  assertEquals(res.headers.get("Allow"), "GET, POST, OPTIONS");
});

Deno.test("handler refuses unauthenticated requests with 401", async () => {
  const handler = createInstagramInsightsReportHandler({
    authenticate: () => Promise.reject(new Error("Unauthorized")),
    store: createFakeStore(),
  });

  const res = await handler(
    new Request(`https://example.com/report?social_account_id=${ACCOUNT_ID}`, { method: "GET" })
  );
  assertEquals(res.status, 401);
  const json = await res.json();
  assertEquals(json.error.code, "UNAUTHORIZED");
});

Deno.test("handler refuses invalid social_account_id with 400", async () => {
  const handler = createInstagramInsightsReportHandler({
    authenticate: () => Promise.resolve({ userId: OWNER_ID, isServiceRole: false }),
    store: createFakeStore(),
  });

  const res = await handler(
    new Request("https://example.com/report?social_account_id=not-a-uuid", { method: "GET" })
  );
  assertEquals(res.status, 400);
  const json = await res.json();
  assertEquals(json.error.code, "INVALID_REQUEST");
});

Deno.test("handler refuses invalid period_days with 400", async () => {
  const handler = createInstagramInsightsReportHandler({
    authenticate: () => Promise.resolve({ userId: OWNER_ID, isServiceRole: false }),
    store: createFakeStore(),
  });

  const res = await handler(
    new Request(
      `https://example.com/report?social_account_id=${ACCOUNT_ID}&period_days=45`,
      { method: "GET" }
    )
  );
  assertEquals(res.status, 400);
  const json = await res.json();
  assertEquals(json.error.code, "INVALID_PERIOD");
});

Deno.test("handler refuses invalid limit with 400", async () => {
  const handler = createInstagramInsightsReportHandler({
    authenticate: () => Promise.resolve({ userId: OWNER_ID, isServiceRole: false }),
    store: createFakeStore(),
  });

  const res = await handler(
    new Request(
      `https://example.com/report?social_account_id=${ACCOUNT_ID}&limit=150`,
      { method: "GET" }
    )
  );
  assertEquals(res.status, 400);
  const json = await res.json();
  assertEquals(json.error.code, "INVALID_LIMIT");
});

Deno.test("handler answers 404 for missing or cross-owner account", async () => {
  const handler = createInstagramInsightsReportHandler({
    authenticate: () => Promise.resolve({ userId: OWNER_ID, isServiceRole: false }),
    store: createFakeStore({ notFound: true }),
  });

  const res = await handler(
    new Request(`https://example.com/report?social_account_id=${ACCOUNT_ID}`, { method: "GET" })
  );
  assertEquals(res.status, 404);
  const json = await res.json();
  assertEquals(json.error.code, "ACCOUNT_NOT_FOUND");
});

Deno.test("handler successfully returns report via GET", async () => {
  const handler = createInstagramInsightsReportHandler({
    authenticate: () => Promise.resolve({ userId: OWNER_ID, isServiceRole: false }),
    store: createFakeStore(),
  });

  const res = await handler(
    new Request(
      `https://example.com/report?social_account_id=${ACCOUNT_ID}&period_days=30&limit=10`,
      { method: "GET" }
    )
  );
  assertEquals(res.status, 200);
  const json = await res.json();
  assertEquals(json.schemaVersion, 1);
  assertEquals(json.scope.socialAccountId, ACCOUNT_ID);
});

Deno.test("handler successfully returns report via POST", async () => {
  const handler = createInstagramInsightsReportHandler({
    authenticate: () => Promise.resolve({ userId: OWNER_ID, isServiceRole: false }),
    store: createFakeStore(),
  });

  const res = await handler(
    new Request("https://example.com/report", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        social_account_id: ACCOUNT_ID,
        period_days: 14,
        limit: 15,
      }),
    })
  );
  assertEquals(res.status, 200);
  const json = await res.json();
  assertEquals(json.schemaVersion, 1);
});

Deno.test("service-role proxy caller acts for target user_id in body", async () => {
  let queriedUser: string | null = null;
  const store = {
    loadReportData: (_acc: string, userId: string): Promise<OwnerReport> => {
      queriedUser = userId;
      return Promise.resolve(MOCK_REPORT);
    },
  } as unknown as ReportStore;

  const handler = createInstagramInsightsReportHandler({
    authenticate: () => Promise.resolve({ userId: "service_user", isServiceRole: true }),
    store,
  });

  const res = await handler(
    new Request("https://example.com/report", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_id: OWNER_ID,
        social_account_id: ACCOUNT_ID,
        period_days: 7,
      }),
    })
  );
  assertEquals(res.status, 200);
  assertEquals(queriedUser, OWNER_ID);
});
