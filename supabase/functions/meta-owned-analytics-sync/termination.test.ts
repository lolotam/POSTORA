import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createOwnedAnalyticsSyncHandler, type OwnedAnalyticsAudit } from "./handler.ts";
import type { AnalyticsRpc, OwnedAnalyticsPlatform } from "./store.ts";
import { AnalyticsWorkerDeadline, AnalyticsWorkerStopped } from "./deadline.ts";

const ACCOUNT = "d3000000-0000-4000-8000-000000000001";
const OWNER = "d1000000-0000-4000-8000-000000000001";
const JOB = "d2000000-0000-4000-8000-000000000001";
const CAPTURE = "d5000000-0000-4000-8000-000000000001";
const STAMP = "2026-11-01T10:00:00.000Z";
type Action = "admit" | "enqueue-daily" | "drain" | "retention";
type Stop = { boundary: string; occurrence?: number; mode: "caller_abort" | "timeout"; allPlatforms?: boolean };

/** Only external database/network/clock boundaries are controlled. */
function fixture(platform: OwnedAnalyticsPlatform, action: Action, stop: Stop) {
  const controller = new AbortController();
  const family = platform === "facebook" ? "fb" : "threads";
  const subject = platform === "facebook" ? "772001" : "773001";
  const postId = platform === "facebook" ? "772001_9001" : "7739001";
  const authority = platform === "facebook" ? { platform_user_id: subject, connection_version: 1,
    credential_id: "d6000000-0000-4000-8000-000000000001", credential_revision: 1, provider_user_id: "771001", token_expires_at: null }
    : { platform_user_id: subject, credential_generation: 1, token_expires_at: null };
  const job = { platform, job_id: JOB, user_id: OWNER, account_id: ACCOUNT, job_generation: 1, authority,
    claim_token: "d4000000-0000-4000-8000-000000000001", lease_until: "2026-11-01T23:00:00Z",
    due_on: "2026-11-01", due_at: "2026-11-01T07:00:00Z", next_due_at: "2026-11-02T08:00:00Z" };
  const events: string[] = [];
  const audits: OwnedAnalyticsAudit[] = [];
  const occurrences = new Map<string, number>();
  let release: (() => void) | undefined;
  let blockedSignal: AbortSignal | undefined;
  let stopIndex = -1, claimed = false, pageCommitted = false, dispatchCommitted = false;
  const pause = <T>(boundary: string, reply: T, signal: AbortSignal): Promise<T> => {
    events.push(boundary);
    const occurrence = (occurrences.get(boundary) ?? 0) + 1;
    occurrences.set(boundary, occurrence);
    if (boundary !== stop.boundary || occurrence !== (stop.occurrence ?? 1)) return Promise.resolve(reply);
    stopIndex = events.length;
    blockedSignal = signal;
    if (stop.mode === "caller_abort") queueMicrotask(() => controller.abort());
    // The dependency ignores cancellation and can acknowledge a write late.
    return new Promise<T>((resolve) => { release = () => resolve(reply); });
  };
  const rpc: AnalyticsRpc = (name, args, signal) => {
    let data: unknown;
    if (name === "next_meta_analytics_dispatch_target") data = args.p_platform !== platform ? { state: "disabled" } : action !== "enqueue-daily" || !args.p_start ? { state: "not_started" }
      : { state: "target", served_at: STAMP, ticket: { platform, due_on: "2026-11-01", policy_digest: "d".repeat(64), round: 1, after_account_id: null, account_id: ACCOUNT } };
    else if (name === "commit_meta_analytics_dispatch_target") {
      data = dispatchCommitted ? { state: "advanced", outcome: "queued", complete: true, refused_count: 0 } : { state: "needs_admission" };
      dispatchCommitted = true;
    } else if (name.endsWith("_analytics_admission_credential")) data = { account_id: ACCOUNT, user_id: OWNER, authority, access_token: "fixture-op", permission_token: "fixture-grant" };
    else if (name.endsWith("_analytics_permissions")) data = { account_id: ACCOUNT, authority, state: "verified" };
    else if (name === "claim_meta_analytics_collection_job") { data = claimed ? null : job; claimed = true; }
    else if (name.endsWith("_analytics_collection_credential")) data = { job_id: JOB, job_generation: 1, authority, access_token: "fixture-op" };
    else if (name.endsWith("_analytics_worker_state")) data = { checkpoint: { cursor: null, post_ids: pageCommitted ? [postId] : [], pages_fetched: pageCommitted ? 1 : 0,
      inventory_complete: pageCommitted, inventory_truncated: false }, operations: ["account_day:2026-10-31", "account_day:2026-10-30", ...(platform === "threads" ? ["profile"] : [])]
        .map((key) => ({ operation_key: key, kind: key === "profile" ? "profile" : "account_day", state: "success", reason: null, last_requested_at: null })) };
    else if (name === `reserve_${family}_analytics_inventory_page`) data = { request_id: CAPTURE, cursor: null, pages_fetched: 0 };
    else if (name === `commit_${family}_analytics_inventory_page`) {
      data = { job_id: JOB, job_generation: 1, pages_fetched: 1, inventory_complete: true, inventory_truncated: false };
      pageCommitted = true;
    } else if (name === `reserve_${family}_analytics_capture`) data = { capture_id: CAPTURE, capture_sequence: 1, job_id: JOB, job_generation: 1,
      kind: "post", subject_id: postId, metric_date: null, since: null, until: null, timezone: null };
    else if (name === `persist_${family}_analytics_capture`) data = { job_id: JOB, job_generation: 1, capture_id: CAPTURE, written: 1, report_revision: 1 };
    else if (name === `complete_${family}_analytics_collection_job`) data = { job_id: JOB, job_generation: 1, state: args.p_outcome,
      on_time: false, due_at: job.due_at, next_due_at: job.next_due_at };
    else if (name === "read_meta_analytics_provider_throttle") data = null;
    else if (name === "record_instagram_provider_throttle_http") data = { bucket_key: args.p_bucket_key, usage_percent: args.p_usage_percent, throttled_until: args.p_throttled_until, job_id: null };
    else if (name === "list_meta_analytics_retention_targets") data = { state: "enabled", targets: [{ account_id: ACCOUNT, last_visited_at: null }] };
    else if (name === "cleanup_meta_analytics_target") data = { deleted: 1, visible_deleted: 1, dry_run: args.p_dry_run, skipped: false, report_revision: 1, floor: args.p_floor };
    else throw new Error(`Unexpected fixture RPC ${name}`);
    return pause(name, { data, error: null }, signal);
  };
  const route = createOwnedAnalyticsSyncHandler({ authorize: () => ({ ok: true }), app: () => ({ id: "770001", secret: "fixture-app" }), rpc,
    audit: async (event, signal) => { audits.push(event); return await pause("audit", true, signal); },
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      const kind = url.pathname.endsWith("/debug_token") ? "debugger" : url.pathname.endsWith("/me") ? "identity"
        : url.pathname.endsWith("/posts") || url.pathname.endsWith("/threads") ? "inventory" : url.pathname.endsWith("/insights") ? "metrics" : "post";
      const payload = kind === "debugger" ? { data: { is_valid: true, user_id: platform === "facebook" ? "771001" : subject, app_id: "770001",
        scopes: platform === "facebook" ? ["read_insights", "pages_read_engagement"] : ["threads_basic", "threads_manage_insights"] } }
        : kind === "identity" ? { id: subject } : kind === "inventory" ? { data: [{ id: postId, created_time: STAMP, timestamp: STAMP }] }
        : kind === "post" ? { id: postId, created_time: STAMP, timestamp: STAMP }
        : { data: (platform === "facebook" ? [url.searchParams.get("metric")!] : ["views", "likes", "replies", "reposts", "quotes", "shares"])
          .map((name) => ({ name, period: "lifetime", values: [{ value: 0 }] })) };
      const response = Response.json(payload, { headers: { "facebook-api-version": "v25.0", "x-app-usage": '{"call_count":1}' } });
      if (stop.boundary === `${kind}_body`) {
        let cancelled = false;
        const body = new ReadableStream<Uint8Array>({ start: (stream) => { void pause(`${kind}_body`, null, request.signal).then(() => { if (!cancelled) stream.close(); }); },
          cancel: () => { cancelled = true; return new Promise(() => undefined); } });
        return new Response(body, { headers: response.headers });
      }
      return await pause(kind, response, request.signal);
    } });
  const body = { action, platform: stop.allPlatforms ? "all" : platform, ...(action === "admit" ? { accountId: ACCOUNT } : action === "retention" ? { dryRun: false } : {}) };
  return { run: () => route(new Request("https://analytics.invalid", { method: "POST", signal: controller.signal, body: JSON.stringify(body) })),
    events, audits, get stopped() { return stopIndex >= 0; }, get signal() { return blockedSignal; }, get stopIndex() { return stopIndex; },
    release: () => release?.() };
}

