-- ============================================================================
-- supabase/tests/competitor_retention_race_fixture.sql
--
-- FIXTURE, NOT A SUITE. scripts/db-harness.sh does not run it. A single
-- connection cannot prove that two sessions are serialised. The SQL
-- suite's sequential checks are not that proof, and this file must not be
-- described as if they were.
--
-- DISPOSABLE DATABASES ONLY. The prepare path COMMITS a synthetic owner
-- and it turns the competitor_retention_enabled switch ON. Do not point
-- DB_URL at a shared database or at production. The script refuses to run
-- unless psql was given -v disposable=1. There is no --cleanup switch;
-- psql does not have one.
--
-- WHAT IS BEING PROVED
--
--   The cleanup takes the PARENT row lock before it touches a job, and it
--   takes it FOR UPDATE SKIP LOCKED. That single fact decides all five
--   races below, and it decides them in TWO DIFFERENT WAYS:
--
--     * A waiter (a reactivation, a collector's fence) BLOCKS on the
--       parent lock. That is an ordinary row-lock wait, and it is
--       observable in pg_stat_activity as wait_event_type = 'Lock'.
--
--     * A second CLEANUP never blocks. It skips the parent another
--       transaction holds and takes the next one. That is the queue
--       pattern, and it is NOT a wait - a rehearsal that expects a wait
--       there would be asserting the wrong thing.
--
--   So races 2 and 3 are rehearsed as LOCK WAITS, and races 1 and 4 as
--   LOCK SKIPS. Race 5 is a refusal, not a race: it proves that an
--   expired generation has no write authority after the cleanup.
--
--   The five races
--     1  the reactivation holds the parent lock, then the cleanup
--     2  the cleanup holds the parent lock, then the reactivation
--     3  the collector's commit versus the cleanup
--     4  two retention runs
--     5  the expired worker after the cleanup
--
-- HOW TO REHEARSE
--
--   0. Prepare. Run ONCE against the disposable database:
--
--        psql "$DB_URL" -v ON_ERROR_STOP=1 -v disposable=1 -v prepare=1 \
--          -f supabase/tests/competitor_retention_race_fixture.sql
--
--      Creates the synthetic owner c7f0f0f0-0000-4000-8000-000000000001,
--      six tracked competitors removed 100 days ago, the jobs the collector
--      races need, and it sets competitor_retention_enabled to true.
--
--      Against the disposable container of the Task 8 validation:
--
--        docker exec -i task8-impl07-pg psql -U supabase_admin \
--          -d partner_api_harness -v ON_ERROR_STOP=1 -v disposable=1 \
--          -v prepare=1 \
--          -f /repo/supabase/tests/competitor_retention_race_fixture.sql
--
--   1. Open THREE sessions against the same database. Two of them are the
--      racers; the third is the observer. The observer is what proves the
--      wait: it reads pg_stat_activity and pg_locks while the other
--      session is blocked.
--
--        docker exec -it task8-impl07-pg psql -U supabase_admin -d partner_api_harness
--
--   2. The observer session, once per race, while the racer is blocked:
--
--        => SELECT * FROM pg_temp.crt_probe();
--
--      (the probe is defined in the observer session by the block below;
--      if the observer session was started before the prepare step, define
--      it with the SQL in the "THE PROBE" section at the end of this file)
--
--   3. Cleanup. Run it even when a rehearsal failed half way. It deletes
--      the synthetic rows AND puts the switch back to false:
--
--        docker exec -i task8-impl07-pg psql -U supabase_admin \
--          -d partner_api_harness -v ON_ERROR_STOP=1 -v disposable=1 \
--          -v cleanup=1 \
--          -f /repo/supabase/tests/competitor_retention_race_fixture.sql
--
-- ---------------------------------------------------------------------------
-- RACE 1 - the reactivation holds the parent lock, then the cleanup.
--
--   The reactivation is an ordinary UPDATE of the parent row. It takes the
--   row lock and holds it until the transaction ends.
--
--   SESSION A (leave the transaction OPEN):
--
--        => BEGIN;
--        => UPDATE public.competitor_watchlist
--        =>    SET is_active = true, removed_at = NULL
--        =>  WHERE id = 'c7a00000-0000-4000-8000-000000000001';
--        => UPDATE 1
--
--   SESSION B (run it while A is open - it must NOT block):
--
--        => BEGIN;
--        => SELECT set_config('request.jwt.claim.role', 'service_role', true);
--        => SELECT public.run_competitor_retention_batch(10, 100, false);
--        => COMMIT;
--
--        The BEGIN is not decoration. The role claim is a TRANSACTION-LOCAL
--        setting, so in an autocommit session the claim is gone again
--        before the next statement runs, and the cleanup answers
--        IG_COLLECTION_CALLER_NOT_ALLOWED instead of running. Every session
--        in this rehearsal that calls a service-only function therefore
--        runs inside an explicit transaction.
--
--   OBSERVED: session B returns IMMEDIATELY. That is the SKIP LOCKED
--   behaviour, not a failure: the cleanup cannot take a parent another
--   transaction holds, so it takes the next candidate instead. The report
--   shows parents_deleted = 0 for this parent.
--
--   SESSION A:
--
--        => COMMIT;
--
--   ASSERT (any session):
--
--        => SELECT is_active, removed_at FROM public.competitor_watchlist
--        =>  WHERE id = 'c7a00000-0000-4000-8000-000000000001';
--        => -- is_active = true, removed_at = NULL: the reactivation won
--        => SELECT count(*) FROM public.competitor_media_snapshots
--        =>  WHERE watchlist_id = 'c7a00000-0000-4000-8000-000000000001';
--        => -- 1: the cleanup deleted nothing of a reactivated entry
--
-- ---------------------------------------------------------------------------
-- RACE 2 - the cleanup holds the parent lock, then the reactivation.
--
--   SESSION A (the cleanup; the transaction stays OPEN, so the lock is
--   held after the call returns):
--
--        => BEGIN;
--        => SELECT set_config('request.jwt.claim.role', 'service_role', true);
--        => SELECT public.run_competitor_retention_batch(10, 100, false);
--        => -- the row is deleted but NOT committed: the lock is held
--
--   SESSION B (run it now - it MUST block):
--
--        => BEGIN;
--        => UPDATE public.competitor_watchlist
--        =>    SET is_active = true, removed_at = NULL
--        =>  WHERE id = 'c7a00000-0000-4000-8000-000000000002';
--
--   OBSERVED: session B is waiting on a row lock. The observer session
--   must show it with wait_event_type = 'Lock' and the blocking backend in
--   pg_blocking_pids().
--
--   SESSION A:
--
--        => COMMIT;
--
--   SESSION B (it unblocks now):
--
--        => UPDATE 0
--        => ROLLBACK;
--
--   ASSERT:
--
--        => SELECT count(*) FROM public.competitor_watchlist
--        =>  WHERE id = 'c7a00000-0000-4000-8000-000000000002';
--        => -- 0: the cleanup committed first, so the reactivation found
--        => -- nothing to reactivate. The row is gone and stays gone.
--
--   The two orderings are not symmetric, and that is the point: a
--   reactivation that WINS keeps the entry and its history, and one that
--   LOSES cannot resurrect what the cleanup already committed.
--
-- ---------------------------------------------------------------------------
-- RACE 3 - the collector's commit versus the cleanup.
--
--   The collector's fence (ig_collection_load_fenced_job) locks the
--   accounts, then the WATCHLIST, then the job - the same parent-then-job
--   order the cleanup uses. So the collector waits on the parent lock.
--
--   SESSION A (the cleanup; leave the transaction OPEN):
--
--        => BEGIN;
--        => SELECT set_config('request.jwt.claim.role', 'service_role', true);
--        => SELECT public.run_competitor_retention_batch(10, 100, false);
--
--   SESSION B (the collector; it MUST block on the parent lock):
--
--        => BEGIN;
--        => SELECT set_config('request.jwt.claim.role', 'service_role', true);
--        => SELECT public.persist_competitor_collection_result_v2(
--        =>   'c7b00000-0000-4000-8000-000000000001',
--        =>   'c7c00000-0000-4000-8000-000000000001',
--        =>   1,
--        =>   jsonb_build_object(
--        =>     'outcome', 'completed',
--        =>     'source', 'apify',
--        =>     'profile', jsonb_build_object(
--        =>       'metrics', jsonb_build_object('followers_count', 1, 'media_count', 1)),
--        =>     'media', jsonb_build_array(),
--        =>     'coverage', jsonb_build_object(
--        =>       'capture_started_at', to_char(now() - interval '1 minute', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
--        =>       'capture_ended_at', to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
--        =>       'ordering_verified', false,
--        =>       'cursor_present', false,
--        =>       'exhausted', true,
--        =>       'truncated', false,
--        =>       'gap_reason', NULL)));
--
--   OBSERVED: session B is waiting on a row lock (wait_event_type =
--   'Lock'). That is the parent lock of the watchlist entry, and it is the
--   lock the cleanup took FIRST.
--
--   SESSION A:
--
--        => COMMIT;
--
--   SESSION B (it unblocks now, and it is refused):
--
--        => ERROR:  IG_COLLECTION_JOB_NOT_FOUND: no such collection job
--        => ROLLBACK;
--
--   ASSERT:
--
--        => SELECT count(*) FROM public.competitor_profile_snapshots
--        =>  WHERE watchlist_id = 'c7a00000-0000-4000-8000-000000000003';
--        => -- 0: the collector wrote nothing
--        => SELECT count(*) FROM public.competitor_capture_coverage
--        =>  WHERE watchlist_id = 'c7a00000-0000-4000-8000-000000000003';
--        => -- 0: and no coverage either
--
-- ---------------------------------------------------------------------------
-- RACE 4 - two retention runs.
--
--   Two cleanups at the same time. SKIP LOCKED means they do not block
--   each other and they do not delete the same parent twice.
--
--   SESSION A and SESSION B, both within about a second of each other:
--
--        => BEGIN;
--        => SELECT set_config('request.jwt.claim.role', 'service_role', true);
--        => SELECT public.run_competitor_retention_batch(1, 100, false);
--        => COMMIT;
--
--   OBSERVED: neither session waits. The two reports together account for
--   exactly TWO deleted parents, never three.
--
--   ASSERT:
--
--        => SELECT count(*) FROM public.competitor_watchlist
--        =>  WHERE id IN ('c7a00000-0000-4000-8000-000000000004',
--        =>                'c7a00000-0000-4000-8000-000000000006');
--        => -- 0: both parents are gone
--        => SELECT count(*) FROM public.competitor_media_snapshots
--        =>  WHERE watchlist_id IN ('c7a00000-0000-4000-8000-000000000004',
--        =>                     'c7a00000-0000-4000-8000-000000000006');
--        => -- 0: and their children went with them
--
--   A third call finds nothing left to do:
--
--        => SELECT public.run_competitor_retention_batch(1, 100, false);
--        => -- parents_deleted = 0
--
-- ---------------------------------------------------------------------------
-- RACE 5 - the expired worker after the cleanup.
--
--   Two parts, and neither of them needs two sessions.
--
--   5a  The cleanup removed the job, so the worker that held the expired
--       lease cannot publish anything:
--
--        => BEGIN;
--        => SELECT set_config('request.jwt.claim.role', 'service_role', true);
--        => SELECT public.run_competitor_retention_batch(10, 100, false);
--        => SELECT public.persist_competitor_collection_result_v2(
--        =>   'c7b00000-0000-4000-8000-000000000002',
--        =>   'c7c00000-0000-4000-8000-000000000002',
--        =>   1,
--        =>   jsonb_build_object('outcome', 'completed', 'source', 'apify',
--        =>     'profile', jsonb_build_object('metrics', jsonb_build_object(
--        =>       'followers_count', 1, 'media_count', 1)),
--        =>     'media', jsonb_build_array(),
--        =>     'coverage', jsonb_build_object(
--        =>       'capture_started_at', to_char(now() - interval '1 minute', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
--        =>       'capture_ended_at', to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
--        =>       'ordering_verified', false, 'cursor_present', false,
--        =>       'exhausted', true, 'truncated', false, 'gap_reason', NULL)));
--        => ERROR:  IG_COLLECTION_JOB_NOT_FOUND: no such collection job
--        => ROLLBACK;
--
--       ASSERT:
--
--        => SELECT count(*) FROM public.competitor_profile_snapshots
--        =>  WHERE watchlist_id = 'c7a00000-0000-4000-8000-000000000005';
--        => -- 0: the expired worker wrote nothing
--
--   5b  The same expired worker on an entry the cleanup did NOT touch
--       (it is only 10 days old) is refused by the lease itself:
--
--        => SELECT public.persist_competitor_collection_result_v2(
--        =>   'c7b00000-0000-4000-8000-000000000003',
--        =>   'c7c00000-0000-4000-8000-000000000003',
--        =>   1,
--        =>   jsonb_build_object('outcome', 'completed', 'source', 'apify',
--        =>     'profile', jsonb_build_object('metrics', jsonb_build_object(
--        =>       'followers_count', 1, 'media_count', 1)),
--        =>     'media', jsonb_build_array(),
--        =>     'coverage', jsonb_build_object(
--        =>       'capture_started_at', to_char(now() - interval '1 minute', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
--        =>       'capture_ended_at', to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
--        =>       'ordering_verified', false, 'cursor_present', false,
--        =>       'exhausted', true, 'truncated', false, 'gap_reason', NULL)));
--        => ERROR:  IG_COLLECTION_CLAIM_STALE: the claim is no longer valid for this job
--
--       ASSERT:
--
--        => SELECT count(*) FROM public.competitor_profile_snapshots
--        =>  WHERE watchlist_id = 'c7a00000-0000-4000-8000-000000000007';
--        => -- 0: the expired lease wrote nothing either
--
-- A PASS of the two-session rehearsal is all of:
--
--   * Race 1: session B returns immediately (the skip) and the reactivated
--     entry, its marker and its children are all still there.
--   * Race 2: session B blocks on the parent lock, the observer sees the
--     wait, and after the cleanup commits the reactivation updates 0 rows.
--   * Race 3: the collector blocks on the parent lock, the observer sees
--     the wait, and the write is refused with IG_COLLECTION_JOB_NOT_FOUND.
--   * Race 4: neither run waits, the two reports together account for
--     exactly two parents, and no parent is deleted twice.
--   * Race 5: both expired workers are refused and neither writes a row.
--   * Cleanup has removed the synthetic owner, its rows, its jobs and put
--     the switch back to false.
-- ============================================================================

\if :{?disposable}
\else
\echo 'REFUSING: this fixture commits synthetic rows and turns the retention switch on.'
\echo 'Re-run with -v disposable=1 against a throwaway database only.'
\quit 2
\endif

\if :{?cleanup}
-- ---------------------------------------------------------------------------
-- CLEANUP. Runs even when a rehearsal failed half way.
-- ---------------------------------------------------------------------------
BEGIN;
DELETE FROM public.competitor_capture_coverage
 WHERE user_id = 'c7f0f0f0-0000-4000-8000-000000000001';
DELETE FROM public.competitor_media_snapshots
 WHERE user_id = 'c7f0f0f0-0000-4000-8000-000000000001';
DELETE FROM public.competitor_profile_snapshots
 WHERE user_id = 'c7f0f0f0-0000-4000-8000-000000000001';
DELETE FROM public.instagram_collection_job_operations
 WHERE user_id = 'c7f0f0f0-0000-4000-8000-000000000001';
DELETE FROM public.instagram_collection_job_checkpoints
 WHERE user_id = 'c7f0f0f0-0000-4000-8000-000000000001';
DELETE FROM public.instagram_collection_jobs
 WHERE user_id = 'c7f0f0f0-0000-4000-8000-000000000001';
DELETE FROM public.instagram_collection_request_throttles
 WHERE user_id = 'c7f0f0f0-0000-4000-8000-000000000001';
DELETE FROM public.competitor_watchlist
 WHERE user_id = 'c7f0f0f0-0000-4000-8000-000000000001';
DELETE FROM public.user_subscriptions
 WHERE user_id = 'c7f0f0f0-0000-4000-8000-000000000001';
DELETE FROM public.user_roles
 WHERE user_id = 'c7f0f0f0-0000-4000-8000-000000000001';
DELETE FROM public.user_quotas
 WHERE user_id = 'c7f0f0f0-0000-4000-8000-000000000001';
DO $cleanup_profiles$
BEGIN
  IF to_regclass('public.profiles') IS NOT NULL THEN
    DELETE FROM public.profiles
     WHERE id = 'c7f0f0f0-0000-4000-8000-000000000001';
  END IF;
END
$cleanup_profiles$;
DELETE FROM auth.users
 WHERE id = 'c7f0f0f0-0000-4000-8000-000000000001';

-- The switch goes back to its default. The prepare step turned it ON and
-- a retention switch left on is not a thing this fixture may leave behind.
UPDATE public.app_settings
   SET value = 'false'::jsonb
 WHERE key = 'competitor_retention_enabled';

COMMIT;
\echo '=== competitor_retention race fixture: cleaned synthetic owner, switch back off ==='

\elif :{?prepare}
-- ---------------------------------------------------------------------------
-- PREPARE. Commits the synthetic fixtures.
-- ---------------------------------------------------------------------------
BEGIN;

-- Re-running the prepare is safe: the synthetic rows of an earlier run go
-- first. The children are removed with their parent.
DELETE FROM public.competitor_watchlist
 WHERE user_id = 'c7f0f0f0-0000-4000-8000-000000000001';

INSERT INTO auth.users (id, email)
VALUES ('c7f0f0f0-0000-4000-8000-000000000001',
        'crt-race-owner@example.invalid')
ON CONFLICT (id) DO NOTHING;

-- Unlimited, so the reactivation in races 1 and 2 is not a quota refusal.
INSERT INTO public.user_quotas (user_id, max_tracked_competitors)
VALUES ('c7f0f0f0-0000-4000-8000-000000000001', -1)
ON CONFLICT (user_id) DO UPDATE SET max_tracked_competitors = -1;

-- Six tracked competitors. Six of them are removed 100 days ago, so they
-- are eligible; the last one is only 10 days old, so it is not.
INSERT INTO public.competitor_watchlist
  (id, user_id, platform, username, is_active, removed_at)
VALUES
  ('c7a00000-0000-4000-8000-000000000001',
   'c7f0f0f0-0000-4000-8000-000000000001', 'instagram', 'crt_race_1',
   false, now() - interval '100 days'),
  ('c7a00000-0000-4000-8000-000000000002',
   'c7f0f0f0-0000-4000-8000-000000000001', 'instagram', 'crt_race_2',
   false, now() - interval '100 days'),
  ('c7a00000-0000-4000-8000-000000000003',
   'c7f0f0f0-0000-4000-8000-000000000001', 'instagram', 'crt_race_3',
   false, now() - interval '100 days'),
  ('c7a00000-0000-4000-8000-000000000004',
   'c7f0f0f0-0000-4000-8000-000000000001', 'instagram', 'crt_race_4a',
   false, now() - interval '100 days'),
  ('c7a00000-0000-4000-8000-000000000006',
   'c7f0f0f0-0000-4000-8000-000000000001', 'instagram', 'crt_race_4b',
   false, now() - interval '100 days'),
  ('c7a00000-0000-4000-8000-000000000005',
   'c7f0f0f0-0000-4000-8000-000000000001', 'instagram', 'crt_race_5',
   false, now() - interval '100 days'),
  ('c7a00000-0000-4000-8000-000000000007',
   'c7f0f0f0-0000-4000-8000-000000000001', 'instagram', 'crt_race_5b',
   false, now() - interval '10 days');

-- One media snapshot each: a child that must go with its parent.
INSERT INTO public.competitor_media_snapshots
  (watchlist_id, user_id, ig_media_id, captured_on, published_at, source)
SELECT w.id, w.user_id, 'crt-race-media-' || w.username, current_date,
       now(), 'apify'
  FROM public.competitor_watchlist AS w
 WHERE w.user_id = 'c7f0f0f0-0000-4000-8000-000000000001';

-- The jobs the collector races need.
--
--   race 3  : a queued job of the race-3 entry. The collector's fence
--             locks the watchlist FIRST, so it waits on the cleanup's
--             parent lock and is refused when the cleanup commits.
--   race 5a : a job with an EXPIRED lease of the race-5 entry. The cleanup
--             removes the job, so the worker has nothing to write to.
--   race 5b : a job with an EXPIRED lease of the race-5b entry, which the
--             cleanup does NOT touch. The expired lease itself is the
--             refusal.
INSERT INTO public.instagram_collection_jobs
  (id, user_id, target_kind, target_id, watchlist_id, captured_on,
   job_generation, status, due_at, lease_token, lease_expires_at)
VALUES
  ('c7b00000-0000-4000-8000-000000000001',
   'c7f0f0f0-0000-4000-8000-000000000001', 'competitor',
   'c7a00000-0000-4000-8000-000000000003',
   'c7a00000-0000-4000-8000-000000000003',
   current_date, 1, 'queued', now(), NULL, NULL),
  ('c7b00000-0000-4000-8000-000000000002',
   'c7f0f0f0-0000-4000-8000-000000000001', 'competitor',
   'c7a00000-0000-4000-8000-000000000005',
   'c7a00000-0000-4000-8000-000000000005',
   current_date, 1, 'leased', now(),
   'c7c00000-0000-4000-8000-000000000002', now() - interval '1 hour'),
  ('c7b00000-0000-4000-8000-000000000003',
   'c7f0f0f0-0000-4000-8000-000000000001', 'competitor',
   'c7a00000-0000-4000-8000-000000000007',
   'c7a00000-0000-4000-8000-000000000007',
   current_date, 1, 'leased', now(),
   'c7c00000-0000-4000-8000-000000000003', now() - interval '1 hour');

-- The switch the cleanup needs. It is put back to false by the cleanup
-- step, and the whole fixture is disposable.
UPDATE public.app_settings
   SET value = 'true'::jsonb
 WHERE key = 'competitor_retention_enabled';

COMMIT;

\echo '=== competitor_retention race fixture: prepared ==='
\echo 'owner            : c7f0f0f0-0000-4000-8000-000000000001'
\echo 'race 1 react lock: c7a00000-0000-4000-8000-000000000001'
\echo 'race 2 clean lock: c7a00000-0000-4000-8000-000000000002'
\echo 'race 3 collector : c7a00000-0000-4000-8000-000000000003'
\echo 'race 4 two runs  : c7a00000-0000-4000-8000-000000000004 and ...006'
\echo 'race 5 expired   : c7a00000-0000-4000-8000-000000000005 (cleaned) and ...007 (kept)'
\echo 'switch           : competitor_retention_enabled = true'

\else
-- ---------------------------------------------------------------------------
-- The manual rehearsal. This branch only prints the reminder; the script
-- of every race is in the header of this file.
--
-- The observer's probe, which is what proves a wait. Define it in the
-- observer session and call it while the racer is blocked:
--
--   CREATE OR REPLACE FUNCTION pg_temp.crt_probe()
--   RETURNS TABLE(pid integer, state text, wait_event_type text,
--                 wait_event text, blocked_by integer[], query text)
--   LANGUAGE sql AS $fn$
--     SELECT a.pid, a.state, a.wait_event_type, a.wait_event,
--            pg_blocking_pids(a.pid), left(a.query, 160)
--       FROM pg_stat_activity AS a
--      WHERE a.datname = current_database()
--        AND a.pid <> pg_backend_pid()
--      ORDER BY a.pid;
--   $fn$;
--
-- A blocked racer shows wait_event_type = 'Lock' and the blocking backend
-- in blocked_by. The holder shows the granted row lock.
-- ---------------------------------------------------------------------------
\echo '=== competitor_retention race fixture: nothing to do ==='
\echo 'Run with -v prepare=1 to create the fixtures, -v cleanup=1 to remove them.'
\echo 'The two-session script of every race is in the header of this file.'
\endif
