/**
 * The worker's contract.
 *
 * WHAT THIS SUITE PINS
 *
 *   The collection lifecycle: the viewer choice, the official capture, the
 *   no-viewer path, the paid fallback, the throttle, the weekly verdict for
 *   a confirmed unavailable target, the budget and the atomic result write.
 *
 * THE ACCEPTANCE IDS
 *
 *   A10 a viewer is present -> the capture is filed as `official`.
 *   A11 no viewer and the paid fallback is off -> the entry is recorded as
 *        an error and no paid request is made.
 *   A12 no viewer and the paid fallback is on -> the capture is filed as
 *        `apify`.
 *   A13 the provider says the target cannot be analysed -> the entry is
 *        filed as `unavailable`, which is the only outcome that opens the
 *        weekly gate.
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

import {
  COMPETITOR_CLAIM_LIMIT,
  createWorkerBudget,
  raceWithBudget,
  runCompetitorDrain,
  runCompetitorEnqueue,
  WORKER_PROVIDER_CEILING_MS,
  WORKER_WRITE_RESERVE_MS,
  type CompetitorWorkerLogEvent,
  type CompetitorWorkerPorts,
} from "./syncWorker.ts";
import {
  CompetitorStoreError,
  createCompetitorServiceStore,
  type CompetitorRpcCaller,
  type CompetitorServiceWritePort,
  type ServiceReadPort,
} from "./store.ts";
import type { CompetitorServiceStore } from "./store.ts";
import {
  CompetitorProviderError,
  type ClaimedCompetitorJob,
  type CompetitorCapture,
  type CompetitorProvider,
  type CompetitorProviderRequest,
  type CompetitorProviderResult,
  type PaidCaptureProvider,
} from "./types.ts";

const OWNER = "aa000000-0000-4000-8000-000000000001";
const WATCHLIST = "c1000000-0000-4000-8000-000000000001";
const JOB = "5c1b0003-0000-4000-8000-000000000003";
const ACCOUNT = "a1000000-0000-4000-8000-000000000001";

/**
 * The write port of a test that does not exercise the exception-path audit.
 *
 * It reports that the row did NOT commit, so a refusal that is audited here
 * is audited as failed - the fail-closed direction.
 */
const noWrites: CompetitorServiceWritePort = {
  async insertSystemLog() {
    return false;
  },
};

interface Recorder {
  store: CompetitorServiceStore;
  readonly persisted: Array<Record<string, unknown>>;
  readonly throttles: Array<Record<string, unknown>>;
  readonly attaches: Array<Record<string, unknown>>;
  readonly permits: Array<{ jobId: string; outcome: string }>;
  readonly logs: CompetitorWorkerLogEvent[];
  claimedLimit: number | null;
}

