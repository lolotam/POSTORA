-- =============================================================================
-- Manual SQL migration: update pg_cron jobs to authenticate with CRON_SECRET
-- =============================================================================
--
-- LOCATION NOTE: This file lives under docs/manual-sql/ (NOT supabase/migrations/)
-- because the project rule is that DB changes are delivered as manual SQL only,
-- never executed automatically by the migration runner. The owner runs this
-- file by hand against the self-hosted Postgres on Contabo.
--
-- DO NOT run with `supabase db push` or any automation.
-- The project owner MUST:
--   1. Replace the placeholder <CRON_SECRET_FROM_PRODUCTION_ENV> below with
--      the real CRON_SECRET value taken from the production .env on the VPS
--      (/etc/dokploy/compose/postorasupabase-supabase-j8axyh/code/.env).
--      Do NOT commit the substituted file.
--   2. Connect to the self-hosted Postgres on Contabo (86.48.2.205) and
--      execute the statements in this file inside a transaction.
--   3. Verify with the SELECT in Step 3 — it confirms headers were applied
--      without printing the secret.
--
-- Purpose:
--   After supabase/functions/_shared/cron-auth.ts was added, every protected
--   cron-triggered Edge Function returns 401 unless the caller presents the
--   shared CRON_SECRET. The existing pg_cron jobs call these functions
--   without that header and are now failing. This migration re-registers each
--   job so the HTTP call carries `Authorization: Bearer <CRON_SECRET>`.
--
-- Affected cron jobs (one per protected function):
--   * process-scheduled-posts
--   * process-scheduled-emails
--   * process-scheduled-blog-posts
--   * process-scheduled-flags
--   * observability-collector
--   * cleanup-media
--   * refresh-tokens
--   * send-expiry-reminders
--   * send-weekly-analytics
--
-- URL policy:
--   All HTTP targets MUST use the self-hosted Kong gateway base URL:
--     https://api.postora.cloud/functions/v1/<function>
--   Any legacy `https://efruibswazzuuupgyzmf.supabase.co/functions/v1/...`
--   targets are obsolete and MUST be removed (see Step 1).
--
-- Rollback:
--   To restore the previous unauthenticated schedule, run for each job:
--     SELECT cron.unschedule('<jobname>');
--     SELECT cron.schedule('<jobname>', '<old-schedule>',
--       $$ SELECT net.http_post(
--            url := 'https://api.postora.cloud/functions/v1/<function>',
--            headers := '{"Content-Type":"application/json"}'::jsonb,
--            body := '{}'::jsonb
--          ) $$);
--   This rollback re-introduces the original 401 problem and should only be
--   used as an emergency mitigation, paired with reverting the function
--   sources that import verifyCronAuth.
--
-- Idempotency:
--   `cron.unschedule` raises if the jobname does not exist. The DO block below
--   swallows that specific case so re-runs are safe.
-- =============================================================================

BEGIN;

-- Sanity: required extensions.
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- -----------------------------------------------------------------------------
-- Step 1. Unschedule any prior versions (current names + any legacy variants
-- + any leftover rows pointing at the deprecated Supabase Cloud hostname).
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  v_job text;
  v_jobs text[] := ARRAY[
    'process-scheduled-posts',
    'process-scheduled-emails',
    'process-scheduled-blog-posts',
    'process-scheduled-flags',
    'observability-collector',
    'cleanup-media',
    'refresh-tokens',
    'send-expiry-reminders',
    'send-weekly-analytics',
    -- Legacy / historical names — safe to attempt unschedule.
    'scheduled-posts',
    'scheduled-emails',
    'scheduled-flags',
    'token-refresh',
    'expiry-reminders',
    'weekly-analytics',
    'media-cleanup',
    'observability'
  ];
BEGIN
  FOREACH v_job IN ARRAY v_jobs LOOP
    BEGIN
      PERFORM cron.unschedule(v_job);
    EXCEPTION WHEN OTHERS THEN
      NULL; -- job did not exist; ignore
    END;
  END LOOP;
END $$;

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT jobname
    FROM cron.job
    WHERE command ILIKE '%efruibswazzuuupgyzmf.supabase.co%'
  LOOP
    PERFORM cron.unschedule(r.jobname);
  END LOOP;
END $$;

-- -----------------------------------------------------------------------------
-- Step 2. Re-schedule each protected function with the CRON_SECRET header.
--
-- Replace <CRON_SECRET_FROM_PRODUCTION_ENV> below with the real value from
-- production .env BEFORE running this migration. Do not commit the substituted
-- file.
--
-- Schedules below preserve the prior cadence used in production. Adjust if a
-- different rhythm is desired; cron expressions are intentionally explicit
-- here so the migration is self-contained.
-- -----------------------------------------------------------------------------

