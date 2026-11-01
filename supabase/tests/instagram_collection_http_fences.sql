-- Real database contracts for the non-retrying collection HTTP boundary.
-- Native callers keep 40001; service-only HTTP wrappers return PT409, while
-- ownership/missing-resource errors and the accepted write fences remain intact.
\set ON_ERROR_STOP on
BEGIN;

DO $grants$
DECLARE signature text; wrapper regprocedure;
BEGIN
  FOREACH signature IN ARRAY ARRAY[
    'public.persist_instagram_collection_snapshot_http(uuid,uuid,bigint,jsonb)',
    'public.record_instagram_collection_job_progress_http(uuid,uuid,bigint,jsonb)',
    'public.complete_instagram_collection_job_http(uuid,uuid,bigint,text,text)',
    'public.record_instagram_provider_throttle_http(text,integer,timestamptz,uuid,uuid,bigint)',
    'public.read_instagram_direct_collection_credential_http(uuid,uuid,bigint,bigint)'
  ] LOOP
    wrapper := signature::regprocedure;
    ASSERT has_function_privilege('service_role',wrapper,'EXECUTE'), 'service role must reach ' || signature;
    ASSERT NOT has_function_privilege('anon',wrapper,'EXECUTE'), 'anonymous must not reach ' || signature;
    ASSERT NOT has_function_privilege('authenticated',wrapper,'EXECUTE'), 'browser must not reach ' || signature;
    ASSERT NOT EXISTS(SELECT 1 FROM pg_proc p, LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a
      WHERE p.oid=wrapper AND a.grantee=0 AND a.privilege_type='EXECUTE'), 'PUBLIC execute must be revoked';
    ASSERT (SELECT NOT prosecdef AND provolatile='v' FROM pg_proc WHERE oid=wrapper), 'wrappers must retain invoker privileges and volatility';
  END LOOP;
END $grants$;

INSERT INTO auth.users(id,email) VALUES ('f1110000-0000-4000-8000-000000000001','http-fence-owner@example.invalid');
INSERT INTO public.social_accounts(id,user_id,platform,platform_user_id,platform_username,access_token,ig_auth_type,is_active)
VALUES ('f1120000-0000-4000-8000-000000000001','f1110000-0000-4000-8000-000000000001','instagram','ig-http-fence','http_fence','synthetic-http-fence-token','facebook_page',true);
INSERT INTO public.instagram_account_capabilities(social_account_id,user_id,platform,login_kind,permission_read_state,granted_scopes,scopes_read_at,credential_generation)
VALUES ('f1120000-0000-4000-8000-000000000001','f1110000-0000-4000-8000-000000000001','instagram','page_linked','ok',ARRAY['instagram_manage_insights'],now(),1);
INSERT INTO public.app_settings(key,value,description) VALUES
('collection_instagram_insights_enabled','true'::jsonb,'Synthetic HTTP fence fixture'),
('collection_instagram_rollout_policy','{"version":1,"owners":{"mode":"allowlist","account_ids":["f1120000-0000-4000-8000-000000000001"]},"competitors":{"mode":"off","targets":[]}}'::jsonb,'Synthetic HTTP fence fixture')
ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value;

SELECT set_config('request.jwt.claim.role','authenticated',true);
SELECT set_config('request.jwt.claim.sub','f1110000-0000-4000-8000-000000000001',true);
SET LOCAL ROLE authenticated;
SELECT public.enqueue_instagram_collection_job(p_target_kind=>'owner',p_target_id=>'f1120000-0000-4000-8000-000000000001',p_mode=>'normal');
DO $browser_refusal$ BEGIN
  BEGIN
    PERFORM public.persist_instagram_collection_snapshot_http('f1130000-0000-4000-8000-000000000001','f1140000-0000-4000-8000-000000000001',1,'{}');
    RAISE EXCEPTION 'browser unexpectedly reached the HTTP writer';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $browser_refusal$;
RESET ROLE;

CREATE TEMP TABLE http_fence_claim(claim jsonb) ON COMMIT DROP;
GRANT SELECT,INSERT ON http_fence_claim TO service_role;
SELECT set_config('request.jwt.claim.role','service_role',true);
SELECT set_config('request.jwt.claim.sub','',true);
SET LOCAL ROLE service_role;
INSERT INTO http_fence_claim SELECT c FROM public.claim_instagram_collection_jobs('owner',100) c
WHERE c->>'social_account_id'='f1120000-0000-4000-8000-000000000001';

