-- Real admission reads must not bypass rollout or captured credential authority.
\set ON_ERROR_STOP on
BEGIN;
INSERT INTO auth.users(id,email) VALUES
 ('81000000-0000-4000-8000-000000000001','meta-admission-one@example.invalid'),
 ('81000000-0000-4000-8000-000000000002','meta-admission-two@example.invalid');
INSERT INTO public.social_accounts(id,user_id,platform,platform_user_id,access_token,is_active,needs_reauth) VALUES
 ('82000000-0000-4000-8000-000000000001','81000000-0000-4000-8000-000000000001','facebook','882001','synthetic-page',true,false),
 ('82000000-0000-4000-8000-000000000002','81000000-0000-4000-8000-000000000002','facebook','882002','synthetic-foreign',true,false),
 ('83000000-0000-4000-8000-000000000001','81000000-0000-4000-8000-000000000001','threads','883001','synthetic-threads',true,false);
INSERT INTO public.facebook_user_credentials(id,user_id,token,provider_user_id,provenance_source,provenance_captured_at) VALUES
 ('85000000-0000-4000-8000-000000000001','81000000-0000-4000-8000-000000000001','synthetic-user','881001','oauth_exchange',clock_timestamp());
INSERT INTO public.facebook_user_credential_connection_fences(social_account_id,user_id,platform) VALUES
 ('82000000-0000-4000-8000-000000000001','81000000-0000-4000-8000-000000000001','facebook');
INSERT INTO public.facebook_user_credential_bindings(social_account_id,user_id,platform,credential_id,verified_facebook_user_id,evidence_source) VALUES
 ('82000000-0000-4000-8000-000000000001','81000000-0000-4000-8000-000000000001','facebook','85000000-0000-4000-8000-000000000001','881001','oauth_exchange');

DO $acl$
DECLARE v_signature text;v_role text;
BEGIN
  FOREACH v_signature IN ARRAY ARRAY['public.read_fb_analytics_admission_credential(uuid,jsonb)',
    'public.read_threads_analytics_admission_credential(uuid,jsonb)'] LOOP
    ASSERT has_function_privilege('service_role',v_signature,'EXECUTE'),'service admission read is granted';
    FOREACH v_role IN ARRAY ARRAY['anon','authenticated'] LOOP
      ASSERT NOT has_function_privilege(v_role,v_signature,'EXECUTE'),'browser admission read is denied';
    END LOOP;
  END LOOP;
END;
$acl$;
SELECT set_config('request.jwt.claim.role','service_role',true);
SELECT set_config('request.jwt.claims','{"role":"service_role"}',true);
SET LOCAL ROLE service_role;
DO $off$
BEGIN
  BEGIN
    PERFORM public.read_fb_analytics_admission_credential('82000000-0000-4000-8000-000000000001',NULL);
    RAISE EXCEPTION 'disabled admission returned a credential';
  EXCEPTION WHEN SQLSTATE 'MAH03' THEN NULL; END;
END;
$off$;
RESET ROLE;
UPDATE public.app_settings SET value='true'::jsonb WHERE key IN ('collection_facebook_analytics_enabled','collection_threads_analytics_enabled');
UPDATE public.app_settings SET value='{"account_ids":["82000000-0000-4000-8000-000000000001"]}'::jsonb WHERE key='collection_facebook_analytics_policy';
UPDATE public.app_settings SET value='{"account_ids":["83000000-0000-4000-8000-000000000001"]}'::jsonb WHERE key='collection_threads_analytics_policy';
SELECT set_config('test.admission_settings_hash',
  (SELECT md5(string_agg(key||value::text,'|' ORDER BY key)) FROM public.app_settings),true);
SELECT set_config('test.admission_cron_hash',
  (SELECT md5(COALESCE(string_agg(to_jsonb(j)::text,'|' ORDER BY jobid),'')) FROM cron.job j),true);
