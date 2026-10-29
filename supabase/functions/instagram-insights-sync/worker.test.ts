/**
 * The bounded OWNER collection worker.
 *
 * WHAT THIS SUITE COVERS
 *
 *   1. the happy path: the claimed job is collected, the profile, the two
 *      daily observations, the media inventory and the media insights are
 *      written, the inventory progress is recorded and the job is completed;
 *   2. the days: the capture day is never collected, the last completed
 *      Kuwait day and the correction day are, and a day that did not fit
 *      the budget is planned, recorded and resumed;
 *   3. the media continuation: at most five media per visit, the queue is
 *      resumed instead of rebuilt, and a media that failed keeps its place;
 *   4. the truth of the inventory: the pages that were fetched, the oldest
 *      instant that came back, whether the window was covered, and the
 *      refusal to complete a job that still owes work;
 *   5. the throttle: a rate limit parks the job once and the job is NOT
 *      completed afterwards, and a nearly spent usage budget stops the run;
 *   6. the fairness: one unusable job never stalls the others;
 *   7. the direct-login account: a stable, non-looping outcome and no
 *      provider call;
 *   8. the bound: an uncooperative claim, read, provider call and write each
 *      abandon the job to its lease instead of hanging the worker;
 *   9. the secrets: no token reaches a log line, a summary or an error.
 *
 * THE CLOCK
 *
 *   The budget is drawn from the REMAINING time, so a clock that jumps
 *   forward makes the next bounded step nearly expire. The worker reads the
 *   clock in a fixed order, and each test below names the step it is
 *   targeting and the arithmetic it relies on.
 */
import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

import { InstagramGraphProvider } from "./graphProvider.ts";
import { InstagramDirectGraphProvider } from "./directGraphProvider.ts";
import type { ClaimedOwnerJob } from "./receipts.ts";
import {
  boundedStep,
  BudgetExceededError,
  MEDIA_INSIGHTS_PER_VISIT,
  MEDIA_QUEUE_LIMIT,
  OWNER_CLAIM_LIMIT,
  runOwnerDrain,
  THROTTLE_WINDOW_MS,
  type OwnerWorkerPorts,
} from "./worker.ts";
import {
  accountDayAnswer,
  createClaimedJob,
  createFakeGraph,
  createFakeStore,
  fixedClock,
  mediaInsightAnswer,
  scheduledClock,
  TEST_ACCOUNT_ID,
  TEST_CAPTURED_ON,
  TEST_CORRECTION_DAY,
  TEST_JOB_ID,
  TEST_PRIMARY_DAY,
} from "./workerTestSupport.ts";

const PROFILE = { followers_count: 3200, media_count: 42 };
const MEDIA = [
  {
    id: "media-1",
    media_type: "IMAGE",
    media_product_type: "FEED",
    timestamp: "2026-10-20T12:00:00Z",
    permalink: "https://instagram.com/p/1",
    like_count: 55,
    comments_count: 3,
  },
];

/** A second account, for the fairness tests. */
const SECOND_ACCOUNT_ID = "01810006-0000-4000-8000-000000000006";

/** The job id of the second owner, for the fairness tests. */
const SECOND_JOB_ID = "01810007-0000-4000-8000-000000000007";

/** The claim token of the second owner, for the fairness tests. */
const SECOND_CLAIM_TOKEN = "01810008-0000-4000-8000-000000000008";

interface Harness {
  readonly ports: OwnerWorkerPorts;
  readonly calls: ReturnType<typeof createFakeStore>["calls"];
  readonly graphCalls: string[];
  readonly graphUrls: string[];
  readonly logs: Array<Record<string, unknown>>;
}

function createHarness(
  options: {
    readonly store?: Parameters<typeof createFakeStore>[0];
    readonly graph?: Parameters<typeof createFakeGraph>[0];
    readonly now?: () => number;
    readonly jobs?: number;
  } = {},
): Harness {
  const { store, calls } = createFakeStore(options.store);
  const { fetchFn, calls: graphCalls, urls: graphUrls } = createFakeGraph({
    profile: PROFILE,
    media: MEDIA,
    mediaInsights: {
      "media-1": mediaInsightAnswer({ reach: 100, views: 200 }),
    },
    ...(options.graph ?? {}),
  });

  const logs: Array<Record<string, unknown>> = [];
  const jobs = Array.from({ length: options.jobs ?? 1 }, () => createClaimedJob());

  const ports: OwnerWorkerPorts = {
    store,
    provider: new InstagramGraphProvider({ fetchFn }),
    // The Instagram-login adapter answers on a different host with a
    // different token, so both adapters are built here. The recorded URLs
    // say which one was used.
    directProvider: new InstagramDirectGraphProvider({ fetchFn }),
    bucketKeyFor: async (credentialId) => await sha256Of(credentialId),
    now: options.now ?? fixedClock(),
    log: (event) => logs.push({ ...event }),
  };

  return { ports, calls, graphCalls, graphUrls, logs };
}

async function sha256Of(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value) as unknown as BufferSource,
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** The inventory progress of the last write. */
function lastInventoryProgress(calls: Harness["calls"]) {
  const inventories = calls.progresses.filter((entry) => entry.kind === "inventory");
  return inventories[inventories.length - 1]!;
}

/** The operations progress of the last write. */
function lastOperationsProgress(calls: Harness["calls"]) {
  const operations = calls.progresses.filter((entry) => entry.kind === "operations");
  return operations[operations.length - 1]!;
}

// ---------------------------------------------------------------------------
// The happy path
// ---------------------------------------------------------------------------

