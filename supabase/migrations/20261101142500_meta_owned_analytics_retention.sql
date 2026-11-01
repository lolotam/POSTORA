-- Independent retention scope, bounded target visits and truthful dry runs.
BEGIN;
CREATE FUNCTION public.meta_analytics_policy_ids(p_policy jsonb)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER
SET search_path=public,pg_temp AS $fn$
BEGIN
  IF p_policy IS NULL OR jsonb_typeof(p_policy)<>'object' THEN
    RAISE EXCEPTION 'META_ANALYTICS_CONFIGURATION_UNAVAILABLE' USING ERRCODE='MAH05'; END IF;
  IF (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_policy) k) IS DISTINCT FROM ARRAY['account_ids']::text[]
    OR jsonb_typeof(p_policy->'account_ids') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'META_ANALYTICS_CONFIGURATION_UNAVAILABLE' USING ERRCODE='MAH05'; END IF;
  IF jsonb_array_length(p_policy->'account_ids')>100 OR EXISTS(
    SELECT 1 FROM jsonb_array_elements(p_policy->'account_ids') e WHERE jsonb_typeof(e)<>'string'
      OR e#>>'{}' !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$') THEN
    RAISE EXCEPTION 'META_ANALYTICS_CONFIGURATION_UNAVAILABLE' USING ERRCODE='MAH05'; END IF;
  RETURN COALESCE((SELECT jsonb_agg(DISTINCT ((e#>>'{}')::uuid)::text ORDER BY ((e#>>'{}')::uuid)::text) FROM jsonb_array_elements(p_policy->'account_ids') e),'[]'::jsonb);
END;
$fn$;

CREATE OR REPLACE FUNCTION public.meta_analytics_collection_policy(p_platform text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path=public,pg_temp AS $fn$
DECLARE v_enabled jsonb;v_policy jsonb;v_ids jsonb;
BEGIN
  IF p_platform IS NULL OR p_platform NOT IN ('facebook','threads') THEN
    RAISE EXCEPTION 'META_ANALYTICS_INVALID_PLATFORM' USING ERRCODE='MAH01'; END IF;
  SELECT value INTO v_enabled FROM public.app_settings WHERE key='collection_'||p_platform||'_analytics_enabled' FOR SHARE;
  IF v_enabled IS NULL OR jsonb_typeof(v_enabled)<>'boolean' THEN
    RAISE EXCEPTION 'META_ANALYTICS_CONFIGURATION_UNAVAILABLE' USING ERRCODE='MAH05'; END IF;
  IF v_enabled='false'::jsonb THEN RETURN jsonb_build_object('state','disabled'); END IF;
  SELECT value INTO v_policy FROM public.app_settings WHERE key='collection_'||p_platform||'_analytics_policy' FOR SHARE;
  v_ids:=public.meta_analytics_policy_ids(v_policy);
  RETURN jsonb_build_object('state','enabled','account_ids',v_ids,'policy_digest',encode(sha256(convert_to(v_policy::text,'utf8')),'hex'));
END;
$fn$;

CREATE FUNCTION public.meta_analytics_retention_policy(p_platform text,p_dry_run boolean)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path=public,pg_temp AS $fn$
DECLARE v_enabled jsonb;v_policy jsonb;
BEGIN
  IF p_platform IS NULL OR p_platform NOT IN ('facebook','threads') OR p_dry_run IS NULL THEN
    RAISE EXCEPTION 'META_ANALYTICS_INVALID_RETENTION' USING ERRCODE='MAH01'; END IF;
  IF NOT p_dry_run THEN
    SELECT value INTO v_enabled FROM public.app_settings WHERE key='retention_'||p_platform||'_analytics_enabled' FOR SHARE;
    IF v_enabled IS NULL OR jsonb_typeof(v_enabled)<>'boolean' THEN
      RAISE EXCEPTION 'META_ANALYTICS_CONFIGURATION_UNAVAILABLE' USING ERRCODE='MAH05'; END IF;
    IF v_enabled='false'::jsonb THEN RETURN jsonb_build_object('state','disabled'); END IF;
  END IF;
  SELECT value INTO v_policy FROM public.app_settings WHERE key='retention_'||p_platform||'_analytics_policy' FOR SHARE;
  RETURN jsonb_build_object('state','enabled','account_ids',public.meta_analytics_policy_ids(v_policy));
END;
$fn$;

CREATE OR REPLACE FUNCTION public.meta_analytics_retention_allowed(p_platform text,p_account uuid,p_dry_run boolean)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path=public,pg_temp AS $fn$
DECLARE v_policy jsonb;
BEGIN
  IF p_platform IS NULL OR p_platform NOT IN ('facebook','threads') OR p_account IS NULL OR p_dry_run IS NULL THEN RETURN false; END IF;
  v_policy:=public.meta_analytics_retention_policy(p_platform,p_dry_run);
  RETURN v_policy->>'state'='enabled' AND (v_policy->'account_ids') @> jsonb_build_array(p_account::text);
EXCEPTION WHEN SQLSTATE 'MAH05' THEN RETURN false;
END;
$fn$;

CREATE TABLE public.meta_analytics_retention_visits (
  social_account_id uuid PRIMARY KEY,user_id uuid NOT NULL,platform text NOT NULL CHECK(platform IN ('facebook','threads')),
  last_visited_at timestamptz NOT NULL CHECK(isfinite(last_visited_at)),
  FOREIGN KEY(social_account_id,user_id,platform) REFERENCES public.social_accounts(id,user_id,platform) ON DELETE CASCADE
);
ALTER TABLE public.meta_analytics_retention_visits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.meta_analytics_retention_visits FROM PUBLIC,anon,authenticated,service_role;
CREATE INDEX meta_analytics_retention_visit_order ON public.meta_analytics_retention_visits(platform,last_visited_at,social_account_id);

CREATE FUNCTION public.list_meta_analytics_retention_targets(p_platform text,p_dry_run boolean)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=public,pg_temp SET lock_timeout='3s' AS $fn$
DECLARE v_policy jsonb;v_targets jsonb;
BEGIN
  PERFORM public.meta_analytics_assert_service();
  v_policy:=public.meta_analytics_retention_policy(p_platform,p_dry_run);
  IF v_policy->>'state'='disabled' THEN RETURN jsonb_build_object('state','disabled'); END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('account_id',t.account_id,'last_visited_at',v.last_visited_at)
    ORDER BY v.last_visited_at NULLS FIRST,t.account_id),'[]'::jsonb) INTO v_targets
    FROM (SELECT (e#>>'{}')::uuid account_id FROM jsonb_array_elements(v_policy->'account_ids') e) t
    LEFT JOIN public.meta_analytics_retention_visits v ON v.social_account_id=t.account_id AND v.platform=p_platform;
  RETURN jsonb_build_object('state','enabled','targets',v_targets);
END;
$fn$;

CREATE FUNCTION public.cleanup_meta_analytics_target(p_platform text,p_account_id uuid,p_floor timestamptz,p_limit integer,p_dry_run boolean)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=public,pg_temp SET lock_timeout='3s' AS $fn$
DECLARE v_owner uuid;v_receipt jsonb;
BEGIN
  PERFORM public.meta_analytics_assert_service();
  IF p_platform IS NULL OR p_platform NOT IN ('facebook','threads') THEN
    RAISE EXCEPTION 'META_ANALYTICS_INVALID_PLATFORM' USING ERRCODE='MAH01'; END IF;
  SELECT user_id INTO v_owner FROM public.social_accounts WHERE id=p_account_id AND platform=p_platform;
  IF v_owner IS NULL THEN RAISE EXCEPTION 'META_ANALYTICS_ACCOUNT_NOT_FOUND' USING ERRCODE='MAH02'; END IF;
  IF p_platform='facebook' THEN v_receipt:=public.cleanup_fb_analytics_history(v_owner,p_account_id,p_floor,p_limit,p_dry_run);
  ELSE v_receipt:=public.cleanup_threads_analytics_history(v_owner,p_account_id,p_floor,p_limit,p_dry_run); END IF;
  IF NOT p_dry_run THEN
    INSERT INTO public.meta_analytics_retention_visits(social_account_id,user_id,platform,last_visited_at)
      VALUES(p_account_id,v_owner,p_platform,clock_timestamp()) ON CONFLICT(social_account_id)
      DO UPDATE SET last_visited_at=EXCLUDED.last_visited_at;
  END IF;
  RETURN v_receipt;
END;
$fn$;
REVOKE ALL ON FUNCTION public.meta_analytics_policy_ids(jsonb) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.meta_analytics_retention_policy(text,boolean) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.list_meta_analytics_retention_targets(text,boolean) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.cleanup_meta_analytics_target(text,uuid,timestamptz,integer,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.list_meta_analytics_retention_targets(text,boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.cleanup_meta_analytics_target(text,uuid,timestamptz,integer,boolean) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
