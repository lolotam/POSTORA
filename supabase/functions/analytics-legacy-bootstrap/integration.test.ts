import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { runLegacyBootstrap, type BootstrapRpc } from "./worker.ts";
import { parseOwnerAnalyticsReadiness } from "../_shared/ownerAnalyticsReadiness.ts";
import { parseFacebookUserAccountCredential, parseInstagramAccountCapability } from "../_shared/facebookUserCredentialStore.ts";

const container = Deno.env.get("ROLLOUT_IT_CONTAINER");
const database = Deno.env.get("ROLLOUT_IT_DB") ?? "partner_api_harness";
async function sql(statement: string): Promise<string> {
  if (!container || !/^[a-zA-Z0-9_-]+$/.test(container) || !/^[a-z_]+_harness$/.test(database)
    || /prod|live|primary/i.test(container + database)) throw new Error("Explicit disposable bootstrap harness required");
  const output = await new Deno.Command("docker", { args: ["exec", container!, "psql", "-U", "supabase_admin", "-d", database,
    "-XAt", "-v", "ON_ERROR_STOP=1", "-c", statement], stdout: "piped", stderr: "piped" }).output();
  if (!output.success) throw new Error("Bootstrap integration SQL failed");
  return new TextDecoder().decode(output.stdout).trim();
}
const quote = (argument: unknown) => argument === null ? "NULL" : typeof argument === "number" ? String(argument)
  : typeof argument === "object" ? `'${JSON.stringify(argument).replaceAll("'", "''")}'::jsonb`
  : `'${String(argument).replaceAll("'", "''")}'`;

const sqlRpc: BootstrapRpc = async (name, args) => {
  if (!/^[a-z_]+$/.test(name) || Object.keys(args).some((key) => !/^p_[a-z_]+$/.test(key))) throw new Error("Invalid fixture RPC");
  const result = await sql(`BEGIN; SET LOCAL request.jwt.claim.role='service_role';
    SET LOCAL request.jwt.claims='{"role":"service_role"}'; SELECT to_json(public.${name}(${Object.entries(args).map(([key, argument]) => `${key}=>${quote(argument)}`).join(",")})); COMMIT;`);
  const payload = JSON.parse(result.split("\n").find((line) => line.startsWith("{") || line === "true" || line === "null") ?? "null");
  return { data: payload, error: null };
};

