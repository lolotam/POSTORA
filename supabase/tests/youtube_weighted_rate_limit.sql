-- YouTube vNext Phase 3B — PR-8A — weighted rate-limit counter SQL proof.
--
-- Proves supabase/migrations/20261127120000_youtube_weighted_rate_limit.sql:
--
--   public.check_weighted_rate_limit(
--       p_key text, p_cost integer, p_max integer, p_window_seconds integer
--   ) RETURNS jsonb   -- { allowed: boolean, count: integer, retry_after: integer }
--
-- Runs as supabase_admin against the disposable baseline-plus-delta database
-- that scripts/db-harness.sh builds. Self-cleaning: every bucket row this
-- suite creates is deleted before the run and again at the end. No provider
-- calls, no network, no real credentials.
--
-- WHY THIS COUNTER EXISTS (spec §4.3 and §10): the project-wide write budget
-- must debit 50 or 400 units in ONE atomic step and must refuse the WHOLE
-- request when the debit would pass the ceiling. `check_rate_limit` adds
-- exactly 1 per call and takes no cost parameter, so it cannot express that,
-- and calling it 400 times is neither atomic nor affordable. The weighted
-- counter is the primitive every later write path (playlist insert, edit
-- save, thumbnail change, caption upload) will debit through, so its
-- failure modes are budget failures, not cosmetic ones.
--
-- What this file proves, in order:
--   1. the first debit creates the bucket, and a debit landing exactly on the
--      ceiling is allowed;
--   2. one unit over the ceiling is refused and leaves the count untouched;
--   3. a refused 400-unit write with 300 left leaves the 300 usable — a
--      refusal never partially debits;
--   4. an expired window resets the counter, and an expired window does not
--      make a write larger than the ceiling acceptable;
--   5. zero, negative and empty arguments raise SQLSTATE 22023;
--   6. two sessions debiting the same bucket concurrently never exceed the
--      ceiling (a real dblink interleaving, with the wait observed);
--   7. only the service role may execute the counter, and it really can;
--   8. `check_rate_limit` still behaves exactly as before and the two
--      counters keep separate bucket keys;
--   9. nothing is left behind.
--
-- `check_rate_limit` is NOT touched by the migration, and that is asserted
-- here rather than assumed: a weighted counter that collided with the
-- legacy `endpoint:identifier` keys would silently corrupt the per-user
-- request limiters that every Edge Function already depends on.

\set ON_ERROR_STOP on
SET plpgsql.check_asserts = on;

CREATE EXTENSION IF NOT EXISTS dblink WITH SCHEMA extensions;

-- IDEMPOTENT RE-RUN. The harness applies every migration newer than the
-- baseline marker before it runs the suites, so the function already exists
-- when this file starts. Re-applying the migration file here is what proves
-- the migration is re-appliable — the runbook tells an operator to apply it
-- by hand, and a migration that can only ever be applied once is a migration
-- that cannot be recovered from.
--
-- If the function does NOT exist, the migration was never applied and every
-- assertion below would fail on a missing function. The preflight block
-- says so in one clear line instead.
SELECT to_regprocedure(
  'public.check_weighted_rate_limit(text,integer,integer,integer)'
) IS NOT NULL AS wrl_migrated \gset

\if :wrl_migrated
\ir ../migrations/20261127120000_youtube_weighted_rate_limit.sql
\endif

-- ── helpers ────────────────────────────────────────────────────────────────

-- The backend PID of a dblink session. Used to attribute a lock wait to the
-- session that holds it.
CREATE FUNCTION pg_temp.wrl_pid(p_session text) RETURNS integer LANGUAGE sql AS
  $$ SELECT pid FROM extensions.dblink(p_session, 'SELECT pg_backend_pid()') AS t(pid int) $$;

-- Block until p_pid waits on p_blocker, or fail loudly.
--
-- The wait IS the proof. A counter that serializes concurrent debits on the
-- bucket row makes the second session wait; if it does not wait, the two
-- debits interleaved and the ceiling assertion below proves nothing.
CREATE FUNCTION pg_temp.wrl_wait_blocked_by(p_pid integer, p_blocker integer, p_label text)
RETURNS void LANGUAGE plpgsql AS $f$
DECLARE
  v_attempt integer := 0;
