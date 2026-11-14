-- Real migrated SQL; synthetic secrets are generated, never printed. No provider/network calls.
BEGIN;
SET LOCAL request.jwt.claim.role='service_role';
SELECT set_config('request.jwt.claims','{"role":"service_role"}',true);

DO $grants$
DECLARE relation text;signature regprocedure;
BEGIN
 FOREACH relation IN ARRAY ARRAY['analytics_legacy_bootstrap_jobs','analytics_legacy_bootstrap_epochs',
  'analytics_legacy_bootstrap_receipts','analytics_legacy_bootstrap_audit','analytics_legacy_bootstrap_run'] LOOP
  ASSERT (SELECT relrowsecurity FROM pg_class WHERE oid=('public.'||relation)::regclass);
  ASSERT NOT has_table_privilege('anon','public.'||relation,'SELECT');
  ASSERT NOT has_table_privilege('authenticated','public.'||relation,'SELECT');
  ASSERT NOT has_table_privilege('service_role','public.'||relation,'INSERT');
 END LOOP;
 FOR signature IN SELECT oid::regprocedure FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE '%analytics_legacy_bootstrap%' LOOP
  ASSERT NOT has_function_privilege('authenticated',signature,'EXECUTE');
  ASSERT NOT has_function_privilege('anon',signature,'EXECUTE');
 END LOOP;
 ASSERT (SELECT value='false'::jsonb FROM public.app_settings WHERE key='analytics_legacy_bootstrap_enabled');
 ASSERT NOT EXISTS(SELECT 1 FROM cron.job WHERE jobname='analytics-legacy-bootstrap-drain' AND active);
END;
$grants$;

INSERT INTO auth.users(id,email) VALUES('ab030000-0000-4000-8000-000000000001','bootstrap-a@example.invalid'),
 ('ab030000-0000-4000-8000-000000000002','bootstrap-b@example.invalid');
INSERT INTO public.social_accounts(id,user_id,platform,platform_user_id,platform_username,access_token,account_metadata,ig_auth_type) VALUES
 ('ab030000-0000-4000-8000-000000000011','ab030000-0000-4000-8000-000000000001','facebook','100001','page',gen_random_uuid()::text,
  jsonb_build_object('user_token',gen_random_uuid()::text),NULL),
 ('ab030000-0000-4000-8000-000000000012','ab030000-0000-4000-8000-000000000001','instagram','178001','instagram',gen_random_uuid()::text,
  '{"facebook_page_id":"100001"}','facebook_page'),
 ('ab030000-0000-4000-8000-000000000013','ab030000-0000-4000-8000-000000000001','instagram','178002','direct',gen_random_uuid()::text,
  '{}','business_login'),
 ('ab030000-0000-4000-8000-000000000014','ab030000-0000-4000-8000-000000000002','facebook','100003','foreign',gen_random_uuid()::text,
  jsonb_build_object('user_token',gen_random_uuid()::text),NULL);

CREATE FUNCTION pg_temp.bootstrap_policy(ids uuid[]) RETURNS void LANGUAGE plpgsql AS $fn$
BEGIN
 UPDATE public.app_settings SET value='true' WHERE key='analytics_legacy_bootstrap_enabled';
 UPDATE public.app_settings SET value=jsonb_build_object('version',1,'account_ids',ids,'max_accounts_per_run',5,'max_attempts_per_account_per_day',3)
  WHERE key='analytics_legacy_bootstrap_policy';
 UPDATE public.analytics_legacy_bootstrap_run SET lease_until=NULL,pause_until=NULL;
END;
$fn$;
CREATE FUNCTION pg_temp.bootstrap_begin(account_id uuid) RETURNS jsonb LANGUAGE plpgsql AS $fn$
DECLARE run_id uuid:=gen_random_uuid();
BEGIN
 PERFORM pg_temp.bootstrap_policy(ARRAY[account_id]);
 PERFORM public.dispatch_analytics_legacy_bootstrap(run_id);
 RETURN public.begin_analytics_legacy_bootstrap(account_id,gen_random_uuid(),run_id);
