import { assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { FacebookInsightsProvider } from "../facebook-page-insights/provider.ts";
import { MetaAnalyticsTransport } from "../_shared/metaAnalyticsTransport.ts";
import { analyticsDefinitions } from "../_shared/analyticsRegistry.ts";
import { analyticsDayBucket } from "../_shared/analyticsCalendar.ts";
import { z } from "https://esm.sh/zod@3.25.76";
import { facebookCollection } from "./facebookCollection.ts";
import { CollectionProviderRefused } from "./collectionProvider.ts";
import type { AnalyticsCapture } from "./store.ts";
import { createOwnedAnalyticsSyncHandler } from "./handler.ts";

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
      const { cells } = await facebookCollection(provider, capture.subject_id).metrics(capture, definitions);
      if (scenario === "mixed") {
        assertEquals(cells.views, { status: "available", value: 0 });
        assertEquals(cells.followers, { status: "unavailable", reason: "provider_error" });
      } else for (const cell of Object.values(cells)) assertEquals(cell, { status: "unavailable",
        reason: scenario === "duplicate" ? "provider_error" : scenario === "misaligned" ? "window_mismatch" : "capability_unverified" });
    });
  }
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

Deno.test("drain isolates known target refusals within one shared cap but stops on an unknown read", async (test) => {
  for (const code of ["MAH03", "57014"] as const) {
    await test.step(code, async () => {
      let claimed = 0;
      let providerCalls = 0;
      const handler = createOwnedAnalyticsSyncHandler({ authorize: () => ({ ok: true }), app: () => ({ id: "770001", secret: "fixture-app" }), audit: async () => true,
        fetch: async () => { providerCalls++; throw new Error("No failed authority read may reach Meta"); },
        rpc: (name) => {
          if (name === "next_meta_analytics_dispatch_target") return Promise.resolve({ data: { state: "not_started" }, error: null });
          if (name === "claim_meta_analytics_collection_job") {
            claimed++;
            const platform = claimed % 2 ? "facebook" : "threads";
            return Promise.resolve({ data: { job_id: `c2000000-0000-4000-8000-${String(claimed).padStart(12, "0")}`,
              user_id: "c1000000-0000-4000-8000-000000000001", account_id: "c3000000-0000-4000-8000-000000000001",
              platform, job_generation: 1, claim_token: "c4000000-0000-4000-8000-000000000001", lease_until: "2026-11-01T20:00:00Z",
              due_on: "2026-11-01", due_at: "2026-11-01T07:00:00Z", next_due_at: "2026-11-02T08:00:00Z",
              authority: platform === "facebook" ? { platform_user_id: "772001", connection_version: 1,
                credential_id: "c5000000-0000-4000-8000-000000000001", credential_revision: 1, provider_user_id: "771001", token_expires_at: null }
                : { platform_user_id: "773001", credential_generation: 1, token_expires_at: null } }, error: null });
          }
          return Promise.resolve({ data: null, error: { code } });
        } });
      const response = await handler(new Request("https://owned-analytics.invalid", { method: "POST", body: JSON.stringify({ action: "drain", platform: "all" }) }));
      const receipt = await response.json();
      assertEquals(claimed, code === "MAH03" ? 50 : 1);
      assertEquals(providerCalls, 0);
      assertEquals(response.status, code === "MAH03" ? 200 : 503);
      assertEquals(receipt.counts.refused, code === "MAH03" ? 50 : 0);
    });
  }
});
