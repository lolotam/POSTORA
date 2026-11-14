-- Two live PostgreSQL backends: a direct-token writer races recovery and
-- settlement. A locked or changed input must never become a reconnect verdict.
\set ON_ERROR_STOP on
BEGIN;
SELECT pg_advisory_xact_lock(hashtextextended('direct_identity_race_fixture',0));
CREATE TABLE public.direct_identity_race_settings AS SELECT key,value FROM public.app_settings WHERE key LIKE 'analytics_legacy_bootstrap_%';
INSERT INTO auth.users(id,email) VALUES('ad140001-0000-4000-8000-000000000001','direct-race@example.invalid');
INSERT INTO public.social_accounts(id,user_id,platform,platform_user_id,platform_username,access_token,ig_auth_type,account_metadata)
VALUES('ad140001-0000-4000-8000-000000000011','ad140001-0000-4000-8000-000000000001','instagram','1789991','flexitolkw',gen_random_uuid()::text,'business_login',
 '{"flow":"direct","source":"instagram_business_login","ig_user_id":"1789991"}');
INSERT INTO public.analytics_legacy_bootstrap_jobs(social_account_id,user_id,platform,login_kind,idempotency_key,state,reason_code,source_kind,source_account_id,input_fence,created_at,updated_at)
VALUES('ad140001-0000-4000-8000-000000000011','ad140001-0000-4000-8000-000000000001','instagram','direct',gen_random_uuid(),'blocked','identity_mismatch','direct',
 'ad140001-0000-4000-8000-000000000011',public.analytics_bootstrap_fence('ad140001-0000-4000-8000-000000000011','ad140001-0000-4000-8000-000000000011',NULL),
 '2026-11-14 17:00:00+00','2026-11-14 17:10:00+00');
UPDATE public.analytics_legacy_bootstrap_run SET holder=NULL,lease_until=NULL,pause_until=NULL;
UPDATE public.app_settings SET value='false' WHERE key='analytics_legacy_bootstrap_enabled';
CREATE TABLE public.direct_identity_race_capture(payload jsonb NOT NULL);
REVOKE ALL ON public.direct_identity_race_capture,public.direct_identity_race_settings FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.direct_identity_race_write() RETURNS boolean LANGUAGE plpgsql AS $fn$
BEGIN
 UPDATE public.social_accounts SET access_token=gen_random_uuid()::text WHERE id='ad140001-0000-4000-8000-000000000011';
 PERFORM pg_sleep(0.5);
 RETURN true;
END;
$fn$;
CREATE FUNCTION public.direct_identity_race_wait() RETURNS void LANGUAGE plpgsql AS $fn$
BEGIN
 FOR attempt IN 1..100 LOOP
  IF EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='postora_direct_identity_race' AND wait_event='PgSleep') THEN RETURN; END IF;
  PERFORM pg_sleep(0.01);
 END LOOP;
 RAISE EXCEPTION 'direct token writer did not reach its locked barrier';
END;
$fn$;
CREATE FUNCTION public.direct_identity_race_refuse(operation text) RETURNS void LANGUAGE plpgsql AS $fn$
DECLARE busy boolean:=false;capture jsonb;result jsonb;
BEGIN
 PERFORM set_config('request.jwt.claim.role','service_role',true);
 PERFORM set_config('request.jwt.claims','{"role":"service_role"}',true);
 BEGIN
  IF operation='recovery' THEN PERFORM public.analytics_bootstrap_reset_direct_identity_incident();
  ELSE
   SELECT payload INTO STRICT capture FROM public.direct_identity_race_capture;
   result:=public.settle_analytics_legacy_bootstrap((capture->>'job_id')::uuid,(capture->>'lease_id')::uuid,(capture->>'revision')::bigint,'direct_verification_unsupported');
  END IF;
 EXCEPTION WHEN SQLSTATE 'MAR05' THEN busy:=true; END;
 ASSERT busy,'the existing account lock order must refuse the live writer';
 ASSERT NOT EXISTS(SELECT 1 FROM public.instagram_account_capabilities WHERE social_account_id='ad140001-0000-4000-8000-000000000011');