END;
$fn$;
CREATE FUNCTION pg_temp.bootstrap_evidence(capture jsonb) RETURNS jsonb LANGUAGE sql AS $fn$
 SELECT jsonb_build_object('app_id','200001','provider_user_id',CASE WHEN capture->'capture'->>'login_kind'='direct' THEN '178002' ELSE '300001' END,
  'page_id',capture->'capture'->>'page_id','instagram_user_id',CASE WHEN capture->'capture'->>'platform'='instagram' THEN capture->'capture'->>'platform_user_id' END,
  'token_type','USER','verified_at',clock_timestamp(),'expires_at',clock_timestamp()+interval '1 hour');
$fn$;
CREATE FUNCTION pg_temp.bootstrap_commit(capture jsonb) RETURNS jsonb LANGUAGE plpgsql AS $fn$
BEGIN
 PERFORM public.permit_analytics_legacy_bootstrap((capture->>'run_id')::uuid,(capture->>'job_id')::uuid,(capture->>'lease_id')::uuid,(capture->>'revision')::bigint,'200001');
 RETURN public.commit_analytics_legacy_bootstrap((capture->>'job_id')::uuid,(capture->>'lease_id')::uuid,(capture->>'revision')::bigint,pg_temp.bootstrap_evidence(capture));
END;
$fn$;

DO $policy$
DECLARE policy jsonb;result jsonb;run_id uuid:=gen_random_uuid();
BEGIN
 ASSERT public.dispatch_analytics_legacy_bootstrap(run_id)->>'status'='disabled';
 PERFORM pg_temp.bootstrap_policy('{}');
 ASSERT public.dispatch_analytics_legacy_bootstrap(run_id)->'account_ids'='[]'::jsonb;
 FOREACH policy IN ARRAY ARRAY[
  '{"version":1,"account_ids":[],"max_accounts_per_run":6,"max_attempts_per_account_per_day":3}'::jsonb,
  '{"version":1,"account_ids":[],"max_accounts_per_run":5,"max_attempts_per_account_per_day":4}'::jsonb,
  '{"version":1,"account_ids":[],"max_accounts_per_run":5,"max_attempts_per_account_per_day":3,"extra":1}'::jsonb,
  '{"version":1,"account_ids":["ab030000-0000-4000-8000-000000000012","ab030000-0000-4000-8000-000000000012"],"max_accounts_per_run":5,"max_attempts_per_account_per_day":3}'::jsonb] LOOP
  UPDATE public.app_settings SET value=policy WHERE key='analytics_legacy_bootstrap_policy';
  result:=public.dispatch_analytics_legacy_bootstrap(run_id);
  ASSERT result->>'status'='settings_unavailable';
 END LOOP;
END;
$policy$;

DO $stale$
DECLARE capture jsonb;result jsonb;scenario text;account_id uuid:='ab030000-0000-4000-8000-000000000012';
BEGIN
 -- These commits occur between capture and install, exactly as during network verification.
 FOREACH scenario IN ARRAY ARRAY['token_without_timestamp','disconnect','identity','capability_aba','fence_aba','expired_lease'] LOOP
  capture:=pg_temp.bootstrap_begin(account_id);
  ASSERT capture->>'state'='verifying','capture must precede network';
  CASE scenario
   WHEN 'token_without_timestamp' THEN UPDATE public.social_accounts SET account_metadata=jsonb_set(account_metadata,'{user_token}',to_jsonb(gen_random_uuid()::text))
    WHERE id='ab030000-0000-4000-8000-000000000011';
   WHEN 'disconnect' THEN UPDATE public.social_accounts SET is_active=false WHERE id=account_id;
   WHEN 'identity' THEN UPDATE public.social_accounts SET platform_user_id='178099' WHERE id=account_id;
   WHEN 'capability_aba' THEN
    INSERT INTO public.instagram_account_capabilities(social_account_id,user_id,login_kind) VALUES(account_id,'ab030000-0000-4000-8000-000000000001','page_linked');
    DELETE FROM public.instagram_account_capabilities WHERE social_account_id=account_id;
   WHEN 'fence_aba' THEN
    PERFORM public.facebook_user_credential_allocate_connection_version(account_id,'ab030000-0000-4000-8000-000000000001','instagram');
    DELETE FROM public.facebook_user_credential_connection_fences WHERE social_account_id=account_id;
   WHEN 'expired_lease' THEN UPDATE public.analytics_legacy_bootstrap_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE social_account_id=account_id;
  END CASE;
  result:=pg_temp.bootstrap_commit(capture);
  ASSERT result->>'reason_code'='stale_capture',scenario||' must refuse';
  ASSERT NOT EXISTS(SELECT 1 FROM public.facebook_user_credential_bindings WHERE social_account_id=account_id);
  DELETE FROM public.analytics_legacy_bootstrap_jobs WHERE social_account_id=account_id;
  UPDATE public.social_accounts SET is_active=true,platform_user_id='178001' WHERE id=account_id;
 END LOOP;
