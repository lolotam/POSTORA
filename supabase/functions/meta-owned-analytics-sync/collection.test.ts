import { assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { FacebookInsightsProvider } from "../facebook-page-insights/provider.ts";
import { createOwnedAnalyticsSyncHandler } from "./handler.ts";
import type { MetricValue } from "../_shared/analyticsContract.ts";
import { ThreadsInsightsProvider } from "../threads-insights/provider.ts";
import { threadsCollection } from "./threadsCollection.ts";
import { projectThreadsPostMetric, projectThreadsAccountMetric } from "../threads-insights/analyticsProjection.ts";
import { closedAnalyticsPeriods } from "../_shared/analyticsCalendar.ts";
import { MetaAnalyticsTransport } from "../_shared/metaAnalyticsTransport.ts";
import { analyticsDefinitions } from "../_shared/analyticsRegistry.ts";
import { analyticsDayBucket } from "../_shared/analyticsCalendar.ts";
import { z } from "https://esm.sh/zod@3.25.76";
import { facebookCollection } from "./facebookCollection.ts";
import { CollectionProviderRefused } from "./collectionProvider.ts";
import type { AnalyticsCapture } from "./store.ts";

Deno.test("a collected day preserves zero and distinguishes missing, duplicate and misaligned cells", async (test) => {
  const day = analyticsDayBucket("2026-11-01", "America/Los_Angeles");
  const capture: AnalyticsCapture = { capture_id: "c1000000-0000-4000-8000-000000000001", capture_sequence: 1,
    job_id: "c2000000-0000-4000-8000-000000000001", job_generation: 1, kind: "account_day", subject_id: "772001", metric_date: day.date,
    since: day.since, until: day.until, timezone: "America/Los_Angeles" };
  const definitions = analyticsDefinitions("facebook", "account").filter((entry) => entry.capability === "available" && entry.windowKind === "day");
  for (const scenario of ["mixed", "duplicate", "misaligned", "version_mismatch"] as const) {
    await test.step(scenario, async () => {
      const provider = new FacebookInsightsProvider({ token: "fixture-page", startedAt: Date.now(), signal: new AbortController().signal,
        fetch: async (input) => {
          const url = new URL(String(input));
          const metric = url.searchParams.get("metric")!;
          const row = { name: metric, period: "day", values: [{ value: 0, end_time: scenario === "misaligned" ? "2026-11-02T07:00:00Z" : day.until }] };
          const rows = scenario === "mixed" && metric === "page_follows" ? [] : scenario === "duplicate" ? [row, row] : [row];
          return Response.json({ data: rows }, { headers: { "facebook-api-version": scenario === "version_mismatch" ? "v26.0" : "v25.0" } });
        } });
      const cells = await facebookCollection(provider, capture.subject_id).metrics(capture, definitions);
      if (scenario === "mixed") {
        assertEquals(cells.views, { status: "available", value: 0 });
        assertEquals(cells.followers, { status: "unavailable", reason: "provider_error" });
      } else for (const cell of Object.values(cells)) assertEquals(cell, { status: "unavailable",
        reason: scenario === "duplicate" ? "provider_error" : scenario === "misaligned" ? "window_mismatch" : "capability_unverified" });
    });
  }
});

Deno.test("Threads snapshots share live and saved decoding without inventing daily periods", async (test) => {
  const windows = closedAnalyticsPeriods({ now: "2026-11-01T12:00:00Z", days: 7, timezone: "America/Los_Angeles" });
  for (const kind of ["profile", "post"] as const) for (const scenario of ["zero_total", "single_lifetime_value", "wrong_period", "missing_value"] as const) {
    await test.step(`${kind}: ${scenario}`, async () => {
      const definition = analyticsDefinitions("threads", kind === "profile" ? "account" : "post").find((entry) => entry.key === (kind === "profile" ? "followers" : "views"))!;
      const row = { name: definition.providerMetric!, ...(scenario === "single_lifetime_value" ? { period: "lifetime" as const, values: [{ value: 0 }] }
        : { ...(scenario === "wrong_period" ? { period: "week" as const } : {}), total_value: { value: scenario === "missing_value" ? null : 0 } }) };
      const reply = { data: { data: [row] }, error: null, status: 200, retryAt: null };
      const provider = new ThreadsInsightsProvider({ token: "fixture-threads", startedAt: Date.now(), signal: new AbortController().signal,
        fetch: async () => Response.json(reply.data) });
      const capture: AnalyticsCapture = { capture_id: "c1000000-0000-4000-8000-000000000001", capture_sequence: 1,
        job_id: "c2000000-0000-4000-8000-000000000001", job_generation: 1, kind, subject_id: "773001", metric_date: null,
        since: null, until: null, timezone: null };
      const cells = await threadsCollection(provider, "773001", windows.current.buckets[0]).metrics(capture, [definition]);
      const live = kind === "post" ? projectThreadsPostMetric(definition, reply, "2026-11-01T12:00:00Z")
        : projectThreadsAccountMetric({ definition, current: reply, previous: reply, windows, observedAt: "2026-11-01T12:00:00Z" });
      const expected: MetricValue = scenario === "zero_total" || kind === "post" && scenario === "single_lifetime_value" ? { status: "available", value: 0 }
        : { status: "unavailable", reason: scenario === "wrong_period" || scenario === "single_lifetime_value" ? "window_mismatch" : "provider_error" };
      assertEquals(cells[definition.key], expected);
      assertEquals(live.current, expected);
    });
  }
});

Deno.test("one platform backoff preserves its retry and permits the other platform to finish", async () => {
  let claims = 0;
  const completed: string[] = [];
  const job = (platform: "facebook" | "threads") => ({ platform, job_id: `c2000000-0000-4000-8000-${platform === "facebook" ? "000000000001" : "000000000002"}`,
    user_id: "c1000000-0000-4000-8000-000000000001", account_id: "c3000000-0000-4000-8000-000000000001", job_generation: 1,
    claim_token: "c4000000-0000-4000-8000-000000000001", lease_until: "2026-11-01T20:00:00Z", due_on: "2026-11-01", due_at: "2026-11-01T07:00:00Z", next_due_at: "2026-11-02T08:00:00Z",
    authority: platform === "facebook" ? { platform_user_id: "772001", connection_version: 1, credential_id: "c5000000-0000-4000-8000-000000000001", credential_revision: 1, provider_user_id: "771001", token_expires_at: null }
      : { platform_user_id: "773001", credential_generation: 1, token_expires_at: null } });
  const retryAt = new Date(Date.now() + 120_000).toISOString();
  const handler = createOwnedAnalyticsSyncHandler({ authorize: () => ({ ok: true }), app: () => ({ id: "770001", secret: "fixture-app" }), audit: async () => true,
    fetch: async () => { throw new Error("A known throttle and accepted captures must not call Meta"); },
    rpc: async (name, args) => {
      const active = job(claims === 1 ? "facebook" : "threads");
      let data: unknown;
      if (name === "next_meta_analytics_dispatch_target") data = { state: "not_started" };
      else if (name === "claim_meta_analytics_collection_job") { claims++; data = claims < 3 ? job(claims === 1 ? "facebook" : "threads") : null; }
      else if (name.endsWith("_analytics_collection_credential")) data = { job_id: active.job_id, job_generation: 1, authority: active.authority, access_token: "fixture-token" };
      else if (name.endsWith("_analytics_worker_state")) data = { checkpoint: { cursor: null, post_ids: [], pages_fetched: 1, inventory_complete: true, inventory_truncated: false },
        operations: active.platform === "facebook" ? [] : ["account_day:2026-10-31", "account_day:2026-10-30", "profile"].map((key) => ({ operation_key: key, kind: key === "profile" ? "profile" : "account_day", state: "success", reason: null, last_requested_at: null })) };
      else if (name === "reserve_fb_analytics_capture") data = { capture_id: "c6000000-0000-4000-8000-000000000001", capture_sequence: 1, job_id: active.job_id, job_generation: 1,
        kind: "account_day", subject_id: "772001", metric_date: "2026-10-31", since: "2026-10-31T07:00:00Z", until: "2026-11-01T07:00:00Z", timezone: "America/Los_Angeles" };
      else if (name === "read_meta_analytics_provider_throttle") data = { usage_percent: 90, throttled_until: retryAt };
      else if (name === "record_instagram_provider_throttle_http") data = { bucket_key: args.p_bucket_key, usage_percent: args.p_usage_percent, throttled_until: args.p_throttled_until, job_id: null };
      else if (name.endsWith("_analytics_collection_job")) {
        completed.push(`${active.platform}:${args.p_outcome}`);
        if (active.platform === "facebook") assertEquals(args.p_retry_at, retryAt);
        data = { job_id: active.job_id, job_generation: 1, state: args.p_outcome, on_time: false, due_at: active.due_at, next_due_at: active.next_due_at };
      } else throw new Error(`Unexpected database operation: ${name}`);
      return { data, error: null };
    } });
  const response = await handler(new Request("https://owned-analytics.invalid", { method: "POST", body: JSON.stringify({ action: "drain", platform: "all" }) }));
  const receipt = await response.json();
  assertEquals(response.status, 200, JSON.stringify(receipt));
  assertEquals(completed, ["facebook:retry", "threads:success"]);
  assertEquals(receipt.counts, { visited: 2, collected: 1, partial: 1, refused: 0 });
  assertEquals(receipt.reason, "rate_limited");
});

Deno.test("inventory with a missing continuation cursor and mismatched post identity refuse", async () => {
  const provider = new FacebookInsightsProvider({ token: "fixture-page", startedAt: Date.now(), signal: new AbortController().signal,
    fetch: async (input) => String(input).includes("/posts?") ? Response.json({ data: [], paging: { next: "https://graph.facebook.com/next" } },
      { headers: { "facebook-api-version": "v25.0" } }) : Response.json({ id: "772001_9002", created_time: "2026-10-30T00:00:00Z" },
      { headers: { "facebook-api-version": "v25.0" } }) });
  const collection = facebookCollection(provider, "772001");
  await assertRejects(() => collection.page(null), CollectionProviderRefused);
  await assertRejects(() => collection.post("772001_9001"), CollectionProviderRefused);
});

Deno.test("an unknown usage write leaves the actual transport unchanged for the caller", async () => {
  const failure = new Error("Synthetic usage store outcome unknown");
  const transport = new MetaAnalyticsTransport({ origin: "https://graph.facebook.com", version: "v25.0", token: "fixture-page",
    signal: new AbortController().signal, startedAt: Date.now(), fallbackReason: "provider_error", rateLimitedReason: "rate_limited",
    failureMessage: "Synthetic provider failure", classifyFailure: () => null,
    fetch: async () => Response.json({ id: "772001" }), afterResponse: async () => { throw failure; } });
  let caught: unknown;
  try { await transport.request(["me"], {}, z.object({ id: z.string() })); } catch (error) { caught = error; }
  assertEquals(caught, failure, "A store outcome must not become a sanitized successful/failed provider response");
});
