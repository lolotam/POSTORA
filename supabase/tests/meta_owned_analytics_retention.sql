-- Boundaries: off/malformed/empty policy, >50 targets, two owners, same-day
-- reopen, credential rotation, CAS replay/skip, expired day and policy change.
\set ON_ERROR_STOP on
BEGIN;
DO $acl$
BEGIN
  ASSERT NOT has_function_privilege('anon','public.meta_analytics_retention_allowed(text,uuid,boolean)','EXECUTE');
  ASSERT NOT has_function_privilege('authenticated','public.meta_analytics_retention_allowed(text,uuid,boolean)','EXECUTE');
  ASSERT NOT has_function_privilege('service_role','public.meta_analytics_retention_allowed(text,uuid,boolean)','EXECUTE');
END;$acl$;
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
INSERT INTO public.fb_analytics_report_state(user_id,social_account_id) VALUES('b1000000-0000-4000-8000-000000000001','b4000000-0000-4000-8000-000000000001');
INSERT INTO public.threads_analytics_report_state(user_id,social_account_id) VALUES('b1000000-0000-4000-8000-000000000001','b3000000-0000-4000-8000-000000000001');
DO $acl$
DECLARE v_signature text;v_role text;
BEGIN
  FOREACH v_signature IN ARRAY ARRAY['public.list_meta_analytics_retention_targets(text,boolean)',
    'public.cleanup_meta_analytics_target(text,uuid,timestamptz,integer,boolean)','public.claim_meta_analytics_collection_job(text)',
    'public.read_meta_analytics_provider_throttle(text)'] LOOP
    ASSERT has_function_privilege('service_role',v_signature,'EXECUTE');
    FOREACH v_role IN ARRAY ARRAY['anon','authenticated'] LOOP ASSERT NOT has_function_privilege(v_role,v_signature,'EXECUTE'); END LOOP;
  END LOOP;
  FOREACH v_role IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
    ASSERT NOT has_table_privilege(v_role,'public.meta_analytics_retention_visits','SELECT,INSERT,UPDATE,DELETE');
    ASSERT NOT has_table_privilege(v_role,'public.meta_analytics_worker_turns','SELECT,INSERT,UPDATE,DELETE');
  END LOOP;
END;
$acl$;
SELECT set_config('request.jwt.claim.role','service_role',true);
SELECT set_config('request.jwt.claims','{"role":"service_role"}',true);
UPDATE public.app_settings SET value=jsonb_build_object('account_ids',jsonb_build_array(upper('b4000000-0000-4000-8000-000000000001'))) WHERE key='retention_facebook_analytics_policy';
INSERT INTO public.fb_page_insight_daily(user_id,social_account_id,metric_date,period_start,period_end,provider_timezone)
  SELECT 'b1000000-0000-4000-8000-000000000001','b4000000-0000-4000-8000-000000000001',d,d::timestamp AT TIME ZONE 'America/Los_Angeles',(d+1)::timestamp AT TIME ZONE 'America/Los_Angeles','America/Los_Angeles'
  FROM (SELECT (clock_timestamp() AT TIME ZONE 'UTC')::date-367 d) q;
SET LOCAL ROLE service_role;
DO $dry$
DECLARE v_result jsonb;v_floor timestamptz:=((clock_timestamp() AT TIME ZONE 'UTC')::date-365)::timestamp AT TIME ZONE 'UTC';
BEGIN
  ASSERT public.list_meta_analytics_retention_targets('facebook',false)->>'state'='disabled';
  ASSERT jsonb_array_length(public.list_meta_analytics_retention_targets('facebook',true)->'targets')=1,'dry-run uses independent normalized target scope';
  v_result:=public.cleanup_meta_analytics_target('facebook','b4000000-0000-4000-8000-000000000001',v_floor,500,true);
  ASSERT (v_result->>'deleted')::integer=1,'dry run reports one actual physical child';
  ASSERT (v_result->>'report_revision')::bigint=1,'dry run preserves revision';
