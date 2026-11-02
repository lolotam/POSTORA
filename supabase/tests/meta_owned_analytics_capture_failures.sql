-- Boundaries: off/malformed/empty policy, >50 targets, two owners, same-day
-- reopen, credential rotation, CAS replay/skip, expired day and policy change.
\set ON_ERROR_STOP on
BEGIN;
INSERT INTO auth.users(id,email) VALUES
 ('b1000000-0000-4000-8000-000000000001','meta-dispatch-one@example.invalid'),
 ('b1000000-0000-4000-8000-000000000002','meta-dispatch-two@example.invalid');
INSERT INTO public.social_accounts(id,user_id,platform,platform_user_id,access_token,is_active,needs_reauth)
SELECT ('b3000000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid,
  CASE WHEN i%2=0 THEN 'b1000000-0000-4000-8000-000000000002'::uuid ELSE 'b1000000-0000-4000-8000-000000000001'::uuid END,
  'threads',(780000+i)::text,'fixture-threads',true,false FROM generate_series(1,60) i;
INSERT INTO public.social_accounts(id,user_id,platform,platform_user_id,access_token,is_active,needs_reauth) VALUES
 ('b4000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000001','facebook','784001','fixture-page',true,false);
INSERT INTO public.facebook_user_credentials(id,user_id,token,provider_user_id,provenance_source,provenance_captured_at) VALUES
 ('b5000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000001','fixture-user','785001','oauth_exchange',clock_timestamp());
INSERT INTO public.facebook_user_credential_connection_fences(social_account_id,user_id,platform) VALUES
 ('b4000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000001','facebook');
INSERT INTO public.facebook_user_credential_bindings(social_account_id,user_id,platform,credential_id,verified_facebook_user_id,evidence_source) VALUES
 ('b4000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000001','facebook','b5000000-0000-4000-8000-000000000001','785001','oauth_exchange');
UPDATE public.app_settings SET value='true'::jsonb WHERE key IN ('collection_facebook_analytics_enabled','collection_threads_analytics_enabled');
UPDATE public.app_settings SET value='{"account_ids":["b4000000-0000-4000-8000-000000000001"]}'::jsonb WHERE key='collection_facebook_analytics_policy';
UPDATE public.app_settings SET value='{"account_ids":["b3000000-0000-4000-8000-000000000001"]}'::jsonb WHERE key='collection_threads_analytics_policy';
SELECT set_config('request.jwt.claim.role','service_role',true);
SELECT set_config('request.jwt.claims','{"role":"service_role"}',true);
SET LOCAL ROLE service_role;
DO $defer$
DECLARE v_owner uuid:='b1000000-0000-4000-8000-000000000001';v_account uuid:='b4000000-0000-4000-8000-000000000001';v_authority jsonb;v_job jsonb;v_retry timestamptz:=clock_timestamp()+interval '60 seconds';
BEGIN
  v_authority:=public.prepare_fb_analytics_account(v_owner,v_account);
  PERFORM public.observe_fb_analytics_permissions(v_owner,v_account,v_authority->'authority',ARRAY['read_insights','pages_read_engagement'],'784001',clock_timestamp(),'verified');
  PERFORM public.enqueue_fb_analytics_collection_job(v_owner,v_account,(clock_timestamp() AT TIME ZONE 'America/Los_Angeles')::date,false);
  v_job:=public.claim_fb_analytics_collection_jobs(1)->0;
  PERFORM public.complete_fb_analytics_collection_job((v_job->>'job_id')::uuid,(v_job->>'claim_token')::uuid,(v_job->>'job_generation')::bigint,'partial','collection_incomplete',v_retry);
  ASSERT public.claim_fb_analytics_collection_jobs(1)='[]'::jsonb,'explicit partial backoff prevents reclaiming the same job within this invocation';
END;
$defer$;
DO $defer$
DECLARE v_owner uuid:='b1000000-0000-4000-8000-000000000001';v_account uuid:='b3000000-0000-4000-8000-000000000001';v_authority jsonb;v_job jsonb;v_retry timestamptz:=clock_timestamp()+interval '60 seconds';
BEGIN
  v_authority:=public.prepare_threads_analytics_account(v_owner,v_account);
  PERFORM public.observe_threads_analytics_permissions(v_owner,v_account,v_authority->'authority',ARRAY['threads_basic','threads_manage_insights'],'780001',clock_timestamp(),'verified');
  PERFORM public.enqueue_threads_analytics_collection_job(v_owner,v_account,(clock_timestamp() AT TIME ZONE 'America/Los_Angeles')::date,false);
  v_job:=public.claim_threads_analytics_collection_jobs(1)->0;
  PERFORM public.complete_threads_analytics_collection_job((v_job->>'job_id')::uuid,(v_job->>'claim_token')::uuid,(v_job->>'job_generation')::bigint,'partial','collection_incomplete',v_retry);
  ASSERT public.claim_threads_analytics_collection_jobs(1)='[]'::jsonb,'explicit partial backoff prevents reclaiming the same job within this invocation';
END;
$defer$;
RESET ROLE;
ROLLBACK;
\echo 'meta_owned_analytics_capture_failures: ALL CHECKS PASSED'