END;
$stale$;

DO $install$
DECLARE capture jsonb;installed jsonb;reconciled jsonb;permissions jsonb;credential uuid;page_token text;
BEGIN
 SELECT access_token INTO page_token FROM public.social_accounts WHERE id='ab030000-0000-4000-8000-000000000012';
 -- Generation zero must become positive without a fabricated OAuth attempt.
 INSERT INTO public.instagram_account_capabilities(social_account_id,user_id,login_kind)
  VALUES('ab030000-0000-4000-8000-000000000012','ab030000-0000-4000-8000-000000000001','page_linked');
 capture:=pg_temp.bootstrap_begin('ab030000-0000-4000-8000-000000000012');
 installed:=pg_temp.bootstrap_commit(capture);
 ASSERT installed->>'state'='permission_pending';
 ASSERT (SELECT credential_generation=1 AND permission_read_state='unknown' FROM public.instagram_account_capabilities WHERE social_account_id='ab030000-0000-4000-8000-000000000012');
 ASSERT (SELECT access_token=page_token FROM public.social_accounts WHERE id='ab030000-0000-4000-8000-000000000012');
 ASSERT public.analytics_bootstrap_binding_verified('ab030000-0000-4000-8000-000000000012');
 SELECT credential_id INTO credential FROM public.facebook_user_credential_bindings WHERE social_account_id='ab030000-0000-4000-8000-000000000012';
 ASSERT (SELECT provenance_source='verified_legacy_bootstrap' FROM public.facebook_user_credentials WHERE id=credential);
 -- Lost response: reconcile by the durable idempotency key, never create/install again.
 SELECT public.reconcile_analytics_legacy_bootstrap('ab030000-0000-4000-8000-000000000012',idempotency_key) INTO reconciled
  FROM public.analytics_legacy_bootstrap_jobs WHERE social_account_id='ab030000-0000-4000-8000-000000000012';
 ASSERT reconciled=installed;
 ASSERT NOT reconciled ? 'capture' AND NOT reconciled ? 'input_fence';
 ASSERT (SELECT count(*)=1 FROM public.analytics_legacy_bootstrap_receipts WHERE job_id=(capture->>'job_id')::uuid);
 permissions:=jsonb_build_object('state','failed','scopes','[]'::jsonb,'observed_at',clock_timestamp());
 installed:=public.complete_analytics_legacy_bootstrap((capture->>'job_id')::uuid,(capture->>'lease_id')::uuid,(installed->>'revision')::bigint,permissions);
 ASSERT installed->>'state'='permission_pending';
 ASSERT (SELECT permission_read_state='failed' AND scopes_read_at IS NULL FROM public.instagram_account_capabilities WHERE social_account_id='ab030000-0000-4000-8000-000000000012');
 UPDATE public.analytics_legacy_bootstrap_jobs SET retry_at=NULL WHERE social_account_id='ab030000-0000-4000-8000-000000000012';
 capture:=pg_temp.bootstrap_begin('ab030000-0000-4000-8000-000000000012');
 permissions:=jsonb_build_object('state','ok','scopes','[]'::jsonb,'observed_at',clock_timestamp());
 installed:=public.complete_analytics_legacy_bootstrap((capture->>'job_id')::uuid,(capture->>'lease_id')::uuid,(capture->>'revision')::bigint,permissions);
 ASSERT installed->>'state'='permissions_missing','a complete empty read is authoritative missing permission';
 ASSERT NOT EXISTS(SELECT 1 FROM public.instagram_collection_jobs WHERE social_account_id='ab030000-0000-4000-8000-000000000012');
