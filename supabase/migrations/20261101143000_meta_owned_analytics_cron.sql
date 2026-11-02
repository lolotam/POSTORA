-- One atomic definition, reapplicable inside an outer transaction for rehearsal.
-- The six real handlers are installed inactive; secrets resolve only at runtime.
DO $schedule$
DECLARE v_platform text;v_action text;v_name text;v_schedule text;v_body jsonb;v_command text;v_ids bigint[];v_id bigint;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_extension WHERE extname='pg_cron')
    OR NOT EXISTS(SELECT 1 FROM pg_extension WHERE extname='pg_net')
    OR to_regprocedure('public.get_cron_secret()') IS NULL THEN
    RAISE EXCEPTION 'META_ANALYTICS_CRON_PREREQUISITES_MISSING'; END IF;
  FOREACH v_platform IN ARRAY ARRAY['facebook','threads'] LOOP
    FOREACH v_action IN ARRAY ARRAY['enqueue-daily','drain','retention'] LOOP
      v_name:=v_platform||'-analytics-'||v_action;
      v_schedule:=CASE v_action WHEN 'enqueue-daily' THEN '5 * * * *' WHEN 'drain' THEN '*/5 * * * *' ELSE '35 * * * *' END;
      v_body:=jsonb_build_object('action',v_action,'platform',v_platform);
      IF v_action='retention' THEN v_body:=v_body||jsonb_build_object('dryRun',false); END IF;
      v_command:=format($command$SELECT net.http_post(
  url := 'https://api.postora.cloud/functions/v1/meta-owned-analytics-sync',
  headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || public.get_cron_secret()),
  body := %L::jsonb,
  timeout_milliseconds := 60000
);$command$,v_body::text);
      SELECT array_agg(jobid ORDER BY jobid) INTO v_ids FROM cron.job WHERE jobname=v_name;
      IF cardinality(v_ids)>0 THEN
        v_id:=v_ids[1];
        PERFORM cron.alter_job(v_id,schedule:=v_schedule,command:=v_command,active:=false);
        IF cardinality(v_ids)>1 THEN
          PERFORM cron.unschedule(duplicate_id) FROM unnest(v_ids[2:cardinality(v_ids)]) duplicate_id;
        END IF;
      ELSE
        v_id:=cron.schedule(v_name,v_schedule,v_command);
        PERFORM cron.alter_job(v_id,active:=false);
      END IF;
    END LOOP;
  END LOOP;
END;
$schedule$;
