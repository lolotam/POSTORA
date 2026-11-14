-- Two real PostgreSQL sessions. Provider verification is the interval between capture and commit.
-- Committed fixtures are necessary for dblink visibility; cleanup is explicit at the end.
CREATE EXTENSION IF NOT EXISTS dblink WITH SCHEMA extensions;
BEGIN;
INSERT INTO auth.users(id,email) VALUES('ac030000-0000-4000-8000-000000000001','bootstrap-race@example.invalid');
INSERT INTO public.social_accounts(id,user_id,platform,platform_user_id,platform_username,access_token,account_metadata,ig_auth_type) VALUES
 ('ac030000-0000-4000-8000-000000000011','ac030000-0000-4000-8000-000000000001','facebook','100101','race_page',gen_random_uuid()::text,'{}',NULL),
 ('ac030000-0000-4000-8000-000000000012','ac030000-0000-4000-8000-000000000001','instagram','178101','race_ig',gen_random_uuid()::text,'{"facebook_page_id":"100101"}','facebook_page'),
 ('ac030000-0000-4000-8000-000000000013','ac030000-0000-4000-8000-000000000001','facebook','100103','race_sibling',gen_random_uuid()::text,'{}',NULL);
INSERT INTO public.facebook_user_credentials(id,user_id,token,provider_user_id,provenance_source,provenance_captured_at)
 VALUES('ac030000-0000-4000-8000-000000000021','ac030000-0000-4000-8000-000000000001',gen_random_uuid()::text,'300101','oauth_exchange',clock_timestamp());
INSERT INTO public.facebook_user_credential_bindings(social_account_id,user_id,platform,credential_id,verified_facebook_user_id,evidence_source,connection_version)
 VALUES('ac030000-0000-4000-8000-000000000011','ac030000-0000-4000-8000-000000000001','facebook',
  'ac030000-0000-4000-8000-000000000021','300101','oauth_exchange',
  public.facebook_user_credential_allocate_connection_version('ac030000-0000-4000-8000-000000000011','ac030000-0000-4000-8000-000000000001','facebook'));
CREATE TABLE public.bootstrap_race_saved_settings AS SELECT key,value FROM public.app_settings WHERE key LIKE 'analytics_legacy_bootstrap_%';
UPDATE public.app_settings SET value='true' WHERE key='analytics_legacy_bootstrap_enabled';
UPDATE public.app_settings SET value='{"version":1,"account_ids":["ac030000-0000-4000-8000-000000000012"],"max_accounts_per_run":5,"max_attempts_per_account_per_day":3}'
 WHERE key='analytics_legacy_bootstrap_policy';
CREATE FUNCTION public.bootstrap_test_race_mutate(scenario text) RETURNS boolean
LANGUAGE plpgsql SET search_path=public,pg_temp AS $fn$
BEGIN
 CASE scenario
  WHEN 'reconnect' THEN UPDATE public.social_accounts SET access_token=gen_random_uuid()::text WHERE id='ac030000-0000-4000-8000-000000000012';
  WHEN 'disconnect' THEN UPDATE public.social_accounts SET is_active=false WHERE id='ac030000-0000-4000-8000-000000000012';
  WHEN 'token_refresh' THEN UPDATE public.facebook_user_credentials SET token=gen_random_uuid()::text,revision=revision+1 WHERE id='ac030000-0000-4000-8000-000000000021';
  WHEN 'shared_set' THEN
   INSERT INTO public.facebook_user_credential_bindings(social_account_id,user_id,platform,credential_id,verified_facebook_user_id,evidence_source,connection_version)
   VALUES('ac030000-0000-4000-8000-000000000013','ac030000-0000-4000-8000-000000000001','facebook',
    'ac030000-0000-4000-8000-000000000021','300101','oauth_exchange',
    public.facebook_user_credential_allocate_connection_version('ac030000-0000-4000-8000-000000000013','ac030000-0000-4000-8000-000000000001','facebook'));
  WHEN 'capability_aba' THEN
   INSERT INTO public.instagram_account_capabilities(social_account_id,user_id,login_kind) VALUES
    ('ac030000-0000-4000-8000-000000000012','ac030000-0000-4000-8000-000000000001','page_linked');
   DELETE FROM public.instagram_account_capabilities WHERE social_account_id='ac030000-0000-4000-8000-000000000012';
 END CASE;
 -- Keep the actual writer transaction open so install races an uncommitted mutation.
 PERFORM pg_sleep(0.4);
 RETURN true;
