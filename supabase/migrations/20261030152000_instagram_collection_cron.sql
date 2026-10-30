-- ===========================================================================
-- 20261030152000_instagram_collection_cron.sql
--
-- C1 - the four inactive collection schedules.
--
-- Plan:  docs/plans/2026-10-30-instagram-collection-rollout-controls.md
--         Task 5 ("Install four inactive authenticated schedules - C1").
-- Spec:  docs/specs/2026-10-30-instagram-collection-rollout-controls.md
--         §5 "C1 schedules and deployment dependencies", §7 row RC-12.
--
-- APPLY AS supabase_admin. It owns the schedules below.
--
-- ===========================================================================
--
-- WHAT THIS IS
--
--   FOUR jobs, all INACTIVE, that ask the two registered collection routes
--   to do their bounded work:
--
--     instagram-insights-enqueue-daily    30 0 * * *    owner daily page
--     competitor-snapshot-enqueue-daily   0 1 * * *    competitor daily page
--     instagram-insights-drain             */2 * * * *   owner drain
--     competitor-snapshot-drain           */2 * * * *   competitor drain
--
--   Each job is one authenticated net.http_post with a JSON body that
--   matches the registered route's STRICT schema exactly. Nothing else is
--   scheduled: there is no continuation job, no discovery job, no
--   retention edit and no fifth entry of any kind. The durable
--   continuation is the drain's own bounded resume, not another schedule.
--
-- WHAT IT IS NOT
--
--   * Not an activation. All four jobs are installed INACTIVE. Enabling
--     them is a separate, authorized action taken by hand after the
--     functions have booted and the off-state has been verified.
--   * Not an admission decision. This file never reads or writes
--     `collection_instagram_insights_enabled` and never reads or writes
--     `collection_instagram_rollout_policy`. The master switch and the
--     rollout policy stay exactly as they are; a job that fires while the
--     collection is off is refused by the route, not by the schedule.
--   * Not a second scheduler. The other schedules - the media, the
--     partner, the competitor retention and the AI image staging jobs -
--     are not touched, not unscheduled and not altered.
--
-- THE BODIES
--
--   The route schemas are strict and refuse unknown keys, so the body is
--   exactly the accepted shape and nothing more:
--
--     instagram-insights-sync      {"action":"enqueue-daily"}
--                                  {"action":"drain"}
--     competitor-snapshot-sync     {"mode":"enqueue-daily","dispatch":"durable"}
--                                  {"mode":"all"}
--
--   The competitor's daily body is the DURABLE branch. The legacy
--   cursor branch ("mode":"enqueue-daily" with a cursor or a limit) stays
--   available for its existing caller, and no schedule depends on reading
--   a cursor out of a response.
--
-- THE SECRET
--
--   The command resolves the shared cron secret at RUN TIME through
--   public.get_cron_secret(), which reads it from the vault. The stored
--   command is a template, not a credential: there is no literal secret,
--   no service key, no interpolated value and no secret-bearing URL in
--   this file or in cron.job.command. Rotating the secret needs no
--   re-application - the next execution picks the new value up.
--
-- THE TIMEOUT
--
--   net.http_post is bounded to 60 seconds. The Edge functions enforce
--   their own <=40 second service budget inside that window, so the
--   bound here is the outer ceiling and not the work's budget.
--
-- THE MISSING-PREREQUISITE CONTRACT
--
--   A schedule that was NOT installed must never be reported as one that
--   was. If pg_cron, pg_net or public.get_cron_secret() is missing, this
--   migration FAILS with an exception naming what is missing, instead of
--   quietly doing nothing and leaving an operator with a belief that the
--   collection is scheduled. The prerequisites are checked BEFORE
--   anything is created, and the whole installation is one statement, so
--   a failure leaves no partially installed schedule behind.
--
-- IDEMPOTENCE
--
--   Applying this file again leaves exactly one job per name, with this
--   schedule and this command, and it INACTIVE. Other jobs are left
--   exactly as they were.
--
--   RE-APPLICATION PAUSES. The definition re-asserts the inactive state,
--   so applying it after an operator has activated a job PAUSES that job
--   again. That is deliberate and it is the documented operational
--   effect: this file never leaves one of its own jobs running, and
--   enabling a schedule is always a deliberate, separate act.
--
-- There is no BEGIN/COMMIT of its own: the block below is one atomic
-- statement, and the SQL suite re-applies this file inside its own
-- transaction.
-- ===========================================================================