const dependencies: { action: Action; name: string; occurrence?: number; allPlatforms?: boolean }[] = [
  { action: "admit", name: "read_FAMILY_analytics_admission_credential" },
  { action: "admit", name: "read_FAMILY_analytics_admission_credential", occurrence: 2 },
  { action: "admit", name: "read_FAMILY_analytics_admission_credential", occurrence: 3 },
  { action: "admit", name: "observe_FAMILY_analytics_permissions" },
  { action: "enqueue-daily", name: "next_meta_analytics_dispatch_target" },
  { action: "enqueue-daily", name: "next_meta_analytics_dispatch_target", allPlatforms: true },
  { action: "enqueue-daily", name: "next_meta_analytics_dispatch_target", occurrence: 3, allPlatforms: true },
  { action: "enqueue-daily", name: "commit_meta_analytics_dispatch_target" },
  { action: "enqueue-daily", name: "commit_meta_analytics_dispatch_target", occurrence: 2 },
  { action: "drain", name: "next_meta_analytics_dispatch_target" },
  { action: "drain", name: "claim_meta_analytics_collection_job" },
  { action: "drain", name: "read_FAMILY_analytics_collection_credential" },
  { action: "drain", name: "read_FAMILY_analytics_collection_credential", occurrence: 2 },
  { action: "drain", name: "read_FAMILY_analytics_worker_state" },
  { action: "drain", name: "read_FAMILY_analytics_worker_state", occurrence: 2 },
  { action: "drain", name: "reserve_FAMILY_analytics_inventory_page" },
  { action: "drain", name: "commit_FAMILY_analytics_inventory_page" },
  { action: "drain", name: "reserve_FAMILY_analytics_capture" },
  { action: "drain", name: "persist_FAMILY_analytics_capture" },
  { action: "drain", name: "complete_FAMILY_analytics_collection_job" },
  { action: "drain", name: "read_meta_analytics_provider_throttle" },
  { action: "drain", name: "record_instagram_provider_throttle_http" },
  { action: "retention", name: "list_meta_analytics_retention_targets" },
  { action: "retention", name: "cleanup_meta_analytics_target" },
];