END;
$install$;

DO $live_authority_fence$
BEGIN
 BEGIN
  UPDATE public.facebook_user_credential_connection_fences SET connection_version=connection_version+1
   WHERE social_account_id='ab030000-0000-4000-8000-000000000012';
  ASSERT NOT public.analytics_bootstrap_binding_verified('ab030000-0000-4000-8000-000000000012');
  BEGIN
   PERFORM public.read_facebook_user_account_credential('ab030000-0000-4000-8000-000000000001','ab030000-0000-4000-8000-000000000012');
   RAISE EXCEPTION 'a receipt alone must not expose a credential after the live connection fence moved';
  EXCEPTION WHEN SQLSTATE 'FUC03' THEN NULL; END;
  RAISE EXCEPTION 'roll back only this deliberate fence corruption' USING ERRCODE='TST01';
 EXCEPTION WHEN SQLSTATE 'TST01' THEN NULL; END;
 ASSERT public.analytics_bootstrap_binding_verified('ab030000-0000-4000-8000-000000000012');
END;
$live_authority_fence$;

DO $direct_and_facebook$
DECLARE capture jsonb;installed jsonb;result jsonb;target uuid;
BEGIN
 FOREACH target IN ARRAY ARRAY['ab030000-0000-4000-8000-000000000013'::uuid,'ab030000-0000-4000-8000-000000000011'::uuid] LOOP
  capture:=pg_temp.bootstrap_begin(target);
  installed:=pg_temp.bootstrap_commit(capture);
  ASSERT installed->>'state'='permission_pending';
  result:=public.complete_analytics_legacy_bootstrap((capture->>'job_id')::uuid,(capture->>'lease_id')::uuid,(installed->>'revision')::bigint,
   jsonb_build_object('state','ok','scopes',CASE WHEN target='ab030000-0000-4000-8000-000000000013' THEN
    '["instagram_business_manage_insights"]'::jsonb ELSE '["pages_read_engagement","read_insights"]'::jsonb END,'observed_at',clock_timestamp()));
  ASSERT result->>'state'='ready';
 END LOOP;
 ASSERT NOT EXISTS(SELECT 1 FROM public.facebook_user_credential_bindings WHERE social_account_id='ab030000-0000-4000-8000-000000000013');
 ASSERT public.meta_analytics_current_authority('facebook','ab030000-0000-4000-8000-000000000011','ab030000-0000-4000-8000-000000000001') IS NOT NULL;
 ASSERT NOT public.meta_analytics_collection_allowed('facebook','ab030000-0000-4000-8000-000000000011');
 ASSERT NOT EXISTS(SELECT 1 FROM public.fb_analytics_report_state WHERE social_account_id='ab030000-0000-4000-8000-000000000011');
 ASSERT (SELECT state='verified' FROM public.fb_analytics_permission_observations WHERE social_account_id='ab030000-0000-4000-8000-000000000011');
END;
$direct_and_facebook$;