END;
$fn$;
REVOKE ALL ON FUNCTION public.bootstrap_test_race_mutate(text) FROM PUBLIC,anon,authenticated,service_role;
COMMIT;

SELECT extensions.dblink_connect('bootstrap_writer','dbname='||current_database()||' user='||current_user||' application_name=postora_bootstrap_race');
-- Each psql command is a separate transaction. dblink owns the competing writer.
CREATE TABLE public.bootstrap_test_capture(payload jsonb NOT NULL);
CREATE FUNCTION public.bootstrap_test_capture_begin() RETURNS void LANGUAGE plpgsql AS $fn$
DECLARE run_id uuid:=gen_random_uuid();capture jsonb;
BEGIN
 PERFORM set_config('request.jwt.claim.role','service_role',true);
 PERFORM set_config('request.jwt.claims','{"role":"service_role"}',true);
 UPDATE public.analytics_legacy_bootstrap_run SET lease_until=NULL,pause_until=NULL;
 PERFORM public.dispatch_analytics_legacy_bootstrap(run_id);
 capture:=public.begin_analytics_legacy_bootstrap('ac030000-0000-4000-8000-000000000012',gen_random_uuid(),run_id);
 ASSERT capture->>'state'='verifying';
 INSERT INTO public.bootstrap_test_capture VALUES(capture);
END;
$fn$;
CREATE FUNCTION public.bootstrap_test_capture_refuse() RETURNS void LANGUAGE plpgsql AS $fn$
DECLARE capture jsonb;result jsonb;evidence jsonb;busy boolean:=false;
BEGIN
 PERFORM set_config('request.jwt.claim.role','service_role',true);
 PERFORM set_config('request.jwt.claims','{"role":"service_role"}',true);
 SELECT payload INTO STRICT capture FROM public.bootstrap_test_capture;
 evidence:=jsonb_build_object('app_id','200001','token_type','USER','provider_user_id','300101','page_id','100101','instagram_user_id','178101',
  'verified_at',clock_timestamp(),'expires_at',clock_timestamp()+interval '1 hour');
 BEGIN
  result:=public.commit_analytics_legacy_bootstrap((capture->>'job_id')::uuid,(capture->>'lease_id')::uuid,(capture->>'revision')::bigint,evidence);
  ASSERT result->>'reason_code'='stale_capture';
 EXCEPTION WHEN SQLSTATE 'MAR05' THEN busy:=true; END;
 ASSERT busy OR result->>'reason_code'='stale_capture';
 ASSERT NOT EXISTS(SELECT 1 FROM public.facebook_user_credential_bindings WHERE social_account_id='ac030000-0000-4000-8000-000000000012');
END;
$fn$;
REVOKE ALL ON FUNCTION public.bootstrap_test_capture_begin(),public.bootstrap_test_capture_refuse() FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.bootstrap_test_wait_writer() RETURNS void LANGUAGE plpgsql AS $fn$
DECLARE attempt integer;
BEGIN
 FOR attempt IN 1..100 LOOP
  IF EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='postora_bootstrap_race' AND wait_event='PgSleep') THEN RETURN; END IF;
  PERFORM pg_sleep(0.01);
 END LOOP;
 RAISE EXCEPTION 'competing writer did not reach its locked barrier';
END;
$fn$;
REVOKE ALL ON FUNCTION public.bootstrap_test_wait_writer() FROM PUBLIC,anon,authenticated,service_role;

SELECT public.bootstrap_test_capture_begin();
SELECT extensions.dblink_send_query('bootstrap_writer',$q$SELECT public.bootstrap_test_race_mutate('reconnect')$q$);
SELECT public.bootstrap_test_wait_writer();
SELECT public.bootstrap_test_capture_refuse();
SELECT * FROM extensions.dblink_get_result('bootstrap_writer') AS writer_done(done boolean);
SELECT * FROM extensions.dblink_get_result('bootstrap_writer') AS writer_drained(done boolean);
SELECT public.bootstrap_test_capture_refuse();
DELETE FROM public.analytics_legacy_bootstrap_jobs WHERE social_account_id='ac030000-0000-4000-8000-000000000012';
TRUNCATE public.bootstrap_test_capture;