BEGIN
  LOOP
    PERFORM pg_stat_clear_snapshot();
    EXIT WHEN p_blocker = ANY(pg_blocking_pids(p_pid));
    v_attempt := v_attempt + 1;
    IF v_attempt > 100 THEN
      RAISE EXCEPTION '% was not blocked by % (blockers: %)',
        p_label, p_blocker, pg_blocking_pids(p_pid);
    END IF;
    PERFORM pg_sleep(0.05);
  END LOOP;
END
$f$;

-- Open (or re-open) the two race sessions against this same database.
--
-- dblink refuses a duplicate connection name, so an already-open session is
-- closed first. The membership test is exact: dblink_disconnect raises when
-- the name is not open, and a catch-all around it would hide a real failure.
CREATE FUNCTION pg_temp.wrl_sessions() RETURNS void LANGUAGE plpgsql AS $f$
DECLARE
  v_name text;
BEGIN
  FOREACH v_name IN ARRAY ARRAY['wrl_a', 'wrl_b'] LOOP
    IF v_name = ANY (extensions.dblink_get_connections()) THEN
      PERFORM extensions.dblink_disconnect(v_name);
    END IF;
    PERFORM extensions.dblink_connect(
      v_name,
      format('dbname=%s user=%s application_name=%s',
             current_database(), current_user, v_name));
  END LOOP;
END
$f$;

-- ── preflight ──────────────────────────────────────────────────────────────

DO $preflight$
BEGIN
  ASSERT to_regprocedure(
           'public.check_weighted_rate_limit(text,integer,integer,integer)') IS NOT NULL,
    'public.check_weighted_rate_limit is missing — apply supabase/migrations/20261127120000_youtube_weighted_rate_limit.sql before running this suite';
  ASSERT to_regprocedure(
           'public.check_rate_limit(text,text,integer,integer)') IS NOT NULL,
    'public.check_rate_limit is missing — the legacy counter is this suite''s precondition';
  ASSERT EXISTS (
    SELECT 1 FROM pg_tables
     WHERE schemaname = 'public' AND tablename = 'rate_limit_buckets'),
    'public.rate_limit_buckets is missing — the weighted counter stores its buckets there';
END
$preflight$;

-- Remove anything a previous (possibly interrupted) run left behind, so a
-- re-run starts from the same state as a first run.
DELETE FROM public.rate_limit_buckets
 WHERE bucket_key LIKE 'weighted:wrl-test:%'
    OR bucket_key LIKE 'wrl-test:%';

-- ── 1. the first debit creates the bucket, and the exact ceiling is allowed ──

DO $first_debit_and_exact_ceiling$
DECLARE
  v_result jsonb;
  v_stored integer;
BEGIN
  v_result := public.check_weighted_rate_limit('wrl-test:basic', 50, 100, 3600);
  ASSERT (v_result ->> 'allowed')::boolean
     AND (v_result ->> 'count')::integer = 50
     AND (v_result ->> 'retry_after')::integer = 0,
    format('the first debit creates the bucket and reports the new count: %s', v_result);

  SELECT count INTO v_stored
    FROM public.rate_limit_buckets
   WHERE bucket_key = 'weighted:wrl-test:basic';
  ASSERT v_stored = 50,
    format('the first debit is stored under the weighted: prefix: %s',
           coalesce(v_stored::text, '<no row>'));

  -- Landing exactly on the ceiling is allowed: 50 + 50 = 100 = p_max.
  v_result := public.check_weighted_rate_limit('wrl-test:basic', 50, 100, 3600);
  ASSERT (v_result ->> 'allowed')::boolean
     AND (v_result ->> 'count')::integer = 100
     AND (v_result ->> 'retry_after')::integer = 0,
    format('a debit landing exactly on the ceiling is allowed: %s', v_result);

  SELECT count INTO v_stored
    FROM public.rate_limit_buckets
   WHERE bucket_key = 'weighted:wrl-test:basic';
  ASSERT v_stored = 100,
    format('the exact-ceiling debit is stored: %s',
           coalesce(v_stored::text, '<no row>'));
