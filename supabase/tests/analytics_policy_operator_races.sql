-- RC-17: two actual backends, observed locks, stale removal/edit and ABA.
-- Self-cleaning committed fixture; run only in the disposable db-harness.
\set ON_ERROR_STOP on
SET statement_timeout='20s';
BEGIN;
CREATE TABLE public.policy_operator_race_fixture AS
 SELECT r.key,s.value,s.key IS NOT NULL AS present,'{}'::jsonb AS capture
 FROM public.analytics_collection_policy_revisions r LEFT JOIN public.app_settings s ON s.key=r.key;
REVOKE ALL ON public.policy_operator_race_fixture FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.policy_operator_race_get(k text) RETURNS jsonb LANGUAGE plpgsql AS $fn$
BEGIN
 IF k='collection_instagram_rollout_policy' THEN RETURN public.get_instagram_collection_rollout_policy(); END IF;
 RETURN public.get_facebook_analytics_collection_policy();
END;$fn$;
CREATE FUNCTION public.policy_operator_race_policy(k text, removed boolean) RETURNS jsonb LANGUAGE sql AS $fn$
 SELECT CASE WHEN k='collection_instagram_rollout_policy' THEN
 jsonb_build_object('version',1,'owners',jsonb_build_object('mode','allowlist','account_ids',CASE WHEN removed THEN '[]'::jsonb ELSE '["02170000-0000-4000-8000-000000000001"]'::jsonb END),
 'competitors',jsonb_build_object('mode','off','targets','[]'::jsonb)) ELSE
 jsonb_build_object('account_ids',CASE WHEN removed THEN '[]'::jsonb ELSE '["02170000-0000-4000-8000-000000000001"]'::jsonb END) END;
$fn$;
CREATE FUNCTION public.policy_operator_race_set(k text,old jsonb,policy jsonb) RETURNS jsonb LANGUAGE plpgsql AS $fn$
BEGIN
 IF k='collection_instagram_rollout_policy' THEN RETURN public.set_instagram_collection_rollout_policy(old->>'fingerprint',(old->>'revision')::bigint,policy,'RC-17 race','RC-17 race authorization'); END IF;
 RETURN public.set_facebook_analytics_collection_policy(old->>'fingerprint',(old->>'revision')::bigint,policy,'RC-17 race','RC-17 race authorization');
END;$fn$;
CREATE FUNCTION public.policy_operator_race_writer(k text) RETURNS jsonb LANGUAGE plpgsql AS $fn$
DECLARE old jsonb; result jsonb;
BEGIN
 SELECT capture INTO STRICT old FROM public.policy_operator_race_fixture WHERE key=k;
 result:=public.policy_operator_race_set(k,old,public.policy_operator_race_policy(k,true));
 ASSERT (result->>'ok')::boolean;
 -- The coordinator owns this barrier until it has observed BOTH backends.
 PERFORM pg_advisory_xact_lock(hashtextextended('RC17-policy-writer-barrier',0));
 RETURN result;
END;$fn$;
CREATE FUNCTION public.policy_operator_race_stale(k text) RETURNS jsonb LANGUAGE plpgsql AS $fn$
DECLARE old jsonb; result jsonb;
BEGIN
 SELECT capture INTO STRICT old FROM public.policy_operator_race_fixture WHERE key=k;
 result:=public.policy_operator_race_set(k,old,public.policy_operator_race_policy(k,false));
 ASSERT result->>'reason_code'='policy_conflict','stale editor must not restore removed account';
 RETURN result;
END;$fn$;
CREATE FUNCTION public.policy_operator_race_maintenance(k text) RETURNS jsonb LANGUAGE plpgsql AS $fn$
BEGIN
 PERFORM 1 FROM public.app_settings WHERE key=k FOR UPDATE;
 PERFORM pg_advisory_xact_lock(hashtextextended('RC17-policy-writer-barrier',0));
 UPDATE public.app_settings SET value=value WHERE key=k;
 RETURN '{"unexpected_maintenance_commit":true}'::jsonb;
END;$fn$;
CREATE FUNCTION public.policy_operator_race_wait(app text, blocker text) RETURNS void LANGUAGE plpgsql AS $fn$
BEGIN
 FOR attempt IN 1..300 LOOP
  IF EXISTS(SELECT 1 FROM pg_stat_activity a WHERE a.application_name=app AND a.wait_event_type='Lock'
   AND (blocker IS NULL OR EXISTS(SELECT 1 FROM pg_stat_activity b WHERE b.application_name=blocker AND b.pid=ANY(pg_blocking_pids(a.pid))))) THEN RETURN; END IF;
  PERFORM pg_sleep(0.01);
 END LOOP;
 RAISE EXCEPTION 'RC17 expected lock wait not observed for %',app;