SELECT public.bootstrap_test_capture_begin();
SELECT extensions.dblink_send_query('bootstrap_writer',$q$SELECT public.bootstrap_test_race_mutate('disconnect')$q$);
SELECT public.bootstrap_test_wait_writer();
SELECT public.bootstrap_test_capture_refuse();
SELECT * FROM extensions.dblink_get_result('bootstrap_writer') AS writer_done(done boolean);
SELECT * FROM extensions.dblink_get_result('bootstrap_writer') AS writer_drained(done boolean);
SELECT public.bootstrap_test_capture_refuse();
DELETE FROM public.analytics_legacy_bootstrap_jobs WHERE social_account_id='ac030000-0000-4000-8000-000000000012';
UPDATE public.social_accounts SET is_active=true WHERE id='ac030000-0000-4000-8000-000000000012';
TRUNCATE public.bootstrap_test_capture;

SELECT public.bootstrap_test_capture_begin();
SELECT extensions.dblink_send_query('bootstrap_writer',$q$SELECT public.bootstrap_test_race_mutate('token_refresh')$q$);
SELECT public.bootstrap_test_wait_writer();
SELECT public.bootstrap_test_capture_refuse();
SELECT * FROM extensions.dblink_get_result('bootstrap_writer') AS writer_done(done boolean);
SELECT * FROM extensions.dblink_get_result('bootstrap_writer') AS writer_drained(done boolean);
SELECT public.bootstrap_test_capture_refuse();
DELETE FROM public.analytics_legacy_bootstrap_jobs WHERE social_account_id='ac030000-0000-4000-8000-000000000012';
TRUNCATE public.bootstrap_test_capture;

SELECT public.bootstrap_test_capture_begin();
SELECT extensions.dblink_send_query('bootstrap_writer',$q$SELECT public.bootstrap_test_race_mutate('shared_set')$q$);
SELECT public.bootstrap_test_wait_writer();
SELECT public.bootstrap_test_capture_refuse();
SELECT * FROM extensions.dblink_get_result('bootstrap_writer') AS writer_done(done boolean);
SELECT * FROM extensions.dblink_get_result('bootstrap_writer') AS writer_drained(done boolean);
SELECT public.bootstrap_test_capture_refuse();
DELETE FROM public.analytics_legacy_bootstrap_jobs WHERE social_account_id='ac030000-0000-4000-8000-000000000012';
TRUNCATE public.bootstrap_test_capture;

SELECT public.bootstrap_test_capture_begin();
SELECT extensions.dblink_send_query('bootstrap_writer',$q$SELECT public.bootstrap_test_race_mutate('capability_aba')$q$);
SELECT public.bootstrap_test_wait_writer();
SELECT public.bootstrap_test_capture_refuse();
SELECT * FROM extensions.dblink_get_result('bootstrap_writer') AS writer_done(done boolean);
SELECT * FROM extensions.dblink_get_result('bootstrap_writer') AS writer_drained(done boolean);
SELECT public.bootstrap_test_capture_refuse();

SELECT extensions.dblink_disconnect('bootstrap_writer');
BEGIN;
UPDATE public.app_settings a SET value=s.value FROM public.bootstrap_race_saved_settings s WHERE a.key=s.key;
DELETE FROM auth.users WHERE id='ac030000-0000-4000-8000-000000000001';
DELETE FROM public.analytics_legacy_bootstrap_epochs WHERE subject_id::text LIKE 'ac030000-%';
UPDATE public.analytics_legacy_bootstrap_run SET holder=NULL,lease_until=NULL,calls=0,pause_until=NULL;
DROP TABLE public.bootstrap_test_capture,public.bootstrap_race_saved_settings;
DROP FUNCTION public.bootstrap_test_race_mutate(text),public.bootstrap_test_capture_begin(),public.bootstrap_test_capture_refuse(),public.bootstrap_test_wait_writer();
COMMIT;
\echo === analytics_legacy_bootstrap_races: ALL CHECKS PASSED ===