END
$first_debit_and_exact_ceiling$;

-- ── 2. one unit over the ceiling is refused and changes nothing ────────────

DO $one_unit_over_is_refused$
DECLARE
  v_result jsonb;
  v_stored integer;
BEGIN
  v_result := public.check_weighted_rate_limit('wrl-test:basic', 1, 100, 3600);
  ASSERT NOT (v_result ->> 'allowed')::boolean
     AND (v_result ->> 'count')::integer = 100
     AND (v_result ->> 'retry_after')::integer >= 1,
    format('one unit over the ceiling is refused: %s', v_result);

  SELECT count INTO v_stored
    FROM public.rate_limit_buckets
   WHERE bucket_key = 'weighted:wrl-test:basic';
  ASSERT v_stored = 100,
    format('a refused debit leaves the count unchanged: %s',
           coalesce(v_stored::text, '<no row>'));
END
$one_unit_over_is_refused$;

-- ── 3. a refused write is refused WHOLE — no partial debit ─────────────────

DO $whole_request_refusal$
DECLARE
  v_result jsonb;
  v_stored integer;
BEGIN
  -- The shape the project budget actually uses: a 4000-unit day ceiling
  -- with 3700 already spent.
  v_result := public.check_weighted_rate_limit('wrl-test:budget', 3700, 4000, 86400);
  ASSERT (v_result ->> 'allowed')::boolean
     AND (v_result ->> 'count')::integer = 3700
     AND (v_result ->> 'retry_after')::integer = 0,
    format('the debit that fits is allowed: %s', v_result);

  -- 300 left, 400 requested: refused, and the 300 stay spendable.
  v_result := public.check_weighted_rate_limit('wrl-test:budget', 400, 4000, 86400);
  ASSERT NOT (v_result ->> 'allowed')::boolean
     AND (v_result ->> 'count')::integer = 3700
     AND (v_result ->> 'retry_after')::integer >= 1,
    format('a 400-unit write with 300 left is refused whole: %s', v_result);

  SELECT count INTO v_stored
    FROM public.rate_limit_buckets
   WHERE bucket_key = 'weighted:wrl-test:budget';
  ASSERT v_stored = 3700,
    format('the refused 400-unit write debited nothing: %s',
           coalesce(v_stored::text, '<no row>'));

  v_result := public.check_weighted_rate_limit('wrl-test:budget', 50, 4000, 86400);
  ASSERT (v_result ->> 'allowed')::boolean
     AND (v_result ->> 'count')::integer = 3750
     AND (v_result ->> 'retry_after')::integer = 0,
    format('the 300 units left are still usable for a later 50-unit write: %s', v_result);
END
$whole_request_refusal$;

-- ── 4. an expired window resets the counter ───────────────────────────────

DO $window_expiry$
DECLARE
  v_result jsonb;
  v_stored integer;
BEGIN
  UPDATE public.rate_limit_buckets
     SET window_start = window_start - interval '2 days',
         expires_at   = expires_at   - interval '2 days'
   WHERE bucket_key = 'weighted:wrl-test:budget';
  ASSERT EXISTS (
    SELECT 1 FROM public.rate_limit_buckets
     WHERE bucket_key = 'weighted:wrl-test:budget'),
    'the budget bucket exists before the expiry proof';

  v_result := public.check_weighted_rate_limit('wrl-test:budget', 50, 4000, 86400);
  ASSERT (v_result ->> 'allowed')::boolean
     AND (v_result ->> 'count')::integer = 50
     AND (v_result ->> 'retry_after')::integer = 0,
    format('an expired window resets the counter: %s', v_result);

  -- An expired window does not make an oversized write acceptable: the
  -- ceiling is the ceiling, in every window. This is the case a
  -- fail-open implementation would let through.
  UPDATE public.rate_limit_buckets
     SET window_start = window_start - interval '2 days',
         expires_at   = expires_at   - interval '2 days'
   WHERE bucket_key = 'weighted:wrl-test:budget';

  v_result := public.check_weighted_rate_limit('wrl-test:budget', 5000, 4000, 86400);
  ASSERT NOT (v_result ->> 'allowed')::boolean
     AND (v_result ->> 'count')::integer = 0
     AND (v_result ->> 'retry_after')::integer > 0,
    format('an expired window still refuses a cost above the ceiling: %s', v_result);

  SELECT count INTO v_stored
    FROM public.rate_limit_buckets
   WHERE bucket_key = 'weighted:wrl-test:budget';
  ASSERT v_stored = 0,
    format('the refused oversized write debited nothing: %s',
           coalesce(v_stored::text, '<no row>'));
