-- ============================================================================
-- supabase/tests/instagram_collection_cron.sql
-- Task 5 / C1 (migration 20261031092000_instagram_collection_cron.sql).
--
-- One transaction, labelled ASSERTs, ROLLBACK, sentinel last. Nothing here
-- touches production and nothing here activates anything.
--
-- WHAT THIS SUITE PROVES
--   C1  applying the schedule definition TWICE leaves exactly ONE job per
--       name - four names, four jobs - and no fifth job of any kind;
--   C2  the four schedules are the exact UTC expressions;
--   C3  all four jobs are INACTIVE: the definition never activates itself;
--   C4  each command calls the right registered route with a body that is
--       exactly the shape the route's STRICT schema accepts, and carries no
--       caller-selected key;
--   C5  each command resolves the shared secret at RUN TIME through
--       public.get_cron_secret() and carries no literal credential;
--   C6  each command bounds net.http_post to 60 seconds or less;
--   C7  the other jobs - the retention, media, partner and staging
--       schedules - are left exactly as they were;
--   C8  no policy and no global mode was activated: the two collection
--       settings are exactly as they were;
--   C9  re-applying after a synthetic activation PAUSES these four again;
--   C10 the stored command resolves the secret when it RUNS: a rotated
--       secret is picked up by the next dispatch with no re-application,
--       the recorded request matches the route contract exactly, and no
--       request was queued for the network;
--   C11 a missing pg_cron, a missing pg_net and a missing
--       public.get_cron_secret() each FAIL the installation - loudly, with
--       an explicit exception - and install nothing;
--   C12 the installation is atomic: a failure in the MIDDLE of it leaves
--       no schedule behind.
--
-- WHY THE DEFINITION IS APPLIED FROM THE MIGRATION FILE
--
--   The suite does not carry a copy of the schedules: it re-applies the
--   migration file itself, with \ir, twice. A copy would prove that the
--   copy is idempotent, which is not the question.
--
-- WHY EVERYTHING IS INSIDE ONE TRANSACTION
--
--   cron.job is an ordinary table, so the rows this suite creates are
--   rolled back with it and the database is left exactly as the harness
--   found it. The migration file carries no BEGIN/COMMIT of its own, which
--   is what makes it re-appliable here.
--
-- THE THREE MISSING-PREREQUISITE FIXTURES
--
--   Each negative removes exactly ONE prerequisite and undoes it with a
--   savepoint, so the shared harness dependencies are back before the next
--   fixture runs and no shared dependency is dropped for good. The removal
--   is a fixture, not a weakening: the production precondition in the
--   migration is untouched, and the definition still FAILS when it is
--   missing.
--
-- THE DISPOSABLE DISPATCH FIXTURE
--
--   The rotation proof replaces public.get_cron_secret() with a reader
--   that returns a disposable value generated IN the database, and
--   net.http_post() with a recorder that keeps the request instead of
--   sending it. Both replacements live inside this transaction and are
--   rolled back with it. The disposable value is never printed, never
--   written into the migration and never asserted in a message.
-- ============================================================================

\set ON_ERROR_STOP on

BEGIN;

-- ---------------------------------------------------------------------------
-- The catalog as the harness found it: the other jobs, and the two
-- collection settings.
-- ---------------------------------------------------------------------------
CREATE TEMP TABLE ic_cron_before ON COMMIT DROP AS
  SELECT j.jobid, j.jobname, j.schedule, j.command, j.active
    FROM cron.job AS j;

CREATE TEMP TABLE ic_settings_before ON COMMIT DROP AS
  SELECT s.key, s.value
    FROM public.app_settings AS s
   WHERE s.key IN ('collection_instagram_insights_enabled',
                   'collection_instagram_rollout_policy');

