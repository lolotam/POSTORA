import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createOwnedAnalyticsSyncHandler } from "./handler.ts";

const owner = "e6100000-0000-4000-8000-000000000001";
const account = (index: number) => `e6200000-0000-4000-8000-${String(index).padStart(12, "0")}`;
const stamp = "2026-11-15T12:00:00.000Z";
const request = (platform: "facebook" | "all" = "all") => new Request("https://analytics.invalid", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "drain", platform }),
});

Deno.test("registered drain resumes a non-first Facebook page, caps five admissions, and still claims measurement work", async () => {
  let position = 55;
  let claims = 0;
  const started = Date.now();
  let now = started;
  const realNow = Date.now;
  Date.now = () => now;
  try {
    const handler = createOwnedAnalyticsSyncHandler({ authorize: () => ({ ok: true }), audit: async () => true,
      app: () => { throw new Error("Current permission proof needs no provider call"); },
      rpc: async (name, args) => {
        if (name === "next_meta_analytics_dispatch_target") {
          assertEquals(args.p_start, false, "A drain must never start or reopen a round");
          return { data: args.p_platform === "threads" ? { state: "not_started" } : {
            state: "target", served_at: stamp, ticket: { platform: "facebook", owner_id: owner,
              due_on: "2026-11-15", policy_digest: "a".repeat(64), round: 1,
              after_account_id: account(position - 1), account_id: account(position) },
          }, error: null };
        }
        if (name === "commit_meta_analytics_dispatch_target") {
          position++;
          now += 2_000;
          return { data: { state: "advanced", outcome: "queued", complete: false, refused_count: 1100 }, error: null };
        }
        assertEquals(name, "claim_meta_analytics_collection_job");
        assertEquals(args.p_platform, "all", "Threads participates in the existing fair claim path");
        assert(started + 40_000 - now >= 25_000, "Resume preserves the measurement budget");
        claims++;
        return { data: null, error: null };
      } });
    const response = await handler(request());
    const receipt = await response.json();
    assertEquals(response.status, 200);
    assertEquals(position, 60);
    assertEquals(claims, 1);
    assertEquals(receipt.resume.counts, { visited: 5, queued: 5, refused: 0 });
    assertEquals(receipt.resume.status, "partial");
  } finally { Date.now = realNow; }
});

Deno.test("ordinary drains leave absent and completed Facebook rounds alone", async (test) => {
  for (const state of ["not_started", "complete", "disabled"] as const) {
    await test.step(state, async () => {
      let writes = 0;
      const handler = createOwnedAnalyticsSyncHandler({ authorize: () => ({ ok: true }), audit: async () => true,
        app: () => { throw new Error("No admission without pending work"); },
        rpc: async (name, args) => {
          if (name === "next_meta_analytics_dispatch_target") {
            assertEquals(args.p_start, false);
            return { data: state === "complete" ? { state, refused_count: 1205, round: 2, served_at: stamp } : { state }, error: null };
          }
          if (name === "claim_meta_analytics_collection_job") return { data: null, error: null };
          writes++;
          throw new Error("No cursor writes without pending work");
        } });
      const response = await handler(request("facebook"));
      assertEquals(response.status, 200);
      const receipt = await response.json();
      assertEquals(receipt.resume.counts, { visited: 0, queued: 0, refused: 0 });
      assertEquals(writes, 0);
    });
  }
});

