/**
 * The HTTP boundary's contract.
 *
 * WHAT THIS SUITE PINS
 *
 *   The request contract, the authorization matrix, the two availability
 *   gates, the response mapping and the bounded audit record.
 *
 * THE MATRIX
 *
 *   A USER mode needs a verified user session. The cron secret and the
 *   service-role key are REFUSED for a user mode, because the owner RPCs
 *   derive the owner from `auth.uid()` and an impersonation would have to
 *   be a different, unsound contract.
 *
 *   A SERVICE mode needs the cron secret, the service-role key or an
 *   administrator. A plain user session is REFUSED.
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

import {
  createCompetitorSyncHandler,
  type CompetitorSyncAuditEvent,
  type CompetitorSyncDeps,
} from "./handler.ts";
import type { CompetitorOwnerStore } from "./store.ts";
import type { CompetitorWorkerPorts } from "./syncWorker.ts";

const OWNER = "aa000000-0000-4000-8000-000000000001";
const WATCHLIST = "c1000000-0000-4000-8000-000000000001";
const USER_TOKEN = "synthetic.owner.bearer";
const CRON_SECRET = "synthetic-cron-secret";
const SERVICE_KEY = "synthetic-service-role-key";

interface Probe {
  readonly audits: CompetitorSyncAuditEvent[];
  readonly ownerCalls: Array<{ name: string; args: Record<string, unknown> }>;
  readonly serviceCalls: Array<{ name: string; args: Record<string, unknown> }>;
  readonly settingReads: string[];
  settings: Record<string, unknown>;
  claims: unknown;
  enqueueReceipt: unknown;
  enqueueFailure: string | null;
  isAdmin: boolean;
  adminLookupFails: boolean;
  configuration: "ready" | "unavailable";
  cronSecret: string | null;
  serviceRoleKey: string | null;
}

function newProbe(): Probe {
  return {
    audits: [],
    ownerCalls: [],
    serviceCalls: [],
    settingReads: [],
    settings: {
      collection_instagram_insights_enabled: { data: { value: true }, error: null },
      credential_facebook_user_mode: { data: { value: "protected" }, error: null },
    },
    claims: { data: { claims: { sub: OWNER, role: "authenticated" } }, error: null },
    enqueueReceipt: {
      data: {
        accepted: true,
        reason: "enqueued",
        job_id: "5c1b0003-0000-4000-8000-000000000003",
        job_generation: 1,
        status: "queued",
        captured_on: "2026-10-29",
        created: true,
        accepted_at: "2026-10-29T02:00:00.123456+00:00",
      },
      error: null,
    },
    enqueueFailure: null,
    isAdmin: false,
    adminLookupFails: false,
    configuration: "ready",
    cronSecret: CRON_SECRET,
    serviceRoleKey: SERVICE_KEY,
  };
}

function buildDeps(probe: Probe): CompetitorSyncDeps {
  const ownerStore: CompetitorOwnerStore = {
    async enqueueCompetitorJob(input) {
      probe.ownerCalls.push({
        name: "enqueue_instagram_collection_job",
        args: { p_target_kind: "competitor", p_target_id: input.watchlistId, p_mode: input.mode },
      });

      if (probe.enqueueFailure === "not_found") {
        throw Object.assign(new Error("x"), { failure: "not_found" });
      }
      if (probe.enqueueFailure === "read_failed") {
        throw Object.assign(new Error("x"), { failure: "read_failed" });
      }

      const receipt = probe.enqueueReceipt as {
        data: {
          accepted: boolean;
          refused?: boolean;
          reason?: string;
          reason_code?: string;
          job_id?: string;
          job_generation?: number;
          status?: string;
          captured_on?: string;
          retry_after_seconds?: number;
        };
        error: unknown;
      };
      const row = receipt.data;

      if (row.refused === true) {
        return {
          kind: "refused",
          projection: {
            accepted: false,
            refused: true,
            reason_code: (row.reason_code ?? "collection_not_eligible") as
              | "collection_not_eligible"
              | "collection_disabled"
              | "settings_unavailable",
            captured_on: row.captured_on ?? "2026-10-29",
          },
        };
      }

      const projection = {
        accepted: row.accepted,
        reason: row.reason ?? "enqueued",
        jobId: row.job_id ?? null,
        jobGeneration: row.job_generation ?? null,
        status: row.status ?? null,
        capturedOn: row.captured_on ?? null,
        retryAfterSeconds: row.retry_after_seconds ?? null,
      };
      return row.accepted
        ? { kind: "accepted", projection }
        : { kind: "throttled", projection };
    },
    async readCompetitorStatus(input) {
      probe.ownerCalls.push({
        name: "read_instagram_collection_job_status",
        args: { p_target_kind: "competitor", p_target_id: input.watchlistId },
      });
      return {
        targetKind: "competitor",
        targetId: input.watchlistId,
        capturedOn: "2026-10-29",
        status: "queued",
        jobGeneration: 1,
        attempts: 0,
        dueAt: null,
        nextRetryAt: null,
        lastAttemptAt: null,
        lastSuccessAt: null,
        reasonCode: null,
        pendingOperations: 0,
      };
    },
  };

  const worker: CompetitorWorkerPorts = {
    store: {
      async listDueTargets() {
        probe.serviceCalls.push({ name: "list_due_competitor_collection_targets", args: {} });
        return [];
      },
      async enqueueDailyPage(input) {
        probe.serviceCalls.push({
          name: "enqueue_instagram_collection_daily_page",
          args: { p_target_kind: "competitor", p_start: input.start },
        });
        return {
          kind: "accepted",
          receipt: {
            targetKind: "competitor",
            capturedOn: "2026-10-29",
            sweepStatus: "completed",
            enqueued: 0,
            hasMore: false,
            pageLimit: 50,
            scanned: 0,
            started: input.start,
            resumed: !input.start,
          },
        };
      },
      async enqueueService() {
        return { accepted: 0, results: [] };
      },
      async claimCompetitorJobs() {
        return [];
      },
      async readWatchlistTarget() {
        return null;
      },
      async listViewerCandidates() {
        return [];
      },
      async resolveViewerCredential() {
        throw new Error("not used");
      },
      async attachViewerContext() {
        throw new Error("not used");
      },
      async authorizeProviderCall() {
        throw new Error("not used");
      },
      async auditAdmissionRefusal() {
        return true;
      },
      async persistResult() {
        throw new Error("not used");
      },
      async recordThrottle() {
        return;
      },
      async readThrottleBucket() {
        return null;
      },
    },
    officialProvider: {
      source: "official",
      async fetch() {
        throw new Error("not used");
      },
    },
    paidFallback: { enabled: false, refusalReason: "apify_disabled" },
    bucketKeyFor: async () => "a".repeat(64),
    now: () => Date.now(),
    log: () => undefined,
  };

  return {
    configuration: () => probe.configuration,
    verifyClaims: async () => probe.claims,
    readSetting: async (key) => {
      probe.settingReads.push(key);
      const row = probe.settings[key];
      return row ?? { data: null, error: null };
    },
    createOwnerStore: () => ownerStore,
    createServiceWorker: () => worker,
    cronSecret: () => probe.cronSecret,
    serviceRoleKey: () => probe.serviceRoleKey,
    isAdmin: async () => {
      if (probe.adminLookupFails) throw new Error("the role lookup failed");
      return probe.isAdmin;
    },
    audit: async (event) => {
      probe.audits.push(event);
    },
  };
}

function post(body: unknown, token?: string): Request {
  return new Request("https://postora.invalid/functions/v1/competitor-snapshot-sync", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

Deno.test("the preflight is answered without an audit record", async () => {
  const probe = newProbe();
  const handler = createCompetitorSyncHandler(buildDeps(probe));

  const response = await handler(
    new Request("https://postora.invalid/x", { method: "OPTIONS" }),
  );

  assertEquals(response.status, 204);
  assertEquals(probe.audits.length, 0);
});

Deno.test("a method other than POST is refused", async () => {
  const probe = newProbe();
  const handler = createCompetitorSyncHandler(buildDeps(probe));

  const response = await handler(new Request("https://postora.invalid/x", { method: "GET" }));

  assertEquals(response.status, 405);
  assertEquals((await response.json()).error, "method_not_allowed");
  assertEquals(probe.audits.length, 1);
});

Deno.test("a request without a bearer is refused", async () => {
  const probe = newProbe();
  const handler = createCompetitorSyncHandler(buildDeps(probe));

  const response = await handler(post({ mode: "entry", watchlist_id: WATCHLIST }));

  assertEquals(response.status, 401);
  assertEquals((await response.json()).error, "unauthorized");
  assertEquals(probe.ownerCalls.length, 0);
});

Deno.test("a user request enqueues and returns a 202 receipt", async () => {
  const probe = newProbe();
  const handler = createCompetitorSyncHandler(buildDeps(probe));

  const response = await handler(
    post({ mode: "entry", watchlist_id: WATCHLIST }, USER_TOKEN),
  );

  assertEquals(response.status, 202);
  const body = await response.json();
  assertEquals(body.accepted, true);
  assertEquals(body.job_id, "5c1b0003-0000-4000-8000-000000000003");
  assertEquals(body.captured_on, "2026-10-29");
  assertEquals(probe.ownerCalls[0]!.name, "enqueue_instagram_collection_job");
  assertEquals(probe.ownerCalls[0]!.args.p_target_kind, "competitor");
  assertEquals(probe.ownerCalls[0]!.args.p_mode, "normal");
});

Deno.test("the force mode reaches the accepted enqueue as a force", async () => {
  const probe = newProbe();
  const handler = createCompetitorSyncHandler(buildDeps(probe));

  const response = await handler(
    post({ mode: "force", watchlist_id: WATCHLIST }, USER_TOKEN),
  );

  assertEquals(response.status, 202);
  assertEquals(probe.ownerCalls[0]!.args.p_mode, "force");
});

Deno.test("the cron secret may not impersonate a user", async () => {
  const probe = newProbe();
  const handler = createCompetitorSyncHandler(buildDeps(probe));

  const response = await handler(post({ mode: "entry", watchlist_id: WATCHLIST }, CRON_SECRET));

  assertEquals(response.status, 403);
  assertEquals((await response.json()).error, "forbidden");
  assertEquals(probe.ownerCalls.length, 0);
});

Deno.test("the service key may not impersonate a user", async () => {
  const probe = newProbe();
  const handler = createCompetitorSyncHandler(buildDeps(probe));

  const response = await handler(post({ mode: "entry", watchlist_id: WATCHLIST }, SERVICE_KEY));

  assertEquals(response.status, 403);
  assertEquals(probe.ownerCalls.length, 0);
});

Deno.test("a plain user may not ask for the scheduled work", async () => {
  const probe = newProbe();
  const handler = createCompetitorSyncHandler(buildDeps(probe));

  const allResponse = await handler(post({ mode: "all" }, USER_TOKEN));
  assertEquals(allResponse.status, 403);

  const dailyResponse = await handler(post({ mode: "enqueue-daily" }, USER_TOKEN));
  assertEquals(dailyResponse.status, 403);

  assertEquals(probe.serviceCalls.length, 0);
});

Deno.test("the cron secret may ask for the scheduled work", async () => {
  const probe = newProbe();
  const handler = createCompetitorSyncHandler(buildDeps(probe));

  const response = await handler(post({ mode: "enqueue-daily" }, CRON_SECRET));

  assertEquals(response.status, 200);
  assertEquals((await response.json()).targets, 0);
});

Deno.test("an administrator may ask for the scheduled work", async () => {
  const probe = newProbe();
  probe.isAdmin = true;
  const handler = createCompetitorSyncHandler(buildDeps(probe));

  const response = await handler(post({ mode: "all" }, USER_TOKEN));

  assertEquals(response.status, 200);
});

Deno.test("an administrator lookup that fails refuses the service path", async () => {
  const probe = newProbe();
  probe.adminLookupFails = true;
  const handler = createCompetitorSyncHandler(buildDeps(probe));

  const response = await handler(post({ mode: "all" }, USER_TOKEN));

  assertEquals(response.status, 403);
});

Deno.test("a service call with no configured service credential is unavailable", async () => {
  const probe = newProbe();
  probe.cronSecret = null;
  probe.serviceRoleKey = null;
  const handler = createCompetitorSyncHandler(buildDeps(probe));

  const response = await handler(post({ mode: "all" }, USER_TOKEN));

  assertEquals(response.status, 503);
  assertEquals((await response.json()).error, "service_auth_unavailable");
});

Deno.test("collection that is off refuses before any schema, RPC or provider access", async () => {
  const probe = newProbe();
  probe.settings.collection_instagram_insights_enabled = { data: { value: false }, error: null };
  const handler = createCompetitorSyncHandler(buildDeps(probe));

  const response = await handler(
    post({ mode: "entry", watchlist_id: WATCHLIST }, USER_TOKEN),
  );

  assertEquals(response.status, 503);
  assertEquals((await response.json()).error, "collection_disabled");
  assertEquals(probe.ownerCalls.length, 0);
  assertEquals(probe.settingReads.length, 1);
});

Deno.test("an absent collection setting is off", async () => {
  const probe = newProbe();
  probe.settings.collection_instagram_insights_enabled = { data: null, error: null };
  const handler = createCompetitorSyncHandler(buildDeps(probe));

  const response = await handler(
    post({ mode: "entry", watchlist_id: WATCHLIST }, USER_TOKEN),
  );

  assertEquals(response.status, 503);
  assertEquals((await response.json()).error, "collection_disabled");
});

Deno.test("a malformed collection setting is unavailable and never off", async () => {
  const probe = newProbe();
  probe.settings.collection_instagram_insights_enabled = { data: { value: "maybe" }, error: null };
  const handler = createCompetitorSyncHandler(buildDeps(probe));

  const response = await handler(
    post({ mode: "entry", watchlist_id: WATCHLIST }, USER_TOKEN),
  );

  assertEquals(response.status, 503);
  assertEquals((await response.json()).error, "settings_unavailable");
});

Deno.test("a failed collection setting read is unavailable", async () => {
  const probe = newProbe();
  probe.settings.collection_instagram_insights_enabled = { data: null, error: { code: "42501" } };
  const handler = createCompetitorSyncHandler(buildDeps(probe));

  const response = await handler(
    post({ mode: "entry", watchlist_id: WATCHLIST }, USER_TOKEN),
  );

  assertEquals(response.status, 503);
  assertEquals((await response.json()).error, "settings_unavailable");
  assertEquals(probe.ownerCalls.length, 0);
});

Deno.test("a legacy credential mode is not a refusal: the rollout policy is the gate", async () => {
  const probe = newProbe();
  probe.settings.credential_facebook_user_mode = { data: { value: "legacy" }, error: null };
  const handler = createCompetitorSyncHandler(buildDeps(probe));

  const response = await handler(
    post({ mode: "entry", watchlist_id: WATCHLIST }, USER_TOKEN),
  );

  // The global mode says WHERE a Facebook User secret is read from. It is
  // still read and still validated, but it is not collection permission:
  // the accepted SQL decides which watchlist entry may be collected for.
  assertEquals(response.status, 202);
  assertEquals(probe.ownerCalls.length, 1);
  assertEquals(probe.settingReads.length, 2);
});

Deno.test("a malformed credential mode is unavailable and never off", async () => {
  const probe = newProbe();
  probe.settings.credential_facebook_user_mode = { data: { value: "maybe" }, error: null };
  const handler = createCompetitorSyncHandler(buildDeps(probe));

  const response = await handler(
    post({ mode: "entry", watchlist_id: WATCHLIST }, USER_TOKEN),
  );

  assertEquals(response.status, 503);
  assertEquals((await response.json()).error, "settings_unavailable");
  assertEquals(probe.ownerCalls.length, 0);
});

Deno.test("a rollout refusal is a 403 and never an enqueue", async () => {
  const probe = newProbe();
  probe.enqueueReceipt = {
    data: {
      accepted: false,
      refused: true,
      reason_code: "collection_not_eligible",
      captured_on: "2026-10-29",
    },
    error: null,
  };
  const handler = createCompetitorSyncHandler(buildDeps(probe));

  const response = await handler(
    post({ mode: "entry", watchlist_id: WATCHLIST }, USER_TOKEN),
  );

  // The watchlist entry IS owned by the caller. The policy simply does not
  // admit it yet, so the answer is one 403.
  assertEquals(response.status, 403);
  assertEquals((await response.json()).error, "collection_not_eligible");
});

Deno.test("an unavailable rollout configuration is a 503 and never a refusal", async () => {
  const probe = newProbe();
  probe.enqueueReceipt = {
    data: {
      accepted: false,
      refused: true,
      reason_code: "settings_unavailable",
      captured_on: "2026-10-29",
    },
    error: null,
  };
  const handler = createCompetitorSyncHandler(buildDeps(probe));

  const response = await handler(
    post({ mode: "entry", watchlist_id: WATCHLIST }, USER_TOKEN),
  );

  assertEquals(response.status, 503);
  assertEquals((await response.json()).error, "settings_unavailable");
});

Deno.test("a malformed request is refused", async () => {
  const probe = newProbe();
  const handler = createCompetitorSyncHandler(buildDeps(probe));

  for (const body of [
    { mode: "unknown", watchlist_id: WATCHLIST },
    { mode: "entry" },
    { mode: "entry", watchlist_id: "not-a-uuid" },
    { mode: "entry", watchlist_id: WATCHLIST, user_id: OWNER },
    { mode: "entry", watchlist_id: WATCHLIST, access_token: "leaked" },
    { mode: "enqueue-daily", limit: 500 },
    { mode: "enqueue-daily", cursor: { due_at: "x" } },
  ]) {
    const response = await handler(post(body, USER_TOKEN));
    assertEquals(response.status, 400, JSON.stringify(body));
    assertEquals((await response.json()).error, "invalid_request");
  }

  assertEquals(probe.ownerCalls.length, 0);
});

Deno.test("a body that is not JSON is refused", async () => {
  const probe = newProbe();
  const handler = createCompetitorSyncHandler(buildDeps(probe));

  const response = await handler(
    new Request("https://postora.invalid/x", {
      method: "POST",
      headers: { authorization: `Bearer ${USER_TOKEN}`, "content-type": "application/json" },
      body: "not json",
    }),
  );

  assertEquals(response.status, 400);
});

Deno.test("an oversized body is refused", async () => {
  const probe = newProbe();
  const handler = createCompetitorSyncHandler(buildDeps(probe));

  const response = await handler(
    new Request("https://postora.invalid/x", {
      method: "POST",
      headers: { authorization: `Bearer ${USER_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ mode: "entry", watchlist_id: WATCHLIST, padding: "x".repeat(8_192) }),
    }),
  );

  assertEquals(response.status, 413);
});

Deno.test("a throttled enqueue is a 429 with a retry hint", async () => {
  const probe = newProbe();
  probe.enqueueReceipt = {
    data: {
      accepted: false,
      reason: "throttled",
      retry_after_seconds: 421,
      captured_on: "2026-10-29",
    },
    error: null,
  };
  const handler = createCompetitorSyncHandler(buildDeps(probe));

  const response = await handler(
    post({ mode: "entry", watchlist_id: WATCHLIST }, USER_TOKEN),
  );

  assertEquals(response.status, 429);
  assertEquals(response.headers.get("Retry-After"), "421");
  const body = await response.json();
  assertEquals(body.accepted, false);
  assertEquals(body.retry_after_seconds, 421);
});

Deno.test("an unknown target is a 404", async () => {
  const probe = newProbe();
  probe.enqueueFailure = "not_found";
  const handler = createCompetitorSyncHandler(buildDeps(probe));

  const response = await handler(
    post({ mode: "entry", watchlist_id: WATCHLIST }, USER_TOKEN),
  );

  assertEquals(response.status, 404);
  assertEquals((await response.json()).error, "not_found");
});

Deno.test("an indeterminate enqueue is never reported as a success", async () => {
  const probe = newProbe();
  probe.enqueueFailure = "read_failed";
  const handler = createCompetitorSyncHandler(buildDeps(probe));

  const response = await handler(
    post({ mode: "entry", watchlist_id: WATCHLIST }, USER_TOKEN),
  );

  assertEquals(response.status, 503);
  assertEquals((await response.json()).error, "enqueue_indeterminate");
});

Deno.test("the status mode reads the owner projection", async () => {
  const probe = newProbe();
  const handler = createCompetitorSyncHandler(buildDeps(probe));

  const response = await handler(
    post({ mode: "status", watchlist_id: WATCHLIST }, USER_TOKEN),
  );

  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.target_kind, "competitor");
  assertEquals(body.status, "queued");
  assertEquals(probe.ownerCalls[0]!.name, "read_instagram_collection_job_status");
});

Deno.test("every terminal path writes one bounded audit attempt", async () => {
  const probe = newProbe();
  const handler = createCompetitorSyncHandler(buildDeps(probe));

  await handler(post({ mode: "entry", watchlist_id: WATCHLIST }, USER_TOKEN));
  await handler(post({ mode: "entry", watchlist_id: WATCHLIST }, CRON_SECRET));

  assertEquals(probe.audits.length, 2);
  assertEquals(probe.audits[0]!.action, "entry");
  assertEquals(probe.audits[0]!.status, 202);
  assertEquals(probe.audits[0]!.userId, OWNER);
  assertEquals(probe.audits[0]!.watchlistId, WATCHLIST);
  assertEquals(probe.audits[1]!.status, 403);
  assert(JSON.stringify(probe.audits).includes(USER_TOKEN) === false);
});

Deno.test("a verified service_role claims object is never upgraded into an admin session", async () => {
  const probe = newProbe();
  probe.claims = { data: { claims: { sub: OWNER, role: "service_role" } }, error: null };
  probe.isAdmin = true;
  const handler = createCompetitorSyncHandler(buildDeps(probe));

  const response = await handler(post({ mode: "all" }, USER_TOKEN));

  assertEquals(response.status, 403);
  assertEquals(probe.serviceCalls.length, 0);
});

Deno.test("an administrator answer that is not exactly true refuses the service path", async () => {
  const probe = newProbe();
  const deps = buildDeps(probe);
  const handler = createCompetitorSyncHandler({
    ...deps,
    isAdmin: async () => "yes" as unknown as boolean,
  });

  const response = await handler(post({ mode: "all" }, USER_TOKEN));

  assertEquals(response.status, 403);
  assertEquals(probe.serviceCalls.length, 0);
});

Deno.test("an unknown mode is audited as a closed literal, never as request text", async () => {
  const probe = newProbe();
  const handler = createCompetitorSyncHandler(buildDeps(probe));
  const marker = "attacker-controlled-action-text";

  const response = await handler(post({ mode: marker }, USER_TOKEN));

  assertEquals(response.status, 400);
  assertEquals(probe.audits.length, 1);
  assertEquals(probe.audits[0]!.action, "unknown");
  assertEquals(JSON.stringify(probe.audits).includes(marker), false);
});

Deno.test("the drain gets the request's work budget, not the five second dependency ceiling", async () => {
  const probe = newProbe();
  const deps = buildDeps(probe);
  const handler = createCompetitorSyncHandler({
    ...deps,
    createServiceWorker: () => {
      const worker = deps.createServiceWorker();
      return {
        ...worker,
        store: {
          ...worker.store,
          // A claim slower than the dependency ceiling but well inside the
          // worker budget. Under a five second ceiling the run would be cut
          // off and reported indeterminate; a drain that only ever had five
          // seconds could never start a provider call (it needs thirteen).
          claimCompetitorJobs: () =>
            new Promise((resolve) => setTimeout(() => resolve([]), 5_500)),
        },
      };
    },
  });

  const response = await handler(post({ mode: "all" }, CRON_SECRET));

  assertEquals(response.status, 200);
  const payload = await response.json();
  assertEquals(payload.claimed, 0);
  // A run that had too little budget refuses to claim and reports stopping
  // early; a run with the real budget finishes the (empty) claim normally.
  assertEquals(payload.stoppedEarly, false);
});

// ---------------------------------------------------------------------------
// The durable daily branch
// ---------------------------------------------------------------------------

Deno.test("the durable branch is a distinct schema branch", async () => {
  const probe = newProbe();
  const handler = createCompetitorSyncHandler(buildDeps(probe));

  // The durable marker with a cursor, with a limit, or with a viewer is a
  // malformed request, not a silently ignored field.
  for (
    const body of [
      { mode: "enqueue-daily", dispatch: "durable", cursor: { due_at: "2026-10-29T00:00:00Z", id: WATCHLIST } },
      { mode: "enqueue-daily", dispatch: "durable", limit: 10 },
      { mode: "enqueue-daily", dispatch: "durable", watchlist_id: WATCHLIST },
      { mode: "enqueue-daily", dispatch: "cursor" },
      { mode: "enqueue-daily", dispatch: true },
    ]
  ) {
    const response = await handler(post(body, CRON_SECRET));
    assertEquals(response.status, 400, JSON.stringify(body));
  }

  assertEquals(
    probe.serviceCalls.some((entry) =>
      entry.name === "enqueue_instagram_collection_daily_page"
    ),
    false,
  );
});

Deno.test("the durable branch starts the day and answers with its exact counters", async () => {
  const probe = newProbe();
  const handler = createCompetitorSyncHandler(buildDeps(probe));

  const response = await handler(
    post({ mode: "enqueue-daily", dispatch: "durable" }, CRON_SECRET),
  );

  assertEquals(response.status, 200);
  assertEquals(await response.json(), {
    mode: "enqueue-daily",
    dispatch: "durable",
    captured_on: "2026-10-29",
    sweep_status: "completed",
    enqueued: 0,
    has_more: false,
  });

  const call = probe.serviceCalls.find((entry) =>
    entry.name === "enqueue_instagram_collection_daily_page"
  );
  assert(call !== undefined, "the durable page was called");
  assertEquals(call.args.p_target_kind, "competitor");
  assertEquals(call.args.p_start, true);
});

Deno.test("the durable branch never walks the legacy due list", async () => {
  const probe = newProbe();
  const handler = createCompetitorSyncHandler(buildDeps(probe));

  await handler(post({ mode: "enqueue-daily", dispatch: "durable" }, CRON_SECRET));

  assertEquals(
    probe.serviceCalls.some((entry) =>
      entry.name === "list_due_competitor_collection_targets"
    ),
    false,
    "the durable branch never reads the cursor-paged due list",
  );
});

Deno.test("the legacy branch keeps its cursor and its limit", async () => {
  const probe = newProbe();
  const handler = createCompetitorSyncHandler(buildDeps(probe));

  const response = await handler(
    post({ mode: "enqueue-daily", limit: 25 }, CRON_SECRET),
  );

  assertEquals(response.status, 200);
  const call = probe.serviceCalls.find((entry) =>
    entry.name === "list_due_competitor_collection_targets"
  );
  assert(call !== undefined, "the legacy due read was called");
  assertEquals(
    probe.serviceCalls.some((entry) =>
      entry.name === "enqueue_instagram_collection_daily_page"
    ),
    false,
    "the legacy branch never reaches the durable statement",
  );
});

Deno.test("a plain user is refused for the durable branch", async () => {
  const probe = newProbe();
  const handler = createCompetitorSyncHandler(buildDeps(probe));

  const response = await handler(
    post({ mode: "enqueue-daily", dispatch: "durable" }, USER_TOKEN),
  );

  assertEquals(response.status, 403);
  assertEquals((await response.json()).error, "forbidden");
  assertEquals(
    probe.serviceCalls.some((entry) =>
      entry.name === "enqueue_instagram_collection_daily_page"
    ),
    false,
  );
});

Deno.test("a disabled collection refuses the durable branch before the statement", async () => {
  const probe = newProbe();
  probe.settings.collection_instagram_insights_enabled = { data: null, error: null };
  const handler = createCompetitorSyncHandler(buildDeps(probe));

  const response = await handler(
    post({ mode: "enqueue-daily", dispatch: "durable" }, CRON_SECRET),
  );

  assertEquals(response.status, 503);
  assertEquals((await response.json()).error, "collection_disabled");
  assertEquals(
    probe.serviceCalls.some((entry) =>
      entry.name === "enqueue_instagram_collection_daily_page"
    ),
    false,
  );
});

Deno.test("a durable page that does not answer is indeterminate, never a completion", async () => {
  const probe = newProbe();
  const handler = createCompetitorSyncHandler({
    ...buildDeps(probe),
    createServiceWorker: () => ({
      ...buildDeps(probe).createServiceWorker(),
      store: {
        ...buildDeps(probe).createServiceWorker().store,
        async enqueueDailyPage() {
          throw new Error("the statement did not answer");
        },
      },
    }),
  });

  const response = await handler(
    post({ mode: "enqueue-daily", dispatch: "durable" }, CRON_SECRET),
  );

  assertEquals(response.status, 503);
  assertEquals((await response.json()).error, "work_indeterminate");
});