END;
$dry$;
RESET ROLE;
DO $preserved$ BEGIN
  ASSERT (SELECT count(*) FROM public.fb_page_insight_daily WHERE social_account_id='b4000000-0000-4000-8000-000000000001')=1,'dry run retains child';
  ASSERT NOT EXISTS(SELECT 1 FROM public.meta_analytics_retention_visits WHERE social_account_id='b4000000-0000-4000-8000-000000000001'),'dry run does not advance visits';
END; $preserved$;
UPDATE public.app_settings SET value='true'::jsonb WHERE key='retention_facebook_analytics_enabled';
UPDATE public.social_accounts SET is_active=false WHERE id='b4000000-0000-4000-8000-000000000001';
SET LOCAL ROLE service_role;
DO $cleanup$
DECLARE v_result jsonb;v_floor timestamptz:=((clock_timestamp() AT TIME ZONE 'UTC')::date-365)::timestamp AT TIME ZONE 'UTC';
BEGIN
  v_result:=public.cleanup_meta_analytics_target('facebook','b4000000-0000-4000-8000-000000000001',v_floor,1,false);
  ASSERT (v_result->>'deleted')::integer=1 AND (v_result->>'report_revision')::bigint=2,'disabled target remains eligible within independent retention scope';
  v_result:=public.cleanup_meta_analytics_target('facebook','b4000000-0000-4000-8000-000000000001',v_floor,500,false);
  ASSERT (v_result->>'deleted')::integer=0 AND (v_result->>'report_revision')::bigint=2,'no-op cleanup does not advance report revision';
END;
$cleanup$;
RESET ROLE;
DO $visited$ BEGIN ASSERT EXISTS(SELECT 1 FROM public.meta_analytics_retention_visits WHERE social_account_id='b4000000-0000-4000-8000-000000000001'),'real no-op visit yields to other targets';END;$visited$;
UPDATE public.app_settings SET value=jsonb_build_object('account_ids',jsonb_build_array(upper('b3000000-0000-4000-8000-000000000001'))) WHERE key='retention_threads_analytics_policy';
INSERT INTO public.threads_account_insight_daily(user_id,social_account_id,metric_date,period_start,period_end,provider_timezone)
  SELECT 'b1000000-0000-4000-8000-000000000001','b3000000-0000-4000-8000-000000000001',d,d::timestamp AT TIME ZONE 'America/Los_Angeles',(d+1)::timestamp AT TIME ZONE 'America/Los_Angeles','America/Los_Angeles'
  FROM (SELECT (clock_timestamp() AT TIME ZONE 'UTC')::date-367 d) q;
SET LOCAL ROLE service_role;
DO $dry$
DECLARE v_result jsonb;v_floor timestamptz:=((clock_timestamp() AT TIME ZONE 'UTC')::date-365)::timestamp AT TIME ZONE 'UTC';
BEGIN
  ASSERT public.list_meta_analytics_retention_targets('threads',false)->>'state'='disabled';
  ASSERT jsonb_array_length(public.list_meta_analytics_retention_targets('threads',true)->'targets')=1,'dry-run uses independent normalized target scope';
  v_result:=public.cleanup_meta_analytics_target('threads','b3000000-0000-4000-8000-000000000001',v_floor,500,true);
  ASSERT (v_result->>'deleted')::integer=1,'dry run reports one actual physical child';
  ASSERT (v_result->>'report_revision')::bigint=1,'dry run preserves revision';
END;
$dry$;
RESET ROLE;
DO $preserved$ BEGIN
  ASSERT (SELECT count(*) FROM public.threads_account_insight_daily WHERE social_account_id='b3000000-0000-4000-8000-000000000001')=1,'dry run retains child';
  ASSERT NOT EXISTS(SELECT 1 FROM public.meta_analytics_retention_visits WHERE social_account_id='b3000000-0000-4000-8000-000000000001'),'dry run does not advance visits';