Deno.test("all real action paths acknowledge their own work before testing unknown outcomes", async (test) => {
  for (const platform of ["facebook", "threads"] as const) for (const action of ["admit", "enqueue-daily", "drain", "retention"] as const) {
    await test.step(`${platform} ${action}`, async () => {
      const scenario = fixture(platform, action, { boundary: "none", mode: "caller_abort" });
      const response = await scenario.run();
      const receipt = await response.json();
      assertEquals(response.status, 200, JSON.stringify({ receipt, events: scenario.events }));
      assertEquals(receipt.status, "complete");
      if (action === "drain") assertEquals(receipt.counts.collected, 1);
      if (action === "enqueue-daily") assertEquals(receipt.counts.queued, 1);
      if (action === "retention") assertEquals(receipt.counts.deleted, 1);
      assertEquals(scenario.audits.length, 1);
    });
  }
});

Deno.test("every worker database dependency bounds ignored cancellation and cannot resume a late acknowledgement", async (test) => {
  for (const platform of ["facebook", "threads"] as const) for (const dependency of dependencies) for (const mode of ["caller_abort", "timeout"] as const) {
    const boundary = dependency.name.replace("FAMILY", platform === "facebook" ? "fb" : "threads");
    await test.step(`${platform} ${dependency.action}${dependency.allPlatforms ? "/all" : ""} ${boundary} #${dependency.occurrence ?? 1} ${mode}`, async () => {
      const scenario = fixture(platform, dependency.action, { boundary, occurrence: dependency.occurrence, mode, allPlatforms: dependency.allPlatforms });
      const started = performance.now();
      const response = await scenario.run();
      const receipt = await response.json();
      assert(scenario.stopped, "The actual production path must reach the stalled dependency");
      assertEquals(response.status, 503, JSON.stringify(receipt));
      assertEquals(receipt.reason, "deadline");
      assertEquals(receipt.auditStored, true);
      assertEquals(scenario.audits.length, 1);
      assertEquals(scenario.signal?.aborted, true);
      assert(performance.now() - started < 8_000, "A noncooperative dependency must not consume the 40-second invocation");
      assertEquals(scenario.events.slice(scenario.stopIndex), ["audit"]);
      if (receipt.counts) assertEquals(receipt.counts.queued ?? receipt.counts.collected ?? receipt.counts.deleted, 0);
      scenario.release();
      await new Promise((resolve) => setTimeout(resolve, 0));
      assertEquals(scenario.events.slice(scenario.stopIndex), ["audit"]);
    });
  }
});