Deno.test("Facebook resume failures preserve independent Threads work and fail closed on storage ambiguity", async (test) => {
  for (const scenario of [
    { name: "missing Facebook app", platform: "all", failure: "app", claims: 2 },
    { name: "Facebook SQL configuration refusal", platform: "all", failure: "configuration", claims: 2 },
    { name: "unknown storage outcome", platform: "all", failure: "storage", claims: 0 },
    { name: "invalid storage contract", platform: "all", failure: "contract", claims: 0 },
    { name: "Facebook-only configuration refusal", platform: "facebook", failure: "app", claims: 0 },
  ] as const) {
    await test.step(scenario.name, async () => {
      let claims = 0;
      const audits: unknown[] = [];
      const completions: unknown[] = [];
      const pageValue = crypto.randomUUID();
      const appValue = crypto.randomUUID();
      const job = { platform: "threads", job_id: crypto.randomUUID(), user_id: owner, account_id: account(52),
        job_generation: 1, claim_token: crypto.randomUUID(), lease_until: stamp, due_on: "2026-11-15",
        due_at: stamp, next_due_at: "2026-11-16T12:00:00.000Z",
        authority: { platform_user_id: "869002", credential_generation: 1, token_expires_at: null } };
      const handler = createOwnedAnalyticsSyncHandler({ authorize: () => ({ ok: true }),
        audit: async (event) => { audits.push(event); return true; },
        app: (platform) => platform === "threads" ? { id: "867002", secret: appValue } : null,
        fetch: async () => { throw new Error("Already accepted Threads captures need no provider calls"); },
        rpc: async (name, args) => {
          if (name === "next_meta_analytics_dispatch_target") return { data: args.p_platform === "threads" ? { state: "not_started" } : {
            state: "target", served_at: stamp, ticket: { platform: "facebook", owner_id: owner,
              due_on: "2026-11-15", policy_digest: "a".repeat(64), round: 1,
              after_account_id: null, account_id: account(51) } }, error: null };
          if (name === "commit_meta_analytics_dispatch_target") {
            if (scenario.failure === "configuration") return { data: null, error: { code: "MAH05" } };
            if (scenario.failure === "storage") return { data: null, error: { code: "57014" } };
            if (scenario.failure === "contract") return { data: {}, error: null };
            return { data: { state: "needs_admission" }, error: null };
          }
          if (name === "claim_meta_analytics_collection_job") {
            assertEquals(args.p_platform, "threads", "A Facebook failure cannot claim Facebook measurements");
            return { data: ++claims === 1 ? job : null, error: null };
          }
          if (name === "read_threads_analytics_collection_credential") return { data: {
            job_id: job.job_id, job_generation: 1, authority: job.authority, access_token: pageValue }, error: null };
          if (name === "read_threads_analytics_worker_state") return { data: {
            checkpoint: { cursor: null, post_ids: [], pages_fetched: 1, inventory_complete: true, inventory_truncated: false },
            operations: ["account_day:2026-11-14", "account_day:2026-11-13", "profile"].map((key) => ({
              operation_key: key, kind: key === "profile" ? "profile" : "account_day", state: "success", reason: null, last_requested_at: null })) }, error: null };
          assertEquals(name, "complete_threads_analytics_collection_job");
          completions.push(args.p_outcome);
          return { data: { job_id: job.job_id, job_generation: 1, state: args.p_outcome,
            on_time: false, due_at: job.due_at, next_due_at: job.next_due_at }, error: null };
        } });
      const reply = await handler(request(scenario.platform));
      const receipt = await reply.json();
      assertEquals(reply.status, 503);
      assertEquals(receipt.ok, false);
      assertEquals(receipt.resume.status, "unavailable");
      assertEquals(claims, scenario.claims);
      assertEquals(completions, scenario.claims ? ["success"] : []);
      assertEquals(receipt.counts.collected, scenario.claims ? 1 : 0);
      assertEquals(audits.length, 1);
    });
  }
});

Deno.test("a pending provider refusal retains retry accounting and leaves the measurement claim reachable", async () => {
  const authority = { platform_user_id: "869001", connection_version: 1, credential_id: crypto.randomUUID(),
    credential_revision: 1, provider_user_id: "868001", token_expires_at: null };
  const ticket = { platform: "facebook", owner_id: owner, due_on: "2026-11-15", policy_digest: "a".repeat(64),
    round: 1, after_account_id: null, account_id: account(51) };
  let attempts = 0;
  let claims = 0;
  let calls = 0;
  const handler = createOwnedAnalyticsSyncHandler({ authorize: () => ({ ok: true }), audit: async () => true,
    app: () => ({ id: "867001", secret: crypto.randomUUID() }),
    rpc: async (name) => {
      if (name === "next_meta_analytics_dispatch_target") return { data: { state: "target", ticket, served_at: stamp }, error: null };
      if (name === "commit_meta_analytics_dispatch_target") return { data: { state: "needs_admission" }, error: null };
      if (name === "read_fb_analytics_admission_credential") return { data: { account_id: account(51), user_id: owner, authority,
        access_token: crypto.randomUUID(), permission_token: crypto.randomUUID() }, error: null };
      if (name === "record_meta_analytics_admission_failure") { attempts++; return { data: { state: "pending", attempts: 1 }, error: null }; }
      assertEquals(name, "claim_meta_analytics_collection_job");
      claims++;
      return { data: null, error: null };
    }, fetch: async () => { calls++; return Response.json({ error: { code: 2, is_transient: true } }, { status: 503 }); } });
  const reply = await handler(request("facebook"));
  const receipt = await reply.json();
  assertEquals(reply.status, 200);
  assertEquals(receipt.resume.reason, "provider_unavailable");
  assertEquals(attempts, 1);
  assertEquals(claims, 1);
  assertEquals(calls, 1, "A failed debugger never proceeds to operational identity or metrics");
});

