-- Real SQL regression for the 2026-11-14 direct identity incident and the
-- separately diagnosed duplicate-row/Page prerequisite. No provider egress.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL request.jwt.claim.role='service_role';
SET LOCAL request.jwt.claims='{"role":"service_role"}';
INSERT INTO public.app_settings(key,value) VALUES
 ('credential_facebook_user_mode','"legacy"'),('credential_facebook_user_protected_pilot_user_ids','[]'),
 ('collection_instagram_insights_enabled','false'),
 ('collection_instagram_rollout_policy','{"version":1,"owners":{"mode":"off","account_ids":[]},"competitors":{"mode":"off","targets":[]}}')
 ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value;
INSERT INTO auth.users(id,email) VALUES('ad140000-0000-4000-8000-000000000001','direct-recovery@example.invalid');
CREATE FUNCTION pg_temp.direct_policy(targets uuid[]) RETURNS uuid LANGUAGE plpgsql AS $fn$
DECLARE run uuid:=gen_random_uuid();
BEGIN
 UPDATE public.app_settings SET value='true' WHERE key='analytics_legacy_bootstrap_enabled';
 UPDATE public.app_settings SET value=jsonb_build_object('version',1,'account_ids',targets,'max_accounts_per_run',5,'max_attempts_per_account_per_day',3)
  WHERE key='analytics_legacy_bootstrap_policy';
 UPDATE public.analytics_legacy_bootstrap_run SET lease_until=NULL,pause_until=NULL;
 PERFORM public.dispatch_analytics_legacy_bootstrap(run);
 RETURN run;
END;
$fn$;
DO $reconnect_route_model$
DECLARE sample record;
BEGIN
 FOR sample IN SELECT * FROM (VALUES
  ('"protected"'::jsonb,'[]'::jsonb,true),
  ('"  PROTECTED "'::jsonb,'false'::jsonb,true),
  ('"legacy"'::jsonb,'[]'::jsonb,false),
  ('null'::jsonb,'["ad140000-0000-4000-8000-000000000001"]'::jsonb,true),
  ('"legacy"'::jsonb,'[" AD140000-0000-4000-8000-000000000001 "]'::jsonb,true),
  ('"typo"'::jsonb,'["ad140000-0000-4000-8000-000000000001"]'::jsonb,false),
  ('false'::jsonb,'["ad140000-0000-4000-8000-000000000001"]'::jsonb,false),
  ('"legacy"'::jsonb,'["ad140000-0000-4000-8000-000000000001","bad"]'::jsonb,false)
 ) variants(mode_config,pilot_config,expected) LOOP
  UPDATE public.app_settings SET value=sample.mode_config WHERE key='credential_facebook_user_mode';
  UPDATE public.app_settings SET value=sample.pilot_config WHERE key='credential_facebook_user_protected_pilot_user_ids';
  ASSERT public.analytics_bootstrap_direct_reconnect_available('ad140000-0000-4000-8000-000000000001')=sample.expected,
   'reconnect availability must match the supported OAuth routing model';
 END LOOP;
 UPDATE public.app_settings SET value='"legacy"' WHERE key='credential_facebook_user_mode';
 UPDATE public.app_settings SET value='[]' WHERE key='credential_facebook_user_protected_pilot_user_ids';
END;
$reconnect_route_model$;
DO $duplicate_rows_are_not_identity_proof$
DECLARE target uuid;run uuid;capture jsonb;result jsonb;
BEGIN
 -- The same display username in two rows must not select/merge an identity.
 INSERT INTO public.social_accounts(id,user_id,platform,platform_user_id,platform_username,access_token,account_metadata,ig_auth_type)
 VALUES('ad140000-0000-4000-8000-000000000011','ad140000-0000-4000-8000-000000000001','instagram','178901','duplicate_fixture',gen_random_uuid()::text,'{"flow":"facebook_business","facebook_page_id":"199999"}','facebook_page'),
 ('ad140000-0000-4000-8000-000000000012','ad140000-0000-4000-8000-000000000001','instagram','178902','duplicate_fixture',gen_random_uuid()::text,'{"flow":"facebook_business","facebook_page_id":""}','facebook_page');
 FOREACH target IN ARRAY ARRAY['ad140000-0000-4000-8000-000000000011'::uuid,'ad140000-0000-4000-8000-000000000012'::uuid] LOOP
  run:=pg_temp.direct_policy(ARRAY[target]);
  capture:=public.begin_analytics_legacy_bootstrap(target,gen_random_uuid(),run);
  ASSERT capture->>'state'='blocked';
  ASSERT capture->>'reason_code'=CASE WHEN target='ad140000-0000-4000-8000-000000000011' THEN 'linked_page_unavailable' ELSE 'linked_page_missing' END,
   'duplicate-row diagnosis must name the actual Page prerequisite';
  result:=public.owner_analytics_readiness_snapshot('instagram','ad140000-0000-4000-8000-000000000001',target,clock_timestamp(),NULL);
  ASSERT result->'connection'->>'reason_code'=capture->>'reason_code';
  ASSERT result->'collection'->>'contract_version'='3';
  ASSERT result->'collection'->>'reason_code'='collection_disabled','policy precedence survives connection diagnosis';
 END LOOP;
 ASSERT (SELECT count(*)=2 FROM public.social_accounts WHERE user_id='ad140000-0000-4000-8000-000000000001' AND platform_username='duplicate_fixture');
 ASSERT NOT EXISTS(SELECT 1 FROM public.facebook_user_credential_bindings WHERE user_id='ad140000-0000-4000-8000-000000000001');