END
$window_expiry$;

-- ── 5. invalid arguments raise SQLSTATE 22023 ─────────────────────────────

-- Every argument is validated before anything is written: a counter that
-- accepted a zero or negative cost would silently mint budget.
DO $invalid_arguments$
DECLARE
  v_case text;
  v_sqlstate text;
BEGIN
  FOREACH v_case IN ARRAY ARRAY[
    'cost 0', 'cost -10', 'max 0', 'max -1',
    'window 0', 'window -60', 'empty key', 'blank key', 'null key'
  ] LOOP
    v_sqlstate := NULL;
    BEGIN
      CASE v_case
        WHEN 'cost 0'     THEN PERFORM public.check_weighted_rate_limit('wrl-test:invalid', 0, 100, 3600);
        WHEN 'cost -10'   THEN PERFORM public.check_weighted_rate_limit('wrl-test:invalid', -10, 100, 3600);
        WHEN 'max 0'      THEN PERFORM public.check_weighted_rate_limit('wrl-test:invalid', 50, 0, 3600);
        WHEN 'max -1'     THEN PERFORM public.check_weighted_rate_limit('wrl-test:invalid', 50, -1, 3600);
        WHEN 'window 0'   THEN PERFORM public.check_weighted_rate_limit('wrl-test:invalid', 50, 100, 0);
        WHEN 'window -60' THEN PERFORM public.check_weighted_rate_limit('wrl-test:invalid', 50, 100, -60);
        WHEN 'empty key'  THEN PERFORM public.check_weighted_rate_limit('', 50, 100, 3600);
        WHEN 'blank key'  THEN PERFORM public.check_weighted_rate_limit('   ', 50, 100, 3600);
        WHEN 'null key'   THEN PERFORM public.check_weighted_rate_limit(NULL::text, 50, 100, 3600);
      END CASE;
      -- Reaching this line means the call was accepted: the counter is not
      -- validating its arguments and the suite must fail loudly.
      RAISE EXCEPTION 'check_weighted_rate_limit accepted the % case', v_case;
    EXCEPTION
      WHEN invalid_parameter_value THEN
        v_sqlstate := SQLSTATE;
    END;
    ASSERT v_sqlstate = '22023',
      format('the %s case raised %s instead of 22023',
             v_case, coalesce(v_sqlstate, '<no error>'));
  END LOOP;
END
$invalid_arguments$;

-- ── 6. two sessions debiting concurrently never exceed the ceiling ─────────

-- The seed is committed in its own transaction: the two race sessions are
-- separate backends and must SEE the row, so it cannot be left inside the
-- suite's own uncommitted work.
DO $seed_race_bucket$
DECLARE
  v_result jsonb;
BEGIN
  v_result := public.check_weighted_rate_limit('wrl-test:race', 50, 500, 3600);
  ASSERT (v_result ->> 'allowed')::boolean
     AND (v_result ->> 'count')::integer = 50,
    format('the race bucket is seeded with 50 of 500: %s', v_result);
END
$seed_race_bucket$;

SELECT pg_temp.wrl_sessions();

DO $concurrent_weighted_debits$
DECLARE
  v_pid_a integer;
  v_pid_b integer;
  v_a text;
  v_b jsonb;
  v_stored integer;
  v_source text;