Deno.test("a claimed owner job is collected, recorded and completed", async () => {
  const harness = createHarness({ store: { jobs: [createClaimedJob()] } });

  const summary = await runOwnerDrain(harness.ports);

  assertEquals(summary.claimed, 1);
  assertEquals(summary.completed, 1);
  assertEquals(summary.abandoned, 0);
  assertEquals(summary.stoppedEarly, false);

  // The accepted snapshot kinds, in the accepted order: the profile, the two
  // daily observations, the media inventory and the media insights.
  assertEquals(
    harness.calls.snapshots.map((entry) => entry.kind),
    [
      "owner_profile_observation",
      "owner_account_day",
      "owner_account_day",
      "owner_media",
      "owner_media",
    ],
  );

  // The profile observation carries the counts the provider reported.
  const profile = harness.calls.snapshots[0]!.items[0]!;
  assertEquals(profile.metrics, { followers_count: 3200, media_count: 42 });

  // The daily observations carry the metrics the provider reported and
  // nothing else.
  const primaryDay = harness.calls.snapshots[1]!.items[0]!;
  assertEquals(primaryDay.provider_date, TEST_PRIMARY_DAY);
  assertEquals(primaryDay.metric_date, TEST_PRIMARY_DAY);
  assertEquals(primaryDay.query_kind, "interactions");
  assertEquals(primaryDay.metrics, { reach: 450, views: 890 });
  assertEquals("accounts_engaged" in (primaryDay.metrics as object), false);

  const correctionDay = harness.calls.snapshots[2]!.items[0]!;
  assertEquals(correctionDay.provider_date, TEST_CORRECTION_DAY);
  assertEquals(correctionDay.metric_date, TEST_CORRECTION_DAY);

  // The media inventory keeps the accepted public counts.
  const media = harness.calls.snapshots[3]!.items[0]!;
  assertEquals(media.ig_media_id, "media-1");
  assertEquals(media.metrics, { like_count_public: 55, comments_count_public: 3 });

  // The media insights are persisted for the same media.
  const mediaInsights = harness.calls.snapshots[4]!.items[0]!;
  assertEquals(mediaInsights.ig_media_id, "media-1");
  assertEquals(mediaInsights.status, "ok");
  assertEquals(mediaInsights.metrics, { reach: 100, views: 200 });

  // The job is completed once, as a full success.
  assertEquals(harness.calls.completes, [{ outcome: "completed", reasonCode: null }]);
});

Deno.test("the claim is always the production limit", async () => {
  const harness = createHarness();
  await runOwnerDrain(harness.ports);
  assertEquals(harness.calls.claims, [{ limit: OWNER_CLAIM_LIMIT }]);
});

// ---------------------------------------------------------------------------
// The days
// ---------------------------------------------------------------------------

Deno.test("the capture day is never collected", async () => {
  const harness = createHarness({ store: { jobs: [createClaimedJob()] } });

  await runOwnerDrain(harness.ports);

  const days = harness.calls.snapshots
    .filter((entry) => entry.kind === "owner_account_day")
    .map((entry) => entry.items[0]!.provider_date);

  assertEquals(days, [TEST_PRIMARY_DAY, TEST_CORRECTION_DAY]);
  assertEquals(days.includes(TEST_CAPTURED_ON), false);

  // The requested range is the day that was asked for, in Kuwait time.
  const dayUrls = harness.graphUrls.filter((url) => url.includes("metric_type=total_value"));
  assertEquals(dayUrls.length, 2);
  for (const url of dayUrls) {
    assertStringIncludes(url, "period=day");
    assertStringIncludes(url, "since=");
  }
});

Deno.test("the planned days are recorded as open operations before the attempt", async () => {
  const harness = createHarness({ store: { jobs: [createClaimedJob()] } });

  await runOwnerDrain(harness.ports);

  const operations = lastOperationsProgress(harness.calls);
  assertEquals(operations.kind, "operations");
  assertEquals(operations.items, [
    {
      operation_key: `account_day:${TEST_PRIMARY_DAY}:interactions`,
      operation_kind: "account_day",
      state: "pending",
      provider_date: TEST_PRIMARY_DAY,
      query_kind: "interactions",
    },
    {
      operation_key: `account_day:${TEST_CORRECTION_DAY}:interactions`,
      operation_kind: "account_day",
      state: "pending",
      provider_date: TEST_CORRECTION_DAY,
      query_kind: "interactions",
    },
  ]);

  // The queue of the checkpoint names the planned days too.
  const planned = harness.calls.progresses.find((entry) => entry.kind === "inventory")!;
  assertEquals(planned.remaining_ids, [
    `account_day:${TEST_PRIMARY_DAY}`,
    `account_day:${TEST_CORRECTION_DAY}`,
  ]);
});

Deno.test("a day that is still owed is resumed, and a collected day is not", async () => {
  const harness = createHarness({
    store: {
      jobs: [
        createClaimedJob({
          checkpoint: { inventory_remaining_ids: [`account_day:${TEST_CORRECTION_DAY}`] },
          pending_operations: [
            { operation_key: `account_day:${TEST_CORRECTION_DAY}:interactions` },
          ],
        }),
      ],
    },
  });

  await runOwnerDrain(harness.ports);

  // Only the correction day is collected: the primary day was collected by
  // an earlier visit and is not collected again.
  const days = harness.calls.snapshots
    .filter((entry) => entry.kind === "owner_account_day")
    .map((entry) => entry.items[0]!.provider_date);
  assertEquals(days, [TEST_CORRECTION_DAY]);
});

