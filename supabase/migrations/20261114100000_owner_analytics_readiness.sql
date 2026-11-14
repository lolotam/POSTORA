-- Additive, read-only readiness. No enrollment, permission probes or settings writes.
BEGIN;

CREATE FUNCTION public.owner_analytics_readiness_snapshot(p_platform text,p_owner uuid,p_account uuid,p_observed_at timestamptz,p_attempt jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=public,pg_temp SET statement_timeout='10s' AS $fn$
DECLARE
  a public.social_accounts; c public.instagram_account_capabilities;
  o public.fb_analytics_permission_observations;
  v_enabled jsonb; v_policy jsonb; v_normal jsonb; v_ids jsonb; v_authority jsonb;
  v_reason text; v_source text; v_state text; v_action text:='wait'; v_reconnect boolean:=false;
  v_connection text:='verified'; v_connection_reason text; v_permission text:='unknown';
  v_permission_at timestamptz; v_missing text[]:='{}'; v_required text[];
  v_credential record; v_route boolean:=false; v_retry timestamptz;
BEGIN
  -- Internal-only helper; callable snapshots establish their owner first.
  IF p_owner IS NULL OR p_platform NOT IN ('instagram','facebook') THEN
    RAISE EXCEPTION 'REPORT_INVALID_REQUEST' USING ERRCODE='MAH01'; END IF;
  SELECT * INTO a FROM public.social_accounts WHERE id=p_account AND user_id=p_owner AND platform=p_platform;
  IF NOT FOUND THEN RAISE EXCEPTION 'REPORT_ACCOUNT_NOT_FOUND' USING ERRCODE='MAH02'; END IF;
  SELECT COALESCE((SELECT value='"protected"'::jsonb FROM public.app_settings WHERE key='credential_facebook_user_mode'),false)
    OR COALESCE((SELECT jsonb_typeof(value)='array' AND value @> jsonb_build_array(p_owner::text)
      FROM public.app_settings WHERE key='credential_facebook_user_protected_pilot_user_ids'),false) INTO v_route;

  -- Policy parsers are the same pure parsers used by collection. Do not call
  -- VOLATILE admission/enqueue functions from a report read.
  BEGIN
    SELECT value INTO v_enabled FROM public.app_settings WHERE key=CASE p_platform
      WHEN 'instagram' THEN 'collection_instagram_insights_enabled' ELSE 'collection_facebook_analytics_enabled' END;
    -- Match the owner intake's legacy JSON string and absent-value semantics.
    IF p_platform='instagram' AND (v_enabled IS NULL OR v_enabled='null'::jsonb) THEN v_enabled:='false'::jsonb;
    ELSIF p_platform='instagram' AND jsonb_typeof(v_enabled)='string' THEN
      v_enabled:=CASE lower(btrim(v_enabled#>>'{}')) WHEN 'true' THEN 'true'::jsonb WHEN 'false' THEN 'false'::jsonb WHEN '' THEN 'false'::jsonb ELSE v_enabled END;
    END IF;
    IF v_enabled IS NULL OR jsonb_typeof(v_enabled)<>'boolean' THEN
      v_reason:='settings_unavailable';
    ELSIF v_enabled='false'::jsonb THEN v_reason:='collection_disabled';
    ELSE
      SELECT value INTO v_policy FROM public.app_settings WHERE key=CASE p_platform
        WHEN 'instagram' THEN 'collection_instagram_rollout_policy' ELSE 'collection_facebook_analytics_policy' END;
      IF p_platform='instagram' THEN
        v_normal:=public.ig_collection_rollout_normalize_policy(v_policy);
        IF v_normal->>'owner_mode'='off' OR (v_normal->>'owner_mode'='allowlist' AND NOT (v_normal->'owner_ids' @> jsonb_build_array(p_account::text))) THEN
          v_reason:='collection_not_eligible'; END IF;
      ELSE
        v_ids:=public.meta_analytics_policy_ids(v_policy);
        IF NOT (v_ids @> jsonb_build_array(p_account::text)) THEN v_reason:='collection_not_eligible'; END IF;
      END IF;
    END IF;
  EXCEPTION WHEN OTHERS THEN v_reason:='settings_unavailable'; END;
  v_source:=CASE WHEN v_reason='settings_unavailable' THEN 'configuration' WHEN v_reason IS NOT NULL THEN 'rollout_policy' END;

  IF NULLIF(btrim(a.platform_user_id),'') IS NULL THEN
    v_connection:='invalid'; v_connection_reason:='account_identity_invalid';
  ELSIF NOT COALESCE(a.is_active,false) THEN
    v_connection:='invalid'; v_connection_reason:='account_inactive';
  ELSIF COALESCE(a.needs_reauth,false) OR a.token_expires_at<=p_observed_at OR NULLIF(btrim(a.access_token),'') IS NULL THEN
    v_connection:='invalid'; v_connection_reason:='token_invalid';
  END IF;

  IF p_platform='instagram' THEN
    SELECT * INTO c FROM public.instagram_account_capabilities WHERE social_account_id=p_account AND user_id=p_owner;
    IF NOT FOUND OR c.credential_generation IS NULL OR c.credential_generation<1 THEN
      IF v_connection_reason IS NULL THEN v_connection:='unverified'; v_connection_reason:='bootstrap_required'; END IF;
    ELSE
      v_required:=CASE WHEN c.login_kind='direct' THEN ARRAY['instagram_business_manage_insights'] ELSE ARRAY['instagram_manage_insights'] END;
      v_permission_at:=c.scopes_read_at;
      IF c.permission_read_state='ok' AND c.scopes_read_at IS NOT NULL AND c.scopes_read_at<=p_observed_at THEN
        SELECT COALESCE(array_agg(s),'{}') INTO v_missing FROM unnest(v_required) s WHERE NOT (s=ANY(c.granted_scopes));
        v_permission:=CASE WHEN cardinality(v_missing)>0 THEN 'missing' ELSE 'verified' END;
      ELSIF c.permission_read_state='failed' THEN v_permission:='unavailable'; END IF;
      IF c.login_kind='page_linked' AND v_connection_reason IS NULL THEN
        SELECT g.lifecycle,g.token_expires_at,NULLIF(btrim(g.token),'') IS NOT NULL AS token_present,
          (b.evidence_source='migrated_instagram_account_credential' OR
            (b.connection_version=f.connection_version AND b.verified_facebook_user_id=g.provider_user_id
              AND b.verified_instagram_user_id=a.platform_user_id AND b.evidence_source IN ('oauth_exchange','token_refresh'))) AS identity_matches
        INTO v_credential FROM public.facebook_user_credential_bindings b
        LEFT JOIN public.facebook_user_credential_connection_fences f USING(social_account_id,user_id,platform)
        JOIN public.facebook_user_credentials g ON g.id=b.credential_id AND g.user_id=b.user_id
        WHERE b.social_account_id=p_account AND b.user_id=p_owner AND b.platform='instagram';
        IF NOT FOUND THEN v_connection:='unverified'; v_connection_reason:='bootstrap_required';
        ELSIF NOT COALESCE(v_credential.identity_matches,false) THEN v_connection:='invalid'; v_connection_reason:='identity_mismatch';
        ELSIF v_credential.lifecycle<>'active' OR NOT v_credential.token_present OR v_credential.token_expires_at<=p_observed_at THEN
          v_connection:='invalid'; v_connection_reason:='token_invalid'; END IF;
      END IF;
    END IF;
  ELSE
    -- Reproduce the current authority's nonsecret version projection without
    -- executing the VOLATILE credential reader or returning credential IDs.
    SELECT g.lifecycle,g.token_expires_at,NULLIF(btrim(g.token),'') IS NOT NULL AS token_present,
      b.connection_version=f.connection_version AND b.verified_facebook_user_id=g.provider_user_id
        AND g.provider_user_id IS NOT NULL AND b.evidence_source IN ('oauth_exchange','token_refresh') AS identity_matches,
      jsonb_build_object('platform_user_id',a.platform_user_id,'connection_version',f.connection_version,
        'credential_id',g.id,'credential_revision',g.revision,'provider_user_id',g.provider_user_id,'token_expires_at',a.token_expires_at) AS authority
    INTO v_credential FROM public.facebook_user_credential_bindings b
    JOIN public.facebook_user_credential_connection_fences f USING(social_account_id,user_id,platform)
    JOIN public.facebook_user_credentials g ON g.id=b.credential_id AND g.user_id=b.user_id
    WHERE b.social_account_id=p_account AND b.user_id=p_owner AND b.platform='facebook';
    IF NOT FOUND THEN
      IF v_connection_reason IS NULL THEN v_connection:='unverified'; v_connection_reason:='bootstrap_required'; END IF;
    ELSE
      v_authority:=v_credential.authority;
      IF v_connection_reason IS NULL THEN
        IF NOT COALESCE(v_credential.identity_matches,false) THEN v_connection:='invalid'; v_connection_reason:='identity_mismatch';
        ELSIF v_credential.lifecycle<>'active' OR NOT v_credential.token_present OR v_credential.token_expires_at<=p_observed_at THEN
          v_connection:='invalid'; v_connection_reason:='token_invalid'; END IF;
      END IF;
      SELECT * INTO o FROM public.fb_analytics_permission_observations
        WHERE social_account_id=p_account AND user_id=p_owner AND authority=v_authority
          AND (observed_at AT TIME ZONE 'America/Los_Angeles')::date=(p_observed_at AT TIME ZONE 'America/Los_Angeles')::date;
      IF FOUND THEN
        v_permission_at:=o.observed_at;
        IF o.state='verified' THEN
          SELECT COALESCE(array_agg(s),'{}') INTO v_missing FROM unnest(ARRAY['read_insights','pages_read_engagement']) s WHERE NOT (s=ANY(o.granted_scopes));
          v_permission:=CASE WHEN cardinality(v_missing)>0 THEN 'missing' ELSE 'verified' END;
        ELSE v_permission:='unavailable'; END IF;
      END IF;
      -- Provider refusals remain current only for this authority, and until a
      -- newer successful permission observation supersedes the failed attempt.
      IF v_connection_reason IS NULL AND COALESCE((p_attempt->>'context_current')::boolean,false)
        AND p_attempt->>'state'='failed' AND (p_attempt->>'observed_at')::timestamptz<=p_observed_at
        AND (v_permission IN ('unknown','unavailable') OR (p_attempt->>'observed_at')::timestamptz>=COALESCE(v_permission_at,'-infinity'::timestamptz)) THEN
        IF p_attempt->>'reason_code'='reauth_required' THEN
          v_connection:='invalid'; v_connection_reason:='token_invalid';
        ELSIF p_attempt->>'reason_code'='permission_missing' THEN
          v_permission:='missing'; v_permission_at:=(p_attempt->>'observed_at')::timestamptz;
        END IF;
      END IF;
    END IF;
  END IF;

  IF v_reason IS NULL THEN
    IF v_connection_reason IS NOT NULL THEN v_reason:=v_connection_reason; v_source:='connection';
    ELSIF v_permission IN ('unknown','unavailable') THEN v_reason:='permission_verification_pending'; v_source:='permission';
    ELSIF v_permission='missing' THEN v_reason:='permission_missing'; v_source:=CASE WHEN cardinality(v_missing)=0 THEN 'job' ELSE 'permission' END;
    ELSIF (p_attempt->>'state' IN ('queued','pending') OR COALESCE((p_attempt->>'context_current')::boolean,true)) AND p_attempt->>'state' IN ('queued','pending','running','leased','retry') THEN
      v_reason:=CASE p_attempt->>'state' WHEN 'pending' THEN 'queued' WHEN 'leased' THEN 'running' WHEN 'retry' THEN
        CASE WHEN p_attempt->>'reason_code' IN ('rate_limited','throttled') THEN 'rate_limited' ELSE 'provider_error' END
        ELSE p_attempt->>'state' END; v_source:='job';
    ELSE v_reason:='awaiting_first_capture'; v_source:='data'; END IF;
  END IF;
  v_state:=CASE WHEN v_reason IN ('collection_disabled','collection_not_eligible') THEN 'not_enabled'
    WHEN v_reason IN ('bootstrap_required','permission_verification_pending') THEN 'preparing'
    WHEN v_reason IN ('token_invalid','stored_user_credential_missing','reconnect_required') THEN 'needs_reconnect'
    WHEN v_reason='permission_missing' THEN 'permissions_missing'
    WHEN v_reason IN ('identity_mismatch','account_identity_invalid','app_mismatch','account_inactive') THEN 'needs_review'
    WHEN v_reason IN ('queued','running','awaiting_first_capture') THEN 'syncing'
    ELSE 'unavailable' END;
  IF v_reason IN ('queued','running','awaiting_first_capture','permission_verification_pending') THEN v_action:='wait';
  ELSIF v_reason IN ('token_invalid','stored_user_credential_missing','reconnect_required','permission_missing') AND v_route THEN
    v_action:=CASE WHEN v_reason='permission_missing' THEN 'grant_permissions' ELSE 'reconnect' END; v_reconnect:=true;
  ELSIF v_reason IN ('rate_limited','provider_error') THEN v_action:='retry_after';
  ELSE v_action:='contact_support'; END IF;
  v_retry:=CASE WHEN COALESCE((p_attempt->>'context_current')::boolean,true) THEN NULLIF(p_attempt->>'retry_at','')::timestamptz END;
  RETURN jsonb_build_object('collection',jsonb_build_object('contract_version',2,'state',v_state,'reason_code',v_reason,
    'reason_source',v_source,'observed_at',p_observed_at,'next_action',v_action,'reconnect_can_help',v_reconnect,
    'retry_at',v_retry,'support_correlation_id',gen_random_uuid()::text),
    'connection',jsonb_build_object('state',v_connection,'reason_code',v_connection_reason),
    'permission',jsonb_build_object('state',v_permission,'observed_at',v_permission_at,'missing_scopes',to_jsonb(v_missing)),
    'last_attempt',CASE WHEN p_attempt->>'observed_at' IS NULL THEN NULL ELSE
      jsonb_build_object('state',p_attempt->>'state','reason_code',p_attempt->>'reason_code','observed_at',p_attempt->>'observed_at') END);
END;
$fn$;
REVOKE ALL ON FUNCTION public.owner_analytics_readiness_snapshot(text,uuid,uuid,timestamptz,jsonb) FROM PUBLIC,anon,authenticated,service_role;

-- Snapshot replacements below preserve the existing bounded history and ACLs.
CREATE OR REPLACE FUNCTION public.read_instagram_owner_report_snapshot(p_user_id uuid,p_account_id uuid,p_as_of timestamptz)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=public,pg_temp AS $fn$
DECLARE v_owner uuid;v_media jsonb;v_daily jsonb;v_profiles jsonb;v_period_totals jsonb;v_collection jsonb;
BEGIN
  IF auth.role()='authenticated' THEN v_owner:=auth.uid();
  ELSIF auth.role()='service_role' THEN v_owner:=p_user_id;
  ELSE RAISE EXCEPTION 'REPORT_CALLER_NOT_ALLOWED' USING ERRCODE='42501';END IF;
  IF v_owner IS NULL OR p_as_of IS NULL OR NOT isfinite(p_as_of) THEN
    RAISE EXCEPTION 'REPORT_INVALID_REQUEST' USING ERRCODE='MAH01';END IF;
  IF NOT EXISTS(SELECT 1 FROM public.social_accounts WHERE id=p_account_id AND user_id=v_owner AND platform='instagram' AND is_active) THEN
    RAISE EXCEPTION 'REPORT_ACCOUNT_NOT_FOUND' USING ERRCODE='MAH02';END IF;
  SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.id),'[]') INTO v_media FROM (
    SELECT id,user_id,social_account_id,post_id,ig_media_id,published_at,captured_at,captured_on,capture_timezone,media_product_type,media_type,permalink,thumbnail_url,status,views,reach,likes,comments,saved,shares,total_interactions,follows,profile_visits,replies,ig_reels_avg_watch_time_ms FROM public.ig_media_insight_snapshots
    WHERE user_id=v_owner AND social_account_id=p_account_id AND captured_at<=p_as_of ORDER BY id LIMIT 20001
  ) r;
  IF jsonb_array_length(v_media)>20000 THEN RAISE EXCEPTION 'REPORT_HISTORY_BOUND_EXCEEDED' USING ERRCODE='MAH05';END IF;
  SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.id),'[]') INTO v_daily FROM (
    SELECT id,user_id,social_account_id,metric_date,provider_date,period_start,period_end,provider_timezone,status,captured_at,reach,views,accounts_engaged,total_interactions,likes,comments,saves,shares,follows,unfollows FROM public.ig_account_insight_daily
    WHERE user_id=v_owner AND social_account_id=p_account_id AND captured_at<=p_as_of ORDER BY id LIMIT 20001
  ) r;
  IF jsonb_array_length(v_daily)>20000 THEN RAISE EXCEPTION 'REPORT_HISTORY_BOUND_EXCEEDED' USING ERRCODE='MAH05';END IF;
  SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.id),'[]') INTO v_profiles FROM (
    SELECT id,user_id,social_account_id,observed_at,observed_on,capture_timezone,status,followers_count,media_count FROM public.ig_account_profile_observations
    WHERE user_id=v_owner AND social_account_id=p_account_id AND observed_at<=p_as_of ORDER BY id LIMIT 20001
  ) r;
  IF jsonb_array_length(v_profiles)>20000 THEN RAISE EXCEPTION 'REPORT_HISTORY_BOUND_EXCEEDED' USING ERRCODE='MAH05';END IF;
  SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.id),'[]') INTO v_period_totals FROM (
    SELECT id,user_id,social_account_id,metric,period_days,since_date,until_date,period_start,period_end,provider_timezone,status,value,captured_at FROM public.ig_account_insight_period_totals
    WHERE user_id=v_owner AND social_account_id=p_account_id AND captured_at<=p_as_of ORDER BY id LIMIT 20001
  ) r;
  IF jsonb_array_length(v_period_totals)>20000 THEN RAISE EXCEPTION 'REPORT_HISTORY_BOUND_EXCEEDED' USING ERRCODE='MAH05';END IF;
  SELECT jsonb_build_object('status',j.status,'last_attempt_at',j.last_attempt_at,
    'last_success_at',(SELECT max(last_success_at) FROM public.instagram_collection_jobs WHERE user_id=v_owner AND social_account_id=p_account_id AND target_kind='owner' AND target_id=p_account_id AND last_success_at<=p_as_of),
    'last_partial_at',(SELECT max(last_partial_at) FROM public.instagram_collection_jobs WHERE user_id=v_owner AND social_account_id=p_account_id AND target_kind='owner' AND target_id=p_account_id AND last_partial_at<=p_as_of),
    'next_retry_at',j.retry_at,'reason_code',j.last_reason_code,'inventory',jsonb_build_object(
      'truncated',COALESCE(c.inventory_truncated,false),'partial',COALESCE(c.inventory_partial,j.status='partial'),
      'window_covered',COALESCE(c.inventory_window_covered,false)),
    'context_current',j.context_credential_generation IS NOT DISTINCT FROM live.credential_generation
      AND j.context_login_kind IS NOT DISTINCT FROM live.login_kind
      AND j.context_viewer_social_account_id IS NOT DISTINCT FROM p_account_id) INTO v_collection
    FROM public.instagram_collection_jobs j
    LEFT JOIN public.instagram_account_capabilities live ON live.social_account_id=p_account_id AND live.user_id=v_owner
    LEFT JOIN public.instagram_collection_job_checkpoints c
      ON c.job_id=j.id AND c.job_generation=j.job_generation AND c.user_id=v_owner AND c.updated_at<=p_as_of
    WHERE j.user_id=v_owner AND j.social_account_id=p_account_id AND j.target_kind='owner' AND j.target_id=p_account_id
      AND greatest(j.created_at,j.updated_at,j.last_attempt_at,j.last_success_at,j.last_partial_at)<=p_as_of
    ORDER BY j.captured_on DESC,j.id DESC LIMIT 1;
  RETURN jsonb_build_object('account_id',p_account_id,'owner_id',v_owner,'media',v_media,'daily',v_daily,'profiles',v_profiles,'period_totals',v_period_totals,'collection',v_collection,'readiness',public.owner_analytics_readiness_snapshot('instagram',v_owner,p_account_id,p_as_of,
    CASE WHEN v_collection IS NULL THEN NULL ELSE jsonb_build_object('state',v_collection->>'status','reason_code',v_collection->>'reason_code',
      'observed_at',v_collection->>'last_attempt_at','retry_at',v_collection->>'next_retry_at','context_current',v_collection->'context_current') END));