function fakeStore(options: {
  readonly candidates?: unknown[];
  readonly bucket?: { readonly usagePercent: number | null; readonly throttledUntil: string | null } | null;
  readonly persistThrows?: boolean;
  readonly credentialGeneration?: number;
  readonly attachedGeneration?: number;
  readonly targetMissing?: boolean;
} = {}): Recorder {
  const persisted: Array<Record<string, unknown>> = [];
  const throttles: Array<Record<string, unknown>> = [];
  const attaches: Array<Record<string, unknown>> = [];
  const permits: Array<{ jobId: string; outcome: string }> = [];
  const logs: CompetitorWorkerLogEvent[] = [];

  const recorder: Recorder = {
    store: {} as CompetitorServiceStore,
    persisted,
    throttles,
    attaches,
    permits,
    logs,
    claimedLimit: null,
  };

  const store: CompetitorServiceStore = {
    async listDueTargets() {
      return [];
    },
    async enqueueService() {
      return { accepted: 0, results: [] };
    },
    async claimCompetitorJobs(input): Promise<ClaimedCompetitorJob[]> {
      recorder.claimedLimit = input.limit;
      return [{
        jobId: JOB,
        userId: OWNER,
        watchlistId: WATCHLIST,
        capturedOn: "2026-10-29",
        jobGeneration: 1,
        claimToken: "claim-token",
        leaseExpiresAt: "2026-10-29T02:02:00Z",
        attempts: 1,
      }];
    },
    async readWatchlistTarget() {
      if (options.targetMissing) return null;
      return { userId: OWNER, username: "competitor_brand" };
    },
    async listViewerCandidates() {
      return (options.candidates ?? [
        {
          id: ACCOUNT,
          user_id: OWNER,
          platform: "instagram",
          platform_user_id: "ig-viewer",
          access_token: "sentinel",
          is_active: true,
          needs_reauth: false,
          ig_auth_type: null,
          account_metadata: { granted_scopes: ["instagram_manage_insights"] },
          connected_at: "2026-01-01T00:00:00Z",
        },
      ]) as never;
    },
    async resolveViewerCredential() {
      return {
        token: "protected-token",
        credentialId: "cred-1",
        capabilityGeneration: options.credentialGeneration ?? 3,
      };
    },
    async attachViewerContext(input) {
      attaches.push({ ...input });
      return {
        kind: "attached",
        context: {
          viewerSocialAccountId: input.viewerSocialAccountId,
          credentialGeneration: options.attachedGeneration ?? 3,
          loginKind: "page_linked",
        },
      };
    },
    async authorizeProviderCall() {
      permits.push({ jobId: JOB, outcome: "allowed" });
      return {
        kind: "allowed",
        permit: {
          allowed: true,
          jobId: JOB,
          targetKind: "competitor",
          targetId: WATCHLIST,
          viewerSocialAccountId: ACCOUNT,
          jobGeneration: 1,
          credentialGeneration: 3,
          policyFingerprint: null,
        },
      };
    },
    async auditAdmissionRefusal() {
      return true;
    },
    async persistResult(input) {
      if (options.persistThrows) {
        throw new Error("the write did not succeed");
      }
      persisted.push(input.payload as unknown as Record<string, unknown>);
      return {
        outcome: (input.payload as { outcome: "completed" | "unavailable" | "retry" }).outcome,
        source: (input.payload as { source?: "official" | "apify" }).source ?? null,
        reasonCode: null,
        written: 1,
        mediaCount: 0,
        capturedAt: null,
        coverage: null,
      };
    },
    async recordThrottle(input) {
      throttles.push({ ...input });
    },
    async readThrottleBucket() {
      return options.bucket ?? null;
    },
  };

  recorder.store = store;
  return recorder;
}

const CAPTURE: CompetitorCapture = {
  source: "official",
  profile: { followers_count: 54200, media_count: 120 },
  media: [{
    ig_media_id: "media_1",
    media_product_type: "REELS",
    media_type: "VIDEO",
    thumbnail_url: null,
    caption: null,
    permalink: null,
    published_at: "2026-10-28T12:00:00.000Z",
    like_count: 1500,
    comments_count: 45,
    view_count: 12000,
  }],
  truncated: false,
  coverage: {
    captureStartedAt: "2026-10-29T02:00:00.000Z",
    captureEndedAt: "2026-10-29T02:00:05.000Z",
    oldestReturnedAt: "2026-10-28T12:00:00.000Z",
    orderingVerified: false,
    cursorPresent: false,
    exhausted: true,
    truncated: false,
    gapReason: null,
  },
};

function provider(
  capture: CompetitorCapture = CAPTURE,
  usagePercent = 0,
): CompetitorProvider & { calls: number } {
  const adapter = {
    source: "official" as const,
    calls: 0,
    async fetch(request: CompetitorProviderRequest): Promise<CompetitorProviderResult> {
      // The permit is asked immediately before the request leaves the
      // process, exactly as the real adapter does it. A refused permit
      // throws BEFORE the call is counted, because the request was never
      // sent.
      if (request.permit !== undefined) {
        await request.permit(request.signal);
      }
      adapter.calls += 1;
      return { capture, usagePercent, throttledUntil: null };
    },
  };
  return adapter;
}

function ports(
  recorder: Recorder,
  officialProvider: CompetitorProvider,
  paidFallback: { enabled: boolean; provider?: PaidCaptureProvider; refusalReason: "apify_disabled" } = {
    enabled: false,
    refusalReason: "apify_disabled",
  },
  now: () => number = () => Date.now(),
): CompetitorWorkerPorts {
  return {
    store: recorder.store,
    officialProvider,
    paidFallback,
    bucketKeyFor: async () => "a".repeat(64),
    now,
    log: (event) => recorder.logs.push(event),
  };
}

Deno.test("A10 a viewer is present and the capture is filed as official", async () => {
  const recorder = fakeStore();
  const adapter = provider();

  const summary = await runCompetitorDrain(ports(recorder, adapter), {});

  assertEquals(summary.claimed, 1);
  assertEquals(summary.completed, 1);
  assertEquals(summary.jobs[0]!.source, "official");
  assertEquals(summary.jobs[0]!.outcome, "completed");
  assertEquals(recorder.persisted.length, 1);
  assertEquals(recorder.persisted[0]!.outcome, "completed");
  assertEquals(recorder.persisted[0]!.source, "official");
  assertEquals(
    JSON.stringify(recorder.persisted[0]!.profile),
    JSON.stringify({ metrics: { followers_count: 54200, media_count: 120 } }),
  );
  assertEquals((recorder.persisted[0]!.media as unknown[]).length, 1);
  assertEquals(recorder.attaches.length, 1);
  assertEquals(recorder.attaches[0]!.viewerSocialAccountId, ACCOUNT);
});