Deno.test("a day that did not fit stays in the queue and the job stays claimable", async () => {
  const harness = createHarness({
    store: {
      jobs: [
        createClaimedJob({
          checkpoint: { inventory_remaining_ids: [`account_day:${TEST_CORRECTION_DAY}`] },
          pending_operations: [
            { operation_key: `account_day:${TEST_CORRECTION_DAY}:interactions` },
          ],
        }),
      ],
    },
    // The correction day answers with a provider failure, so it is not
    // collected and stays owed.
    graph: {
      accountDays: {
        [TEST_CORRECTION_DAY]: { error: { code: 1, message: "temporary" } },
      },
    },
  });

  const summary = await runOwnerDrain(harness.ports);

  assertEquals(summary.retried, 1);
  assertEquals(summary.completed, 0);
  // The job is completed as a retry, and the operation stays open, so the
  // accepted claim selects it again.
  assertEquals(harness.calls.completes, [
    { outcome: "retry", reasonCode: "provider_error" },
  ]);
  const planned = lastInventoryProgress(harness.calls);
  assertEquals(planned.remaining_ids.includes(`account_day:${TEST_CORRECTION_DAY}`), true);
});

// ---------------------------------------------------------------------------
// The media continuation
// ---------------------------------------------------------------------------

Deno.test("the insights of at most five media are collected per visit", async () => {
  const media = Array.from({ length: 8 }, (_unused, index) => ({
    id: `media-${index + 1}`,
    media_type: "IMAGE",
    media_product_type: "FEED",
    timestamp: `2026-10-${String(20 - index).padStart(2, "0")}T12:00:00Z`,
  }));

  const harness = createHarness({
    store: { jobs: [createClaimedJob()] },
    graph: { media },
  });

  const summary = await runOwnerDrain(harness.ports);

  assertEquals(summary.completed, 0);
  assertEquals(summary.partial, 1);

  // Exactly five media insights were fetched.
  assertEquals(harness.graphCalls.filter((call) => call === "mediaInsight").length, 5);
  assertEquals(MEDIA_INSIGHTS_PER_VISIT, 5);

  // The three media that were not reached stay in the queue, and the job is
  // left claimable.
  const progress = lastInventoryProgress(harness.calls);
  assertEquals(progress.remaining_ids, ["media-6", "media-7", "media-8"]);
  assertEquals(harness.calls.completes, [
    { outcome: "partial", reasonCode: "media_insights_pending" },
  ]);
});

Deno.test("the pending media queue is resumed instead of rebuilt", async () => {
  const harness = createHarness({
    store: {
      jobs: [
        createClaimedJob({
          checkpoint: { inventory_remaining_ids: ["media-7"], inventory_pages_fetched: 1 },
        }),
      ],
    },
    graph: { media: [] },
  });

  await runOwnerDrain(harness.ports);

  // The queued media was collected, not the newest ones: the queue was
  // resumed.
  const insightUrls = harness.graphUrls.filter((url) => url.includes("/insights"));
  assertEquals(insightUrls.length, 1);
  assertStringIncludes(insightUrls[0]!, "/media-7/insights");
});

Deno.test("a media whose insights failed keeps its place in the queue", async () => {
  const harness = createHarness({
    store: { jobs: [createClaimedJob()] },
    graph: {
      mediaInsights: {
        "media-1": { error: { message: "temporary" } },
      },
    },
  });

  const summary = await runOwnerDrain(harness.ports);

  assertEquals(summary.partial, 1);
  assertEquals(summary.completed, 0);

  // The media is still owed, and the job is not completed.
  const progress = lastInventoryProgress(harness.calls);
  assertEquals(progress.remaining_ids, ["media-1"]);
  assertEquals(harness.calls.completes, [
    { outcome: "partial", reasonCode: "media_insights_pending" },
  ]);
});

Deno.test("a media whose type has no insights is closed truthfully", async () => {
  const harness = createHarness({
    store: {
      jobs: [createClaimedJob()],
      mediaInventory: {
        "media-1": { mediaProductType: "FEED", mediaType: "CAROUSEL_ALBUM" },
      },
    },
  });

  const summary = await runOwnerDrain(harness.ports);

  assertEquals(summary.completed, 1);

  // The media was written as unavailable, and no insight was requested.
  const insight = harness.calls.snapshots[4]!.items[0]!;
  assertEquals(insight.status, "unavailable");
  assertEquals(harness.graphCalls.includes("mediaInsight"), false);
});

Deno.test("a queue that cannot hold every media records the gap", async () => {
  const media = Array.from({ length: MEDIA_QUEUE_LIMIT + 3 }, (_unused, index) => ({
    id: `media-${index + 1}`,
    media_type: "IMAGE",
    media_product_type: "FEED",
    timestamp: "2026-10-20T12:00:00Z",
  }));

  const harness = createHarness({
    store: { jobs: [createClaimedJob()] },
    graph: { media },
  });

  const summary = await runOwnerDrain(harness.ports);

  assertEquals(summary.completed, 0);
  assertEquals(summary.partial, 1);

  // The queue is capped at the size the accepted checkpoint accepts, and the
  // limitation is recorded instead of hidden.
  const progress = lastInventoryProgress(harness.calls);
  assertEquals(progress.remaining_ids.length, MEDIA_QUEUE_LIMIT - MEDIA_INSIGHTS_PER_VISIT);
  assertEquals(progress.gap_reason, "media_queue_capped");
});

// ---------------------------------------------------------------------------
// The truth of the inventory
// ---------------------------------------------------------------------------

Deno.test("the inventory progress reports the pages, the oldest instant and the coverage", async () => {
  const harness = createHarness({
    store: { jobs: [createClaimedJob()] },
    graph: {
      media: [
        {
          id: "media-1",
          media_type: "IMAGE",
          timestamp: "2026-10-20T12:00:00Z",
        },
      ],
    },
  });

  const summary = await runOwnerDrain(harness.ports);

  assertEquals(summary.completed, 1);
  const progress = lastInventoryProgress(harness.calls);
  assertEquals(progress.kind, "inventory");
  assertEquals(progress.pages_fetched, 1);
  assertEquals(progress.oldest_returned_at, "2026-10-20T12:00:00.000Z");
  assertEquals(progress.window_start, "2026-07-30");
  assertEquals(progress.window_end, TEST_CAPTURED_ON);
  assertEquals(progress.truncated, false);
  assertEquals(progress.window_covered, true);
  assertEquals(progress.partial, false);
  assertEquals(progress.gap_reason, null);
  assertEquals(progress.cursor, null);
  // Nothing is owed: the queue is empty.
  assertEquals(progress.remaining_ids, []);
});

