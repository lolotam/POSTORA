import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { resolveRolloutRuntime, RolloutSqlError, SERVICE_ROLE, acquireRolloutLease, releaseRolloutLease } from "../_shared/rolloutIntegrationTestSupport.ts";
import { handler } from "./index.ts";

const OWNER = "a1000000-0000-4000-8000-000000000001";
const PAGE = "a2000000-0000-4000-8000-000000000001";
const THREADS = "a3000000-0000-4000-8000-000000000001";
const CREDENTIAL = "a5000000-0000-4000-8000-000000000001";
const API = "https://owned-analytics.invalid";
const literal = (value: unknown) => `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`;
const settingKeys = "'collection_facebook_analytics_enabled','collection_threads_analytics_enabled','collection_facebook_analytics_policy','collection_threads_analytics_policy'";

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
  let ownsFixture = false;
  const failures: unknown[] = [];
  const auditIds: unknown[] = [];
  const sweepDigests: string[] = [];
  let loseCommitResponse = false;
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
      || ["next_meta_analytics_dispatch_target", "commit_meta_analytics_dispatch_target"].includes(name), "Unexpected RPC refused");
    try {
      const result = await runtime.callRpc(name, body, SERVICE_ROLE);
      if (loseCommitResponse && name === "commit_meta_analytics_dispatch_target") {
        loseCommitResponse = false;
        return Response.json({ code: "57014", message: "Synthetic lost commit response" }, { status: 503 });
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
  } catch (error) { failures.push(error); }
  finally {
    globalThis.fetch = oldFetch;
    try { if (snapshot) await runtime.exec(`UPDATE public.app_settings s SET value=e.value FROM jsonb_each(${literal(snapshot)}) e WHERE s.key=e.key;`); }
    catch (error) { failures.push(error); }
    try { if (ownsFixture) await runtime.exec(`DELETE FROM public.system_logs WHERE id::text IN (SELECT jsonb_array_elements_text(${literal(auditIds)}));
      DELETE FROM public.meta_analytics_enqueue_sweeps WHERE policy_digest IN (SELECT jsonb_array_elements_text(${literal(sweepDigests)}));
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
