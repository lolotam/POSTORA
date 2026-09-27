-- Activate the whatsapp-scheduled-sender cron job.
--
-- WHY
-- 20260930100000_whatsapp_scheduled_sender.sql installs the job inactive so the
-- old, unfenced sender could never run on it. The fenced sender (PR #219) is
-- deployed and was verified live on 2026-09-28, and production's job was then
-- activated by hand. This records that state, so a database built from the
-- migrations runs the sender too; without it, messages scheduled from the
-- dashboard would stay pending forever.
--
-- Idempotent: a no-op when pg_cron is absent, the job is missing, or it is
-- already active. No BEGIN/COMMIT of its own (the harness wraps the file).
DO $do_activate_scheduled_sender$
DECLARE
  v_jobid bigint;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RETURN;
  END IF;

  SELECT jobid INTO v_jobid
  FROM cron.job
  WHERE jobname = 'whatsapp-scheduled-sender' AND NOT active;

  IF v_jobid IS NOT NULL THEN
    PERFORM cron.alter_job(job_id := v_jobid, active := true);
  END IF;
END $do_activate_scheduled_sender$;