END;$fn$;


CREATE OR REPLACE FUNCTION public.read_meta_owned_analytics_history(p_platform text,p_user_id uuid,p_account_id uuid,p_request jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=public,pg_temp AS $fn$
DECLARE v_owner uuid;v_report jsonb;v_health jsonb;v_inventory jsonb;v_profiles jsonb;v_profile_current jsonb:='[]';v_authority jsonb;v_prefix text;v_attempt jsonb;v_period_posts jsonb;v_has_data boolean;
BEGIN
  IF auth.role()='authenticated' THEN v_owner:=auth.uid();
  ELSIF auth.role()='service_role' THEN v_owner:=p_user_id;
  ELSE RAISE EXCEPTION 'META_ANALYTICS_CALLER_NOT_ALLOWED' USING ERRCODE='42501'; END IF;
  IF v_owner IS NULL OR p_platform IS NULL OR p_platform NOT IN ('facebook','threads') THEN
    RAISE EXCEPTION 'META_ANALYTICS_INVALID_REPORT_REQUEST' USING ERRCODE='MAH01'; END IF;
  IF p_platform='facebook' THEN v_report:=public.read_fb_analytics_history(v_owner,p_account_id,p_request);
  ELSE v_report:=public.read_threads_analytics_history(v_owner,p_account_id,p_request); END IF;
  IF v_report->>'ok'='false' THEN RETURN v_report; END IF;
  SELECT jsonb_build_object('active',COALESCE(is_active,false),'needs_reauth',COALESCE(needs_reauth,false),
    'token_expired',token_expires_at IS NOT NULL AND token_expires_at<=clock_timestamp()) INTO v_health
    FROM public.social_accounts WHERE id=p_account_id AND user_id=v_owner AND platform=p_platform;
  IF v_health IS NULL THEN RAISE EXCEPTION 'META_ANALYTICS_ACCOUNT_NOT_FOUND' USING ERRCODE='MAH02'; END IF;
  IF p_platform='facebook' THEN
    SELECT COALESCE(jsonb_agg(e.value||jsonb_build_object('collected_at',c.received_at)),'[]') INTO v_profiles
      FROM jsonb_array_elements(v_report->'profile_boundaries') e JOIN public.fb_analytics_captures c
        ON c.id=(e.value->>'capture_id')::uuid AND c.user_id=v_owner AND c.social_account_id=p_account_id;
  ELSE
    SELECT COALESCE(jsonb_agg(e.value||jsonb_build_object('collected_at',c.received_at)),'[]') INTO v_profiles
      FROM jsonb_array_elements(v_report->'profile_boundaries') e JOIN public.threads_analytics_captures c
        ON c.id=(e.value->>'capture_id')::uuid AND c.user_id=v_owner AND c.social_account_id=p_account_id;
    -- The current point value is the latest actual observation, including a
    -- failed latest measurement. Historical comparison anchors stay separate.
    SELECT COALESCE(jsonb_agg(to_jsonb(sample)),'[]') INTO v_profile_current FROM (
      SELECT DISTINCT ON(m.metric_key) m.*,c.received_at AS collected_at
      FROM public.threads_account_profile_observations o JOIN public.threads_analytics_metric_values m ON m.profile_observation_id=o.id
      JOIN public.threads_analytics_captures c ON c.id=m.capture_id
      WHERE o.user_id=v_owner AND o.social_account_id=p_account_id AND o.observed_at<=clock_timestamp()
      ORDER BY m.metric_key,o.observed_at DESC,o.id DESC
    ) sample;
  END IF;
  v_prefix:=CASE p_platform WHEN 'facebook' THEN 'fb' ELSE 'threads' END;
  -- Same latest-per-post selection as the saved report, before its cursor.
  -- Bound the response and fail closed instead of silently dropping evidence.
  EXECUTE format($evidence$
    WITH latest_posts AS (
      SELECT DISTINCT ON(p.platform_post_id) p.* FROM public.%1$I p
      WHERE p.user_id=$1 AND p.social_account_id=$2 AND p.published_at>=$3 AND p.published_at<$4
      ORDER BY p.platform_post_id,p.captured_on DESC
    ), bounded AS (SELECT * FROM latest_posts ORDER BY published_at DESC,platform_post_id DESC LIMIT 20001)
    SELECT COALESCE(jsonb_agg(jsonb_build_object('post',to_jsonb(p),'metrics',
      (SELECT COALESCE(jsonb_agg(to_jsonb(m)||jsonb_build_object('collected_at',c.received_at)),'[]')
       FROM public.%2$I m JOIN public.%3$I c ON c.id=m.capture_id AND c.user_id=m.user_id AND c.social_account_id=m.social_account_id
       WHERE m.post_snapshot_id=p.id AND m.user_id=$1 AND m.social_account_id=$2))),'[]') FROM bounded p
  $evidence$,v_prefix||'_post_insight_snapshots',v_prefix||'_analytics_metric_values',v_prefix||'_analytics_captures')
  INTO v_period_posts USING v_owner,p_account_id,(v_report->>'since')::timestamptz,(v_report->>'until')::timestamptz;
  IF jsonb_array_length(v_period_posts)>20000 THEN RAISE EXCEPTION 'META_ANALYTICS_HISTORY_BOUND_EXCEEDED' USING ERRCODE='MAH05'; END IF;
  -- The canonical SQL metric validator already enforces the same provider,
  -- version and window contract as the registry. This is account-wide evidence,
  -- independent of the requested period, page and last job outcome.
  EXECUTE format($evidence$
    SELECT EXISTS(SELECT 1 FROM public.%1$I m JOIN public.%2$I c ON c.id=m.capture_id
      AND c.user_id=m.user_id AND c.social_account_id=m.social_account_id
      WHERE m.user_id=$1 AND m.social_account_id=$2 AND m.status='available' AND m.value IS NOT NULL
        AND c.received_at IS NOT NULL AND c.received_at<=statement_timestamp()
        AND public.meta_analytics_metric_valid($3,CASE WHEN m.post_snapshot_id IS NOT NULL THEN 'post' ELSE 'account' END,
          m.metric_key,m.status,m.value,m.reason,m.provider_metric,m.api_version,m.window_kind,m.provider_timezone,m.window_since,m.window_until,m.source_ref))
  $evidence$,v_prefix||'_analytics_metric_values',v_prefix||'_analytics_captures') INTO v_has_data USING v_owner,p_account_id,p_platform;
  -- Coverage is inventory at the selected checkpoint, never current provider completeness.
  BEGIN v_authority:=public.meta_analytics_current_authority(p_platform,p_account_id,v_owner);
  EXCEPTION WHEN SQLSTATE 'MAH03' THEN v_authority:=NULL; END;
  EXECUTE format($inventory$
    WITH newest AS (
      SELECT * FROM public.%1$I WHERE user_id=$3 AND social_account_id=$4 ORDER BY due_at DESC,id DESC LIMIT 1
    ), selected AS (
      SELECT j.id,j.due_on,j.job_generation,c.updated_at,c.post_ids,c.inventory_complete,c.inventory_truncated
      FROM newest n JOIN public.%1$I j ON j.user_id=n.user_id AND j.social_account_id=n.social_account_id
      JOIN public.%2$I c ON c.job_id=j.id AND c.job_generation=j.job_generation
      WHERE $2 IS NOT NULL AND j.credential_authority IS NOT NULL AND j.credential_authority=$2
        AND (j.id=n.id OR ((j.due_at,j.id)<(n.due_at,n.id) AND NOT EXISTS(
          SELECT 1 FROM public.%1$I f WHERE f.user_id=n.user_id AND f.social_account_id=n.social_account_id
            AND (f.due_at,f.id)>(j.due_at,j.id) AND (f.due_at,f.id)<=(n.due_at,n.id)
            AND (f.job_generation=1 AND f.credential_authority IS NULL AND f.attempts=0
              AND f.state='pending' AND f.claim_token IS NULL AND NOT EXISTS(
                SELECT 1 FROM public.%2$I fc WHERE fc.job_id=f.id AND fc.job_generation=f.job_generation)) IS NOT TRUE)))
      ORDER BY j.due_at DESC,j.id DESC LIMIT 1
    ), shown AS (
      SELECT value#>>'{}' AS id FROM jsonb_array_elements(jsonb_path_query_array($1,'$.**.capture_id')
        ||jsonb_path_query_array($1,'$.**.metadata_capture_id'))
    ), coverage AS (
      SELECT s.*,s.inventory_complete AND NOT EXISTS(
        SELECT 1 FROM jsonb_array_elements($1->'posts') e WHERE NOT (e.value->'post'->>'platform_post_id'=ANY(s.post_ids)))
        AND NOT EXISTS(SELECT 1 FROM shown x WHERE NOT EXISTS(
          SELECT 1 FROM public.%3$I c WHERE c.id::text=x.id AND c.user_id=$3 AND c.social_account_id=$4
            AND c.received_at IS NOT NULL AND c.credential_authority=$2)) AS covered FROM selected s
    ) SELECT jsonb_build_object('complete',covered AND NOT inventory_truncated,'truncated',inventory_truncated,
      'state',CASE WHEN inventory_truncated THEN 'truncated' WHEN covered THEN 'complete' ELSE 'incomplete' END,
      'source',jsonb_build_object('job_id',id,'due_on',due_on,'job_generation',job_generation,'checkpoint_updated_at',updated_at)) FROM coverage
  $inventory$,v_prefix||'_analytics_collection_jobs',v_prefix||'_analytics_collection_checkpoints',v_prefix||'_analytics_captures')
  INTO v_inventory USING v_report||jsonb_build_object('profile_current',v_profile_current,'posts',v_period_posts),v_authority,v_owner,p_account_id;
  IF jsonb_array_length(v_profiles)<>jsonb_array_length(v_report->'profile_boundaries') THEN
    RAISE EXCEPTION 'META_ANALYTICS_INCOMPLETE_HISTORY' USING ERRCODE='MAH05'; END IF;
  IF p_platform='facebook' THEN
    SELECT jsonb_build_object('state',j.state,'reason_code',j.reason_code,
      'observed_at',CASE WHEN j.attempts>0 THEN j.updated_at END,'retry_at',j.retry_at,
      'context_current',COALESCE(j.credential_authority=v_authority,false)) INTO v_attempt
    FROM public.fb_analytics_collection_jobs j WHERE j.user_id=v_owner AND j.social_account_id=p_account_id
    ORDER BY j.due_at DESC,j.id DESC LIMIT 1;
  END IF;
  RETURN jsonb_set(v_report,'{profile_boundaries}',v_profiles)||jsonb_build_object('health',v_health,
    'inventory',COALESCE(v_inventory,'{"complete":false,"truncated":false,"state":"unknown","source":null}'::jsonb),'profile_current',v_profile_current,'period_posts',v_period_posts,'account_has_measurements',v_has_data)
    ||CASE WHEN p_platform='facebook' THEN jsonb_build_object('readiness',public.owner_analytics_readiness_snapshot(
      p_platform,v_owner,p_account_id,statement_timestamp(),v_attempt)) ELSE '{}'::jsonb END;
END;
$fn$;
REVOKE ALL ON FUNCTION public.read_meta_owned_analytics_history(text,uuid,uuid,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.read_meta_owned_analytics_history(text,uuid,uuid,jsonb) TO authenticated,service_role;

NOTIFY pgrst,'reload schema';
COMMIT;