DO $ownership_and_budget$
DECLARE result jsonb;run_id uuid:=gen_random_uuid();capture jsonb;counter integer;
BEGIN
 PERFORM pg_temp.bootstrap_policy(ARRAY['ab030000-0000-4000-8000-000000000014'::uuid]);
 PERFORM public.dispatch_analytics_legacy_bootstrap(run_id);
 capture:=public.begin_analytics_legacy_bootstrap('ab030000-0000-4000-8000-000000000014',gen_random_uuid(),run_id);
 ASSERT capture->>'user_id'='ab030000-0000-4000-8000-000000000002';
 FOR counter IN 1..50 LOOP
  ASSERT public.permit_analytics_legacy_bootstrap(run_id,(capture->>'job_id')::uuid,(capture->>'lease_id')::uuid,(capture->>'revision')::bigint,'200001');
 END LOOP;
 ASSERT NOT public.permit_analytics_legacy_bootstrap(run_id,(capture->>'job_id')::uuid,(capture->>'lease_id')::uuid,(capture->>'revision')::bigint,'200001');
 PERFORM public.record_analytics_legacy_bootstrap_usage(run_id,(capture->>'job_id')::uuid,85,clock_timestamp()+interval '3 days','200001');
 ASSERT (SELECT throttled_until>clock_timestamp()+interval '2 days' FROM public.instagram_provider_throttle_buckets
  WHERE bucket_key=encode(extensions.digest('owned_analytics:app:facebook:200001','sha256'),'hex'));
 DELETE FROM public.instagram_provider_throttle_buckets WHERE bucket_key=encode(extensions.digest('owned_analytics:app:facebook:200001','sha256'),'hex');
 ASSERT NOT (SELECT row_to_json(a)::text ~ '(access_token|user_token|input_fence)' FROM public.analytics_legacy_bootstrap_audit a LIMIT 1);
END;
$ownership_and_budget$;

DO $permission_monotonic_and_policy$
DECLARE capture jsonb;installed jsonb;target uuid:='ab030000-0000-4000-8000-000000000012';generation bigint;credential uuid;
BEGIN
 -- A current protected capability takes permission refresh, never a generation reset or a new grant.
 SELECT credential_generation INTO generation FROM public.instagram_account_capabilities WHERE social_account_id=target;
 SELECT credential_id INTO credential FROM public.facebook_user_credential_bindings WHERE social_account_id=target;
 PERFORM public.write_instagram_account_capability(target,'ab030000-0000-4000-8000-000000000001',
  jsonb_build_object('login_kind','page_linked','expected_credential_generation',generation,'permission_read_state','ok',
   'granted_scopes',ARRAY['instagram_manage_insights'],'scopes_read_at',clock_timestamp()));
 UPDATE public.analytics_legacy_bootstrap_jobs SET state='permission_pending',retry_at=NULL,
  attempt_times=ARRAY(SELECT t-interval '25 hours' FROM unnest(attempt_times) t) WHERE social_account_id=target;
 capture:=pg_temp.bootstrap_begin(target);
 ASSERT capture->>'state'='permission_pending' AND (capture->>'installed')::boolean;
 ASSERT (SELECT credential_generation=generation FROM public.instagram_account_capabilities WHERE social_account_id=target);
 ASSERT (SELECT credential_id=credential FROM public.facebook_user_credential_bindings WHERE social_account_id=target);
 UPDATE public.app_settings SET value='false' WHERE key='analytics_legacy_bootstrap_enabled';
 installed:=public.complete_analytics_legacy_bootstrap((capture->>'job_id')::uuid,(capture->>'lease_id')::uuid,(capture->>'revision')::bigint,
  jsonb_build_object('state','ok','scopes',ARRAY['instagram_manage_insights'],'observed_at',clock_timestamp()));
 ASSERT installed->>'reason_code'='stale_capture','revocation must stop permission completion after install';
 UPDATE public.app_settings SET value='true' WHERE key='analytics_legacy_bootstrap_enabled';
 installed:=public.complete_analytics_legacy_bootstrap((capture->>'job_id')::uuid,(capture->>'lease_id')::uuid,(capture->>'revision')::bigint,
  jsonb_build_object('state','failed','scopes','[]'::jsonb,'observed_at',clock_timestamp()));
 ASSERT installed->>'state'='permission_pending';
 ASSERT (SELECT permission_read_state='ok' AND granted_scopes @> ARRAY['instagram_manage_insights'] AND last_read_failed_at IS NOT NULL
  FROM public.instagram_account_capabilities WHERE social_account_id=target),'transient failure must preserve monotonic successful evidence';
END;
$permission_monotonic_and_policy$;