Deno.test("a truncated inventory is a partial and never a full success", async () => {
  const harness = createHarness({
    store: { jobs: [createClaimedJob()] },
  });

  // The provider always offers another page, so the sweep is capped.
  const summary = await runOwnerDrain({
    ...harness.ports,
    provider: new InstagramGraphProvider({
      fetchFn: (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("metric_type=total_value")) {
          return Promise.resolve(
            new Response(JSON.stringify(accountDayAnswer({ reach: 450 })), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }),
          );
        }
        if (url.includes("/insights?")) {
          return Promise.resolve(
            new Response(JSON.stringify(mediaInsightAnswer({ reach: 100 })), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }),
          );
        }
        if (url.includes("/media?")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                data: [
                  {
                    id: "media-1",
                    media_type: "IMAGE",
                    timestamp: "2026-10-20T12:00:00Z",
                  },
                ],
                paging: {
                  cursors: { after: "cursor-1" },
                  next: "https://graph.facebook.com/v22.0/ig/media?after=cursor-1",
                },
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            ),
          );
        }
        return Promise.resolve(
          new Response(JSON.stringify(PROFILE), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );
      },
    }),
  });

  assertEquals(summary.completed, 0);
  assertEquals(summary.partial, 1);

  const progress = lastInventoryProgress(harness.calls);
  assertEquals(progress.truncated, true);
  assertEquals(progress.window_covered, false);
  assertEquals(progress.partial, true);
  assertEquals(progress.pages_fetched, 2);
  assertEquals(progress.cursor, "cursor-1");
  assertEquals(progress.gap_reason, "inventory_truncated");

  // The accepted SQL refuses a `completed` completion for a truncated
  // inventory, so the worker must not claim one.
  assertEquals(harness.calls.completes, [
    { outcome: "partial", reasonCode: "inventory_incomplete" },
  ]);
});

Deno.test("a media window that is covered by an older item stops the sweep", async () => {
  const harness = createHarness({
    store: { jobs: [createClaimedJob()] },
    graph: {
      media: [
        {
          id: "media-old",
          media_type: "IMAGE",
          timestamp: "2026-01-01T00:00:00Z",
        },
      ],
    },
  });

  const summary = await runOwnerDrain(harness.ports);

  assertEquals(summary.completed, 1);
  const progress = lastInventoryProgress(harness.calls);
  assertEquals(progress.window_covered, true);
  assertEquals(progress.truncated, false);
  // The item is outside the ninety day window, so it is not stored: only the
  // profile and the two daily observations were written.
  assertEquals(harness.calls.snapshots.length, 3);
});

// ---------------------------------------------------------------------------
// The throttle
// ---------------------------------------------------------------------------

Deno.test("a rate limit parks the job once and the job is never completed", async () => {
  const harness = createHarness({
    store: { jobs: [createClaimedJob()] },
    graph: {
      profile: { error: { code: 32, message: "Page request limit reached" } },
      accountDays: {
        [TEST_PRIMARY_DAY]: { error: { code: 32, message: "Page request limit reached" } },
      },
      media: [],
    },
  });

  const summary = await runOwnerDrain(harness.ports);

  assertEquals(summary.retried, 1);
  assertEquals(summary.completed, 0);
  assertEquals(summary.stoppedEarly, true);

  // The job-scoped throttle parks the job exactly once.
  assertEquals(harness.calls.throttles.length, 1);
  assertEquals(harness.calls.throttles[0]!.jobId, TEST_JOB_ID);
  assertEquals(harness.calls.throttles[0]!.throttledUntil !== null, true);

  // A parked job is not a completed job.
  assertEquals(harness.calls.completes.length, 0);
});

Deno.test("a nearly spent usage budget stops the run after the job", async () => {
  const harness = createHarness({
    store: { jobs: [createClaimedJob(), createClaimedJob()] },
    graph: {
      profileHeaders: { "x-app-usage": JSON.stringify({ call_count: 85 }) },
    },
  });

  const summary = await runOwnerDrain(harness.ports);

  assertEquals(summary.claimed, 2);
  assertEquals(summary.partial, 1);
  assertEquals(summary.completed, 0);
  assertEquals(summary.stoppedEarly, true);

  // The provider work stops with the usage: the daily observations and the
  // media inventory are not requested.
  assertEquals(harness.graphCalls, ["profile"]);

  // The shared bucket carries the window, and it is NOT job-scoped: the
  // bucket state is shared, the job is not parked by it.
  assertEquals(harness.calls.throttles.length, 1);
  assertEquals(harness.calls.throttles[0]!.jobId, null);
  assertEquals(harness.calls.throttles[0]!.usagePercent, 85);
  assertEquals(harness.calls.throttles[0]!.throttledUntil !== null, true);

  // The job is left partial and the reason says why.
  assertEquals(harness.calls.completes, [
    { outcome: "partial", reasonCode: "rate_limited" },
  ]);
});

// ---------------------------------------------------------------------------
// The fairness: one job never stalls the others
// ---------------------------------------------------------------------------