Deno.test("an unacknowledged resume database timeout ends the invocation before any measurement claim", async () => {
  let calls = 0;
  let release: (() => void) | undefined;
  let signal: AbortSignal | undefined;
  const handler = createOwnedAnalyticsSyncHandler({ authorize: () => ({ ok: true }), audit: async () => true, app: () => null,
    rpc: (_name, _args, abort) => {
      calls++;
      if (calls === 1) return Promise.resolve({ data: { state: "not_started" }, error: null });
      signal = abort;
      return new Promise((resolve) => { release = () => resolve({ data: { state: "not_started" }, error: null }); });
    } });
  try {
    const started = performance.now();
    const reply = await handler(request("facebook"));
    assert(performance.now() - started < 7_000, "The existing five-second DB call bound is retained");
    const receipt = await reply.json();
    assertEquals(reply.status, 503);
    assertEquals(receipt.reason, "deadline");
    assertEquals(receipt.resume.storageUncertain, true);
    assertEquals(signal?.aborted, true);
    assertEquals(calls, 2, "Only preflight and the failed resume read; no retry, cursor write or measurement after an unknown outcome");
  } finally { release?.(); }
});

Deno.test("an exhausted admission slice with nonzero preflight latency still permits an actual measurement claim", async () => {
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  let claims = 0;
  let nextReads = 0;
  let observationWrites = 0;
  const authority = { platform_user_id: "869001", connection_version: 1, credential_id: crypto.randomUUID(),
    credential_revision: 1, provider_user_id: "868001", token_expires_at: null };
  const credential = { account_id: account(51), user_id: owner, authority,
    access_token: crypto.randomUUID(), permission_token: crypto.randomUUID() };
  const ticket = { platform: "facebook", owner_id: owner, due_on: "2026-11-15", policy_digest: "a".repeat(64),
    round: 1, after_account_id: null, account_id: account(51) };
  try {
    const handler = createOwnedAnalyticsSyncHandler({ authorize: () => ({ ok: true }), audit: async () => true,
      app: () => ({ id: "867001", secret: crypto.randomUUID() }),
      rpc: async (name, args) => {
        if (name === "next_meta_analytics_dispatch_target") {
          now += nextReads++ === 0 ? 700 : 2_500;
          return { data: args.p_platform === "threads" ? { state: "not_started" } : { state: "target", ticket, served_at: stamp }, error: null };
        }
        if (name === "commit_meta_analytics_dispatch_target") { now += 700; return { data: { state: "needs_admission" }, error: null }; }
        if (name === "read_fb_analytics_admission_credential") { now += 700; return { data: credential, error: null }; }
        if (name === "observe_fb_analytics_permissions") { observationWrites++; throw new Error("An expired slice must not start this write"); }
        assertEquals(name, "claim_meta_analytics_collection_job");
        assertEquals(args.p_platform, "all");
        claims++;
        return { data: null, error: null };
      }, fetch: async (input) => {
        now += 3_800; // Each provider response remains inside the existing four-second request bound.
        const url = new URL(input instanceof Request ? input.url : String(input));
        return Response.json(url.pathname.endsWith("debug_token")
          ? { data: { is_valid: true, app_id: "867001", user_id: "868001", scopes: ["read_insights", "pages_read_engagement"] } }
          : { id: "869001" }, { headers: { "facebook-api-version": "v25.0" } });
      } });
    const response = await handler(request());
    const receipt = await response.json();
    assertEquals(response.status, 200, JSON.stringify(receipt));
    assertEquals(receipt.resume.reason, "deadline");
    assertEquals(receipt.resume.storageUncertain, undefined, "No unacknowledged database operation exists");
    assertEquals(observationWrites, 0);
    assertEquals(claims, 1);
  } finally { Date.now = realNow; }
});
