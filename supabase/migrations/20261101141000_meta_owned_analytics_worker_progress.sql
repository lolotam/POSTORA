-- Durable daily enumeration for the platform-owned queues. No activation.
BEGIN;

CREATE FUNCTION public.meta_analytics_collection_policy(p_platform text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path=public,pg_temp AS $fn$
DECLARE v_enabled jsonb;v_policy jsonb;
BEGIN
  IF p_platform IS NULL OR p_platform NOT IN ('facebook','threads') THEN
    RAISE EXCEPTION 'META_ANALYTICS_INVALID_PLATFORM' USING ERRCODE='MAH01'; END IF;
  SELECT value INTO v_enabled FROM public.app_settings WHERE key='collection_'||p_platform||'_analytics_enabled' FOR SHARE;
  IF v_enabled IS NULL OR jsonb_typeof(v_enabled)<>'boolean' THEN
    RAISE EXCEPTION 'META_ANALYTICS_CONFIGURATION_UNAVAILABLE' USING ERRCODE='MAH05'; END IF;
  IF v_enabled='false'::jsonb THEN RETURN jsonb_build_object('state','disabled'); END IF;
  SELECT value INTO v_policy FROM public.app_settings WHERE key='collection_'||p_platform||'_analytics_policy' FOR SHARE;
  IF v_policy IS NULL OR jsonb_typeof(v_policy)<>'object' THEN
    RAISE EXCEPTION 'META_ANALYTICS_CONFIGURATION_UNAVAILABLE' USING ERRCODE='MAH05'; END IF;
  IF (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(v_policy) k) IS DISTINCT FROM ARRAY['account_ids']::text[]
    OR jsonb_typeof(v_policy->'account_ids') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'META_ANALYTICS_CONFIGURATION_UNAVAILABLE' USING ERRCODE='MAH05'; END IF;
  IF jsonb_array_length(v_policy->'account_ids')>100 OR EXISTS(
    SELECT 1 FROM jsonb_array_elements(v_policy->'account_ids') e WHERE jsonb_typeof(e)<>'string'
      OR e#>>'{}' !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$') THEN
    RAISE EXCEPTION 'META_ANALYTICS_CONFIGURATION_UNAVAILABLE' USING ERRCODE='MAH05'; END IF;
  RETURN jsonb_build_object('state','enabled','account_ids',COALESCE((SELECT jsonb_agg(DISTINCT ((e#>>'{}')::uuid)::text ORDER BY ((e#>>'{}')::uuid)::text)
      FROM jsonb_array_elements(v_policy->'account_ids') e),'[]'::jsonb),
    'policy_digest',encode(sha256(convert_to(v_policy::text,'utf8')),'hex'));
END;
$fn$;

-- Preserve fail-closed boolean refusals; UUID spelling does not change identity.
CREATE OR REPLACE FUNCTION public.meta_analytics_collection_allowed(p_platform text,p_account uuid)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path=public,pg_temp AS $fn$
DECLARE v_policy jsonb;
BEGIN
  IF p_platform IS NULL OR p_platform NOT IN ('facebook','threads') OR p_account IS NULL THEN RETURN false; END IF;
  v_policy:=public.meta_analytics_collection_policy(p_platform);
  RETURN v_policy->>'state'='enabled' AND (v_policy->'account_ids') @> jsonb_build_array(p_account::text);
EXCEPTION WHEN SQLSTATE 'MAH05' THEN RETURN false;
END;
$fn$;

-- Global policy enumeration, never tenant measurements or credential storage.
CREATE TABLE public.meta_analytics_enqueue_sweeps (
  platform text NOT NULL CHECK(platform IN ('facebook','threads')),
  due_on date NOT NULL,policy_digest text NOT NULL CHECK(policy_digest ~ '^[a-f0-9]{64}$'),
  dispatch_round bigint NOT NULL DEFAULT 1 CHECK(dispatch_round>0),last_account_id uuid,
  complete boolean NOT NULL DEFAULT false,outcomes jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(outcomes)='object' AND pg_column_size(outcomes)<=65536),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(platform,due_on,policy_digest)
);
ALTER TABLE public.meta_analytics_enqueue_sweeps ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.meta_analytics_enqueue_sweeps FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.meta_analytics_dispatch_next_id(p_policy jsonb,p_after uuid)
RETURNS uuid LANGUAGE sql IMMUTABLE SECURITY INVOKER
SET search_path=public,pg_temp AS $fn$
  SELECT (e#>>'{}')::uuid FROM jsonb_array_elements(p_policy->'account_ids') e
  WHERE p_after IS NULL OR (e#>>'{}')::uuid>p_after ORDER BY 1 LIMIT 1;
$fn$;

CREATE FUNCTION public.next_meta_analytics_dispatch_target(p_platform text,p_start boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=public,pg_temp SET lock_timeout='3s' AS $fn$
DECLARE v_policy jsonb;v_sweep public.meta_analytics_enqueue_sweeps;v_account uuid;
  v_due date:=(clock_timestamp() AT TIME ZONE 'America/Los_Angeles')::date;v_refused integer;
BEGIN
  PERFORM public.meta_analytics_assert_service();
  IF p_start IS NULL THEN RAISE EXCEPTION 'META_ANALYTICS_INVALID_DISPATCH' USING ERRCODE='MAH01'; END IF;
  v_policy:=public.meta_analytics_collection_policy(p_platform);
  IF v_policy->>'state'='disabled' THEN RETURN jsonb_build_object('state','disabled'); END IF;
  IF p_start THEN
    INSERT INTO public.meta_analytics_enqueue_sweeps(platform,due_on,policy_digest)
      VALUES(p_platform,v_due,v_policy->>'policy_digest') ON CONFLICT DO NOTHING;
  END IF;
  SELECT * INTO v_sweep FROM public.meta_analytics_enqueue_sweeps
    WHERE platform=p_platform AND due_on=v_due AND policy_digest=v_policy->>'policy_digest' FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('state','not_started'); END IF;
  IF v_due<>(clock_timestamp() AT TIME ZONE 'America/Los_Angeles')::date THEN
    RAISE EXCEPTION 'META_ANALYTICS_DISPATCH_CHANGED' USING ERRCODE='MAH04'; END IF;
  IF v_sweep.complete AND p_start THEN
    UPDATE public.meta_analytics_enqueue_sweeps SET dispatch_round=dispatch_round+1,last_account_id=NULL,
      complete=false,outcomes='{}',updated_at=clock_timestamp()
      WHERE platform=p_platform AND due_on=v_due AND policy_digest=v_sweep.policy_digest RETURNING * INTO v_sweep;
  END IF;
  v_account:=public.meta_analytics_dispatch_next_id(v_policy,v_sweep.last_account_id);
  IF v_sweep.complete OR v_account IS NULL THEN
    IF NOT v_sweep.complete THEN
      UPDATE public.meta_analytics_enqueue_sweeps SET complete=true,updated_at=clock_timestamp()
        WHERE platform=p_platform AND due_on=v_due AND policy_digest=v_sweep.policy_digest;
    END IF;
    SELECT count(*) INTO v_refused FROM jsonb_each(v_sweep.outcomes) e WHERE e.value->>'outcome'='refused';
    RETURN jsonb_build_object('state','complete','refused_count',v_refused,'round',v_sweep.dispatch_round,'served_at',v_sweep.updated_at);
  END IF;
  RETURN jsonb_build_object('state','target','served_at',v_sweep.updated_at,'ticket',jsonb_build_object('platform',p_platform,'due_on',v_due,
    'policy_digest',v_sweep.policy_digest,'round',v_sweep.dispatch_round,'after_account_id',v_sweep.last_account_id,'account_id',v_account));
END;
$fn$;

CREATE FUNCTION public.commit_meta_analytics_dispatch_target(p_ticket jsonb,p_outcome text DEFAULT 'enqueue',p_reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=public,pg_temp SET lock_timeout='3s' AS $fn$
DECLARE v_platform text;v_due date;v_round bigint;v_account uuid;v_after uuid;v_owner uuid;
  v_policy jsonb;v_sweep public.meta_analytics_enqueue_sweeps;v_prepared jsonb;v_job jsonb;
  v_outcome text:=p_outcome;v_reason text:=p_reason;v_ready boolean;v_complete boolean;v_refused integer;
BEGIN
  PERFORM public.meta_analytics_assert_service();
  IF p_ticket IS NULL OR jsonb_typeof(p_ticket)<>'object' OR pg_column_size(p_ticket)>8192 THEN
    RAISE EXCEPTION 'META_ANALYTICS_INVALID_DISPATCH_TICKET' USING ERRCODE='MAH01'; END IF;
  IF (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_ticket) k) IS DISTINCT FROM
      ARRAY['account_id','after_account_id','due_on','platform','policy_digest','round']::text[]
    OR p_ticket->>'platform' IS NULL OR p_ticket->>'platform' NOT IN ('facebook','threads')
    OR COALESCE(p_ticket->>'policy_digest','') !~ '^[a-f0-9]{64}$'
    OR jsonb_typeof(p_ticket->'round') IS DISTINCT FROM 'number' OR COALESCE(p_ticket->>'round','') !~ '^[1-9][0-9]{0,14}$'
    OR COALESCE(p_ticket->>'due_on','') !~ '^\d{4}-\d{2}-\d{2}$'
    OR COALESCE(p_ticket->>'account_id','') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    OR jsonb_typeof(p_ticket->'after_account_id') NOT IN ('null','string')
    OR p_ticket->>'after_account_id' IS NOT NULL AND p_ticket->>'after_account_id' !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    OR p_outcome IS NULL OR p_outcome NOT IN ('enqueue','refused')
    OR p_outcome='enqueue' AND p_reason IS NOT NULL
    OR p_outcome='refused' AND (p_reason IS NULL OR p_reason NOT IN ('account_unavailable','permission_missing','reauth_required','identity_mismatch','app_mismatch','provider_error','admission_refused')) THEN
    RAISE EXCEPTION 'META_ANALYTICS_INVALID_DISPATCH_TICKET' USING ERRCODE='MAH01'; END IF;
  BEGIN v_due:=(p_ticket->>'due_on')::date;
  EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
    RAISE EXCEPTION 'META_ANALYTICS_INVALID_DISPATCH_TICKET' USING ERRCODE='MAH01'; END;
  v_platform:=p_ticket->>'platform';v_round:=(p_ticket->>'round')::bigint;
  v_account:=(p_ticket->>'account_id')::uuid;v_after:=(p_ticket->>'after_account_id')::uuid;
  -- Parent account first. The sweep reader never waits for an account lock.
  SELECT user_id INTO v_owner FROM public.social_accounts WHERE id=v_account AND platform=v_platform;
  IF v_owner IS NOT NULL THEN PERFORM public.meta_analytics_lock_account(v_account,v_owner,v_platform); END IF;
  v_policy:=public.meta_analytics_collection_policy(v_platform);
  IF v_policy->>'state'<>'enabled' THEN RAISE EXCEPTION 'META_ANALYTICS_COLLECTION_DISABLED' USING ERRCODE='MAH03'; END IF;
  IF v_due<>(clock_timestamp() AT TIME ZONE 'America/Los_Angeles')::date OR v_policy->>'policy_digest' IS DISTINCT FROM p_ticket->>'policy_digest' THEN
    RAISE EXCEPTION 'META_ANALYTICS_DISPATCH_CHANGED' USING ERRCODE='MAH04'; END IF;
  SELECT * INTO v_sweep FROM public.meta_analytics_enqueue_sweeps
    WHERE platform=v_platform AND due_on=v_due AND policy_digest=p_ticket->>'policy_digest' FOR UPDATE;
  IF NOT FOUND OR v_sweep.complete OR v_sweep.dispatch_round<>v_round OR v_sweep.last_account_id IS DISTINCT FROM v_after
    OR public.meta_analytics_dispatch_next_id(v_policy,v_after) IS DISTINCT FROM v_account THEN
    RAISE EXCEPTION 'META_ANALYTICS_DISPATCH_CHANGED' USING ERRCODE='MAH04'; END IF;
  IF v_due<>(clock_timestamp() AT TIME ZONE 'America/Los_Angeles')::date THEN
    RAISE EXCEPTION 'META_ANALYTICS_DISPATCH_CHANGED' USING ERRCODE='MAH04'; END IF;
  IF v_outcome='enqueue' THEN
    IF v_owner IS NULL THEN v_outcome:='refused';v_reason:='account_unavailable';
    ELSE
      BEGIN
        IF v_platform='facebook' THEN
          v_prepared:=public.prepare_fb_analytics_account(v_owner,v_account);
          SELECT EXISTS(SELECT 1 FROM public.fb_analytics_permission_observations WHERE user_id=v_owner AND social_account_id=v_account
            AND authority=v_prepared->'authority' AND state='verified' AND observed_at>=v_due::timestamp AT TIME ZONE 'America/Los_Angeles'
            AND granted_scopes @> ARRAY['read_insights','pages_read_engagement']::text[]) INTO v_ready;
        ELSE
          v_prepared:=public.prepare_threads_analytics_account(v_owner,v_account);
          SELECT EXISTS(SELECT 1 FROM public.threads_analytics_permission_observations WHERE user_id=v_owner AND social_account_id=v_account
            AND authority=v_prepared->'authority' AND state='verified' AND observed_at>=v_due::timestamp AT TIME ZONE 'America/Los_Angeles'
            AND granted_scopes @> ARRAY['threads_basic','threads_manage_insights']::text[]) INTO v_ready;
        END IF;
        IF NOT v_ready THEN
          IF v_due<>(clock_timestamp() AT TIME ZONE 'America/Los_Angeles')::date THEN
            RAISE EXCEPTION 'META_ANALYTICS_DISPATCH_CHANGED' USING ERRCODE='MAH04'; END IF;
          RETURN jsonb_build_object('state','needs_admission');
        END IF;
        IF v_platform='facebook' THEN v_job:=public.enqueue_fb_analytics_collection_job(v_owner,v_account,v_due,false);
        ELSE v_job:=public.enqueue_threads_analytics_collection_job(v_owner,v_account,v_due,false); END IF;
        v_outcome:='queued';
      EXCEPTION WHEN SQLSTATE 'MAH02' OR SQLSTATE 'MAH03' THEN v_outcome:='refused';v_reason:='admission_refused'; END;
    END IF;
  END IF;
  IF v_due<>(clock_timestamp() AT TIME ZONE 'America/Los_Angeles')::date THEN
    RAISE EXCEPTION 'META_ANALYTICS_DISPATCH_CHANGED' USING ERRCODE='MAH04'; END IF;
  v_complete:=public.meta_analytics_dispatch_next_id(v_policy,v_account) IS NULL;
  UPDATE public.meta_analytics_enqueue_sweeps SET last_account_id=v_account,complete=v_complete,updated_at=clock_timestamp(),
    outcomes=outcomes||jsonb_build_object(v_account::text,jsonb_build_object('outcome',v_outcome,'reason',v_reason,'job_id',v_job->'job_id'))
    WHERE platform=v_platform AND due_on=v_due AND policy_digest=v_sweep.policy_digest RETURNING * INTO v_sweep;
  SELECT count(*) INTO v_refused FROM jsonb_each(v_sweep.outcomes) e WHERE e.value->>'outcome'='refused';
  RETURN jsonb_build_object('state','advanced','outcome',v_outcome,'complete',v_complete,'refused_count',v_refused);
END;
$fn$;

REVOKE ALL ON FUNCTION public.meta_analytics_collection_policy(text) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.meta_analytics_dispatch_next_id(jsonb,uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.next_meta_analytics_dispatch_target(text,boolean) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.commit_meta_analytics_dispatch_target(jsonb,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.next_meta_analytics_dispatch_target(text,boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.commit_meta_analytics_dispatch_target(jsonb,text,text) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
