/**
 * The daily dispatch of the `instagram-insights-sync` handler.
 *
 * WHAT THIS SUITE COVERS
 *
 *   1. the request contract: the body carries no key other than the
 *      action, and every caller-selected owner, account, date, cursor,
 *      limit or force is refused;
 *   2. the method rules: POST only, and the preflight is not work;
 *   3. the authorization matrix: the cron secret, the service-role key and
 *      a verified administrator are service callers; a plain user, a
 *      `service_role` claim, a forged identity and a deployment without a
 *      service credential are refused;
 *   4. the availability gates: a disabled collection refuses BEFORE the
 *      daily statement is sent;
 *   5. the response: the bounded 202 / 200 receipt with its exact
 *      counters, and the typed 503 answers;
 *   6. the absence of side effects: the dispatch builds NO worker and
 *      makes ZERO provider calls.
 */
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

import {
  createInstagramInsightsSyncHandler,
  type InstagramInsightsSyncDeps,
  type OwnerIntakeAuditEvent,
} from "./handler.ts";
import type { OwnerCollectionStore } from "./store.ts";
import { InstagramGraphProvider } from "./graphProvider.ts";
import { InstagramDirectGraphProvider } from "./directGraphProvider.ts";
import type { OwnerWorkerPorts } from "./worker.ts";
import { createFakeGraph, createFakeStore } from "./workerTestSupport.ts";
import type { OwnerDailyEnqueuePorts } from "./dailyEnqueue.ts";
import type {
  OwnerDailyEnqueueOutcome,
  OwnerDailyEnqueueReceipt,
} from "./dailyEnqueueStore.ts";

const CRON_SECRET = "the-cron-secret";
const SERVICE_ROLE_KEY = "the-service-role-key";
const OWNER_ID = "0f100001-0000-4000-8000-000000000001";
const BEARER = "header.payload.signature";

const DEFAULT_SETTINGS: Record<string, unknown> = {
  collection_instagram_insights_enabled: { data: { value: true }, error: null },
  credential_facebook_user_mode: { data: { value: "protected" }, error: null },
};

function receipt(overrides: Partial<OwnerDailyEnqueueReceipt> = {}): OwnerDailyEnqueueReceipt {
  return {
    targetKind: "owner",
    capturedOn: "2026-10-30",
    sweepStatus: "pending",
    enqueued: 25,
    hasMore: true,
    pageLimit: 25,
    scanned: 25,
    started: true,
    resumed: false,
    ...overrides,
  };
}

interface HarnessOptions {
  readonly claims?: unknown;
  readonly settings?: Record<string, unknown>;
  readonly cronSecret?: string | null;
  readonly serviceRoleKey?: string | null;
  readonly withoutServicePorts?: boolean;
  readonly withoutDailyPorts?: boolean;
  readonly admin?: boolean | "fail" | "hang" | "not-boolean";
  readonly dailyThrows?: boolean;
  readonly dailyOutcome?: OwnerDailyEnqueueOutcome;
}

interface Harness {
  readonly handler: (request: Request) => Promise<Response>;
  readonly audit: OwnerIntakeAuditEvent[];
  readonly settingsReads: string[];
  readonly dailyCalls: number;
  readonly workerBuilds: number;
  readonly providerCalls: number;
}

function claimsEnvelope(sub: unknown = OWNER_ID, role: unknown = "authenticated"): unknown {
  return { data: { claims: { sub, role } }, error: null };
}

