-- Owned Meta analytics history. Additive; no pilot, schedule or retention activation.
-- Runtime RPCs use literal per-platform relations. SQLSTATE MAH01/02/03/04/05
-- are domain refusals, deliberately not PostgREST-retryable 40001.
BEGIN;

CREATE FUNCTION public.meta_analytics_assert_service()
RETURNS void LANGUAGE plpgsql STABLE SECURITY INVOKER
SET search_path = public, pg_temp AS $fn$
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'META_ANALYTICS_SERVICE_REQUIRED' USING ERRCODE = '42501';
  END IF;
END;
$fn$;

CREATE FUNCTION public.meta_analytics_reason_valid(p_reason text)
RETURNS boolean LANGUAGE sql IMMUTABLE STRICT
SET search_path = public, pg_temp AS $fn$
  SELECT p_reason = ANY(ARRAY['reauth_required','permission_missing','provider_error',
    'window_mismatch','outside_retention','capability_unverified','not_offered','not_collected']);
$fn$;

CREATE FUNCTION public.meta_analytics_metric_key_valid(p_key text)
RETURNS boolean LANGUAGE sql IMMUTABLE STRICT
SET search_path = public, pg_temp AS $fn$
  SELECT p_key = ANY(ARRAY['views','profile_views','reach','unique_viewers','impressions',
    'engagements','likes','comments','replies','shares','reposts','quotes','saves','followers']);
$fn$;

-- This is a database constraint projection of analyticsRegistry.ts, not a
-- caller-editable capability registry. New verified capabilities need a migration.
CREATE FUNCTION public.meta_analytics_provider_metric(
  p_platform text, p_level text, p_key text, p_window_kind text
) RETURNS text LANGUAGE sql IMMUTABLE STRICT
SET search_path = public, pg_temp AS $fn$
  SELECT CASE
    WHEN p_platform='facebook' AND p_level='account' AND p_window_kind='day' THEN
      CASE p_key WHEN 'views' THEN 'page_media_view'
        WHEN 'unique_viewers' THEN 'page_total_media_view_unique'
        WHEN 'engagements' THEN 'page_post_engagements' WHEN 'followers' THEN 'page_follows' END
    WHEN p_platform='facebook' AND p_level='post' AND p_window_kind='lifetime' THEN
      CASE p_key WHEN 'views' THEN 'post_media_view' WHEN 'unique_viewers' THEN 'post_total_media_view_unique' END
    WHEN p_platform='threads' AND p_level='account' AND p_key='profile_views' AND p_window_kind='day' THEN 'views'
    WHEN p_platform='threads' AND p_level='account' AND p_key='followers' AND p_window_kind='point_in_time' THEN 'followers_count'
    WHEN p_platform='threads' AND p_level='post' AND p_window_kind='lifetime'
      AND p_key=ANY(ARRAY['views','likes','replies','reposts','quotes','shares']) THEN p_key
  END;
$fn$;

CREATE FUNCTION public.meta_analytics_metric_valid(
  p_platform text,p_level text,p_key text,p_status text,p_value bigint,p_reason text,
  p_provider_metric text,p_api_version text,p_window_kind text,p_timezone text,
  p_since timestamptz,p_until timestamptz,p_source text
) RETURNS boolean LANGUAGE plpgsql IMMUTABLE
SET search_path = public, pg_temp AS $fn$
DECLARE v_expected text;
BEGIN
  -- Instagram capability is still unverified. Preserve the actual legacy
  -- window when supplied, without promoting raw legacy counts to availability.
  IF p_platform='instagram' AND p_status='unavailable' THEN
    IF NOT COALESCE(p_level IN ('account','post') AND public.meta_analytics_metric_key_valid(p_key)
      AND p_value IS NULL AND public.meta_analytics_reason_valid(p_reason) AND p_provider_metric IS NULL
      AND p_api_version='v22.0' AND p_source='instagram_graph_v22'
      AND p_window_kind IN ('day','period_total','lifetime','point_in_time'),false) THEN RETURN false; END IF;
    IF p_timezone IS NULL AND p_since IS NULL AND p_until IS NULL THEN RETURN true; END IF;
    IF p_window_kind NOT IN ('day','period_total') OR p_timezone IS NULL OR length(p_timezone)>64
      OR p_since IS NULL OR p_until IS NULL OR NOT isfinite(p_since) OR NOT isfinite(p_until) OR p_until<=p_since THEN RETURN false; END IF;
    BEGIN
      PERFORM p_since AT TIME ZONE p_timezone;
    EXCEPTION WHEN invalid_parameter_value THEN RETURN false;
    END;
    RETURN true;
  END IF;
  IF p_platform IS NULL OR p_level IS NULL OR p_key IS NULL OR p_status IS NULL
    OR p_api_version IS NULL OR p_window_kind IS NULL OR p_source IS NULL
    OR p_level NOT IN ('account','post') OR NOT public.meta_analytics_metric_key_valid(p_key)
    OR p_window_kind NOT IN ('day','period_total','point_in_time','lifetime')
    OR p_api_version <> (CASE p_platform WHEN 'facebook' THEN 'v25.0' WHEN 'threads' THEN 'v1.0' WHEN 'instagram' THEN 'v22.0' ELSE '' END)
    OR p_source <> (CASE p_platform WHEN 'facebook' THEN 'meta_graph_v25' WHEN 'threads' THEN 'threads_graph_v1' WHEN 'instagram' THEN 'instagram_graph_v22' ELSE '' END)
    OR p_provider_metric IS NOT NULL AND p_provider_metric !~ '^[a-z][a-z0-9_]{0,99}$'
    OR p_timezone IS DISTINCT FROM 'America/Los_Angeles' AND p_window_kind IN ('day','period_total')
    OR p_window_kind IN ('day','period_total') AND (p_since IS NULL OR p_until IS NULL OR NOT isfinite(p_since) OR NOT isfinite(p_until) OR p_until<=p_since)
    OR p_window_kind IN ('point_in_time','lifetime') AND (p_since IS NOT NULL OR p_until IS NOT NULL OR p_timezone IS NOT NULL)
  THEN RETURN false; END IF;
  IF p_status='unavailable' THEN
    RETURN p_value IS NULL AND COALESCE(public.meta_analytics_reason_valid(p_reason),false);
  END IF;
  v_expected := public.meta_analytics_provider_metric(p_platform,p_level,p_key,p_window_kind);
  RETURN COALESCE(p_status='available' AND p_reason IS NULL AND p_value BETWEEN 0 AND 9007199254740991
    AND v_expected IS NOT NULL AND p_provider_metric IS NOT DISTINCT FROM v_expected,false);
END;
$fn$;

CREATE FUNCTION public.meta_analytics_validate_metric_map(p_metrics jsonb,p_expected text[])
RETURNS void LANGUAGE plpgsql IMMUTABLE
SET search_path = public, pg_temp AS $fn$
DECLARE v_key text; v_cell jsonb; v_keys text[]; v_expected text[];
BEGIN
  IF p_metrics IS NULL OR jsonb_typeof(p_metrics)<>'object' OR pg_column_size(p_metrics)>131072
    OR cardinality(p_expected) NOT BETWEEN 1 AND 14 THEN
    RAISE EXCEPTION 'META_ANALYTICS_INVALID_METRICS' USING ERRCODE='MAH01';
  END IF;
  SELECT array_agg(k ORDER BY k) INTO v_keys FROM jsonb_object_keys(p_metrics) k;
  SELECT array_agg(DISTINCT k ORDER BY k) INTO v_expected FROM unnest(p_expected) k;
  IF v_keys IS DISTINCT FROM v_expected OR cardinality(v_expected)<>cardinality(p_expected) THEN
    RAISE EXCEPTION 'META_ANALYTICS_METRIC_SET_MISMATCH' USING ERRCODE='MAH01';
  END IF;
  FOR v_key,v_cell IN SELECT * FROM jsonb_each(p_metrics) LOOP
    IF NOT public.meta_analytics_metric_key_valid(v_key) OR jsonb_typeof(v_cell)<>'object'
      OR EXISTS(SELECT 1 FROM jsonb_object_keys(v_cell) k WHERE k NOT IN ('status','value','reason')) THEN
      RAISE EXCEPTION 'META_ANALYTICS_INVALID_METRIC' USING ERRCODE='MAH01';
    END IF;
    IF v_cell->>'status'='available' THEN
      IF NOT(v_cell ? 'value') OR v_cell ? 'reason' OR jsonb_typeof(v_cell->'value')<>'number'
        OR (v_cell->>'value') !~ '^(0|[1-9][0-9]{0,15})$'
        OR (v_cell->>'value')::numeric>9007199254740991 THEN
        RAISE EXCEPTION 'META_ANALYTICS_INVALID_VALUE' USING ERRCODE='MAH01';
      END IF;
    ELSIF v_cell->>'status'='unavailable' THEN
      IF v_cell ? 'value' OR NOT COALESCE(public.meta_analytics_reason_valid(v_cell->>'reason'),false) THEN
        RAISE EXCEPTION 'META_ANALYTICS_INVALID_REASON' USING ERRCODE='MAH01';
      END IF;
    ELSE RAISE EXCEPTION 'META_ANALYTICS_INVALID_STATUS' USING ERRCODE='MAH01'; END IF;
  END LOOP;
END;
$fn$;

