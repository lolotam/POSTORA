/** Disposable SQL history, never canned report/mutation responses or completed worker receipts. */
import { ownerReleaseSql, syntheticOwnerReleaseKey } from "./instagramOwnerReleaseSeed.ts";
import { fileURLToPath } from "node:url";
import { assertPreparedOwnerExecutionSource } from "../../scripts/instagram-owner-execution-source.mjs";
import {
  INSTAGRAM_RELEASE, assertInstagramReleaseCleanupIdentity, assertInstagramReleaseManifest,
  createInstagramReleaseManifest, requireInstagramReleaseLogin, type InstagramReleaseManifest,
} from "./instagramRelease.ts";

type SavedSetting = { key: string; value: unknown; description: string | null };
export interface InstagramReleaseSeed { manifest: InstagramReleaseManifest; previousSettings: SavedSetting[] }
const SETTING_KEYS = ["collection_instagram_insights_enabled", "collection_instagram_rollout_policy", "credential_facebook_user_mode", "apify_enabled", "brand_scrape_max_posts"];
const jsonSql = (payload: unknown): string => `'${JSON.stringify(payload).replaceAll("'", "''")}'::jsonb`;

async function authAdmin(path: string, init: RequestInit = {}): Promise<Response> {
  const serviceKey = await syntheticOwnerReleaseKey("service_role");
  return fetch(`${INSTAGRAM_RELEASE.authUrl}/admin/users${path}`, { ...init,
    headers: { Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" }, redirect: "error", signal: AbortSignal.timeout(10_000) });
}

async function createReleaseUsers(manifest: InstagramReleaseManifest): Promise<void> {
  for (const user of Object.values(manifest.users)) {
    const response = await authAdmin("", { method: "POST", body: JSON.stringify({ id: user.id, email: user.email,
      password: INSTAGRAM_RELEASE.password, email_confirm: true, role: "authenticated",
      app_metadata: { instagram_release_namespace: manifest.namespace } }) });
    if (!response.ok) throw new Error(`Instagram release synthetic Auth creation failed (${response.status})`);
    assertInstagramReleaseCleanupIdentity(manifest, await response.json());
    const login = await fetch(`${INSTAGRAM_RELEASE.authUrl}/token?grant_type=password`, { method: "POST",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: user.email, password: INSTAGRAM_RELEASE.password }),
      redirect: "error", signal: AbortSignal.timeout(10_000) });
    await requireInstagramReleaseLogin(login, user.id);
  }
}

async function pristineReleaseDatabase(): Promise<void> {
  const receipt = JSON.parse(await ownerReleaseSql(`SELECT jsonb_build_object('database',current_database(),
    'users',(SELECT count(*) FROM auth.users),'active_cron',(SELECT count(*) FROM cron.job WHERE active),
    'cron_launcher',current_setting('cron.launch_active_jobs'),
    'required',to_regclass('public.competitor_capture_coverage') IS NOT NULL
      AND to_regprocedure('public.read_own_competitor_quota()') IS NOT NULL
      AND to_regprocedure('public.persist_competitor_collection_result_v2(uuid,uuid,bigint,jsonb)') IS NOT NULL);`));
  if (receipt.database !== "postora_owner_release_harness" || receipt.users !== 0 || receipt.active_cron !== 0
    || receipt.cron_launcher !== "off" || receipt.required !== true) throw new Error("Instagram release fixture requires a pristine migrated database and disabled cron");
}

export async function seedInstagramRelease(): Promise<InstagramReleaseSeed> {
  assertPreparedOwnerExecutionSource(fileURLToPath(new URL("../../", import.meta.url)));
  await pristineReleaseDatabase();
  const referenceInstant = JSON.parse(await ownerReleaseSql("SELECT to_json(clock_timestamp());"));
  const manifest = createInstagramReleaseManifest(referenceInstant);
  const previousSettings = JSON.parse(await ownerReleaseSql(`SELECT COALESCE(jsonb_agg(jsonb_build_object('key',key,'value',value,'description',description)),'[]'::jsonb)
    FROM public.app_settings WHERE key IN (SELECT jsonb_array_elements_text(${jsonSql(SETTING_KEYS)}));`)) as SavedSetting[];
  await ownerReleaseSql(`INSERT INTO public.app_settings(key,value,description)
    VALUES('test_instagram_release_namespace',${jsonSql(manifest.namespace)},'Exclusive disposable canonical fixture lease');`);
  const seed = { manifest, previousSettings };
  try {
    await createReleaseUsers(manifest);
    await ownerReleaseSql(releaseSeedSql(manifest));
    return seed;
  } catch (failure) {
    // Cleanup failures remain visible alongside the original boot failure.
    try { await cleanupInstagramRelease(seed); } catch (cleanupFailure) { throw new AggregateError([failure, cleanupFailure], "Instagram release setup and cleanup failed"); }
    throw failure;
  }
}

export async function cleanupInstagramRelease(seed: InstagramReleaseSeed): Promise<void> {
  assertPreparedOwnerExecutionSource(fileURLToPath(new URL("../../", import.meta.url)));
  assertInstagramReleaseManifest(seed.manifest);
  const namespace = JSON.parse(await ownerReleaseSql("SELECT value FROM public.app_settings WHERE key='test_instagram_release_namespace';"));
  if (namespace !== seed.manifest.namespace) throw new Error("Refusing cleanup without the owned Instagram release namespace lease");
  const ownedUsers: string[] = [];
  for (const user of Object.values(seed.manifest.users)) {
    const response = await authAdmin(`/${user.id}`);
    if (response.status === 404) continue;
    if (!response.ok) throw new Error("Instagram release cleanup identity read failed");
    assertInstagramReleaseCleanupIdentity(seed.manifest, await response.json());
    ownedUsers.push(user.id);
  }
  await cleanupReleaseChildren(ownedUsers);
  for (const id of ownedUsers) {
    const response = await authAdmin(`/${id}`, { method: "DELETE" });
    if (!response.ok) throw new Error("Instagram release cleanup failed");
  }
  await restoreReleaseSettings(seed.previousSettings);
  await ownerReleaseSql(`DELETE FROM public.app_settings WHERE key='test_instagram_release_namespace' AND value=${jsonSql(seed.manifest.namespace)};`);
  const remaining = await ownerReleaseSql(`SELECT count(*) FROM auth.users WHERE id IN (SELECT (entry->>'id')::uuid FROM jsonb_array_elements(${jsonSql(Object.values(seed.manifest.users))}) entry);`);
  if (remaining !== "0") throw new Error("Instagram release cleanup left owned identities");
}

async function cleanupReleaseChildren(ownedUsers: string[]): Promise<void> {
  await ownerReleaseSql(`BEGIN;
DO $leases$ BEGIN
 IF EXISTS(SELECT 1 FROM public.instagram_collection_jobs WHERE user_id IN (SELECT jsonb_array_elements_text(${jsonSql(ownedUsers)})::uuid)
  AND lease_token IS NOT NULL AND lease_expires_at>clock_timestamp()) THEN RAISE EXCEPTION 'Canonical fixture worker still has a live lease';END IF;
END;$leases$;
DELETE FROM public.brand_scrape_sessions WHERE user_id IN (SELECT jsonb_array_elements_text(${jsonSql(ownedUsers)})::uuid);
DELETE FROM public.brand_scrape_cache WHERE EXISTS(SELECT 1 FROM jsonb_array_elements_text(${jsonSql(ownedUsers)}) AS owners(owner_id)
 WHERE cache_key LIKE 'instagram:v2:'||owner_id||':%');
COMMIT;`);
}

async function restoreReleaseSettings(previousSettings: SavedSetting[]): Promise<void> {
  await ownerReleaseSql(`BEGIN;
DELETE FROM public.app_settings WHERE key IN (SELECT jsonb_array_elements_text(${jsonSql(SETTING_KEYS)}));
INSERT INTO public.app_settings(key,value,description)
SELECT entry->>'key',entry->'value',entry->>'description' FROM jsonb_array_elements(${jsonSql(previousSettings)}) entry;
COMMIT;`);
}

function releaseSeedSql(manifest: InstagramReleaseManifest): string {
  assertInstagramReleaseManifest(manifest);
  return `BEGIN;
CREATE TEMP TABLE release_fixture AS SELECT ${jsonSql(manifest)} AS manifest;
INSERT INTO public.user_roles(user_id,role) VALUES ('${manifest.users.admin.id}','admin') ON CONFLICT DO NOTHING;
INSERT INTO public.user_quotas(user_id,max_tracked_competitors) VALUES
 ('${manifest.users.ownerA.id}',20),('${manifest.users.ownerB.id}',5),('${manifest.users.admin.id}',0)
 ON CONFLICT(user_id) DO UPDATE SET max_tracked_competitors=EXCLUDED.max_tracked_competitors;
${accountSeedSql()}
${watchlistSeedSql()}
${ownerHistorySeedSql()}
${competitorHistorySeedSql()}
${discoveryHistorySeedSql()}
${releaseSettingsSql(manifest)}
DO $verify$ BEGIN
 IF (SELECT count(*) FROM public.user_roles WHERE user_id IN ('${manifest.users.ownerA.id}','${manifest.users.ownerB.id}') AND role='admin')<>0 THEN
  RAISE EXCEPTION 'Canonical owners must not be admins';
 END IF;
END;$verify$;
COMMIT;`;
}

function accountSeedSql(): string {
  return `DO $accounts$
DECLARE a jsonb; m jsonb; u uuid; t timestamptz; scopes text[];
BEGIN
 SELECT manifest INTO STRICT m FROM release_fixture;t:=(m->>'referenceInstant')::timestamptz;
 FOR a IN SELECT value FROM jsonb_array_elements(m->'accounts') LOOP
  u:=(m->'users'->(a->>'owner')->>'id')::uuid;
  INSERT INTO public.social_accounts(id,user_id,platform,platform_user_id,platform_username,access_token,ig_auth_type,is_active,needs_reauth,connected_at,token_expires_at)
  VALUES((a->>'id')::uuid,u,'instagram',a->>'providerId',a->>'username',a->>'token',
    CASE a->>'loginKind' WHEN 'direct' THEN 'business_login' ELSE 'facebook_page' END,true,false,
    t-interval '1 day'-CASE WHEN a->>'key'='pageGranted' THEN interval '0 seconds' ELSE interval '1 hour' END,
    CASE WHEN a->>'authority'='expired' THEN t-interval '1 hour' ELSE t+interval '30 days' END);
  scopes:=CASE WHEN a->>'authority' IN ('granted','expired') THEN
   CASE a->>'loginKind' WHEN 'direct' THEN ARRAY['instagram_business_basic','instagram_business_manage_insights'] ELSE ARRAY['instagram_basic','instagram_manage_insights','pages_read_engagement'] END
   ELSE ARRAY[]::text[] END;
  IF a->>'key'='pageMissing' THEN CONTINUE;END IF;
  INSERT INTO public.instagram_account_capabilities(social_account_id,user_id,login_kind,permission_read_state,granted_scopes,scopes_read_at,last_read_failed_at,last_read_error_code,credential_generation)
  VALUES((a->>'id')::uuid,u,a->>'loginKind',CASE WHEN a->>'authority' IN ('granted','denied','expired') THEN 'ok' ELSE a->>'authority' END,scopes,
   CASE WHEN a->>'authority' IN ('granted','denied','expired') THEN t END,CASE WHEN a->>'authority'='failed' THEN t END,
   CASE WHEN a->>'authority'='failed' THEN 'synthetic_permission_read_failed' END,1);
  IF a->>'loginKind'='page_linked' THEN
   INSERT INTO public.facebook_user_credentials(id,user_id,token,revision,lifecycle,token_expires_at,provenance_source)
   VALUES((a->>'credentialId')::uuid,u,a->>'token',1,'active',CASE WHEN a->>'authority'='expired' THEN t-interval '1 hour' ELSE t+interval '30 days' END,'migrated_instagram_account_credential');
   INSERT INTO public.facebook_user_credential_bindings(social_account_id,user_id,platform,credential_id,evidence_source)
   VALUES((a->>'id')::uuid,u,'instagram',(a->>'credentialId')::uuid,'migrated_instagram_account_credential');
  END IF;
 END LOOP;
END;$accounts$;`;
}

function watchlistSeedSql(): string {
  return `INSERT INTO public.competitor_watchlist(id,user_id,username,label,is_active,removed_at,status,source,last_synced_at,created_at)
SELECT (w->>'id')::uuid,(m->'users'->(w->>'owner')->>'id')::uuid,w->>'username','Synthetic '||(w->>'scenario'),
 w->>'scenario' NOT IN ('retention_89','retention_90'),
 CASE w->>'scenario' WHEN 'retention_89' THEN (m->>'referenceInstant')::timestamptz-interval '89 days'
 WHEN 'retention_90' THEN (m->>'referenceInstant')::timestamptz-interval '90 days' END,
 'pending',NULL,NULL,(m->>'referenceInstant')::timestamptz-interval '40 days'
FROM (SELECT manifest m FROM release_fixture) fixture CROSS JOIN LATERAL jsonb_array_elements(m->'watchlists') w;`;
}

function ownerHistorySeedSql(): string {
  return `DO $owner$
DECLARE a jsonb;m jsonb;t timestamptz;u uuid;i integer;published timestamptz;metric bigint;leap_year integer;special_day date;
BEGIN
 SELECT manifest INTO STRICT m FROM release_fixture;t:=(m->>'referenceInstant')::timestamptz;
 FOR a IN SELECT value FROM jsonb_array_elements(m->'accounts') WHERE value->>'key' IN ('pageGranted','otherPage','threshold') LOOP
  u:=(m->'users'->(a->>'owner')->>'id')::uuid;
  FOR i IN 0..20 LOOP
   published:=t-interval '3 days'-i*interval '1 day';
   metric:=CASE i WHEN 0 THEN 300 WHEN 1 THEN 150 WHEN 2 THEN 100 WHEN 3 THEN 50 WHEN 4 THEN NULL WHEN 5 THEN 0 ELSE 100 END;
   IF i IN (6,7,8) THEN published:=t-interval '48 hours'+(i-7)*interval '1 microsecond';END IF;
   INSERT INTO public.ig_media_insight_snapshots(user_id,social_account_id,ig_media_id,published_at,captured_at,captured_on,capture_timezone,media_product_type,media_type,status,views,reach,likes,comments,saved,shares,total_interactions,caption)
   VALUES(u,(a->>'id')::uuid,(a->>'providerId')||'_history_'||i,published,t,(t AT TIME ZONE 'Asia/Kuwait')::date,'Asia/Kuwait','REELS','VIDEO','ok',metric,0,0,0,0,0,0,'Synthetic owner media '||i);
  END LOOP;
  INSERT INTO public.ig_media_insight_snapshots(user_id,social_account_id,ig_media_id,published_at,captured_at,captured_on,capture_timezone,media_product_type,media_type,status,views)
  SELECT u,(a->>'id')::uuid,(a->>'providerId')||'_history_0',t-interval '3 days',t-interval '1 day',(t AT TIME ZONE 'Asia/Kuwait')::date-1,'Asia/Kuwait','REELS','VIDEO','ok',200;
  INSERT INTO public.ig_account_profile_observations(user_id,social_account_id,observed_at,observed_on,capture_timezone,status,followers_count,media_count)
  VALUES(u,(a->>'id')::uuid,t,(t AT TIME ZONE 'Asia/Kuwait')::date,'Asia/Kuwait','ok',CASE WHEN a->>'key'='threshold' THEN 99 ELSE 120 END,21);
  -- Legacy raw history carries a synthetic timezone; it grants no canonical Instagram calendar capability.
  INSERT INTO public.ig_account_insight_daily(user_id,social_account_id,metric_date,provider_date,period_start,period_end,provider_timezone,status,captured_at,reach,views,total_interactions)
  SELECT u,(a->>'id')::uuid,(t AT TIME ZONE 'UTC')::date-d,(t AT TIME ZONE 'UTC')::date-d,
   ((t AT TIME ZONE 'UTC')::date-d)::timestamp AT TIME ZONE 'UTC',
   ((t AT TIME ZONE 'UTC')::date-d+1)::timestamp AT TIME ZONE 'UTC','UTC','ok',t,
   CASE WHEN d=1 THEN NULL ELSE 0 END,CASE WHEN d=1 THEN NULL ELSE 200 END,0 FROM generate_series(1,30) d;
  FOR i IN 0..6 LOOP
   INSERT INTO public.ig_media_insight_snapshots(user_id,social_account_id,ig_media_id,published_at,captured_at,captured_on,media_product_type,media_type,status,views,likes,comments,saved,shares)
   VALUES(u,(a->>'id')::uuid,(a->>'providerId')||'_six_baseline_'||i,t-(i+3)*interval '1 day',t,(t AT TIME ZONE 'Asia/Kuwait')::date,'FEED','IMAGE','ok',NULL,CASE WHEN i=0 THEN 300 ELSE 100 END,0,0,0);
  END LOOP;
  FOREACH i IN ARRAY ARRAY[7,8,30,31,90,91] LOOP
   INSERT INTO public.ig_media_insight_snapshots(user_id,social_account_id,ig_media_id,published_at,captured_at,captured_on,media_product_type,media_type,status,views)
   VALUES(u,(a->>'id')::uuid,(a->>'providerId')||'_cadence_'||i,t-i*interval '1 day',t,(t AT TIME ZONE 'Asia/Kuwait')::date,'STORY','IMAGE','ok',0);
  END LOOP;
  INSERT INTO public.ig_media_insight_snapshots(user_id,social_account_id,ig_media_id,published_at,captured_at,captured_on,media_product_type,media_type,status,views)
  SELECT u,(a->>'id')::uuid,(a->>'providerId')||'_midnight_'||offset_us,
   (date_trunc('day',t AT TIME ZONE 'Asia/Kuwait') AT TIME ZONE 'Asia/Kuwait')+offset_us*interval '1 microsecond',t,(t AT TIME ZONE 'Asia/Kuwait')::date,'FEED','VIDEO','ok',0
   FROM unnest(ARRAY[-1,0,1]) offset_us;
  leap_year:=extract(year FROM t)::integer;
  WHILE leap_year%4<>0 OR (leap_year%100=0 AND leap_year%400<>0) LOOP leap_year:=leap_year-1;END LOOP;
  FOREACH special_day IN ARRAY ARRAY[make_date(leap_year,2,29),date_trunc('month',t AT TIME ZONE 'Asia/Kuwait')::date] LOOP
   INSERT INTO public.ig_account_insight_daily(user_id,social_account_id,metric_date,provider_date,period_start,period_end,provider_timezone,status,captured_at,reach)
   VALUES(u,(a->>'id')::uuid,special_day,special_day,special_day::timestamp AT TIME ZONE 'Asia/Kuwait',(special_day+1)::timestamp AT TIME ZONE 'Asia/Kuwait','Asia/Kuwait','ok',t,0)
   ON CONFLICT DO NOTHING;
  END LOOP;
 END LOOP;
END;$owner$;`;
}

function competitorHistorySeedSql(): string {
  return `DO $competitors$
DECLARE w jsonb;m jsonb;t timestamptz;u uuid;d integer;followers bigint;s text;i integer;pub timestamptz;
BEGIN
 SELECT manifest INTO STRICT m FROM release_fixture;t:=(m->>'referenceInstant')::timestamptz;
 FOR w IN SELECT value FROM jsonb_array_elements(m->'watchlists') WHERE value->>'scenario' NOT IN ('quota','retention_89','retention_90') LOOP
  u:=(m->'users'->(w->>'owner')->>'id')::uuid;
  FOREACH d IN ARRAY ARRAY[30,7,0] LOOP
   IF w->>'scenario'='first' AND d<>0 THEN CONTINUE;END IF;
   IF w->>'scenario'='missing' AND d<>0 THEN CONTINUE;END IF;
   followers:=CASE d WHEN 30 THEN 80 WHEN 7 THEN 100 ELSE 120 END;s:='official';
   IF w->>'scenario'='zero' AND d<>0 THEN followers:=0;END IF;
   IF w->>'scenario'='null' AND d<>0 THEN followers:=NULL;END IF;
   IF w->>'scenario'='negative' THEN followers:=CASE d WHEN 30 THEN 160 WHEN 7 THEN 140 ELSE 120 END;END IF;
   IF w->>'scenario'='source_switch' AND d=0 THEN s:='apify';END IF;
   INSERT INTO public.competitor_profile_snapshots(watchlist_id,user_id,captured_on,captured_at,capture_timezone,followers_count,media_count,source,status)
   VALUES((w->>'id')::uuid,u,((t-(d+CASE WHEN w->>'scenario'='stale' AND d<>0 THEN 4 ELSE 0 END)*interval '1 day') AT TIME ZONE 'Asia/Kuwait')::date,
    t-(d+CASE WHEN w->>'scenario'='stale' AND d<>0 THEN 4 ELSE 0 END)*interval '1 day','Asia/Kuwait',followers,30,s,'ok');
  END LOOP;
  IF w->>'scenario'='missing' THEN
   INSERT INTO public.competitor_profile_snapshots(watchlist_id,user_id,captured_on,captured_at,capture_timezone,followers_count,media_count,source,status)
   VALUES((w->>'id')::uuid,u,((t-interval '3 days') AT TIME ZONE 'Asia/Kuwait')::date,t-interval '3 days','Asia/Kuwait',110,30,'official','ok');
  END IF;
  FOR i IN 0..29 LOOP
   pub:=t-(CASE WHEN i<3 THEN i+3 ELSE i+8 END)*interval '1 day';
   IF w->>'scenario'='partial' THEN pub:=t-interval '3 days'-i*interval '1 hour';END IF;
   IF w->>'scenario'='cursor_tie' AND i<2 THEN pub:=t-interval '3 days'+i*interval '1 microsecond';END IF;
   INSERT INTO public.competitor_media_snapshots(watchlist_id,user_id,ig_media_id,captured_on,captured_at,capture_timezone,media_product_type,media_type,published_at,like_count,comments_count,view_count,source,status,caption)
   VALUES((w->>'id')::uuid,u,(w->>'username')||'_media_'||i,(t AT TIME ZONE 'Asia/Kuwait')::date,t,'Asia/Kuwait',CASE WHEN i=20 THEN 'FEED' ELSE 'REELS' END,'VIDEO',pub,
    CASE WHEN i=0 THEN NULL ELSE 0 END,0,CASE i WHEN 0 THEN 300 WHEN 1 THEN 150 WHEN 2 THEN 100 WHEN 3 THEN 50 WHEN 4 THEN NULL WHEN 5 THEN 0 ELSE 100 END,s,'ok','Synthetic competitor media '||i);
  END LOOP;
  IF w->>'scenario'<>'legacy' THEN
   -- Positive ordering is downstream synthetic evidence only; actual transport ordering remains unverified.
   INSERT INTO public.competitor_capture_coverage(watchlist_id,user_id,captured_on,captured_at,source,job_generation,capture_started_at,capture_ended_at,oldest_returned_at,ordering_verified,cursor_present,exhausted,truncated,gap_reason)
   VALUES((w->>'id')::uuid,u,(t AT TIME ZONE 'Asia/Kuwait')::date,t,s,1,t-interval '1 second',t,
    CASE WHEN w->>'scenario'='partial' THEN t-interval '4 days' ELSE t-interval '40 days' END,
    true,w->>'scenario'='partial',w->>'scenario'<>'partial',w->>'scenario'='partial',CASE WHEN w->>'scenario'='partial' THEN 'media_cap_reached' END);
  END IF;
  UPDATE public.competitor_watchlist SET status='ok',source=s,last_synced_at=t WHERE id=(w->>'id')::uuid AND user_id=u;
 END LOOP;
END;$competitors$;`;
}

function releaseSettingsSql(manifest: InstagramReleaseManifest): string {
  const policy = { version: 1, owners: { mode: "allowlist", account_ids: manifest.accounts.map((account) => account.id) },
    competitors: { mode: "allowlist", targets: manifest.watchlists.filter((entry) => entry.owner !== "admin").map((entry) => ({
      watchlist_id: entry.id, viewer_social_account_id: manifest.accounts.find((account) => account.key === (entry.owner === "ownerA" ? "pageGranted" : "otherPage"))!.id })) } };
  const settings = { collection_instagram_insights_enabled: true, collection_instagram_rollout_policy: policy,
    credential_facebook_user_mode: "legacy", apify_enabled: false, brand_scrape_max_posts: 50 };
  return `INSERT INTO public.app_settings(key,value,description) SELECT key,value,'Disposable canonical Instagram release fixture'
   FROM jsonb_each(${jsonSql(settings)}) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value;`;
}

function discoveryHistorySeedSql(): string {
  return `INSERT INTO public.brand_scrape_sessions(user_id,platform,username,profile_data,posts_data,total_posts_fetched,strategy_used,api_endpoint,scraped_at)
SELECT (m->'users'->'ownerA'->>'id')::uuid,'instagram','release_history_'||source_name,
 jsonb_build_object('id','release_history_'||source_name,'username','release_history_'||source_name,'fullName','Synthetic source history',
  'bio','','avatarUrl','','followersCount',120,'followingCount',0,'postsCount',0,'isVerified',false,'website',NULL,'platform','instagram')
  ||CASE WHEN source_name='unknown' THEN '{}'::jsonb ELSE jsonb_build_object('source',source_name) END,
 '[]'::jsonb,0,CASE WHEN source_name='unknown' THEN 'cache' ELSE source_name END,NULL,(m->>'referenceInstant')::timestamptz
FROM (SELECT manifest m FROM release_fixture) fixture CROSS JOIN unnest(ARRAY['official','graph_own','apify','unknown']) source_name;`;
}