BEGIN
  -- Session A opens a transaction and debits 300 of the remaining 450.
  -- The bucket row is locked FOR UPDATE for the life of that transaction.
  PERFORM extensions.dblink_exec('wrl_a', 'BEGIN');
  SELECT res INTO v_a FROM extensions.dblink(
    'wrl_a',
    format('SELECT public.check_weighted_rate_limit(%L, 300, 500, 3600)::text',
           'wrl-test:race')) AS t(res text);

  -- Session B asks for the same 300 and must WAIT for A's row lock.
  v_pid_a := pg_temp.wrl_pid('wrl_a');
  v_pid_b := pg_temp.wrl_pid('wrl_b');
  PERFORM extensions.dblink_send_query(
    'wrl_b',
    format('SELECT public.check_weighted_rate_limit(%L, 300, 500, 3600)',
           'wrl-test:race'));
  PERFORM pg_temp.wrl_wait_blocked_by(
    v_pid_b, v_pid_a, 'the second concurrent weighted debit');

  -- The wait only means something if the serialization is the bucket row
  -- lock the plan specifies, so the body is checked for it too.
  SELECT prosrc INTO v_source
    FROM pg_proc
   WHERE oid = 'public.check_weighted_rate_limit(text,integer,integer,integer)'::regprocedure;
  ASSERT position('for update' in lower(v_source)) > 0
     OR position('for no key update' in lower(v_source)) > 0,
    'the weighted counter serializes concurrent debits with SELECT ... FOR UPDATE on the bucket row';

  -- A commits; B then reads 350 and refuses its own 300.
  PERFORM extensions.dblink_exec('wrl_a', 'COMMIT');

  SELECT res INTO v_b FROM extensions.dblink_get_result('wrl_b') AS t(res jsonb);
  PERFORM * FROM extensions.dblink_get_result('wrl_b') AS t(res jsonb);

  ASSERT (v_a::jsonb ->> 'allowed')::boolean
     AND (v_a::jsonb ->> 'count')::integer = 350,
    format('the first concurrent debit is allowed at 350: %s', v_a);
  ASSERT NOT (v_b ->> 'allowed')::boolean
     AND (v_b ->> 'count')::integer = 350
     AND (v_b ->> 'retry_after')::integer >= 1,
    format('the serialized concurrent debit is refused at the ceiling: %s', v_b);

  SELECT count INTO v_stored
    FROM public.rate_limit_buckets
   WHERE bucket_key = 'weighted:wrl-test:race';
  ASSERT v_stored = 350,
    format('two concurrent debits never exceed the ceiling (350, never 650): %s',
           coalesce(v_stored::text, '<no row>'));
END
$concurrent_weighted_debits$;

-- ── 7. only the service role may execute the counter ──────────────────────

-- The browser roles must not reach the budget counter at all: a counter an
-- anonymous caller can debit is a counter the budget cannot hold.
DO $privileges$
BEGIN
  ASSERT NOT has_function_privilege(
           'anon', 'public.check_weighted_rate_limit(text,integer,integer,integer)', 'EXECUTE'),
    'anon cannot execute the weighted counter';
  ASSERT NOT has_function_privilege(
           'authenticated', 'public.check_weighted_rate_limit(text,integer,integer,integer)', 'EXECUTE'),
    'authenticated cannot execute the weighted counter';
  ASSERT has_function_privilege(
           'service_role', 'public.check_weighted_rate_limit(text,integer,integer,integer)', 'EXECUTE'),
    'service_role can execute the weighted counter';
END
$privileges$;

-- The production caller reaches this function through the service-role key,
-- so "service_role may execute it" has to be more than a grant: the call
-- has to run and its debit has to land.
--
-- SET ROLE is statement level — a role change is not allowed inside a DO
-- block — so the answer travels to the assertion through a session setting
-- rather than a psql variable (which is not interpolated inside a
-- dollar-quoted body).
BEGIN;
SET LOCAL ROLE service_role;
SELECT set_config(
         'postora.wrl_service_role_result',
         public.check_weighted_rate_limit('wrl-test:svc', 50, 100, 3600)::text,
         false);