SELECT cron.schedule(
  'process-scheduled-posts',
  '* * * * *',
  $$ SELECT net.http_post(
       url     := 'https://api.postora.cloud/functions/v1/process-scheduled-posts',
       headers := '{"Content-Type":"application/json","Authorization":"Bearer <CRON_SECRET_FROM_PRODUCTION_ENV>"}'::jsonb,
       body    := '{}'::jsonb
     ) $$
);

SELECT cron.schedule(
  'process-scheduled-emails',
  '* * * * *',
  $$ SELECT net.http_post(
       url     := 'https://api.postora.cloud/functions/v1/process-scheduled-emails',
       headers := '{"Content-Type":"application/json","Authorization":"Bearer <CRON_SECRET_FROM_PRODUCTION_ENV>"}'::jsonb,
       body    := '{}'::jsonb
     ) $$
);

SELECT cron.schedule(
  'process-scheduled-blog-posts',
  '*/5 * * * *',
  $$ SELECT net.http_post(
       url     := 'https://api.postora.cloud/functions/v1/process-scheduled-blog-posts',
       headers := '{"Content-Type":"application/json","Authorization":"Bearer <CRON_SECRET_FROM_PRODUCTION_ENV>"}'::jsonb,
       body    := '{}'::jsonb
     ) $$
);

SELECT cron.schedule(
  'process-scheduled-flags',
  '*/5 * * * *',
  $$ SELECT net.http_post(
       url     := 'https://api.postora.cloud/functions/v1/process-scheduled-flags',
       headers := '{"Content-Type":"application/json","Authorization":"Bearer <CRON_SECRET_FROM_PRODUCTION_ENV>"}'::jsonb,
       body    := '{}'::jsonb
     ) $$
);

SELECT cron.schedule(
  'observability-collector',
  '*/5 * * * *',
  $$ SELECT net.http_post(
       url     := 'https://api.postora.cloud/functions/v1/observability-collector',
       headers := '{"Content-Type":"application/json","Authorization":"Bearer <CRON_SECRET_FROM_PRODUCTION_ENV>"}'::jsonb,
       body    := '{}'::jsonb
     ) $$
);

SELECT cron.schedule(
  'cleanup-media',
  '0 3 * * *',
  $$ SELECT net.http_post(
       url     := 'https://api.postora.cloud/functions/v1/cleanup-media',
       headers := '{"Content-Type":"application/json","Authorization":"Bearer <CRON_SECRET_FROM_PRODUCTION_ENV>"}'::jsonb,
       body    := '{}'::jsonb
     ) $$
);

SELECT cron.schedule(
  'refresh-tokens',
  '0 * * * *',
  $$ SELECT net.http_post(
       url     := 'https://api.postora.cloud/functions/v1/refresh-tokens',
       headers := '{"Content-Type":"application/json","Authorization":"Bearer <CRON_SECRET_FROM_PRODUCTION_ENV>"}'::jsonb,
       body    := '{}'::jsonb
     ) $$
);

SELECT cron.schedule(
  'send-expiry-reminders',
  '0 9 * * *',
  $$ SELECT net.http_post(
       url     := 'https://api.postora.cloud/functions/v1/send-expiry-reminders',
       headers := '{"Content-Type":"application/json","Authorization":"Bearer <CRON_SECRET_FROM_PRODUCTION_ENV>"}'::jsonb,
       body    := '{}'::jsonb
     ) $$
);

SELECT cron.schedule(
  'send-weekly-analytics',
  '0 10 * * 1',
  $$ SELECT net.http_post(
       url     := 'https://api.postora.cloud/functions/v1/send-weekly-analytics',
       headers := '{"Content-Type":"application/json","Authorization":"Bearer <CRON_SECRET_FROM_PRODUCTION_ENV>"}'::jsonb,
       body    := '{}'::jsonb
     ) $$
);

-- -----------------------------------------------------------------------------
-- Step 3. Verify (after COMMIT). These queries do NOT print the secret.
--   SELECT jobname, schedule FROM cron.job ORDER BY jobname;
--   SELECT jobname,
--          command ILIKE '%Authorization":"Bearer %' AS has_auth_header,
--          command ILIKE '%api.postora.cloud%'      AS uses_self_hosted_url,
--          command ILIKE '%efruibswazzuuupgyzmf%'   AS has_legacy_cloud_url
--   FROM cron.job ORDER BY jobname;
-- All rows should show has_auth_header = true, uses_self_hosted_url = true,
-- has_legacy_cloud_url = false.
-- -----------------------------------------------------------------------------

COMMIT;