Deno.test("a job without a bound context does not stall the next owner", async () => {
  const broken = createClaimedJob({
    context: {
      viewer_social_account_id: null,
      credential_generation: null,
      login_kind: null,
      capability_present: false,
      permission_read_state: null,
      granted_scopes: [],
    },
  });

  const harness = createHarness({
    store: { jobs: [broken, createClaimedJob()] },
  });

  const summary = await runOwnerDrain(harness.ports);

  assertEquals(summary.claimed, 2);
  assertEquals(summary.abandoned, 1);
  assertEquals(summary.completed, 1);
  assertEquals(summary.stoppedEarly, false);
  assertEquals(summary.jobs[0]!.reasonCode, "context_missing");
  assertEquals(summary.jobs[1]!.outcome, "completed");
});

Deno.test("a target that is gone does not stall the next owner", async () => {
  const broken = createClaimedJob({
    social_account_id: SECOND_ACCOUNT_ID,
    target_id: SECOND_ACCOUNT_ID,
    context: {
      viewer_social_account_id: SECOND_ACCOUNT_ID,
      credential_generation: 7,
      login_kind: "page_linked",
      capability_present: true,
      permission_read_state: "ok",
      granted_scopes: ["instagram_basic", "instagram_manage_insights"],
    },
  });

  const harness = createHarness({
    store: {
      jobs: [broken, createClaimedJob()],
      accounts: {
        [SECOND_ACCOUNT_ID]: { target: null },
      },
    },
  });

  const summary = await runOwnerDrain(harness.ports);

  assertEquals(summary.claimed, 2);
  assertEquals(summary.abandoned, 1);
  assertEquals(summary.completed, 1);
  assertEquals(summary.stoppedEarly, false);
  assertEquals(summary.jobs[0]!.reasonCode, "target_missing");
  assertEquals(summary.jobs[1]!.outcome, "completed");
});

Deno.test("a credential that was replaced does not stall the next owner", async () => {
  const broken = createClaimedJob({
    social_account_id: SECOND_ACCOUNT_ID,
    target_id: SECOND_ACCOUNT_ID,
    context: {
      viewer_social_account_id: SECOND_ACCOUNT_ID,
      credential_generation: 7,
      login_kind: "page_linked",
      capability_present: true,
      permission_read_state: "ok",
      granted_scopes: ["instagram_basic", "instagram_manage_insights"],
    },
  });

  const harness = createHarness({
    store: {
      jobs: [broken, createClaimedJob()],
      accounts: {
        [SECOND_ACCOUNT_ID]: { credential: { capabilityGeneration: 8 } },
      },
    },
  });

  const summary = await runOwnerDrain(harness.ports);

  assertEquals(summary.claimed, 2);
  assertEquals(summary.abandoned, 1);
  assertEquals(summary.completed, 1);
  assertEquals(summary.stoppedEarly, false);
  assertEquals(summary.jobs[0]!.reasonCode, "credential_changed");
  assertEquals(summary.jobs[1]!.outcome, "completed");
});

Deno.test("a throttled credential does not stall the next owner", async () => {
  const throttledKey = await sha256Of("credential-throttled");
  const healthyKey = await sha256Of("credential-healthy");

  const broken = createClaimedJob({
    social_account_id: SECOND_ACCOUNT_ID,
    target_id: SECOND_ACCOUNT_ID,
    context: {
      viewer_social_account_id: SECOND_ACCOUNT_ID,
      credential_generation: 7,
      login_kind: "page_linked",
      capability_present: true,
      permission_read_state: "ok",
      granted_scopes: ["instagram_basic", "instagram_manage_insights"],
    },
  });

  const harness = createHarness({
    store: {
      jobs: [broken, createClaimedJob()],
      accounts: {
        [SECOND_ACCOUNT_ID]: { credential: { credentialId: "credential-throttled" } },
        [TEST_ACCOUNT_ID]: { credential: { credentialId: "credential-healthy" } },
      },
      bucketByKey: {
        [throttledKey]: {
          usagePercent: 90,
          throttledUntil: "2026-10-28T13:00:00.000Z",
        },
        [healthyKey]: null,
      },
    },
    now: fixedClock(Date.parse("2026-10-28T12:00:00.000Z")),
  });

  const summary = await runOwnerDrain(harness.ports);

  assertEquals(summary.claimed, 2);
  assertEquals(summary.retried, 1);
  assertEquals(summary.completed, 1);
  assertEquals(summary.stoppedEarly, false);

  // The throttled owner spent no provider call; the healthy owner was
  // collected.
  assertEquals(harness.calls.throttles.length, 1);
  assertEquals(harness.calls.throttles[0]!.jobId, TEST_JOB_ID);
  assertEquals(harness.calls.snapshots.length, 5);
});

/**
 * The owner whose write the database refuses.
 *
 * It is NOT a fresh job: its checkpoint says the window is covered and that
 * nothing is owed, so the FIRST write it attempts is the snapshot write -
 * the write the accepted fence refused with SQLSTATE 40001.
 */
function createRefusedWriteJob(): ClaimedOwnerJob {
  return createClaimedJob({
    job_id: SECOND_JOB_ID,
    claim_token: SECOND_CLAIM_TOKEN,
    social_account_id: SECOND_ACCOUNT_ID,
    target_id: SECOND_ACCOUNT_ID,
    context: {
      viewer_social_account_id: SECOND_ACCOUNT_ID,
      credential_generation: 7,
      login_kind: "page_linked",
      capability_present: true,
      permission_read_state: "ok",
      granted_scopes: ["instagram_basic", "instagram_manage_insights"],
    },
    checkpoint: {
      inventory_pages_fetched: 1,
      inventory_window_covered: true,
      inventory_window_start: "2026-07-30",
      inventory_window_end: TEST_CAPTURED_ON,
      inventory_remaining_ids: [],
    },
  });
}