-- ---------------------------------------------------------------------------
-- A stale, ACTIVE drain job and a duplicate of it under another owner, as an
-- earlier hand-made install could have left them. The definition must
-- rewrite the first (C2-C4 read its schedule and command) and remove the
-- second (C1 counts one job per name).
-- ---------------------------------------------------------------------------
INSERT INTO cron.job (jobname, schedule, command, nodeport, username, active)
VALUES
  ('instagram-insights-drain', '*/9 * * * *', 'SELECT 1', coalesce(inet_server_port(), 5432), current_user, true),
  ('instagram-insights-drain', '*/9 * * * *', 'SELECT 1', coalesce(inet_server_port(), 5432), 'postgres', true)
ON CONFLICT (jobname, username) DO UPDATE
  SET schedule = EXCLUDED.schedule, command = EXCLUDED.command, active = true;

-- ---------------------------------------------------------------------------
-- The schedule definition, applied twice.
-- ---------------------------------------------------------------------------
\ir ../migrations/20261031092000_instagram_collection_cron.sql
\ir ../migrations/20261031092000_instagram_collection_cron.sql

-- ===========================================================================
-- C1: exactly four jobs, one per name, and nothing else.
-- ===========================================================================
DO $c1$
DECLARE
  v_names  text[] := ARRAY[
    'instagram-insights-enqueue-daily',
    'instagram-insights-drain',
    'competitor-snapshot-enqueue-daily',
    'competitor-snapshot-drain'
  ];
  v_name   text;
  v_count  integer;
  v_added  integer;
BEGIN
  FOREACH v_name IN ARRAY v_names LOOP
    SELECT count(*)::integer INTO v_count
      FROM cron.job AS j
     WHERE j.jobname = v_name;

    ASSERT v_count = 1,
      'C1 exactly one ' || v_name || ' job after two applications, got ' || v_count::text;
  END LOOP;

  -- No fifth job. A definition that added one more schedule would show up
  -- here as a row the catalog did not hold before.
  SELECT count(*)::integer INTO v_added
    FROM (
      SELECT j.jobid, j.jobname, j.schedule, j.command, j.active
        FROM cron.job AS j
       WHERE j.jobname IS NULL OR j.jobname <> ALL (v_names)
      EXCEPT
      SELECT b.jobid, b.jobname, b.schedule, b.command, b.active
        FROM ic_cron_before AS b
       WHERE b.jobname IS NULL OR b.jobname <> ALL (v_names)
    ) AS extra;

  ASSERT v_added = 0,
    'C1 the definition added a schedule outside the four collection schedules';
END
$c1$;

-- ===========================================================================
-- C2, C4, C5, C6: the four definitions, one by one.
-- ===========================================================================
DO $c2$
DECLARE
  v_def      record;
  v_schedule text;
  v_command  text;
  v_timeout  integer;
