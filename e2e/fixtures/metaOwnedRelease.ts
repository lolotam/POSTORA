/** Synthetic history for the real saved-report SQL reader; never a report DTO. */
import { OWNER_RELEASE } from "./instagramOwnerReleaseSettings.mjs";
import { analyticsDefinitions } from "../../supabase/functions/_shared/analyticsRegistry.ts";

export const META_KINDS = ["active", "archived", "permission", "expired", "foreign"] as const;
export type MetaFixturePlatform = "facebook" | "threads";
export const META_PLATFORMS = ["facebook", "threads"] as const;
export const META_ACCOUNTS = META_PLATFORMS.flatMap((platform, index) => META_KINDS.map((kind, accountIndex) => ({
  platform, kind, id: `8e0${index + 4}0000-0000-4000-8000-${String(accountIndex + 1).padStart(12, "0")}`,
  owner: kind === "foreign" ? OWNER_RELEASE.otherOwnerId : OWNER_RELEASE.ownerId,
  providerId: String(884100 + index * 1000 + accountIndex), name: `${platform}_${kind}`,
})));
const jsonSql = (value: unknown) => `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`;
export const metaPostId = (account: typeof META_ACCOUNTS[number], index: number) => account.platform === "facebook"
  ? `${account.providerId}_${90000 + index}` : `${account.providerId}${90000 + index}`;