function createHarness(options: HarnessOptions = {}): Harness {
  const audit: OwnerIntakeAuditEvent[] = [];
  const settingsReads: string[] = [];
  let dailyCalls = 0;
  let workerBuilds = 0;

  const settings: Record<string, unknown> = { ...DEFAULT_SETTINGS, ...(options.settings ?? {}) };

  const { store } = createFakeStore();
  const { fetchFn, calls } = createFakeGraph({
    profile: { followers_count: 1, media_count: 1 },
    media: [],
  });

  const workerPorts: OwnerWorkerPorts = {
    store,
    provider: new InstagramGraphProvider({ fetchFn }),
    directProvider: new InstagramDirectGraphProvider({ fetchFn }),
    bucketKeyFor: async () => "a".repeat(64),
    now: () => 0,
    log: () => undefined,
  };

  const ownerStore: OwnerCollectionStore = {
    async enqueueOwnerJob() {
      throw new Error("the owner store must not be used by the dispatch");
    },
    async readOwnerStatus() {
      throw new Error("the owner store must not be used by the dispatch");
    },
  };

  const dailyPorts: OwnerDailyEnqueuePorts = {
    store: {
      async enqueueDailyPage(): Promise<OwnerDailyEnqueueOutcome> {
        dailyCalls += 1;
        if (options.dailyThrows) throw new Error("the statement did not answer");
        return options.dailyOutcome ?? { kind: "accepted", receipt: receipt() };
      },
    },
    log: () => undefined,
  };

  const deps: InstagramInsightsSyncDeps = {
    configuration: () => "ready",
    verifyClaims: async () => {
      if (options.admin === "hang") await new Promise(() => undefined);
      return "claims" in options ? options.claims : claimsEnvelope();
    },
    readSetting: async (key: string) => {
      settingsReads.push(key);
      return settings[key];
    },
    createOwnerStore: () => ownerStore,
    audit: async (event: OwnerIntakeAuditEvent) => {
      audit.push(event);
    },
    service: options.withoutServicePorts
      ? undefined
      : {
        cronSecret: () => (options.cronSecret === undefined ? CRON_SECRET : options.cronSecret),
        serviceRoleKey: () =>
          (options.serviceRoleKey === undefined
            ? SERVICE_ROLE_KEY
            : options.serviceRoleKey),
        isAdmin: async (): Promise<boolean> => {
          if (options.admin === "fail") throw new Error("the lookup failed");
          if (options.admin === "hang") await new Promise(() => undefined);
          if (options.admin === "not-boolean") return "yes" as unknown as boolean;
          return options.admin === true;
        },
        createServiceWorker: () => {
          workerBuilds += 1;
          return workerPorts;
        },
        createDailyEnqueue: options.withoutDailyPorts
          ? undefined
          : () => dailyPorts,
      },
  };

  return {
    handler: createInstagramInsightsSyncHandler(deps),
    audit,
    settingsReads,
    get dailyCalls() {
      return dailyCalls;
    },
    get workerBuilds() {
      return workerBuilds;
    },
    get providerCalls() {
      return calls.length;
    },
  };
}