DO $do_instagram_collection_cron$
DECLARE
  v_def   record;
  v_ids   bigint[];
  v_jobid bigint;
  v_i     integer;
BEGIN
  ---------------------------------------------------------------------------
  -- 1. The prerequisites. Each one is checked by name, and a missing one
  --    is an exception rather than a NOTICE: a schedule that is not there
  --    must not look like a schedule that is. They are checked BEFORE the
  --    first job is touched, so a refusal installs nothing at all.
  ---------------------------------------------------------------------------
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RAISE EXCEPTION
      'instagram collection cron NOT installed: the pg_cron extension is missing';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_net') THEN
    RAISE EXCEPTION
      'instagram collection cron NOT installed: the pg_net extension is missing';
  END IF;

  IF to_regprocedure('public.get_cron_secret()') IS NULL THEN
    RAISE EXCEPTION
      'instagram collection cron NOT installed: public.get_cron_secret() is missing';
  END IF;

  ---------------------------------------------------------------------------
  -- 2. The four schedules.
  --
  --    Each one is reconciled by its own NAME. The ids are collected
  --    before anything is removed, so a duplicate of one of these four is
  --    removed rather than left behind, and a job that is not one of these
  --    four is never read, never written and never unscheduled.
  --
  --    The stored command is a template: the secret is resolved by
  --    public.get_cron_secret() when the job RUNS, not when it is
  --    installed.
  ---------------------------------------------------------------------------
  FOR v_def IN
    SELECT t.jobname, t.schedule, t.command
      FROM (VALUES
        (
          'instagram-insights-enqueue-daily',
          '30 0 * * *',
          $cron$
SELECT net.http_post(
  url := 'https://api.postora.cloud/functions/v1/instagram-insights-sync',
  headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'Authorization', 'Bearer ' || public.get_cron_secret()
  ),
  body := jsonb_build_object('action', 'enqueue-daily'),
  timeout_milliseconds := 60000
);
$cron$
        ),
        (
          'instagram-insights-drain',
          '*/2 * * * *',
          $cron$
SELECT net.http_post(
  url := 'https://api.postora.cloud/functions/v1/instagram-insights-sync',
  headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'Authorization', 'Bearer ' || public.get_cron_secret()
  ),
  body := jsonb_build_object('action', 'drain'),
  timeout_milliseconds := 60000
);
$cron$
        ),
        (
          'competitor-snapshot-enqueue-daily',
          '0 1 * * *',
          $cron$
SELECT net.http_post(
  url := 'https://api.postora.cloud/functions/v1/competitor-snapshot-sync',
  headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'Authorization', 'Bearer ' || public.get_cron_secret()
  ),
  body := jsonb_build_object('mode', 'enqueue-daily', 'dispatch', 'durable'),
  timeout_milliseconds := 60000
);
$cron$
        ),
        (
          'competitor-snapshot-drain',
          '*/2 * * * *',
          $cron$
SELECT net.http_post(
  url := 'https://api.postora.cloud/functions/v1/competitor-snapshot-sync',
  headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'Authorization', 'Bearer ' || public.get_cron_secret()
  ),
  body := jsonb_build_object('mode', 'all'),
  timeout_milliseconds := 60000
);
$cron$
        )
      ) AS t(jobname, schedule, command)
  LOOP
    SELECT array_agg(j.jobid ORDER BY j.jobid) INTO v_ids
      FROM cron.job AS j
     WHERE j.jobname = v_def.jobname;

    IF v_ids IS NULL THEN
      SELECT cron.schedule(v_def.jobname, v_def.schedule, v_def.command) INTO v_jobid;
    ELSE
      v_jobid := v_ids[1];
      FOR v_i IN 2..coalesce(array_length(v_ids, 1), 1) LOOP
        PERFORM cron.unschedule(v_ids[v_i]);
      END LOOP;
    END IF;

    -------------------------------------------------------------------------
    -- 3. The job is INACTIVE, with this schedule and this command.
    --
    --    Re-applying the definition re-asserts all three, including the
    --    inactive state. This file never activates its own schedule, and
    --    an activation is a separate, authorized action.
    -------------------------------------------------------------------------
    PERFORM cron.alter_job(
      job_id   := v_jobid,
      schedule := v_def.schedule,
      command  := v_def.command,
      active   := false
    );
  END LOOP;
END
$do_instagram_collection_cron$;