export async function seedMetaOwnedRelease(sql: (statement: string) => Promise<string>): Promise<void> {
  const existing = JSON.parse(await sql(`SELECT COALESCE(jsonb_agg(jsonb_build_object('id',id,'owner',user_id,'platform',platform)),'[]'::jsonb)
    FROM public.social_accounts WHERE id IN (SELECT (entry->>'id')::uuid FROM jsonb_array_elements(${jsonSql(META_ACCOUNTS)}) entry);`)) ?? [];
  if (existing.length) {
    if (existing.length !== META_ACCOUNTS.length || existing.some((row: { id: string; owner: string; platform: string }) =>
      !META_ACCOUNTS.some((account) => account.id === row.id && account.owner === row.owner && account.platform === row.platform))) {
      throw new Error("Refusing partial or foreign Meta browser fixture identities");
    }
    return;
  }
  const metrics = Object.fromEntries(META_PLATFORMS.map((platform) => [platform, {
    daily: analyticsDefinitions(platform, "account").filter((metric) => metric.capability === "available" && metric.windowKind === "day").map((metric) => metric.key),
    post: analyticsDefinitions(platform, "post").filter((metric) => metric.capability === "available").map((metric) => metric.key),
  }]));
  await sql(`BEGIN;
CREATE FUNCTION pg_temp.seed_owned_browser_capture(p_platform text,p_account uuid,p_kind text,p_subject text,p_date date,p_observed timestamptz,p_metrics jsonb,p_text text DEFAULT '')
RETURNS void LANGUAGE plpgsql AS $seed$
DECLARE v_prefix text:=CASE p_platform WHEN 'facebook' THEN 'fb' WHEN 'threads' THEN 'threads' END;
 v_owner uuid;v_job uuid;v_operation uuid:=gen_random_uuid();v_capture uuid:=gen_random_uuid();v_row uuid:=gen_random_uuid();v_sequence bigint;
 v_keys text[];v_entry record;v_window text;v_since timestamptz;v_until timestamptz;v_api text:=CASE p_platform WHEN 'facebook' THEN 'v25.0' ELSE 'v1.0' END;
 v_source text:=CASE p_platform WHEN 'facebook' THEN 'meta_graph_v25' ELSE 'threads_graph_v1' END;
 v_today date:=(clock_timestamp() AT TIME ZONE 'America/Los_Angeles')::date;
BEGIN
 ASSERT v_prefix IS NOT NULL,'Only the two fixed fixture families are allowed';
 SELECT user_id INTO STRICT v_owner FROM public.social_accounts WHERE id=p_account AND platform=p_platform;
 SELECT array_agg(key ORDER BY key) INTO v_keys FROM jsonb_each(p_metrics);
 EXECUTE format('UPDATE public.%I SET next_capture_sequence=next_capture_sequence+1 WHERE social_account_id=$1 RETURNING next_capture_sequence',v_prefix||'_analytics_report_state') INTO STRICT v_sequence USING p_account;
 EXECUTE format('SELECT id FROM public.%I WHERE social_account_id=$1 AND due_on=$2',v_prefix||'_analytics_collection_jobs') INTO STRICT v_job USING p_account,v_today-1;
 EXECUTE format('INSERT INTO public.%I(id,job_id,user_id,social_account_id,job_generation,operation_key,kind,state,requested_metrics) VALUES($1,$2,$3,$4,1,$5,$6,''success'',$7)',v_prefix||'_analytics_collection_operations')
 USING v_operation,v_job,v_owner,p_account,'fixture:'||v_sequence,p_kind,v_keys;
 IF p_kind='account_day' THEN v_since:=p_date::timestamp AT TIME ZONE 'America/Los_Angeles';v_until:=(p_date+1)::timestamp AT TIME ZONE 'America/Los_Angeles';END IF;
 EXECUTE format('INSERT INTO public.%I(id,job_id,operation_id,job_generation,claim_token,user_id,social_account_id,capture_sequence,kind,subject_id,metric_date,window_since,window_until,provider_timezone,api_version,requested_metrics,credential_authority,requested_at,received_at,payload_digest,receipt)
 VALUES($1,$2,$3,1,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,''{}'',$16-interval ''1 second'',$16,repeat(''0'',64),''{"fixture":true}'')',v_prefix||'_analytics_captures')
 USING v_capture,v_job,v_operation,gen_random_uuid(),v_owner,p_account,v_sequence,p_kind,p_subject,p_date,v_since,v_until,CASE WHEN p_kind='account_day' THEN 'America/Los_Angeles' END,v_api,v_keys,p_observed;
 IF p_kind='post' THEN
  v_window:='lifetime';
  EXECUTE format('INSERT INTO public.%I(id,user_id,social_account_id,platform_post_id,captured_on,published_at,post_text,metadata_capture_id) VALUES($1,$2,$3,$4,($5 AT TIME ZONE ''UTC'')::date,(($6-3)::timestamp AT TIME ZONE ''America/Los_Angeles'')+interval ''12 hours''-right($4,2)::integer*interval ''1 second'',$7,$8)',v_prefix||'_post_insight_snapshots')
  USING v_row,v_owner,p_account,p_subject,p_observed,v_today,p_text,v_capture;
 ELSIF p_kind='account_day' THEN
  v_window:='day';
  EXECUTE format('INSERT INTO public.%I(id,user_id,social_account_id,metric_date,period_start,period_end,provider_timezone) VALUES($1,$2,$3,$4,$5,$6,''America/Los_Angeles'')',CASE p_platform WHEN 'facebook' THEN 'fb_page_insight_daily' ELSE 'threads_account_insight_daily' END)
  USING v_row,v_owner,p_account,p_date,v_since,v_until;
 ELSE
  v_window:='point_in_time';
  EXECUTE format('INSERT INTO public.%I(id,user_id,social_account_id,capture_id,observed_at) VALUES($1,$2,$3,$4,$5)',CASE p_platform WHEN 'facebook' THEN 'fb_page_profile_observations' ELSE 'threads_account_profile_observations' END)
  USING v_row,v_owner,p_account,v_capture,p_observed;
 END IF;
 FOR v_entry IN SELECT key,value FROM jsonb_each(p_metrics) LOOP
  EXECUTE format('INSERT INTO public.%I(user_id,social_account_id,daily_id,post_snapshot_id,profile_observation_id,metric_key,status,value,provider_metric,api_version,window_kind,provider_timezone,window_since,window_until,source_ref,capture_id,observed_at)
   VALUES($1,$2,$3,$4,$5,$6,''available'',$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)',v_prefix||'_analytics_metric_values')
  USING v_owner,p_account,CASE WHEN p_kind='account_day' THEN v_row END,CASE WHEN p_kind='post' THEN v_row END,CASE WHEN p_kind='profile' THEN v_row END,
   v_entry.key,(v_entry.value#>>'{}')::bigint,public.meta_analytics_provider_metric(p_platform,CASE WHEN p_kind='post' THEN 'post' ELSE 'account' END,v_entry.key,v_window),v_api,v_window,
   CASE WHEN p_kind='account_day' THEN 'America/Los_Angeles' END,v_since,v_until,v_source,v_capture,p_observed;
 END LOOP;
END;$seed$;
DO $accounts$
DECLARE a jsonb;v_prefix text;v_day date:=(clock_timestamp() AT TIME ZONE 'America/Los_Angeles')::date;v_metrics jsonb;v_index integer;v_keys jsonb;v_subject text;
BEGIN
 FOR a IN SELECT value FROM jsonb_array_elements(${jsonSql(META_ACCOUNTS)}) LOOP
  v_prefix:=CASE a->>'platform' WHEN 'facebook' THEN 'fb' ELSE 'threads' END;
  INSERT INTO public.social_accounts(id,user_id,platform,platform_user_id,platform_username,access_token,is_active,needs_reauth,connected_at)
  VALUES((a->>'id')::uuid,(a->>'owner')::uuid,a->>'platform',a->>'providerId',a->>'name','owned-'||(a->>'platform')||'-'||(a->>'kind'),a->>'kind'<>'archived',false,
   CASE WHEN a->>'kind'='archived' THEN '2019-01-01'::timestamptz ELSE '2020-01-01'::timestamptz+array_position(ARRAY['active','permission','expired','foreign'],a->>'kind')*interval '1 day' END);
  EXECUTE format('INSERT INTO public.%I(user_id,social_account_id) VALUES($1,$2)',v_prefix||'_analytics_report_state') USING (a->>'owner')::uuid,(a->>'id')::uuid;
  EXECUTE format('INSERT INTO public.%I(user_id,social_account_id,due_on,due_at,next_due_at,state,completed_at,last_success_at) VALUES($1,$2,$3,$3::timestamp AT TIME ZONE ''America/Los_Angeles'',($3+1)::timestamp AT TIME ZONE ''America/Los_Angeles'',''success'',clock_timestamp()-interval ''1 minute'',clock_timestamp()-interval ''1 minute'')',v_prefix||'_analytics_collection_jobs') USING (a->>'owner')::uuid,(a->>'id')::uuid,v_day-1;
  EXECUTE format('INSERT INTO public.%I(job_id,user_id,social_account_id,job_generation,inventory_complete) SELECT id,user_id,social_account_id,1,true FROM public.%I WHERE social_account_id=$1',v_prefix||'_analytics_collection_checkpoints',v_prefix||'_analytics_collection_jobs') USING (a->>'id')::uuid;
  v_keys:=${jsonSql(metrics)}->(a->>'platform')->'post';
  SELECT jsonb_object_agg(key,0) INTO v_metrics FROM jsonb_array_elements_text(v_keys) key;
  FOR v_index IN 0..CASE WHEN a->>'kind'='archived' THEN 0 ELSE 25 END LOOP
   v_subject:=CASE a->>'platform' WHEN 'facebook' THEN (a->>'providerId')||'_' ELSE a->>'providerId' END||(90000+v_index)::text;
   PERFORM pg_temp.seed_owned_browser_capture(a->>'platform',(a->>'id')::uuid,'post',v_subject,NULL,clock_timestamp()-interval '1 minute',v_metrics,
    'Saved '||(a->>'platform')||' '||(a->>'kind')||' post '||lpad(v_index::text,2,'0'));
  END LOOP;
  EXECUTE format('UPDATE public.%I SET post_ids=(SELECT array_agg(platform_post_id ORDER BY published_at DESC,platform_post_id DESC) FROM public.%I WHERE social_account_id=$1),pages_fetched=$2 WHERE social_account_id=$1',v_prefix||'_analytics_collection_checkpoints',v_prefix||'_post_insight_snapshots')
   USING (a->>'id')::uuid,CASE WHEN a->>'kind'='archived' THEN 1 ELSE 2 END;
  FOR v_index IN 1..28 LOOP
   SELECT jsonb_object_agg(key,CASE WHEN key='followers' THEN 100+v_index ELSE 0 END) INTO v_metrics FROM jsonb_array_elements_text(${jsonSql(metrics)}->(a->>'platform')->'daily') key;
   PERFORM pg_temp.seed_owned_browser_capture(a->>'platform',(a->>'id')::uuid,'account_day',a->>'providerId',v_day-v_index,clock_timestamp()-interval '1 minute',v_metrics);
  END LOOP;
  IF a->>'platform'='threads' THEN
   PERFORM pg_temp.seed_owned_browser_capture('threads',(a->>'id')::uuid,'profile',a->>'providerId',NULL,((v_day-7)::timestamp AT TIME ZONE 'America/Los_Angeles')-interval '1 hour','{"followers":10}');
   PERFORM pg_temp.seed_owned_browser_capture('threads',(a->>'id')::uuid,'profile',a->>'providerId',NULL,clock_timestamp()-interval '1 minute','{"followers":17}');
  END IF;
 END LOOP;
END;$accounts$;
INSERT INTO public.facebook_user_credentials(id,user_id,token,provider_user_id,provenance_source,provenance_captured_at) VALUES
 ('8e060000-0000-4000-8000-000000000001','${OWNER_RELEASE.ownerId}','owned-user-primary','887001','oauth_exchange',clock_timestamp()),
 ('8e060000-0000-4000-8000-000000000002','${OWNER_RELEASE.otherOwnerId}','owned-user-foreign','887002','oauth_exchange',clock_timestamp());
INSERT INTO public.facebook_user_credential_connection_fences(social_account_id,user_id,platform)
 SELECT id,user_id,platform FROM public.social_accounts WHERE id IN (SELECT (a->>'id')::uuid FROM jsonb_array_elements(${jsonSql(META_ACCOUNTS)}) a) AND platform='facebook';
INSERT INTO public.facebook_user_credential_bindings(social_account_id,user_id,platform,credential_id,verified_facebook_user_id,evidence_source)
 SELECT id,user_id,platform,CASE WHEN user_id='${OWNER_RELEASE.ownerId}' THEN '8e060000-0000-4000-8000-000000000001'::uuid ELSE '8e060000-0000-4000-8000-000000000002'::uuid END,
  CASE WHEN user_id='${OWNER_RELEASE.ownerId}' THEN '887001' ELSE '887002' END,'oauth_exchange'
 FROM public.social_accounts WHERE id IN (SELECT (a->>'id')::uuid FROM jsonb_array_elements(${jsonSql(META_ACCOUNTS)}) a) AND platform='facebook';
UPDATE public.app_settings SET value='true'::jsonb WHERE key IN ('collection_facebook_analytics_enabled','collection_threads_analytics_enabled');
UPDATE public.app_settings SET value=jsonb_build_object('account_ids',(SELECT jsonb_agg(a->>'id') FROM jsonb_array_elements(${jsonSql(META_ACCOUNTS)}) a
 WHERE a->>'platform'=CASE app_settings.key WHEN 'collection_facebook_analytics_policy' THEN 'facebook' ELSE 'threads' END AND a->>'kind' IN ('active','permission','expired')))
 WHERE key IN ('collection_facebook_analytics_policy','collection_threads_analytics_policy');
COMMIT;`);
}