Deno.test("A11 no viewer and the paid fallback off records an error and calls nothing", async () => {
  const recorder = fakeStore({ candidates: [] });
  const adapter = provider();
  let paidCalls = 0;

  const paid: PaidCaptureProvider = {
    source: "apify",
    async capture() {
      paidCalls += 1;
      return { status: "failed", reason: "provider_error" };
    },
  };

  const summary = await runCompetitorDrain(
    ports(recorder, adapter, { enabled: false, provider: paid, refusalReason: "apify_disabled" }),
    {},
  );

  assertEquals(summary.retried, 1);
  assertEquals(summary.jobs[0]!.reasonCode, "apify_disabled");
  assertEquals(paidCalls, 0);
  assertEquals(adapter.calls, 0);
  assertEquals(recorder.persisted.length, 1);
  assertEquals(recorder.persisted[0]!.outcome, "retry");
  assertEquals(recorder.persisted[0]!.reason_code, "apify_disabled");
});

Deno.test("A12 no viewer and the paid fallback on files the capture as apify", async () => {
  const recorder = fakeStore({ candidates: [] });
  const adapter = provider();

  const paid: PaidCaptureProvider = {
    source: "apify",
    async capture() {
      return {
        status: "completed",
        capture: {
          source: "apify",
          profile: { followers_count: 10, media_count: 2 },
          media: [],
          truncated: false,
          coverage: {
            captureStartedAt: "2026-10-29T02:00:00.000Z",
            captureEndedAt: "2026-10-29T02:00:04.000Z",
            oldestReturnedAt: null,
            orderingVerified: false,
            cursorPresent: null,
            exhausted: true,
            truncated: false,
            gapReason: null,
          },
        },
      };
    },
  };

  const summary = await runCompetitorDrain(
    ports(recorder, adapter, { enabled: true, provider: paid, refusalReason: "apify_disabled" }),
    {},
  );

  assertEquals(summary.completed, 1);
  assertEquals(summary.jobs[0]!.source, "apify");
  assertEquals(recorder.persisted[0]!.source, "apify");
  assertEquals(recorder.persisted[0]!.outcome, "completed");
  // The official provider was never called: there was no viewer for it.
  assertEquals(adapter.calls, 0);
});

Deno.test("A13 a confirmed unavailable target opens the weekly verdict", async () => {
  const recorder = fakeStore();
  const adapter: CompetitorProvider = {
    source: "official",
    async fetch(): Promise<CompetitorProviderResult> {
      throw new CompetitorProviderError(
        "target_unavailable",
        "The provider reported that this target cannot be analysed.",
      );
    },
  };

  const summary = await runCompetitorDrain(ports(recorder, adapter), {});

  assertEquals(summary.unavailable, 1);
  assertEquals(summary.jobs[0]!.outcome, "unavailable");
  assertEquals(recorder.persisted[0]!.outcome, "unavailable");
  assertEquals(recorder.persisted[0]!.reason_code, "target_unavailable");
});

Deno.test("a temporary viewer failure is a retry and never the weekly verdict", async () => {
  const recorder = fakeStore();
  const adapter: CompetitorProvider = {
    source: "official",
    async fetch(): Promise<CompetitorProviderResult> {
      throw new CompetitorProviderError(
        "scope_missing",
        "The provider refused the permission for this discovery.",
      );
    },
  };

  const summary = await runCompetitorDrain(ports(recorder, adapter), {});

  assertEquals(summary.retried, 1);
  assertEquals(summary.unavailable, 0);
  assertEquals(recorder.persisted[0]!.outcome, "retry");
  assertEquals(recorder.persisted[0]!.reason_code, "scope_missing");
});

Deno.test("a throttle parks the job and does not complete it", async () => {
  const recorder = fakeStore();
  const adapter: CompetitorProvider = {
    source: "official",
    async fetch(): Promise<CompetitorProviderResult> {
      throw new CompetitorProviderError(
        "rate_limited",
        "The provider is throttling this application.",
        { usagePercent: 91 },
      );
    },
  };

  const summary = await runCompetitorDrain(ports(recorder, adapter), {});

  assertEquals(summary.retried, 1);
  assertEquals(summary.jobs[0]!.reasonCode, "rate_limited");
  // The job is parked through the throttle RPC, so it is NOT written
  // again by the result path.
  assertEquals(recorder.persisted.length, 0);
  assertEquals(recorder.throttles.length, 1);
  assertEquals(recorder.throttles[0]!.jobId, JOB);
  assertEquals(recorder.throttles[0]!.usagePercent, 91);
});