Deno.test("a snapshot write the database refused does not stall the next owner", async () => {
  // The account reconnected while its media insights call was in flight: the
  // database refused the next snapshot write with SQLSTATE 40001 and stored
  // nothing. The condition belongs to THAT owner alone.
  const broken = createRefusedWriteJob();

  const harness = createHarness({
    store: {
      jobs: [broken, createClaimedJob()],
      writeFailure: {
        jobId: SECOND_JOB_ID,
        failure: "stale_claim",
        sqlstate: "40001",
      },
    },
  });

  const summary = await runOwnerDrain(harness.ports);

  assertEquals(summary.claimed, 2);
  assertEquals(summary.abandoned, 1);
  assertEquals(summary.completed, 1);
  assertEquals(summary.stoppedEarly, false);
  assertEquals(summary.jobs[0]!.reasonCode, "stale_claim");
  assertEquals(summary.jobs[1]!.outcome, "completed");

  // Nothing was written for the refused job, and the healthy owner was
  // collected.
  assertEquals(harness.calls.completes.length, 1);
  assertEquals(harness.calls.completes[0]!.outcome, "completed");

  // The write the database refused WAS the snapshot write of that job.
  assertEquals(harness.calls.refusedWrites.length, 1);
  assertEquals(harness.calls.refusedWrites[0]!.jobId, SECOND_JOB_ID);
  assertEquals(harness.calls.refusedWrites[0]!.kind, "snapshot");
});

Deno.test("a write refused because the connection changed does not stall the next owner", async () => {
  // The same refusal, read as the replaced connection it also is.
  const broken = createRefusedWriteJob();

  const harness = createHarness({
    store: {
      jobs: [broken, createClaimedJob()],
      writeFailure: {
        jobId: SECOND_JOB_ID,
        failure: "credential_changed",
        sqlstate: "40001",
      },
    },
  });

  const summary = await runOwnerDrain(harness.ports);

  assertEquals(summary.claimed, 2);
  assertEquals(summary.abandoned, 1);
  assertEquals(summary.completed, 1);
  assertEquals(summary.stoppedEarly, false);
  assertEquals(summary.jobs[0]!.reasonCode, "credential_changed");
  assertEquals(summary.jobs[1]!.outcome, "completed");
});

Deno.test("a write that failed for an unknown reason still stops the run", async () => {
  // An unknown failure is NOT a definitive refusal: the statement may have
  // committed, so nothing is reported as stored and the run stops.
  const broken = createRefusedWriteJob();

  const harness = createHarness({
    store: {
      jobs: [broken, createClaimedJob()],
      writeFailure: {
        jobId: SECOND_JOB_ID,
        failure: "rpc_failed",
        sqlstate: "57014",
      },
    },
  });

  const summary = await runOwnerDrain(harness.ports);

  assertEquals(summary.claimed, 2);
  assertEquals(summary.abandoned, 1);
  assertEquals(summary.completed, 0);
  assertEquals(summary.stoppedEarly, true);
  assertEquals(summary.jobs[0]!.reasonCode, "storage_error");

  // The second job was never reached: the run stopped.
  assertEquals(summary.jobs.length, 1);
  assertEquals(harness.calls.completes.length, 0);
});

// ---------------------------------------------------------------------------
// The context, the credential and the direct-login account
// ---------------------------------------------------------------------------

Deno.test("a job without a bound context spends no provider call", async () => {
  const harness = createHarness({
    store: {
      jobs: [
        createClaimedJob({
          context: {
            viewer_social_account_id: null,
            credential_generation: null,
            login_kind: null,
            capability_present: false,
            permission_read_state: null,
            granted_scopes: [],
          },
        }),
      ],
    },
  });

  const summary = await runOwnerDrain(harness.ports);

  assertEquals(summary.abandoned, 1);
  assertEquals(summary.processed, 0);
  assertEquals(harness.graphCalls.length, 0);
  assertEquals(harness.calls.completes.length, 0);
  assertEquals(harness.calls.snapshots.length, 0);
});

Deno.test("a credential generation that moved on spends no provider call", async () => {
  const harness = createHarness({
    store: {
      jobs: [createClaimedJob()],
      credential: { capabilityGeneration: 8 },
    },
  });

  const summary = await runOwnerDrain(harness.ports);

  assertEquals(summary.abandoned, 1);
  assertEquals(summary.processed, 0);
  assertEquals(harness.graphCalls.length, 0);
  assertEquals(harness.calls.completes.length, 0);
  assertEquals(harness.calls.snapshots.length, 0);
});

Deno.test("an account without a protected credential is a retry, not a collection", async () => {
  const harness = createHarness({
    store: {
      jobs: [createClaimedJob()],
      credentialFailure: "credential_missing",
    },
  });

  const summary = await runOwnerDrain(harness.ports);

  assertEquals(summary.retried, 1);
  assertEquals(harness.graphCalls.length, 0);
  assertEquals(harness.calls.completes, [
    { outcome: "retry", reasonCode: "credential_unavailable" },
  ]);
});

Deno.test("a media that was already collected keeps its stored metrics and is never queued twice", async () => {
  const harness = createHarness({
    store: {
      jobs: [createClaimedJob()],
      // The row this capture day already stores carries the insights that
      // were collected for this media, so the media owes nothing.
      mediaInventory: { "media-1": { views: 200, reach: 100 } },
    },
  });

  const summary = await runOwnerDrain(harness.ports);

  // The media is not collected again: no provider call is spent on a media
  // the database already knows.
  assertEquals(harness.graphCalls.includes("mediaInsight"), false);

  // The queue is empty, so the job is a full success.
  const progress = lastInventoryProgress(harness.calls);
  assertEquals(progress.remaining_ids, []);
  assertEquals(summary.completed, 1);

  // The inventory write carries the stored insight metrics over. The
  // accepted upsert writes the EXCLUDED columns, so a metric that is not in
  // the payload is nulled - and a re-swept page would wipe the insights this
  // capture day already stored.
  const inventory = harness.calls.snapshots.find((entry) => entry.kind === "owner_media")!;
  assertEquals(inventory.items[0]!.metrics, {
    like_count_public: 55,
    comments_count_public: 3,
    views: 200,
    reach: 100,
  });
});

