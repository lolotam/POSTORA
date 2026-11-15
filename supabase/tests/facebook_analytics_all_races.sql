-- Observe two real backends: v2 CAS, policy/ticket and owner/ticket races.
\set ON_ERROR_STOP on
SET statement_timeout='20s';
CREATE EXTENSION IF NOT EXISTS dblink WITH SCHEMA extensions;
BEGIN;
CREATE TABLE public.fb6_race_fixture(kind text PRIMARY KEY,receipt jsonb NOT NULL);
REVOKE ALL ON public.fb6_race_fixture FROM PUBLIC,anon,authenticated,service_role;
INSERT INTO public.fb6_race_fixture SELECT 'settings',jsonb_object_agg(key,value) FROM public.app_settings
 WHERE key IN ('collection_facebook_analytics_enabled','collection_facebook_analytics_policy');
INSERT INTO auth.users(id,email) VALUES
 ('e6900000-0000-4000-8000-000000000001','phase6-race-one@example.invalid'),
 ('e6900000-0000-4000-8000-000000000002','phase6-race-two@example.invalid');
INSERT INTO public.social_accounts(id,user_id,platform,platform_user_id,access_token,is_active,needs_reauth)
 VALUES('e6910000-0000-4000-8000-000000000001','e6900000-0000-4000-8000-000000000001','facebook','869001',gen_random_uuid()::text,true,false);