RESET ROLE;
COMMIT;

DO $service_role_execution$
DECLARE
  v_result jsonb := current_setting('postora.wrl_service_role_result')::jsonb;
BEGIN
  ASSERT (v_result ->> 'allowed')::boolean
     AND (v_result ->> 'count')::integer = 50
     AND (v_result ->> 'retry_after')::integer = 0,
    format('service_role executes the weighted counter: %s', v_result);
  ASSERT EXISTS (
    SELECT 1 FROM public.rate_limit_buckets
     WHERE bucket_key = 'weighted:wrl-test:svc' AND count = 50),
    'the service_role debit reached the bucket table';
END
$service_role_execution$;

-- ── 8. `check_rate_limit` is untouched, and the two counters never collide ─

DO $legacy_counter_untouched$
DECLARE
  v_result jsonb;
  v_weighted jsonb;
BEGIN
  v_result := public.check_rate_limit('wrl-test', 'legacy', 2, 3600);
  ASSERT (v_result ->> 'allowed')::boolean
     AND (v_result ->> 'count')::integer = 1,
    format('the legacy counter still allows the first request: %s', v_result);

  v_result := public.check_rate_limit('wrl-test', 'legacy', 2, 3600);
  ASSERT (v_result ->> 'allowed')::boolean
     AND (v_result ->> 'count')::integer = 2,
    format('the legacy counter still allows the second request: %s', v_result);

  v_result := public.check_rate_limit('wrl-test', 'legacy', 2, 3600);
  ASSERT NOT (v_result ->> 'allowed')::boolean
     AND (v_result ->> 'count')::integer = 2
     AND (v_result ->> 'remaining')::integer = 0,
    format('the legacy counter still refuses the third request: %s', v_result);

  -- The weighted counter on the same logical name must use its own key.
  v_weighted := public.check_weighted_rate_limit('wrl-test:legacy', 50, 100, 3600);
  ASSERT (v_weighted ->> 'allowed')::boolean
     AND (v_weighted ->> 'count')::integer = 50,
    format('the weighted counter debits its own key: %s', v_weighted);

  ASSERT EXISTS (
    SELECT 1 FROM public.rate_limit_buckets
     WHERE bucket_key = 'wrl-test:legacy' AND count = 2),
    'the legacy counter kept its own bucket row and count';
  ASSERT EXISTS (
    SELECT 1 FROM public.rate_limit_buckets
     WHERE bucket_key = 'weighted:wrl-test:legacy' AND count = 50),
    'the weighted counter kept its own bucket row and count';
  ASSERT (SELECT count(*) FROM public.rate_limit_buckets
           WHERE bucket_key IN ('wrl-test:legacy', 'weighted:wrl-test:legacy')) = 2,
    'the two counters use two distinct bucket keys';
END
$legacy_counter_untouched$;

-- ── 9. cleanup ─────────────────────────────────────────────────────────────

-- Close the race sessions and remove every bucket this suite created.
DO $disconnect_race_sessions$
DECLARE
  v_name text;
BEGIN
  FOREACH v_name IN ARRAY ARRAY['wrl_a', 'wrl_b'] LOOP
    IF v_name = ANY (extensions.dblink_get_connections()) THEN
      PERFORM extensions.dblink_disconnect(v_name);
    END IF;
  END LOOP;
END
$disconnect_race_sessions$;

DELETE FROM public.rate_limit_buckets
 WHERE bucket_key LIKE 'weighted:wrl-test:%'
    OR bucket_key LIKE 'wrl-test:%';

DO $clean_state$
BEGIN
  ASSERT NOT EXISTS (
    SELECT 1 FROM public.rate_limit_buckets
     WHERE bucket_key LIKE 'weighted:wrl-test:%'
        OR bucket_key LIKE 'wrl-test:%'),
    'the suite left no rate-limit bucket behind';
END
$clean_state$;

\echo '=== youtube_weighted_rate_limit: ALL CHECKS PASSED ==='