Deno.test({ name: "registered worker reaches real capture/install/permission SQL and reconciles a lost install response", ignore: !container, fn: async () => {
  const owner = crypto.randomUUID();
  const page = crypto.randomUUID();
  const instagram = crypto.randomUUID();
  let oldSettings = "";
  let installs = 0;
  let providerCalls = 0;
  const userToken = crypto.randomUUID();
  const pageToken = crypto.randomUUID();
  try {
    oldSettings = await sql("SELECT jsonb_object_agg(key,value) FROM public.app_settings WHERE key LIKE 'analytics_legacy_bootstrap_%'");
    await sql(`BEGIN;
      INSERT INTO auth.users(id,email) VALUES('${owner}','${owner}@example.invalid');
      INSERT INTO public.social_accounts(id,user_id,platform,platform_user_id,platform_username,access_token,account_metadata,ig_auth_type)
      VALUES('${page}','${owner}','facebook','100701','fixture_page','${pageToken}',jsonb_build_object('user_token','${userToken}'::text),NULL),
        ('${instagram}','${owner}','instagram','178701','fixture_ig','${pageToken}','{"facebook_page_id":"100701"}','facebook_page');
      UPDATE public.app_settings SET value='true' WHERE key='analytics_legacy_bootstrap_enabled';
      UPDATE public.app_settings SET value=jsonb_build_object('version',1,'account_ids',jsonb_build_array('${instagram}'),
        'max_accounts_per_run',5,'max_attempts_per_account_per_day',3) WHERE key='analytics_legacy_bootstrap_policy';
      UPDATE public.analytics_legacy_bootstrap_run SET lease_until=NULL,pause_until=NULL; COMMIT;`);
    const rpc: BootstrapRpc = async (name, args) => {
      const result = await sqlRpc(name, args, AbortSignal.timeout(4_000));
      if (name === "commit_analytics_legacy_bootstrap" && ++installs === 1) throw new Error("Synthetic response lost after durable install");
      return result;
    };
    const replies = [
      { data: { is_valid: true, type: "USER", app_id: "200701", user_id: "300701", expires_at: 0, data_access_expires_at: 0 } },
      { id: "300701" }, { data: [{ id: "100701" }] }, { id: "100701", instagram_business_account: { id: "178701" } },
      { data: [{ permission: "instagram_manage_insights", status: "granted" }] },
    ];
    const facebookApp = { id: "200701", secret: crypto.randomUUID() };
    const outcome = await runLegacyBootstrap({ rpc, apps: { facebook: facebookApp, instagram: { id: "200702", secret: crypto.randomUUID() } },
      fetcher: async (request, init) => {
        providerCalls++;
        const url = new URL(String(request));
        const authorization = new Headers(init?.headers).get("Authorization");
        if (url.pathname.endsWith("/debug_token")) {
          assertEquals(url.searchParams.get("input_token") === userToken, true);
          assertEquals(authorization === `Bearer ${facebookApp.id}|${facebookApp.secret}`, true);
        } else if (url.pathname.endsWith("/me/permissions")) {
          assertEquals(url.searchParams.get("access_token") === userToken, true);
        } else assertEquals(authorization === `Bearer ${userToken}`, true);
        return Response.json(replies.shift());
      } });
    assertEquals(outcome.accounts[0].state, "ready");
    assertEquals(installs, 1);
    assertEquals(providerCalls, 5);
    assertEquals(await sql(`SELECT count(*) FROM public.instagram_collection_jobs WHERE social_account_id='${instagram}'`), "0");
    assertEquals(await sql(`SELECT credential_generation>=1 AND permission_read_state='ok' FROM public.instagram_account_capabilities WHERE social_account_id='${instagram}'`), "t");
    // Exercise the real post-bootstrap SQL payload through the runtime validators,
    // including the provenance label those readers deliberately do not project.
    const credential = JSON.parse(await sql(`SELECT public.read_facebook_user_account_credential('${owner}','${instagram}')`));
    const parsedCredential = parseFacebookUserAccountCredential("read_facebook_user_account_credential", credential);
    assertEquals(parsedCredential.found, true);
    assertEquals(parsedCredential.token === userToken, true);
    assertEquals(parsedCredential.credentialKind, "facebook_user");
    // The account reader intentionally omits provider identity; verify it at the installed grant.
    assertEquals(await sql(`SELECT provider_user_id FROM public.facebook_user_credentials WHERE id='${parsedCredential.credentialId}'`), "300701");
    // Compare against the Page row seeded with the same value, so no secret-shaped assignment literal appears in the test.
    assertEquals(await sql(`SELECT i.access_token = p.access_token FROM public.social_accounts i, public.social_accounts p WHERE i.id='${instagram}' AND p.id='${page}'`), "t");
    const capability = JSON.parse(await sql(`SELECT public.read_instagram_account_capability('${instagram}','${owner}')`));
    assertEquals(parseInstagramAccountCapability("read_instagram_account_capability", capability).scopesAuthoritative, true);
    assertEquals(await sql(`SELECT evidence_source FROM public.facebook_user_credential_bindings WHERE social_account_id='${instagram}'`), "verified_legacy_bootstrap");
  } finally {
    await sql(`BEGIN; DELETE FROM auth.users WHERE id='${owner}';
      UPDATE public.analytics_legacy_bootstrap_run SET holder=NULL,lease_until=NULL,pause_until=NULL,calls=0;
      ${oldSettings ? `UPDATE public.app_settings a SET value=e.value FROM jsonb_each(${quote(JSON.parse(oldSettings))}) e WHERE a.key=e.key;` : ""} COMMIT;`);
  }
} });

