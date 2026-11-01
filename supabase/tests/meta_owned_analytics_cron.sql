-- Exact schedule definitions, runtime secret rotation and fail-closed prerequisites.
\set ON_ERROR_STOP on
BEGIN;
DO $safe$ BEGIN ASSERT current_setting('cron.launch_active_jobs')='off','disposable cron launcher must be off';END;$safe$;
CREATE TEMP TABLE mac_before ON COMMIT DROP AS SELECT jobid,jobname,schedule,command,active FROM cron.job;
CREATE TEMP TABLE mac_settings ON COMMIT DROP AS SELECT key,value FROM public.app_settings;
\ir ../migrations/20261101143000_meta_owned_analytics_cron.sql
\ir ../migrations/20261101143000_meta_owned_analytics_cron.sql
DO $definitions$
DECLARE v_platform text;v_action text;v_count integer;v_row record;
BEGIN
  FOREACH v_platform IN ARRAY ARRAY['facebook','threads'] LOOP
    FOREACH v_action IN ARRAY ARRAY['enqueue-daily','drain','retention'] LOOP
      SELECT count(*) INTO v_count FROM cron.job WHERE jobname=v_platform||'-analytics-'||v_action;
      ASSERT v_count=1,'one job per exact name';
      SELECT * INTO v_row FROM cron.job WHERE jobname=v_platform||'-analytics-'||v_action;
      ASSERT NOT v_row.active,'definition remains inactive';
      ASSERT v_row.schedule=CASE v_action WHEN 'enqueue-daily' THEN '5 * * * *' WHEN 'drain' THEN '*/5 * * * *' ELSE '35 * * * *' END;
      PERFORM cron.alter_job(v_row.jobid,active:=true);
    END LOOP;
  END LOOP;
END;
$definitions$;
\ir ../migrations/20261101143000_meta_owned_analytics_cron.sql
DO $paused$ BEGIN
  ASSERT (SELECT count(*) FROM cron.job WHERE jobname ~ '^(facebook|threads)-analytics-(enqueue-daily|drain|retention)$' AND NOT active)=6;
  ASSERT NOT EXISTS((SELECT jobid,jobname,schedule,command,active FROM cron.job WHERE jobname !~ '^(facebook|threads)-analytics-(enqueue-daily|drain|retention)$')
    EXCEPT (SELECT * FROM mac_before WHERE jobname !~ '^(facebook|threads)-analytics-(enqueue-daily|drain|retention)$')),'unrelated jobs unchanged';
  ASSERT NOT EXISTS((SELECT key,value FROM public.app_settings) EXCEPT (SELECT * FROM mac_settings)),'settings unchanged';
END;$paused$;
SAVEPOINT missing_secret;
ALTER FUNCTION public.get_cron_secret() RENAME TO mac_missing_secret;
\set ON_ERROR_STOP off
\ir ../migrations/20261101143000_meta_owned_analytics_cron.sql
\set observed_state :SQLSTATE
\set ON_ERROR_STOP on
ROLLBACK TO SAVEPOINT missing_secret;
SELECT :'observed_state'='P0001' AS expected_failure \gset
\if :expected_failure
\else
  \echo 'Missing secret prerequisite did not refuse installation'
  \quit 1
\endif
SAVEPOINT missing_net;
DROP EXTENSION pg_net CASCADE;
\set ON_ERROR_STOP off
\ir ../migrations/20261101143000_meta_owned_analytics_cron.sql
\set observed_state :SQLSTATE
\set ON_ERROR_STOP on
ROLLBACK TO SAVEPOINT missing_net;
SELECT :'observed_state'='P0001' AS expected_failure \gset
\if :expected_failure
\else
  \echo 'Missing net prerequisite did not refuse installation'
  \quit 1
\endif
SAVEPOINT missing_cron;
DROP EXTENSION pg_cron CASCADE;
\set ON_ERROR_STOP off
\ir ../migrations/20261101143000_meta_owned_analytics_cron.sql
\set observed_state :SQLSTATE
\set ON_ERROR_STOP on
ROLLBACK TO SAVEPOINT missing_cron;
SELECT :'observed_state'='P0001' AS expected_failure \gset
\if :expected_failure
\else
  \echo 'Missing cron prerequisite did not refuse installation'
  \quit 1
\endif
CREATE TEMP TABLE mac_secret(value text) ON COMMIT DROP;
INSERT INTO mac_secret SELECT encode(sha256(convert_to(random()::text||clock_timestamp()::text,'utf8')),'hex');
CREATE OR REPLACE FUNCTION public.get_cron_secret() RETURNS text LANGUAGE sql STABLE AS $secret$ SELECT value FROM pg_temp.mac_secret LIMIT 1 $secret$;
CREATE TEMP TABLE mac_requests(id bigserial,url text,headers jsonb,body jsonb,timeout_milliseconds integer) ON COMMIT DROP;
CREATE OR REPLACE FUNCTION net.http_post(url text,body jsonb DEFAULT '{}'::jsonb,params jsonb DEFAULT '{}'::jsonb,
  headers jsonb DEFAULT '{"Content-Type":"application/json"}'::jsonb,timeout_milliseconds integer DEFAULT 5000)
RETURNS bigint LANGUAGE plpgsql AS $recorder$
DECLARE v_id bigint;
BEGIN
  INSERT INTO pg_temp.mac_requests(url,headers,body,timeout_milliseconds) VALUES(url,headers,body,timeout_milliseconds) RETURNING id INTO v_id;
  RETURN v_id;
END;
$recorder$;
DO $requests$
DECLARE v_round integer;v_job record;v_request record;v_body jsonb;v_action text;v_platform text;v_secret text;
BEGIN
  FOR v_round IN 1..2 LOOP
    UPDATE pg_temp.mac_secret SET value=encode(sha256(convert_to(random()::text||clock_timestamp()::text,'utf8')),'hex');
    SELECT value INTO v_secret FROM pg_temp.mac_secret;
    FOR v_job IN SELECT * FROM cron.job WHERE jobname ~ '^(facebook|threads)-analytics-(enqueue-daily|drain|retention)$' ORDER BY jobname LOOP
      EXECUTE v_job.command;
      SELECT * INTO v_request FROM pg_temp.mac_requests ORDER BY id DESC LIMIT 1;
      v_platform:=split_part(v_job.jobname,'-',1);v_action:=substring(v_job.jobname FROM '-analytics-(.*)$');
      v_body:=jsonb_build_object('platform',v_platform,'action',v_action);
      IF v_action='retention' THEN v_body:=v_body||jsonb_build_object('dryRun',false); END IF;
      ASSERT v_request.body=v_body,'exact stored request body';
      ASSERT v_request.url='https://api.postora.cloud/functions/v1/meta-owned-analytics-sync';
      ASSERT v_request.headers->>'Authorization'='Bearer '||v_secret,'runtime secret rotation';
      ASSERT v_request.headers->>'Content-Type'='application/json' AND v_request.timeout_milliseconds=60000;
      ASSERT position(v_secret IN v_job.command)=0,'no literal credential stored';
    END LOOP;
  END LOOP;
  ASSERT (SELECT count(*) FROM pg_temp.mac_requests)=12,'all stored commands ran only through recorder';
END;
$requests$;
ROLLBACK;

\echo "meta_owned_analytics_cron: ALL CHECKS PASSED"
