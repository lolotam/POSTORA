import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { z } from "https://esm.sh/zod@3.25.76";
import { resolveRolloutRuntime, RolloutSqlError, SERVICE_ROLE, acquireRolloutLease, releaseRolloutLease } from "../_shared/rolloutIntegrationTestSupport.ts";
import { handler } from "./index.ts";
import { parseAnalyticsReport } from "../_shared/analyticsSchema.ts";
import { handleGetPostAnalytics } from "../n8n-api/serviceProxy.ts";

const OWNER = "a1000000-0000-4000-8000-000000000001";
const PAGE = "a2000000-0000-4000-8000-000000000001";
const THREADS = "a3000000-0000-4000-8000-000000000001";
const CREDENTIAL = "a5000000-0000-4000-8000-000000000001";
const API = "https://owned-analytics.invalid";
const literal = (value: unknown) => `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`;
const settingKeys = "'collection_facebook_analytics_enabled','collection_threads_analytics_enabled','collection_facebook_analytics_policy','collection_threads_analytics_policy','retention_facebook_analytics_enabled','retention_threads_analytics_enabled','retention_facebook_analytics_policy','retention_threads_analytics_policy'";

Deno.test("registered admission and dispatch preserve real SQL fences and durable progress", async (test) => {
  const target = Deno.env.get("ROLLOUT_IT_CONTAINER");
  const database = Deno.env.get("ROLLOUT_IT_DB") ?? "";
  assert(target && database.endsWith("_harness"), "Explicit disposable container and _harness database are required");
  const inspected = await new Deno.Command("docker", { args: ["inspect", target], stdout: "piped", stderr: "piped" }).output();
  assert(inspected.success, "Disposable container inspection failed");
  const container = JSON.parse(new TextDecoder().decode(inspected.stdout))[0];
  assert(["meta-analytics-history-c2", "postora-db-harness-ci"].includes(container.Config.Labels["postora.task"]), "Disposable task label required");
  Deno.env.set("ROLLOUT_IT_CONTAINER", container.Id);
  const runtime = resolveRolloutRuntime();
  assertEquals(await runtime.queryJson("SELECT to_jsonb(current_setting('cron.launch_active_jobs'));"), "off");
  const lease = "meta-owned-admission";
  await acquireRolloutLease(runtime, lease);
  const previousEnvironment = new Map(["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "CRON_SECRET", "FACEBOOK_APP_ID", "FACEBOOK_APP_SECRET", "THREADS_APP_ID", "THREADS_APP_SECRET"]
    .map((key) => [key, Deno.env.get(key)]));
  const oldFetch = globalThis.fetch;
  let snapshot: unknown;
  let turnSnapshot: unknown;
  let ownsFixture = false;
  const failures: unknown[] = [];
  const auditIds: unknown[] = [];
  const sweepDigests: string[] = [];
  const throttleKeys = new Set<string>();
  let loseCommitResponse = false;
  let loseCaptureResponse = false;
  const sqlRequest = async (outgoing: Request): Promise<Response> => {
    const url = new URL(outgoing.url);
    const body = await outgoing.json();
    if (url.pathname === "/rest/v1/system_logs") {
      const id = await runtime.queryJson(`INSERT INTO public.system_logs(level,category,source,message,metadata)
        SELECT x.level,x.category,x.source,x.message,x.metadata FROM jsonb_to_record(${literal(body)})
        AS x(level text,category text,source text,message text,metadata jsonb) RETURNING to_jsonb(id);`, SERVICE_ROLE);
      auditIds.push(id);
      return new Response(null, { status: 201 });
    }
    const name = url.pathname.slice("/rest/v1/rpc/".length);
    assert(/^(read|observe)_(fb|threads)_analytics_(admission_credential|permissions)$/.test(name)
      || /^(claim|read|reserve|commit|persist|complete)_(fb|threads)_analytics_(collection_jobs|collection_credential|worker_state|inventory_page|capture|collection_job)$/.test(name)
      || ["next_meta_analytics_dispatch_target", "commit_meta_analytics_dispatch_target", "read_meta_analytics_provider_throttle", "record_instagram_provider_throttle_http", "claim_meta_analytics_collection_job",
        "list_meta_analytics_retention_targets", "cleanup_meta_analytics_target", "read_meta_owned_analytics_history"].includes(name), "Unexpected RPC refused");
    if (name === "record_instagram_provider_throttle_http") {
      assert(/^[a-f0-9]{64}$/.test(body.p_bucket_key), "Only a validated synthetic digest can enter fixture cleanup");
      assertEquals([body.p_job_id, body.p_claim_token, body.p_job_generation], [null, null, null], "Foreign jobs never enter the Instagram job RPC");
      if (!throttleKeys.has(body.p_bucket_key)) {
        assertEquals(await runtime.queryJson(`SELECT to_jsonb(count(*)) FROM public.instagram_provider_throttle_buckets WHERE bucket_key='${body.p_bucket_key}';`), 0,
          "Never replace a pre-existing throttle fixture");
        throttleKeys.add(body.p_bucket_key);
      }
    }
    try {
      const result = await runtime.callRpc(name, body, SERVICE_ROLE);
      if (loseCommitResponse && name === "commit_meta_analytics_dispatch_target") {
        loseCommitResponse = false;
        return Response.json({ code: "57014", message: "Synthetic lost commit response" }, { status: 503 });
      }
      if (loseCaptureResponse && name.startsWith("persist_")) {
        loseCaptureResponse = false;
        return Response.json({ code: "57014", message: "Synthetic lost capture response" }, { status: 503 });
      }
      return Response.json(result);
    } catch (error) {
      if (!(error instanceof RolloutSqlError)) throw error;
      return Response.json({ code: error.sqlstate, message: "Synthetic SQL refusal" }, { status: 400 });
    }
  };
  try {
    assertEquals(await runtime.queryJson(`SELECT to_jsonb(count(*)) FROM auth.users WHERE id='${OWNER}';`), 0, "Never replace a pre-existing owner");
    snapshot = await runtime.queryJson(`SELECT jsonb_object_agg(key,value) FROM public.app_settings WHERE key IN (${settingKeys});`);
    turnSnapshot = await runtime.queryJson("SELECT jsonb_object_agg(platform,last_claimed_at) FROM public.meta_analytics_worker_turns;");
    assert(snapshot && typeof snapshot === "object", "Existing rollout settings required");
    for (const id of [PAGE, THREADS]) {
      const digest = await runtime.queryJson(`SELECT to_jsonb(encode(sha256(convert_to(${literal({ account_ids: [id] })}::text,'utf8')),'hex'));`);
      assert(typeof digest === "string", "Fixture policy digest must be database-authored");
      sweepDigests.push(digest);
    }
    assertEquals(await runtime.queryJson(`SELECT to_jsonb(count(*)) FROM public.meta_analytics_enqueue_sweeps
      WHERE policy_digest IN (SELECT jsonb_array_elements_text(${literal(sweepDigests)}));`), 0, "Never replace pre-existing sweep metadata");
    await runtime.exec(`BEGIN;
      INSERT INTO auth.users(id,email) VALUES('${OWNER}','meta-admission-it@example.invalid');
      INSERT INTO public.social_accounts(id,user_id,platform,platform_user_id,access_token,is_active,needs_reauth) VALUES
        ('${PAGE}','${OWNER}','facebook','772001','synthetic-page',true,false),
        ('${THREADS}','${OWNER}','threads','773001','synthetic-threads',true,false);
      INSERT INTO public.facebook_user_credentials(id,user_id,token,provider_user_id,provenance_source,provenance_captured_at)
        VALUES('${CREDENTIAL}','${OWNER}','synthetic-user','771001','oauth_exchange',clock_timestamp());
      INSERT INTO public.facebook_user_credential_connection_fences(social_account_id,user_id,platform) VALUES('${PAGE}','${OWNER}','facebook');
      INSERT INTO public.facebook_user_credential_bindings(social_account_id,user_id,platform,credential_id,verified_facebook_user_id,evidence_source)
        VALUES('${PAGE}','${OWNER}','facebook','${CREDENTIAL}','771001','oauth_exchange');
      UPDATE public.app_settings SET value='true'::jsonb WHERE key IN ('collection_facebook_analytics_enabled','collection_threads_analytics_enabled');
      COMMIT;`);
    ownsFixture = true;
    for (const [key, value] of Object.entries({ SUPABASE_URL: API, SUPABASE_SERVICE_ROLE_KEY: "fixture-service", CRON_SECRET: "synthetic-cron",
      FACEBOOK_APP_ID: "770001", FACEBOOK_APP_SECRET: "synthetic-app", THREADS_APP_ID: "770001", THREADS_APP_SECRET: "synthetic-app" })) Deno.env.set(key, value);
    const { handler: reportHandler } = await import("../meta-owned-analytics-report/index.ts");
    const reportRequest = (platform: "facebook" | "threads", accountId: string, ownerId = OWNER) => reportHandler(new Request(API, {
      method: "POST", headers: { Authorization: "Bearer fixture-service", "Content-Type": "application/json" },
      body: JSON.stringify({ platform, accountId, user_id: ownerId, analyticsContractVersion: 1, periodDays: 7 }),
    }));
    for (const platform of ["facebook", "threads"] as const) {
      const accountId = platform === "facebook" ? PAGE : THREADS;
      for (const scenario of ["normal", "exclude_before_second_request", "exclude_before_observation_write"] as const) {
        const passed = await test.step(`${platform}: ${scenario}`, async () => {
          await runtime.exec(`UPDATE public.app_settings SET value=jsonb_build_object('account_ids',jsonb_build_array('${accountId}')) WHERE key='collection_${platform}_analytics_policy';`);
          let providerCalls = 0;
          globalThis.fetch = async (input, init) => {
            const outgoing = new Request(input, init);
            const url = new URL(outgoing.url);
            if (url.origin === API) return await sqlRequest(outgoing);
            assertEquals(url.origin, platform === "facebook" ? "https://graph.facebook.com" : "https://graph.threads.net");
            providerCalls++;
            const debuggerCall = url.pathname.endsWith("/debug_token");
            if (debuggerCall) {
              assertEquals(url.searchParams.get("input_token"), platform === "facebook" ? "synthetic-user" : "synthetic-threads");
              assertEquals(outgoing.headers.get("authorization"), `Bearer ${platform === "threads" ? "TH|" : ""}770001|synthetic-app`);
            } else assertEquals(outgoing.headers.get("authorization"), `Bearer ${platform === "facebook" ? "synthetic-page" : "synthetic-threads"}`);
            if (scenario === "exclude_before_second_request" && debuggerCall || scenario === "exclude_before_observation_write" && !debuggerCall) {
              await runtime.exec(`UPDATE public.app_settings SET value='{"account_ids":[]}'::jsonb WHERE key='collection_${platform}_analytics_policy';`);
            }
            return Response.json(debuggerCall ? { data: { is_valid: true, app_id: "770001", user_id: platform === "facebook" ? "771001" : "773001",
              scopes: platform === "facebook" ? ["read_insights", "pages_read_engagement"] : ["threads_basic", "threads_manage_insights"] } }
              : { id: platform === "facebook" ? "772001" : "773001" }, { headers: { "facebook-api-version": "v25.0" } });
          };
          const response = await handler(new Request(`${API}/functions/v1/meta-owned-analytics-sync`, { method: "POST",
            headers: { Authorization: "Bearer synthetic-cron", "Content-Type": "application/json" }, body: JSON.stringify({ action: "admit", platform, accountId }) }));
          const result = await response.json();
          assertEquals(response.status, scenario === "normal" ? 200 : 409, JSON.stringify({ result, providerCalls }));
          assertEquals(providerCalls, scenario === "exclude_before_second_request" ? 1 : 2);
          const family = platform === "facebook" ? "fb" : "threads";
          assertEquals(await runtime.queryJson(`SELECT to_jsonb(count(*)) FROM public.${family}_analytics_permission_observations WHERE user_id='${OWNER}' AND state='verified';`), 1);
          assertEquals(await runtime.queryJson(`SELECT to_jsonb(count(*)) FROM public.${family}_analytics_collection_jobs WHERE user_id='${OWNER}';`), 0);
        });
        assert(passed, "Stop after a failed real admission scenario");
      }
    }
    assertEquals(await runtime.queryJson(`SELECT to_jsonb(count(*)) FROM public.system_logs WHERE source='meta-owned-analytics-sync' AND metadata->>'accountId' IN ('${PAGE}','${THREADS}');`), 6);
    await runtime.exec(`UPDATE public.app_settings SET value=jsonb_build_object('account_ids',jsonb_build_array('${PAGE}')) WHERE key='collection_facebook_analytics_policy';
      UPDATE public.app_settings SET value=jsonb_build_object('account_ids',jsonb_build_array('${THREADS}')) WHERE key='collection_threads_analytics_policy';`);
    let providerCalls = 0;
    globalThis.fetch = async (input, init) => {
      const outgoing = new Request(input, init);
      const url = new URL(outgoing.url);
      if (url.origin === API) return await sqlRequest(outgoing);
      providerCalls++;
      assertEquals(url.origin, "https://graph.threads.net");
      if (url.pathname.endsWith("debug_token")) {
        assertEquals(url.searchParams.get("input_token"), "fixture-rotated");
        return Response.json({ data: { is_valid: true, user_id: "773001", scopes: ["threads_basic", "threads_manage_insights",
          ...Array.from({ length: 40 }, (_unused, index) => `other_permission_${index}`)] } });
      }
      assertEquals(outgoing.headers.get("authorization"), "Bearer fixture-rotated");
      return Response.json({ id: "773001" });
    };
    const dispatch = () => handler(new Request(API, { method: "POST", headers: { Authorization: "Bearer synthetic-cron", "Content-Type": "application/json" },
      body: JSON.stringify({ action: "enqueue-daily", platform: "all" }) }));
    for (const scenario of ["fresh_grants", "existing_jobs", "rotated_credential", "lost_commit_then_resume"] as const) {
      const passed = await test.step(`dispatch: ${scenario}`, async () => {
        if (scenario === "rotated_credential") await runtime.exec(`UPDATE public.social_accounts SET access_token='fixture-rotated' WHERE id='${THREADS}';`);
        if (scenario === "lost_commit_then_resume") {
          loseCommitResponse = true;
          const lost = await dispatch();
          assertEquals(lost.status, 503);
          const result = await lost.json();
          assertEquals(result.reason, "storage_unavailable");
          assertEquals(result.counts.queued, 0);
        }
        const response = await dispatch();
        const result = await response.json();
        assertEquals(response.status, 200, JSON.stringify(result));
        assertEquals(result.status, "complete");
        assertEquals(result.counts, { visited: 2, queued: 2, refused: 0 });
        assertEquals(providerCalls, ["rotated_credential", "lost_commit_then_resume"].includes(scenario) ? 2 : 0);
        for (const family of ["fb", "threads"]) assertEquals(await runtime.queryJson(`SELECT jsonb_build_object('count',count(*),'generation',min(job_generation))
          FROM public.${family}_analytics_collection_jobs WHERE user_id='${OWNER}';`), { count: 1, generation: 1 });
      });
      assert(passed, "Stop after a failed durable dispatch scenario");
    }
    assertEquals(auditIds.length, 11);
    for (const platform of ["facebook", "threads"] as const) {
      const passed = await test.step(`collection: ${platform} lost capture response then fenced resume`, async () => {
        const family = platform === "facebook" ? "fb" : "threads";
        const accountId = platform === "facebook" ? PAGE : THREADS;
        const providerId = platform === "facebook" ? "772001" : "773001";
        const postId = platform === "facebook" ? `${providerId}_9001` : "7739001";
        const capturedRequests: string[] = [];
        let metricScenario: "normal" | "permission" | "credential" = "normal";
        globalThis.fetch = async (input, init) => {
          const outgoing = new Request(input, init);
          const url = new URL(outgoing.url);
          if (url.origin === API) return await sqlRequest(outgoing);
          assertEquals(url.origin, platform === "facebook" ? "https://graph.facebook.com" : "https://graph.threads.net");
          assertEquals(outgoing.headers.get("authorization"), platform === "facebook" ? "Bearer synthetic-page" : "Bearer fixture-rotated");
          const reply = (payload: unknown) => Response.json(payload, { headers: platform === "facebook" ? { "facebook-api-version": "v25.0" } : {} });
          const post = platform === "facebook" ? { id: postId, created_time: "2026-10-30T12:00:00Z", message: "Synthetic Page post", permalink_url: "https://facebook.com/9001" }
            : { id: postId, timestamp: "2026-10-30T12:00:00Z", text: "Synthetic Threads post", permalink: "https://threads.net/9001" };
          if (url.pathname.endsWith("/posts") || url.pathname.endsWith("/threads")) return reply({ data: [post] });
          if (url.pathname.endsWith(`/${postId}`)) return reply(post);
          const metrics = url.searchParams.get("metric")!.split(",");
          capturedRequests.push(url.pathname + "?" + url.searchParams.toString());
          if (metricScenario === "permission" && metrics.includes("page_post_engagements")) return Response.json({ error: { code: 10 } }, { status: 403 });
          if (metricScenario === "credential" && metrics.includes("followers_count")) return Response.json({ error: { code: 190 } }, { status: 400 });
          const isDay = url.searchParams.has("since");
          return reply({ data: metrics.map((name) => name === "followers_count" ? { name, period: "day", total_value: { value: 0 } }
            : { name, period: isDay ? "day" : "lifetime", values: [{ value: 0,
              ...(isDay ? { end_time: new Date(Number(url.searchParams.get("until")) * 1000).toISOString() } : {}) }] }) });
        };
        const drain = () => handler(new Request(API, { method: "POST", headers: { Authorization: "Bearer synthetic-cron", "Content-Type": "application/json" },
          body: JSON.stringify({ action: "drain", platform }) }));
        loseCaptureResponse = true;
        const lost = await drain();
        const lostBody = await lost.json();
        assertEquals(lost.status, 503, JSON.stringify(lostBody));
        assertEquals(lostBody.reason, "storage_unavailable");
        assertEquals(await runtime.queryJson(`SELECT to_jsonb(count(*)) FROM public.${family}_analytics_collection_operations WHERE social_account_id='${accountId}' AND state='success';`), 1);
        await runtime.exec(`UPDATE public.${family}_analytics_collection_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE social_account_id='${accountId}';`);
        const resumed = await drain();
        const resumedBody = await resumed.json();
        assertEquals(resumed.status, 200, JSON.stringify(resumedBody));
        assertEquals(resumedBody.counts.collected, 1, JSON.stringify(resumedBody));
        assertEquals(await runtime.queryJson(`SELECT to_jsonb(count(*)) FROM public.${family}_analytics_metric_values WHERE social_account_id='${accountId}' AND status='available' AND value=0;`), platform === "facebook" ? 10 : 9);
        assertEquals(new Set(capturedRequests).size, capturedRequests.length, "Accepted operations are not fetched again after a lost commit");
        const report = await runtime.queryJson(`SELECT public.read_${family}_analytics_history('${OWNER}','${accountId}',jsonb_build_object(
          'since',((clock_timestamp() AT TIME ZONE 'America/Los_Angeles')::date-7)::timestamp AT TIME ZONE 'America/Los_Angeles',
          'until',(clock_timestamp() AT TIME ZONE 'America/Los_Angeles')::date::timestamp AT TIME ZONE 'America/Los_Angeles'));`, SERVICE_ROLE);
        const persisted = z.object({ ok: z.literal(true), collection: z.object({ latest: z.object({ state: z.literal("success") }) }),
          daily: z.array(z.object({ metrics: z.array(z.object({ status: z.string(), value: z.number().nullable() })) })) }).parse(report);
        assertEquals(persisted.daily.length, 2);
        assertEquals(persisted.daily.every((day) => day.metrics.every((cell) => cell.status === "available" && cell.value === 0)), true);
        const beforeReportRequests = capturedRequests.length;
        const canonicalResponse = await reportRequest(platform, accountId);
        const canonical = await canonicalResponse.json();
        assertEquals(canonicalResponse.status, 200, JSON.stringify(canonical));
        parseAnalyticsReport(canonical);
        assertEquals(canonical.source, "persisted");
        assertEquals(canonical.platform, platform);
        assertEquals(canonical.metrics.find((metric: { definition: { key: string } }) => metric.definition.key === (platform === "facebook" ? "views" : "profile_views")).current,
          { status: "partial", value: 0, coverage: { availableDays: 2, expectedDays: 7 } });
        assertEquals(canonical.posts.items[0].metrics.find((metric: { definition: { key: string } }) => metric.definition.key === "views").current, { status: "available", value: 0 });
        if (platform === "threads") assertEquals(canonical.metrics.find((metric: { definition: { key: string } }) => metric.definition.key === "followers").current,
          { status: "available", value: 0 }, "A real current point sample is usable on its capture day without pretending it is a period total");
        assertEquals(capturedRequests.length, beforeReportRequests, "Saved reports perform no provider requests");
        assertEquals((await reportRequest(platform, accountId, CREDENTIAL)).status, 404, "The real report path structurally rejects a foreign acting owner");
        metricScenario = platform === "facebook" ? "permission" : "credential";
        await runtime.exec(`SELECT public.enqueue_${family}_analytics_collection_job('${OWNER}','${accountId}',(clock_timestamp() AT TIME ZONE 'America/Los_Angeles')::date,true);`, SERVICE_ROLE);
        const mixed = await drain();
        const mixedReceipt = await mixed.json();
        assertEquals(mixed.status, 200, JSON.stringify(mixedReceipt));
        assertEquals(mixedReceipt.counts.refused, 1);
        const mixedResponse = await reportRequest(platform, accountId);
        const mixedReport = await mixedResponse.json();
        assertEquals(mixedResponse.status, 200, JSON.stringify(mixedReport));
        parseAnalyticsReport(mixedReport);
        const proxied = await handleGetPostAnalytics({
          loadAccount: async () => ({ account: { id: accountId, user_id: OWNER, platform, platform_user_id: platform === "facebook" ? "772001" : "773001", is_active: true }, failed: false }),
          invoke: async (name, body) => {
            assertEquals(name, "meta-owned-analytics-report");
            const response = await reportHandler(new Request(API, { method: "POST", headers: { Authorization: "Bearer fixture-service" }, body: JSON.stringify(body) }));
            return { status: response.status, data: await response.json() };
          }, storeImage: async () => { throw new Error("Read-only analytics must not store media"); }, mediaQuotaBlocked: async () => null,
        }, OWNER, new URLSearchParams({ social_account_id: accountId, period_days: "7", analyticsContractVersion: "1" }));
        assertEquals(proxied.status, 200);
        assertEquals(parseAnalyticsReport(proxied.body).metrics, mixedReport.metrics, "Worker → SQL → report → actual proxy preserves each measurement cause");
        assertEquals(mixedReport.sync.status, "failed");
        assertEquals(mixedReport.sync.reason, platform === "facebook" ? "permission_missing" : "reauth_required");
        if (platform === "facebook") {
          const engagement = mixedReport.metrics.find((metric: { definition: { key: string } }) => metric.definition.key === "engagements");
          assertEquals(engagement.trend[6].metric, { status: "unavailable", reason: "permission_missing" });
          assertEquals(mixedReport.metrics.find((metric: { definition: { key: string } }) => metric.definition.key === "views").trend[6].metric,
            { status: "available", value: 0 }, "An earlier successful metric in the same response plan remains saved");
          assertEquals(mixedReport.metrics.find((metric: { definition: { key: string } }) => metric.definition.key === "followers").trend[6].metric,
            { status: "unavailable", reason: "not_collected" }, "A refused request does not fabricate failure evidence for later unattempted metrics");
        } else assertEquals(mixedReport.metrics.find((metric: { definition: { key: string } }) => metric.definition.key === "followers").current,
          { status: "unavailable", reason: "reauth_required" });
        metricScenario = "normal";
        await runtime.exec(`SELECT public.enqueue_${family}_analytics_collection_job('${OWNER}','${accountId}',(clock_timestamp() AT TIME ZONE 'America/Los_Angeles')::date,true);`, SERVICE_ROLE);
        let throttledRequests = 0;
        globalThis.fetch = async (input, init) => {
          const outgoing = new Request(input, init);
          if (new URL(outgoing.url).origin === API) return await sqlRequest(outgoing);
          throttledRequests++;
          return Response.json({ error: { code: 4 } }, { status: 429, headers: { "Retry-After": "900" } });
        };
        const throttled = await drain();
        const throttledBody = await throttled.json();
        assertEquals(throttled.status, 200, JSON.stringify(throttledBody));
        assertEquals(throttledBody.reason, "rate_limited");
        assertEquals(throttledRequests, 1);
        await runtime.exec(`SELECT public.enqueue_${family}_analytics_collection_job('${OWNER}','${accountId}',(clock_timestamp() AT TIME ZONE 'America/Los_Angeles')::date-1,false);`, SERVICE_ROLE);
        const blocked = await drain();
        assertEquals(blocked.status, 200);
        assertEquals((await blocked.json()).reason, "rate_limited");
        assertEquals(throttledRequests, 1, "A later due date honors persisted authority-bucket backoff before HTTP");
      });
      assert(passed, "Stop after a failed real collection boundary");
    }
    const savedHealthPassed = await test.step("saved report retains measurements while expired connection health is failed", async () => {
      await runtime.exec(`UPDATE public.social_accounts SET needs_reauth=true,token_expires_at=clock_timestamp()-interval '1 hour' WHERE id='${PAGE}';`);
      const response = await reportRequest("facebook", PAGE);
      const report = await response.json();
      assertEquals(response.status, 200, JSON.stringify(report));
      assertEquals(report.sync.status, "failed");
      assertEquals(report.sync.reason, "reauth_required");
      assertEquals(report.posts.items[0].metrics.find((metric: { definition: { key: string } }) => metric.definition.key === "views").current, { status: "available", value: 0 });
    });
    assert(savedHealthPassed, "Stop after a saved connection-health report fails");
    const dryRunPassed = await test.step("registered retention dry run uses real independent scope without mutation", async () => {
      await runtime.exec(`UPDATE public.app_settings SET value=jsonb_build_object('account_ids',jsonb_build_array('${PAGE}')) WHERE key='retention_facebook_analytics_policy';
        UPDATE public.app_settings SET value=jsonb_build_object('account_ids',jsonb_build_array('${THREADS}')) WHERE key='retention_threads_analytics_policy';`);
      const revisions = () => runtime.queryJson(`SELECT jsonb_build_array(
        (SELECT report_revision FROM public.fb_analytics_report_state WHERE social_account_id='${PAGE}'),
        (SELECT report_revision FROM public.threads_analytics_report_state WHERE social_account_id='${THREADS}'));`);
      const before = await revisions();
      const response = await handler(new Request(API, { method: "POST", headers: { Authorization: "Bearer synthetic-cron", "Content-Type": "application/json" },
        body: JSON.stringify({ action: "retention", platform: "all", dryRun: true }) }));
      const receipt = await response.json();
      assertEquals(response.status, 200, JSON.stringify(receipt));
      assertEquals(receipt.status, "complete");
      assertEquals(receipt.counts, { targeted: 2, visited: 2, deleted: 0, wouldDelete: 0, skipped: 0, refused: 0 });
      assertEquals(await revisions(), before);
      assertEquals(await runtime.queryJson(`SELECT to_jsonb(count(*)) FROM public.meta_analytics_retention_visits WHERE user_id='${OWNER}';`), 0);
    });
    assert(dryRunPassed, "Stop after a registered retention dry-run failure");
    await runtime.exec(`UPDATE public.app_settings SET value='false'::jsonb WHERE key IN ('collection_facebook_analytics_enabled','collection_threads_analytics_enabled');`);
    const schedules = await runtime.queryJson(`SELECT jsonb_agg(jsonb_build_object('name',jobname,'command',command) ORDER BY jobname)
      FROM cron.job WHERE jobname ~ '^(facebook|threads)-analytics-(enqueue-daily|drain|retention)$';`);
    assert(Array.isArray(schedules) && schedules.length === 6, "Six real inactive schedule definitions required");
    for (const schedule of schedules) {
      const passed = await test.step(`stored schedule body: ${schedule.name}`, async () => {
        const matched = /body := '((?:[^']|'')*)'::jsonb/.exec(schedule.command);
        assert(matched, "Stored JSON literal must be extracted from the exact command");
        const body = JSON.parse(matched[1].replaceAll("''", "'"));
        const response = await handler(new Request(API, { method: "POST", headers: { Authorization: "Bearer synthetic-cron", "Content-Type": "application/json" }, body: JSON.stringify(body) }));
        const receipt = await response.json();
        assertEquals(response.status, 200, JSON.stringify(receipt));
        assertEquals(receipt.status, "disabled");
        assertEquals(receipt.action, body.action);
      });
      assert(passed, "Stop after a stored schedule body fails the registered route");
    }
  } catch (error) { failures.push(error); }
  finally {
    globalThis.fetch = oldFetch;
    try { if (snapshot) await runtime.exec(`UPDATE public.app_settings s SET value=e.value FROM jsonb_each(${literal(snapshot)}) e WHERE s.key=e.key;`); }
    catch (error) { failures.push(error); }
    try { if (turnSnapshot) await runtime.exec(`UPDATE public.meta_analytics_worker_turns t SET last_claimed_at=(e.value#>>'{}')::timestamptz FROM jsonb_each(${literal(turnSnapshot)}) e WHERE t.platform=e.key;`); }
    catch (error) { failures.push(error); }
    try { if (ownsFixture) await runtime.exec(`DELETE FROM public.system_logs WHERE id::text IN (SELECT jsonb_array_elements_text(${literal(auditIds)}));
      DELETE FROM public.meta_analytics_enqueue_sweeps WHERE policy_digest IN (SELECT jsonb_array_elements_text(${literal(sweepDigests)}));
      DELETE FROM public.instagram_provider_throttle_buckets WHERE bucket_key IN (SELECT jsonb_array_elements_text(${literal([...throttleKeys])}));
      DELETE FROM auth.users WHERE id='${OWNER}';`); }
    catch (error) { failures.push(error); }
    for (const [key, value] of previousEnvironment) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
    Deno.env.set("ROLLOUT_IT_CONTAINER", target);
    try { await releaseRolloutLease(runtime, lease); }
    catch (error) { failures.push(error); }
  }
  if (failures.length) throw new AggregateError(failures, "Disposable admission proof or cleanup failed");
});