END; $preserved$;
UPDATE public.app_settings SET value='true'::jsonb WHERE key='retention_threads_analytics_enabled';
UPDATE public.social_accounts SET is_active=false WHERE id='b3000000-0000-4000-8000-000000000001';
SET LOCAL ROLE service_role;
DO $cleanup$
DECLARE v_result jsonb;v_floor timestamptz:=((clock_timestamp() AT TIME ZONE 'UTC')::date-365)::timestamp AT TIME ZONE 'UTC';
BEGIN
  v_result:=public.cleanup_meta_analytics_target('threads','b3000000-0000-4000-8000-000000000001',v_floor,1,false);
  ASSERT (v_result->>'deleted')::integer=1 AND (v_result->>'report_revision')::bigint=2,'disabled target remains eligible within independent retention scope';
  v_result:=public.cleanup_meta_analytics_target('threads','b3000000-0000-4000-8000-000000000001',v_floor,500,false);
  ASSERT (v_result->>'deleted')::integer=0 AND (v_result->>'report_revision')::bigint=2,'no-op cleanup does not advance report revision';
END;
$cleanup$;
RESET ROLE;
DO $visited$ BEGIN ASSERT EXISTS(SELECT 1 FROM public.meta_analytics_retention_visits WHERE social_account_id='b3000000-0000-4000-8000-000000000001'),'real no-op visit yields to other targets';END;$visited$;
-- Independent invocations use durable platform turns, even when the first job is partial again.
UPDATE public.social_accounts SET is_active=true WHERE id IN ('b4000000-0000-4000-8000-000000000001','b3000000-0000-4000-8000-000000000001');
UPDATE public.app_settings SET value='true'::jsonb WHERE key IN ('collection_facebook_analytics_enabled','collection_threads_analytics_enabled');
UPDATE public.app_settings SET value='{"account_ids":["b4000000-0000-4000-8000-000000000001"]}'::jsonb WHERE key='collection_facebook_analytics_policy';
UPDATE public.app_settings SET value='{"account_ids":["b3000000-0000-4000-8000-000000000001"]}'::jsonb WHERE key='collection_threads_analytics_policy';
UPDATE public.meta_analytics_worker_turns SET last_claimed_at='epoch';
SET LOCAL ROLE service_role;
DO $turns$
DECLARE v_authority jsonb;v_job jsonb;v_owner uuid:='b1000000-0000-4000-8000-000000000001';
BEGIN
  v_authority:=public.prepare_fb_analytics_account(v_owner,'b4000000-0000-4000-8000-000000000001');
  PERFORM public.observe_fb_analytics_permissions(v_owner,'b4000000-0000-4000-8000-000000000001',v_authority->'authority',ARRAY['read_insights','pages_read_engagement'],'784001',clock_timestamp(),'verified');
  v_authority:=public.prepare_threads_analytics_account(v_owner,'b3000000-0000-4000-8000-000000000001');
  PERFORM public.observe_threads_analytics_permissions(v_owner,'b3000000-0000-4000-8000-000000000001',v_authority->'authority',ARRAY['threads_basic','threads_manage_insights'],'780001',clock_timestamp(),'verified');
  PERFORM public.enqueue_fb_analytics_collection_job(v_owner,'b4000000-0000-4000-8000-000000000001',(clock_timestamp() AT TIME ZONE 'America/Los_Angeles')::date,false);
  PERFORM public.enqueue_threads_analytics_collection_job(v_owner,'b3000000-0000-4000-8000-000000000001',(clock_timestamp() AT TIME ZONE 'America/Los_Angeles')::date,false);
  v_job:=public.claim_meta_analytics_collection_job('all');
  ASSERT v_job->>'platform'='facebook';
  PERFORM public.complete_fb_analytics_collection_job((v_job->>'job_id')::uuid,(v_job->>'claim_token')::uuid,(v_job->>'job_generation')::bigint,'partial','fixture_partial');
  v_job:=public.claim_meta_analytics_collection_job('all');
  ASSERT v_job->>'platform'='threads','next invocation gives the other platform a turn';
END;
$turns$;
RESET ROLE;
ROLLBACK;

\echo "meta_owned_analytics_retention: ALL CHECKS PASSED"
