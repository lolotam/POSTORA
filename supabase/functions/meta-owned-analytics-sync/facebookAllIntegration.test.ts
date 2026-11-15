import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { acquireRolloutLease, releaseRolloutLease, resolveRolloutRuntime, RolloutSqlError, SERVICE_ROLE } from "../_shared/rolloutIntegrationTestSupport.ts";

const owner = "e7100000-0000-4000-8000-000000000001";
const foreign = "e7100000-0000-4000-8000-000000000002";
const credentialId = "e7300000-0000-4000-8000-000000000001";
const account = (index: number) => `e7200000-0000-4000-8000-${String(index).padStart(12, "0")}`;
const api = "https://phase6-analytics.invalid";
const authorization = (value: string) => ["Bearer", value].join(" ");
const literal = (value: unknown) => `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`;

Deno.test("registered Facebook all drain resumes SQL cursor, reconciles loss, fences owners and enrolls a future Page", async () => {
  const runtime = resolveRolloutRuntime();
  const lease = crypto.randomUUID();
  await acquireRolloutLease(runtime, lease);
  const originalFetch = globalThis.fetch;
  const envKeys = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "CRON_SECRET", "FACEBOOK_APP_ID", "FACEBOOK_APP_SECRET"];
  const originalEnv = new Map(envKeys.map((key) => [key, Deno.env.get(key)]));
  const service = crypto.randomUUID();
  const cron = crypto.randomUUID();
  const userToken = crypto.randomUUID();
  const pageToken = crypto.randomUUID();
  const newPageToken = crypto.randomUUID();
  const appSecret = crypto.randomUUID();
  let savedSettings: unknown;
  let savedTurns: unknown;
  let fixtureOwned = false;
  let loseCommit = true;
  let explicitStart = false;
  const providerCalls: string[] = [];
  const sweepDigests = new Set<string>();
  const auditIds: unknown[] = [];
  const throttleKeys = new Set<string>();
  const pageSetup = (id: string) => `
    INSERT INTO public.facebook_user_credential_connection_fences(social_account_id,user_id,platform) VALUES('${id}','${owner}','facebook');
    INSERT INTO public.facebook_user_credential_bindings(social_account_id,user_id,platform,credential_id,verified_facebook_user_id,evidence_source)
      VALUES('${id}','${owner}','facebook','${credentialId}','868701','oauth_exchange');
    -- The ordinary collector, not fixture SQL, obtains permission evidence.
  `;
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin === api) {
      const body = await request.json();
      if (url.pathname === "/rest/v1/system_logs") {
        const id = await runtime.queryJson(`INSERT INTO public.system_logs(level,category,source,message,metadata)
          SELECT x.level,x.category,x.source,x.message,x.metadata FROM jsonb_to_record(${literal(body)})
          AS x(level text,category text,source text,message text,metadata jsonb) RETURNING to_jsonb(id);`, SERVICE_ROLE);
        auditIds.push(id);
        return new Response(null, { status: 201 });
      }
      const name = url.pathname.slice("/rest/v1/rpc/".length);
      assert(/^(read|observe|claim|reserve|commit|persist|complete|record|next)_/.test(name), "Unexpected fixture RPC");
      if (name === "next_meta_analytics_dispatch_target") assertEquals(body.p_start, explicitStart, "Only explicit enqueue-daily may open a round");
      if (name === "record_instagram_provider_throttle_http") throttleKeys.add(body.p_bucket_key);
      try {
        const reply = await runtime.callRpc(name, body, SERVICE_ROLE);
        if (name === "next_meta_analytics_dispatch_target" && reply && typeof reply === "object" && "ticket" in reply) {
          sweepDigests.add((reply as { ticket: { policy_digest: string } }).ticket.policy_digest);
          // enqueue-daily sets start only on its first next-target call.
          explicitStart = false;
        }
        if (name === "commit_meta_analytics_dispatch_target" && loseCommit) {
          loseCommit = false;
          return Response.json({ code: "57014", message: "Synthetic lost committed cursor response" }, { status: 503 });
        }
        return Response.json(reply);
      } catch (error) {
        if (!(error instanceof RolloutSqlError)) throw error;
        return Response.json({ code: error.sqlstate, message: "Synthetic SQL refusal" }, { status: 400 });
      }
    }
    assertEquals(url.origin, "https://graph.facebook.com", "No foreign or paid provider calls");
    providerCalls.push(url.pathname);
    const headers = { "facebook-api-version": "v25.0" };
    if (url.pathname === "/v25.0/debug_token") {
      assertEquals(url.searchParams.get("input_token"), userToken);
      assertEquals(request.headers.get("authorization"), authorization(["867701", appSecret].join("|")));
      return Response.json({ data: { is_valid: true, app_id: "867701", user_id: "868701", scopes: ["read_insights", "pages_read_engagement"] } }, { headers });
    }
    const pageId = request.headers.get("authorization") === authorization(pageToken) ? "869752"
      : request.headers.get("authorization") === authorization(newPageToken) ? "869799" : null;
    assert(pageId !== null, "Only an owned ready Page token may leave the process");
    if (url.pathname === "/v25.0/me") return Response.json({ id: pageId }, { headers });
    assert(new RegExp(`^/v25\\.0/${pageId}/(posts|insights)$`).test(url.pathname), "Only the ready token's Page receives measurement calls");
    return Response.json({ data: [] }, { headers });
  };
  try {
    assertEquals(await runtime.queryJson(`SELECT to_jsonb(count(*)) FROM auth.users WHERE id IN ('${owner}','${foreign}');`), 0);
    assertEquals(await runtime.queryJson("SELECT to_jsonb(count(*)) FROM public.social_accounts WHERE platform='facebook' AND is_active;"), 0,
      "Array-free all fixture requires its own empty disposable population");
    savedSettings = await runtime.queryJson("SELECT jsonb_object_agg(key,value) FROM public.app_settings WHERE key IN ('collection_facebook_analytics_enabled','collection_facebook_analytics_policy','collection_threads_analytics_enabled');");
    savedTurns = await runtime.queryJson("SELECT jsonb_object_agg(platform,last_claimed_at) FROM public.meta_analytics_worker_turns;");
    await runtime.exec(`BEGIN;
      INSERT INTO auth.users(id,email) VALUES('${owner}','phase6-runtime-one@example.invalid'),('${foreign}','phase6-runtime-two@example.invalid');
      INSERT INTO public.social_accounts(id,user_id,platform,platform_user_id,access_token,is_active,needs_reauth)
        SELECT ('e7200000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid,
          CASE WHEN i=52 THEN '${owner}'::uuid ELSE '${foreign}'::uuid END,'facebook',(869700+i)::text,
          CASE WHEN i=52 THEN ${literal(pageToken)}#>>'{}' ELSE gen_random_uuid()::text END,true,false FROM generate_series(1,52) i;
      INSERT INTO public.facebook_user_credentials(id,user_id,token,provider_user_id,provenance_source,provenance_captured_at)
        VALUES('${credentialId}','${owner}',${literal(userToken)}#>>'{}','868701','oauth_exchange',clock_timestamp());
      ${pageSetup(account(52))}
      UPDATE public.app_settings SET value='true' WHERE key='collection_facebook_analytics_enabled';
      UPDATE public.app_settings SET value='false' WHERE key='collection_threads_analytics_enabled';
      DO $policy$ DECLARE s jsonb;r jsonb; BEGIN
        s:=public.get_facebook_analytics_collection_policy();
        r:=public.set_facebook_analytics_collection_policy(s->>'fingerprint',(s->>'revision')::bigint,'{"version":2,"mode":"all","account_ids":[]}','phase6 integration','local only');
        ASSERT r->>'ok'='true'; END;$policy$;
      COMMIT;`);
    fixtureOwned = true;
    const digest = await runtime.queryJson(`DO $prefix$ DECLARE t jsonb; BEGIN
      PERFORM set_config('request.jwt.claim.role','service_role',true);
      FOR i IN 1..50 LOOP
        t:=public.next_meta_analytics_dispatch_target('facebook',i=1)->'ticket';
        PERFORM public.commit_meta_analytics_dispatch_target(t,'refused','admission_refused');
      END LOOP; END;$prefix$;
      SELECT to_jsonb(public.meta_analytics_collection_policy('facebook')->>'policy_digest');`);
    assert(typeof digest === "string"); sweepDigests.add(digest);
    for (const [key, value] of Object.entries({ SUPABASE_URL: api, SUPABASE_SERVICE_ROLE_KEY: service, CRON_SECRET: cron,
      FACEBOOK_APP_ID: "867701", FACEBOOK_APP_SECRET: appSecret })) Deno.env.set(key, value);
    const { handler } = await import("./index.ts");
    const invoke = (body: unknown) => handler(new Request(api, { method: "POST", headers: { Authorization: authorization(cron), "Content-Type": "application/json" }, body: JSON.stringify(body) }));
    const lost = await invoke({ action: "drain", platform: "facebook" });
    assertEquals(lost.status, 503);
    assertEquals(providerCalls.length, 0, "An ambiguous cursor write stops before all provider work");
    const resumed = await invoke({ action: "drain", platform: "facebook" });
    const receipt = await resumed.json();
    assertEquals(resumed.status, 200, JSON.stringify(receipt));
    assertEquals(receipt.resume.counts, { visited: 1, queued: 1, refused: 0 });
    assertEquals(await runtime.queryJson(`SELECT to_jsonb(count(*)) FROM public.fb_analytics_collection_jobs WHERE social_account_id='${account(52)}';`), 1);
    assert(providerCalls.includes("/v25.0/debug_token") && providerCalls.includes("/v25.0/me"));
    assert(providerCalls.some((path) => path.endsWith("/posts")), "The same drain reaches measurement work after resume");
    const beforeForeign = providerCalls.length;
    const foreignReply = await handler(new Request(api, { method: "POST", headers: { Authorization: authorization(service), "Content-Type": "application/json" },
      body: JSON.stringify({ action: "enqueue", platform: "facebook", user_id: foreign, accountId: account(52) }) }));
    assertEquals(foreignReply.status, 404);
    assertEquals(providerCalls.length, beforeForeign, "Foreign owner refusal has zero provider calls");
    const beforeRound = await runtime.queryJson(`SELECT to_jsonb(dispatch_round) FROM public.meta_analytics_enqueue_sweeps WHERE policy_digest='${digest}';`);
    // A new Page behind the cursor is visible without editing the all policy.
    await runtime.exec(`INSERT INTO public.social_accounts(id,user_id,platform,platform_user_id,access_token,is_active,needs_reauth)
      VALUES('${account(0)}','${owner}','facebook','869799',${literal(newPageToken)}#>>'{}',true,false); ${pageSetup(account(0))}`);
    await invoke({ action: "drain", platform: "facebook" });
    assertEquals(await runtime.queryJson(`SELECT to_jsonb(dispatch_round) FROM public.meta_analytics_enqueue_sweeps WHERE policy_digest='${digest}';`), beforeRound);
    explicitStart = true;
    const started = await invoke({ action: "enqueue-daily", platform: "facebook" });
    assertEquals(started.status, 200);
    assertEquals(await runtime.queryJson(`SELECT to_jsonb(count(*)) FROM public.fb_analytics_sweep_outcomes o
      JOIN public.meta_analytics_enqueue_sweeps s USING(platform,due_on,policy_digest,dispatch_round)
      WHERE o.social_account_id='${account(0)}';`), 1, "Hourly explicit dispatcher enrolls the behind-cursor connection");
    assertEquals(await runtime.queryJson(`SELECT to_jsonb(count(*)) FROM public.fb_analytics_collection_jobs WHERE social_account_id='${account(0)}';`), 1,
      "A ready future Page gets its normal job without a policy edit");
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of originalEnv) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
    try {
      if (fixtureOwned) {
        await runtime.exec(`BEGIN;
          UPDATE public.app_settings s SET value=e.value FROM jsonb_each(${literal(savedSettings)}) e WHERE s.key=e.key;
          UPDATE public.meta_analytics_worker_turns t SET last_claimed_at=(e.value#>>'{}')::timestamptz FROM jsonb_each(${literal(savedTurns)}) e WHERE t.platform=e.key;
          DELETE FROM public.meta_analytics_enqueue_sweeps WHERE platform='facebook' AND policy_digest IN (SELECT jsonb_array_elements_text(${literal([...sweepDigests])}));
          DELETE FROM auth.users WHERE id IN ('${owner}','${foreign}');
          DELETE FROM public.system_logs WHERE id::text IN (SELECT jsonb_array_elements_text(${literal(auditIds)}));
          DELETE FROM public.instagram_provider_throttle_buckets WHERE bucket_key IN (SELECT jsonb_array_elements_text(${literal([...throttleKeys])}));
          COMMIT;`);
      }
    } finally { await releaseRolloutLease(runtime, lease); }
  }
});
