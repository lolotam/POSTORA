-- ============================================================================
-- supabase/tests/competitor_retention_cron.sql
-- Task 8 / M4 (migration 20261030130000_competitor_retention_cron.sql).
--
-- One transaction, labelled ASSERTs, ROLLBACK, sentinel last. Nothing here
-- touches production and nothing here activates anything.
--
-- WHAT THIS SUITE PROVES
--   C1  applying the schedule definition TWICE leaves exactly ONE job named
--       `competitor-retention` - not two, not zero;
--   C2  that job runs at `20 * * * *`;
--   C3  that job is INACTIVE: the definition never activates itself;
--   C4  its command resolves the shared secret at RUN TIME through
--       public.get_cron_secret() and carries no literal credential;
--   C5  its command calls the retention function and states the dry-run
--       flag, so the function's strict body contract is satisfied by the
--       schedule itself;
--   C6  the other jobs - the media, collection and partner schedules - are
--       left exactly as they were: none added, none removed, none altered.
--
-- WHY THE DEFINITION IS APPLIED FROM THE MIGRATION FILE
--
--   The suite does not carry a copy of the schedule: it re-applies the
--   migration file itself, with \ir, twice. A copy would prove that the
--   copy is idempotent, which is not the question.
--
-- WHY EVERYTHING IS INSIDE ONE TRANSACTION
--
--   cron.job is an ordinary table, so the rows this suite creates are
--   rolled back with it and the database is left exactly as the harness
--   found it. The migration file carries no BEGIN/COMMIT of its own, which
--   is what makes it re-appliable here.
-- ============================================================================

\set ON_ERROR_STOP on

BEGIN;

-- The jobs as they are, before the definition is applied again.
CREATE TEMP TABLE cr_cron_before ON COMMIT DROP AS
  SELECT j.jobid, j.jobname, j.schedule, j.command, j.active
    FROM cron.job AS j;

-- ---------------------------------------------------------------------------
-- The schedule definition, applied twice.
-- ---------------------------------------------------------------------------
\ir ../migrations/20261030130000_competitor_retention_cron.sql
\ir ../migrations/20261030130000_competitor_retention_cron.sql

-- ===========================================================================
-- C1 - C5: the one job, its schedule, its inactive state and its command.
-- ===========================================================================
DO $c1$
DECLARE
  v_count    integer;
  v_schedule text;
  v_active   boolean;
  v_command  text;
BEGIN
  SELECT count(*)::integer INTO v_count
    FROM cron.job
   WHERE jobname = 'competitor-retention';

  ASSERT v_count = 1,
    'C1 exactly one competitor-retention job after two applications, got ' || v_count::text;

  SELECT j.schedule, j.active, j.command
    INTO v_schedule, v_active, v_command
    FROM cron.job AS j
   WHERE j.jobname = 'competitor-retention';

  ASSERT v_schedule = '20 * * * *',
    'C2 the job runs at minute 20 of every hour, got ' || coalesce(v_schedule, 'none');

  ASSERT v_active = false,
    'C3 the job is installed inactive: the definition never activates itself';

  -- The secret is resolved at run time. The stored command is a template.
  ASSERT position('get_cron_secret()' in v_command) > 0,
    'C4 the command resolves the shared secret through public.get_cron_secret()';

  -- The header carries the TEMPLATE 'Bearer ', not a value: the credential
  -- is concatenated at run time from the vault.
  ASSERT position('Bearer ' in v_command) > 0,
    'C4 the command sends the shared secret in the Authorization header';

  -- No literal credential. A quoted literal of credential length is a
  -- value someone pasted into the command; a token of that length
  -- anywhere in it is the same mistake written differently.
  ASSERT v_command !~ '''[A-Za-z0-9_-]{24,}''',
    'C4 the command carries no quoted literal credential';
  ASSERT v_command !~ '[A-Za-z0-9_-]{40,}',
    'C4 the command carries no opaque literal credential';

  -- The command reaches the retention function and satisfies its strict
  -- body contract.
  ASSERT position('functions/v1/competitor-retention' in v_command) > 0,
    'C5 the command calls the competitor-retention function';
  ASSERT position('dry_run' in v_command) > 0,
    'C5 the command states the dry-run flag the function requires';
END
$c1$;

-- ===========================================================================
-- C6: the other jobs are untouched.
-- ===========================================================================
DO $c2$
DECLARE
  v_added   integer;
  v_removed integer;
BEGIN
  SELECT count(*)::integer INTO v_added FROM (
    SELECT j.jobid, j.jobname, j.schedule, j.command, j.active
      FROM cron.job AS j
     WHERE j.jobname <> 'competitor-retention'
    EXCEPT
    SELECT b.jobid, b.jobname, b.schedule, b.command, b.active
      FROM cr_cron_before AS b
     WHERE b.jobname <> 'competitor-retention'
  ) AS extra;

  SELECT count(*)::integer INTO v_removed FROM (
    SELECT b.jobid, b.jobname, b.schedule, b.command, b.active
      FROM cr_cron_before AS b
     WHERE b.jobname <> 'competitor-retention'
    EXCEPT
    SELECT j.jobid, j.jobname, j.schedule, j.command, j.active
      FROM cron.job AS j
     WHERE j.jobname <> 'competitor-retention'
  ) AS missing;

  ASSERT v_added = 0,
    'C6 the schedule definition added or altered another job';
  ASSERT v_removed = 0,
    'C6 the schedule definition removed another job';
END
$c2$;

-- ===========================================================================
-- The suite is over: nothing it created survives.
-- ===========================================================================
ROLLBACK;

\echo 'competitor_retention_cron: ALL CHECKS PASSED'