Deno.test({ name: "fourteen-day provider pause settles a seven-day job retry and releases the real SQL lease", ignore: !container, fn: async () => {
  const owner = crypto.randomUUID();
  const page = crypto.randomUUID();
  const instagram = crypto.randomUUID();
  const appId = String(crypto.getRandomValues(new Uint32Array(1))[0]);
  let oldSettings = "";
  try {
    oldSettings = await sql("SELECT jsonb_object_agg(key,value) FROM public.app_settings WHERE key LIKE 'analytics_legacy_bootstrap_%'");
    await sql(`BEGIN;
      INSERT INTO auth.users(id,email) VALUES('${owner}','${owner}@example.invalid');
      INSERT INTO public.social_accounts(id,user_id,platform,platform_user_id,platform_username,access_token,account_metadata,ig_auth_type)
      VALUES('${page}','${owner}','facebook','100801','fixture_page',gen_random_uuid()::text,jsonb_build_object('user_token',gen_random_uuid()::text),NULL),
        ('${instagram}','${owner}','instagram','178801','fixture_ig',gen_random_uuid()::text,'{"facebook_page_id":"100801"}','facebook_page');
      UPDATE public.app_settings SET value='true' WHERE key='analytics_legacy_bootstrap_enabled';
      UPDATE public.app_settings SET value=jsonb_build_object('version',1,'account_ids',jsonb_build_array('${instagram}'),
        'max_accounts_per_run',5,'max_attempts_per_account_per_day',3) WHERE key='analytics_legacy_bootstrap_policy';
      UPDATE public.analytics_legacy_bootstrap_run SET lease_until=NULL,pause_until=NULL; COMMIT;`);
    const started = Date.now();
    const outcome = await runLegacyBootstrap({ rpc: sqlRpc,
      apps: { facebook: { id: appId, secret: crypto.randomUUID() }, instagram: { id: appId, secret: crypto.randomUUID() } },
      fetcher: () => Promise.resolve(Response.json({ error: { code: 4 } }, { status: 429, headers: { "retry-after": "1209600" } })) });
    assertEquals(outcome.accounts[0].state, "retry");
    assertEquals(outcome.accounts[0].reason_code, "rate_limited");
    const job = JSON.parse(await sql(`SELECT jsonb_build_object('released',lease_id IS NULL AND lease_until IS NULL,'retry_at',retry_at)
      FROM public.analytics_legacy_bootstrap_jobs WHERE social_account_id='${instagram}'`));
    assertEquals(job.released, true);
    assertEquals(Date.parse(job.retry_at) >= started + 7 * 86_400_000, true);
    assertEquals(Date.parse(job.retry_at) <= Date.now() + 7 * 86_400_000, true);
    assertEquals(await sql(`SELECT throttled_until>clock_timestamp()+interval '13 days' FROM public.instagram_provider_throttle_buckets
      WHERE bucket_key=encode(extensions.digest('owned_analytics:app:facebook:${appId}','sha256'),'hex')`), "t");
  } finally {
    await sql(`BEGIN; DELETE FROM auth.users WHERE id='${owner}';
      DELETE FROM public.instagram_provider_throttle_buckets
        WHERE bucket_key=encode(extensions.digest('owned_analytics:app:facebook:${appId}','sha256'),'hex');
      UPDATE public.analytics_legacy_bootstrap_run SET holder=NULL,lease_until=NULL,pause_until=NULL,calls=0;
      ${oldSettings ? `UPDATE public.app_settings a SET value=e.value FROM jsonb_each(${quote(JSON.parse(oldSettings))}) e WHERE a.key=e.key;` : ""} COMMIT;`);
  }
} });