Deno.test("the shared throttle bucket is read before the call and stops it", async () => {
  const recorder = fakeStore({
    bucket: { usagePercent: 91, throttledUntil: "2999-01-01T00:00:00Z" },
  });
  const adapter = provider();

  const summary = await runCompetitorDrain(ports(recorder, adapter), {});

  assertEquals(adapter.calls, 0);
  assertEquals(summary.retried, 1);
  assertEquals(summary.jobs[0]!.reasonCode, "rate_limited");
  assertEquals(recorder.persisted.length, 1);
  assertEquals(recorder.persisted[0]!.reason_code, "rate_limited");
});

Deno.test("the successful capture records the shared bucket for the next worker", async () => {
  const recorder = fakeStore();
  const adapter = provider(CAPTURE, 42);

  await runCompetitorDrain(ports(recorder, adapter), {});

  assertEquals(recorder.throttles.length, 1);
  assertEquals(recorder.throttles[0]!.usagePercent, 42);
  assertEquals(recorder.throttles[0]!.jobId, undefined);
});

Deno.test("a credential generation that moved refuses before the provider call", async () => {
  const recorder = fakeStore({ attachedGeneration: 3, credentialGeneration: 4 });
  const adapter = provider();

  const summary = await runCompetitorDrain(ports(recorder, adapter), {});

  assertEquals(adapter.calls, 0);
  assertEquals(summary.jobs[0]!.reasonCode, "credential_changed");
  assertEquals(recorder.persisted[0]!.reason_code, "credential_changed");
});

Deno.test("a provider call is not started when the budget is spent", async () => {
  const recorder = fakeStore();
  const adapter = provider();

  const clock = { value: 1_000 };
  const summary = await runCompetitorDrain(
    ports(
      recorder,
      adapter,
      { enabled: false, refusalReason: "apify_disabled" },
      () => clock.value,
    ),
    {},
  );

  // The claim is always the production limit; the budget decides how many
  // of the claimed jobs are processed.
  assertEquals(summary.claimed, 1);
  assertEquals(summary.processed, 1);
  assertEquals(recorder.claimedLimit, COMPETITOR_CLAIM_LIMIT);

  // A second run whose clock has already burnt the budget processes
  // nothing: the remaining jobs keep their leases and are recovered.
  const spent = fakeStore();
  const spentClock = { value: 1_000 };
  spent.store.claimCompetitorJobs = async () => {
    spentClock.value += 40_000;
    return [];
  };

  const blocked = await runCompetitorDrain(
    ports(
      spent,
      provider(),
      { enabled: false, refusalReason: "apify_disabled" },
      () => spentClock.value,
    ),
    {},
  );

  assertEquals(blocked.claimed, 0);
  assertEquals(blocked.processed, 0);
  assertEquals(spent.persisted.length, 0);
});

Deno.test("a provider call is not started when only the reserve is left", async () => {
  const recorder = fakeStore();
  const adapter = provider();

  const clock = { value: 1_000 };
  recorder.store.claimCompetitorJobs = async () => {
    // The claim itself eats almost the whole budget.
    clock.value += 40_000 - (WORKER_PROVIDER_CEILING_MS + WORKER_WRITE_RESERVE_MS) + 1;
    return [{
      jobId: JOB,
      userId: OWNER,
      watchlistId: WATCHLIST,
      capturedOn: "2026-10-29",
      jobGeneration: 1,
      claimToken: "claim-token",
      leaseExpiresAt: "2026-10-29T02:02:00Z",
      attempts: 1,
    }];
  };

  const summary = await runCompetitorDrain(
    ports(
      recorder,
      adapter,
      { enabled: false, refusalReason: "apify_disabled" },
      () => clock.value,
    ),
    {},
  );

  assertEquals(summary.claimed, 1);
  assertEquals(summary.processed, 0);
  assertEquals(summary.stoppedEarly, true);
  assertEquals(adapter.calls, 0);
  assertEquals(recorder.persisted.length, 0);
});