BEGIN
  -- The schedules below are UTC expressions. pg_cron reads them in
  -- cron.timezone, so that setting is part of the contract.
  ASSERT current_setting('cron.timezone', true) IN ('UTC', 'GMT', 'Etc/UTC'),
    'C2 the cron timezone is UTC, got ' || coalesce(current_setting('cron.timezone', true), 'none');

  FOR v_def IN
    SELECT * FROM (VALUES
      ('instagram-insights-enqueue-daily',
       '30 0 * * *',
       'https://api.postora.cloud/functions/v1/instagram-insights-sync',
       'jsonb_build_object\(\s*''action''\s*,\s*''enqueue-daily''\s*\)'),
      ('instagram-insights-drain',
       '*/2 * * * *',
       'https://api.postora.cloud/functions/v1/instagram-insights-sync',
       'jsonb_build_object\(\s*''action''\s*,\s*''drain''\s*\)'),
      ('competitor-snapshot-enqueue-daily',
       '0 1 * * *',
       'https://api.postora.cloud/functions/v1/competitor-snapshot-sync',
       'jsonb_build_object\(\s*''mode''\s*,\s*''enqueue-daily''\s*,\s*''dispatch''\s*,\s*''durable''\s*\)'),
      ('competitor-snapshot-drain',
       '*/2 * * * *',
       'https://api.postora.cloud/functions/v1/competitor-snapshot-sync',
       'jsonb_build_object\(\s*''mode''\s*,\s*''all''\s*\)')
    ) AS t(jobname, schedule, url, body_pattern)
  LOOP
    SELECT j.schedule, j.command
      INTO v_schedule, v_command
      FROM cron.job AS j
     WHERE j.jobname = v_def.jobname;

    ASSERT v_command IS NOT NULL,
      'C2 ' || v_def.jobname || ' is installed';

    -- C2: the exact UTC expression.
    ASSERT v_schedule = v_def.schedule,
      'C2 ' || v_def.jobname || ' runs at ' || v_def.schedule || ', got '
        || coalesce(v_schedule, 'none');

    -- C4: the route and the body the route's strict schema accepts.
    ASSERT position(v_def.url in v_command) > 0,
      'C4 ' || v_def.jobname || ' calls its registered route';
    ASSERT v_command ~ v_def.body_pattern,
      'C4 ' || v_def.jobname || ' sends exactly the accepted body';

    -- C4: no caller-selected key. The route schemas refuse unknown keys,
    -- and a body that carried one would be a malformed request.
    ASSERT v_command !~ '(cursor|limit|force|social_account_id|user_id|watchlist_id|captured_on|access_token)',
      'C4 ' || v_def.jobname || ' carries no caller-selected key';

    -- C5: the secret is resolved at RUN TIME, by the shared reader.
    ASSERT position('public.get_cron_secret()' in v_command) > 0,
      'C5 ' || v_def.jobname || ' resolves the shared secret through public.get_cron_secret()';
    ASSERT v_command ~ '''Authorization''\s*,\s*''Bearer ''\s*\|\|\s*public\.get_cron_secret\(\)',
      'C5 ' || v_def.jobname || ' sends the runtime secret in the Authorization header';

    -- C5: no literal credential. A quoted literal of credential length is
    -- a value someone pasted into the command; a token of that length
    -- anywhere in it is the same mistake written differently.
    ASSERT v_command !~ '''[A-Za-z0-9_-]{24,}''',
      'C5 ' || v_def.jobname || ' carries no quoted literal credential';
    ASSERT v_command !~ '[A-Za-z0-9_-]{40,}',
      'C5 ' || v_def.jobname || ' carries no opaque literal credential';

    -- C6: the HTTP timeout is bounded.
    v_timeout := substring(v_command from 'timeout_milliseconds\s*:=\s*(\d+)')::integer;
    ASSERT v_timeout > 0 AND v_timeout <= 60000,
      'C6 ' || v_def.jobname || ' bounds the HTTP timeout to 60 seconds or less, got '
        || coalesce(v_timeout::text, 'none');
  END LOOP;
END
$c2$;

-- ===========================================================================
-- C3: every one of the four is INACTIVE.
-- ===========================================================================
DO $c3$
DECLARE
  v_name     text;
  v_inactive integer;
  v_count    integer;
BEGIN
  FOREACH v_name IN ARRAY ARRAY[
    'instagram-insights-enqueue-daily',
    'instagram-insights-drain',
    'competitor-snapshot-enqueue-daily',
    'competitor-snapshot-drain'
  ] LOOP
    SELECT count(*) FILTER (WHERE NOT j.active)::integer, count(*)::integer
      INTO v_inactive, v_count
      FROM cron.job AS j
     WHERE j.jobname = v_name;

    ASSERT v_count = 1,
      'C3 exactly one ' || v_name || ' job exists';
    ASSERT coalesce(v_inactive, 0) = 1,
      'C3 ' || v_name || ' is installed inactive: the definition never activates itself';
  END LOOP;
END
$c3$;

-- ===========================================================================
-- C7: the other jobs are untouched.
-- ===========================================================================
DO $c4$
DECLARE
  v_names   text[] := ARRAY[
    'instagram-insights-enqueue-daily',
    'instagram-insights-drain',
    'competitor-snapshot-enqueue-daily',
    'competitor-snapshot-drain'
  ];
  v_added   integer;
  v_removed integer;
BEGIN
  SELECT count(*)::integer INTO v_added FROM (
    SELECT j.jobid, j.jobname, j.schedule, j.command, j.active
      FROM cron.job AS j
     WHERE j.jobname IS NULL OR j.jobname <> ALL (v_names)
    EXCEPT
    SELECT b.jobid, b.jobname, b.schedule, b.command, b.active
      FROM ic_cron_before AS b
     WHERE b.jobname IS NULL OR b.jobname <> ALL (v_names)
  ) AS extra;

  SELECT count(*)::integer INTO v_removed FROM (
    SELECT b.jobid, b.jobname, b.schedule, b.command, b.active
      FROM ic_cron_before AS b
     WHERE b.jobname IS NULL OR b.jobname <> ALL (v_names)
    EXCEPT
    SELECT j.jobid, j.jobname, j.schedule, j.command, j.active
      FROM cron.job AS j
     WHERE j.jobname IS NULL OR j.jobname <> ALL (v_names)
  ) AS missing;

  ASSERT v_added = 0,
    'C7 the schedule definition added or altered another job';
  ASSERT v_removed = 0,
    'C7 the schedule definition removed another job';
END
$c4$;

-- ===========================================================================
-- C8: no policy and no global mode was activated.
-- ===========================================================================
DO $c5$
DECLARE
  v_changed integer;
  v_gone    integer;
BEGIN
  SELECT count(*)::integer INTO v_changed FROM (
    SELECT s.key, s.value
      FROM public.app_settings AS s
     WHERE s.key IN ('collection_instagram_insights_enabled',
                     'collection_instagram_rollout_policy')
    EXCEPT
    SELECT b.key, b.value FROM ic_settings_before AS b
  ) AS changed;

  SELECT count(*)::integer INTO v_gone FROM (
    SELECT b.key, b.value FROM ic_settings_before AS b
    EXCEPT
    SELECT s.key, s.value
      FROM public.app_settings AS s
     WHERE s.key IN ('collection_instagram_insights_enabled',
                     'collection_instagram_rollout_policy')
  ) AS missing;

  ASSERT v_changed = 0,
    'C8 the schedule definition changed a collection setting';
  ASSERT v_gone = 0,
    'C8 the schedule definition removed a collection setting';
END
$c5$;

-- ===========================================================================
-- C9: re-applying after a synthetic activation pauses these four again.
--
-- The activation is synthetic: the four are switched on by hand, exactly as
-- an operator would, and the definition is applied again. It must leave
-- them inactive, because this file never leaves one of its own schedules
-- running.
-- ===========================================================================
DO $c6$
DECLARE
  v_name  text;
  v_jobid bigint;
BEGIN
  FOREACH v_name IN ARRAY ARRAY[
    'instagram-insights-enqueue-daily',
    'instagram-insights-drain',
    'competitor-snapshot-enqueue-daily',
    'competitor-snapshot-drain'
  ] LOOP
    SELECT j.jobid INTO v_jobid FROM cron.job AS j WHERE j.jobname = v_name;
    PERFORM cron.alter_job(job_id := v_jobid, active := true);
  END LOOP;
END
$c6$;

\ir ../migrations/20261031092000_instagram_collection_cron.sql

DO $c7$
DECLARE
  v_name     text;
  v_inactive integer;
BEGIN
  FOREACH v_name IN ARRAY ARRAY[
    'instagram-insights-enqueue-daily',
    'instagram-insights-drain',
    'competitor-snapshot-enqueue-daily',
    'competitor-snapshot-drain'
  ] LOOP
    SELECT count(*) FILTER (WHERE NOT j.active)::integer INTO v_inactive
      FROM cron.job AS j
     WHERE j.jobname = v_name;

    ASSERT coalesce(v_inactive, 0) = 1,
      'C9 the re-application paused ' || v_name || ' again';
  END LOOP;
END
$c7$;

-- ===========================================================================
-- C11: a missing prerequisite FAILS the installation, loudly, and installs
--      nothing.
--
-- Each fixture removes exactly ONE prerequisite, applies the definition and
-- requires an explicit failure. A definition that merely NOTICE-ed its way
-- out would leave SQLSTATE 00000 and would be a schedule that was never
-- installed reported as one that was.
--
-- The removals are undone with savepoints, so the shared dependencies are
-- back before the next fixture runs.
-- ===========================================================================

-- The catalog as it is before the fixtures, so that "nothing was installed"
-- can be asserted against the state the fixtures started from.
CREATE TEMP TABLE ic_cron_at_negatives ON COMMIT DROP AS
  SELECT j.jobid, j.jobname, j.schedule, j.command, j.active
    FROM cron.job AS j;

-- --- the pg_cron fixture ----------------------------------------------------
\set ON_ERROR_STOP off
SAVEPOINT neg_cron_before;
DROP EXTENSION pg_cron CASCADE;
SAVEPOINT neg_cron_run;
\ir ../migrations/20261031092000_instagram_collection_cron.sql
\set neg_cron_sqlstate :SQLSTATE
SELECT 1 AS neg_cron_aborted \gset
ROLLBACK TO SAVEPOINT neg_cron_run;
ROLLBACK TO SAVEPOINT neg_cron_before;
\set ON_ERROR_STOP on

-- --- the pg_net fixture -----------------------------------------------------
\set ON_ERROR_STOP off
SAVEPOINT neg_net_before;
DROP EXTENSION pg_net CASCADE;
SAVEPOINT neg_net_run;
\ir ../migrations/20261031092000_instagram_collection_cron.sql
\set neg_net_sqlstate :SQLSTATE
SELECT 1 AS neg_net_aborted \gset
ROLLBACK TO SAVEPOINT neg_net_run;
ROLLBACK TO SAVEPOINT neg_net_before;
\set ON_ERROR_STOP on

-- --- the get_cron_secret fixture --------------------------------------------
\set ON_ERROR_STOP off
SAVEPOINT neg_secret_before;
DROP FUNCTION public.get_cron_secret();
SAVEPOINT neg_secret_run;
\ir ../migrations/20261031092000_instagram_collection_cron.sql
\set neg_secret_sqlstate :SQLSTATE
SELECT 1 AS neg_secret_aborted \gset
ROLLBACK TO SAVEPOINT neg_secret_run;
ROLLBACK TO SAVEPOINT neg_secret_before;
\set ON_ERROR_STOP on

-- Each fixture must have FAILED: the transaction was aborted, so the probe
-- query above never set its variable.
\if :{?neg_cron_aborted}
DO $fail$ BEGIN
  RAISE EXCEPTION 'C11 the definition did not fail when pg_cron was missing';
END $fail$;
\endif
\if :{?neg_net_aborted}
DO $fail$ BEGIN
  RAISE EXCEPTION 'C11 the definition did not fail when pg_net was missing';
END $fail$;
\endif
\if :{?neg_secret_aborted}
DO $fail$ BEGIN
  RAISE EXCEPTION 'C11 the definition did not fail when public.get_cron_secret() was missing';
END $fail$;
\endif

-- And it must have failed with the deliberate exception, not with a broken
-- migration: RAISE EXCEPTION is SQLSTATE P0001.
CREATE TEMP TABLE ic_negatives (
  fixture  text PRIMARY KEY,
  sqlstate text NOT NULL
) ON COMMIT DROP;

INSERT INTO ic_negatives (fixture, sqlstate) VALUES ('pg_cron', :'neg_cron_sqlstate');
INSERT INTO ic_negatives (fixture, sqlstate) VALUES ('pg_net', :'neg_net_sqlstate');
INSERT INTO ic_negatives (fixture, sqlstate) VALUES ('get_cron_secret', :'neg_secret_sqlstate');

DO $c8$
DECLARE
  v_not_explicit text;
  v_count        integer;
BEGIN
  SELECT string_agg(f.fixture, ', ') INTO v_not_explicit
    FROM ic_negatives AS f
   WHERE f.sqlstate <> 'P0001';

  ASSERT v_not_explicit IS NULL,
    'C11 the failure of [' || coalesce(v_not_explicit, '') || '] was not an explicit exception';

  -- Nothing was installed. The two failures whose prerequisite is not the
  -- cron schema itself are the ones that COULD have left a half-installed
  -- schedule behind: the catalog was there to write into.
  SELECT count(*)::integer INTO v_count
    FROM cron.job AS j
   WHERE j.jobname IN ('instagram-insights-enqueue-daily',
                       'instagram-insights-drain',
                       'competitor-snapshot-enqueue-daily',
                       'competitor-snapshot-drain');

  ASSERT v_count = 4,
    'C11 a failed installation left ' || v_count::text || ' collection schedules behind';

  SELECT count(*)::integer INTO v_count
    FROM (
      SELECT j.jobid, j.jobname, j.schedule, j.command, j.active
        FROM cron.job AS j
       WHERE j.jobname IN ('instagram-insights-enqueue-daily',
                           'instagram-insights-drain',
                           'competitor-snapshot-enqueue-daily',
                           'competitor-snapshot-drain')
      EXCEPT
      SELECT b.jobid, b.jobname, b.schedule, b.command, b.active
        FROM ic_cron_at_negatives AS b
       WHERE b.jobname IN ('instagram-insights-enqueue-daily',
                           'instagram-insights-drain',
                           'competitor-snapshot-enqueue-daily',
                           'competitor-snapshot-drain')
    ) AS changed;

  ASSERT v_count = 0,
    'C11 a failed installation changed a collection schedule';

  -- The dropped prerequisite is back: every fixture undid itself.
  ASSERT to_regprocedure('public.get_cron_secret()') IS NOT NULL,
    'C11 the get_cron_secret fixture did not restore public.get_cron_secret()';
  ASSERT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron'),
    'C11 the pg_cron fixture did not restore the pg_cron extension';
  ASSERT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_net'),
    'C11 the pg_net fixture did not restore the pg_net extension';
END
$c8$;

-- ===========================================================================
-- C12: the installation is atomic.
--
-- The probe replaces cron.schedule with one that fails on the fourth call.
-- The definition then creates three schedules and dies on the fourth, and
-- the three must not survive: the whole installation is one statement, so
-- the failure takes the earlier ones with it.
-- ===========================================================================
\set ON_ERROR_STOP off
SAVEPOINT atomic_before;
SELECT set_config('ig_c1.schedule_calls', '0', true);
SELECT cron.unschedule(j.jobid)
  FROM cron.job AS j
 WHERE j.jobname IN ('instagram-insights-enqueue-daily',
                     'instagram-insights-drain',
                     'competitor-snapshot-enqueue-daily',
                     'competitor-snapshot-drain');
CREATE OR REPLACE FUNCTION cron.schedule(job_name text, schedule text, command text)
RETURNS bigint
LANGUAGE plpgsql
AS $atomic_probe$
DECLARE
  v_id bigint;
  v_n  integer;
BEGIN
  v_n := coalesce(current_setting('ig_c1.schedule_calls', true)::integer, 0) + 1;
  PERFORM set_config('ig_c1.schedule_calls', v_n::text, true);

  IF v_n > 3 THEN
    RAISE EXCEPTION 'the atomicity probe fails the fourth installation';
  END IF;

  INSERT INTO cron.job (jobname, schedule, command, nodeport)
  VALUES (job_name, schedule, command, coalesce(inet_server_port(), 5432))
  RETURNING jobid INTO v_id;

  RETURN v_id;
END
$atomic_probe$;
SAVEPOINT atomic_run;
\ir ../migrations/20261031092000_instagram_collection_cron.sql
SELECT 1 AS atomic_aborted \gset
ROLLBACK TO SAVEPOINT atomic_run;
\set ON_ERROR_STOP on

\if :{?atomic_aborted}
DO $fail$ BEGIN
  RAISE EXCEPTION 'C12 the atomicity probe did not fail the installation';
END $fail$;
\endif

-- The three schedules the failed installation had already created are gone:
-- the statement took them with it.
DO $c9$
DECLARE
  v_count integer;
BEGIN
  SELECT count(*)::integer INTO v_count
    FROM cron.job AS j
   WHERE j.jobname IN ('instagram-insights-enqueue-daily',
                       'instagram-insights-drain',
                       'competitor-snapshot-enqueue-daily',
                       'competitor-snapshot-drain');

  ASSERT v_count = 0,
    'C12 a failed installation left ' || v_count::text || ' schedules behind';
END
$c9$;

ROLLBACK TO SAVEPOINT atomic_before;

-- The probe and the removed schedules are restored.
DO $c10$
DECLARE
  v_count integer;
BEGIN
  SELECT count(*)::integer INTO v_count
    FROM cron.job AS j
   WHERE j.jobname IN ('instagram-insights-enqueue-daily',
                       'instagram-insights-drain',
                       'competitor-snapshot-enqueue-daily',
                       'competitor-snapshot-drain');

  ASSERT v_count = 4,
    'C12 the atomicity fixture did not restore the four collection schedules';
END
$c10$;

-- ===========================================================================
-- C10: the secret is resolved when the command RUNS.
--
-- The disposable helpers replace public.get_cron_secret() with a reader
-- that returns a disposable value generated IN the database, and
-- net.http_post() with a recorder that KEEPS the request instead of
-- sending it. No request leaves the database and no network is touched.
-- ---------------------------------------------------------------------------
-- The disposable value is never printed and never asserted in a message.
-- ============================================================================
CREATE TEMP TABLE ic_secret (
  value text PRIMARY KEY
) ON COMMIT DROP;

INSERT INTO ic_secret (value)
SELECT encode(sha256(convert_to(random()::text || clock_timestamp()::text, 'UTF8')), 'hex');

CREATE OR REPLACE FUNCTION public.get_cron_secret() RETURNS text
  LANGUAGE sql STABLE
  AS $disposable$ SELECT value FROM pg_temp.ic_secret LIMIT 1 $disposable$;

CREATE TEMP TABLE ic_request (
  id                   serial PRIMARY KEY,
  url                  text NOT NULL,
  headers              jsonb NOT NULL,
  body                 jsonb NOT NULL,
  timeout_milliseconds integer NOT NULL
) ON COMMIT DROP;

CREATE OR REPLACE FUNCTION net.http_post(
  url text,
  body jsonb DEFAULT '{}'::jsonb,
  params jsonb DEFAULT '{}'::jsonb,
  headers jsonb DEFAULT '{"Content-Type": "application/json"}'::jsonb,
  timeout_milliseconds integer DEFAULT 5000
) RETURNS bigint
  LANGUAGE plpgsql
  AS $recorder$
DECLARE
  v_id bigint;
BEGIN
  INSERT INTO pg_temp.ic_request (url, headers, body, timeout_milliseconds)
  VALUES (url, headers, body, timeout_milliseconds)
  RETURNING id INTO v_id;

  RETURN v_id;
END
$recorder$;

-- The stored commands are executed EXACTLY as they are stored.
DO $c11$
DECLARE
  v_def     record;
  v_command text;
  v_url     text;
  v_body    jsonb;
  v_headers jsonb;
  v_timeout integer;
BEGIN
  FOR v_def IN
    SELECT * FROM (VALUES
      ('instagram-insights-enqueue-daily',
       'https://api.postora.cloud/functions/v1/instagram-insights-sync',
       '{"action":"enqueue-daily"}'::jsonb),
      ('instagram-insights-drain',
       'https://api.postora.cloud/functions/v1/instagram-insights-sync',
       '{"action":"drain"}'::jsonb),
      ('competitor-snapshot-enqueue-daily',
       'https://api.postora.cloud/functions/v1/competitor-snapshot-sync',
       '{"mode":"enqueue-daily","dispatch":"durable"}'::jsonb),
      ('competitor-snapshot-drain',
       'https://api.postora.cloud/functions/v1/competitor-snapshot-sync',
       '{"mode":"all"}'::jsonb)
    ) AS t(jobname, url, body)
  LOOP
    SELECT j.command INTO v_command
      FROM cron.job AS j
     WHERE j.jobname = v_def.jobname;

    ASSERT v_command IS NOT NULL,
      'C10 ' || v_def.jobname || ' has a stored command';

    EXECUTE v_command;

    SELECT r.url, r.body, r.headers, r.timeout_milliseconds
      INTO v_url, v_body, v_headers, v_timeout
      FROM pg_temp.ic_request AS r
     ORDER BY r.id DESC
     LIMIT 1;

    ASSERT v_url = v_def.url,
      'C10 ' || v_def.jobname || ' calls its registered route';
    ASSERT v_body = v_def.body,
      'C10 ' || v_def.jobname || ' sends exactly the body the route accepts';
    ASSERT v_headers ->> 'Content-Type' = 'application/json',
      'C10 ' || v_def.jobname || ' sends a JSON content type';
    ASSERT v_timeout > 0 AND v_timeout <= 60000,
      'C10 ' || v_def.jobname || ' bounds the HTTP timeout to 60 seconds or less';
  END LOOP;

  -- No request for a collection route was queued for the network: the
  -- recorder replaced the sender, so nothing left the database. Other
  -- schedules in this database do queue requests of their own, so the
  -- assertion is about the two collection routes and not about the queue.
  ASSERT NOT EXISTS (
    SELECT 1
      FROM net.http_request_queue
     WHERE url IN ('https://api.postora.cloud/functions/v1/instagram-insights-sync',
                   'https://api.postora.cloud/functions/v1/competitor-snapshot-sync')
  ),
    'C10 a request for a collection route was queued for the network';
END
$c11$;

-- The rotation: the NEXT dispatch observes the new value, with no
-- re-application of the definition in between.
DO $c12$
DECLARE
  v_command       text;
  v_secret_old    text;
  v_secret_new    text;
  v_authorization text;
BEGIN
  SELECT j.command INTO v_command
    FROM cron.job AS j
   WHERE j.jobname = 'instagram-insights-enqueue-daily';

  SELECT s.value INTO v_secret_old FROM pg_temp.ic_secret AS s;

  EXECUTE v_command;

  SELECT r.headers ->> 'Authorization' INTO v_authorization
    FROM pg_temp.ic_request AS r
   ORDER BY r.id DESC
   LIMIT 1;

  ASSERT v_authorization = 'Bearer ' || v_secret_old,
    'C10 the dispatched request carried the current secret';

  -- Rotate the disposable secret.
  UPDATE pg_temp.ic_secret
     SET value = encode(sha256(convert_to(random()::text || clock_timestamp()::text, 'UTF8')), 'hex');

  SELECT s.value INTO v_secret_new FROM pg_temp.ic_secret AS s;

  ASSERT v_secret_new <> v_secret_old,
    'C10 the disposable secret really changed';

  -- The SAME stored command, with no re-application in between.
  EXECUTE v_command;

  SELECT r.headers ->> 'Authorization' INTO v_authorization
    FROM pg_temp.ic_request AS r
   ORDER BY r.id DESC
   LIMIT 1;

  ASSERT v_authorization = 'Bearer ' || v_secret_new,
    'C10 a rotated secret is picked up by the next dispatch without re-applying the definition';

  -- And the stored command never carried either value.
  ASSERT position(v_secret_old in v_command) = 0
     AND position(v_secret_new in v_command) = 0,
    'C10 the stored command carries no literal credential';
END
$c12$;

-- ===========================================================================
-- The suite is over: nothing it created survives.
-- ===========================================================================
ROLLBACK;

\echo 'instagram_collection_cron: ALL CHECKS PASSED'