DO $success$
DECLARE c jsonb; receipt jsonb; payload jsonb; claim_arg uuid; generation_arg bigint;
BEGIN
  SELECT claim INTO STRICT c FROM http_fence_claim;
  payload := jsonb_build_object('kind','owner_profile_observation','items',jsonb_build_array(jsonb_build_object('observed_at',now(),'status','ok','metrics',jsonb_build_object('followers_count',42,'media_count',0))));
  receipt := public.persist_instagram_collection_snapshot_http((c->>'job_id')::uuid,(c->>'claim_token')::uuid,(c->>'job_generation')::bigint,payload);
  ASSERT (receipt->>'written')::integer=1, 'HTTP wrapper must execute the real writer';
  FOR claim_arg,generation_arg IN
    SELECT * FROM (VALUES
      ('f1140000-0000-4000-8000-000000000099'::uuid,(c->>'job_generation')::bigint),
      ((c->>'claim_token')::uuid,(c->>'job_generation')::bigint+1)
    ) invalid_claims(token,generation)
  LOOP
    BEGIN
      PERFORM public.persist_instagram_collection_snapshot_http((c->>'job_id')::uuid,claim_arg,generation_arg,payload);
      RAISE EXCEPTION 'wrong claim token or generation was accepted';
    EXCEPTION WHEN SQLSTATE 'PT409' THEN NULL;
    END;
  END LOOP;
END $success$;
RESET ROLE;

UPDATE public.instagram_account_capabilities SET credential_generation=2
WHERE social_account_id='f1120000-0000-4000-8000-000000000001';

SELECT set_config('request.jwt.claim.role','service_role',true);
SET LOCAL ROLE service_role;
DO $stale$
DECLARE c jsonb; statement text; before_rows text; after_rows text;
BEGIN
  SELECT claim INTO STRICT c FROM http_fence_claim;
  SELECT jsonb_agg(to_jsonb(p) ORDER BY p.id)::text INTO before_rows FROM public.ig_account_profile_observations p
  WHERE p.social_account_id='f1120000-0000-4000-8000-000000000001';
  BEGIN
    PERFORM public.persist_instagram_collection_snapshot((c->>'job_id')::uuid,(c->>'claim_token')::uuid,(c->>'job_generation')::bigint,'{}');
    RAISE EXCEPTION 'native stale writer was accepted';
  EXCEPTION WHEN serialization_failure THEN NULL;
  END;
  FOREACH statement IN ARRAY ARRAY[
    'SELECT public.persist_instagram_collection_snapshot_http($1,$2,$3,''{}''::jsonb)',
    'SELECT public.record_instagram_collection_job_progress_http($1,$2,$3,''{}''::jsonb)',
    'SELECT public.complete_instagram_collection_job_http($1,$2,$3,''retry'',''provider_error'')',
    'SELECT public.record_instagram_provider_throttle_http(repeat(''a'',64),40,now()+interval ''1 minute'',$1,$2,$3)',
    'SELECT public.read_instagram_direct_collection_credential_http($1,$2,$3,1)'
  ] LOOP
    BEGIN
      EXECUTE statement USING (c->>'job_id')::uuid,(c->>'claim_token')::uuid,(c->>'job_generation')::bigint;
      RAISE EXCEPTION 'HTTP stale operation was accepted';
    EXCEPTION WHEN SQLSTATE 'PT409' THEN
      ASSERT SQLERRM='IG_COLLECTION_CLAIM_STALE: captured collection context is no longer current', 'refusal must be sanitized';
    END;
  END LOOP;
  SELECT jsonb_agg(to_jsonb(p) ORDER BY p.id)::text INTO after_rows FROM public.ig_account_profile_observations p
  WHERE p.social_account_id='f1120000-0000-4000-8000-000000000001';
  ASSERT before_rows IS NOT DISTINCT FROM after_rows, 'stale operations must preserve history';
  BEGIN
    PERFORM public.persist_instagram_collection_snapshot_http('f1130000-0000-4000-8000-000000000099','f1140000-0000-4000-8000-000000000099',1,'{}');
    RAISE EXCEPTION 'missing job was accepted';
  EXCEPTION WHEN no_data_found THEN NULL;
  END;
END $stale$;
RESET ROLE;
ROLLBACK;
\echo 'ALL CHECKS PASSED'