END;
$duplicate_rows_are_not_identity_proof$;

DO $page_prerequisite_retries_require_changed_inputs$
DECLARE target uuid;run uuid;capture jsonb;before_job public.analytics_legacy_bootstrap_jobs;
 after_job public.analytics_legacy_bootstrap_jobs;before_audits bigint;
BEGIN
 -- PR #427: neither a new idempotency key nor an unrelated failure permits
 -- retry. Only a repaired Page prerequisite can retire its captured diagnosis.
 INSERT INTO public.social_accounts(id,user_id,platform,platform_user_id,platform_username,access_token,account_metadata,ig_auth_type)
 VALUES('ad140000-0000-4000-8000-000000000021','ad140000-0000-4000-8000-000000000001','instagram','178921','page_retry_fixture',gen_random_uuid()::text,
  '{"facebook_page_id":"299999"}','facebook_page'),
 ('ad140000-0000-4000-8000-000000000022','ad140000-0000-4000-8000-000000000001','instagram','178922','page_retry_fixture',gen_random_uuid()::text,
  '{"facebook_page_id":""}','facebook_page');
 FOREACH target IN ARRAY ARRAY['ad140000-0000-4000-8000-000000000021'::uuid,'ad140000-0000-4000-8000-000000000022'::uuid] LOOP
  run:=pg_temp.direct_policy(ARRAY[target]);
  capture:=public.begin_analytics_legacy_bootstrap(target,gen_random_uuid(),run);
  ASSERT capture->>'state'='blocked' AND capture->>'reason_code'=CASE WHEN target='ad140000-0000-4000-8000-000000000021'
   THEN 'linked_page_unavailable' ELSE 'linked_page_missing' END,'fixture must capture a real Page prerequisite failure';
  SELECT * INTO STRICT before_job FROM public.analytics_legacy_bootstrap_jobs WHERE social_account_id=target;
  capture:=public.begin_analytics_legacy_bootstrap(target,gen_random_uuid(),run);
  SELECT * INTO STRICT after_job FROM public.analytics_legacy_bootstrap_jobs WHERE social_account_id=target;
  ASSERT after_job IS NOT DISTINCT FROM before_job,'unchanged Page prerequisite must leave the job untouched';
  ASSERT capture->>'reason_code'=before_job.reason_code;
  ASSERT EXISTS(SELECT 1 FROM public.analytics_legacy_bootstrap_audit WHERE correlation_id=before_job.correlation_id
   AND event='begin' AND reason_code='settled_or_busy'),'settled Page refusal must be audited';
  run:=pg_temp.direct_policy(ARRAY[target]);
  ASSERT (SELECT NOT target=ANY(account_ids) FROM public.analytics_legacy_bootstrap_run WHERE holder=run),
   'dispatcher must leave an unchanged Page prerequisite out of the bounded batch';

  IF before_job.reason_code='linked_page_missing' THEN
   UPDATE public.social_accounts SET account_metadata=account_metadata||'{"facebook_page_id":"299998"}'::jsonb WHERE id=target;
  END IF;
  INSERT INTO public.social_accounts(user_id,platform,platform_user_id,platform_username,access_token,account_metadata)
  SELECT user_id,'facebook',account_metadata->>'facebook_page_id','repaired_page_fixture',gen_random_uuid()::text,
   jsonb_build_object('user_token',gen_random_uuid()::text) FROM public.social_accounts WHERE id=target;
  SELECT count(*) INTO before_audits FROM public.analytics_legacy_bootstrap_audit
   WHERE correlation_id=before_job.correlation_id AND event='begin' AND reason_code='verification_pending';
  run:=pg_temp.direct_policy(ARRAY[target]);
  ASSERT (SELECT target=ANY(account_ids) FROM public.analytics_legacy_bootstrap_run WHERE holder=run),
   'dispatcher must admit the repaired Page prerequisite, including an absent-to-present Page source';
  capture:=public.begin_analytics_legacy_bootstrap(target,gen_random_uuid(),run);
  SELECT * INTO STRICT after_job FROM public.analytics_legacy_bootstrap_jobs WHERE social_account_id=target;
  ASSERT capture->>'state'='verifying','repaired Page prerequisite must retry without a target generation/version advance';
  ASSERT after_job.input_fence IS DISTINCT FROM before_job.input_fence;
  ASSERT after_job.captured_generation=before_job.captured_generation AND after_job.captured_connection=before_job.captured_connection;
  ASSERT after_job.attempts=before_job.attempts+1 AND cardinality(after_job.attempt_times)=cardinality(before_job.attempt_times)+1
   AND after_job.attempt_times[1:cardinality(before_job.attempt_times)]=before_job.attempt_times,
   'Page retry must preserve daily attempt history and consume one attempt';
  ASSERT (SELECT count(*) FROM public.analytics_legacy_bootstrap_audit
   WHERE correlation_id=before_job.correlation_id AND event='begin' AND reason_code='verification_pending')=before_audits+1,
   'Page retry must emit its normal begin audit';

  -- Even another changed fence cannot bypass a live lease or the daily cap.
  UPDATE public.social_accounts SET account_metadata=account_metadata||jsonb_build_object('page_repair_revision',gen_random_uuid()) WHERE id=target;
  before_job:=after_job;
  PERFORM public.begin_analytics_legacy_bootstrap(target,gen_random_uuid(),run);
  SELECT * INTO STRICT after_job FROM public.analytics_legacy_bootstrap_jobs WHERE social_account_id=target;
  ASSERT after_job IS NOT DISTINCT FROM before_job,'changed Page inputs cannot steal a live lease';
  UPDATE public.analytics_legacy_bootstrap_jobs SET state='blocked',
   reason_code=CASE WHEN target='ad140000-0000-4000-8000-000000000021' THEN 'linked_page_unavailable' ELSE 'linked_page_missing' END,
   lease_id=NULL,lease_until=NULL,attempts=3,attempt_times=ARRAY[clock_timestamp(),clock_timestamp(),clock_timestamp()]
   WHERE social_account_id=target;
  SELECT * INTO STRICT before_job FROM public.analytics_legacy_bootstrap_jobs WHERE social_account_id=target;
  PERFORM public.begin_analytics_legacy_bootstrap(target,gen_random_uuid(),run);
  SELECT * INTO STRICT after_job FROM public.analytics_legacy_bootstrap_jobs WHERE social_account_id=target;
  ASSERT after_job IS NOT DISTINCT FROM before_job,'changed Page inputs cannot reset or bypass the daily attempt cap';
  ASSERT EXISTS(SELECT 1 FROM public.analytics_legacy_bootstrap_audit WHERE correlation_id=before_job.correlation_id
   AND event='begin' AND reason_code='attempt_budget'),'daily cap refusal must be audited';

  UPDATE public.analytics_legacy_bootstrap_jobs SET reason_code='app_mismatch',attempts=1,attempt_times=ARRAY[clock_timestamp()]
   WHERE social_account_id=target;
  SELECT * INTO STRICT before_job FROM public.analytics_legacy_bootstrap_jobs WHERE social_account_id=target;
  PERFORM public.begin_analytics_legacy_bootstrap(target,gen_random_uuid(),run);
  SELECT * INTO STRICT after_job FROM public.analytics_legacy_bootstrap_jobs WHERE social_account_id=target;
  ASSERT after_job IS NOT DISTINCT FROM before_job,'changed Page inputs must not reopen an unrelated blocked job';
  run:=pg_temp.direct_policy(ARRAY[target]);
  ASSERT (SELECT NOT target=ANY(account_ids) FROM public.analytics_legacy_bootstrap_run WHERE holder=run),
   'dispatcher must leave an unrelated blocked job out of the bounded batch';
 END LOOP;
