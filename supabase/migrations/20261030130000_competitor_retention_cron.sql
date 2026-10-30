-- ===========================================================================
-- Task 8 / M4 - the inactive hourly schedule of the competitor retention
-- cleanup.
--
-- Plan: docs/plans/2026-10-30-competitor-ui-and-retention.md
--   Task 8 ("Add retention Edge orchestration and inactive cron") and the
--   migration inventory row M4.
--
-- Spec: docs/specs/2026-10-30-competitor-ui-and-retention.md
--   §7 "Retention and concurrency contract" and the acceptance map row
--   T8-10.
--
-- APPLY AS supabase_admin. It owns the schedule below.
--
-- ===========================================================================
--
-- WHAT THIS IS
--
--   ONE job, `competitor-retention`, that calls the retention Edge function
--   once an hour at minute 20 UTC. It is installed INACTIVE.
--
-- WHAT IT IS NOT
--
--   * It is NOT the cleanup. The cleanup is the bounded SQL batch
--     (migration M3) and the Edge function that orchestrates it. This file
--     only decides WHEN the function is asked to run.
--   * It is NOT active. The job is created with `active := false`, and a
--     re-application keeps it inactive. Enabling it is a separate,
--     authorized action taken by hand after the migration is verified, the
--     function has booted and a dry run has been reviewed.
--   * It is NOT the switch. `competitor_retention_enabled` is the
--     server-controlled switch and it defaults to false. This schedule
--     stays inert even when it is activated: the SQL refuses to mutate
--     anything while the switch is off, missing or malformed.
--   * It is NOT a second scheduler. The existing media, collection and
--     partner schedules are not touched, not unscheduled and not altered.
--
-- THE SECRET
--
--   The command resolves the shared cron secret at RUN TIME through
--   public.get_cron_secret(), which reads it from the vault. There is no
--   literal credential in this file and none in `cron.job.command`: the
--   stored command is a template, not a secret.
--
-- THE MISSING-PREREQUISITE CONTRACT
--
--   A schedule that was NOT installed must never be reported as one that
--   was. If pg_cron, pg_net or public.get_cron_secret() is missing, this
--   migration FAILS with an exception naming what is missing, instead of
--   quietly doing nothing and leaving an operator with a belief that the
--   cleanup is scheduled.
--
-- IDEMPOTENCE
--
--   Applying this file again leaves exactly one job named
--   `competitor-retention`, with this schedule and this command, and it
--   INACTIVE. Other jobs are left exactly as they were.
--
-- There is no BEGIN/COMMIT of its own: the block below is one atomic
-- statement, and the SQL suite re-applies this file inside its own
-- transaction.
-- ===========================================================================

DO $do_competitor_retention_cron$
DECLARE
  v_jobid  bigint;
  v_ids    bigint[];
  v_extra  bigint;
  v_command text := $cron$
SELECT net.http_post(
  url := 'https://api.postora.cloud/functions/v1/competitor-retention',
  headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'Authorization', 'Bearer ' || get_cron_secret()
  ),
  body := jsonb_build_object('dry_run', false)
);
$cron$;
BEGIN
  ---------------------------------------------------------------------------
  -- 1. The prerequisites. Each one is checked by name, and a missing one
  --    is an exception rather than a NOTICE: a schedule that is not there
  --    must not look like a schedule that is.
  ---------------------------------------------------------------------------
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RAISE EXCEPTION
      'competitor-retention cron NOT installed: the pg_cron extension is missing';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_net') THEN
    RAISE EXCEPTION
      'competitor-retention cron NOT installed: the pg_net extension is missing';
  END IF;

  IF to_regprocedure('public.get_cron_secret()') IS NULL THEN
    RAISE EXCEPTION
      'competitor-retention cron NOT installed: public.get_cron_secret() is missing';
  END IF;

  ---------------------------------------------------------------------------
  -- 2. Exactly one job with this name.
  --
  --    A duplicate can only ever be a duplicate of THIS job - the name is
  --    unique in cron.job - and leaving it would make "one job" a lie. The
  --    ids are collected before anything is removed, so the loop cannot
  --    skip one.
  ---------------------------------------------------------------------------
  SELECT array_agg(jobid ORDER BY jobid) INTO v_ids
    FROM cron.job
   WHERE jobname = 'competitor-retention';

  IF array_length(v_ids, 1) IS NULL THEN
    SELECT cron.schedule('competitor-retention', '20 * * * *', v_command) INTO v_jobid;
  ELSE
    v_jobid := v_ids[1];
    FOR i IN 2..coalesce(array_length(v_ids, 1), 1) LOOP
      v_extra := v_ids[i];
      PERFORM cron.unschedule(v_extra);
    END LOOP;
  END IF;

  ---------------------------------------------------------------------------
  -- 3. The job is INACTIVE, with this schedule and this command.
  --
  --    Re-applying the definition re-asserts all three. That includes the
  --    inactive state: this file never activates its own schedule, and an
  --    activation is a separate, authorized action.
  ---------------------------------------------------------------------------
  PERFORM cron.alter_job(
    job_id  := v_jobid,
    schedule := '20 * * * *',
    command  := v_command,
    active   := false
  );
END
$do_competitor_retention_cron$;