END;$fn$;
REVOKE ALL ON FUNCTION public.policy_operator_race_get(text),public.policy_operator_race_policy(text,boolean),
 public.policy_operator_race_set(text,jsonb,jsonb),public.policy_operator_race_writer(text),public.policy_operator_race_stale(text),public.policy_operator_race_maintenance(text),public.policy_operator_race_wait(text,text)
 FROM PUBLIC,anon,authenticated,service_role;
COMMIT;
SELECT extensions.dblink_connect('rc17_writer','dbname='||current_database()||' user='||current_user||' application_name=rc17_policy_writer');
SELECT extensions.dblink_connect('rc17_editor','dbname='||current_database()||' user='||current_user||' application_name=rc17_policy_editor');

DO $race$
DECLARE k text; original jsonb; removed jsonb; restored jsonb; result jsonb;
BEGIN
 FOREACH k IN ARRAY ARRAY['collection_instagram_rollout_policy','collection_facebook_analytics_policy'] LOOP
  -- Remote fixture writes commit between steps; the coordinator never holds
  -- a settings/revision lock while waiting for another backend.
  PERFORM extensions.dblink_exec('rc17_writer',format('UPDATE public.app_settings SET value=public.policy_operator_race_policy(%L,false) WHERE key=%L',k,k));
  PERFORM extensions.dblink_exec('rc17_writer',format('UPDATE public.policy_operator_race_fixture SET capture=public.policy_operator_race_get(%L) WHERE key=%L',k,k));
  SELECT capture INTO original FROM public.policy_operator_race_fixture WHERE key=k;
  PERFORM pg_advisory_lock(hashtextextended('RC17-policy-writer-barrier',0));
  PERFORM extensions.dblink_send_query('rc17_writer',format('SELECT public.policy_operator_race_writer(%L)',k));
  PERFORM public.policy_operator_race_wait('rc17_policy_writer',NULL);
  PERFORM extensions.dblink_send_query('rc17_editor',format('SELECT public.policy_operator_race_stale(%L)',k));
  PERFORM public.policy_operator_race_wait('rc17_policy_editor','rc17_policy_writer');
  RAISE NOTICE 'RC17 observed removal writer blocking stale editor: %',k;
  PERFORM pg_advisory_unlock(hashtextextended('RC17-policy-writer-barrier',0));
  SELECT payload INTO result FROM extensions.dblink_get_result('rc17_writer') AS r(payload jsonb);
  PERFORM * FROM extensions.dblink_get_result('rc17_writer') AS r(payload jsonb);
  SELECT payload INTO result FROM extensions.dblink_get_result('rc17_editor') AS r(payload jsonb);
  ASSERT result->>'reason_code'='policy_conflict';
  PERFORM * FROM extensions.dblink_get_result('rc17_editor') AS r(payload jsonb);
  removed:=public.policy_operator_race_get(k);
  ASSERT removed->'policy'=public.policy_operator_race_policy(k,true);
  ASSERT (removed->>'revision')::bigint=(original->>'revision')::bigint+1;
  -- Restore A through fresh CAS in backend A; backend B still holds original
  -- A fingerprint AND revision in its captured edit, across the whole ABA.
  SELECT payload INTO result FROM extensions.dblink('rc17_writer',format(
   'SELECT public.policy_operator_race_set(%L,public.policy_operator_race_get(%L),public.policy_operator_race_policy(%L,false))',k,k,k)) AS r(payload jsonb);
  ASSERT (result->>'ok')::boolean;
  restored:=public.policy_operator_race_get(k);
  ASSERT restored->>'fingerprint'=original->>'fingerprint';
  ASSERT (restored->>'revision')::bigint=(original->>'revision')::bigint+2;
  SELECT payload INTO result FROM extensions.dblink('rc17_editor',format('SELECT public.policy_operator_race_stale(%L)',k)) AS r(payload jsonb);
  ASSERT result->>'reason_code'='policy_conflict','stale edit after A -> B -> A refused';
  ASSERT public.policy_operator_race_get(k)=restored;
  -- The revision tombstone also serializes two creators when there is no
  -- app_settings row to lock. Only the first closed recovery may commit.
  PERFORM extensions.dblink_exec('rc17_writer',format('DELETE FROM public.app_settings WHERE key=%L',k));
  PERFORM extensions.dblink_exec('rc17_writer',format('UPDATE public.policy_operator_race_fixture SET capture=public.policy_operator_race_get(%L) WHERE key=%L',k,k));
  PERFORM pg_advisory_lock(hashtextextended('RC17-policy-writer-barrier',0));
  PERFORM extensions.dblink_send_query('rc17_writer',format('SELECT public.policy_operator_race_writer(%L)',k));
  PERFORM public.policy_operator_race_wait('rc17_policy_writer',NULL);
  PERFORM extensions.dblink_send_query('rc17_editor',format('SELECT public.policy_operator_race_stale(%L)',k));
  PERFORM public.policy_operator_race_wait('rc17_policy_editor','rc17_policy_writer');
  RAISE NOTICE 'RC17 observed missing-row recovery blocking stale creator: %',k;
  PERFORM pg_advisory_unlock(hashtextextended('RC17-policy-writer-barrier',0));
  SELECT payload INTO result FROM extensions.dblink_get_result('rc17_writer') AS r(payload jsonb);
  ASSERT (result->>'ok')::boolean;
  PERFORM * FROM extensions.dblink_get_result('rc17_writer') AS r(payload jsonb);
  SELECT payload INTO result FROM extensions.dblink_get_result('rc17_editor') AS r(payload jsonb);
  ASSERT result->>'reason_code'='policy_conflict';
  PERFORM * FROM extensions.dblink_get_result('rc17_editor') AS r(payload jsonb);
  ASSERT public.policy_operator_race_get(k)->'policy'=public.policy_operator_race_policy(k,true);
  -- Exceptional owner/admin DML locks settings first; CAS locks revision
  -- first. The audit's NOWAIT must abort maintenance rather than deadlock.
  PERFORM extensions.dblink_exec('rc17_writer',format('UPDATE public.policy_operator_race_fixture SET capture=public.policy_operator_race_get(%L) WHERE key=%L',k,k));
  original:=public.policy_operator_race_get(k);
  PERFORM pg_advisory_lock(hashtextextended('RC17-policy-writer-barrier',0));
  PERFORM extensions.dblink_send_query('rc17_editor',format('SELECT public.policy_operator_race_maintenance(%L)',k));
  PERFORM public.policy_operator_race_wait('rc17_policy_editor',NULL);
  PERFORM extensions.dblink_send_query('rc17_writer',format('SELECT public.policy_operator_race_writer(%L)',k));
  PERFORM public.policy_operator_race_wait('rc17_policy_writer','rc17_policy_editor');
  RAISE NOTICE 'RC17 observed settings/revision inversion; maintenance must refuse safely: %',k;
  PERFORM pg_advisory_unlock(hashtextextended('RC17-policy-writer-barrier',0));
  BEGIN
   PERFORM * FROM extensions.dblink_get_result('rc17_editor') AS r(payload jsonb);
   RAISE EXCEPTION 'maintenance must not commit against the CAS revision lock';
  EXCEPTION WHEN lock_not_available THEN NULL; END;
  PERFORM * FROM extensions.dblink_get_result('rc17_editor') AS r(payload jsonb);
  SELECT payload INTO result FROM extensions.dblink_get_result('rc17_writer') AS r(payload jsonb);
  ASSERT (result->>'ok')::boolean,'CAS completes after maintenance rolls back';
  PERFORM * FROM extensions.dblink_get_result('rc17_writer') AS r(payload jsonb);
  ASSERT (public.policy_operator_race_get(k)->>'revision')::bigint=(original->>'revision')::bigint+1,'failed maintenance advances neither policy nor audit revision';
 END LOOP;
END;$race$;
SELECT extensions.dblink_disconnect('rc17_writer');
SELECT extensions.dblink_disconnect('rc17_editor');
BEGIN;
-- Restore content through the trusted owner path; revisions still increase.
UPDATE public.app_settings s SET value=f.value FROM public.policy_operator_race_fixture f WHERE s.key=f.key AND f.present;
DELETE FROM public.app_settings s USING public.policy_operator_race_fixture f WHERE s.key=f.key AND NOT f.present;
DROP TABLE public.policy_operator_race_fixture;
DROP FUNCTION public.policy_operator_race_get(text),public.policy_operator_race_policy(text,boolean),
 public.policy_operator_race_set(text,jsonb,jsonb),public.policy_operator_race_writer(text),public.policy_operator_race_stale(text),public.policy_operator_race_maintenance(text),public.policy_operator_race_wait(text,text);
COMMIT;
RESET statement_timeout;
\echo === analytics_policy_operator_races: ALL CHECKS PASSED ===