Deno.test({ name: "legacy direct fallback is explicit; a NEW lifecycle direct reconnect reaches trusted permission capability", ignore: !container, fn: async () => {
  const owner = crypto.randomUUID();
  const account = crypto.randomUUID();
  const canonical = "17890701";
  const legacyToken = crypto.randomUUID();
  const lifecycleToken = crypto.randomUUID();
  let settings = "";
  let calls = 0;
  try {
    settings = await sql("SELECT jsonb_object_agg(key,value) FROM public.app_settings WHERE key LIKE 'analytics_legacy_bootstrap_%' OR key='credential_facebook_user_mode'");
    await sql(`BEGIN;
      INSERT INTO auth.users(id,email) VALUES('${owner}','${owner}@example.invalid');
      INSERT INTO public.social_accounts(id,user_id,platform,platform_user_id,platform_username,access_token,ig_auth_type,account_metadata)
      VALUES('${account}','${owner}','instagram','${canonical}','fixture_direct','${legacyToken}','business_login',
        '{"flow":"direct","source":"instagram_business_login","ig_user_id":"${canonical}"}');
      INSERT INTO public.app_settings(key,value) VALUES('credential_facebook_user_mode','"protected"') ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value;
      UPDATE public.app_settings SET value='true' WHERE key='analytics_legacy_bootstrap_enabled';
      UPDATE public.app_settings SET value=jsonb_build_object('version',1,'account_ids',jsonb_build_array('${account}'),
        'max_accounts_per_run',5,'max_attempts_per_account_per_day',3) WHERE key='analytics_legacy_bootstrap_policy';
      UPDATE public.analytics_legacy_bootstrap_run SET lease_until=NULL,pause_until=NULL; COMMIT;`);
    const apps = { facebook: { id: "20090701", secret: crypto.randomUUID() }, instagram: { id: "20090702", secret: crypto.randomUUID() } };
    const first = await runLegacyBootstrap({ rpc: sqlRpc, apps, fetcher: async (request, init) => {
      calls++;
      const url = new URL(String(request));
      assertEquals(url.origin, "https://graph.instagram.com");
      assertEquals(url.pathname, "/v22.0/me");
      assertEquals(new Headers(init?.headers).get("Authorization") === `Bearer ${legacyToken}`, true);
      return Response.json({ id: canonical, user_id: "99090701" });
    } });
    assertEquals(first.accounts[0].state, "needs_reconnect");
    assertEquals(first.accounts[0].reason_code, "direct_verification_unsupported");
    assertEquals(first.accounts[0].next_action, "supported_reconnect");
    assertEquals(first.accounts[0].reconnect_path, "/profiles");
    assertEquals(calls, 1);
    assertEquals(await sql(`SELECT count(*) FROM public.instagram_account_capabilities WHERE social_account_id='${account}'`), "0");
    assertEquals(await sql(`SELECT count(*) FROM public.facebook_user_credential_bindings WHERE social_account_id='${account}'`), "0");
    const snapshot = await sqlRpc("read_instagram_owner_report_snapshot", { p_user_id: owner, p_account_id: account,
      p_as_of: new Date().toISOString() }, AbortSignal.timeout(4_000)) as { data: { readiness: unknown } };
    assertEquals(parseOwnerAnalyticsReadiness(snapshot.data.readiness).connection.reason_code, "direct_verification_unsupported");

    // Drive the real durable OAuth lifecycle, not bootstrap evidence injection.
    await sql(`BEGIN; SET LOCAL request.jwt.claim.role='service_role'; SET LOCAL request.jwt.claims='{"role":"service_role"}';
      DO $lifecycle$ DECLARE begun jsonb;claimed jsonb;receipt jsonb;BEGIN
        begun:=public.begin_meta_oauth_attempt('${owner}',jsonb_build_object('flow','instagram_direct','intent','reconnect','target_social_account_id','${account}'));
        claimed:=public.claim_meta_oauth_callback('${owner}',jsonb_build_object('attempt_id',begun->>'attempt_id','nonce',begun->>'nonce','flow','instagram_direct'));
        PERFORM public.complete_meta_oauth_callback('${owner}',jsonb_build_object('attempt_id',begun->>'attempt_id','claim_token',claimed->>'claim_token',
          'stash',jsonb_build_object('candidates',jsonb_build_array(jsonb_build_object('ig_user_id','${canonical}','ig_username','fixture_direct')),'user_token','${lifecycleToken}')));
        receipt:=public.commit_meta_oauth_selection('${owner}',jsonb_build_object('attempt_id',begun->>'attempt_id','selection_key','instagram_direct:ig:${canonical}'));
        ASSERT receipt->>'social_account_id'='${account}';
        ASSERT receipt->>'login_kind'='direct' AND receipt->>'credential_id' IS NULL;
      END;$lifecycle$;
      UPDATE public.analytics_legacy_bootstrap_run SET lease_until=NULL,pause_until=NULL; COMMIT;`);
    const second = await runLegacyBootstrap({ rpc: sqlRpc, apps, fetcher: async (request) => {
      calls++;
      const url = new URL(String(request));
      assertEquals(url.origin, "https://graph.instagram.com");
      assertEquals(url.pathname, "/v22.0/me/permissions");
      assertEquals(url.searchParams.get("access_token") === lifecycleToken, true);
      return Response.json({ data: [{ permission: "instagram_business_manage_insights", status: "granted" }] });
    } });
    assertEquals(second.accounts[0].state, "ready");
    assertEquals(calls, 2);
    assertEquals(await sql(`SELECT login_kind='direct' AND credential_generation>0 AND permission_read_state='ok' AND granted_scopes @> ARRAY['instagram_business_manage_insights']
      FROM public.instagram_account_capabilities WHERE social_account_id='${account}'`), "t");
    assertEquals(await sql(`SELECT count(*) FROM public.facebook_user_credential_bindings WHERE social_account_id='${account}'`), "0");
    assertEquals(JSON.stringify([first, second]).includes(legacyToken), false);
    assertEquals(JSON.stringify([first, second]).includes(lifecycleToken), false);
  } finally {
    await sql(`BEGIN; DELETE FROM auth.users WHERE id='${owner}';
      UPDATE public.analytics_legacy_bootstrap_run SET holder=NULL,lease_until=NULL,pause_until=NULL,calls=0;
      DELETE FROM public.app_settings WHERE key='credential_facebook_user_mode' AND NOT (${quote(JSON.parse(settings || "{}"))} ? key);
      ${settings ? `UPDATE public.app_settings a SET value=e.value FROM jsonb_each(${quote(JSON.parse(settings))}) e WHERE a.key=e.key;` : ""} COMMIT;`);
  }
} });
