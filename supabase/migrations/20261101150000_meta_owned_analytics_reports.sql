-- Persisted measurements and current connection health share one MVCC snapshot.
BEGIN;
CREATE OR REPLACE FUNCTION public.read_meta_owned_analytics_history(p_platform text,p_user_id uuid,p_account_id uuid,p_request jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=public,pg_temp AS $fn$
DECLARE v_owner uuid;v_report jsonb;v_health jsonb;v_inventory jsonb;v_profiles jsonb;v_profile_current jsonb:='[]';
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
    SELECT jsonb_build_object('complete',COALESCE(c.inventory_complete,false),'truncated',COALESCE(c.inventory_truncated,false)) INTO v_inventory
      FROM public.fb_analytics_collection_jobs j LEFT JOIN public.fb_analytics_collection_checkpoints c ON c.job_id=j.id AND c.job_generation=j.job_generation
      WHERE j.user_id=v_owner AND j.social_account_id=p_account_id ORDER BY j.due_at DESC,j.id DESC LIMIT 1;
    SELECT COALESCE(jsonb_agg(e.value||jsonb_build_object('collected_at',c.received_at)),'[]') INTO v_profiles
      FROM jsonb_array_elements(v_report->'profile_boundaries') e JOIN public.fb_analytics_captures c
        ON c.id=(e.value->>'capture_id')::uuid AND c.user_id=v_owner AND c.social_account_id=p_account_id;
  ELSE
    SELECT jsonb_build_object('complete',COALESCE(c.inventory_complete,false),'truncated',COALESCE(c.inventory_truncated,false)) INTO v_inventory
      FROM public.threads_analytics_collection_jobs j LEFT JOIN public.threads_analytics_collection_checkpoints c ON c.job_id=j.id AND c.job_generation=j.job_generation
      WHERE j.user_id=v_owner AND j.social_account_id=p_account_id ORDER BY j.due_at DESC,j.id DESC LIMIT 1;
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
  IF jsonb_array_length(v_profiles)<>jsonb_array_length(v_report->'profile_boundaries') THEN
    RAISE EXCEPTION 'META_ANALYTICS_INCOMPLETE_HISTORY' USING ERRCODE='MAH05'; END IF;
  RETURN jsonb_set(v_report,'{profile_boundaries}',v_profiles)||jsonb_build_object('health',v_health,
    'inventory',COALESCE(v_inventory,'{"complete":false,"truncated":false}'::jsonb),'profile_current',v_profile_current);
END;
$fn$;
REVOKE ALL ON FUNCTION public.read_meta_owned_analytics_history(text,uuid,uuid,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.read_meta_owned_analytics_history(text,uuid,uuid,jsonb) TO authenticated,service_role;

-- Legacy owner DTO reads use one bounded snapshot, never independent REST pages.
CREATE FUNCTION public.read_instagram_owner_report_snapshot(p_user_id uuid,p_account_id uuid,p_as_of timestamptz)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=public,pg_temp AS $fn$
DECLARE v_owner uuid;v_media jsonb;v_daily jsonb;v_profiles jsonb;v_collection jsonb;
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
  SELECT jsonb_build_object('status',j.status,'last_attempt_at',j.last_attempt_at,
    'last_success_at',(SELECT max(last_success_at) FROM public.instagram_collection_jobs WHERE user_id=v_owner AND social_account_id=p_account_id AND target_kind='owner' AND target_id=p_account_id),
    'last_partial_at',(SELECT max(last_partial_at) FROM public.instagram_collection_jobs WHERE user_id=v_owner AND social_account_id=p_account_id AND target_kind='owner' AND target_id=p_account_id),
    'next_retry_at',j.retry_at,'reason_code',j.last_reason_code,'inventory',jsonb_build_object(
      'truncated',COALESCE(c.inventory_truncated,false),'partial',COALESCE(c.inventory_partial,j.status='partial'),
      'window_covered',COALESCE(c.inventory_window_covered,false))) INTO v_collection
    FROM public.instagram_collection_jobs j LEFT JOIN public.instagram_collection_job_checkpoints c
      ON c.job_id=j.id AND c.job_generation=j.job_generation AND c.user_id=v_owner
    WHERE j.user_id=v_owner AND j.social_account_id=p_account_id AND j.target_kind='owner' AND j.target_id=p_account_id
    ORDER BY j.captured_on DESC,j.id DESC LIMIT 1;
  RETURN jsonb_build_object('account_id',p_account_id,'owner_id',v_owner,'media',v_media,'daily',v_daily,'profiles',v_profiles,'collection',v_collection);
END;$fn$;
REVOKE ALL ON FUNCTION public.read_instagram_owner_report_snapshot(uuid,uuid,timestamptz) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.read_instagram_owner_report_snapshot(uuid,uuid,timestamptz) TO authenticated,service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