Deno.test("permission HTTP and body stalls cannot become a committed grant or refusal", async (test) => {
  for (const platform of ["facebook", "threads"] as const) for (const boundary of ["debugger", "debugger_body", "identity", "identity_body"]) {
    await test.step(`${platform} ${boundary}`, async () => {
      const scenario = fixture(platform, "admit", { boundary, mode: "timeout" });
      const started = performance.now();
      const response = await scenario.run();
      const receipt = await response.json();
      assert(scenario.stopped);
      assertEquals(response.status, 503, JSON.stringify(receipt));
      assertEquals(receipt.reason, "provider_unavailable");
      assertEquals(scenario.audits.length, 1);
      assert(performance.now() - started < 7_000);
      assertEquals(scenario.events.slice(scenario.stopIndex), ["audit"]);
      scenario.release();
      await new Promise((resolve) => setTimeout(resolve, 0));
      assertEquals(scenario.events.slice(scenario.stopIndex), ["audit"]);
    });
  }
});

Deno.test("a noncooperative final audit is bounded and cannot yield a success receipt", async () => {
  const scenario = fixture("threads", "retention", { boundary: "audit", mode: "timeout" });
  const started = performance.now();
  const response = await scenario.run();
  const receipt = await response.json();
  assert(scenario.stopped);
  assertEquals(response.status, 503);
  assertEquals(receipt.reason, "audit_unavailable");
  assertEquals(receipt.auditStored, false);
  assertEquals(scenario.audits.length, 1);
  assert(performance.now() - started < 8_000);
  scenario.release();
});

Deno.test("stalled or oversized request bodies stop before any account operation and retain a refusal audit", async (test) => {
  for (const mode of ["caller_abort", "timeout", "oversize"] as const) {
    await test.step(mode, async () => {
      const controller = new AbortController();
      let cancelled = false, dependencies = 0, audits = 0;
      const body = new ReadableStream<Uint8Array>({ start: (stream) => {
        if (mode === "oversize") stream.enqueue(new Uint8Array(8193));
      }, cancel: () => { cancelled = true; return new Promise(() => undefined); } });
      const route = createOwnedAnalyticsSyncHandler({ authorize: () => ({ ok: true }),
        app: () => { dependencies++; throw new Error("Unparsed input cannot access app credentials"); },
        rpc: () => { dependencies++; throw new Error("Unparsed input cannot access account state"); },
        audit: async (_event, signal) => { signal.throwIfAborted(); audits++; return true; } });
      const started = performance.now();
      const responsePromise = route(new Request("https://analytics.invalid", { method: "POST", body, signal: controller.signal }));
      if (mode === "caller_abort") setTimeout(() => controller.abort(), 0);
      const response = await responsePromise;
      const receipt = await response.json();
      assertEquals(response.status, mode === "oversize" ? 400 : 503);
      assertEquals(receipt.auditStored, true);
      assertEquals(cancelled, true);
      assertEquals(dependencies, 0);
      assertEquals(audits, 1);
      assert(performance.now() - started < 8_000);
    });
  }
});

Deno.test("the final-write reserve shortens a dependency ceiling and refuses new work after exhaustion", async (test) => {
  for (const elapsed of [34_000, 35_001, 40_001]) {
    await test.step(`${elapsed}ms consumed`, async () => {
      const deadline = new AnalyticsWorkerDeadline(Date.now() - elapsed, new AbortController().signal);
      let called = false, signal: AbortSignal | undefined, refusal: unknown;
      const started = performance.now();
      try { await deadline.run((active) => { called = true; signal = active; return new Promise(() => undefined); }); }
      catch (error) { refusal = error; }
      assert(refusal instanceof AnalyticsWorkerStopped);
      assertEquals(refusal.reason, "deadline");
      assertEquals(called, elapsed === 34_000);
      if (called) assertEquals(signal?.aborted, true);
      assert(performance.now() - started < 3_000);
    });
  }
});