END;
$page_prerequisite_retries_require_changed_inputs$;

CREATE FUNCTION pg_temp.incident_job(username text,number integer) RETURNS uuid LANGUAGE plpgsql AS $fn$
DECLARE account uuid:=gen_random_uuid();job uuid;provider text:=(1789900+number)::text;
BEGIN
 INSERT INTO public.social_accounts(id,user_id,platform,platform_user_id,platform_username,access_token,ig_auth_type,account_metadata)
 VALUES(account,'ad140000-0000-4000-8000-000000000001','instagram',provider,username,gen_random_uuid()::text,'business_login',
  jsonb_build_object('flow','direct','source','instagram_business_login','ig_user_id',provider));
 INSERT INTO public.analytics_legacy_bootstrap_jobs(social_account_id,user_id,platform,login_kind,idempotency_key,state,reason_code,
  source_kind,source_account_id,input_fence,attempts,attempt_times,created_at,updated_at)
 VALUES(account,'ad140000-0000-4000-8000-000000000001','instagram','direct',gen_random_uuid(),'blocked','identity_mismatch',
  'direct',account,public.analytics_bootstrap_fence(account,account,NULL),1,ARRAY[clock_timestamp()],
  '2026-11-14 17:00:00+00','2026-11-14 17:10:00+00') RETURNING id INTO job;
 RETURN job;