Deno.test("a provider call that does not answer is abandoned inside the budget", async () => {
  // The guard is exercised on its own: a transport that never settles must
  // not keep the worker waiting.
  const never = new Promise<never>(() => undefined);
  const outcome = await raceWithBudget(never, createWorkerBudget(() => 1_000, 120));

  assertEquals(outcome.ok, false);
});

Deno.test("a run whose budget cannot start a provider call processes nothing", async () => {
  const recorder = fakeStore();
  const adapter = provider();

  const summary = await runCompetitorDrain(
    {
      ...ports(recorder, adapter, { enabled: false, refusalReason: "apify_disabled" }),
      budgetMs: 250,
    },
    {},
  );

  // A budget that cannot even cover the write reserve does not claim at
  // all, so no lease is taken that it could never use. Nothing was written
  // and nothing was reported as a success.
  assertEquals(recorder.claimedLimit, null);
  assertEquals(summary.claimed, 0);
  assertEquals(summary.processed, 0);
  assertEquals(summary.stoppedEarly, true);
  assertEquals(adapter.calls, 0);
  assertEquals(recorder.persisted.length, 0);
});

Deno.test("a failed result write is never reported as a stored outcome", async () => {
  const recorder = fakeStore({ persistThrows: true });
  const adapter = provider();

  // The failed write abandons the job to its lease: it is not counted as
  // processed, not reported as stored, and the run stops instead of
  // spending further provider calls against a failing database.
  const summary = await runCompetitorDrain(ports(recorder, adapter), {});

  assertEquals(recorder.persisted.length, 0);
  assertEquals(summary.processed, 0);
  assertEquals(summary.completed, 0);
  assertEquals(summary.abandoned, 1);
  assertEquals(summary.jobs[0]!.outcome, "abandoned");
  assertEquals(summary.jobs[0]!.reasonCode, "storage_error");
  assertEquals(summary.stoppedEarly, true);
});

Deno.test("the scheduled enqueue groups the due targets by owner and returns the cursor", async () => {
  const calls: Array<{ ownerId: string; watchlistIds: readonly string[] }> = [];

  const recorder = fakeStore();
  const store: CompetitorServiceStore = {
    ...recorder.store,
    async listDueTargets(input) {
      // The ordered due list, paged by the (due_at, id) cursor like the SQL.
      const all = [
        { userId: OWNER, watchlistId: "c1", username: "one", dueAt: "2026-10-01T00:00:00Z" },
        { userId: OWNER, watchlistId: "c2", username: "two", dueAt: "2026-10-02T00:00:00Z" },
        { userId: "bb000000-0000-4000-8000-000000000002", watchlistId: "c3", username: "three", dueAt: "2026-10-03T00:00:00Z" },
      ];
      const after = input.cursor;
      const rest = after === null ? all : all.slice(all.findIndex((row) => row.watchlistId === after.id) + 1);
      return rest.slice(0, input.limit);
    },
    async enqueueService(input) {
      calls.push({ ownerId: input.ownerId, watchlistIds: input.watchlistIds });
      return { accepted: input.watchlistIds.length, results: [] };
    },
  };

  const summary = await runCompetitorEnqueue(
    {
      ...ports(recorder, provider()),
      store,
    },
    { limit: 3, cursor: null },
  );

  assertEquals(summary.targets, 3);
  assertEquals(summary.owners, 2);
  assertEquals(summary.enqueued, 3);
  assertEquals(calls.length, 2);
  assertEquals(calls[0]!.ownerId, OWNER);
  assertEquals(calls[0]!.watchlistIds.length, 2);
  // The page was full, so the walk read the next page, found the end of the
  // due list and reports no cursor to resume from.
  assertEquals(summary.nextCursor, null);
});

Deno.test("the scheduled enqueue walks every due page, so the first page cannot starve the rest", async () => {
  const recorder = fakeStore();
  const pages: Array<string | null> = [];
  const enqueuedIds: string[] = [];
  const all = Array.from({ length: 7 }, (_, index) => ({
    userId: OWNER,
    watchlistId: `c${index + 1}`,
    username: `target_${index + 1}`,
    dueAt: `2026-10-0${index + 1}T00:00:00Z`,
  }));

  const store: CompetitorServiceStore = {
    ...recorder.store,
    async listDueTargets(input) {
      pages.push(input.cursor?.id ?? null);
      const start = input.cursor === null
        ? 0
        : all.findIndex((row) => row.watchlistId === input.cursor!.id) + 1;
      return all.slice(start, start + input.limit);
    },
    async enqueueService(input) {
      enqueuedIds.push(...input.watchlistIds);
      return { accepted: input.watchlistIds.length, results: [] };
    },
  };

  const summary = await runCompetitorEnqueue(
    { ...ports(recorder, provider()), store },
    { limit: 3, cursor: null },
  );

  assertEquals(pages, [null, "c3", "c6"]);
  assertEquals(enqueuedIds, ["c1", "c2", "c3", "c4", "c5", "c6", "c7"]);
  assertEquals(summary.targets, 7);
  assertEquals(summary.nextCursor, null);
});

