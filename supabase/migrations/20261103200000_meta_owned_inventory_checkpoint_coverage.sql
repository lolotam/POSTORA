-- Persisted measurements and current connection health share one MVCC snapshot.
BEGIN;
CREATE OR REPLACE FUNCTION public.read_meta_owned_analytics_history(p_platform text,p_user_id uuid,p_account_id uuid,p_request jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=public,pg_temp AS $fn$
DECLARE v_owner uuid;v_report jsonb;v_health jsonb;v_inventory jsonb;v_profiles jsonb;v_profile_current jsonb:='[]';v_authority jsonb;v_prefix text;
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
  -- Coverage is inventory at the selected checkpoint, never current provider completeness.
  BEGIN v_authority:=public.meta_analytics_current_authority(p_platform,p_account_id,v_owner);
  EXCEPTION WHEN SQLSTATE 'MAH03' THEN v_authority:=NULL; END;
  v_prefix:=CASE p_platform WHEN 'facebook' THEN 'fb' ELSE 'threads' END;
  EXECUTE format($inventory$
    WITH newest AS (
      SELECT * FROM public.%1$I WHERE user_id=$3 AND social_account_id=$4 ORDER BY due_at DESC,id DESC LIMIT 1
    ), selected AS (
      SELECT j.id,j.due_on,j.job_generation,c.updated_at,c.post_ids,c.inventory_complete,c.inventory_truncated
      FROM newest n JOIN public.%1$I j ON j.user_id=n.user_id AND j.social_account_id=n.social_account_id
      JOIN public.%2$I c ON c.job_id=j.id AND c.job_generation=j.job_generation
      WHERE $2 IS NOT NULL AND j.credential_authority IS NOT NULL AND j.credential_authority=$2
        AND (j.id=n.id OR (n.job_generation=1 AND n.credential_authority IS NULL AND n.attempts=0
          AND n.state='pending' AND n.claim_token IS NULL AND (j.due_at,j.id)<(n.due_at,n.id)
          AND NOT EXISTS(SELECT 1 FROM public.%2$I nc WHERE nc.job_id=n.id AND nc.job_generation=n.job_generation)))
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
  INTO v_inventory USING v_report||jsonb_build_object('profile_current',v_profile_current),v_authority,v_owner,p_account_id;
  IF jsonb_array_length(v_profiles)<>jsonb_array_length(v_report->'profile_boundaries') THEN
    RAISE EXCEPTION 'META_ANALYTICS_INCOMPLETE_HISTORY' USING ERRCODE='MAH05'; END IF;
  RETURN jsonb_set(v_report,'{profile_boundaries}',v_profiles)||jsonb_build_object('health',v_health,
    'inventory',COALESCE(v_inventory,'{"complete":false,"truncated":false,"state":"unknown","source":null}'::jsonb),'profile_current',v_profile_current);
END;
$fn$;
REVOKE ALL ON FUNCTION public.read_meta_owned_analytics_history(text,uuid,uuid,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.read_meta_owned_analytics_history(text,uuid,uuid,jsonb) TO authenticated,service_role;
COMMIT;
