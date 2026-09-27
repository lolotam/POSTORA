-- Activate the whatsapp-scheduled-sender cron job (creating it if missing).
--
-- WHY
-- 20260930100000_whatsapp_scheduled_sender.sql installs the job inactive so the
-- old, unfenced sender could never run on it. The fenced sender (PR #219) is
-- deployed and was verified live on 2026-09-28, and production's job was then
-- activated by hand. This records that state, so a database built from the
-- migrations runs the sender too; without it, messages scheduled from the
-- dashboard would stay pending forever.
--
-- If the earlier migration skipped creating the job (get_cron_secret() was not
-- defined yet), it is created here, active. When pg_cron or get_cron_secret()
-- is absent (the harness databases, a bare bootstrap), nothing can be
-- scheduled: that is reported with a NOTICE rather than failing, as for every
-- other cron job in this repo.
--
-- Idempotent: re-running leaves one active job. No BEGIN/COMMIT of its own.
DO $do_activate_scheduled_sender$
DECLARE
  v_jobid bigint;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron')
     OR to_regprocedure('public.get_cron_secret()') IS NULL THEN
    RAISE NOTICE 'whatsapp-scheduled-sender cron not scheduled: pg_cron or get_cron_secret() is missing';
    RETURN;
  END IF;

  SELECT jobid INTO v_jobid FROM cron.job WHERE jobname = 'whatsapp-scheduled-sender';

  IF v_jobid IS NULL THEN
    PERFORM cron.schedule(
      'whatsapp-scheduled-sender',
      '* * * * *',
      $$
      SELECT net.http_post(url := 'https://api.postora.cloud/functions/v1/whatsapp-scheduled-sender', headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || get_cron_secret()), body := '{}'::jsonb);
      $$
    );
  ELSE
    PERFORM cron.alter_job(job_id := v_jobid, active := true);
  END IF;
END $do_activate_scheduled_sender$;