Deno.test("a media whose insights are still owed is queued again", async () => {
  const harness = createHarness({
    store: {
      jobs: [createClaimedJob()],
      // The row exists, but it carries no insight metric: the media was
      // inventoried and its insights are still owed.
      mediaInventory: { "media-1": { views: null, reach: null } },
    },
  });

  await runOwnerDrain(harness.ports);

  // The media was collected again, because it still owed its insights.
  assertEquals(harness.graphCalls.filter((call) => call === "mediaInsight").length, 1);
});

// ---------------------------------------------------------------------------
// The login kinds
// ---------------------------------------------------------------------------

Deno.test("a page-linked account is collected through the Facebook login adapter", async () => {
  const harness = createHarness({ store: { jobs: [createClaimedJob()] } });

  await runOwnerDrain(harness.ports);

  assertEquals(harness.graphUrls.length > 0, true);
  for (const url of harness.graphUrls) {
    assert(url.startsWith("https://graph.facebook.com/"));
  }
});

Deno.test("a direct-login account is collected through the Instagram login adapter", async () => {
  const harness = createHarness({
    store: {
      jobs: [
        createClaimedJob({
          context: {
            viewer_social_account_id: TEST_ACCOUNT_ID,
            credential_generation: 7,
            login_kind: "direct",
            capability_present: true,
            permission_read_state: "ok",
            granted_scopes: ["instagram_business_basic", "instagram_business_manage_insights"],
          },
        }),
      ],
      capability: {
        loginKind: "direct",
        grantedScopes: ["instagram_business_basic", "instagram_business_manage_insights"],
      },
    },
  });

  const summary = await runOwnerDrain(harness.ports);

  assertEquals(summary.completed, 1);

  // Every provider call went to the Instagram-login host. The host and the
  // token never come from different logins.
  assertEquals(harness.graphUrls.length > 0, true);
  for (const url of harness.graphUrls) {
    assert(url.startsWith("https://graph.instagram.com/"));
  }

  // The protected Facebook credential was never read, and the operational
  // token came from the fenced direct reader.
  assertEquals(harness.calls.credentialReads.length, 0);
  assertEquals(harness.calls.directCredentialReads.length, 1);
});

Deno.test("a direct credential whose generation moved on spends no provider call", async () => {
  const harness = createHarness({
    store: {
      jobs: [
        createClaimedJob({
          context: {
            viewer_social_account_id: TEST_ACCOUNT_ID,
            credential_generation: 7,
            login_kind: "direct",
            capability_present: true,
            permission_read_state: "ok",
            granted_scopes: ["instagram_business_basic", "instagram_business_manage_insights"],
          },
        }),
      ],
      capability: {
        loginKind: "direct",
        // The connection was replaced after the claim.
        credentialGeneration: 9,
        grantedScopes: ["instagram_business_basic", "instagram_business_manage_insights"],
      },
    },
  });

  const summary = await runOwnerDrain(harness.ports);

  assertEquals(summary.abandoned, 1);
  assertEquals(summary.completed, 0);
  assertEquals(harness.graphCalls.length, 0);
  assertEquals(harness.calls.completes.length, 0);
});

Deno.test("a direct credential that the database refuses is not a collection", async () => {
  const harness = createHarness({
    store: {
      jobs: [
        createClaimedJob({
          context: {
            viewer_social_account_id: TEST_ACCOUNT_ID,
            credential_generation: 7,
            login_kind: "direct",
            capability_present: true,
            permission_read_state: "ok",
            granted_scopes: ["instagram_business_basic", "instagram_business_manage_insights"],
          },
        }),
      ],
      capability: {
        loginKind: "direct",
        grantedScopes: ["instagram_business_basic", "instagram_business_manage_insights"],
      },
      directCredentialFailure: "credential_changed",
    },
  });

  const summary = await runOwnerDrain(harness.ports);

  assertEquals(summary.abandoned, 1);
  assertEquals(harness.graphCalls.length, 0);
});

Deno.test("a direct-login account without the insights permission is closed with a stable outcome and no provider call", async () => {
  const harness = createHarness({
    store: {
      jobs: [
        createClaimedJob({
          context: {
            viewer_social_account_id: TEST_ACCOUNT_ID,
            credential_generation: 7,
            login_kind: "direct",
            capability_present: true,
            permission_read_state: "ok",
            granted_scopes: ["instagram_basic"],
          },
        }),
      ],
      capability: { loginKind: "direct" },
    },
  });

  const summary = await runOwnerDrain(harness.ports);

  assertEquals(summary.unavailable, 1);
  assertEquals(summary.completed, 0);
  assertEquals(summary.retried, 0);

  // The outcome is decided from the trusted capability, before the
  // credential is read and without a provider call.
  assertEquals(harness.calls.credentialReads.length, 0);
  assertEquals(harness.calls.directCredentialReads.length, 0);
  assertEquals(harness.graphCalls.length, 0);
  assertEquals(harness.calls.completes, [
    { outcome: "unavailable", reasonCode: "direct_login_unsupported" },
  ]);
});

// ---------------------------------------------------------------------------
// The bound
// ---------------------------------------------------------------------------

Deno.test("boundedStep gives up on a step that ignores the abort", async () => {
  let calls = 0;
  const budget = {
    startedAt: 0,
    totalMs: 120,
    remainingMs: () => 120 - (calls++ === 0 ? 0 : 0),
    canStartProviderCall: () => false,
  };

  const started = Date.now();
  let refused = false;
  try {
    await boundedStep(budget, 0, undefined, () => new Promise(() => undefined));
  } catch (error) {
    refused = error instanceof BudgetExceededError;
  }

  assertEquals(refused, true);
  assert(Date.now() - started < 2_000);
});