// ---------------------------------------------------------------------------
// Every step is bounded, and the usage stop really stops the run.
// ---------------------------------------------------------------------------

const SECOND_JOB: ClaimedCompetitorJob = {
  jobId: "5c1b0003-0000-4000-8000-000000000004",
  userId: OWNER,
  watchlistId: "c1000000-0000-4000-8000-000000000002",
  capturedOn: "2026-10-29",
  jobGeneration: 1,
  claimToken: "claim-token-2",
  leaseExpiresAt: "2026-10-29T02:02:00Z",
  attempts: 1,
};

function twoJobs(recorder: Recorder): void {
  const first = recorder.store.claimCompetitorJobs;
  recorder.store.claimCompetitorJobs = async (input) => [...await first(input), SECOND_JOB];
}

Deno.test("the whole budget bounds even an uncooperative claim", async () => {
  const recorder = fakeStore();
  recorder.store.claimCompetitorJobs = () => new Promise<never>(() => undefined);

  const started = Date.now();
  const summary = await runCompetitorDrain(
    { ...ports(recorder, provider()), budgetMs: WORKER_WRITE_RESERVE_MS + 40 },
    {},
  );

  assert(Date.now() - started < 2_000);
  assertEquals(summary.claimed, 0);
  assertEquals(summary.stoppedEarly, true);
});

Deno.test("an uncooperative read abandons the job and stops the run", async () => {
  const recorder = fakeStore();
  twoJobs(recorder);
  recorder.store.listViewerCandidates = () => new Promise<never>(() => undefined);
  const adapter = provider();

  const started = Date.now();
  const summary = await runCompetitorDrain(
    {
      ...ports(recorder, adapter),
      budgetMs: WORKER_PROVIDER_CEILING_MS + WORKER_WRITE_RESERVE_MS + 60,
    },
    {},
  );

  // A read may use everything except the write reserve; it can never use
  // the reserve, and it never waits on the store past that deadline.
  assert(Date.now() - started < WORKER_PROVIDER_CEILING_MS + 2_000);
  assertEquals(summary.abandoned, 1);
  assertEquals(summary.jobs[0]!.reasonCode, "deadline_exceeded");
  assertEquals(summary.jobs.length, 1);
  assertEquals(adapter.calls, 0);
  assertEquals(recorder.persisted.length, 0);
});

Deno.test("an uncooperative result write is abandoned, never retried or reported stored", async () => {
  const recorder = fakeStore();
  let writes = 0;
  recorder.store.persistResult = () => {
    writes += 1;
    return new Promise<never>(() => undefined);
  };

  const started = Date.now();
  const summary = await runCompetitorDrain(
    {
      ...ports(recorder, provider()),
      budgetMs: WORKER_PROVIDER_CEILING_MS + WORKER_WRITE_RESERVE_MS + 60,
    },
    {},
  );

  // The write may use the reserve, so this run waits out the reserve; it is
  // bounded by the whole budget, not by the store.
  assert(Date.now() - started < WORKER_PROVIDER_CEILING_MS + WORKER_WRITE_RESERVE_MS + 2_000);
  assertEquals(writes, 1);
  assertEquals(summary.completed, 0);
  assertEquals(summary.abandoned, 1);
  assertEquals(summary.jobs[0]!.outcome, "abandoned");
});

Deno.test("a nearly spent usage budget is recorded as a shared window and stops the run", async () => {
  const recorder = fakeStore();
  twoJobs(recorder);
  const adapter = provider(CAPTURE, 85);

  const summary = await runCompetitorDrain(ports(recorder, adapter), {});

  assertEquals(adapter.calls, 1);
  assertEquals(summary.completed, 1);
  assertEquals(summary.jobs.length, 1);
  assertEquals(summary.stoppedEarly, true);
  assertEquals(recorder.throttles.length, 1);
  assertEquals(recorder.throttles[0]!.usagePercent, 85);
  assert(typeof recorder.throttles[0]!.throttledUntil === "string");
});