SET LOCAL ROLE service_role;
DO $admission$
DECLARE v_page jsonb;v_threads jsonb;v_again jsonb;
BEGIN
  v_page:=public.read_fb_analytics_admission_credential('82000000-0000-4000-8000-000000000001',NULL);
  ASSERT v_page->>'user_id'='81000000-0000-4000-8000-000000000001','owner is derived from the account';
  ASSERT v_page->>'access_token'='synthetic-page' AND v_page->>'permission_token'='synthetic-user','Page and User tokens keep separate roles';
  ASSERT v_page#>>'{authority,provider_user_id}'='881001' AND v_page#>>'{authority,platform_user_id}'='882001','both identities remain captured';
  v_again:=public.read_fb_analytics_admission_credential('82000000-0000-4000-8000-000000000001',v_page->'authority');
  ASSERT v_again->'authority'=v_page->'authority','unchanged authority is reusable';
  BEGIN
    PERFORM public.read_fb_analytics_admission_credential('82000000-0000-4000-8000-000000000001','{}');
    RAISE EXCEPTION 'partial authority passed';
  EXCEPTION WHEN SQLSTATE 'MAH04' THEN NULL; END;
  BEGIN
    PERFORM public.read_fb_analytics_admission_credential('82000000-0000-4000-8000-000000000002',NULL);
    RAISE EXCEPTION 'excluded foreign account returned a credential';
  EXCEPTION WHEN SQLSTATE 'MAH03' THEN NULL; END;
  BEGIN
    PERFORM public.read_threads_analytics_admission_credential('82000000-0000-4000-8000-000000000001',NULL);
    RAISE EXCEPTION 'cross-platform account returned a credential';
  EXCEPTION WHEN SQLSTATE 'MAH02' THEN NULL; END;
  v_threads:=public.read_threads_analytics_admission_credential('83000000-0000-4000-8000-000000000001',NULL);
  ASSERT v_threads->>'access_token'='synthetic-threads' AND v_threads->>'permission_token'='synthetic-threads','Threads has one operational grant';
  ASSERT (v_threads#>>'{authority,credential_generation}')::bigint>0,'Threads receives its real C2 epoch';
  UPDATE public.social_accounts SET access_token='synthetic-threads-rotated' WHERE id='83000000-0000-4000-8000-000000000001';
  BEGIN
    PERFORM public.read_threads_analytics_admission_credential('83000000-0000-4000-8000-000000000001',v_threads->'authority');
    RAISE EXCEPTION 'rotated Threads authority passed';
  EXCEPTION WHEN SQLSTATE 'MAH04' THEN NULL; END;
END;
$admission$;
RESET ROLE;
DO $effects$
BEGIN
  ASSERT current_setting('test.admission_settings_hash')=(SELECT md5(string_agg(key||value::text,'|' ORDER BY key)) FROM public.app_settings),'admission preserved all settings';
  ASSERT current_setting('test.admission_cron_hash')=(SELECT md5(COALESCE(string_agg(to_jsonb(j)::text,'|' ORDER BY jobid),'')) FROM cron.job j),'admission preserved all cron definitions';
  ASSERT (SELECT count(*)=0 FROM public.fb_analytics_collection_jobs WHERE user_id='81000000-0000-4000-8000-000000000001'),'admission did not enqueue';
  ASSERT (SELECT count(*)=0 FROM public.threads_analytics_collection_jobs WHERE user_id='81000000-0000-4000-8000-000000000001'),'Threads admission did not enqueue';
  ASSERT (SELECT count(*)=0 FROM public.fb_analytics_permission_observations WHERE user_id='81000000-0000-4000-8000-000000000001'),'reader did not invent permissions';
  ASSERT (SELECT access_token='synthetic-page' FROM public.social_accounts WHERE id='82000000-0000-4000-8000-000000000001'),'reader preserved operational token';
  ASSERT (SELECT token='synthetic-user' AND revision=1 FROM public.facebook_user_credentials WHERE id='85000000-0000-4000-8000-000000000001'),'reader preserved protected token and revision';
  UPDATE public.facebook_user_credentials SET token_expires_at=clock_timestamp()-interval '1 second'
    WHERE id='85000000-0000-4000-8000-000000000001';
  BEGIN
    PERFORM public.read_fb_analytics_admission_credential('82000000-0000-4000-8000-000000000001',NULL);
    RAISE EXCEPTION 'expired protected User token passed admission';
  EXCEPTION WHEN SQLSTATE 'MAH03' THEN NULL; END;
END;
$effects$;
ROLLBACK;
\echo ALL CHECKS PASSED: owned analytics worker admission