Deno.test("an uncooperative claim abandons the run inside the budget", async () => {
  // The claim is the first bounded step. The clock puts it 34 seconds into
  // the run, so its window is one second.
  const harness = createHarness({
    store: { hangOn: "claim" },
    now: scheduledClock([0, 34_000]),
  });

  const started = Date.now();
  const summary = await runOwnerDrain(harness.ports);

  assertEquals(summary.claimed, 0);
  assertEquals(summary.abandoned, 0);
  assertEquals(summary.stoppedEarly, true);
  assert(Date.now() - started < 5_000);
});

Deno.test("an uncooperative read abandons the job to its lease", async () => {
  // The clock reads: the budget start, the claim, the provider-call
  // precondition, the job start and the target read. The read is put 34.8
  // seconds into the run, so its window is two hundred milliseconds.
  const harness = createHarness({
    store: { jobs: [createClaimedJob()], hangOn: "target" },
    now: scheduledClock([0, 1_000, 2_000, 3_000, 34_800]),
  });

  const started = Date.now();
  const summary = await runOwnerDrain(harness.ports);

  assertEquals(summary.abandoned, 1);
  assertEquals(summary.processed, 0);
  assertEquals(harness.calls.completes.length, 0);
  assertEquals(harness.graphCalls.length, 0);
  assertEquals(summary.jobs[0]!.reasonCode, "deadline_exceeded");
  assert(Date.now() - started < 5_000);
});

Deno.test("an uncooperative provider call abandons the job to its lease", async () => {
  // The clock reads: the budget start, the claim, the provider-call
  // precondition, the job start, the target read, the capability read, the
  // credential read, the bucket key, the bucket read, the provider-call
  // precondition and the provider call. The provider call is put 34.8
  // seconds into the run, so its window is two hundred milliseconds.
  const harness = createHarness({
    store: { jobs: [createClaimedJob()] },
    graph: { hangOn: "profile" },
    now: scheduledClock([
      0,
      1_000,
      2_000,
      3_000,
      4_000,
      5_000,
      6_000,
      7_000,
      8_000,
      9_000,
      34_800,
    ]),
  });

  const started = Date.now();
  const summary = await runOwnerDrain(harness.ports);

  assertEquals(summary.abandoned, 1);
  assertEquals(summary.processed, 0);
  assertEquals(harness.calls.completes.length, 0);
  assertEquals(harness.calls.snapshots.length, 0);
  // The provider call WAS started: the transport was reached and then gave
  // up on the worker's deadline.
  assertEquals(harness.graphCalls.length, 1);
  assertEquals(summary.jobs[0]!.reasonCode, "deadline_exceeded");
  assert(Date.now() - started < 5_000);
});

Deno.test("an uncooperative write abandons the job to its lease", async () => {
  // The clock reads: the budget start, the claim, the provider-call
  // precondition, the job start, the three reads, the provider-call
  // precondition, the provider call and the first write. The write is put
  // 39.5 seconds into the run, so its window is half a second.
  const harness = createHarness({
    store: { jobs: [createClaimedJob()], hangOn: "snapshot" },
    now: scheduledClock([
      0,
      1_000,
      2_000,
      3_000,
      4_000,
      5_000,
      6_000,
      7_000,
      8_000,
      9_000,
      10_000,
      39_500,
    ]),
  });

  const started = Date.now();
  const summary = await runOwnerDrain(harness.ports);

  assertEquals(summary.abandoned, 1);
  assertEquals(summary.processed, 0);
  assertEquals(harness.calls.completes.length, 0);
  assertEquals(summary.jobs[0]!.reasonCode, "deadline_exceeded");
  assert(Date.now() - started < 5_000);
});

Deno.test("a failed write abandons the job and stores nothing", async () => {
  const harness = createHarness({
    store: { jobs: [createClaimedJob()], failOn: "complete" },
  });

  const summary = await runOwnerDrain(harness.ports);

  assertEquals(summary.abandoned, 1);
  assertEquals(summary.processed, 0);
  assertEquals(summary.stoppedEarly, true);
});

// ---------------------------------------------------------------------------
// The secrets
// ---------------------------------------------------------------------------

Deno.test("no token reaches a log line, a summary or an error", async () => {
  const harness = createHarness({
    store: { jobs: [createClaimedJob()] },
    graph: {
      profile: { error: { code: 190, message: "Invalid OAuth access token: secret-value" } },
    },
  });

  const summary = await runOwnerDrain(harness.ports);

  const serialised = JSON.stringify({
    summary,
    logs: harness.logs,
    calls: harness.calls,
  });

  assertEquals(serialised.includes("the-secret-token"), false);
  assertEquals(serialised.includes("secret-value"), false);
  assertEquals(serialised.includes("access_token"), false);
  assertStringIncludes(serialised, "token_invalid");
});

Deno.test("the throttle window is the shared one", async () => {
  const harness = createHarness({
    store: {
      jobs: [createClaimedJob()],
      bucket: { usagePercent: 90, throttledUntil: "2026-10-28T13:00:00.000Z" },
    },
    now: fixedClock(Date.parse("2026-10-28T12:00:00.000Z")),
  });

  const summary = await runOwnerDrain(harness.ports);

  assertEquals(summary.retried, 1);
  assertEquals(harness.graphCalls.length, 0);
  // The shared window parks the job: it is not completed.
  assertEquals(harness.calls.completes.length, 0);
  assertEquals(harness.calls.throttles.length, 1);
  assertEquals(harness.calls.throttles[0]!.jobId, TEST_JOB_ID);
  assertEquals(
    harness.calls.throttles[0]!.throttledUntil !== null,
    true,
  );
  assertEquals(THROTTLE_WINDOW_MS, 900_000);
});