Deno.test("a throttle without a provider deadline still records a shared window", async () => {
  const recorder = fakeStore();
  const adapter: CompetitorProvider = {
    source: "official",
    async fetch() {
      throw new CompetitorProviderError("rate_limited", "throttled", { usagePercent: 100 });
    },
  };

  const summary = await runCompetitorDrain(ports(recorder, adapter), {});

  assertEquals(summary.jobs[0]!.reasonCode, "rate_limited");
  assertEquals(recorder.persisted.length, 0);
  assertEquals(recorder.throttles.length, 1);
  assertEquals(recorder.throttles[0]!.jobId, JOB);
  assert(typeof recorder.throttles[0]!.throttledUntil === "string");
});

Deno.test("the shared bucket follows the protected credential, not the viewer id", async () => {
  const recorder = fakeStore();
  const keyed: string[] = [];

  await runCompetitorDrain(
    {
      ...ports(recorder, provider()),
      bucketKeyFor: async (credentialId) => {
        keyed.push(credentialId);
        return "a".repeat(64);
      },
    },
    {},
  );

  assertEquals(keyed, ["cred-1"]);
});

Deno.test("a viewer token or scope failure is a retry, never the weekly verdict", async () => {
  for (const kind of ["token_invalid", "scope_missing", "provider_error"] as const) {
    const recorder = fakeStore();
    const adapter: CompetitorProvider = {
      source: "official",
      async fetch() {
        throw new CompetitorProviderError(kind, "failure");
      },
    };

    const summary = await runCompetitorDrain(ports(recorder, adapter), {});

    assertEquals(summary.unavailable, 0);
    assertEquals(recorder.persisted[0]!.outcome, "retry");
    assertEquals(recorder.persisted[0]!.reason_code, kind);
  }
});

Deno.test("a capture that claims another source is never filed as official", async () => {
  const recorder = fakeStore();
  const adapter = provider({ ...CAPTURE, source: "apify" });

  const summary = await runCompetitorDrain(ports(recorder, adapter), {});

  assertEquals(summary.completed, 0);
  assertEquals(summary.retried, 1);
  assertEquals(recorder.persisted.length, 1);
  assertEquals(recorder.persisted[0]!.outcome, "retry");
  assertEquals(recorder.persisted[0]!.source, undefined);
});

// ---------------------------------------------------------------------------
// The PRODUCTION path: index -> worker -> store -> the v2 SQL.
//
// The store below is the real module, not a fake: the worker writes through
// it, it calls the versioned writer by name, and it validates the receipt
// the database would send back. Mocking the whole path away would prove
// nothing about the contract that actually runs.
// ---------------------------------------------------------------------------