function post(body: unknown, bearer: string = BEARER): Request {
  return new Request("https://api.postora.invalid/functions/v1/instagram-insights-sync", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${bearer}`,
    },
    body: JSON.stringify(body),
  });
}

async function json(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  return text ? JSON.parse(text) : {};
}

// ---------------------------------------------------------------------------
// The request contract
// ---------------------------------------------------------------------------

Deno.test("the daily dispatch carries no key other than the action", async () => {
  const harness = createHarness();

  for (
    const body of [
      { action: "enqueue-daily", social_account_id: "0f1a0002-0000-4000-8000-000000000012" },
      { action: "enqueue-daily", user_id: OWNER_ID },
      { action: "enqueue-daily", captured_on: "2026-10-30" },
      { action: "enqueue-daily", cursor: { due_at: "2026-10-30T00:00:00Z", id: OWNER_ID } },
      { action: "enqueue-daily", limit: 5 },
      { action: "enqueue-daily", force: true },
      { action: "enqueue-daily", mode: "force" },
      { action: "enqueue-daily", dispatch: "durable" },
    ]
  ) {
    const response = await harness.handler(post(body));
    assertEquals(response.status, 400, JSON.stringify(body));
  }

  assertEquals(harness.dailyCalls, 0);
});

Deno.test("an unknown action is refused", async () => {
  const harness = createHarness();
  const response = await harness.handler(post({ action: "enqueue" }));

  assertEquals(response.status, 400);
  assertEquals(harness.dailyCalls, 0);
});

Deno.test("only POST is accepted", async () => {
  const harness = createHarness();

  for (const method of ["GET", "PUT", "DELETE", "PATCH"]) {
    const response = await harness.handler(
      new Request("https://api.postora.invalid/functions/v1/instagram-insights-sync", {
        method,
        headers: { Authorization: `Bearer ${CRON_SECRET}` },
      }),
    );
    assertEquals(response.status, 405, method);
  }

  assertEquals(harness.dailyCalls, 0);
});

Deno.test("the preflight is not work", async () => {
  const harness = createHarness();
  const response = await harness.handler(
    new Request("https://api.postora.invalid/functions/v1/instagram-insights-sync", {
      method: "OPTIONS",
    }),
  );

  assertEquals(response.status, 204);
  assertEquals(harness.dailyCalls, 0);
  assertEquals(harness.audit.length, 0);
});

Deno.test("a malformed body is refused", async () => {
  const harness = createHarness();

  const invalidJson = await harness.handler(
    new Request("https://api.postora.invalid/functions/v1/instagram-insights-sync", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${CRON_SECRET}`,
      },
      body: "{not json",
    }),
  );
  assertEquals(invalidJson.status, 400);

  const tooLarge = await harness.handler(
    new Request("https://api.postora.invalid/functions/v1/instagram-insights-sync", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${CRON_SECRET}`,
      },
      body: JSON.stringify({ action: "enqueue-daily", padding: "x".repeat(5_000) }),
    }),
  );
  assertEquals(tooLarge.status, 413);

  assertEquals(harness.dailyCalls, 0);
});

// ---------------------------------------------------------------------------
// The authorization matrix
// ---------------------------------------------------------------------------

Deno.test("the cron secret and the service-role key are service callers", async () => {
  for (const bearer of [CRON_SECRET, SERVICE_ROLE_KEY]) {
    const harness = createHarness();
    const response = await harness.handler(post({ action: "enqueue-daily" }, bearer));

    assertEquals(response.status, 202, bearer);
    assertEquals(harness.dailyCalls, 1);
  }
});

Deno.test("a verified administrator is a service caller", async () => {
  const harness = createHarness({ admin: true });
  const response = await harness.handler(post({ action: "enqueue-daily" }));

  assertEquals(response.status, 202);
  assertEquals(harness.dailyCalls, 1);
});

Deno.test("a plain user session is refused", async () => {
  const harness = createHarness({ admin: false });
  const response = await harness.handler(post({ action: "enqueue-daily" }));

  assertEquals(response.status, 403);
  assertEquals((await json(response)).error, "forbidden");
  assertEquals(harness.dailyCalls, 0);
});

Deno.test("a service_role claim is never upgraded into a user", async () => {
  const harness = createHarness({
    claims: claimsEnvelope(OWNER_ID, "service_role"),
    admin: true,
  });
  const response = await harness.handler(post({ action: "enqueue-daily" }));

  assertEquals(response.status, 403);
  assertEquals(harness.dailyCalls, 0);
});

Deno.test("a forged identity is refused", async () => {
  for (const claims of ["not-an-envelope", null, [], 42, { data: {}, error: null }]) {
    const harness = createHarness({ claims, admin: true });
    const response = await harness.handler(post({ action: "enqueue-daily" }));
    assertEquals(response.status, 401, JSON.stringify(claims));
    assertEquals(harness.dailyCalls, 0);
  }
});

Deno.test("a dispatch without a bearer is refused", async () => {
  const harness = createHarness();
  const response = await harness.handler(
    new Request("https://api.postora.invalid/functions/v1/instagram-insights-sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "enqueue-daily" }),
    }),
  );

  assertEquals(response.status, 401);
  assertEquals(harness.dailyCalls, 0);
});

Deno.test("a deployment without a service credential is a misconfiguration", async () => {
  for (const harness of [
    createHarness({ withoutServicePorts: true }),
    createHarness({ cronSecret: null, serviceRoleKey: null }),
  ]) {
    const response = await harness.handler(post({ action: "enqueue-daily" }));
    assertEquals(response.status, 503);
    assertEquals((await json(response)).error, "service_auth_unavailable");
    assertEquals(harness.dailyCalls, 0);
  }
});

Deno.test("a deployment without a daily dispatcher is unavailable", async () => {
  const harness = createHarness({ withoutDailyPorts: true });
  const response = await harness.handler(post({ action: "enqueue-daily" }, CRON_SECRET));

  assertEquals(response.status, 503);
  assertEquals((await json(response)).error, "request_unavailable");
});

// ---------------------------------------------------------------------------
// The availability gates
// ---------------------------------------------------------------------------

Deno.test("a disabled collection refuses before the statement is sent", async () => {
  const harness = createHarness({
    settings: { collection_instagram_insights_enabled: { data: null, error: null } },
  });

  const response = await harness.handler(post({ action: "enqueue-daily" }, CRON_SECRET));

  assertEquals(response.status, 503);
  assertEquals((await json(response)).error, "collection_disabled");
  assertEquals(harness.dailyCalls, 0);
  assertEquals(harness.settingsReads, ["collection_instagram_insights_enabled"]);
});

Deno.test("a malformed setting is unavailable, never absent", async () => {
  const harness = createHarness({
    settings: {
      collection_instagram_insights_enabled: { data: { value: "yes" }, error: null },
    },
  });

  const response = await harness.handler(post({ action: "enqueue-daily" }, CRON_SECRET));

  assertEquals(response.status, 503);
  assertEquals((await json(response)).error, "settings_unavailable");
  assertEquals(harness.dailyCalls, 0);
});

// ---------------------------------------------------------------------------
// The response
// ---------------------------------------------------------------------------

Deno.test("a page with progress left is a 202 with its exact counters", async () => {
  const harness = createHarness();
  const response = await harness.handler(post({ action: "enqueue-daily" }, CRON_SECRET));

  assertEquals(response.status, 202);
  assertEquals(await json(response), {
    action: "enqueue-daily",
    captured_on: "2026-10-30",
    sweep_status: "pending",
    enqueued: 25,
    has_more: true,
  });
});

Deno.test("a page that finished the day is a 200", async () => {
  const harness = createHarness({
    dailyOutcome: {
      kind: "accepted",
      receipt: receipt({
        enqueued: 0,
        scanned: 0,
        hasMore: false,
        sweepStatus: "completed",
      }),
    },
  });

  const response = await harness.handler(post({ action: "enqueue-daily" }, CRON_SECRET));

  assertEquals(response.status, 200);
  assertEquals(await json(response), {
    action: "enqueue-daily",
    captured_on: "2026-10-30",
    sweep_status: "completed",
    enqueued: 0,
    has_more: false,
  });
});

Deno.test("a refusal of the configuration is a typed 503", async () => {
  for (
    const [reason, code] of [
      ["collection_disabled", "collection_disabled"],
      ["settings_unavailable", "settings_unavailable"],
    ] as const
  ) {
    const harness = createHarness({
      dailyOutcome: { kind: "refused", reason, capturedOn: "2026-10-30" },
    });

    const response = await harness.handler(post({ action: "enqueue-daily" }, CRON_SECRET));

    assertEquals(response.status, 503);
    assertEquals((await json(response)).error, code);
  }
});

Deno.test("a lost or malformed reply is indeterminate, never a completion", async () => {
  const harness = createHarness({ dailyThrows: true });
  const response = await harness.handler(post({ action: "enqueue-daily" }, CRON_SECRET));

  assertEquals(response.status, 503);
  assertEquals((await json(response)).error, "request_unavailable");
});

Deno.test("a sweep state outside the published set is never sent to a client", async () => {
  const harness = createHarness({
    dailyOutcome: {
      kind: "accepted",
      receipt: receipt({ sweepStatus: "expired", hasMore: false }),
    },
  });

  const response = await harness.handler(post({ action: "enqueue-daily" }, CRON_SECRET));

  assertEquals(response.status, 503);
  assertEquals((await json(response)).error, "request_unavailable");
});

// ---------------------------------------------------------------------------
// The absence of side effects
// ---------------------------------------------------------------------------

Deno.test("the dispatch builds no worker and calls no provider", async () => {
  const harness = createHarness();
  const response = await harness.handler(post({ action: "enqueue-daily" }, CRON_SECRET));

  assertEquals(response.status, 202);
  assertEquals(harness.workerBuilds, 0);
  assertEquals(harness.providerCalls, 0);
});

Deno.test("the audit records the action and the outcome, and no body", async () => {
  const harness = createHarness();
  await harness.handler(post({ action: "enqueue-daily" }, CRON_SECRET));

  assertEquals(harness.audit.length, 1);
  assertEquals(harness.audit[0]!.action, "enqueue-daily");
  assertEquals(harness.audit[0]!.status, 202);
  assert(!("body" in harness.audit[0]!), "the audit never carries the request body");
});