CREATE FUNCTION public.meta_analytics_collection_allowed(p_platform text,p_account uuid)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path=public,pg_temp AS $fn$
DECLARE v_enabled jsonb; v_policy jsonb;
BEGIN
  IF p_platform NOT IN ('facebook','threads') OR p_account IS NULL THEN RETURN false; END IF;
  SELECT value INTO v_enabled FROM public.app_settings WHERE key='collection_'||p_platform||'_analytics_enabled' FOR SHARE;
  IF v_enabled IS DISTINCT FROM 'true'::jsonb THEN RETURN false; END IF;
  SELECT value INTO v_policy FROM public.app_settings WHERE key='collection_'||p_platform||'_analytics_policy' FOR SHARE;
  IF v_policy IS NULL OR jsonb_typeof(v_policy)<>'object'
    OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(v_policy) k) IS DISTINCT FROM ARRAY['account_ids']::text[]
    OR jsonb_typeof(v_policy->'account_ids')<>'array' OR jsonb_array_length(v_policy->'account_ids')>100 THEN RETURN false; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(v_policy->'account_ids') e
    WHERE jsonb_typeof(e)<>'string' OR (e#>>'{}') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')
  THEN RETURN false; END IF;
  RETURN (v_policy->'account_ids') @> jsonb_build_array(p_account::text);
END;
$fn$;

INSERT INTO public.app_settings(key,value,description)
SELECT setting_key,setting_value,'Owned analytics: explicit activation approval required'
FROM (VALUES
 ('collection_facebook_analytics_enabled','false'::jsonb),('collection_threads_analytics_enabled','false'::jsonb),
 ('collection_facebook_analytics_policy','{"account_ids":[]}'::jsonb),('collection_threads_analytics_policy','{"account_ids":[]}'::jsonb),
 ('retention_facebook_analytics_enabled','false'::jsonb),('retention_threads_analytics_enabled','false'::jsonb),
 ('retention_facebook_analytics_policy','{"account_ids":[]}'::jsonb),('retention_threads_analytics_policy','{"account_ids":[]}'::jsonb)
) s(setting_key,setting_value) ON CONFLICT(key) DO NOTHING;

CREATE POLICY meta_analytics_settings_private ON public.app_settings AS RESTRICTIVE FOR ALL TO anon,authenticated
USING (key NOT IN ('collection_facebook_analytics_enabled','collection_threads_analytics_enabled',
 'collection_facebook_analytics_policy','collection_threads_analytics_policy','retention_facebook_analytics_enabled',
 'retention_threads_analytics_enabled','retention_facebook_analytics_policy','retention_threads_analytics_policy') OR public.has_role(auth.uid(),'admin'))
WITH CHECK (key NOT IN ('collection_facebook_analytics_enabled','collection_threads_analytics_enabled',
 'collection_facebook_analytics_policy','collection_threads_analytics_policy','retention_facebook_analytics_enabled',
 'retention_threads_analytics_enabled','retention_facebook_analytics_policy','retention_threads_analytics_policy') OR public.has_role(auth.uid(),'admin'));


CREATE TABLE public.fb_analytics_report_state (
  user_id uuid NOT NULL, social_account_id uuid PRIMARY KEY, platform text NOT NULL DEFAULT 'facebook' CHECK(platform='facebook'),
  report_revision bigint NOT NULL DEFAULT 1 CHECK(report_revision>0), next_capture_sequence bigint NOT NULL DEFAULT 0 CHECK(next_capture_sequence>=0),
  provider_timezone text NOT NULL DEFAULT 'America/Los_Angeles' CHECK(provider_timezone='America/Los_Angeles'),
  retention_floor timestamptz NOT NULL DEFAULT (((clock_timestamp() AT TIME ZONE 'UTC')::date-365)::timestamp AT TIME ZONE 'UTC'),
  credential_guarded boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(social_account_id,user_id,platform),
  FOREIGN KEY(social_account_id,user_id,platform) REFERENCES public.social_accounts(id,user_id,platform) ON DELETE CASCADE
);
CREATE TABLE public.fb_analytics_permission_observations (
  user_id uuid NOT NULL,social_account_id uuid PRIMARY KEY,platform text NOT NULL DEFAULT 'facebook' CHECK(platform='facebook'),
  authority jsonb NOT NULL CHECK(jsonb_typeof(authority)='object'),
  granted_scopes text[] NOT NULL CHECK(cardinality(granted_scopes) BETWEEN 0 AND 32),
  observed_at timestamptz NOT NULL CHECK(isfinite(observed_at)),
  state text NOT NULL CHECK(state IN ('verified','unavailable')),
  source_ref text NOT NULL CHECK(source_ref='meta_graph_v25'),
  UNIQUE(social_account_id,user_id,platform),
  FOREIGN KEY(social_account_id,user_id,platform) REFERENCES public.social_accounts(id,user_id,platform) ON DELETE CASCADE
);
CREATE TABLE public.fb_analytics_collection_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid NOT NULL,social_account_id uuid NOT NULL,
  platform text NOT NULL DEFAULT 'facebook' CHECK(platform='facebook'),
  due_on date NOT NULL,due_at timestamptz NOT NULL,next_due_at timestamptz NOT NULL,
  provider_timezone text NOT NULL DEFAULT 'America/Los_Angeles' CHECK(provider_timezone='America/Los_Angeles'),
  job_generation bigint NOT NULL DEFAULT 1 CHECK(job_generation>0),state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','running','partial','success','failed','retry')),
  claim_token uuid,lease_until timestamptz,credential_authority jsonb,
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),retry_at timestamptz,completed_at timestamptz,
  last_success_at timestamptz,last_partial_at timestamptz,reason_code text,
  created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK(isfinite(due_at) AND isfinite(next_due_at) AND due_at<next_due_at),
  CHECK(due_at=due_on::timestamp AT TIME ZONE provider_timezone AND next_due_at=(due_on+1)::timestamp AT TIME ZONE provider_timezone),
  CHECK((claim_token IS NULL)=(lease_until IS NULL)),
  CHECK(lease_until IS NULL OR isfinite(lease_until)),
  CHECK(reason_code IS NULL OR reason_code ~ '^[a-z0-9_]{1,64}$'),
  UNIQUE(id,user_id,social_account_id,platform),UNIQUE(user_id,social_account_id,due_on),
  FOREIGN KEY(social_account_id,user_id,platform) REFERENCES public.social_accounts(id,user_id,platform) ON DELETE CASCADE
);
CREATE INDEX fb_analytics_jobs_due ON public.fb_analytics_collection_jobs(state,retry_at,due_at,id);
CREATE INDEX fb_analytics_jobs_owner ON public.fb_analytics_collection_jobs(user_id,social_account_id,due_on DESC);
-- Equal-due jobs yield to the least recently served target. Claim/completion
-- use wall-clock updated_at so several RPCs in one transaction also yield.
CREATE INDEX fb_analytics_jobs_claim_target ON public.fb_analytics_collection_jobs(user_id,social_account_id,due_at,updated_at,id) WHERE state IN ('pending','running','partial','retry');
CREATE TABLE public.fb_analytics_collection_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),job_id uuid NOT NULL,user_id uuid NOT NULL,social_account_id uuid NOT NULL,
  platform text NOT NULL DEFAULT 'facebook' CHECK(platform='facebook'),job_generation bigint NOT NULL CHECK(job_generation>0),
  operation_key text NOT NULL CHECK(operation_key ~ '^[a-zA-Z0-9_:.-]{1,200}$'),
  kind text NOT NULL CHECK(kind IN ('account_day','post','profile','period_total')),
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','success','unavailable','failed')),
  requested_metrics text[] NOT NULL CHECK(cardinality(requested_metrics) BETWEEN 1 AND 14),
  completed_at timestamptz,reason_code text,
  UNIQUE(id,job_id,job_generation,user_id,social_account_id,platform),UNIQUE(job_id,job_generation,operation_key),
  FOREIGN KEY(job_id,user_id,social_account_id,platform) REFERENCES public.fb_analytics_collection_jobs(id,user_id,social_account_id,platform) ON DELETE CASCADE
);
CREATE INDEX fb_analytics_operations_owner ON public.fb_analytics_collection_operations(user_id,social_account_id,job_id,job_generation);
CREATE TABLE public.fb_analytics_collection_checkpoints (
  job_id uuid NOT NULL,user_id uuid NOT NULL,social_account_id uuid NOT NULL,
  platform text NOT NULL DEFAULT 'facebook' CHECK(platform='facebook'),job_generation bigint NOT NULL CHECK(job_generation>0),
  inventory_cursor text,post_ids text[] NOT NULL DEFAULT '{}',pages_fetched integer NOT NULL DEFAULT 0 CHECK(pages_fetched>=0),
  inventory_complete boolean NOT NULL DEFAULT false,inventory_truncated boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK(cardinality(post_ids)<=500),
  CHECK(inventory_cursor IS NULL OR (length(inventory_cursor) BETWEEN 1 AND 4096 AND inventory_cursor !~ '://|[[:space:]]' AND lower(inventory_cursor) NOT LIKE '%access_token%')),
  PRIMARY KEY(job_id,job_generation),
  FOREIGN KEY(job_id,user_id,social_account_id,platform) REFERENCES public.fb_analytics_collection_jobs(id,user_id,social_account_id,platform) ON DELETE CASCADE
);
CREATE INDEX fb_analytics_checkpoint_owner ON public.fb_analytics_collection_checkpoints(user_id,social_account_id,job_id);
CREATE TABLE public.fb_analytics_captures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),job_id uuid NOT NULL,operation_id uuid NOT NULL,job_generation bigint NOT NULL,claim_token uuid NOT NULL,
  user_id uuid NOT NULL,social_account_id uuid NOT NULL,platform text NOT NULL DEFAULT 'facebook' CHECK(platform='facebook'),
  capture_sequence bigint NOT NULL CHECK(capture_sequence>0),kind text NOT NULL CHECK(kind IN ('account_day','post','profile','period_total')),
  subject_id text NOT NULL CHECK(subject_id ~ '^[a-zA-Z0-9_-]{1,200}$'),metric_date date,
  window_since timestamptz,window_until timestamptz,provider_timezone text,
  api_version text NOT NULL CHECK(api_version='v25.0'),requested_metrics text[] NOT NULL CHECK(cardinality(requested_metrics) BETWEEN 1 AND 14),
  credential_authority jsonb NOT NULL CHECK(jsonb_typeof(credential_authority)='object'),
  requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),received_at timestamptz,
  payload_digest text CHECK(payload_digest IS NULL OR payload_digest ~ '^[a-f0-9]{64}$'),receipt jsonb,
  CHECK((received_at IS NULL)=(payload_digest IS NULL) AND (receipt IS NULL)=(payload_digest IS NULL)),
  CHECK(received_at IS NULL OR (isfinite(received_at) AND received_at>=requested_at)),
  CHECK((kind IN ('account_day','period_total') AND window_since IS NOT NULL AND window_until IS NOT NULL AND isfinite(window_since) AND isfinite(window_until) AND window_since<window_until AND provider_timezone='America/Los_Angeles')
    OR (kind IN ('post','profile') AND window_since IS NULL AND window_until IS NULL AND provider_timezone IS NULL)),
  CHECK((kind='account_day')=(metric_date IS NOT NULL)),
  UNIQUE(id,user_id,social_account_id,platform),UNIQUE(user_id,social_account_id,capture_sequence),
  FOREIGN KEY(operation_id,job_id,job_generation,user_id,social_account_id,platform)
    REFERENCES public.fb_analytics_collection_operations(id,job_id,job_generation,user_id,social_account_id,platform) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED
);
ALTER TABLE public.fb_analytics_captures ADD FOREIGN KEY(social_account_id,user_id,platform) REFERENCES public.social_accounts(id,user_id,platform) ON DELETE CASCADE;
CREATE INDEX fb_analytics_capture_job ON public.fb_analytics_captures(job_id,job_generation,operation_id);
CREATE TABLE public.fb_page_insight_daily (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid NOT NULL,social_account_id uuid NOT NULL,
  platform text NOT NULL DEFAULT 'facebook' CHECK(platform='facebook'),metric_date date NOT NULL,
  period_start timestamptz NOT NULL,period_end timestamptz NOT NULL,provider_timezone text NOT NULL CHECK(provider_timezone='America/Los_Angeles'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK(period_start=metric_date::timestamp AT TIME ZONE provider_timezone AND period_end=(metric_date+1)::timestamp AT TIME ZONE provider_timezone),
  UNIQUE(id,user_id,social_account_id,platform),UNIQUE(user_id,social_account_id,metric_date),
  FOREIGN KEY(social_account_id,user_id,platform) REFERENCES public.social_accounts(id,user_id,platform) ON DELETE CASCADE
);
CREATE INDEX fb_analytics_daily_owner ON public.fb_page_insight_daily(user_id,social_account_id,metric_date DESC);
CREATE TABLE public.fb_post_insight_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid NOT NULL,social_account_id uuid NOT NULL,
  platform text NOT NULL DEFAULT 'facebook' CHECK(platform='facebook'),platform_post_id text NOT NULL CHECK(platform_post_id ~ '^[a-zA-Z0-9_-]{1,200}$'),
  captured_on date NOT NULL,published_at timestamptz NOT NULL CHECK(isfinite(published_at)),
  post_text text NOT NULL DEFAULT '' CHECK(length(post_text)<=10000),permalink text,
  metadata_capture_id uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
  CHECK(permalink IS NULL OR (length(permalink)<=2048 AND permalink ~ '^https://[^[:space:]]+$')),
  UNIQUE(id,user_id,social_account_id,platform),UNIQUE(user_id,social_account_id,platform_post_id,captured_on),
  FOREIGN KEY(social_account_id,user_id,platform) REFERENCES public.social_accounts(id,user_id,platform) ON DELETE CASCADE,
  FOREIGN KEY(metadata_capture_id,user_id,social_account_id,platform) REFERENCES public.fb_analytics_captures(id,user_id,social_account_id,platform) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX fb_analytics_posts_owner ON public.fb_post_insight_snapshots(user_id,social_account_id,published_at DESC,platform_post_id DESC,captured_on DESC);
CREATE INDEX fb_analytics_posts_capture ON public.fb_post_insight_snapshots(metadata_capture_id,user_id,social_account_id,platform);
CREATE TABLE public.fb_page_profile_observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid NOT NULL,social_account_id uuid NOT NULL,
  platform text NOT NULL DEFAULT 'facebook' CHECK(platform='facebook'),capture_id uuid NOT NULL,
  observed_at timestamptz NOT NULL CHECK(isfinite(observed_at)),created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(id,user_id,social_account_id,platform),UNIQUE(user_id,social_account_id,capture_id),
  FOREIGN KEY(social_account_id,user_id,platform) REFERENCES public.social_accounts(id,user_id,platform) ON DELETE CASCADE,
  FOREIGN KEY(capture_id,user_id,social_account_id,platform) REFERENCES public.fb_analytics_captures(id,user_id,social_account_id,platform) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX fb_analytics_profile_owner ON public.fb_page_profile_observations(user_id,social_account_id,observed_at DESC,id DESC);
CREATE INDEX fb_analytics_profile_capture ON public.fb_page_profile_observations(capture_id,user_id,social_account_id,platform);
CREATE TABLE public.fb_analytics_metric_values (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid NOT NULL,social_account_id uuid NOT NULL,
  platform text NOT NULL DEFAULT 'facebook' CHECK(platform='facebook'),daily_id uuid,post_snapshot_id uuid,profile_observation_id uuid,
  metric_key text NOT NULL,status text NOT NULL,value bigint,reason text,
  provider_metric text,api_version text NOT NULL,window_kind text NOT NULL,provider_timezone text,
  window_since timestamptz,window_until timestamptz,source_ref text NOT NULL,
  capture_id uuid NOT NULL,observed_at timestamptz NOT NULL CHECK(isfinite(observed_at)),
  CHECK(num_nonnulls(daily_id,post_snapshot_id,profile_observation_id)=1),
  CHECK((daily_id IS NULL OR window_kind='day') AND (post_snapshot_id IS NULL OR window_kind='lifetime') AND (profile_observation_id IS NULL OR window_kind='point_in_time')),
  CHECK(public.meta_analytics_metric_valid(platform,CASE WHEN post_snapshot_id IS NOT NULL THEN 'post' ELSE 'account' END,
    metric_key,status,value,reason,provider_metric,api_version,window_kind,provider_timezone,window_since,window_until,source_ref)),
  FOREIGN KEY(social_account_id,user_id,platform) REFERENCES public.social_accounts(id,user_id,platform) ON DELETE CASCADE,
  FOREIGN KEY(daily_id,user_id,social_account_id,platform) REFERENCES public.fb_page_insight_daily(id,user_id,social_account_id,platform) ON DELETE CASCADE,
  FOREIGN KEY(post_snapshot_id,user_id,social_account_id,platform) REFERENCES public.fb_post_insight_snapshots(id,user_id,social_account_id,platform) ON DELETE CASCADE,
  FOREIGN KEY(profile_observation_id,user_id,social_account_id,platform) REFERENCES public.fb_page_profile_observations(id,user_id,social_account_id,platform) ON DELETE CASCADE,
  FOREIGN KEY(capture_id,user_id,social_account_id,platform) REFERENCES public.fb_analytics_captures(id,user_id,social_account_id,platform) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED
);
CREATE UNIQUE INDEX fb_analytics_metric_daily_key ON public.fb_analytics_metric_values(daily_id,metric_key) WHERE daily_id IS NOT NULL;
CREATE UNIQUE INDEX fb_analytics_metric_post_key ON public.fb_analytics_metric_values(post_snapshot_id,metric_key) WHERE post_snapshot_id IS NOT NULL;
CREATE UNIQUE INDEX fb_analytics_metric_profile_key ON public.fb_analytics_metric_values(profile_observation_id,metric_key) WHERE profile_observation_id IS NOT NULL;
CREATE INDEX fb_analytics_metric_owner ON public.fb_analytics_metric_values(user_id,social_account_id,metric_key,observed_at DESC);
CREATE INDEX fb_analytics_metric_capture ON public.fb_analytics_metric_values(capture_id,user_id,social_account_id,platform);
CREATE TABLE public.fb_analytics_period_totals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid NOT NULL,social_account_id uuid NOT NULL,
  platform text NOT NULL DEFAULT 'facebook' CHECK(platform='facebook'),level text NOT NULL CHECK(level IN ('account','post')),
  subject_id text NOT NULL CHECK(subject_id ~ '^[a-zA-Z0-9_-]{1,200}$'),metric_key text NOT NULL,
  api_version text NOT NULL,provider_timezone text NOT NULL,window_since timestamptz NOT NULL,window_until timestamptz NOT NULL,
  captured_on date NOT NULL,status text NOT NULL,value bigint,reason text,provider_metric text,
  source_ref text NOT NULL,capture_id uuid NOT NULL,observed_at timestamptz NOT NULL CHECK(isfinite(observed_at)),
  CHECK(public.meta_analytics_metric_valid(platform,level,metric_key,status,value,reason,provider_metric,api_version,'period_total',provider_timezone,window_since,window_until,source_ref)),
  UNIQUE(user_id,social_account_id,level,subject_id,metric_key,api_version,provider_timezone,window_since,window_until,captured_on),
  FOREIGN KEY(social_account_id,user_id,platform) REFERENCES public.social_accounts(id,user_id,platform) ON DELETE CASCADE,
  FOREIGN KEY(capture_id,user_id,social_account_id,platform) REFERENCES public.fb_analytics_captures(id,user_id,social_account_id,platform) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX fb_analytics_totals_owner ON public.fb_analytics_period_totals(user_id,social_account_id,window_since,window_until,captured_on DESC);
CREATE INDEX fb_analytics_totals_capture ON public.fb_analytics_period_totals(capture_id,user_id,social_account_id,platform);


CREATE TABLE public.threads_analytics_report_state (
  user_id uuid NOT NULL, social_account_id uuid PRIMARY KEY, platform text NOT NULL DEFAULT 'threads' CHECK(platform='threads'),
  report_revision bigint NOT NULL DEFAULT 1 CHECK(report_revision>0), next_capture_sequence bigint NOT NULL DEFAULT 0 CHECK(next_capture_sequence>=0),
  provider_timezone text NOT NULL DEFAULT 'America/Los_Angeles' CHECK(provider_timezone='America/Los_Angeles'),
  retention_floor timestamptz NOT NULL DEFAULT (((clock_timestamp() AT TIME ZONE 'UTC')::date-365)::timestamp AT TIME ZONE 'UTC'),
  credential_guarded boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(social_account_id,user_id,platform),
  FOREIGN KEY(social_account_id,user_id,platform) REFERENCES public.social_accounts(id,user_id,platform) ON DELETE CASCADE
);
CREATE TABLE public.threads_analytics_permission_observations (
  user_id uuid NOT NULL,social_account_id uuid PRIMARY KEY,platform text NOT NULL DEFAULT 'threads' CHECK(platform='threads'),
  authority jsonb NOT NULL CHECK(jsonb_typeof(authority)='object'),
  granted_scopes text[] NOT NULL CHECK(cardinality(granted_scopes) BETWEEN 0 AND 32),
  observed_at timestamptz NOT NULL CHECK(isfinite(observed_at)),
  state text NOT NULL CHECK(state IN ('verified','unavailable')),
  source_ref text NOT NULL CHECK(source_ref='threads_graph_v1'),
  UNIQUE(social_account_id,user_id,platform),
  FOREIGN KEY(social_account_id,user_id,platform) REFERENCES public.social_accounts(id,user_id,platform) ON DELETE CASCADE
);
CREATE TABLE public.threads_analytics_collection_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid NOT NULL,social_account_id uuid NOT NULL,
  platform text NOT NULL DEFAULT 'threads' CHECK(platform='threads'),
  due_on date NOT NULL,due_at timestamptz NOT NULL,next_due_at timestamptz NOT NULL,
  provider_timezone text NOT NULL DEFAULT 'America/Los_Angeles' CHECK(provider_timezone='America/Los_Angeles'),
  job_generation bigint NOT NULL DEFAULT 1 CHECK(job_generation>0),state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','running','partial','success','failed','retry')),
  claim_token uuid,lease_until timestamptz,credential_authority jsonb,
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),retry_at timestamptz,completed_at timestamptz,
  last_success_at timestamptz,last_partial_at timestamptz,reason_code text,
  created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK(isfinite(due_at) AND isfinite(next_due_at) AND due_at<next_due_at),
  CHECK(due_at=due_on::timestamp AT TIME ZONE provider_timezone AND next_due_at=(due_on+1)::timestamp AT TIME ZONE provider_timezone),
  CHECK((claim_token IS NULL)=(lease_until IS NULL)),
  CHECK(lease_until IS NULL OR isfinite(lease_until)),
  CHECK(reason_code IS NULL OR reason_code ~ '^[a-z0-9_]{1,64}$'),
  UNIQUE(id,user_id,social_account_id,platform),UNIQUE(user_id,social_account_id,due_on),
  FOREIGN KEY(social_account_id,user_id,platform) REFERENCES public.social_accounts(id,user_id,platform) ON DELETE CASCADE
);
CREATE INDEX threads_analytics_jobs_due ON public.threads_analytics_collection_jobs(state,retry_at,due_at,id);
CREATE INDEX threads_analytics_jobs_owner ON public.threads_analytics_collection_jobs(user_id,social_account_id,due_on DESC);
CREATE INDEX threads_analytics_jobs_claim_target ON public.threads_analytics_collection_jobs(user_id,social_account_id,due_at,updated_at,id) WHERE state IN ('pending','running','partial','retry');
CREATE TABLE public.threads_analytics_collection_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),job_id uuid NOT NULL,user_id uuid NOT NULL,social_account_id uuid NOT NULL,
  platform text NOT NULL DEFAULT 'threads' CHECK(platform='threads'),job_generation bigint NOT NULL CHECK(job_generation>0),
  operation_key text NOT NULL CHECK(operation_key ~ '^[a-zA-Z0-9_:.-]{1,200}$'),
  kind text NOT NULL CHECK(kind IN ('account_day','post','profile','period_total')),
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','success','unavailable','failed')),
  requested_metrics text[] NOT NULL CHECK(cardinality(requested_metrics) BETWEEN 1 AND 14),
  completed_at timestamptz,reason_code text,
  UNIQUE(id,job_id,job_generation,user_id,social_account_id,platform),UNIQUE(job_id,job_generation,operation_key),
  FOREIGN KEY(job_id,user_id,social_account_id,platform) REFERENCES public.threads_analytics_collection_jobs(id,user_id,social_account_id,platform) ON DELETE CASCADE
);
CREATE INDEX threads_analytics_operations_owner ON public.threads_analytics_collection_operations(user_id,social_account_id,job_id,job_generation);
CREATE TABLE public.threads_analytics_collection_checkpoints (
  job_id uuid NOT NULL,user_id uuid NOT NULL,social_account_id uuid NOT NULL,
  platform text NOT NULL DEFAULT 'threads' CHECK(platform='threads'),job_generation bigint NOT NULL CHECK(job_generation>0),
  inventory_cursor text,post_ids text[] NOT NULL DEFAULT '{}',pages_fetched integer NOT NULL DEFAULT 0 CHECK(pages_fetched>=0),
  inventory_complete boolean NOT NULL DEFAULT false,inventory_truncated boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK(cardinality(post_ids)<=500),
  CHECK(inventory_cursor IS NULL OR (length(inventory_cursor) BETWEEN 1 AND 4096 AND inventory_cursor !~ '://|[[:space:]]' AND lower(inventory_cursor) NOT LIKE '%access_token%')),
  PRIMARY KEY(job_id,job_generation),
  FOREIGN KEY(job_id,user_id,social_account_id,platform) REFERENCES public.threads_analytics_collection_jobs(id,user_id,social_account_id,platform) ON DELETE CASCADE
);
CREATE INDEX threads_analytics_checkpoint_owner ON public.threads_analytics_collection_checkpoints(user_id,social_account_id,job_id);
CREATE TABLE public.threads_analytics_captures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),job_id uuid NOT NULL,operation_id uuid NOT NULL,job_generation bigint NOT NULL,claim_token uuid NOT NULL,
  user_id uuid NOT NULL,social_account_id uuid NOT NULL,platform text NOT NULL DEFAULT 'threads' CHECK(platform='threads'),
  capture_sequence bigint NOT NULL CHECK(capture_sequence>0),kind text NOT NULL CHECK(kind IN ('account_day','post','profile','period_total')),
  subject_id text NOT NULL CHECK(subject_id ~ '^[a-zA-Z0-9_-]{1,200}$'),metric_date date,
  window_since timestamptz,window_until timestamptz,provider_timezone text,
  api_version text NOT NULL CHECK(api_version='v1.0'),requested_metrics text[] NOT NULL CHECK(cardinality(requested_metrics) BETWEEN 1 AND 14),
  credential_authority jsonb NOT NULL CHECK(jsonb_typeof(credential_authority)='object'),
  requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),received_at timestamptz,
  payload_digest text CHECK(payload_digest IS NULL OR payload_digest ~ '^[a-f0-9]{64}$'),receipt jsonb,
  CHECK((received_at IS NULL)=(payload_digest IS NULL) AND (receipt IS NULL)=(payload_digest IS NULL)),
  CHECK(received_at IS NULL OR (isfinite(received_at) AND received_at>=requested_at)),
  CHECK((kind IN ('account_day','period_total') AND window_since IS NOT NULL AND window_until IS NOT NULL AND isfinite(window_since) AND isfinite(window_until) AND window_since<window_until AND provider_timezone='America/Los_Angeles')
    OR (kind IN ('post','profile') AND window_since IS NULL AND window_until IS NULL AND provider_timezone IS NULL)),
  CHECK((kind='account_day')=(metric_date IS NOT NULL)),
  UNIQUE(id,user_id,social_account_id,platform),UNIQUE(user_id,social_account_id,capture_sequence),
  FOREIGN KEY(operation_id,job_id,job_generation,user_id,social_account_id,platform)
    REFERENCES public.threads_analytics_collection_operations(id,job_id,job_generation,user_id,social_account_id,platform) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED
);
ALTER TABLE public.threads_analytics_captures ADD FOREIGN KEY(social_account_id,user_id,platform) REFERENCES public.social_accounts(id,user_id,platform) ON DELETE CASCADE;
CREATE INDEX threads_analytics_capture_job ON public.threads_analytics_captures(job_id,job_generation,operation_id);
CREATE TABLE public.threads_account_insight_daily (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid NOT NULL,social_account_id uuid NOT NULL,
  platform text NOT NULL DEFAULT 'threads' CHECK(platform='threads'),metric_date date NOT NULL,
  period_start timestamptz NOT NULL,period_end timestamptz NOT NULL,provider_timezone text NOT NULL CHECK(provider_timezone='America/Los_Angeles'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK(period_start=metric_date::timestamp AT TIME ZONE provider_timezone AND period_end=(metric_date+1)::timestamp AT TIME ZONE provider_timezone),
  UNIQUE(id,user_id,social_account_id,platform),UNIQUE(user_id,social_account_id,metric_date),
  FOREIGN KEY(social_account_id,user_id,platform) REFERENCES public.social_accounts(id,user_id,platform) ON DELETE CASCADE
);
CREATE INDEX threads_analytics_daily_owner ON public.threads_account_insight_daily(user_id,social_account_id,metric_date DESC);
CREATE TABLE public.threads_post_insight_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid NOT NULL,social_account_id uuid NOT NULL,
  platform text NOT NULL DEFAULT 'threads' CHECK(platform='threads'),platform_post_id text NOT NULL CHECK(platform_post_id ~ '^[a-zA-Z0-9_-]{1,200}$'),
  captured_on date NOT NULL,published_at timestamptz NOT NULL CHECK(isfinite(published_at)),
  post_text text NOT NULL DEFAULT '' CHECK(length(post_text)<=10000),permalink text,
  metadata_capture_id uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
  CHECK(permalink IS NULL OR (length(permalink)<=2048 AND permalink ~ '^https://[^[:space:]]+$')),
  UNIQUE(id,user_id,social_account_id,platform),UNIQUE(user_id,social_account_id,platform_post_id,captured_on),
  FOREIGN KEY(social_account_id,user_id,platform) REFERENCES public.social_accounts(id,user_id,platform) ON DELETE CASCADE,
  FOREIGN KEY(metadata_capture_id,user_id,social_account_id,platform) REFERENCES public.threads_analytics_captures(id,user_id,social_account_id,platform) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX threads_analytics_posts_owner ON public.threads_post_insight_snapshots(user_id,social_account_id,published_at DESC,platform_post_id DESC,captured_on DESC);
CREATE INDEX threads_analytics_posts_capture ON public.threads_post_insight_snapshots(metadata_capture_id,user_id,social_account_id,platform);
CREATE TABLE public.threads_account_profile_observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid NOT NULL,social_account_id uuid NOT NULL,
  platform text NOT NULL DEFAULT 'threads' CHECK(platform='threads'),capture_id uuid NOT NULL,
  observed_at timestamptz NOT NULL CHECK(isfinite(observed_at)),created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(id,user_id,social_account_id,platform),UNIQUE(user_id,social_account_id,capture_id),
  FOREIGN KEY(social_account_id,user_id,platform) REFERENCES public.social_accounts(id,user_id,platform) ON DELETE CASCADE,
  FOREIGN KEY(capture_id,user_id,social_account_id,platform) REFERENCES public.threads_analytics_captures(id,user_id,social_account_id,platform) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX threads_analytics_profile_owner ON public.threads_account_profile_observations(user_id,social_account_id,observed_at DESC,id DESC);
CREATE INDEX threads_analytics_profile_capture ON public.threads_account_profile_observations(capture_id,user_id,social_account_id,platform);
CREATE TABLE public.threads_analytics_metric_values (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid NOT NULL,social_account_id uuid NOT NULL,
  platform text NOT NULL DEFAULT 'threads' CHECK(platform='threads'),daily_id uuid,post_snapshot_id uuid,profile_observation_id uuid,
  metric_key text NOT NULL,status text NOT NULL,value bigint,reason text,
  provider_metric text,api_version text NOT NULL,window_kind text NOT NULL,provider_timezone text,
  window_since timestamptz,window_until timestamptz,source_ref text NOT NULL,
  capture_id uuid NOT NULL,observed_at timestamptz NOT NULL CHECK(isfinite(observed_at)),
  CHECK(num_nonnulls(daily_id,post_snapshot_id,profile_observation_id)=1),
  CHECK((daily_id IS NULL OR window_kind='day') AND (post_snapshot_id IS NULL OR window_kind='lifetime') AND (profile_observation_id IS NULL OR window_kind='point_in_time')),
  CHECK(public.meta_analytics_metric_valid(platform,CASE WHEN post_snapshot_id IS NOT NULL THEN 'post' ELSE 'account' END,
    metric_key,status,value,reason,provider_metric,api_version,window_kind,provider_timezone,window_since,window_until,source_ref)),
  FOREIGN KEY(social_account_id,user_id,platform) REFERENCES public.social_accounts(id,user_id,platform) ON DELETE CASCADE,
  FOREIGN KEY(daily_id,user_id,social_account_id,platform) REFERENCES public.threads_account_insight_daily(id,user_id,social_account_id,platform) ON DELETE CASCADE,
  FOREIGN KEY(post_snapshot_id,user_id,social_account_id,platform) REFERENCES public.threads_post_insight_snapshots(id,user_id,social_account_id,platform) ON DELETE CASCADE,
  FOREIGN KEY(profile_observation_id,user_id,social_account_id,platform) REFERENCES public.threads_account_profile_observations(id,user_id,social_account_id,platform) ON DELETE CASCADE,
  FOREIGN KEY(capture_id,user_id,social_account_id,platform) REFERENCES public.threads_analytics_captures(id,user_id,social_account_id,platform) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED
);
CREATE UNIQUE INDEX threads_analytics_metric_daily_key ON public.threads_analytics_metric_values(daily_id,metric_key) WHERE daily_id IS NOT NULL;
CREATE UNIQUE INDEX threads_analytics_metric_post_key ON public.threads_analytics_metric_values(post_snapshot_id,metric_key) WHERE post_snapshot_id IS NOT NULL;
CREATE UNIQUE INDEX threads_analytics_metric_profile_key ON public.threads_analytics_metric_values(profile_observation_id,metric_key) WHERE profile_observation_id IS NOT NULL;
CREATE INDEX threads_analytics_metric_owner ON public.threads_analytics_metric_values(user_id,social_account_id,metric_key,observed_at DESC);
CREATE INDEX threads_analytics_metric_capture ON public.threads_analytics_metric_values(capture_id,user_id,social_account_id,platform);
CREATE TABLE public.threads_analytics_period_totals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid NOT NULL,social_account_id uuid NOT NULL,
  platform text NOT NULL DEFAULT 'threads' CHECK(platform='threads'),level text NOT NULL CHECK(level IN ('account','post')),
  subject_id text NOT NULL CHECK(subject_id ~ '^[a-zA-Z0-9_-]{1,200}$'),metric_key text NOT NULL,
  api_version text NOT NULL,provider_timezone text NOT NULL,window_since timestamptz NOT NULL,window_until timestamptz NOT NULL,
  captured_on date NOT NULL,status text NOT NULL,value bigint,reason text,provider_metric text,
  source_ref text NOT NULL,capture_id uuid NOT NULL,observed_at timestamptz NOT NULL CHECK(isfinite(observed_at)),
  CHECK(public.meta_analytics_metric_valid(platform,level,metric_key,status,value,reason,provider_metric,api_version,'period_total',provider_timezone,window_since,window_until,source_ref)),
  UNIQUE(user_id,social_account_id,level,subject_id,metric_key,api_version,provider_timezone,window_since,window_until,captured_on),
  FOREIGN KEY(social_account_id,user_id,platform) REFERENCES public.social_accounts(id,user_id,platform) ON DELETE CASCADE,
  FOREIGN KEY(capture_id,user_id,social_account_id,platform) REFERENCES public.threads_analytics_captures(id,user_id,social_account_id,platform) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX threads_analytics_totals_owner ON public.threads_analytics_period_totals(user_id,social_account_id,window_since,window_until,captured_on DESC);
CREATE INDEX threads_analytics_totals_capture ON public.threads_analytics_period_totals(capture_id,user_id,social_account_id,platform);

CREATE TABLE public.threads_analytics_connection_fences (
  social_account_id uuid PRIMARY KEY,user_id uuid NOT NULL,platform text NOT NULL DEFAULT 'threads' CHECK(platform='threads'),
  credential_generation bigint NOT NULL DEFAULT 1 CHECK(credential_generation>0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(social_account_id,user_id,platform) REFERENCES public.social_accounts(id,user_id,platform) ON DELETE CASCADE
);
CREATE INDEX threads_analytics_connection_owner ON public.threads_analytics_connection_fences(user_id,social_account_id);
CREATE FUNCTION public.meta_analytics_threads_epoch_trigger()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
BEGIN
  IF OLD.platform='threads' AND ROW(OLD.access_token,OLD.refresh_token,OLD.token_expires_at,OLD.platform_user_id,OLD.user_id,OLD.platform,OLD.is_active,OLD.needs_reauth)
    IS DISTINCT FROM ROW(NEW.access_token,NEW.refresh_token,NEW.token_expires_at,NEW.platform_user_id,NEW.user_id,NEW.platform,NEW.is_active,NEW.needs_reauth) THEN
    INSERT INTO public.threads_analytics_connection_fences(social_account_id,user_id,platform,credential_generation)
    VALUES(OLD.id,OLD.user_id,'threads',1)
    ON CONFLICT(social_account_id) DO UPDATE SET credential_generation=public.threads_analytics_connection_fences.credential_generation+1,updated_at=now();
  END IF;
  RETURN NEW;
END;
$fn$;
CREATE TRIGGER meta_analytics_threads_epoch BEFORE UPDATE ON public.social_accounts
FOR EACH ROW EXECUTE FUNCTION public.meta_analytics_threads_epoch_trigger();

CREATE FUNCTION public.meta_analytics_fb_guarded(p_account uuid,p_owner uuid)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
DECLARE v_guarded boolean;
BEGIN
  IF auth.role()='authenticated' AND (auth.uid() IS NULL OR p_owner IS DISTINCT FROM auth.uid()) THEN
    RAISE EXCEPTION 'META_ANALYTICS_ACCOUNT_NOT_FOUND' USING ERRCODE='MAH02';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.social_accounts WHERE id=p_account AND user_id=p_owner AND platform='facebook') THEN
    RAISE EXCEPTION 'META_ANALYTICS_ACCOUNT_NOT_FOUND' USING ERRCODE='MAH02';
  END IF;
  SELECT credential_guarded INTO v_guarded FROM public.fb_analytics_report_state WHERE social_account_id=p_account AND user_id=p_owner;
  RETURN COALESCE(v_guarded,false);
END;
$fn$;
CREATE FUNCTION public.meta_analytics_fb_guard_trigger()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $fn$
DECLARE v_writer name;
BEGIN
  IF OLD.platform<>'facebook' THEN RETURN NEW; END IF;
  IF ROW(OLD.access_token,OLD.refresh_token,OLD.token_expires_at,OLD.platform_user_id,OLD.user_id,OLD.platform,OLD.is_active,OLD.needs_reauth)
    IS NOT DISTINCT FROM ROW(NEW.access_token,NEW.refresh_token,NEW.token_expires_at,NEW.platform_user_id,NEW.user_id,NEW.platform,NEW.is_active,NEW.needs_reauth) THEN RETURN NEW; END IF;
  IF NOT public.meta_analytics_fb_guarded(OLD.id,OLD.user_id) THEN RETURN NEW; END IF;
  SELECT pg_get_userbyid(proowner) INTO v_writer FROM pg_proc WHERE oid='public.bind_facebook_user_credential(uuid,jsonb)'::regprocedure;
  IF current_user IS DISTINCT FROM v_writer THEN
    RAISE EXCEPTION 'META_ANALYTICS_FENCED_WRITER_REQUIRED' USING ERRCODE='MAH03';
  END IF;
  RETURN NEW;
END;
$fn$;
CREATE TRIGGER meta_analytics_fb_guard BEFORE UPDATE ON public.social_accounts
FOR EACH ROW EXECUTE FUNCTION public.meta_analytics_fb_guard_trigger();

CREATE FUNCTION public.meta_analytics_current_authority(p_platform text,p_account uuid,p_owner uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=public,pg_temp AS $fn$
DECLARE v_account public.social_accounts;v_context jsonb;v_generation bigint;
BEGIN
  SELECT * INTO v_account FROM public.social_accounts WHERE id=p_account AND user_id=p_owner AND platform=p_platform;
  IF NOT FOUND THEN RAISE EXCEPTION 'META_ANALYTICS_ACCOUNT_NOT_FOUND' USING ERRCODE='MAH02'; END IF;
  IF NOT v_account.is_active OR COALESCE(v_account.needs_reauth,false) OR NULLIF(btrim(v_account.access_token),'') IS NULL
    OR v_account.token_expires_at<=clock_timestamp() THEN
    RAISE EXCEPTION 'META_ANALYTICS_REAUTH_REQUIRED' USING ERRCODE='MAH03';
  END IF;
  IF p_platform='facebook' THEN
    SELECT jsonb_build_object('platform_user_id',v_account.platform_user_id,'connection_version',f.connection_version,
      'credential_id',c.id,'credential_revision',c.revision,'provider_user_id',c.provider_user_id,'token_expires_at',v_account.token_expires_at)
    INTO v_context FROM public.facebook_user_credential_bindings b
    JOIN public.facebook_user_credential_connection_fences f USING(social_account_id,user_id,platform)
    JOIN public.facebook_user_credentials c ON c.id=b.credential_id AND c.user_id=b.user_id
    WHERE b.social_account_id=p_account AND b.user_id=p_owner AND b.platform='facebook'
      AND b.connection_version=f.connection_version AND b.verified_facebook_user_id=c.provider_user_id
      AND c.provider_user_id IS NOT NULL AND b.evidence_source IN ('oauth_exchange','token_refresh') AND c.lifecycle='active';
    IF v_context IS NULL THEN RAISE EXCEPTION 'META_ANALYTICS_CREDENTIAL_AUTHORITY_MISSING' USING ERRCODE='MAH03'; END IF;
  ELSIF p_platform='threads' THEN
    SELECT credential_generation INTO v_generation FROM public.threads_analytics_connection_fences WHERE social_account_id=p_account AND user_id=p_owner;
    IF NOT FOUND THEN RAISE EXCEPTION 'META_ANALYTICS_CREDENTIAL_AUTHORITY_MISSING' USING ERRCODE='MAH03'; END IF;
    v_context:=jsonb_build_object('platform_user_id',v_account.platform_user_id,'credential_generation',v_generation,'token_expires_at',v_account.token_expires_at);
  ELSE RAISE EXCEPTION 'META_ANALYTICS_INVALID_PLATFORM' USING ERRCODE='MAH01'; END IF;
  RETURN v_context;
END;
$fn$;

CREATE FUNCTION public.meta_analytics_lock_account(p_account uuid,p_owner uuid,p_platform text,p_nowait boolean DEFAULT false)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=public,pg_temp AS $fn$
BEGIN
  IF p_nowait THEN
    PERFORM 1 FROM public.social_accounts WHERE id=p_account AND user_id=p_owner AND platform=p_platform FOR UPDATE NOWAIT;
  ELSE
    PERFORM 1 FROM public.social_accounts WHERE id=p_account AND user_id=p_owner AND platform=p_platform FOR UPDATE;
  END IF;
  IF NOT FOUND THEN RAISE EXCEPTION 'META_ANALYTICS_ACCOUNT_NOT_FOUND' USING ERRCODE='MAH02'; END IF;
  IF p_nowait THEN
    IF NOT pg_try_advisory_xact_lock(hashtext('social_account_guard:'||p_account::text)) THEN
      RAISE EXCEPTION 'META_ANALYTICS_BUSY' USING ERRCODE='55P03'; END IF;
    IF p_platform='facebook' AND NOT pg_try_advisory_xact_lock(hashtext('instagram_capability:'||p_account::text)) THEN
      RAISE EXCEPTION 'META_ANALYTICS_BUSY' USING ERRCODE='55P03'; END IF;
  ELSE
    PERFORM pg_advisory_xact_lock(hashtext('social_account_guard:'||p_account::text));
    IF p_platform='facebook' THEN PERFORM pg_advisory_xact_lock(hashtext('instagram_capability:'||p_account::text)); END IF;
  END IF;
END;
$fn$;
CREATE FUNCTION public.meta_analytics_state_monotonic()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $fn$
BEGIN
  IF OLD.credential_guarded AND NOT NEW.credential_guarded OR NEW.report_revision<OLD.report_revision
    OR NEW.next_capture_sequence<OLD.next_capture_sequence OR NEW.retention_floor IS NULL OR NEW.retention_floor<OLD.retention_floor
    OR NEW.provider_timezone<>OLD.provider_timezone THEN
    RAISE EXCEPTION 'META_ANALYTICS_STATE_REGRESSION' USING ERRCODE='MAH03';
  END IF;
  RETURN NEW;
END;
$fn$;
CREATE TRIGGER fb_analytics_state_monotonic BEFORE UPDATE ON public.fb_analytics_report_state FOR EACH ROW EXECUTE FUNCTION public.meta_analytics_state_monotonic();
CREATE TRIGGER threads_analytics_state_monotonic BEFORE UPDATE ON public.threads_analytics_report_state FOR EACH ROW EXECUTE FUNCTION public.meta_analytics_state_monotonic();


CREATE FUNCTION public.prepare_fb_analytics_account(p_user_id uuid,p_account_id uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp SET lock_timeout='3s' AS $fn$
DECLARE v_authority jsonb;
BEGIN
  PERFORM public.meta_analytics_assert_service();
  PERFORM public.meta_analytics_lock_account(p_account_id,p_user_id,'facebook');
  IF NOT public.meta_analytics_collection_allowed('facebook',p_account_id) THEN
    RAISE EXCEPTION 'META_ANALYTICS_COLLECTION_DISABLED' USING ERRCODE='MAH03'; END IF;

  v_authority:=public.meta_analytics_current_authority('facebook',p_account_id,p_user_id);
  INSERT INTO public.fb_analytics_report_state(user_id,social_account_id,credential_guarded)
    VALUES(p_user_id,p_account_id,true) ON CONFLICT(social_account_id) DO UPDATE SET credential_guarded=true;
  RETURN jsonb_build_object('account_id',p_account_id,'authority',v_authority);
END;
$fn$;
CREATE FUNCTION public.observe_fb_analytics_permissions(p_user_id uuid,p_account_id uuid,p_expected_authority jsonb,p_granted_scopes text[],p_verified_provider_id text,p_observed_at timestamptz,p_state text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp SET lock_timeout='3s' AS $fn$
DECLARE v_authority jsonb;v_previous public.fb_analytics_permission_observations;v_provider_id text;
BEGIN
  PERFORM public.meta_analytics_assert_service();
  PERFORM public.meta_analytics_lock_account(p_account_id,p_user_id,'facebook');
  IF NOT public.meta_analytics_collection_allowed('facebook',p_account_id) THEN RAISE EXCEPTION 'META_ANALYTICS_COLLECTION_DISABLED' USING ERRCODE='MAH03'; END IF;
  v_authority:=public.meta_analytics_current_authority('facebook',p_account_id,p_user_id);
  IF p_expected_authority IS DISTINCT FROM v_authority THEN RAISE EXCEPTION 'META_ANALYTICS_CREDENTIAL_CHANGED' USING ERRCODE='MAH04'; END IF;
  v_provider_id:=v_authority->>'platform_user_id';
  IF p_verified_provider_id IS DISTINCT FROM v_provider_id OR p_state NOT IN ('verified','unavailable')
    OR p_observed_at IS NULL OR NOT isfinite(p_observed_at) OR p_observed_at>clock_timestamp()
    OR p_observed_at<clock_timestamp()-interval '5 minutes' OR p_granted_scopes IS NULL OR cardinality(p_granted_scopes)>32
    OR EXISTS(SELECT 1 FROM unnest(p_granted_scopes) k WHERE k IS NULL OR k !~ '^[a-z][a-z0-9_]{0,99}$')
    OR cardinality(p_granted_scopes)<>(SELECT count(DISTINCT k) FROM unnest(p_granted_scopes) k) THEN
    RAISE EXCEPTION 'META_ANALYTICS_INVALID_PERMISSION_OBSERVATION' USING ERRCODE='MAH01';
  END IF;
  PERFORM 1 FROM public.fb_analytics_report_state WHERE social_account_id=p_account_id AND user_id=p_user_id AND credential_guarded FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'META_ANALYTICS_ACCOUNT_NOT_PREPARED' USING ERRCODE='MAH03'; END IF;
  SELECT * INTO v_previous FROM public.fb_analytics_permission_observations WHERE social_account_id=p_account_id FOR UPDATE;
  IF FOUND AND (v_previous.granted_scopes IS DISTINCT FROM p_granted_scopes OR v_previous.state IS DISTINCT FROM p_state) THEN
    PERFORM public.facebook_user_credential_commit_connection_version(p_user_id,p_account_id,(v_authority->>'connection_version')::bigint);
    v_authority:=public.meta_analytics_current_authority('facebook',p_account_id,p_user_id);
  END IF;
  INSERT INTO public.fb_analytics_permission_observations(user_id,social_account_id,authority,granted_scopes,observed_at,state,source_ref)
    VALUES(p_user_id,p_account_id,v_authority,p_granted_scopes,p_observed_at,p_state,'meta_graph_v25')
  ON CONFLICT(social_account_id) DO UPDATE SET authority=EXCLUDED.authority,granted_scopes=EXCLUDED.granted_scopes,
    observed_at=EXCLUDED.observed_at,state=EXCLUDED.state;
  RETURN jsonb_build_object('account_id',p_account_id,'authority',v_authority,'state',p_state);
END;
$fn$;
CREATE FUNCTION public.fb_analytics_require_permission(p_user_id uuid,p_account_id uuid,p_authority jsonb)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=public,pg_temp AS $fn$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.fb_analytics_permission_observations
    WHERE user_id=p_user_id AND social_account_id=p_account_id AND authority=p_authority AND state='verified'
      AND granted_scopes @> ARRAY['read_insights','pages_read_engagement']::text[]) THEN
    RAISE EXCEPTION 'META_ANALYTICS_PERMISSION_REQUIRED' USING ERRCODE='MAH03'; END IF;
END;
$fn$;
CREATE FUNCTION public.enqueue_fb_analytics_collection_job(p_user_id uuid,p_account_id uuid,p_due_on date,p_force boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp SET lock_timeout='3s' AS $fn$
DECLARE v_authority jsonb;v_job public.fb_analytics_collection_jobs;v_due_at timestamptz;
BEGIN
  PERFORM public.meta_analytics_assert_service();
  PERFORM public.meta_analytics_lock_account(p_account_id,p_user_id,'facebook');
  IF p_due_on IS NULL OR p_due_on>(clock_timestamp() AT TIME ZONE 'America/Los_Angeles')::date
    OR p_due_on<(clock_timestamp() AT TIME ZONE 'America/Los_Angeles')::date-365 THEN
    RAISE EXCEPTION 'META_ANALYTICS_INVALID_DUE_DATE' USING ERRCODE='MAH01'; END IF;
  IF NOT public.meta_analytics_collection_allowed('facebook',p_account_id) THEN RAISE EXCEPTION 'META_ANALYTICS_COLLECTION_DISABLED' USING ERRCODE='MAH03'; END IF;
  v_authority:=public.meta_analytics_current_authority('facebook',p_account_id,p_user_id);
  PERFORM public.fb_analytics_require_permission(p_user_id,p_account_id,v_authority);
  PERFORM 1 FROM public.fb_analytics_report_state WHERE social_account_id=p_account_id AND user_id=p_user_id AND credential_guarded FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'META_ANALYTICS_ACCOUNT_NOT_PREPARED' USING ERRCODE='MAH03'; END IF;
  v_due_at:=p_due_on::timestamp AT TIME ZONE 'America/Los_Angeles';
  INSERT INTO public.fb_analytics_collection_jobs(user_id,social_account_id,due_on,due_at,next_due_at)
    VALUES(p_user_id,p_account_id,p_due_on,v_due_at,(p_due_on+1)::timestamp AT TIME ZONE 'America/Los_Angeles') ON CONFLICT(user_id,social_account_id,due_on) DO NOTHING;
  SELECT * INTO v_job FROM public.fb_analytics_collection_jobs WHERE user_id=p_user_id AND social_account_id=p_account_id AND due_on=p_due_on FOR UPDATE;
  IF p_force THEN
    UPDATE public.fb_analytics_collection_jobs SET job_generation=job_generation+1,state='pending',claim_token=NULL,lease_until=NULL,
      credential_authority=NULL,completed_at=NULL,last_success_at=NULL,retry_at=NULL,reason_code=NULL,updated_at=clock_timestamp() WHERE id=v_job.id RETURNING * INTO v_job;
  END IF;
  RETURN jsonb_build_object('job_id',v_job.id,'job_generation',v_job.job_generation,'state',v_job.state,'due_at',v_job.due_at,'next_due_at',v_job.next_due_at);
END;
$fn$;
CREATE FUNCTION public.claim_fb_analytics_collection_jobs(p_limit integer DEFAULT 1)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp SET lock_timeout='3s' AS $fn$
DECLARE v_candidate record;v_job public.fb_analytics_collection_jobs;v_authority jsonb;v_jobs jsonb:='[]';v_claim uuid;v_hint jsonb;v_accounts uuid[];
BEGIN
  PERFORM public.meta_analytics_assert_service();
  IF p_limit IS NULL OR p_limit<>1 THEN RAISE EXCEPTION 'META_ANALYTICS_INVALID_LIMIT' USING ERRCODE='MAH01'; END IF;
  -- Search hints are bounded and never grant authority. The locked policy
  -- is checked again after the candidate's parent lock, before any claim.
  SELECT value->'account_ids' INTO v_hint FROM public.app_settings WHERE key='collection_facebook_analytics_policy';
  IF v_hint IS NULL OR jsonb_typeof(v_hint)<>'array' OR jsonb_array_length(v_hint)>100 THEN RETURN '[]'::jsonb; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(v_hint) e WHERE jsonb_typeof(e)<>'string'
    OR e#>>'{}' !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$') THEN RETURN '[]'::jsonb; END IF;
  SELECT array_agg(DISTINCT (e#>>'{}')::uuid) INTO v_accounts FROM jsonb_array_elements(v_hint) e;
  FOR v_candidate IN SELECT j.id,j.user_id,j.social_account_id FROM unnest(v_accounts) h(account_id)
    JOIN public.social_accounts a ON a.id=h.account_id AND a.platform='facebook'
    CROSS JOIN LATERAL(SELECT q.id,q.user_id,q.social_account_id,q.due_at,q.updated_at FROM public.fb_analytics_collection_jobs q
      WHERE q.user_id=a.user_id AND q.social_account_id=a.id AND q.state IN ('pending','running','partial','retry')
        AND q.due_on>=(clock_timestamp() AT TIME ZONE 'America/Los_Angeles')::date-365
        AND (q.retry_at IS NULL OR q.retry_at<=clock_timestamp()) AND (q.lease_until IS NULL OR q.lease_until<=clock_timestamp())
        AND q.due_at<=clock_timestamp() ORDER BY q.due_at,q.updated_at,q.id LIMIT 1) j
    ORDER BY j.due_at,j.updated_at,j.id LOOP
    EXIT WHEN jsonb_array_length(v_jobs)>=p_limit;
    BEGIN
      PERFORM public.meta_analytics_lock_account(v_candidate.social_account_id,v_candidate.user_id,'facebook',true);
      IF NOT public.meta_analytics_collection_allowed('facebook',v_candidate.social_account_id) THEN RAISE EXCEPTION 'META_ANALYTICS_NOT_ELIGIBLE' USING ERRCODE='MAH03'; END IF;
      v_authority:=public.meta_analytics_current_authority('facebook',v_candidate.social_account_id,v_candidate.user_id);
      PERFORM public.fb_analytics_require_permission(v_candidate.user_id,v_candidate.social_account_id,v_authority);
      PERFORM 1 FROM public.fb_analytics_report_state WHERE social_account_id=v_candidate.social_account_id AND user_id=v_candidate.user_id AND credential_guarded FOR UPDATE NOWAIT;
      IF NOT FOUND THEN RAISE EXCEPTION 'META_ANALYTICS_NOT_ELIGIBLE' USING ERRCODE='MAH03'; END IF;
      SELECT * INTO v_job FROM public.fb_analytics_collection_jobs WHERE id=v_candidate.id FOR UPDATE NOWAIT;
      IF v_job.state NOT IN ('pending','running','partial','retry') OR v_job.lease_until>clock_timestamp() OR v_job.retry_at>clock_timestamp() THEN RAISE EXCEPTION 'META_ANALYTICS_STALE_CLAIM' USING ERRCODE='MAH04'; END IF;
      v_claim:=gen_random_uuid();
      UPDATE public.fb_analytics_collection_jobs SET
        job_generation=job_generation+CASE WHEN credential_authority IS NOT NULL AND credential_authority IS DISTINCT FROM v_authority THEN 1 ELSE 0 END,
        state='running',claim_token=v_claim,lease_until=clock_timestamp()+interval '120 seconds',credential_authority=v_authority,
        attempts=attempts+1,retry_at=NULL,updated_at=clock_timestamp() WHERE id=v_job.id RETURNING * INTO v_job;
      v_jobs:=v_jobs||jsonb_build_array(jsonb_build_object('job_id',v_job.id,'user_id',v_job.user_id,'account_id',v_job.social_account_id,
        'job_generation',v_job.job_generation,'claim_token',v_job.claim_token,'lease_until',v_job.lease_until,'authority',v_authority,
        'due_on',v_job.due_on,'due_at',v_job.due_at,'next_due_at',v_job.next_due_at));
    EXCEPTION WHEN lock_not_available THEN CONTINUE;
      WHEN SQLSTATE 'MAH02' OR SQLSTATE 'MAH03' OR SQLSTATE 'MAH04' THEN CONTINUE;
    END;
  END LOOP;
  RETURN v_jobs;
END;
$fn$;
CREATE FUNCTION public.fb_analytics_fenced_job(p_job_id uuid,p_claim_token uuid,p_job_generation bigint)
RETURNS public.fb_analytics_collection_jobs LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=public,pg_temp AS $fn$
DECLARE v_job public.fb_analytics_collection_jobs;v_authority jsonb;
BEGIN
  SELECT * INTO v_job FROM public.fb_analytics_collection_jobs WHERE id=p_job_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'META_ANALYTICS_JOB_NOT_FOUND' USING ERRCODE='MAH02'; END IF;
  PERFORM public.meta_analytics_lock_account(v_job.social_account_id,v_job.user_id,'facebook');
  IF NOT public.meta_analytics_collection_allowed('facebook',v_job.social_account_id) THEN RAISE EXCEPTION 'META_ANALYTICS_COLLECTION_DISABLED' USING ERRCODE='MAH03'; END IF;
  v_authority:=public.meta_analytics_current_authority('facebook',v_job.social_account_id,v_job.user_id);
  PERFORM public.fb_analytics_require_permission(v_job.user_id,v_job.social_account_id,v_authority);
  PERFORM 1 FROM public.fb_analytics_report_state WHERE social_account_id=v_job.social_account_id AND user_id=v_job.user_id AND credential_guarded FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'META_ANALYTICS_ACCOUNT_NOT_PREPARED' USING ERRCODE='MAH03'; END IF;
  SELECT * INTO v_job FROM public.fb_analytics_collection_jobs WHERE id=p_job_id FOR UPDATE;
  IF v_job.state<>'running' OR v_job.claim_token IS DISTINCT FROM p_claim_token OR v_job.job_generation IS DISTINCT FROM p_job_generation
    OR v_job.lease_until IS NULL OR v_job.lease_until<=clock_timestamp() OR v_job.credential_authority IS DISTINCT FROM v_authority THEN
    RAISE EXCEPTION 'META_ANALYTICS_STALE_CLAIM' USING ERRCODE='MAH04'; END IF;
  RETURN v_job;
END;
$fn$;
CREATE FUNCTION public.read_fb_analytics_collection_credential(p_job_id uuid,p_claim_token uuid,p_job_generation bigint)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp SET lock_timeout='3s' AS $fn$
DECLARE v_job public.fb_analytics_collection_jobs;v_token text;
BEGIN
  PERFORM public.meta_analytics_assert_service();
  v_job:=public.fb_analytics_fenced_job(p_job_id,p_claim_token,p_job_generation);
  SELECT access_token INTO v_token FROM public.social_accounts WHERE id=v_job.social_account_id AND user_id=v_job.user_id AND platform='facebook';
  IF v_job.lease_until<=clock_timestamp() THEN RAISE EXCEPTION 'META_ANALYTICS_STALE_CLAIM' USING ERRCODE='MAH04'; END IF;
  RETURN jsonb_build_object('job_id',v_job.id,'job_generation',v_job.job_generation,'authority',v_job.credential_authority,'access_token',v_token);
END;
$fn$;
CREATE FUNCTION public.checkpoint_fb_analytics_inventory(p_job_id uuid,p_claim_token uuid,p_job_generation bigint,p_cursor text,p_post_ids text[],p_pages_fetched integer,p_complete boolean,p_truncated boolean)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp SET lock_timeout='3s' AS $fn$
DECLARE v_job public.fb_analytics_collection_jobs;v_previous public.fb_analytics_collection_checkpoints;
BEGIN
  PERFORM public.meta_analytics_assert_service();
  v_job:=public.fb_analytics_fenced_job(p_job_id,p_claim_token,p_job_generation);
  IF p_post_ids IS NULL OR cardinality(p_post_ids)>500 OR p_pages_fetched IS NULL OR p_pages_fetched<0
    OR p_complete IS NULL OR p_truncated IS NULL OR p_complete AND (p_cursor IS NOT NULL OR p_truncated)
    OR EXISTS(SELECT 1 FROM unnest(p_post_ids) k WHERE k IS NULL OR length(k)>200 OR k !~ '^[0-9]+_[0-9]+$'
      OR split_part(k,'_',1) IS DISTINCT FROM v_job.credential_authority->>'platform_user_id')
    OR cardinality(p_post_ids)<>(SELECT count(DISTINCT k) FROM unnest(p_post_ids) k) THEN
    RAISE EXCEPTION 'META_ANALYTICS_INVALID_INVENTORY' USING ERRCODE='MAH01'; END IF;
  SELECT * INTO v_previous FROM public.fb_analytics_collection_checkpoints WHERE job_id=p_job_id AND job_generation=p_job_generation FOR UPDATE;
  IF FOUND AND (p_pages_fetched<v_previous.pages_fetched OR NOT p_post_ids @> v_previous.post_ids
    OR v_previous.inventory_complete AND NOT p_complete) THEN RAISE EXCEPTION 'META_ANALYTICS_INVENTORY_REGRESSION' USING ERRCODE='MAH04'; END IF;
  IF v_job.lease_until<=clock_timestamp() THEN RAISE EXCEPTION 'META_ANALYTICS_STALE_CLAIM' USING ERRCODE='MAH04'; END IF;
  INSERT INTO public.fb_analytics_collection_checkpoints(job_id,user_id,social_account_id,job_generation,inventory_cursor,post_ids,pages_fetched,inventory_complete,inventory_truncated)
    VALUES(p_job_id,v_job.user_id,v_job.social_account_id,p_job_generation,p_cursor,p_post_ids,p_pages_fetched,p_complete,p_truncated)
  ON CONFLICT(job_id,job_generation) DO UPDATE SET inventory_cursor=EXCLUDED.inventory_cursor,post_ids=EXCLUDED.post_ids,
    pages_fetched=EXCLUDED.pages_fetched,inventory_complete=EXCLUDED.inventory_complete,inventory_truncated=EXCLUDED.inventory_truncated,updated_at=now();
  RETURN jsonb_build_object('job_id',p_job_id,'job_generation',p_job_generation,'pages_fetched',p_pages_fetched,'inventory_complete',p_complete);
END;
$fn$;


CREATE FUNCTION public.prepare_threads_analytics_account(p_user_id uuid,p_account_id uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp SET lock_timeout='3s' AS $fn$
DECLARE v_authority jsonb;
BEGIN
  PERFORM public.meta_analytics_assert_service();
  PERFORM public.meta_analytics_lock_account(p_account_id,p_user_id,'threads');
  IF NOT public.meta_analytics_collection_allowed('threads',p_account_id) THEN
    RAISE EXCEPTION 'META_ANALYTICS_COLLECTION_DISABLED' USING ERRCODE='MAH03'; END IF;
  INSERT INTO public.threads_analytics_connection_fences(social_account_id,user_id) VALUES(p_account_id,p_user_id) ON CONFLICT(social_account_id) DO NOTHING;
  v_authority:=public.meta_analytics_current_authority('threads',p_account_id,p_user_id);
  INSERT INTO public.threads_analytics_report_state(user_id,social_account_id,credential_guarded)
    VALUES(p_user_id,p_account_id,true) ON CONFLICT(social_account_id) DO UPDATE SET credential_guarded=true;
  RETURN jsonb_build_object('account_id',p_account_id,'authority',v_authority);
END;
$fn$;
CREATE FUNCTION public.observe_threads_analytics_permissions(p_user_id uuid,p_account_id uuid,p_expected_authority jsonb,p_granted_scopes text[],p_verified_provider_id text,p_observed_at timestamptz,p_state text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp SET lock_timeout='3s' AS $fn$
DECLARE v_authority jsonb;v_previous public.threads_analytics_permission_observations;v_provider_id text;
BEGIN
  PERFORM public.meta_analytics_assert_service();
  PERFORM public.meta_analytics_lock_account(p_account_id,p_user_id,'threads');
  IF NOT public.meta_analytics_collection_allowed('threads',p_account_id) THEN RAISE EXCEPTION 'META_ANALYTICS_COLLECTION_DISABLED' USING ERRCODE='MAH03'; END IF;
  v_authority:=public.meta_analytics_current_authority('threads',p_account_id,p_user_id);
  IF p_expected_authority IS DISTINCT FROM v_authority THEN RAISE EXCEPTION 'META_ANALYTICS_CREDENTIAL_CHANGED' USING ERRCODE='MAH04'; END IF;
  v_provider_id:=v_authority->>'platform_user_id';
  IF p_verified_provider_id IS DISTINCT FROM v_provider_id OR p_state NOT IN ('verified','unavailable')
    OR p_observed_at IS NULL OR NOT isfinite(p_observed_at) OR p_observed_at>clock_timestamp()
    OR p_observed_at<clock_timestamp()-interval '5 minutes' OR p_granted_scopes IS NULL OR cardinality(p_granted_scopes)>32
    OR EXISTS(SELECT 1 FROM unnest(p_granted_scopes) k WHERE k IS NULL OR k !~ '^[a-z][a-z0-9_]{0,99}$')
    OR cardinality(p_granted_scopes)<>(SELECT count(DISTINCT k) FROM unnest(p_granted_scopes) k) THEN
    RAISE EXCEPTION 'META_ANALYTICS_INVALID_PERMISSION_OBSERVATION' USING ERRCODE='MAH01';
  END IF;
  PERFORM 1 FROM public.threads_analytics_report_state WHERE social_account_id=p_account_id AND user_id=p_user_id AND credential_guarded FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'META_ANALYTICS_ACCOUNT_NOT_PREPARED' USING ERRCODE='MAH03'; END IF;
  SELECT * INTO v_previous FROM public.threads_analytics_permission_observations WHERE social_account_id=p_account_id FOR UPDATE;
  IF FOUND AND (v_previous.granted_scopes IS DISTINCT FROM p_granted_scopes OR v_previous.state IS DISTINCT FROM p_state) THEN
    UPDATE public.threads_analytics_connection_fences SET credential_generation=credential_generation+1,updated_at=now() WHERE social_account_id=p_account_id AND user_id=p_user_id;
    v_authority:=public.meta_analytics_current_authority('threads',p_account_id,p_user_id);
  END IF;
  INSERT INTO public.threads_analytics_permission_observations(user_id,social_account_id,authority,granted_scopes,observed_at,state,source_ref)
    VALUES(p_user_id,p_account_id,v_authority,p_granted_scopes,p_observed_at,p_state,'threads_graph_v1')
  ON CONFLICT(social_account_id) DO UPDATE SET authority=EXCLUDED.authority,granted_scopes=EXCLUDED.granted_scopes,
    observed_at=EXCLUDED.observed_at,state=EXCLUDED.state;
  RETURN jsonb_build_object('account_id',p_account_id,'authority',v_authority,'state',p_state);
END;
$fn$;
CREATE FUNCTION public.threads_analytics_require_permission(p_user_id uuid,p_account_id uuid,p_authority jsonb)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=public,pg_temp AS $fn$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.threads_analytics_permission_observations
    WHERE user_id=p_user_id AND social_account_id=p_account_id AND authority=p_authority AND state='verified'
      AND granted_scopes @> ARRAY['threads_basic','threads_manage_insights']::text[]) THEN
    RAISE EXCEPTION 'META_ANALYTICS_PERMISSION_REQUIRED' USING ERRCODE='MAH03'; END IF;
END;
$fn$;
CREATE FUNCTION public.enqueue_threads_analytics_collection_job(p_user_id uuid,p_account_id uuid,p_due_on date,p_force boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp SET lock_timeout='3s' AS $fn$
DECLARE v_authority jsonb;v_job public.threads_analytics_collection_jobs;v_due_at timestamptz;
BEGIN
  PERFORM public.meta_analytics_assert_service();
  PERFORM public.meta_analytics_lock_account(p_account_id,p_user_id,'threads');
  IF p_due_on IS NULL OR p_due_on>(clock_timestamp() AT TIME ZONE 'America/Los_Angeles')::date
    OR p_due_on<(clock_timestamp() AT TIME ZONE 'America/Los_Angeles')::date-365 THEN
    RAISE EXCEPTION 'META_ANALYTICS_INVALID_DUE_DATE' USING ERRCODE='MAH01'; END IF;
  IF NOT public.meta_analytics_collection_allowed('threads',p_account_id) THEN RAISE EXCEPTION 'META_ANALYTICS_COLLECTION_DISABLED' USING ERRCODE='MAH03'; END IF;
  v_authority:=public.meta_analytics_current_authority('threads',p_account_id,p_user_id);
  PERFORM public.threads_analytics_require_permission(p_user_id,p_account_id,v_authority);
  PERFORM 1 FROM public.threads_analytics_report_state WHERE social_account_id=p_account_id AND user_id=p_user_id AND credential_guarded FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'META_ANALYTICS_ACCOUNT_NOT_PREPARED' USING ERRCODE='MAH03'; END IF;
  v_due_at:=p_due_on::timestamp AT TIME ZONE 'America/Los_Angeles';
  INSERT INTO public.threads_analytics_collection_jobs(user_id,social_account_id,due_on,due_at,next_due_at)
    VALUES(p_user_id,p_account_id,p_due_on,v_due_at,(p_due_on+1)::timestamp AT TIME ZONE 'America/Los_Angeles') ON CONFLICT(user_id,social_account_id,due_on) DO NOTHING;
  SELECT * INTO v_job FROM public.threads_analytics_collection_jobs WHERE user_id=p_user_id AND social_account_id=p_account_id AND due_on=p_due_on FOR UPDATE;
  IF p_force THEN
    UPDATE public.threads_analytics_collection_jobs SET job_generation=job_generation+1,state='pending',claim_token=NULL,lease_until=NULL,
      credential_authority=NULL,completed_at=NULL,last_success_at=NULL,retry_at=NULL,reason_code=NULL,updated_at=clock_timestamp() WHERE id=v_job.id RETURNING * INTO v_job;
  END IF;
  RETURN jsonb_build_object('job_id',v_job.id,'job_generation',v_job.job_generation,'state',v_job.state,'due_at',v_job.due_at,'next_due_at',v_job.next_due_at);
END;
$fn$;
CREATE FUNCTION public.claim_threads_analytics_collection_jobs(p_limit integer DEFAULT 1)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp SET lock_timeout='3s' AS $fn$
DECLARE v_candidate record;v_job public.threads_analytics_collection_jobs;v_authority jsonb;v_jobs jsonb:='[]';v_claim uuid;v_hint jsonb;v_accounts uuid[];
BEGIN
  PERFORM public.meta_analytics_assert_service();
  IF p_limit IS NULL OR p_limit<>1 THEN RAISE EXCEPTION 'META_ANALYTICS_INVALID_LIMIT' USING ERRCODE='MAH01'; END IF;
  -- Search hints are bounded and never grant authority. The locked policy
  -- is checked again after the candidate's parent lock, before any claim.
  SELECT value->'account_ids' INTO v_hint FROM public.app_settings WHERE key='collection_threads_analytics_policy';
  IF v_hint IS NULL OR jsonb_typeof(v_hint)<>'array' OR jsonb_array_length(v_hint)>100 THEN RETURN '[]'::jsonb; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(v_hint) e WHERE jsonb_typeof(e)<>'string'
    OR e#>>'{}' !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$') THEN RETURN '[]'::jsonb; END IF;
  SELECT array_agg(DISTINCT (e#>>'{}')::uuid) INTO v_accounts FROM jsonb_array_elements(v_hint) e;
  FOR v_candidate IN SELECT j.id,j.user_id,j.social_account_id FROM unnest(v_accounts) h(account_id)
    JOIN public.social_accounts a ON a.id=h.account_id AND a.platform='threads'
    CROSS JOIN LATERAL(SELECT q.id,q.user_id,q.social_account_id,q.due_at,q.updated_at FROM public.threads_analytics_collection_jobs q
      WHERE q.user_id=a.user_id AND q.social_account_id=a.id AND q.state IN ('pending','running','partial','retry')
        AND q.due_on>=(clock_timestamp() AT TIME ZONE 'America/Los_Angeles')::date-365
        AND (q.retry_at IS NULL OR q.retry_at<=clock_timestamp()) AND (q.lease_until IS NULL OR q.lease_until<=clock_timestamp())
        AND q.due_at<=clock_timestamp() ORDER BY q.due_at,q.updated_at,q.id LIMIT 1) j
    ORDER BY j.due_at,j.updated_at,j.id LOOP
    EXIT WHEN jsonb_array_length(v_jobs)>=p_limit;
    BEGIN
      PERFORM public.meta_analytics_lock_account(v_candidate.social_account_id,v_candidate.user_id,'threads',true);
      IF NOT public.meta_analytics_collection_allowed('threads',v_candidate.social_account_id) THEN RAISE EXCEPTION 'META_ANALYTICS_NOT_ELIGIBLE' USING ERRCODE='MAH03'; END IF;
      v_authority:=public.meta_analytics_current_authority('threads',v_candidate.social_account_id,v_candidate.user_id);
      PERFORM public.threads_analytics_require_permission(v_candidate.user_id,v_candidate.social_account_id,v_authority);
      PERFORM 1 FROM public.threads_analytics_report_state WHERE social_account_id=v_candidate.social_account_id AND user_id=v_candidate.user_id AND credential_guarded FOR UPDATE NOWAIT;
      IF NOT FOUND THEN RAISE EXCEPTION 'META_ANALYTICS_NOT_ELIGIBLE' USING ERRCODE='MAH03'; END IF;
      SELECT * INTO v_job FROM public.threads_analytics_collection_jobs WHERE id=v_candidate.id FOR UPDATE NOWAIT;
      IF v_job.state NOT IN ('pending','running','partial','retry') OR v_job.lease_until>clock_timestamp() OR v_job.retry_at>clock_timestamp() THEN RAISE EXCEPTION 'META_ANALYTICS_STALE_CLAIM' USING ERRCODE='MAH04'; END IF;
      v_claim:=gen_random_uuid();
      UPDATE public.threads_analytics_collection_jobs SET
        job_generation=job_generation+CASE WHEN credential_authority IS NOT NULL AND credential_authority IS DISTINCT FROM v_authority THEN 1 ELSE 0 END,
        state='running',claim_token=v_claim,lease_until=clock_timestamp()+interval '120 seconds',credential_authority=v_authority,
        attempts=attempts+1,retry_at=NULL,updated_at=clock_timestamp() WHERE id=v_job.id RETURNING * INTO v_job;
      v_jobs:=v_jobs||jsonb_build_array(jsonb_build_object('job_id',v_job.id,'user_id',v_job.user_id,'account_id',v_job.social_account_id,
        'job_generation',v_job.job_generation,'claim_token',v_job.claim_token,'lease_until',v_job.lease_until,'authority',v_authority,
        'due_on',v_job.due_on,'due_at',v_job.due_at,'next_due_at',v_job.next_due_at));
    EXCEPTION WHEN lock_not_available THEN CONTINUE;
      WHEN SQLSTATE 'MAH02' OR SQLSTATE 'MAH03' OR SQLSTATE 'MAH04' THEN CONTINUE;
    END;
  END LOOP;
  RETURN v_jobs;
END;
$fn$;
CREATE FUNCTION public.threads_analytics_fenced_job(p_job_id uuid,p_claim_token uuid,p_job_generation bigint)
RETURNS public.threads_analytics_collection_jobs LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=public,pg_temp AS $fn$
DECLARE v_job public.threads_analytics_collection_jobs;v_authority jsonb;
BEGIN
  SELECT * INTO v_job FROM public.threads_analytics_collection_jobs WHERE id=p_job_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'META_ANALYTICS_JOB_NOT_FOUND' USING ERRCODE='MAH02'; END IF;
  PERFORM public.meta_analytics_lock_account(v_job.social_account_id,v_job.user_id,'threads');
  IF NOT public.meta_analytics_collection_allowed('threads',v_job.social_account_id) THEN RAISE EXCEPTION 'META_ANALYTICS_COLLECTION_DISABLED' USING ERRCODE='MAH03'; END IF;
  v_authority:=public.meta_analytics_current_authority('threads',v_job.social_account_id,v_job.user_id);
  PERFORM public.threads_analytics_require_permission(v_job.user_id,v_job.social_account_id,v_authority);
  PERFORM 1 FROM public.threads_analytics_report_state WHERE social_account_id=v_job.social_account_id AND user_id=v_job.user_id AND credential_guarded FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'META_ANALYTICS_ACCOUNT_NOT_PREPARED' USING ERRCODE='MAH03'; END IF;
  SELECT * INTO v_job FROM public.threads_analytics_collection_jobs WHERE id=p_job_id FOR UPDATE;
  IF v_job.state<>'running' OR v_job.claim_token IS DISTINCT FROM p_claim_token OR v_job.job_generation IS DISTINCT FROM p_job_generation
    OR v_job.lease_until IS NULL OR v_job.lease_until<=clock_timestamp() OR v_job.credential_authority IS DISTINCT FROM v_authority THEN
    RAISE EXCEPTION 'META_ANALYTICS_STALE_CLAIM' USING ERRCODE='MAH04'; END IF;
  RETURN v_job;
END;
$fn$;
CREATE FUNCTION public.read_threads_analytics_collection_credential(p_job_id uuid,p_claim_token uuid,p_job_generation bigint)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp SET lock_timeout='3s' AS $fn$
DECLARE v_job public.threads_analytics_collection_jobs;v_token text;
BEGIN
  PERFORM public.meta_analytics_assert_service();
  v_job:=public.threads_analytics_fenced_job(p_job_id,p_claim_token,p_job_generation);
  SELECT access_token INTO v_token FROM public.social_accounts WHERE id=v_job.social_account_id AND user_id=v_job.user_id AND platform='threads';
  IF v_job.lease_until<=clock_timestamp() THEN RAISE EXCEPTION 'META_ANALYTICS_STALE_CLAIM' USING ERRCODE='MAH04'; END IF;
  RETURN jsonb_build_object('job_id',v_job.id,'job_generation',v_job.job_generation,'authority',v_job.credential_authority,'access_token',v_token);
END;
$fn$;
CREATE FUNCTION public.checkpoint_threads_analytics_inventory(p_job_id uuid,p_claim_token uuid,p_job_generation bigint,p_cursor text,p_post_ids text[],p_pages_fetched integer,p_complete boolean,p_truncated boolean)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp SET lock_timeout='3s' AS $fn$
DECLARE v_job public.threads_analytics_collection_jobs;v_previous public.threads_analytics_collection_checkpoints;
BEGIN
  PERFORM public.meta_analytics_assert_service();
  v_job:=public.threads_analytics_fenced_job(p_job_id,p_claim_token,p_job_generation);
  IF p_post_ids IS NULL OR cardinality(p_post_ids)>500 OR p_pages_fetched IS NULL OR p_pages_fetched<0
    OR p_complete IS NULL OR p_truncated IS NULL OR p_complete AND (p_cursor IS NOT NULL OR p_truncated)
    OR EXISTS(SELECT 1 FROM unnest(p_post_ids) k WHERE k IS NULL OR k !~ '^[a-zA-Z0-9_-]{1,200}$')
    OR cardinality(p_post_ids)<>(SELECT count(DISTINCT k) FROM unnest(p_post_ids) k) THEN
    RAISE EXCEPTION 'META_ANALYTICS_INVALID_INVENTORY' USING ERRCODE='MAH01'; END IF;
  SELECT * INTO v_previous FROM public.threads_analytics_collection_checkpoints WHERE job_id=p_job_id AND job_generation=p_job_generation FOR UPDATE;
  IF FOUND AND (p_pages_fetched<v_previous.pages_fetched OR NOT p_post_ids @> v_previous.post_ids
    OR v_previous.inventory_complete AND NOT p_complete) THEN RAISE EXCEPTION 'META_ANALYTICS_INVENTORY_REGRESSION' USING ERRCODE='MAH04'; END IF;
  IF v_job.lease_until<=clock_timestamp() THEN RAISE EXCEPTION 'META_ANALYTICS_STALE_CLAIM' USING ERRCODE='MAH04'; END IF;
  INSERT INTO public.threads_analytics_collection_checkpoints(job_id,user_id,social_account_id,job_generation,inventory_cursor,post_ids,pages_fetched,inventory_complete,inventory_truncated)
    VALUES(p_job_id,v_job.user_id,v_job.social_account_id,p_job_generation,p_cursor,p_post_ids,p_pages_fetched,p_complete,p_truncated)
  ON CONFLICT(job_id,job_generation) DO UPDATE SET inventory_cursor=EXCLUDED.inventory_cursor,post_ids=EXCLUDED.post_ids,
    pages_fetched=EXCLUDED.pages_fetched,inventory_complete=EXCLUDED.inventory_complete,inventory_truncated=EXCLUDED.inventory_truncated,updated_at=now();
  RETURN jsonb_build_object('job_id',p_job_id,'job_generation',p_job_generation,'pages_fetched',p_pages_fetched,'inventory_complete',p_complete);
END;
$fn$;


CREATE FUNCTION public.reserve_fb_analytics_capture(p_job_id uuid,p_claim_token uuid,p_job_generation bigint,p_operation_key text,p_request jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp SET lock_timeout='3s' AS $fn$
DECLARE v_job public.fb_analytics_collection_jobs;v_kind text;v_subject text;v_metrics text[];v_operation public.fb_analytics_collection_operations;
  v_date date;v_since timestamptz;v_until timestamptz;v_zone text;v_sequence bigint;v_capture uuid:=gen_random_uuid();
BEGIN
  PERFORM public.meta_analytics_assert_service();
  v_job:=public.fb_analytics_fenced_job(p_job_id,p_claim_token,p_job_generation);
  IF p_request IS NULL OR jsonb_typeof(p_request)<>'object' OR pg_column_size(p_request)>8192
    OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_request) k WHERE k NOT IN ('kind','subject_id','metrics','metric_date','since','until'))
    OR p_operation_key IS NULL OR p_operation_key !~ '^[a-zA-Z0-9_:.-]{1,200}$'
    OR jsonb_typeof(p_request->'metrics') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'META_ANALYTICS_INVALID_CAPTURE_REQUEST' USING ERRCODE='MAH01'; END IF;
  v_kind:=p_request->>'kind';v_subject:=p_request->>'subject_id';
  SELECT array_agg(e#>>'{}' ORDER BY e#>>'{}') INTO v_metrics FROM jsonb_array_elements(p_request->'metrics') e;
  IF v_kind IS NULL OR v_kind NOT IN ('account_day','post','profile','period_total') OR v_subject IS NULL OR v_subject !~ '^[a-zA-Z0-9_-]{1,200}$'
    OR v_metrics IS NULL OR cardinality(v_metrics) NOT BETWEEN 1 AND 14
    OR cardinality(v_metrics)<>(SELECT count(DISTINCT x) FROM unnest(v_metrics) x)
    OR EXISTS(SELECT 1 FROM unnest(v_metrics) k WHERE NOT public.meta_analytics_metric_key_valid(k)) THEN
    RAISE EXCEPTION 'META_ANALYTICS_INVALID_CAPTURE_REQUEST' USING ERRCODE='MAH01'; END IF;
  IF v_kind IN ('account_day','profile') AND v_subject IS DISTINCT FROM v_job.credential_authority->>'platform_user_id' THEN
    RAISE EXCEPTION 'META_ANALYTICS_SUBJECT_NOT_OWNED' USING ERRCODE='MAH02'; END IF;
  IF v_kind='post' OR v_kind='period_total' AND v_subject IS DISTINCT FROM v_job.credential_authority->>'platform_user_id' THEN
    IF NOT EXISTS(SELECT 1 FROM public.fb_analytics_collection_checkpoints WHERE job_id=p_job_id AND job_generation=p_job_generation AND v_subject=ANY(post_ids)) THEN
      RAISE EXCEPTION 'META_ANALYTICS_SUBJECT_NOT_IN_INVENTORY' USING ERRCODE='MAH02'; END IF;
    IF v_subject !~ '^[0-9]+_[0-9]+$' OR split_part(v_subject,'_',1) IS DISTINCT FROM v_job.credential_authority->>'platform_user_id' THEN
      RAISE EXCEPTION 'META_ANALYTICS_SUBJECT_NOT_OWNED' USING ERRCODE='MAH02'; END IF;
  END IF;
  IF v_kind='account_day' THEN
    IF p_request->>'metric_date' IS NULL OR (p_request->>'metric_date') !~ '^\d{4}-\d{2}-\d{2}$' THEN
      RAISE EXCEPTION 'META_ANALYTICS_INVALID_METRIC_DATE' USING ERRCODE='MAH01'; END IF;
    v_date:=(p_request->>'metric_date')::date;v_zone:='America/Los_Angeles';
    IF v_date>=v_job.due_on OR v_date<v_job.due_on-365 THEN RAISE EXCEPTION 'META_ANALYTICS_OPEN_OR_EXPIRED_DAY' USING ERRCODE='MAH01'; END IF;
    v_since:=v_date::timestamp AT TIME ZONE v_zone;v_until:=(v_date+1)::timestamp AT TIME ZONE v_zone;
  ELSIF v_kind='period_total' THEN
    v_zone:='America/Los_Angeles';v_since:=(p_request->>'since')::timestamptz;v_until:=(p_request->>'until')::timestamptz;
    IF v_since IS NULL OR v_until IS NULL OR NOT isfinite(v_since) OR NOT isfinite(v_until) OR v_since>=v_until
      OR v_until>v_job.due_at OR v_since<v_job.due_at-interval '365 days'
      OR (v_since AT TIME ZONE v_zone)::time<>'00:00'::time OR (v_until AT TIME ZONE v_zone)::time<>'00:00'::time
      OR ((v_until AT TIME ZONE v_zone)::date-(v_since AT TIME ZONE v_zone)::date) NOT IN (7,14,30,90) THEN
      RAISE EXCEPTION 'META_ANALYTICS_INVALID_PERIOD' USING ERRCODE='MAH01'; END IF;
  ELSIF p_request ? 'since' OR p_request ? 'until' OR p_request ? 'metric_date' THEN
    RAISE EXCEPTION 'META_ANALYTICS_INVALID_CAPTURE_WINDOW' USING ERRCODE='MAH01';
  END IF;
  INSERT INTO public.fb_analytics_collection_operations(job_id,user_id,social_account_id,job_generation,operation_key,kind,requested_metrics)
    VALUES(p_job_id,v_job.user_id,v_job.social_account_id,p_job_generation,p_operation_key,v_kind,v_metrics)
    ON CONFLICT(job_id,job_generation,operation_key) DO NOTHING;
  SELECT * INTO v_operation FROM public.fb_analytics_collection_operations WHERE job_id=p_job_id AND job_generation=p_job_generation AND operation_key=p_operation_key FOR UPDATE;
  IF v_operation.kind<>v_kind OR v_operation.requested_metrics IS DISTINCT FROM v_metrics OR v_operation.state IN ('success','unavailable')
    OR EXISTS(SELECT 1 FROM public.fb_analytics_captures c WHERE c.operation_id=v_operation.id
      AND (c.subject_id IS DISTINCT FROM v_subject OR c.metric_date IS DISTINCT FROM v_date
        OR c.window_since IS DISTINCT FROM v_since OR c.window_until IS DISTINCT FROM v_until)) THEN
    RAISE EXCEPTION 'META_ANALYTICS_OPERATION_CONFLICT' USING ERRCODE='MAH04'; END IF;
  UPDATE public.fb_analytics_report_state SET next_capture_sequence=next_capture_sequence+1 WHERE social_account_id=v_job.social_account_id AND user_id=v_job.user_id RETURNING next_capture_sequence INTO v_sequence;
  IF v_job.lease_until<=clock_timestamp() THEN RAISE EXCEPTION 'META_ANALYTICS_STALE_CLAIM' USING ERRCODE='MAH04'; END IF;
  INSERT INTO public.fb_analytics_captures(id,job_id,operation_id,job_generation,claim_token,user_id,social_account_id,capture_sequence,kind,subject_id,metric_date,
    window_since,window_until,provider_timezone,api_version,requested_metrics,credential_authority)
  VALUES(v_capture,p_job_id,v_operation.id,p_job_generation,p_claim_token,v_job.user_id,v_job.social_account_id,v_sequence,v_kind,v_subject,v_date,
    v_since,v_until,v_zone,'v25.0',v_metrics,v_job.credential_authority);
  RETURN jsonb_build_object('capture_id',v_capture,'capture_sequence',v_sequence,'job_id',p_job_id,'job_generation',p_job_generation,
    'kind',v_kind,'subject_id',v_subject,'metric_date',v_date,'since',v_since,'until',v_until,'timezone',v_zone);
END;
$fn$;
CREATE FUNCTION public.persist_fb_analytics_capture(p_job_id uuid,p_claim_token uuid,p_job_generation bigint,p_capture_id uuid,p_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp SET lock_timeout='3s' AS $fn$
DECLARE v_job public.fb_analytics_collection_jobs;v_capture public.fb_analytics_captures;v_digest text;v_received timestamptz;v_observed timestamptz;
  v_parent uuid;v_window_kind text;v_level text;v_key text;v_cell jsonb;v_written integer:=0;v_count integer;v_revision bigint;v_receipt jsonb;
BEGIN
  PERFORM public.meta_analytics_assert_service();
  v_job:=public.fb_analytics_fenced_job(p_job_id,p_claim_token,p_job_generation);
  SELECT * INTO v_capture FROM public.fb_analytics_captures WHERE id=p_capture_id AND job_id=p_job_id AND job_generation=p_job_generation
    AND user_id=v_job.user_id AND social_account_id=v_job.social_account_id FOR UPDATE;
  IF NOT FOUND OR v_capture.credential_authority IS DISTINCT FROM v_job.credential_authority OR v_capture.claim_token IS DISTINCT FROM p_claim_token THEN
    RAISE EXCEPTION 'META_ANALYTICS_CAPTURE_NOT_FOUND' USING ERRCODE='MAH02'; END IF;
  IF p_payload IS NULL OR jsonb_typeof(p_payload)<>'object' OR pg_column_size(p_payload)>262144
    OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_payload) k WHERE k NOT IN ('metrics','received_at','observed_at','published_at','text','permalink')) THEN
    RAISE EXCEPTION 'META_ANALYTICS_INVALID_CAPTURE_PAYLOAD' USING ERRCODE='MAH01'; END IF;
  PERFORM public.meta_analytics_validate_metric_map(p_payload->'metrics',v_capture.requested_metrics);
  v_received:=(p_payload->>'received_at')::timestamptz;v_observed:=(p_payload->>'observed_at')::timestamptz;
  IF v_received IS NULL OR v_observed IS NULL OR NOT isfinite(v_received) OR NOT isfinite(v_observed)
    OR v_received<v_capture.requested_at OR v_received>clock_timestamp() OR v_observed>v_received
    OR v_capture.kind='profile' AND v_observed<v_capture.requested_at THEN
    RAISE EXCEPTION 'META_ANALYTICS_INVALID_CAPTURE_TIME' USING ERRCODE='MAH01'; END IF;
  v_digest:=encode(sha256(convert_to(p_payload::text,'utf8')),'hex');
  IF EXISTS(SELECT 1 FROM public.fb_analytics_captures c WHERE c.operation_id=v_capture.operation_id
    AND c.capture_sequence>v_capture.capture_sequence) THEN
    RAISE EXCEPTION 'META_ANALYTICS_SUPERSEDED_CAPTURE' USING ERRCODE='MAH04'; END IF;
  IF v_capture.payload_digest IS NOT NULL THEN
    IF v_capture.payload_digest IS DISTINCT FROM v_digest THEN RAISE EXCEPTION 'META_ANALYTICS_CAPTURE_REPLAY_CONFLICT' USING ERRCODE='MAH04'; END IF;
    IF v_job.lease_until<=clock_timestamp() THEN RAISE EXCEPTION 'META_ANALYTICS_STALE_CLAIM' USING ERRCODE='MAH04'; END IF;
    RETURN v_capture.receipt;
  END IF;
  v_window_kind:=CASE v_capture.kind WHEN 'account_day' THEN 'day' WHEN 'post' THEN 'lifetime' WHEN 'profile' THEN 'point_in_time' ELSE 'period_total' END;
  v_level:=CASE WHEN v_capture.kind='post' OR v_capture.kind='period_total' AND v_capture.subject_id IS DISTINCT FROM v_job.credential_authority->>'platform_user_id' THEN 'post' ELSE 'account' END;
  IF v_capture.kind='account_day' THEN
    INSERT INTO public.fb_page_insight_daily(user_id,social_account_id,metric_date,period_start,period_end,provider_timezone)
    VALUES(v_job.user_id,v_job.social_account_id,v_capture.metric_date,v_capture.window_since,v_capture.window_until,v_capture.provider_timezone)
    ON CONFLICT(user_id,social_account_id,metric_date) DO NOTHING;
    SELECT id INTO v_parent FROM public.fb_page_insight_daily WHERE user_id=v_job.user_id AND social_account_id=v_job.social_account_id AND metric_date=v_capture.metric_date;
  ELSIF v_capture.kind='post' THEN
    IF p_payload->>'published_at' IS NULL OR NOT isfinite((p_payload->>'published_at')::timestamptz)
      OR (p_payload->>'published_at')::timestamptz>v_received OR length(COALESCE(p_payload->>'text',''))>10000 THEN
      RAISE EXCEPTION 'META_ANALYTICS_INVALID_POST_METADATA' USING ERRCODE='MAH01'; END IF;
    INSERT INTO public.fb_post_insight_snapshots(user_id,social_account_id,platform_post_id,captured_on,published_at,post_text,permalink,metadata_capture_id)
    VALUES(v_job.user_id,v_job.social_account_id,v_capture.subject_id,(v_received AT TIME ZONE 'UTC')::date,
      (p_payload->>'published_at')::timestamptz,COALESCE(p_payload->>'text',''),p_payload->>'permalink',p_capture_id)
    ON CONFLICT(user_id,social_account_id,platform_post_id,captured_on) DO UPDATE SET published_at=EXCLUDED.published_at,post_text=EXCLUDED.post_text,
      permalink=EXCLUDED.permalink,metadata_capture_id=EXCLUDED.metadata_capture_id
    WHERE (SELECT capture_sequence FROM public.fb_analytics_captures WHERE id=fb_post_insight_snapshots.metadata_capture_id)<v_capture.capture_sequence;
    GET DIAGNOSTICS v_count=ROW_COUNT;v_written:=v_written+v_count;
    SELECT id INTO v_parent FROM public.fb_post_insight_snapshots WHERE user_id=v_job.user_id AND social_account_id=v_job.social_account_id
      AND platform_post_id=v_capture.subject_id AND captured_on=(v_received AT TIME ZONE 'UTC')::date;
  ELSIF v_capture.kind='profile' THEN
    INSERT INTO public.fb_page_profile_observations(user_id,social_account_id,capture_id,observed_at) VALUES(v_job.user_id,v_job.social_account_id,p_capture_id,v_observed)
      ON CONFLICT(user_id,social_account_id,capture_id) DO NOTHING RETURNING id INTO v_parent;
  END IF;
  FOR v_key,v_cell IN SELECT * FROM jsonb_each(p_payload->'metrics') ORDER BY key LOOP
    IF v_capture.kind='period_total' THEN
      INSERT INTO public.fb_analytics_period_totals(user_id,social_account_id,level,subject_id,metric_key,api_version,provider_timezone,window_since,window_until,
        captured_on,status,value,reason,provider_metric,source_ref,capture_id,observed_at)
      VALUES(v_job.user_id,v_job.social_account_id,v_level,v_capture.subject_id,v_key,v_capture.api_version,v_capture.provider_timezone,
        v_capture.window_since,v_capture.window_until,(v_received AT TIME ZONE 'UTC')::date,v_cell->>'status',(v_cell->>'value')::bigint,v_cell->>'reason',
        public.meta_analytics_provider_metric('facebook',v_level,v_key,v_window_kind),'meta_graph_v25',p_capture_id,v_observed)
      ON CONFLICT(user_id,social_account_id,level,subject_id,metric_key,api_version,provider_timezone,window_since,window_until,captured_on)
      DO UPDATE SET status=EXCLUDED.status,value=EXCLUDED.value,reason=EXCLUDED.reason,provider_metric=EXCLUDED.provider_metric,source_ref=EXCLUDED.source_ref,
        capture_id=EXCLUDED.capture_id,observed_at=EXCLUDED.observed_at
      WHERE (SELECT capture_sequence FROM public.fb_analytics_captures WHERE id=fb_analytics_period_totals.capture_id)<v_capture.capture_sequence;
    ELSE
      IF v_capture.kind='account_day' THEN
        INSERT INTO public.fb_analytics_metric_values(user_id,social_account_id,daily_id,post_snapshot_id,profile_observation_id,metric_key,status,value,reason,
          provider_metric,api_version,window_kind,provider_timezone,window_since,window_until,source_ref,capture_id,observed_at)
        VALUES(v_job.user_id,v_job.social_account_id,v_parent,NULL,NULL,v_key,v_cell->>'status',(v_cell->>'value')::bigint,v_cell->>'reason',
          public.meta_analytics_provider_metric('facebook',v_level,v_key,v_window_kind),v_capture.api_version,v_window_kind,v_capture.provider_timezone,
          v_capture.window_since,v_capture.window_until,'meta_graph_v25',p_capture_id,v_observed)
        ON CONFLICT(daily_id,metric_key) WHERE daily_id IS NOT NULL DO UPDATE SET status=EXCLUDED.status,value=EXCLUDED.value,reason=EXCLUDED.reason,
          provider_metric=EXCLUDED.provider_metric,api_version=EXCLUDED.api_version,window_kind=EXCLUDED.window_kind,provider_timezone=EXCLUDED.provider_timezone,
          window_since=EXCLUDED.window_since,window_until=EXCLUDED.window_until,source_ref=EXCLUDED.source_ref,capture_id=EXCLUDED.capture_id,observed_at=EXCLUDED.observed_at
        WHERE (SELECT capture_sequence FROM public.fb_analytics_captures WHERE id=fb_analytics_metric_values.capture_id)<v_capture.capture_sequence;
      ELSIF v_capture.kind='post' THEN
        INSERT INTO public.fb_analytics_metric_values(user_id,social_account_id,daily_id,post_snapshot_id,profile_observation_id,metric_key,status,value,reason,
          provider_metric,api_version,window_kind,provider_timezone,window_since,window_until,source_ref,capture_id,observed_at)
        VALUES(v_job.user_id,v_job.social_account_id,NULL,v_parent,NULL,v_key,v_cell->>'status',(v_cell->>'value')::bigint,v_cell->>'reason',
          public.meta_analytics_provider_metric('facebook',v_level,v_key,v_window_kind),v_capture.api_version,v_window_kind,v_capture.provider_timezone,
          v_capture.window_since,v_capture.window_until,'meta_graph_v25',p_capture_id,v_observed)
        ON CONFLICT(post_snapshot_id,metric_key) WHERE post_snapshot_id IS NOT NULL DO UPDATE SET status=EXCLUDED.status,value=EXCLUDED.value,reason=EXCLUDED.reason,
          provider_metric=EXCLUDED.provider_metric,api_version=EXCLUDED.api_version,window_kind=EXCLUDED.window_kind,provider_timezone=EXCLUDED.provider_timezone,
          window_since=EXCLUDED.window_since,window_until=EXCLUDED.window_until,source_ref=EXCLUDED.source_ref,capture_id=EXCLUDED.capture_id,observed_at=EXCLUDED.observed_at
        WHERE (SELECT capture_sequence FROM public.fb_analytics_captures WHERE id=fb_analytics_metric_values.capture_id)<v_capture.capture_sequence;
      ELSIF v_capture.kind='profile' THEN
        INSERT INTO public.fb_analytics_metric_values(user_id,social_account_id,daily_id,post_snapshot_id,profile_observation_id,metric_key,status,value,reason,
          provider_metric,api_version,window_kind,provider_timezone,window_since,window_until,source_ref,capture_id,observed_at)
        VALUES(v_job.user_id,v_job.social_account_id,NULL,NULL,v_parent,v_key,v_cell->>'status',(v_cell->>'value')::bigint,v_cell->>'reason',
          public.meta_analytics_provider_metric('facebook',v_level,v_key,v_window_kind),v_capture.api_version,v_window_kind,v_capture.provider_timezone,
          v_capture.window_since,v_capture.window_until,'meta_graph_v25',p_capture_id,v_observed)
        ON CONFLICT(profile_observation_id,metric_key) WHERE profile_observation_id IS NOT NULL DO UPDATE SET status=EXCLUDED.status,value=EXCLUDED.value,reason=EXCLUDED.reason,
          provider_metric=EXCLUDED.provider_metric,api_version=EXCLUDED.api_version,window_kind=EXCLUDED.window_kind,provider_timezone=EXCLUDED.provider_timezone,
          window_since=EXCLUDED.window_since,window_until=EXCLUDED.window_until,source_ref=EXCLUDED.source_ref,capture_id=EXCLUDED.capture_id,observed_at=EXCLUDED.observed_at
        WHERE (SELECT capture_sequence FROM public.fb_analytics_captures WHERE id=fb_analytics_metric_values.capture_id)<v_capture.capture_sequence;
      END IF;
    END IF;
    GET DIAGNOSTICS v_count=ROW_COUNT;v_written:=v_written+v_count;
  END LOOP;
  IF v_job.lease_until<=clock_timestamp() THEN RAISE EXCEPTION 'META_ANALYTICS_STALE_CLAIM' USING ERRCODE='MAH04'; END IF;
  UPDATE public.fb_analytics_report_state SET report_revision=report_revision+CASE WHEN v_written>0 THEN 1 ELSE 0 END,updated_at=now()
    WHERE social_account_id=v_job.social_account_id AND user_id=v_job.user_id RETURNING report_revision INTO v_revision;
  v_receipt:=jsonb_build_object('job_id',p_job_id,'job_generation',p_job_generation,'capture_id',p_capture_id,'written',v_written,'report_revision',v_revision);
  UPDATE public.fb_analytics_captures SET received_at=v_received,payload_digest=v_digest,receipt=v_receipt WHERE id=p_capture_id;
  UPDATE public.fb_analytics_collection_operations SET state=CASE
      WHEN EXISTS(SELECT 1 FROM jsonb_each(p_payload->'metrics') e WHERE e.value->>'status'='unavailable' AND e.value->>'reason' NOT IN ('not_offered','outside_retention')) THEN 'failed'
      WHEN EXISTS(SELECT 1 FROM jsonb_each(p_payload->'metrics') e WHERE e.value->>'status'='available') THEN 'success' ELSE 'unavailable' END,
    completed_at=clock_timestamp(),reason_code=(SELECT value->>'reason' FROM jsonb_each(p_payload->'metrics') WHERE value->>'status'='unavailable' ORDER BY key LIMIT 1)
    WHERE id=v_capture.operation_id;
  RETURN v_receipt;
END;
$fn$;


CREATE FUNCTION public.reserve_threads_analytics_capture(p_job_id uuid,p_claim_token uuid,p_job_generation bigint,p_operation_key text,p_request jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp SET lock_timeout='3s' AS $fn$
DECLARE v_job public.threads_analytics_collection_jobs;v_kind text;v_subject text;v_metrics text[];v_operation public.threads_analytics_collection_operations;
  v_date date;v_since timestamptz;v_until timestamptz;v_zone text;v_sequence bigint;v_capture uuid:=gen_random_uuid();
BEGIN
  PERFORM public.meta_analytics_assert_service();
  v_job:=public.threads_analytics_fenced_job(p_job_id,p_claim_token,p_job_generation);
  IF p_request IS NULL OR jsonb_typeof(p_request)<>'object' OR pg_column_size(p_request)>8192
    OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_request) k WHERE k NOT IN ('kind','subject_id','metrics','metric_date','since','until'))
    OR p_operation_key IS NULL OR p_operation_key !~ '^[a-zA-Z0-9_:.-]{1,200}$'
    OR jsonb_typeof(p_request->'metrics') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'META_ANALYTICS_INVALID_CAPTURE_REQUEST' USING ERRCODE='MAH01'; END IF;
  v_kind:=p_request->>'kind';v_subject:=p_request->>'subject_id';
  SELECT array_agg(e#>>'{}' ORDER BY e#>>'{}') INTO v_metrics FROM jsonb_array_elements(p_request->'metrics') e;
  IF v_kind IS NULL OR v_kind NOT IN ('account_day','post','profile','period_total') OR v_subject IS NULL OR v_subject !~ '^[a-zA-Z0-9_-]{1,200}$'
    OR v_metrics IS NULL OR cardinality(v_metrics) NOT BETWEEN 1 AND 14
    OR cardinality(v_metrics)<>(SELECT count(DISTINCT x) FROM unnest(v_metrics) x)
    OR EXISTS(SELECT 1 FROM unnest(v_metrics) k WHERE NOT public.meta_analytics_metric_key_valid(k)) THEN
    RAISE EXCEPTION 'META_ANALYTICS_INVALID_CAPTURE_REQUEST' USING ERRCODE='MAH01'; END IF;
  IF v_kind IN ('account_day','profile') AND v_subject IS DISTINCT FROM v_job.credential_authority->>'platform_user_id' THEN
    RAISE EXCEPTION 'META_ANALYTICS_SUBJECT_NOT_OWNED' USING ERRCODE='MAH02'; END IF;
  IF v_kind='post' OR v_kind='period_total' AND v_subject IS DISTINCT FROM v_job.credential_authority->>'platform_user_id' THEN
    IF NOT EXISTS(SELECT 1 FROM public.threads_analytics_collection_checkpoints WHERE job_id=p_job_id AND job_generation=p_job_generation AND v_subject=ANY(post_ids)) THEN
      RAISE EXCEPTION 'META_ANALYTICS_SUBJECT_NOT_IN_INVENTORY' USING ERRCODE='MAH02'; END IF;

  END IF;
  IF v_kind='account_day' THEN
    IF p_request->>'metric_date' IS NULL OR (p_request->>'metric_date') !~ '^\d{4}-\d{2}-\d{2}$' THEN
      RAISE EXCEPTION 'META_ANALYTICS_INVALID_METRIC_DATE' USING ERRCODE='MAH01'; END IF;
    v_date:=(p_request->>'metric_date')::date;v_zone:='America/Los_Angeles';
    IF v_date>=v_job.due_on OR v_date<v_job.due_on-365 THEN RAISE EXCEPTION 'META_ANALYTICS_OPEN_OR_EXPIRED_DAY' USING ERRCODE='MAH01'; END IF;
    v_since:=v_date::timestamp AT TIME ZONE v_zone;v_until:=(v_date+1)::timestamp AT TIME ZONE v_zone;
  ELSIF v_kind='period_total' THEN
    v_zone:='America/Los_Angeles';v_since:=(p_request->>'since')::timestamptz;v_until:=(p_request->>'until')::timestamptz;
    IF v_since IS NULL OR v_until IS NULL OR NOT isfinite(v_since) OR NOT isfinite(v_until) OR v_since>=v_until
      OR v_until>v_job.due_at OR v_since<v_job.due_at-interval '365 days'
      OR (v_since AT TIME ZONE v_zone)::time<>'00:00'::time OR (v_until AT TIME ZONE v_zone)::time<>'00:00'::time
      OR ((v_until AT TIME ZONE v_zone)::date-(v_since AT TIME ZONE v_zone)::date) NOT IN (7,14,30,90) THEN
      RAISE EXCEPTION 'META_ANALYTICS_INVALID_PERIOD' USING ERRCODE='MAH01'; END IF;
  ELSIF p_request ? 'since' OR p_request ? 'until' OR p_request ? 'metric_date' THEN
    RAISE EXCEPTION 'META_ANALYTICS_INVALID_CAPTURE_WINDOW' USING ERRCODE='MAH01';
  END IF;
  INSERT INTO public.threads_analytics_collection_operations(job_id,user_id,social_account_id,job_generation,operation_key,kind,requested_metrics)
    VALUES(p_job_id,v_job.user_id,v_job.social_account_id,p_job_generation,p_operation_key,v_kind,v_metrics)
    ON CONFLICT(job_id,job_generation,operation_key) DO NOTHING;
  SELECT * INTO v_operation FROM public.threads_analytics_collection_operations WHERE job_id=p_job_id AND job_generation=p_job_generation AND operation_key=p_operation_key FOR UPDATE;
  IF v_operation.kind<>v_kind OR v_operation.requested_metrics IS DISTINCT FROM v_metrics OR v_operation.state IN ('success','unavailable')
    OR EXISTS(SELECT 1 FROM public.threads_analytics_captures c WHERE c.operation_id=v_operation.id
      AND (c.subject_id IS DISTINCT FROM v_subject OR c.metric_date IS DISTINCT FROM v_date
        OR c.window_since IS DISTINCT FROM v_since OR c.window_until IS DISTINCT FROM v_until)) THEN
    RAISE EXCEPTION 'META_ANALYTICS_OPERATION_CONFLICT' USING ERRCODE='MAH04'; END IF;
  UPDATE public.threads_analytics_report_state SET next_capture_sequence=next_capture_sequence+1 WHERE social_account_id=v_job.social_account_id AND user_id=v_job.user_id RETURNING next_capture_sequence INTO v_sequence;
  IF v_job.lease_until<=clock_timestamp() THEN RAISE EXCEPTION 'META_ANALYTICS_STALE_CLAIM' USING ERRCODE='MAH04'; END IF;
  INSERT INTO public.threads_analytics_captures(id,job_id,operation_id,job_generation,claim_token,user_id,social_account_id,capture_sequence,kind,subject_id,metric_date,
    window_since,window_until,provider_timezone,api_version,requested_metrics,credential_authority)
  VALUES(v_capture,p_job_id,v_operation.id,p_job_generation,p_claim_token,v_job.user_id,v_job.social_account_id,v_sequence,v_kind,v_subject,v_date,
    v_since,v_until,v_zone,'v1.0',v_metrics,v_job.credential_authority);
  RETURN jsonb_build_object('capture_id',v_capture,'capture_sequence',v_sequence,'job_id',p_job_id,'job_generation',p_job_generation,
    'kind',v_kind,'subject_id',v_subject,'metric_date',v_date,'since',v_since,'until',v_until,'timezone',v_zone);
END;
$fn$;
CREATE FUNCTION public.persist_threads_analytics_capture(p_job_id uuid,p_claim_token uuid,p_job_generation bigint,p_capture_id uuid,p_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp SET lock_timeout='3s' AS $fn$
DECLARE v_job public.threads_analytics_collection_jobs;v_capture public.threads_analytics_captures;v_digest text;v_received timestamptz;v_observed timestamptz;
  v_parent uuid;v_window_kind text;v_level text;v_key text;v_cell jsonb;v_written integer:=0;v_count integer;v_revision bigint;v_receipt jsonb;
BEGIN
  PERFORM public.meta_analytics_assert_service();
  v_job:=public.threads_analytics_fenced_job(p_job_id,p_claim_token,p_job_generation);
  SELECT * INTO v_capture FROM public.threads_analytics_captures WHERE id=p_capture_id AND job_id=p_job_id AND job_generation=p_job_generation
    AND user_id=v_job.user_id AND social_account_id=v_job.social_account_id FOR UPDATE;
  IF NOT FOUND OR v_capture.credential_authority IS DISTINCT FROM v_job.credential_authority OR v_capture.claim_token IS DISTINCT FROM p_claim_token THEN
    RAISE EXCEPTION 'META_ANALYTICS_CAPTURE_NOT_FOUND' USING ERRCODE='MAH02'; END IF;
  IF p_payload IS NULL OR jsonb_typeof(p_payload)<>'object' OR pg_column_size(p_payload)>262144
    OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_payload) k WHERE k NOT IN ('metrics','received_at','observed_at','published_at','text','permalink')) THEN
    RAISE EXCEPTION 'META_ANALYTICS_INVALID_CAPTURE_PAYLOAD' USING ERRCODE='MAH01'; END IF;
  PERFORM public.meta_analytics_validate_metric_map(p_payload->'metrics',v_capture.requested_metrics);
  v_received:=(p_payload->>'received_at')::timestamptz;v_observed:=(p_payload->>'observed_at')::timestamptz;
  IF v_received IS NULL OR v_observed IS NULL OR NOT isfinite(v_received) OR NOT isfinite(v_observed)
    OR v_received<v_capture.requested_at OR v_received>clock_timestamp() OR v_observed>v_received
    OR v_capture.kind='profile' AND v_observed<v_capture.requested_at THEN
    RAISE EXCEPTION 'META_ANALYTICS_INVALID_CAPTURE_TIME' USING ERRCODE='MAH01'; END IF;
  v_digest:=encode(sha256(convert_to(p_payload::text,'utf8')),'hex');
  IF EXISTS(SELECT 1 FROM public.threads_analytics_captures c WHERE c.operation_id=v_capture.operation_id
    AND c.capture_sequence>v_capture.capture_sequence) THEN
    RAISE EXCEPTION 'META_ANALYTICS_SUPERSEDED_CAPTURE' USING ERRCODE='MAH04'; END IF;
  IF v_capture.payload_digest IS NOT NULL THEN
    IF v_capture.payload_digest IS DISTINCT FROM v_digest THEN RAISE EXCEPTION 'META_ANALYTICS_CAPTURE_REPLAY_CONFLICT' USING ERRCODE='MAH04'; END IF;
    IF v_job.lease_until<=clock_timestamp() THEN RAISE EXCEPTION 'META_ANALYTICS_STALE_CLAIM' USING ERRCODE='MAH04'; END IF;
    RETURN v_capture.receipt;
  END IF;
  v_window_kind:=CASE v_capture.kind WHEN 'account_day' THEN 'day' WHEN 'post' THEN 'lifetime' WHEN 'profile' THEN 'point_in_time' ELSE 'period_total' END;
  v_level:=CASE WHEN v_capture.kind='post' OR v_capture.kind='period_total' AND v_capture.subject_id IS DISTINCT FROM v_job.credential_authority->>'platform_user_id' THEN 'post' ELSE 'account' END;
  IF v_capture.kind='account_day' THEN
    INSERT INTO public.threads_account_insight_daily(user_id,social_account_id,metric_date,period_start,period_end,provider_timezone)
    VALUES(v_job.user_id,v_job.social_account_id,v_capture.metric_date,v_capture.window_since,v_capture.window_until,v_capture.provider_timezone)
    ON CONFLICT(user_id,social_account_id,metric_date) DO NOTHING;
    SELECT id INTO v_parent FROM public.threads_account_insight_daily WHERE user_id=v_job.user_id AND social_account_id=v_job.social_account_id AND metric_date=v_capture.metric_date;
  ELSIF v_capture.kind='post' THEN
    IF p_payload->>'published_at' IS NULL OR NOT isfinite((p_payload->>'published_at')::timestamptz)
      OR (p_payload->>'published_at')::timestamptz>v_received OR length(COALESCE(p_payload->>'text',''))>10000 THEN
      RAISE EXCEPTION 'META_ANALYTICS_INVALID_POST_METADATA' USING ERRCODE='MAH01'; END IF;
    INSERT INTO public.threads_post_insight_snapshots(user_id,social_account_id,platform_post_id,captured_on,published_at,post_text,permalink,metadata_capture_id)
    VALUES(v_job.user_id,v_job.social_account_id,v_capture.subject_id,(v_received AT TIME ZONE 'UTC')::date,
      (p_payload->>'published_at')::timestamptz,COALESCE(p_payload->>'text',''),p_payload->>'permalink',p_capture_id)
    ON CONFLICT(user_id,social_account_id,platform_post_id,captured_on) DO UPDATE SET published_at=EXCLUDED.published_at,post_text=EXCLUDED.post_text,
      permalink=EXCLUDED.permalink,metadata_capture_id=EXCLUDED.metadata_capture_id
    WHERE (SELECT capture_sequence FROM public.threads_analytics_captures WHERE id=threads_post_insight_snapshots.metadata_capture_id)<v_capture.capture_sequence;
    GET DIAGNOSTICS v_count=ROW_COUNT;v_written:=v_written+v_count;
    SELECT id INTO v_parent FROM public.threads_post_insight_snapshots WHERE user_id=v_job.user_id AND social_account_id=v_job.social_account_id
      AND platform_post_id=v_capture.subject_id AND captured_on=(v_received AT TIME ZONE 'UTC')::date;
  ELSIF v_capture.kind='profile' THEN
    INSERT INTO public.threads_account_profile_observations(user_id,social_account_id,capture_id,observed_at) VALUES(v_job.user_id,v_job.social_account_id,p_capture_id,v_observed)
      ON CONFLICT(user_id,social_account_id,capture_id) DO NOTHING RETURNING id INTO v_parent;
  END IF;
  FOR v_key,v_cell IN SELECT * FROM jsonb_each(p_payload->'metrics') ORDER BY key LOOP
    IF v_capture.kind='period_total' THEN
      INSERT INTO public.threads_analytics_period_totals(user_id,social_account_id,level,subject_id,metric_key,api_version,provider_timezone,window_since,window_until,
        captured_on,status,value,reason,provider_metric,source_ref,capture_id,observed_at)
      VALUES(v_job.user_id,v_job.social_account_id,v_level,v_capture.subject_id,v_key,v_capture.api_version,v_capture.provider_timezone,
        v_capture.window_since,v_capture.window_until,(v_received AT TIME ZONE 'UTC')::date,v_cell->>'status',(v_cell->>'value')::bigint,v_cell->>'reason',
        public.meta_analytics_provider_metric('threads',v_level,v_key,v_window_kind),'threads_graph_v1',p_capture_id,v_observed)
      ON CONFLICT(user_id,social_account_id,level,subject_id,metric_key,api_version,provider_timezone,window_since,window_until,captured_on)
      DO UPDATE SET status=EXCLUDED.status,value=EXCLUDED.value,reason=EXCLUDED.reason,provider_metric=EXCLUDED.provider_metric,source_ref=EXCLUDED.source_ref,
        capture_id=EXCLUDED.capture_id,observed_at=EXCLUDED.observed_at
      WHERE (SELECT capture_sequence FROM public.threads_analytics_captures WHERE id=threads_analytics_period_totals.capture_id)<v_capture.capture_sequence;
    ELSE
      IF v_capture.kind='account_day' THEN
        INSERT INTO public.threads_analytics_metric_values(user_id,social_account_id,daily_id,post_snapshot_id,profile_observation_id,metric_key,status,value,reason,
          provider_metric,api_version,window_kind,provider_timezone,window_since,window_until,source_ref,capture_id,observed_at)
        VALUES(v_job.user_id,v_job.social_account_id,v_parent,NULL,NULL,v_key,v_cell->>'status',(v_cell->>'value')::bigint,v_cell->>'reason',
          public.meta_analytics_provider_metric('threads',v_level,v_key,v_window_kind),v_capture.api_version,v_window_kind,v_capture.provider_timezone,
          v_capture.window_since,v_capture.window_until,'threads_graph_v1',p_capture_id,v_observed)
        ON CONFLICT(daily_id,metric_key) WHERE daily_id IS NOT NULL DO UPDATE SET status=EXCLUDED.status,value=EXCLUDED.value,reason=EXCLUDED.reason,
          provider_metric=EXCLUDED.provider_metric,api_version=EXCLUDED.api_version,window_kind=EXCLUDED.window_kind,provider_timezone=EXCLUDED.provider_timezone,
          window_since=EXCLUDED.window_since,window_until=EXCLUDED.window_until,source_ref=EXCLUDED.source_ref,capture_id=EXCLUDED.capture_id,observed_at=EXCLUDED.observed_at
        WHERE (SELECT capture_sequence FROM public.threads_analytics_captures WHERE id=threads_analytics_metric_values.capture_id)<v_capture.capture_sequence;
      ELSIF v_capture.kind='post' THEN
        INSERT INTO public.threads_analytics_metric_values(user_id,social_account_id,daily_id,post_snapshot_id,profile_observation_id,metric_key,status,value,reason,
          provider_metric,api_version,window_kind,provider_timezone,window_since,window_until,source_ref,capture_id,observed_at)
        VALUES(v_job.user_id,v_job.social_account_id,NULL,v_parent,NULL,v_key,v_cell->>'status',(v_cell->>'value')::bigint,v_cell->>'reason',
          public.meta_analytics_provider_metric('threads',v_level,v_key,v_window_kind),v_capture.api_version,v_window_kind,v_capture.provider_timezone,
          v_capture.window_since,v_capture.window_until,'threads_graph_v1',p_capture_id,v_observed)
        ON CONFLICT(post_snapshot_id,metric_key) WHERE post_snapshot_id IS NOT NULL DO UPDATE SET status=EXCLUDED.status,value=EXCLUDED.value,reason=EXCLUDED.reason,
          provider_metric=EXCLUDED.provider_metric,api_version=EXCLUDED.api_version,window_kind=EXCLUDED.window_kind,provider_timezone=EXCLUDED.provider_timezone,
          window_since=EXCLUDED.window_since,window_until=EXCLUDED.window_until,source_ref=EXCLUDED.source_ref,capture_id=EXCLUDED.capture_id,observed_at=EXCLUDED.observed_at
        WHERE (SELECT capture_sequence FROM public.threads_analytics_captures WHERE id=threads_analytics_metric_values.capture_id)<v_capture.capture_sequence;
      ELSIF v_capture.kind='profile' THEN
        INSERT INTO public.threads_analytics_metric_values(user_id,social_account_id,daily_id,post_snapshot_id,profile_observation_id,metric_key,status,value,reason,
          provider_metric,api_version,window_kind,provider_timezone,window_since,window_until,source_ref,capture_id,observed_at)
        VALUES(v_job.user_id,v_job.social_account_id,NULL,NULL,v_parent,v_key,v_cell->>'status',(v_cell->>'value')::bigint,v_cell->>'reason',
          public.meta_analytics_provider_metric('threads',v_level,v_key,v_window_kind),v_capture.api_version,v_window_kind,v_capture.provider_timezone,
          v_capture.window_since,v_capture.window_until,'threads_graph_v1',p_capture_id,v_observed)
        ON CONFLICT(profile_observation_id,metric_key) WHERE profile_observation_id IS NOT NULL DO UPDATE SET status=EXCLUDED.status,value=EXCLUDED.value,reason=EXCLUDED.reason,
          provider_metric=EXCLUDED.provider_metric,api_version=EXCLUDED.api_version,window_kind=EXCLUDED.window_kind,provider_timezone=EXCLUDED.provider_timezone,
          window_since=EXCLUDED.window_since,window_until=EXCLUDED.window_until,source_ref=EXCLUDED.source_ref,capture_id=EXCLUDED.capture_id,observed_at=EXCLUDED.observed_at
        WHERE (SELECT capture_sequence FROM public.threads_analytics_captures WHERE id=threads_analytics_metric_values.capture_id)<v_capture.capture_sequence;
      END IF;
    END IF;
    GET DIAGNOSTICS v_count=ROW_COUNT;v_written:=v_written+v_count;
  END LOOP;
  IF v_job.lease_until<=clock_timestamp() THEN RAISE EXCEPTION 'META_ANALYTICS_STALE_CLAIM' USING ERRCODE='MAH04'; END IF;
  UPDATE public.threads_analytics_report_state SET report_revision=report_revision+CASE WHEN v_written>0 THEN 1 ELSE 0 END,updated_at=now()
    WHERE social_account_id=v_job.social_account_id AND user_id=v_job.user_id RETURNING report_revision INTO v_revision;
  v_receipt:=jsonb_build_object('job_id',p_job_id,'job_generation',p_job_generation,'capture_id',p_capture_id,'written',v_written,'report_revision',v_revision);
  UPDATE public.threads_analytics_captures SET received_at=v_received,payload_digest=v_digest,receipt=v_receipt WHERE id=p_capture_id;
  UPDATE public.threads_analytics_collection_operations SET state=CASE
      WHEN EXISTS(SELECT 1 FROM jsonb_each(p_payload->'metrics') e WHERE e.value->>'status'='unavailable' AND e.value->>'reason' NOT IN ('not_offered','outside_retention')) THEN 'failed'
      WHEN EXISTS(SELECT 1 FROM jsonb_each(p_payload->'metrics') e WHERE e.value->>'status'='available') THEN 'success' ELSE 'unavailable' END,
    completed_at=clock_timestamp(),reason_code=(SELECT value->>'reason' FROM jsonb_each(p_payload->'metrics') WHERE value->>'status'='unavailable' ORDER BY key LIMIT 1)
    WHERE id=v_capture.operation_id;
  RETURN v_receipt;
END;
$fn$;

ALTER TABLE public.ig_account_insight_daily ADD CONSTRAINT ig_daily_provenance_owner UNIQUE(id,user_id,social_account_id);
ALTER TABLE public.ig_media_insight_snapshots ADD CONSTRAINT ig_post_provenance_owner UNIQUE(id,user_id,social_account_id);
ALTER TABLE public.ig_account_profile_observations ADD CONSTRAINT ig_profile_provenance_owner UNIQUE(id,user_id,social_account_id);
ALTER TABLE public.instagram_collection_jobs ADD CONSTRAINT ig_job_provenance_owner UNIQUE(id,user_id,social_account_id);
CREATE TABLE public.ig_analytics_report_state (
  social_account_id uuid PRIMARY KEY,user_id uuid NOT NULL,platform text NOT NULL DEFAULT 'instagram' CHECK(platform='instagram'),
  next_capture_sequence bigint NOT NULL DEFAULT 0 CHECK(next_capture_sequence>=0),report_revision bigint NOT NULL DEFAULT 1 CHECK(report_revision>0),
  UNIQUE(social_account_id,user_id,platform),
  FOREIGN KEY(social_account_id,user_id,platform) REFERENCES public.social_accounts(id,user_id,platform) ON DELETE CASCADE
);
CREATE TABLE public.ig_analytics_captures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid NOT NULL,social_account_id uuid NOT NULL,claim_token uuid NOT NULL,
  request_identity jsonb NOT NULL CHECK(jsonb_typeof(request_identity)='object'),receipt jsonb,
  platform text NOT NULL DEFAULT 'instagram' CHECK(platform='instagram'),job_id uuid NOT NULL,job_generation bigint NOT NULL CHECK(job_generation>0),
  capture_sequence bigint NOT NULL CHECK(capture_sequence>0),requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  received_at timestamptz,payload_digest text CHECK(payload_digest IS NULL OR payload_digest ~ '^[a-f0-9]{64}$'),
  credential_generation bigint NOT NULL CHECK(credential_generation>0),
  UNIQUE(id,user_id,social_account_id,platform),UNIQUE(user_id,social_account_id,capture_sequence),
  FOREIGN KEY(social_account_id,user_id,platform) REFERENCES public.social_accounts(id,user_id,platform) ON DELETE CASCADE,
  FOREIGN KEY(job_id,user_id,social_account_id) REFERENCES public.instagram_collection_jobs(id,user_id,social_account_id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX ig_analytics_capture_job ON public.ig_analytics_captures(job_id,job_generation);
CREATE TABLE public.ig_analytics_metric_values (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid NOT NULL,social_account_id uuid NOT NULL,
  platform text NOT NULL DEFAULT 'instagram' CHECK(platform='instagram'),daily_id uuid,post_snapshot_id uuid,profile_observation_id uuid,
  metric_key text NOT NULL,status text NOT NULL,value bigint,reason text,provider_metric text,api_version text NOT NULL,
  window_kind text NOT NULL,provider_timezone text,window_since timestamptz,window_until timestamptz,source_ref text NOT NULL,
  capture_id uuid NOT NULL,observed_at timestamptz NOT NULL CHECK(isfinite(observed_at)),
  CHECK(num_nonnulls(daily_id,post_snapshot_id,profile_observation_id)=1),
  CHECK(public.meta_analytics_metric_valid(platform,CASE WHEN post_snapshot_id IS NULL THEN 'account' ELSE 'post' END,
    metric_key,status,value,reason,provider_metric,api_version,window_kind,provider_timezone,window_since,window_until,source_ref)),
  FOREIGN KEY(social_account_id,user_id,platform) REFERENCES public.social_accounts(id,user_id,platform) ON DELETE CASCADE,
  FOREIGN KEY(daily_id,user_id,social_account_id) REFERENCES public.ig_account_insight_daily(id,user_id,social_account_id) ON DELETE CASCADE,
  FOREIGN KEY(post_snapshot_id,user_id,social_account_id) REFERENCES public.ig_media_insight_snapshots(id,user_id,social_account_id) ON DELETE CASCADE,
  FOREIGN KEY(profile_observation_id,user_id,social_account_id) REFERENCES public.ig_account_profile_observations(id,user_id,social_account_id) ON DELETE CASCADE,
  FOREIGN KEY(capture_id,user_id,social_account_id,platform) REFERENCES public.ig_analytics_captures(id,user_id,social_account_id,platform) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED
);
CREATE UNIQUE INDEX ig_analytics_metric_daily_key ON public.ig_analytics_metric_values(daily_id,metric_key) WHERE daily_id IS NOT NULL;
CREATE UNIQUE INDEX ig_analytics_metric_post_key ON public.ig_analytics_metric_values(post_snapshot_id,metric_key) WHERE post_snapshot_id IS NOT NULL;
CREATE UNIQUE INDEX ig_analytics_metric_profile_key ON public.ig_analytics_metric_values(profile_observation_id,metric_key) WHERE profile_observation_id IS NOT NULL;
CREATE INDEX ig_analytics_metric_owner ON public.ig_analytics_metric_values(user_id,social_account_id,metric_key,observed_at DESC);
CREATE INDEX ig_analytics_metric_capture ON public.ig_analytics_metric_values(capture_id,user_id,social_account_id,platform);

CREATE FUNCTION public.meta_analytics_retention_allowed(p_platform text,p_account uuid,p_dry_run boolean)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=public,pg_temp AS $fn$
DECLARE v_enabled jsonb;v_policy jsonb;
BEGIN
  IF p_platform NOT IN ('facebook','threads') OR p_account IS NULL OR p_dry_run IS NULL THEN RETURN false; END IF;
  SELECT value INTO v_enabled FROM public.app_settings WHERE key='retention_'||p_platform||'_analytics_enabled' FOR SHARE;
  IF NOT p_dry_run AND v_enabled IS DISTINCT FROM 'true'::jsonb THEN RETURN false; END IF;
  SELECT value INTO v_policy FROM public.app_settings WHERE key='retention_'||p_platform||'_analytics_policy' FOR SHARE;
  IF v_policy IS NULL OR jsonb_typeof(v_policy)<>'object'
    OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(v_policy) k) IS DISTINCT FROM ARRAY['account_ids']::text[]
    OR jsonb_typeof(v_policy->'account_ids')<>'array' OR jsonb_array_length(v_policy->'account_ids')>100 THEN RETURN false; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(v_policy->'account_ids') e
    WHERE jsonb_typeof(e)<>'string' OR (e#>>'{}') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$') THEN RETURN false; END IF;
  RETURN (v_policy->'account_ids') @> jsonb_build_array(p_account::text);
END;
$fn$;


CREATE FUNCTION public.complete_fb_analytics_collection_job(p_job_id uuid,p_claim_token uuid,p_job_generation bigint,p_outcome text,p_reason text DEFAULT NULL,p_retry_at timestamptz DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp SET lock_timeout='3s' AS $fn$
DECLARE v_job public.fb_analytics_collection_jobs;
BEGIN
  PERFORM public.meta_analytics_assert_service();v_job:=public.fb_analytics_fenced_job(p_job_id,p_claim_token,p_job_generation);
  IF p_outcome IS NULL OR p_outcome NOT IN ('success','partial','failed','retry') OR p_reason IS NOT NULL AND p_reason !~ '^[a-z0-9_]{1,64}$'
    OR p_outcome='retry' AND (p_retry_at IS NULL OR NOT isfinite(p_retry_at) OR p_retry_at<=clock_timestamp() OR p_retry_at>clock_timestamp()+interval '1 day') THEN
    RAISE EXCEPTION 'META_ANALYTICS_INVALID_COMPLETION' USING ERRCODE='MAH01'; END IF;
  IF p_outcome='success' AND (
    NOT EXISTS(SELECT 1 FROM public.fb_analytics_collection_checkpoints WHERE job_id=p_job_id AND job_generation=p_job_generation AND inventory_complete AND NOT inventory_truncated)
    OR EXISTS(SELECT 1 FROM public.fb_analytics_collection_operations WHERE job_id=p_job_id AND job_generation=p_job_generation AND state IN ('pending','failed'))
    OR NOT EXISTS(SELECT 1 FROM public.fb_analytics_collection_operations WHERE job_id=p_job_id AND job_generation=p_job_generation AND kind='account_day' AND state='success')
    ) THEN
    RAISE EXCEPTION 'META_ANALYTICS_INCOMPLETE_COLLECTION' USING ERRCODE='MAH05'; END IF;

  IF p_outcome='success' AND (
    EXISTS(SELECT 1 FROM unnest(ARRAY[v_job.due_on-1,v_job.due_on-2]) day_value CROSS JOIN unnest(ARRAY['views','unique_viewers','engagements','followers']) key_value
      WHERE NOT EXISTS(SELECT 1 FROM public.fb_page_insight_daily d JOIN public.fb_analytics_metric_values m ON m.daily_id=d.id
        JOIN public.fb_analytics_captures c ON c.id=m.capture_id WHERE d.user_id=v_job.user_id AND d.social_account_id=v_job.social_account_id
          AND d.metric_date=day_value AND m.metric_key=key_value AND c.job_id=p_job_id AND c.job_generation=p_job_generation
          AND m.status='available'))
    OR EXISTS(SELECT 1 FROM public.fb_analytics_collection_checkpoints checkpoint CROSS JOIN unnest(checkpoint.post_ids) post_id CROSS JOIN unnest(ARRAY['views','unique_viewers']) key_value
      WHERE checkpoint.job_id=p_job_id AND checkpoint.job_generation=p_job_generation
        AND NOT EXISTS(SELECT 1 FROM public.fb_post_insight_snapshots p JOIN public.fb_analytics_metric_values m ON m.post_snapshot_id=p.id
          JOIN public.fb_analytics_captures c ON c.id=m.capture_id WHERE p.user_id=v_job.user_id AND p.social_account_id=v_job.social_account_id
            AND p.platform_post_id=post_id AND m.metric_key=key_value AND c.job_id=p_job_id AND c.job_generation=p_job_generation
            AND m.status='available'))

  ) THEN RAISE EXCEPTION 'META_ANALYTICS_INCOMPLETE_COLLECTION' USING ERRCODE='MAH05'; END IF;
  IF v_job.lease_until<=clock_timestamp() THEN RAISE EXCEPTION 'META_ANALYTICS_STALE_CLAIM' USING ERRCODE='MAH04'; END IF;
  UPDATE public.fb_analytics_collection_jobs SET state=p_outcome,completed_at=CASE WHEN p_outcome IN ('success','failed') THEN clock_timestamp() END,
    last_success_at=CASE WHEN p_outcome='success' THEN clock_timestamp() ELSE last_success_at END,
    last_partial_at=CASE WHEN p_outcome='partial' THEN clock_timestamp() ELSE last_partial_at END,
    retry_at=CASE WHEN p_outcome='retry' THEN p_retry_at WHEN p_outcome='partial' THEN clock_timestamp() ELSE NULL END,
    reason_code=p_reason,claim_token=NULL,lease_until=NULL,updated_at=clock_timestamp() WHERE id=p_job_id;
  UPDATE public.fb_analytics_report_state SET report_revision=report_revision+1,updated_at=now() WHERE social_account_id=v_job.social_account_id AND user_id=v_job.user_id;
  RETURN jsonb_build_object('job_id',p_job_id,'job_generation',p_job_generation,'state',p_outcome,
    'on_time',p_outcome='success' AND clock_timestamp()<v_job.next_due_at,'due_at',v_job.due_at,'next_due_at',v_job.next_due_at);
END;
$fn$;
CREATE FUNCTION public.cleanup_fb_analytics_history(p_user_id uuid,p_account_id uuid,p_floor timestamptz,p_limit integer DEFAULT 500,p_dry_run boolean DEFAULT true)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp SET lock_timeout='3s' AS $fn$
DECLARE v_today_floor timestamptz:=((clock_timestamp() AT TIME ZONE 'UTC')::date-365)::timestamp AT TIME ZONE 'UTC';
  v_deleted integer:=0;v_visible integer:=0;v_count integer;v_revision bigint;v_anchors uuid[];
BEGIN
  PERFORM public.meta_analytics_assert_service();
  IF p_floor IS NULL OR NOT isfinite(p_floor) OR p_floor>v_today_floor OR p_floor<v_today_floor-interval '1 day'
    OR (p_floor AT TIME ZONE 'UTC')::time<>'00:00'::time OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 500 OR p_dry_run IS NULL THEN
    RAISE EXCEPTION 'META_ANALYTICS_INVALID_CLEANUP_SCOPE' USING ERRCODE='MAH01'; END IF;
  PERFORM public.meta_analytics_lock_account(p_account_id,p_user_id,'facebook');
  IF NOT public.meta_analytics_retention_allowed('facebook',p_account_id,p_dry_run) THEN RAISE EXCEPTION 'META_ANALYTICS_RETENTION_DISABLED' USING ERRCODE='MAH03'; END IF;
  SELECT report_revision INTO v_revision FROM public.fb_analytics_report_state WHERE social_account_id=p_account_id AND user_id=p_user_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('deleted',0,'dry_run',p_dry_run,'skipped',false,'report_revision',NULL,'floor',p_floor); END IF;
  IF EXISTS(SELECT 1 FROM public.fb_analytics_collection_jobs WHERE user_id=p_user_id AND social_account_id=p_account_id AND lease_until>clock_timestamp()) THEN
    RETURN jsonb_build_object('deleted',0,'dry_run',p_dry_run,'skipped',true,'report_revision',v_revision,'floor',p_floor); END IF;
  SELECT COALESCE(array_agg(id),'{}') INTO v_anchors FROM (
    SELECT DISTINCT ON(m.metric_key) o.id FROM public.fb_page_profile_observations o JOIN public.fb_analytics_metric_values m ON m.profile_observation_id=o.id
    WHERE o.user_id=p_user_id AND o.social_account_id=p_account_id AND o.observed_at<p_floor AND m.status='available'
    ORDER BY m.metric_key,o.observed_at DESC,o.id DESC) a;
  BEGIN
    DELETE FROM public.fb_analytics_metric_values WHERE id IN (
      SELECT m.id FROM public.fb_analytics_metric_values m
      LEFT JOIN public.fb_post_insight_snapshots p ON p.id=m.post_snapshot_id LEFT JOIN public.fb_page_insight_daily d ON d.id=m.daily_id LEFT JOIN public.fb_page_profile_observations o ON o.id=m.profile_observation_id
      WHERE m.user_id=p_user_id AND m.social_account_id=p_account_id AND
        (p.captured_on<(p_floor AT TIME ZONE 'UTC')::date OR d.period_end<=p_floor OR o.observed_at<p_floor AND NOT o.id=ANY(v_anchors))
      ORDER BY m.id LIMIT p_limit-v_deleted);
    GET DIAGNOSTICS v_count=ROW_COUNT;v_deleted:=v_deleted+v_count;v_visible:=v_visible+v_count;
    DELETE FROM public.fb_post_insight_snapshots p WHERE p.id IN (SELECT q.id FROM public.fb_post_insight_snapshots q WHERE q.user_id=p_user_id AND q.social_account_id=p_account_id
      AND q.captured_on<(p_floor AT TIME ZONE 'UTC')::date AND NOT EXISTS(SELECT 1 FROM public.fb_analytics_metric_values m WHERE m.post_snapshot_id=q.id) ORDER BY q.id LIMIT p_limit-v_deleted);
    GET DIAGNOSTICS v_count=ROW_COUNT;v_deleted:=v_deleted+v_count;v_visible:=v_visible+v_count;
    DELETE FROM public.fb_page_insight_daily d WHERE d.id IN (SELECT q.id FROM public.fb_page_insight_daily q WHERE q.user_id=p_user_id AND q.social_account_id=p_account_id
      AND q.period_end<=p_floor AND NOT EXISTS(SELECT 1 FROM public.fb_analytics_metric_values m WHERE m.daily_id=q.id) ORDER BY q.id LIMIT p_limit-v_deleted);
    GET DIAGNOSTICS v_count=ROW_COUNT;v_deleted:=v_deleted+v_count;v_visible:=v_visible+v_count;
    DELETE FROM public.fb_page_profile_observations o WHERE o.id IN (SELECT q.id FROM public.fb_page_profile_observations q WHERE q.user_id=p_user_id AND q.social_account_id=p_account_id
      AND q.observed_at<p_floor AND NOT q.id=ANY(v_anchors) AND NOT EXISTS(SELECT 1 FROM public.fb_analytics_metric_values m WHERE m.profile_observation_id=q.id) ORDER BY q.id LIMIT p_limit-v_deleted);
    GET DIAGNOSTICS v_count=ROW_COUNT;v_deleted:=v_deleted+v_count;v_visible:=v_visible+v_count;
    DELETE FROM public.fb_analytics_period_totals WHERE id IN (SELECT id FROM public.fb_analytics_period_totals WHERE user_id=p_user_id AND social_account_id=p_account_id
      AND window_until<=p_floor AND captured_on<(p_floor AT TIME ZONE 'UTC')::date ORDER BY id LIMIT p_limit-v_deleted);
    GET DIAGNOSTICS v_count=ROW_COUNT;v_deleted:=v_deleted+v_count;v_visible:=v_visible+v_count;
    DELETE FROM public.fb_analytics_captures c WHERE c.id IN (SELECT q.id FROM public.fb_analytics_captures q WHERE q.user_id=p_user_id AND q.social_account_id=p_account_id AND q.requested_at<p_floor
      AND NOT EXISTS(SELECT 1 FROM public.fb_analytics_metric_values m WHERE m.capture_id=q.id)
      AND NOT EXISTS(SELECT 1 FROM public.fb_post_insight_snapshots p WHERE p.metadata_capture_id=q.id)
      AND NOT EXISTS(SELECT 1 FROM public.fb_page_profile_observations o WHERE o.capture_id=q.id)
      AND NOT EXISTS(SELECT 1 FROM public.fb_analytics_period_totals t WHERE t.capture_id=q.id) ORDER BY q.id LIMIT p_limit-v_deleted);
    GET DIAGNOSTICS v_count=ROW_COUNT;v_deleted:=v_deleted+v_count;
    DELETE FROM public.fb_analytics_collection_operations o WHERE o.id IN (SELECT q.id FROM public.fb_analytics_collection_operations q JOIN public.fb_analytics_collection_jobs j ON j.id=q.job_id
      WHERE q.user_id=p_user_id AND q.social_account_id=p_account_id AND j.state IN ('success','failed') AND j.next_due_at<=p_floor
      AND NOT EXISTS(SELECT 1 FROM public.fb_analytics_captures c WHERE c.operation_id=q.id) ORDER BY q.id LIMIT p_limit-v_deleted);
    GET DIAGNOSTICS v_count=ROW_COUNT;v_deleted:=v_deleted+v_count;
    DELETE FROM public.fb_analytics_collection_checkpoints q WHERE (q.job_id,q.job_generation) IN (SELECT c.job_id,c.job_generation FROM public.fb_analytics_collection_checkpoints c
      JOIN public.fb_analytics_collection_jobs j ON j.id=c.job_id WHERE c.user_id=p_user_id AND c.social_account_id=p_account_id AND j.state IN ('success','failed') AND j.next_due_at<=p_floor
      ORDER BY c.job_id,c.job_generation LIMIT p_limit-v_deleted);
    GET DIAGNOSTICS v_count=ROW_COUNT;v_deleted:=v_deleted+v_count;
    DELETE FROM public.fb_analytics_collection_jobs j WHERE j.id IN (SELECT q.id FROM public.fb_analytics_collection_jobs q WHERE q.user_id=p_user_id AND q.social_account_id=p_account_id
      AND q.state IN ('success','failed') AND q.next_due_at<=p_floor AND NOT EXISTS(SELECT 1 FROM public.fb_analytics_collection_operations o WHERE o.job_id=q.id)
      AND NOT EXISTS(SELECT 1 FROM public.fb_analytics_collection_checkpoints c WHERE c.job_id=q.id)
      AND NOT EXISTS(SELECT 1 FROM public.fb_analytics_captures c WHERE c.job_id=q.id) ORDER BY q.id LIMIT p_limit-v_deleted);
    GET DIAGNOSTICS v_count=ROW_COUNT;v_deleted:=v_deleted+v_count;
    IF v_visible>0 THEN UPDATE public.fb_analytics_report_state SET report_revision=report_revision+1,retention_floor=GREATEST(retention_floor,p_floor),updated_at=now()
      WHERE social_account_id=p_account_id AND user_id=p_user_id RETURNING report_revision INTO v_revision; END IF;
    IF p_dry_run THEN RAISE EXCEPTION 'META_ANALYTICS_DRY_RUN_ROLLBACK' USING ERRCODE='MAH09'; END IF;
  EXCEPTION WHEN SQLSTATE 'MAH09' THEN NULL;
  END;
  IF p_dry_run THEN SELECT report_revision INTO v_revision FROM public.fb_analytics_report_state WHERE social_account_id=p_account_id AND user_id=p_user_id; END IF;
  RETURN jsonb_build_object('deleted',v_deleted,'visible_deleted',v_visible,'dry_run',p_dry_run,'skipped',false,'report_revision',v_revision,'floor',p_floor);
END;
$fn$;


CREATE FUNCTION public.complete_threads_analytics_collection_job(p_job_id uuid,p_claim_token uuid,p_job_generation bigint,p_outcome text,p_reason text DEFAULT NULL,p_retry_at timestamptz DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp SET lock_timeout='3s' AS $fn$
DECLARE v_job public.threads_analytics_collection_jobs;
BEGIN
  PERFORM public.meta_analytics_assert_service();v_job:=public.threads_analytics_fenced_job(p_job_id,p_claim_token,p_job_generation);
  IF p_outcome IS NULL OR p_outcome NOT IN ('success','partial','failed','retry') OR p_reason IS NOT NULL AND p_reason !~ '^[a-z0-9_]{1,64}$'
    OR p_outcome='retry' AND (p_retry_at IS NULL OR NOT isfinite(p_retry_at) OR p_retry_at<=clock_timestamp() OR p_retry_at>clock_timestamp()+interval '1 day') THEN
    RAISE EXCEPTION 'META_ANALYTICS_INVALID_COMPLETION' USING ERRCODE='MAH01'; END IF;
  IF p_outcome='success' AND (
    NOT EXISTS(SELECT 1 FROM public.threads_analytics_collection_checkpoints WHERE job_id=p_job_id AND job_generation=p_job_generation AND inventory_complete AND NOT inventory_truncated)
    OR EXISTS(SELECT 1 FROM public.threads_analytics_collection_operations WHERE job_id=p_job_id AND job_generation=p_job_generation AND state IN ('pending','failed'))
    OR NOT EXISTS(SELECT 1 FROM public.threads_analytics_collection_operations WHERE job_id=p_job_id AND job_generation=p_job_generation AND kind='account_day' AND state='success')
    ) THEN
    RAISE EXCEPTION 'META_ANALYTICS_INCOMPLETE_COLLECTION' USING ERRCODE='MAH05'; END IF;

  IF p_outcome='success' AND (
    EXISTS(SELECT 1 FROM unnest(ARRAY[v_job.due_on-1,v_job.due_on-2]) day_value CROSS JOIN unnest(ARRAY['profile_views']) key_value
      WHERE NOT EXISTS(SELECT 1 FROM public.threads_account_insight_daily d JOIN public.threads_analytics_metric_values m ON m.daily_id=d.id
        JOIN public.threads_analytics_captures c ON c.id=m.capture_id WHERE d.user_id=v_job.user_id AND d.social_account_id=v_job.social_account_id
          AND d.metric_date=day_value AND m.metric_key=key_value AND c.job_id=p_job_id AND c.job_generation=p_job_generation
          AND m.status='available'))
    OR EXISTS(SELECT 1 FROM public.threads_analytics_collection_checkpoints checkpoint CROSS JOIN unnest(checkpoint.post_ids) post_id CROSS JOIN unnest(ARRAY['views','likes','replies','reposts','quotes','shares']) key_value
      WHERE checkpoint.job_id=p_job_id AND checkpoint.job_generation=p_job_generation
        AND NOT EXISTS(SELECT 1 FROM public.threads_post_insight_snapshots p JOIN public.threads_analytics_metric_values m ON m.post_snapshot_id=p.id
          JOIN public.threads_analytics_captures c ON c.id=m.capture_id WHERE p.user_id=v_job.user_id AND p.social_account_id=v_job.social_account_id
            AND p.platform_post_id=post_id AND m.metric_key=key_value AND c.job_id=p_job_id AND c.job_generation=p_job_generation
            AND m.status='available'))
    OR NOT EXISTS(SELECT 1 FROM public.threads_analytics_metric_values m JOIN public.threads_analytics_captures c ON c.id=m.capture_id WHERE c.job_id=p_job_id AND c.job_generation=p_job_generation AND m.profile_observation_id IS NOT NULL AND m.metric_key='followers' AND m.status='available')
  ) THEN RAISE EXCEPTION 'META_ANALYTICS_INCOMPLETE_COLLECTION' USING ERRCODE='MAH05'; END IF;
  IF v_job.lease_until<=clock_timestamp() THEN RAISE EXCEPTION 'META_ANALYTICS_STALE_CLAIM' USING ERRCODE='MAH04'; END IF;
  UPDATE public.threads_analytics_collection_jobs SET state=p_outcome,completed_at=CASE WHEN p_outcome IN ('success','failed') THEN clock_timestamp() END,
    last_success_at=CASE WHEN p_outcome='success' THEN clock_timestamp() ELSE last_success_at END,
    last_partial_at=CASE WHEN p_outcome='partial' THEN clock_timestamp() ELSE last_partial_at END,
    retry_at=CASE WHEN p_outcome='retry' THEN p_retry_at WHEN p_outcome='partial' THEN clock_timestamp() ELSE NULL END,
    reason_code=p_reason,claim_token=NULL,lease_until=NULL,updated_at=clock_timestamp() WHERE id=p_job_id;
  UPDATE public.threads_analytics_report_state SET report_revision=report_revision+1,updated_at=now() WHERE social_account_id=v_job.social_account_id AND user_id=v_job.user_id;
  RETURN jsonb_build_object('job_id',p_job_id,'job_generation',p_job_generation,'state',p_outcome,
    'on_time',p_outcome='success' AND clock_timestamp()<v_job.next_due_at,'due_at',v_job.due_at,'next_due_at',v_job.next_due_at);
END;
$fn$;
CREATE FUNCTION public.cleanup_threads_analytics_history(p_user_id uuid,p_account_id uuid,p_floor timestamptz,p_limit integer DEFAULT 500,p_dry_run boolean DEFAULT true)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp SET lock_timeout='3s' AS $fn$
DECLARE v_today_floor timestamptz:=((clock_timestamp() AT TIME ZONE 'UTC')::date-365)::timestamp AT TIME ZONE 'UTC';
  v_deleted integer:=0;v_visible integer:=0;v_count integer;v_revision bigint;v_anchors uuid[];
BEGIN
  PERFORM public.meta_analytics_assert_service();
  IF p_floor IS NULL OR NOT isfinite(p_floor) OR p_floor>v_today_floor OR p_floor<v_today_floor-interval '1 day'
    OR (p_floor AT TIME ZONE 'UTC')::time<>'00:00'::time OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 500 OR p_dry_run IS NULL THEN
    RAISE EXCEPTION 'META_ANALYTICS_INVALID_CLEANUP_SCOPE' USING ERRCODE='MAH01'; END IF;
  PERFORM public.meta_analytics_lock_account(p_account_id,p_user_id,'threads');
  IF NOT public.meta_analytics_retention_allowed('threads',p_account_id,p_dry_run) THEN RAISE EXCEPTION 'META_ANALYTICS_RETENTION_DISABLED' USING ERRCODE='MAH03'; END IF;
  SELECT report_revision INTO v_revision FROM public.threads_analytics_report_state WHERE social_account_id=p_account_id AND user_id=p_user_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('deleted',0,'dry_run',p_dry_run,'skipped',false,'report_revision',NULL,'floor',p_floor); END IF;
  IF EXISTS(SELECT 1 FROM public.threads_analytics_collection_jobs WHERE user_id=p_user_id AND social_account_id=p_account_id AND lease_until>clock_timestamp()) THEN
    RETURN jsonb_build_object('deleted',0,'dry_run',p_dry_run,'skipped',true,'report_revision',v_revision,'floor',p_floor); END IF;
  SELECT COALESCE(array_agg(id),'{}') INTO v_anchors FROM (
    SELECT DISTINCT ON(m.metric_key) o.id FROM public.threads_account_profile_observations o JOIN public.threads_analytics_metric_values m ON m.profile_observation_id=o.id
    WHERE o.user_id=p_user_id AND o.social_account_id=p_account_id AND o.observed_at<p_floor AND m.status='available'
    ORDER BY m.metric_key,o.observed_at DESC,o.id DESC) a;
  BEGIN
    DELETE FROM public.threads_analytics_metric_values WHERE id IN (
      SELECT m.id FROM public.threads_analytics_metric_values m
      LEFT JOIN public.threads_post_insight_snapshots p ON p.id=m.post_snapshot_id LEFT JOIN public.threads_account_insight_daily d ON d.id=m.daily_id LEFT JOIN public.threads_account_profile_observations o ON o.id=m.profile_observation_id
      WHERE m.user_id=p_user_id AND m.social_account_id=p_account_id AND
        (p.captured_on<(p_floor AT TIME ZONE 'UTC')::date OR d.period_end<=p_floor OR o.observed_at<p_floor AND NOT o.id=ANY(v_anchors))
      ORDER BY m.id LIMIT p_limit-v_deleted);
    GET DIAGNOSTICS v_count=ROW_COUNT;v_deleted:=v_deleted+v_count;v_visible:=v_visible+v_count;
    DELETE FROM public.threads_post_insight_snapshots p WHERE p.id IN (SELECT q.id FROM public.threads_post_insight_snapshots q WHERE q.user_id=p_user_id AND q.social_account_id=p_account_id
      AND q.captured_on<(p_floor AT TIME ZONE 'UTC')::date AND NOT EXISTS(SELECT 1 FROM public.threads_analytics_metric_values m WHERE m.post_snapshot_id=q.id) ORDER BY q.id LIMIT p_limit-v_deleted);
    GET DIAGNOSTICS v_count=ROW_COUNT;v_deleted:=v_deleted+v_count;v_visible:=v_visible+v_count;
    DELETE FROM public.threads_account_insight_daily d WHERE d.id IN (SELECT q.id FROM public.threads_account_insight_daily q WHERE q.user_id=p_user_id AND q.social_account_id=p_account_id
      AND q.period_end<=p_floor AND NOT EXISTS(SELECT 1 FROM public.threads_analytics_metric_values m WHERE m.daily_id=q.id) ORDER BY q.id LIMIT p_limit-v_deleted);
    GET DIAGNOSTICS v_count=ROW_COUNT;v_deleted:=v_deleted+v_count;v_visible:=v_visible+v_count;
    DELETE FROM public.threads_account_profile_observations o WHERE o.id IN (SELECT q.id FROM public.threads_account_profile_observations q WHERE q.user_id=p_user_id AND q.social_account_id=p_account_id
      AND q.observed_at<p_floor AND NOT q.id=ANY(v_anchors) AND NOT EXISTS(SELECT 1 FROM public.threads_analytics_metric_values m WHERE m.profile_observation_id=q.id) ORDER BY q.id LIMIT p_limit-v_deleted);
    GET DIAGNOSTICS v_count=ROW_COUNT;v_deleted:=v_deleted+v_count;v_visible:=v_visible+v_count;
    DELETE FROM public.threads_analytics_period_totals WHERE id IN (SELECT id FROM public.threads_analytics_period_totals WHERE user_id=p_user_id AND social_account_id=p_account_id
      AND window_until<=p_floor AND captured_on<(p_floor AT TIME ZONE 'UTC')::date ORDER BY id LIMIT p_limit-v_deleted);
    GET DIAGNOSTICS v_count=ROW_COUNT;v_deleted:=v_deleted+v_count;v_visible:=v_visible+v_count;
    DELETE FROM public.threads_analytics_captures c WHERE c.id IN (SELECT q.id FROM public.threads_analytics_captures q WHERE q.user_id=p_user_id AND q.social_account_id=p_account_id AND q.requested_at<p_floor
      AND NOT EXISTS(SELECT 1 FROM public.threads_analytics_metric_values m WHERE m.capture_id=q.id)
      AND NOT EXISTS(SELECT 1 FROM public.threads_post_insight_snapshots p WHERE p.metadata_capture_id=q.id)
      AND NOT EXISTS(SELECT 1 FROM public.threads_account_profile_observations o WHERE o.capture_id=q.id)
      AND NOT EXISTS(SELECT 1 FROM public.threads_analytics_period_totals t WHERE t.capture_id=q.id) ORDER BY q.id LIMIT p_limit-v_deleted);
    GET DIAGNOSTICS v_count=ROW_COUNT;v_deleted:=v_deleted+v_count;
    DELETE FROM public.threads_analytics_collection_operations o WHERE o.id IN (SELECT q.id FROM public.threads_analytics_collection_operations q JOIN public.threads_analytics_collection_jobs j ON j.id=q.job_id
      WHERE q.user_id=p_user_id AND q.social_account_id=p_account_id AND j.state IN ('success','failed') AND j.next_due_at<=p_floor
      AND NOT EXISTS(SELECT 1 FROM public.threads_analytics_captures c WHERE c.operation_id=q.id) ORDER BY q.id LIMIT p_limit-v_deleted);
    GET DIAGNOSTICS v_count=ROW_COUNT;v_deleted:=v_deleted+v_count;
    DELETE FROM public.threads_analytics_collection_checkpoints q WHERE (q.job_id,q.job_generation) IN (SELECT c.job_id,c.job_generation FROM public.threads_analytics_collection_checkpoints c
      JOIN public.threads_analytics_collection_jobs j ON j.id=c.job_id WHERE c.user_id=p_user_id AND c.social_account_id=p_account_id AND j.state IN ('success','failed') AND j.next_due_at<=p_floor
      ORDER BY c.job_id,c.job_generation LIMIT p_limit-v_deleted);
    GET DIAGNOSTICS v_count=ROW_COUNT;v_deleted:=v_deleted+v_count;
    DELETE FROM public.threads_analytics_collection_jobs j WHERE j.id IN (SELECT q.id FROM public.threads_analytics_collection_jobs q WHERE q.user_id=p_user_id AND q.social_account_id=p_account_id
      AND q.state IN ('success','failed') AND q.next_due_at<=p_floor AND NOT EXISTS(SELECT 1 FROM public.threads_analytics_collection_operations o WHERE o.job_id=q.id)
      AND NOT EXISTS(SELECT 1 FROM public.threads_analytics_collection_checkpoints c WHERE c.job_id=q.id)
      AND NOT EXISTS(SELECT 1 FROM public.threads_analytics_captures c WHERE c.job_id=q.id) ORDER BY q.id LIMIT p_limit-v_deleted);
    GET DIAGNOSTICS v_count=ROW_COUNT;v_deleted:=v_deleted+v_count;
    IF v_visible>0 THEN UPDATE public.threads_analytics_report_state SET report_revision=report_revision+1,retention_floor=GREATEST(retention_floor,p_floor),updated_at=now()
      WHERE social_account_id=p_account_id AND user_id=p_user_id RETURNING report_revision INTO v_revision; END IF;
    IF p_dry_run THEN RAISE EXCEPTION 'META_ANALYTICS_DRY_RUN_ROLLBACK' USING ERRCODE='MAH09'; END IF;
  EXCEPTION WHEN SQLSTATE 'MAH09' THEN NULL;
  END;
  IF p_dry_run THEN SELECT report_revision INTO v_revision FROM public.threads_analytics_report_state WHERE social_account_id=p_account_id AND user_id=p_user_id; END IF;
  RETURN jsonb_build_object('deleted',v_deleted,'visible_deleted',v_visible,'dry_run',p_dry_run,'skipped',false,'report_revision',v_revision,'floor',p_floor);
END;
$fn$;


CREATE FUNCTION public.read_fb_analytics_history(p_user_id uuid,p_account_id uuid,p_request jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
DECLARE v_owner uuid;v_since timestamptz;v_until timestamptz;v_previous timestamptz;v_days integer;v_limit integer;
  v_after timestamptz;v_after_id text;v_expected bigint;v_result jsonb;
BEGIN
  IF auth.role()='authenticated' THEN v_owner:=auth.uid();
  ELSIF auth.role()='service_role' THEN v_owner:=p_user_id;
  ELSE RAISE EXCEPTION 'META_ANALYTICS_CALLER_NOT_ALLOWED' USING ERRCODE='42501'; END IF;
  IF v_owner IS NULL OR p_request IS NULL OR jsonb_typeof(p_request)<>'object'
    OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_request) k WHERE k NOT IN ('since','until','expected_revision','after_published_at','after_id','limit')) THEN
    RAISE EXCEPTION 'META_ANALYTICS_INVALID_REPORT_REQUEST' USING ERRCODE='MAH01'; END IF;
  BEGIN
    v_since:=(p_request->>'since')::timestamptz;v_until:=(p_request->>'until')::timestamptz;
    v_after:=(p_request->>'after_published_at')::timestamptz;v_after_id:=p_request->>'after_id';
    v_expected:=(p_request->>'expected_revision')::bigint;v_limit:=COALESCE((p_request->>'limit')::integer,25);
  EXCEPTION WHEN invalid_text_representation OR invalid_datetime_format OR datetime_field_overflow OR numeric_value_out_of_range THEN
    RAISE EXCEPTION 'META_ANALYTICS_INVALID_REPORT_REQUEST' USING ERRCODE='MAH01';
  END;
  v_days:=(v_until AT TIME ZONE 'America/Los_Angeles')::date-(v_since AT TIME ZONE 'America/Los_Angeles')::date;
  IF v_since IS NULL OR v_until IS NULL OR NOT isfinite(v_since) OR NOT isfinite(v_until) OR v_days NOT IN (7,14,30,90)
    OR (v_since AT TIME ZONE 'America/Los_Angeles')::time<>'00:00'::time OR (v_until AT TIME ZONE 'America/Los_Angeles')::time<>'00:00'::time
    OR v_until>(clock_timestamp() AT TIME ZONE 'America/Los_Angeles')::date::timestamp AT TIME ZONE 'America/Los_Angeles'
    OR v_limit NOT BETWEEN 1 AND 50 OR (v_after IS NULL)<>(v_after_id IS NULL) OR v_after IS NOT NULL AND (v_expected IS NULL OR v_expected<1)
    OR v_after IS NOT NULL AND (NOT isfinite(v_after) OR v_after_id !~ '^[a-zA-Z0-9_-]{1,200}$') THEN
    RAISE EXCEPTION 'META_ANALYTICS_INVALID_REPORT_REQUEST' USING ERRCODE='MAH01'; END IF;
  v_previous:=((v_since AT TIME ZONE 'America/Los_Angeles')::date-v_days)::timestamp AT TIME ZONE 'America/Los_Angeles';
  WITH owned AS (
    SELECT a.id,a.user_id,s.report_revision,s.retention_floor,s.provider_timezone
    FROM public.social_accounts a LEFT JOIN public.fb_analytics_report_state s ON s.social_account_id=a.id AND s.user_id=a.user_id
    WHERE a.id=p_account_id AND a.user_id=v_owner AND a.platform='facebook'
  ), latest_posts AS (
    SELECT DISTINCT ON(p.platform_post_id) p.* FROM public.fb_post_insight_snapshots p JOIN owned a ON a.id=p.social_account_id AND a.user_id=p.user_id
    WHERE p.published_at>=v_since AND p.published_at<v_until ORDER BY p.platform_post_id,p.captured_on DESC
  ), selected_posts AS (
    SELECT * FROM latest_posts p WHERE v_after IS NULL OR (p.published_at,p.platform_post_id)<(v_after,v_after_id)
    ORDER BY p.published_at DESC,p.platform_post_id DESC LIMIT v_limit+1
  ), boundaries AS (SELECT unnest(ARRAY[v_previous,v_since,v_until]) AS boundary), samples AS (
    SELECT b.boundary,m.* FROM boundaries b CROSS JOIN LATERAL (
      SELECT DISTINCT ON(v.metric_key) o.observed_at,o.id AS observation_id,v.*
      FROM public.fb_page_profile_observations o JOIN public.fb_analytics_metric_values v ON v.profile_observation_id=o.id
      JOIN owned a ON a.id=o.social_account_id AND a.user_id=o.user_id
      WHERE o.observed_at<=b.boundary AND o.observed_at>=b.boundary-interval '24 hours'
      ORDER BY v.metric_key,(v.status='available') DESC,o.observed_at DESC,o.id DESC
    ) m
  ) SELECT CASE
    WHEN v_expected IS NOT NULL AND v_expected IS DISTINCT FROM a.report_revision THEN jsonb_build_object('ok',false,'reason','history_revision_changed')
    WHEN a.retention_floor IS NOT NULL AND v_previous<a.retention_floor THEN jsonb_build_object('ok',false,'reason','history_expired')
    ELSE jsonb_build_object('ok',true,'account_id',a.id,'platform','facebook','revision',a.report_revision,'retention_floor',a.retention_floor,
      'as_of',v_until,'since',v_since,'until',v_until,'previous_since',v_previous,'timezone','America/Los_Angeles',
      'daily',COALESCE((SELECT jsonb_agg(jsonb_build_object('bucket',to_jsonb(d),'metrics',
        (SELECT COALESCE(jsonb_agg(to_jsonb(m)||jsonb_build_object('collected_at',c.received_at)),'[]') FROM public.fb_analytics_metric_values m
         JOIN public.fb_analytics_captures c ON c.id=m.capture_id WHERE m.daily_id=d.id)))
        FROM public.fb_page_insight_daily d WHERE d.user_id=a.user_id AND d.social_account_id=a.id AND d.period_start>=v_previous AND d.period_end<=v_until),'[]'),
      'posts',COALESCE((SELECT jsonb_agg(jsonb_build_object('post',to_jsonb(p),'metrics',
        (SELECT COALESCE(jsonb_agg(to_jsonb(m)||jsonb_build_object('collected_at',c.received_at)),'[]') FROM public.fb_analytics_metric_values m
         JOIN public.fb_analytics_captures c ON c.id=m.capture_id WHERE m.post_snapshot_id=p.id)) ORDER BY p.published_at DESC,p.platform_post_id DESC) FROM selected_posts p),'[]'),
      'profile_boundaries',COALESCE((SELECT jsonb_agg(to_jsonb(x)) FROM samples x),'[]'),
      'period_totals',COALESCE((SELECT jsonb_agg(to_jsonb(t)||jsonb_build_object('collected_at',c.received_at)) FROM public.fb_analytics_period_totals t
        JOIN public.fb_analytics_captures c ON c.id=t.capture_id WHERE t.user_id=a.user_id AND t.social_account_id=a.id
        AND ((t.window_since=v_since AND t.window_until=v_until) OR (t.window_since=v_previous AND t.window_until=v_since))),'[]'),
      'collection',jsonb_build_object('last_success_at',(SELECT max(last_success_at) FROM public.fb_analytics_collection_jobs WHERE user_id=a.user_id AND social_account_id=a.id),
        'last_partial_at',(SELECT max(last_partial_at) FROM public.fb_analytics_collection_jobs WHERE user_id=a.user_id AND social_account_id=a.id),
        'latest', (SELECT jsonb_build_object('state',j.state,'reason_code',j.reason_code,'retry_at',j.retry_at,'due_at',j.due_at,'next_due_at',j.next_due_at,'completed_at',j.completed_at) FROM public.fb_analytics_collection_jobs j WHERE j.user_id=a.user_id AND j.social_account_id=a.id ORDER BY j.due_at DESC,j.id DESC LIMIT 1),
        'syncing',EXISTS(SELECT 1 FROM public.fb_analytics_collection_jobs WHERE user_id=a.user_id AND social_account_id=a.id AND lease_until>clock_timestamp()))
    ) END INTO v_result FROM owned a;
  IF v_result IS NULL THEN RAISE EXCEPTION 'META_ANALYTICS_ACCOUNT_NOT_FOUND' USING ERRCODE='MAH02'; END IF;
  RETURN v_result;
END;
$fn$;


CREATE FUNCTION public.read_threads_analytics_history(p_user_id uuid,p_account_id uuid,p_request jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
DECLARE v_owner uuid;v_since timestamptz;v_until timestamptz;v_previous timestamptz;v_days integer;v_limit integer;
  v_after timestamptz;v_after_id text;v_expected bigint;v_result jsonb;
BEGIN
  IF auth.role()='authenticated' THEN v_owner:=auth.uid();
  ELSIF auth.role()='service_role' THEN v_owner:=p_user_id;
  ELSE RAISE EXCEPTION 'META_ANALYTICS_CALLER_NOT_ALLOWED' USING ERRCODE='42501'; END IF;
  IF v_owner IS NULL OR p_request IS NULL OR jsonb_typeof(p_request)<>'object'
    OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_request) k WHERE k NOT IN ('since','until','expected_revision','after_published_at','after_id','limit')) THEN
    RAISE EXCEPTION 'META_ANALYTICS_INVALID_REPORT_REQUEST' USING ERRCODE='MAH01'; END IF;
  BEGIN
    v_since:=(p_request->>'since')::timestamptz;v_until:=(p_request->>'until')::timestamptz;
    v_after:=(p_request->>'after_published_at')::timestamptz;v_after_id:=p_request->>'after_id';
    v_expected:=(p_request->>'expected_revision')::bigint;v_limit:=COALESCE((p_request->>'limit')::integer,25);
  EXCEPTION WHEN invalid_text_representation OR invalid_datetime_format OR datetime_field_overflow OR numeric_value_out_of_range THEN
    RAISE EXCEPTION 'META_ANALYTICS_INVALID_REPORT_REQUEST' USING ERRCODE='MAH01';
  END;
  v_days:=(v_until AT TIME ZONE 'America/Los_Angeles')::date-(v_since AT TIME ZONE 'America/Los_Angeles')::date;
  IF v_since IS NULL OR v_until IS NULL OR NOT isfinite(v_since) OR NOT isfinite(v_until) OR v_days NOT IN (7,14,30,90)
    OR (v_since AT TIME ZONE 'America/Los_Angeles')::time<>'00:00'::time OR (v_until AT TIME ZONE 'America/Los_Angeles')::time<>'00:00'::time
    OR v_until>(clock_timestamp() AT TIME ZONE 'America/Los_Angeles')::date::timestamp AT TIME ZONE 'America/Los_Angeles'
    OR v_limit NOT BETWEEN 1 AND 50 OR (v_after IS NULL)<>(v_after_id IS NULL) OR v_after IS NOT NULL AND (v_expected IS NULL OR v_expected<1)
    OR v_after IS NOT NULL AND (NOT isfinite(v_after) OR v_after_id !~ '^[a-zA-Z0-9_-]{1,200}$') THEN
    RAISE EXCEPTION 'META_ANALYTICS_INVALID_REPORT_REQUEST' USING ERRCODE='MAH01'; END IF;
  v_previous:=((v_since AT TIME ZONE 'America/Los_Angeles')::date-v_days)::timestamp AT TIME ZONE 'America/Los_Angeles';
  WITH owned AS (
    SELECT a.id,a.user_id,s.report_revision,s.retention_floor,s.provider_timezone
    FROM public.social_accounts a LEFT JOIN public.threads_analytics_report_state s ON s.social_account_id=a.id AND s.user_id=a.user_id
    WHERE a.id=p_account_id AND a.user_id=v_owner AND a.platform='threads'
  ), latest_posts AS (
    SELECT DISTINCT ON(p.platform_post_id) p.* FROM public.threads_post_insight_snapshots p JOIN owned a ON a.id=p.social_account_id AND a.user_id=p.user_id
    WHERE p.published_at>=v_since AND p.published_at<v_until ORDER BY p.platform_post_id,p.captured_on DESC
  ), selected_posts AS (
    SELECT * FROM latest_posts p WHERE v_after IS NULL OR (p.published_at,p.platform_post_id)<(v_after,v_after_id)
    ORDER BY p.published_at DESC,p.platform_post_id DESC LIMIT v_limit+1
  ), boundaries AS (SELECT unnest(ARRAY[v_previous,v_since,v_until]) AS boundary), samples AS (
    SELECT b.boundary,m.* FROM boundaries b CROSS JOIN LATERAL (
      SELECT DISTINCT ON(v.metric_key) o.observed_at,o.id AS observation_id,v.*
      FROM public.threads_account_profile_observations o JOIN public.threads_analytics_metric_values v ON v.profile_observation_id=o.id
      JOIN owned a ON a.id=o.social_account_id AND a.user_id=o.user_id
      WHERE o.observed_at<=b.boundary AND o.observed_at>=b.boundary-interval '24 hours'
      ORDER BY v.metric_key,(v.status='available') DESC,o.observed_at DESC,o.id DESC
    ) m
  ) SELECT CASE
    WHEN v_expected IS NOT NULL AND v_expected IS DISTINCT FROM a.report_revision THEN jsonb_build_object('ok',false,'reason','history_revision_changed')
    WHEN a.retention_floor IS NOT NULL AND v_previous<a.retention_floor THEN jsonb_build_object('ok',false,'reason','history_expired')
    ELSE jsonb_build_object('ok',true,'account_id',a.id,'platform','threads','revision',a.report_revision,'retention_floor',a.retention_floor,
      'as_of',v_until,'since',v_since,'until',v_until,'previous_since',v_previous,'timezone','America/Los_Angeles',
      'daily',COALESCE((SELECT jsonb_agg(jsonb_build_object('bucket',to_jsonb(d),'metrics',
        (SELECT COALESCE(jsonb_agg(to_jsonb(m)||jsonb_build_object('collected_at',c.received_at)),'[]') FROM public.threads_analytics_metric_values m
         JOIN public.threads_analytics_captures c ON c.id=m.capture_id WHERE m.daily_id=d.id)))
        FROM public.threads_account_insight_daily d WHERE d.user_id=a.user_id AND d.social_account_id=a.id AND d.period_start>=v_previous AND d.period_end<=v_until),'[]'),
      'posts',COALESCE((SELECT jsonb_agg(jsonb_build_object('post',to_jsonb(p),'metrics',
        (SELECT COALESCE(jsonb_agg(to_jsonb(m)||jsonb_build_object('collected_at',c.received_at)),'[]') FROM public.threads_analytics_metric_values m
         JOIN public.threads_analytics_captures c ON c.id=m.capture_id WHERE m.post_snapshot_id=p.id)) ORDER BY p.published_at DESC,p.platform_post_id DESC) FROM selected_posts p),'[]'),
      'profile_boundaries',COALESCE((SELECT jsonb_agg(to_jsonb(x)) FROM samples x),'[]'),
      'period_totals',COALESCE((SELECT jsonb_agg(to_jsonb(t)||jsonb_build_object('collected_at',c.received_at)) FROM public.threads_analytics_period_totals t
        JOIN public.threads_analytics_captures c ON c.id=t.capture_id WHERE t.user_id=a.user_id AND t.social_account_id=a.id
        AND ((t.window_since=v_since AND t.window_until=v_until) OR (t.window_since=v_previous AND t.window_until=v_since))),'[]'),
      'collection',jsonb_build_object('last_success_at',(SELECT max(last_success_at) FROM public.threads_analytics_collection_jobs WHERE user_id=a.user_id AND social_account_id=a.id),
        'last_partial_at',(SELECT max(last_partial_at) FROM public.threads_analytics_collection_jobs WHERE user_id=a.user_id AND social_account_id=a.id),
        'latest', (SELECT jsonb_build_object('state',j.state,'reason_code',j.reason_code,'retry_at',j.retry_at,'due_at',j.due_at,'next_due_at',j.next_due_at,'completed_at',j.completed_at) FROM public.threads_analytics_collection_jobs j WHERE j.user_id=a.user_id AND j.social_account_id=a.id ORDER BY j.due_at DESC,j.id DESC LIMIT 1),
        'syncing',EXISTS(SELECT 1 FROM public.threads_analytics_collection_jobs WHERE user_id=a.user_id AND social_account_id=a.id AND lease_until>clock_timestamp()))
    ) END INTO v_result FROM owned a;
  IF v_result IS NULL THEN RAISE EXCEPTION 'META_ANALYTICS_ACCOUNT_NOT_FOUND' USING ERRCODE='MAH02'; END IF;
  RETURN v_result;
END;
$fn$;


-- Existing legacy writers remain callable. If they alter a scalar without the
-- new provenance wrapper, invalidate only the affected provenance rather than
-- attributing the new value to an old capture. Follow-breakdown-only updates do
-- not erase interaction provenance.
CREATE FUNCTION public.ig_analytics_invalidate_legacy_provenance()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
DECLARE v_count integer;
BEGIN
  IF TG_TABLE_NAME='ig_account_insight_daily' THEN
    DELETE FROM public.ig_analytics_metric_values m WHERE m.daily_id=OLD.id AND (
      OLD.status IS DISTINCT FROM NEW.status OR ROW(OLD.period_start,OLD.period_end,OLD.provider_timezone) IS DISTINCT FROM ROW(NEW.period_start,NEW.period_end,NEW.provider_timezone)
      OR m.metric_key='views' AND OLD.views IS DISTINCT FROM NEW.views
      OR m.metric_key='reach' AND OLD.reach IS DISTINCT FROM NEW.reach
      OR m.metric_key='engagements' AND OLD.total_interactions IS DISTINCT FROM NEW.total_interactions
      OR m.metric_key='likes' AND OLD.likes IS DISTINCT FROM NEW.likes
      OR m.metric_key='comments' AND OLD.comments IS DISTINCT FROM NEW.comments
      OR m.metric_key='saves' AND OLD.saves IS DISTINCT FROM NEW.saves
      OR m.metric_key='shares' AND OLD.shares IS DISTINCT FROM NEW.shares);
  ELSIF TG_TABLE_NAME='ig_media_insight_snapshots' THEN
    DELETE FROM public.ig_analytics_metric_values m WHERE m.post_snapshot_id=OLD.id AND (
      OLD.status IS DISTINCT FROM NEW.status
      OR m.metric_key='views' AND OLD.views IS DISTINCT FROM NEW.views
      OR m.metric_key='reach' AND OLD.reach IS DISTINCT FROM NEW.reach
      OR m.metric_key='engagements' AND OLD.total_interactions IS DISTINCT FROM NEW.total_interactions
      OR m.metric_key='likes' AND OLD.likes IS DISTINCT FROM NEW.likes
      OR m.metric_key='comments' AND OLD.comments IS DISTINCT FROM NEW.comments
      OR m.metric_key='saves' AND OLD.saved IS DISTINCT FROM NEW.saved
      OR m.metric_key='shares' AND OLD.shares IS DISTINCT FROM NEW.shares
      OR m.metric_key='replies' AND OLD.replies IS DISTINCT FROM NEW.replies
      OR m.metric_key='profile_views' AND OLD.profile_visits IS DISTINCT FROM NEW.profile_visits);
  ELSE
    DELETE FROM public.ig_analytics_metric_values m WHERE m.profile_observation_id=OLD.id
      AND (OLD.status IS DISTINCT FROM NEW.status OR m.metric_key='followers' AND OLD.followers_count IS DISTINCT FROM NEW.followers_count);
  END IF;
  GET DIAGNOSTICS v_count=ROW_COUNT;
  IF v_count>0 THEN UPDATE public.ig_analytics_report_state SET report_revision=report_revision+1 WHERE social_account_id=OLD.social_account_id AND user_id=OLD.user_id; END IF;
  RETURN NEW;
END;
$fn$;
CREATE TRIGGER ig_analytics_daily_invalidation AFTER UPDATE ON public.ig_account_insight_daily FOR EACH ROW EXECUTE FUNCTION public.ig_analytics_invalidate_legacy_provenance();
CREATE TRIGGER ig_analytics_post_invalidation AFTER UPDATE ON public.ig_media_insight_snapshots FOR EACH ROW EXECUTE FUNCTION public.ig_analytics_invalidate_legacy_provenance();
CREATE TRIGGER ig_analytics_profile_invalidation AFTER UPDATE ON public.ig_account_profile_observations FOR EACH ROW EXECUTE FUNCTION public.ig_analytics_invalidate_legacy_provenance();

CREATE FUNCTION public.meta_analytics_ig_legacy_digest(p_owner uuid,p_account uuid,p_captured_on date,p_identity jsonb)
RETURNS text LANGUAGE sql STABLE SECURITY INVOKER SET search_path=public,pg_temp AS $fn$
  SELECT encode(sha256(convert_to(legacy_row::text,'utf8')),'hex') FROM (
    SELECT to_jsonb(d) AS legacy_row FROM public.ig_account_insight_daily d
    WHERE p_identity->>'kind'='owner_account_day' AND d.user_id=p_owner AND d.social_account_id=p_account
      AND d.metric_date=(p_identity->>'metric_date')::date
    UNION ALL
    SELECT to_jsonb(p) FROM public.ig_media_insight_snapshots p
    WHERE p_identity->>'kind'='owner_media' AND p.user_id=p_owner AND p.social_account_id=p_account
      AND p.ig_media_id=p_identity->>'media_id' AND p.captured_on=p_captured_on
  ) legacy;
$fn$;

CREATE FUNCTION public.reserve_ig_analytics_capture(p_job_id uuid,p_claim_token uuid,p_job_generation bigint,p_request jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp SET lock_timeout='3s' AS $fn$
DECLARE v_job public.instagram_collection_jobs;v_kind text;v_date date;v_media text;v_metrics text[];v_identity jsonb;v_sequence bigint;v_capture uuid:=gen_random_uuid();v_legacy_digest text;
BEGIN
  PERFORM public.meta_analytics_assert_service();
  BEGIN
    v_job:=public.ig_collection_load_fenced_job(p_job_id,p_claim_token,p_job_generation,true,NULL);
  EXCEPTION WHEN serialization_failure THEN RAISE EXCEPTION 'META_ANALYTICS_STALE_CLAIM' USING ERRCODE='MAH04'; END;
  IF v_job.target_kind<>'owner' THEN RAISE EXCEPTION 'META_ANALYTICS_OWNER_JOB_REQUIRED' USING ERRCODE='MAH02'; END IF;
  IF p_request IS NULL OR jsonb_typeof(p_request)<>'object' OR pg_column_size(p_request)>8192
    OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_request) k WHERE k NOT IN ('kind','metric_date','media_id','metrics'))
    OR jsonb_typeof(p_request->'metrics') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'META_ANALYTICS_INVALID_CAPTURE_REQUEST' USING ERRCODE='MAH01'; END IF;
  v_kind:=p_request->>'kind';v_media:=p_request->>'media_id';
  SELECT array_agg(e#>>'{}' ORDER BY e#>>'{}') INTO v_metrics FROM jsonb_array_elements(p_request->'metrics') e;
  IF v_kind IS NULL OR v_kind NOT IN ('owner_account_day','owner_media','owner_profile_observation') OR v_metrics IS NULL
    OR cardinality(v_metrics) NOT BETWEEN 1 AND 14 OR cardinality(v_metrics)<>(SELECT count(DISTINCT k) FROM unnest(v_metrics) k)
    OR EXISTS(SELECT 1 FROM unnest(v_metrics) k WHERE NOT public.meta_analytics_metric_key_valid(k)) THEN
    RAISE EXCEPTION 'META_ANALYTICS_INVALID_CAPTURE_REQUEST' USING ERRCODE='MAH01'; END IF;
  IF v_kind='owner_account_day' THEN
    v_date:=(p_request->>'metric_date')::date;
    IF v_date IS NULL OR v_date>=v_job.captured_on OR v_date<v_job.captured_on-365 OR v_media IS NOT NULL
      OR NOT v_metrics<@ARRAY['views','reach','engagements','likes','comments','saves','shares']::text[] THEN
      RAISE EXCEPTION 'META_ANALYTICS_INVALID_CAPTURE_REQUEST' USING ERRCODE='MAH01'; END IF;
  ELSIF v_kind='owner_media' THEN
    IF v_media IS NULL OR v_media !~ '^[a-zA-Z0-9_-]{1,200}$' OR p_request ? 'metric_date'
      OR NOT v_metrics<@ARRAY['views','reach','engagements','likes','comments','saves','shares','replies','profile_views']::text[] THEN
      RAISE EXCEPTION 'META_ANALYTICS_INVALID_CAPTURE_REQUEST' USING ERRCODE='MAH01'; END IF;
  ELSIF v_media IS NOT NULL OR p_request ? 'metric_date' OR v_metrics IS DISTINCT FROM ARRAY['followers']::text[] THEN
    RAISE EXCEPTION 'META_ANALYTICS_INVALID_CAPTURE_REQUEST' USING ERRCODE='MAH01'; END IF;
  -- Both writers use the existing target/job fence. A pending sidecar response
  -- must not replace a legacy row accepted after this reservation.
  v_identity:=jsonb_build_object('kind',v_kind,'metric_date',v_date,'media_id',v_media,'metrics',v_metrics);
  v_legacy_digest:=public.meta_analytics_ig_legacy_digest(v_job.user_id,v_job.social_account_id,v_job.captured_on,v_identity);
  v_identity:=v_identity||jsonb_build_object('legacy_digest',v_legacy_digest);
  INSERT INTO public.ig_analytics_report_state(user_id,social_account_id) VALUES(v_job.user_id,v_job.social_account_id) ON CONFLICT(social_account_id) DO NOTHING;
  UPDATE public.ig_analytics_report_state SET next_capture_sequence=next_capture_sequence+1 WHERE user_id=v_job.user_id AND social_account_id=v_job.social_account_id RETURNING next_capture_sequence INTO v_sequence;
  PERFORM public.ig_collection_assert_lease_live(v_job.lease_expires_at);
  INSERT INTO public.ig_analytics_captures(id,user_id,social_account_id,job_id,job_generation,claim_token,request_identity,capture_sequence,credential_generation)
    VALUES(v_capture,v_job.user_id,v_job.social_account_id,p_job_id,p_job_generation,p_claim_token,v_identity,v_sequence,v_job.context_credential_generation);
  RETURN jsonb_build_object('capture_id',v_capture,'capture_sequence',v_sequence,'job_id',p_job_id,'job_generation',p_job_generation);
EXCEPTION WHEN serialization_failure THEN RAISE EXCEPTION 'META_ANALYTICS_STALE_CLAIM' USING ERRCODE='MAH04';
END;
$fn$;

CREATE FUNCTION public.persist_ig_analytics_snapshot(p_job_id uuid,p_claim_token uuid,p_job_generation bigint,p_capture_id uuid,p_legacy_payload jsonb,p_metric_values jsonb,p_received_at timestamptz)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp SET lock_timeout='3s' AS $fn$
DECLARE v_job public.instagram_collection_jobs;v_capture public.ig_analytics_captures;v_kind text;v_item jsonb;v_metrics text[];v_key text;v_cell jsonb;
  v_parent uuid;v_column text;v_window text;v_digest text;v_receipt jsonb;v_legacy_receipt jsonb;v_observed timestamptz;v_written integer:=0;
  v_since timestamptz;v_until timestamptz;v_timezone text;v_legacy_digest text;
BEGIN
  PERFORM public.meta_analytics_assert_service();
  v_job:=public.ig_collection_load_fenced_job(p_job_id,p_claim_token,p_job_generation,true,NULL);
  IF v_job.target_kind<>'owner' THEN RAISE EXCEPTION 'META_ANALYTICS_OWNER_JOB_REQUIRED' USING ERRCODE='MAH02'; END IF;
  SELECT * INTO v_capture FROM public.ig_analytics_captures WHERE id=p_capture_id AND job_id=p_job_id AND job_generation=p_job_generation
    AND user_id=v_job.user_id AND social_account_id=v_job.social_account_id FOR UPDATE;
  IF NOT FOUND OR v_capture.claim_token IS DISTINCT FROM p_claim_token OR v_capture.credential_generation IS DISTINCT FROM v_job.context_credential_generation THEN
    RAISE EXCEPTION 'META_ANALYTICS_CAPTURE_NOT_FOUND' USING ERRCODE='MAH02'; END IF;
  v_kind:=v_capture.request_identity->>'kind';
  IF p_legacy_payload IS NULL OR jsonb_typeof(p_legacy_payload)<>'object' OR p_legacy_payload->>'kind' IS DISTINCT FROM v_kind
    OR jsonb_typeof(p_legacy_payload->'items') IS DISTINCT FROM 'array' OR jsonb_array_length(p_legacy_payload->'items')<>1
    OR pg_column_size(p_legacy_payload)>262144 OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_legacy_payload) k WHERE k NOT IN ('kind','items')) THEN
    RAISE EXCEPTION 'META_ANALYTICS_INVALID_COMPATIBILITY_PAYLOAD' USING ERRCODE='MAH01'; END IF;
  SELECT array_agg(e#>>'{}' ORDER BY e#>>'{}') INTO v_metrics FROM jsonb_array_elements(v_capture.request_identity->'metrics') e;
  PERFORM public.meta_analytics_validate_metric_map(p_metric_values,v_metrics);
  IF p_received_at IS NULL OR NOT isfinite(p_received_at) OR p_received_at<v_capture.requested_at OR p_received_at>clock_timestamp() THEN
    RAISE EXCEPTION 'META_ANALYTICS_INVALID_CAPTURE_TIME' USING ERRCODE='MAH01'; END IF;
  v_item:=p_legacy_payload->'items'->0;
  IF v_kind='owner_account_day' AND ((v_item->>'metric_date')::date IS DISTINCT FROM (v_capture.request_identity->>'metric_date')::date OR v_item->>'query_kind' IS DISTINCT FROM 'interactions')
    OR v_kind='owner_media' AND v_item->>'ig_media_id' IS DISTINCT FROM v_capture.request_identity->>'media_id' THEN
    RAISE EXCEPTION 'META_ANALYTICS_CAPTURE_SUBJECT_MISMATCH' USING ERRCODE='MAH01'; END IF;
  IF EXISTS(SELECT 1 FROM public.ig_analytics_captures c WHERE c.user_id=v_capture.user_id AND c.social_account_id=v_capture.social_account_id
    AND c.capture_sequence>v_capture.capture_sequence AND c.request_identity->>'kind'=v_kind
    AND c.request_identity->'metric_date'=v_capture.request_identity->'metric_date' AND c.request_identity->'media_id'=v_capture.request_identity->'media_id') THEN
    RAISE EXCEPTION 'META_ANALYTICS_SUPERSEDED_CAPTURE' USING ERRCODE='MAH04'; END IF;
  v_digest:=encode(sha256(convert_to(jsonb_build_object('legacy',p_legacy_payload,'metrics',p_metric_values,'received_at',p_received_at)::text,'utf8')),'hex');
  IF v_capture.payload_digest IS NOT NULL THEN
    IF v_capture.payload_digest IS DISTINCT FROM v_digest THEN RAISE EXCEPTION 'META_ANALYTICS_CAPTURE_REPLAY_CONFLICT' USING ERRCODE='MAH04'; END IF;
    PERFORM public.ig_collection_assert_lease_live(v_job.lease_expires_at);RETURN v_capture.receipt;
  END IF;
  v_legacy_digest:=public.meta_analytics_ig_legacy_digest(v_job.user_id,v_job.social_account_id,v_job.captured_on,v_capture.request_identity);
  IF v_kind='owner_profile_observation' AND EXISTS(SELECT 1 FROM public.ig_account_profile_observations o WHERE o.user_id=v_job.user_id AND o.social_account_id=v_job.social_account_id
    AND o.observed_at=(v_item->>'observed_at')::timestamptz) THEN
    RAISE EXCEPTION 'META_ANALYTICS_NEWER_LEGACY_CAPTURE' USING ERRCODE='MAH04';
  END IF;
  IF v_capture.request_identity->>'legacy_digest' IS DISTINCT FROM v_legacy_digest THEN
    RAISE EXCEPTION 'META_ANALYTICS_NEWER_LEGACY_CAPTURE' USING ERRCODE='MAH04'; END IF;
  -- No verified Instagram cell exists in the current canonical registry. The
  -- CHECK on scalar provenance refuses available values rather than promoting
  -- legacy numbers. The legacy writer still retains its original DTO values.
  v_legacy_receipt:=public.persist_instagram_collection_snapshot(p_job_id,p_claim_token,p_job_generation,p_legacy_payload);
  IF v_kind='owner_account_day' THEN
    SELECT id,period_start,period_end,provider_timezone INTO v_parent,v_since,v_until,v_timezone
    FROM public.ig_account_insight_daily WHERE user_id=v_job.user_id AND social_account_id=v_job.social_account_id AND metric_date=(v_capture.request_identity->>'metric_date')::date;
    v_column:='daily_id';v_window:='day';v_observed:=p_received_at;
  ELSIF v_kind='owner_media' THEN
    SELECT id INTO v_parent FROM public.ig_media_insight_snapshots WHERE user_id=v_job.user_id AND social_account_id=v_job.social_account_id
      AND ig_media_id=v_capture.request_identity->>'media_id' AND captured_on=v_job.captured_on;
    v_column:='post_snapshot_id';v_window:='lifetime';v_observed:=p_received_at;
  ELSE
    v_observed:=(v_item->>'observed_at')::timestamptz;
    IF v_observed<v_capture.requested_at OR v_observed>p_received_at THEN RAISE EXCEPTION 'META_ANALYTICS_INVALID_CAPTURE_TIME' USING ERRCODE='MAH01'; END IF;
    SELECT id INTO v_parent FROM public.ig_account_profile_observations WHERE user_id=v_job.user_id AND social_account_id=v_job.social_account_id AND observed_at=v_observed;
    v_column:='profile_observation_id';v_window:='point_in_time';
  END IF;
  IF v_parent IS NULL THEN RAISE EXCEPTION 'META_ANALYTICS_COMPATIBILITY_WRITE_MISSING' USING ERRCODE='MAH05'; END IF;
  FOR v_key,v_cell IN SELECT * FROM jsonb_each(p_metric_values) ORDER BY key LOOP
    INSERT INTO public.ig_analytics_metric_values(user_id,social_account_id,daily_id,post_snapshot_id,profile_observation_id,metric_key,status,value,reason,
      provider_metric,api_version,window_kind,provider_timezone,window_since,window_until,source_ref,capture_id,observed_at)
    VALUES(v_job.user_id,v_job.social_account_id,CASE WHEN v_column='daily_id' THEN v_parent END,CASE WHEN v_column='post_snapshot_id' THEN v_parent END,
      CASE WHEN v_column='profile_observation_id' THEN v_parent END,v_key,v_cell->>'status',(v_cell->>'value')::bigint,v_cell->>'reason',
      NULL,'v22.0',v_window,v_timezone,v_since,v_until,'instagram_graph_v22',p_capture_id,v_observed)
    ON CONFLICT DO NOTHING;
    -- The account/job fence serializes compatibility writes. Replace exactly
    -- the same typed metric, preserving sibling metrics and capture ownership.
    UPDATE public.ig_analytics_metric_values SET status=v_cell->>'status',value=(v_cell->>'value')::bigint,reason=v_cell->>'reason',capture_id=p_capture_id,observed_at=v_observed,
      provider_timezone=v_timezone,window_since=v_since,window_until=v_until
    WHERE user_id=v_job.user_id AND social_account_id=v_job.social_account_id AND metric_key=v_key
      AND (v_column='daily_id' AND daily_id=v_parent OR v_column='post_snapshot_id' AND post_snapshot_id=v_parent OR v_column='profile_observation_id' AND profile_observation_id=v_parent);
    v_written:=v_written+1;
  END LOOP;
  PERFORM public.ig_collection_assert_lease_live(v_job.lease_expires_at);
  UPDATE public.ig_analytics_report_state SET report_revision=report_revision+1 WHERE user_id=v_job.user_id AND social_account_id=v_job.social_account_id;
  v_receipt:=jsonb_build_object('job_id',p_job_id,'job_generation',p_job_generation,'capture_id',p_capture_id,'written',v_written,'legacy_receipt',v_legacy_receipt);
  UPDATE public.ig_analytics_captures SET received_at=p_received_at,payload_digest=v_digest,receipt=v_receipt WHERE id=p_capture_id;
  RETURN v_receipt;
EXCEPTION WHEN serialization_failure THEN RAISE EXCEPTION 'META_ANALYTICS_STALE_CLAIM' USING ERRCODE='MAH04';
END;
$fn$;

DO $security$
DECLARE v_table text;v_function record;
BEGIN
  FOR v_table IN SELECT tablename FROM pg_tables WHERE schemaname='public' AND
    (tablename LIKE 'fb_analytics_%' OR tablename LIKE 'threads_analytics_%' OR tablename LIKE 'ig_analytics_%'
      OR tablename IN ('fb_page_insight_daily','fb_post_insight_snapshots','fb_page_profile_observations',
        'threads_account_insight_daily','threads_post_insight_snapshots','threads_account_profile_observations')) LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',v_table);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,anon,authenticated,service_role',v_table);
    EXECUTE format('GRANT SELECT ON public.%I TO service_role',v_table);
  END LOOP;
  FOR v_function IN SELECT p.oid::regprocedure AS identity,p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'
    AND (p.proname LIKE 'meta_analytics_%' OR p.proname LIKE 'fb_analytics_%' OR p.proname LIKE 'threads_analytics_%' OR p.proname LIKE 'ig_analytics_%'
      OR p.proname ~ '^(prepare|observe|enqueue|claim|read|checkpoint|reserve|persist|complete|cleanup)_(fb|threads|ig)_analytics_') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',v_function.identity);
    IF v_function.proname ~ '^(prepare|observe|enqueue|claim|read|checkpoint|reserve|persist|complete|cleanup)_(fb|threads|ig)_analytics_' THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',v_function.identity);
    END IF;
    IF v_function.proname IN ('read_fb_analytics_history','read_threads_analytics_history','meta_analytics_fb_guarded') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated,service_role',v_function.identity);
    END IF;
  END LOOP;
END;
$security$;
COMMIT;