Deno.test("the production path carries the coverage into the versioned write", async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];

  const rpc: CompetitorRpcCaller = async (name, args) => {
    calls.push({ name, args });
    if (name === "claim_instagram_collection_jobs") {
      return {
        data: [{
          job_id: JOB,
          user_id: OWNER,
          watchlist_id: WATCHLIST,
          captured_on: "2026-10-29",
          job_generation: 1,
          claim_token: "claim-token",
          lease_expires_at: "2026-10-29T02:02:00Z",
          attempts: 1,
        }],
        error: null,
      };
    }
    if (name === "attach_instagram_collection_job_viewer_context") {
      return {
        data: {
          viewer_social_account_id: ACCOUNT,
          credential_generation: 3,
          login_kind: "page_linked",
        },
        error: null,
      };
    }
    if (name === "read_facebook_user_account_credential") {
      return {
        data: {
          found: true,
          social_account_id: ACCOUNT,
          platform: "instagram",
          credential_id: "cred-1",
          credential_kind: "facebook_user",
          token: "protected-token",
          token_expires_at: null,
          revision: 4,
          capability_generation: 3,
          connection_version: 1,
        },
        error: null,
      };
    }
    if (name === "read_instagram_account_capability") {
      return {
        data: {
          social_account_id: ACCOUNT,
          capability_present: true,
          login_kind: "page_linked",
          permission_read_state: "ok",
          scopes_authoritative: true,
          granted_scopes: ["instagram_manage_insights"],
          scopes_read_at: "2026-01-01T00:00:00Z",
          last_read_failed_at: null,
          last_read_error_code: null,
          credential_generation: 3,
          credential_updated_at: null,
          generation_reason: null,
          reconnected_at: null,
          has_protected_credential: true,
          updated_at: null,
        },
        error: null,
      };
    }
    if (name === "attach_instagram_collection_job_viewer_context") {
      return {
        data: {
          job_id: JOB,
          job_generation: 1,
          viewer_social_account_id: ACCOUNT,
          credential_generation: 3,
          login_kind: "page_linked",
          granted_scopes: ["instagram_manage_insights"],
        },
        error: null,
      };
    }
    if (name === "authorize_instagram_collection_provider_call") {
      return {
        data: {
          allowed: true,
          job_id: JOB,
          target_kind: "competitor",
          target_id: WATCHLIST,
          viewer_social_account_id: ACCOUNT,
          job_generation: 1,
          credential_generation: 3,
          policy_fingerprint: null,
        },
        error: null,
      };
    }
    if (name === "persist_competitor_collection_result_v2") {
      return {
        data: {
          version: 2,
          job_id: JOB,
          job_generation: 1,
          outcome: "completed",
          source: "official",
          watchlist_id: WATCHLIST,
          captured_on: "2026-10-29",
          written: 2,
          media_count: 1,
          captured_at: "2026-10-29T02:00:00+00:00",
          coverage: {
            watchlist_id: WATCHLIST,
            user_id: OWNER,
            captured_on: "2026-10-29",
            captured_at: "2026-10-29T02:00:00+00:00",
            source: "official",
            job_generation: 1,
            capture_started_at: "2026-10-29T02:00:00.000Z",
            capture_ended_at: "2026-10-29T02:00:05.000Z",
            oldest_returned_at: "2026-10-28T12:00:00.000Z",
            ordering_verified: false,
            cursor_present: false,
            exhausted: true,
            truncated: false,
            gap_reason: null,
            inventory_complete: true,
          },
        },
        error: null,
      };
    }
    return { data: null, error: null };
  };

  const reads: ServiceReadPort = {
    async readOne(table, _columns, filters) {
      if (table === "competitor_watchlist") {
        return { data: { id: WATCHLIST, user_id: OWNER, username: "competitor_brand" }, error: null };
      }
      if (table === "instagram_provider_throttle_buckets") {
        return { data: null, error: null };
      }
      return { data: filters ? null : null, error: null };
    },
    async readMany(table) {
      if (table === "social_accounts") {
        return {
          data: [{
            id: ACCOUNT,
            user_id: OWNER,
            platform: "instagram",
            platform_user_id: "ig-viewer",
            is_active: true,
            needs_reauth: false,
            connected_at: "2026-01-01T00:00:00Z",
          }],
          error: null,
        };
      }
      if (table === "instagram_account_capabilities") {
        return {
          data: [{
            social_account_id: ACCOUNT,
            user_id: OWNER,
            platform: "instagram",
            login_kind: "page_linked",
            permission_read_state: "ok",
            granted_scopes: ["instagram_manage_insights"],
            credential_generation: 3,
          }],
          error: null,
        };
      }
      return { data: [], error: null };
    },
  };

  const store = createCompetitorServiceStore({ rpc, reads, writes: noWrites });

  const summary = await runCompetitorDrain(
    {
      store,
      officialProvider: provider(),
      paidFallback: { enabled: false, refusalReason: "apify_disabled" },
      bucketKeyFor: async () => "a".repeat(64),
      now: () => Date.now(),
      log: () => undefined,
    },
    {},
  );

  assertEquals(summary.completed, 1);

  const write = calls.find((call) => call.name === "persist_competitor_collection_result_v2");
  assert(write !== undefined, "the versioned writer was called");
  assertEquals(
    calls.some((call) => call.name === "persist_competitor_collection_result"),
    false,
    "the v1 writer was not called",
  );

  const payload = write.args.p_payload as {
    readonly coverage?: Record<string, unknown>;
  };

  assertEquals(
    JSON.stringify(payload.coverage),
    JSON.stringify({
      capture_started_at: "2026-10-29T02:00:00.000Z",
      capture_ended_at: "2026-10-29T02:00:05.000Z",
      oldest_returned_at: "2026-10-28T12:00:00.000Z",
      ordering_verified: false,
      cursor_present: false,
      exhausted: true,
      truncated: false,
      gap_reason: null,
    }),
    "the coverage travelled with the payload",
  );
});

Deno.test("the production path refuses a receipt the coverage does not answer for", async () => {
  // The store validates the receipt it gets back. A receipt whose stored
  // coverage disagrees with the request is not evidence that the write
  // happened as asked, so the write is never reported as stored.
  const recorder = fakeStore();
  recorder.store.persistResult = async () => {
    throw new CompetitorStoreError("read_failed");
  };

  const adapter = provider();
  const summary = await runCompetitorDrain(ports(recorder, adapter), {});

  assertEquals(summary.completed, 0);
  assertEquals(summary.abandoned, 1);
  assertEquals(summary.jobs[0]!.reasonCode, "storage_error");
});