/** Only fixed synthetic account IDs/tokens are recognized; other Graph calls remain with the IG fixture. */
export class MetaOwnedProviderFixture {
  calls: { platform: MetaFixturePlatform; kind: string; account: string }[] = [];
  reply(request: Request): Response | null {
    const url = new URL(request.url);
    const token = request.headers.get("authorization")?.replace(/^Bearer /i, "");
    if (url.pathname.endsWith("/debug_token")) {
      const checked = url.searchParams.get("input_token");
      const threaded = META_ACCOUNTS.find((entry) => entry.platform === "threads" && checked === `owned-threads-${entry.kind}`);
      const facebook = checked === "owned-user-primary" || checked === "owned-user-foreign";
      if (!threaded && !facebook) return null;
      const platform = threaded ? "threads" : "facebook";
      if (url.origin !== (threaded ? "https://graph.threads.net" : "https://graph.facebook.com") || token !== `${threaded ? "TH|" : ""}770001|owned-fixture-app`) throw new Error("Owned debugger fixture credential mismatch");
      this.calls.push({ platform, kind: "permissions", account: threaded?.kind ?? "bound-owner" });
      return Response.json({ data: { is_valid: true, app_id: "770001", user_id: threaded?.providerId ?? (checked === "owned-user-primary" ? "887001" : "887002"),
        scopes: threaded ? ["threads_basic", "threads_manage_insights"] : ["read_insights", "pages_read_engagement"] } },
        { headers: facebook ? { "facebook-api-version": "v25.0" } : {} });
    }
    const account = META_ACCOUNTS.find((entry) => url.pathname.split("/").some((segment) => segment === entry.providerId || Array.from({ length: 26 }, (_, index) => metaPostId(entry, index)).includes(segment)));
    if (!account) return null;
    if (url.origin !== (account.platform === "facebook" ? "https://graph.facebook.com" : "https://graph.threads.net") || token !== `owned-${account.platform}-${account.kind}`) {
      throw new Error("Owned Meta fixture refused a foreign endpoint or credential");
    }
    const respond = (body: unknown, status = 200) => Response.json(body, { status, headers: account.platform === "facebook" ? { "facebook-api-version": "v25.0" } : {} });
    const isInventory = /\/(posts|threads)$/.test(url.pathname);
    const isMetric = /\/(insights|threads_insights)$/.test(url.pathname);
    this.calls.push({ platform: account.platform, kind: isInventory ? "inventory" : isMetric ? "metric" : "identity", account: account.kind });
    const post = (index: number) => ({ id: metaPostId(account, index),
      ...(account.platform === "facebook" ? { created_time: new Date(Date.now() - 3 * 86_400_000 - index * 1000).toISOString(), message: `Collected facebook ${account.kind} post ${String(index).padStart(2, "0")}` }
        : { timestamp: new Date(Date.now() - 3 * 86_400_000 - index * 1000).toISOString(), text: `Collected threads ${account.kind} post ${String(index).padStart(2, "0")}` }) });
    if (isInventory) {
      const second = url.searchParams.has("after");
      return respond({ data: Array.from({ length: second ? 1 : 25 }, (_, index) => post(second ? 25 : index)),
        ...(second ? {} : { paging: { cursors: { after: "fixture-page-two" }, next: `${url.origin}${url.pathname}?after=fixture-page-two` } }) });
    }
    const postIndex = Array.from({ length: 26 }, (_, index) => index).find((index) => url.pathname.split("/").includes(metaPostId(account, index)));
    if (!isMetric) return respond(postIndex === undefined ? { id: account.providerId } : post(postIndex));
    if (account.kind === "permission" || account.kind === "expired") return respond({ error: { code: account.kind === "permission" ? 10 : 190 } }, account.kind === "permission" ? 403 : 400);
    const metrics = url.searchParams.get("metric")?.split(",") ?? [];
    const day = postIndex === undefined && !metrics.includes("followers_count");
    return respond({ data: metrics.map((name) => name === "followers_count" ? { name, total_value: { value: 17 } }
      : { name, period: day ? "day" : "lifetime", values: [{ value: postIndex === undefined ? 0 : 42,
        ...(day ? { end_time: new Date(Number(url.searchParams.get("until")) * 1000).toISOString() } : {}) }] }) });
  }
}