DO $untrusted_evidence$
DECLARE capture jsonb;evidence jsonb;outcome jsonb;scenario text;target uuid:='ab030000-0000-4000-8000-000000000015';
BEGIN
 INSERT INTO public.social_accounts(id,user_id,platform,platform_user_id,platform_username,access_token,account_metadata,ig_auth_type)
 VALUES(target,'ab030000-0000-4000-8000-000000000001','instagram','178009','proof_fixture',gen_random_uuid()::text,'{"facebook_page_id":"100001"}','facebook_page');
 FOREACH scenario IN ARRAY ARRAY['app','type','page','instagram'] LOOP
  capture:=pg_temp.bootstrap_begin(target);
  ASSERT capture->>'state'='verifying';
  ASSERT public.permit_analytics_legacy_bootstrap((capture->>'run_id')::uuid,(capture->>'job_id')::uuid,(capture->>'lease_id')::uuid,(capture->>'revision')::bigint,'200001');
  evidence:=pg_temp.bootstrap_evidence(capture)||CASE scenario WHEN 'app' THEN '{"app_id":"200002"}'::jsonb
   WHEN 'type' THEN '{"token_type":"PAGE"}'::jsonb WHEN 'page' THEN '{"page_id":"100099"}'::jsonb ELSE '{"instagram_user_id":"178099"}'::jsonb END;
  outcome:=public.commit_analytics_legacy_bootstrap((capture->>'job_id')::uuid,(capture->>'lease_id')::uuid,(capture->>'revision')::bigint,evidence);
  ASSERT outcome->>'reason_code'=CASE scenario WHEN 'app' THEN 'app_mismatch' WHEN 'type' THEN 'token_invalid' ELSE 'identity_mismatch' END;
  ASSERT NOT EXISTS(SELECT 1 FROM public.instagram_account_capabilities WHERE social_account_id=target);
  ASSERT NOT EXISTS(SELECT 1 FROM public.facebook_user_credential_bindings WHERE social_account_id=target);
  DELETE FROM public.analytics_legacy_bootstrap_jobs WHERE social_account_id=target;
 END LOOP;
END;
$untrusted_evidence$;

DO $expired_protected_fallback$
DECLARE source_credential uuid;original_secret text;original_revision bigint;capture jsonb;outcome jsonb;
 target uuid:='ab030000-0000-4000-8000-000000000016';
BEGIN
 SELECT c.id,c.token,c.revision INTO source_credential,original_secret,original_revision FROM public.facebook_user_credentials c
  JOIN public.facebook_user_credential_bindings b ON b.credential_id=c.id WHERE b.social_account_id='ab030000-0000-4000-8000-000000000011';
 UPDATE public.facebook_user_credentials SET token_expires_at=clock_timestamp()-interval '1 day' WHERE id=source_credential;
 INSERT INTO public.social_accounts(id,user_id,platform,platform_user_id,platform_username,access_token,account_metadata,ig_auth_type)
 VALUES(target,'ab030000-0000-4000-8000-000000000001','instagram','178016','fallback_fixture',gen_random_uuid()::text,'{"facebook_page_id":"100001"}','facebook_page');
 capture:=pg_temp.bootstrap_begin(target);
 ASSERT capture->>'state'='verifying','a stored same-owner Page candidate must not force reconnect merely because another stored grant expired';
 outcome:=pg_temp.bootstrap_commit(capture);
 ASSERT outcome->>'state'='permission_pending';
 ASSERT (SELECT credential_id<>source_credential FROM public.facebook_user_credential_bindings WHERE social_account_id=target);
 ASSERT (SELECT credential_id=source_credential FROM public.facebook_user_credential_bindings WHERE social_account_id='ab030000-0000-4000-8000-000000000011');
 ASSERT (SELECT token=original_secret AND revision=original_revision FROM public.facebook_user_credentials WHERE id=source_credential),
  'installing an isolated grant must not replace the old shared grant';
END;
$expired_protected_fallback$;

SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claim.role='service_role';
DO $impersonation$
BEGIN
 BEGIN
  PERFORM public.dispatch_analytics_legacy_bootstrap(gen_random_uuid());
  RAISE EXCEPTION 'browser impersonation unexpectedly accepted';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END;
$impersonation$;
RESET ROLE;
ROLLBACK;
\echo === analytics_legacy_bootstrap: ALL CHECKS PASSED ===
