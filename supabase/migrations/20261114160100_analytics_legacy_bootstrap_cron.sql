-- Reachable dispatch, installed inactive. Applying this migration never enables repair.
DO $schedule$
DECLARE job_id bigint;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_extension WHERE extname='pg_cron') OR
    NOT EXISTS(SELECT 1 FROM pg_extension WHERE extname='pg_net') OR
    to_regprocedure('public.get_cron_secret()') IS NULL THEN RAISE EXCEPTION 'BOOTSTRAP_CRON_PREREQUISITES_MISSING'; END IF;
 job_id:=cron.schedule('analytics-legacy-bootstrap-drain','*/5 * * * *',$command$
  SELECT net.http_post(url:='https://api.postora.cloud/functions/v1/analytics-legacy-bootstrap',
   headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||public.get_cron_secret()),
   body:='{"action":"drain"}'::jsonb,timeout_milliseconds:=45000);
 $command$);
 PERFORM cron.alter_job(job_id,active:=false);
END;
$schedule$;