END;
$fn$;
REVOKE ALL ON FUNCTION public.direct_identity_race_write(),public.direct_identity_race_wait(),public.direct_identity_race_refuse(text) FROM PUBLIC,anon,authenticated,service_role;
COMMIT;
SELECT extensions.dblink_connect('direct_identity_writer','dbname='||current_database()||' user='||current_user||' application_name=postora_direct_identity_race');
SELECT extensions.dblink_send_query('direct_identity_writer','SELECT public.direct_identity_race_write()');
SELECT public.direct_identity_race_wait();
SELECT public.direct_identity_race_refuse('recovery');
SELECT * FROM extensions.dblink_get_result('direct_identity_writer') AS done(value boolean);
SELECT * FROM extensions.dblink_get_result('direct_identity_writer') AS drained(value boolean);
DO $recovery_after_writer$ BEGIN
 ASSERT public.analytics_bootstrap_reset_direct_identity_incident()=0,'changed input must be skipped after the writer commits';
 ASSERT (SELECT state='blocked' AND revision=1 FROM public.analytics_legacy_bootstrap_jobs WHERE social_account_id='ad140001-0000-4000-8000-000000000011');
END;$recovery_after_writer$;
BEGIN;
DELETE FROM public.analytics_legacy_bootstrap_jobs WHERE social_account_id='ad140001-0000-4000-8000-000000000011';
SET LOCAL request.jwt.claim.role='service_role';
SET LOCAL request.jwt.claims='{"role":"service_role"}';
DO $capture$ DECLARE run uuid:=gen_random_uuid();capture jsonb;BEGIN
 UPDATE public.app_settings SET value='true' WHERE key='analytics_legacy_bootstrap_enabled';
 UPDATE public.app_settings SET value='{"version":1,"account_ids":["ad140001-0000-4000-8000-000000000011"],"max_accounts_per_run":5,"max_attempts_per_account_per_day":3}' WHERE key='analytics_legacy_bootstrap_policy';
 PERFORM public.dispatch_analytics_legacy_bootstrap(run);
 capture:=public.begin_analytics_legacy_bootstrap('ad140001-0000-4000-8000-000000000011',gen_random_uuid(),run);
 ASSERT capture->>'state'='verifying';
 INSERT INTO public.direct_identity_race_capture VALUES(capture);
END;$capture$;
COMMIT;
SELECT extensions.dblink_send_query('direct_identity_writer','SELECT public.direct_identity_race_write()');
SELECT public.direct_identity_race_wait();
SELECT public.direct_identity_race_refuse('settlement');
SELECT * FROM extensions.dblink_get_result('direct_identity_writer') AS done(value boolean);
SELECT * FROM extensions.dblink_get_result('direct_identity_writer') AS drained(value boolean);
BEGIN;
SET LOCAL request.jwt.claim.role='service_role';
SET LOCAL request.jwt.claims='{"role":"service_role"}';
DO $settle_after_writer$ DECLARE capture jsonb;result jsonb;BEGIN
 SELECT payload INTO STRICT capture FROM public.direct_identity_race_capture;
 result:=public.settle_analytics_legacy_bootstrap((capture->>'job_id')::uuid,(capture->>'lease_id')::uuid,(capture->>'revision')::bigint,'direct_verification_unsupported');
 ASSERT result->>'reason_code'='stale_capture','a verdict based on the old direct token must be discarded';
END;$settle_after_writer$;
COMMIT;
SELECT extensions.dblink_disconnect('direct_identity_writer');
BEGIN;
UPDATE public.app_settings a SET value=s.value FROM public.direct_identity_race_settings s WHERE a.key=s.key;
DELETE FROM auth.users WHERE id='ad140001-0000-4000-8000-000000000001';
DELETE FROM public.analytics_legacy_bootstrap_epochs WHERE subject_id::text LIKE 'ad140001-%';
UPDATE public.analytics_legacy_bootstrap_run SET holder=NULL,lease_until=NULL,pause_until=NULL,calls=0;
DROP TABLE public.direct_identity_race_settings,public.direct_identity_race_capture;
DROP FUNCTION public.direct_identity_race_write(),public.direct_identity_race_wait(),public.direct_identity_race_refuse(text);
COMMIT;
\echo === analytics_direct_identity_races: ALL CHECKS PASSED ===