END;
$fn$;
DO $narrow_recovery$
DECLARE job uuid;target uuid;capture jsonb;result jsonb;run uuid;names text[]:=ARRAY['australianbodycarekw','autoverse511','elsashaikhpk','eltamlawy_chicks','etern.foto','flexitolkw','kapiva.shilajit'];
 controls uuid[]:='{}';old_revision bigint;before_audits bigint;
BEGIN
 FOR i IN 1..7 LOOP PERFORM pg_temp.incident_job(names[i],i);END LOOP;
 -- Same failure outside incident names, changed inputs, installed capability,
 -- newer incident, different failure, live lease and installed receipt all refuse.
 controls:=array_append(controls,pg_temp.incident_job('unrelated_fixture',20));
 job:=pg_temp.incident_job(names[1],21);controls:=array_append(controls,job);
 UPDATE public.social_accounts SET access_token=gen_random_uuid()::text WHERE id=(SELECT social_account_id FROM public.analytics_legacy_bootstrap_jobs WHERE id=job);
 job:=pg_temp.incident_job(names[2],22);controls:=array_append(controls,job);
 INSERT INTO public.instagram_account_capabilities(social_account_id,user_id,login_kind)
 SELECT social_account_id,user_id,'direct' FROM public.analytics_legacy_bootstrap_jobs WHERE id=job;
 job:=pg_temp.incident_job(names[3],23);controls:=array_append(controls,job);
 UPDATE public.analytics_legacy_bootstrap_jobs SET updated_at='2026-11-14 17:16:00+00' WHERE id=job;
 job:=pg_temp.incident_job(names[4],24);controls:=array_append(controls,job);
 UPDATE public.analytics_legacy_bootstrap_jobs SET reason_code='app_mismatch' WHERE id=job;
 job:=pg_temp.incident_job(names[5],25);controls:=array_append(controls,job);
 UPDATE public.analytics_legacy_bootstrap_jobs SET lease_id=gen_random_uuid(),lease_until=clock_timestamp()+interval '1 hour' WHERE id=job;
 job:=pg_temp.incident_job(names[6],26);controls:=array_append(controls,job);
 UPDATE public.analytics_legacy_bootstrap_jobs SET installed=true WHERE id=job;
 UPDATE public.app_settings SET value='false' WHERE key='analytics_legacy_bootstrap_enabled';
 UPDATE public.analytics_legacy_bootstrap_run SET lease_until=NULL;
 UPDATE public.app_settings SET value='true' WHERE key='analytics_legacy_bootstrap_enabled';
 BEGIN
  PERFORM public.analytics_bootstrap_reset_direct_identity_incident();
  RAISE EXCEPTION 'unpaused recovery accepted';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'BOOTSTRAP_RECOVERY_REQUIRES_PAUSE' THEN RAISE; END IF; END;
 UPDATE public.app_settings SET value='false' WHERE key='analytics_legacy_bootstrap_enabled';
 job:=pg_temp.incident_job(names[7],27);
 BEGIN
  PERFORM public.analytics_bootstrap_reset_direct_identity_incident();
  RAISE EXCEPTION 'unbounded recovery accepted';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'BOOTSTRAP_RECOVERY_POPULATION_DRIFT' THEN RAISE; END IF; END;
 DELETE FROM public.social_accounts WHERE id=(SELECT social_account_id FROM public.analytics_legacy_bootstrap_jobs WHERE id=job);
 SELECT count(*) INTO before_audits FROM public.analytics_legacy_bootstrap_audit WHERE event='direct_identity_incident_reset';
 ASSERT public.analytics_bootstrap_reset_direct_identity_incident()=7;
 ASSERT public.analytics_bootstrap_reset_direct_identity_incident()=0,'recovery is idempotent';
 ASSERT (SELECT count(*) FROM public.analytics_legacy_bootstrap_audit WHERE event='direct_identity_incident_reset')-before_audits=7;
 ASSERT (SELECT bool_and(state='blocked') FROM public.analytics_legacy_bootstrap_jobs WHERE id=ANY(controls));
 ASSERT (SELECT bool_and(revision=2 AND attempts=1 AND cardinality(attempt_times)=1 AND retry_at IS NOT NULL)
  FROM public.analytics_legacy_bootstrap_jobs WHERE state='retry' AND user_id='ad140000-0000-4000-8000-000000000001');
 SELECT social_account_id INTO target FROM public.analytics_legacy_bootstrap_jobs WHERE state='retry' AND user_id='ad140000-0000-4000-8000-000000000001' ORDER BY social_account_id LIMIT 1;
 run:=pg_temp.direct_policy(ARRAY[target]);
 capture:=public.begin_analytics_legacy_bootstrap(target,gen_random_uuid(),run);
 ASSERT capture->>'state'='verifying',capture->>'reason_code';
 ASSERT capture->'capture'->>'login_kind'='direct';
 UPDATE public.app_settings SET value='"protected"' WHERE key='credential_facebook_user_mode';
 result:=public.settle_analytics_legacy_bootstrap((capture->>'job_id')::uuid,(capture->>'lease_id')::uuid,(capture->>'revision')::bigint,'direct_verification_unsupported');
 ASSERT result->>'state'='needs_reconnect' AND result->>'reason_code'='direct_verification_unsupported',result::text;
 ASSERT result->>'next_action'='supported_reconnect' AND result->>'reconnect_path'='/profiles',result::text;
 -- Collection disabled remains primary; the direct reason is independent.
 UPDATE public.app_settings SET value='"protected"' WHERE key='credential_facebook_user_mode';
 result:=public.owner_analytics_readiness_snapshot('instagram','ad140000-0000-4000-8000-000000000001',target,clock_timestamp(),NULL);
 ASSERT result->'collection'->>'reason_code'='collection_disabled',result::text;
 ASSERT result->'connection'->>'reason_code'='direct_verification_unsupported',result::text;
 ASSERT result->'connection'->>'reconnect_path'='/profiles';
 UPDATE public.app_settings SET value='true' WHERE key='collection_instagram_insights_enabled';
 UPDATE public.app_settings SET value='{"version":1,"owners":{"mode":"all","account_ids":[]},"competitors":{"mode":"off","targets":[]}}'
 WHERE key='collection_instagram_rollout_policy';
 result:=public.owner_analytics_readiness_snapshot('instagram','ad140000-0000-4000-8000-000000000001',target,clock_timestamp(),NULL);
 ASSERT result->'collection'->>'reason_code'='direct_verification_unsupported';
 ASSERT result->'collection'->>'next_action'='reconnect' AND (result->'collection'->>'reconnect_can_help')::boolean;
 UPDATE public.app_settings SET value='"legacy"' WHERE key='credential_facebook_user_mode';
 UPDATE public.app_settings SET value='[]' WHERE key='credential_facebook_user_protected_pilot_user_ids';
 result:=public.owner_analytics_readiness_snapshot('instagram','ad140000-0000-4000-8000-000000000001',target,clock_timestamp(),NULL);
 ASSERT result->'collection'->>'next_action'='contact_support';
 ASSERT NOT (result->'collection'->>'reconnect_can_help')::boolean;
 ASSERT result->'connection'->>'reconnect_path' IS NULL,'never advertise an unprotected legacy save as a repair';
 UPDATE public.social_accounts SET access_token=gen_random_uuid()::text WHERE id=target;
 result:=public.owner_analytics_readiness_snapshot('instagram','ad140000-0000-4000-8000-000000000001',target,clock_timestamp(),NULL);
 ASSERT result->'connection'->>'reason_code'='bootstrap_required','a changed input retires the old bootstrap diagnosis';
 ASSERT NOT EXISTS(SELECT 1 FROM public.facebook_user_credential_bindings WHERE social_account_id=target);
 ASSERT NOT EXISTS(SELECT 1 FROM public.instagram_account_capabilities WHERE social_account_id=target);
 ASSERT NOT has_function_privilege('service_role','public.analytics_bootstrap_reset_direct_identity_incident()','EXECUTE');
 ASSERT NOT has_function_privilege('authenticated','public.analytics_bootstrap_reset_direct_identity_incident()','EXECUTE');
END;
$narrow_recovery$;
ROLLBACK;
\echo === analytics_direct_identity_recovery: ALL CHECKS PASSED ===