UPDATE public.app_settings SET value='true' WHERE key='collection_facebook_analytics_enabled';
CREATE FUNCTION public.fb6_race_set(policy jsonb,old jsonb DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql AS $fn$
DECLARE captured jsonb:=COALESCE(old,public.get_facebook_analytics_collection_policy());
BEGIN
 RETURN public.set_facebook_analytics_collection_policy(captured->>'fingerprint',(captured->>'revision')::bigint,policy,'phase6 SQL race','phase6 local only');
END;$fn$;
CREATE FUNCTION public.fb6_race_writer(kind text) RETURNS jsonb LANGUAGE plpgsql AS $fn$
DECLARE r jsonb;
BEGIN
 IF kind='owner' THEN
  UPDATE public.social_accounts SET user_id='e6900000-0000-4000-8000-000000000002' WHERE id='e6910000-0000-4000-8000-000000000001';
  r:='{"ok":true}';
 ELSE r:=public.fb6_race_set('{"version":2,"mode":"off","account_ids":[]}'); END IF;
 ASSERT r->>'ok'='true';
 PERFORM pg_advisory_xact_lock(hashtextextended('phase6-fb-race-barrier',0));
 RETURN r;
END;$fn$;
CREATE FUNCTION public.fb6_race_second(scenario text) RETURNS jsonb LANGUAGE plpgsql AS $fn$
DECLARE captured jsonb;r jsonb;
BEGIN
 PERFORM set_config('request.jwt.claim.role','service_role',true);
 SELECT receipt INTO STRICT captured FROM public.fb6_race_fixture WHERE kind=scenario;
 IF scenario='policy' THEN
  RETURN public.fb6_race_set('{"version":2,"mode":"allowlist","account_ids":[]}',captured->'snapshot');
 END IF;
 BEGIN
  IF scenario='owner' THEN
   PERFORM public.read_fb_analytics_admission_credential((captured#>>'{ticket,account_id}')::uuid,NULL,(captured#>>'{ticket,owner_id}')::uuid);
  ELSE
   PERFORM public.commit_meta_analytics_dispatch_target(captured->'ticket','refused','admission_refused');
  END IF;
  RAISE EXCEPTION 'stale operation committed';
 EXCEPTION WHEN SQLSTATE 'MAH02' OR SQLSTATE 'MAH03' OR SQLSTATE 'MAH04' THEN RETURN jsonb_build_object('refusal',SQLSTATE); END;
END;$fn$;
CREATE FUNCTION public.fb6_race_wait(app text,blocker text DEFAULT NULL) RETURNS void LANGUAGE plpgsql AS $fn$
BEGIN
 FOR attempt IN 1..300 LOOP
  IF EXISTS(SELECT 1 FROM pg_stat_activity a WHERE a.application_name=app AND a.wait_event_type='Lock'
   AND (blocker IS NULL OR EXISTS(SELECT 1 FROM pg_stat_activity b WHERE b.application_name=blocker AND b.pid=ANY(pg_blocking_pids(a.pid))))) THEN RETURN; END IF;
  PERFORM pg_sleep(0.01);
 END LOOP;
 RAISE EXCEPTION 'phase6 expected lock wait not observed: %',app;
END;$fn$;
REVOKE ALL ON FUNCTION public.fb6_race_set(jsonb,jsonb),public.fb6_race_writer(text),public.fb6_race_second(text),public.fb6_race_wait(text,text)
 FROM PUBLIC,anon,authenticated,service_role;
COMMIT;
SELECT extensions.dblink_connect('fb6_writer','dbname='||current_database()||' user='||current_user||' application_name=fb6_writer');
SELECT extensions.dblink_connect('fb6_second','dbname='||current_database()||' user='||current_user||' application_name=fb6_second');
DO $races$
DECLARE scenario text;r jsonb;
BEGIN
 FOREACH scenario IN ARRAY ARRAY['policy','dispatch','owner'] LOOP
  SELECT payload INTO r FROM extensions.dblink('fb6_writer',
   'SELECT public.fb6_race_set(''{"version":2,"mode":"all","account_ids":[]}'')') AS r(payload jsonb);
  ASSERT r->>'ok'='true';
  PERFORM extensions.dblink_exec('fb6_writer',format($sql$
   INSERT INTO public.fb6_race_fixture(kind,receipt)
   SELECT %L,jsonb_build_object('snapshot',public.get_facebook_analytics_collection_policy(),'ticket',
    CASE WHEN %L='policy' THEN NULL ELSE public.next_meta_analytics_dispatch_target('facebook',true)->'ticket' END)
   FROM (SELECT set_config('request.jwt.claim.role','service_role',true)) auth
  $sql$,scenario,scenario));
  PERFORM pg_advisory_lock(hashtextextended('phase6-fb-race-barrier',0));
  PERFORM extensions.dblink_send_query('fb6_writer',format('SELECT public.fb6_race_writer(%L)',scenario));
  PERFORM public.fb6_race_wait('fb6_writer');
  PERFORM extensions.dblink_send_query('fb6_second',format('SELECT public.fb6_race_second(%L)',scenario));
  PERFORM public.fb6_race_wait('fb6_second','fb6_writer');
  RAISE NOTICE 'phase6 observed % writer blocking stale operation',scenario;
  PERFORM pg_advisory_unlock(hashtextextended('phase6-fb-race-barrier',0));
  SELECT payload INTO r FROM extensions.dblink_get_result('fb6_writer') AS r(payload jsonb);
  ASSERT r->>'ok'='true';
  PERFORM * FROM extensions.dblink_get_result('fb6_writer') AS r(payload jsonb);
  SELECT payload INTO r FROM extensions.dblink_get_result('fb6_second') AS r(payload jsonb);
  IF scenario='policy' THEN ASSERT r->>'reason_code'='policy_conflict';
  ELSIF scenario='dispatch' THEN ASSERT r->>'refusal' IN ('MAH03','MAH04');
  ELSE ASSERT r->>'refusal' IN ('MAH02','MAH04'); END IF;
  PERFORM * FROM extensions.dblink_get_result('fb6_second') AS r(payload jsonb);
 END LOOP;
END;$races$;
SELECT extensions.dblink_disconnect('fb6_writer');
SELECT extensions.dblink_disconnect('fb6_second');
BEGIN;
UPDATE public.app_settings s SET value=f.receipt->s.key FROM public.fb6_race_fixture f
 WHERE f.kind='settings' AND f.receipt ? s.key;
DELETE FROM public.meta_analytics_enqueue_sweeps WHERE platform='facebook'
 AND policy_digest IN (SELECT receipt#>>'{ticket,policy_digest}' FROM public.fb6_race_fixture);
DELETE FROM auth.users WHERE id IN ('e6900000-0000-4000-8000-000000000001','e6900000-0000-4000-8000-000000000002');
DROP TABLE public.fb6_race_fixture;
DROP FUNCTION public.fb6_race_set(jsonb,jsonb),public.fb6_race_writer(text),public.fb6_race_second(text),public.fb6_race_wait(text,text);
COMMIT;
RESET statement_timeout;
\echo === facebook_analytics_all_races: ALL CHECKS PASSED ===
