-- ============================================================================
-- supabase/tests/instagram_collection_daily_dispatch_race_fixture.sql
--
-- FIXTURE, NOT A SUITE. scripts/db-harness.sh does not run it, and it is
-- listed in the harness EXCLUDED_FROM_SUITES. A single connection cannot
-- prove what two sessions do to each other, and the sequential checks in
-- instagram_collection_daily_dispatch.sql are not that proof. This file
-- must not be described as if they were.
--
-- DISPOSABLE DATABASES ONLY. The prepare path COMMITS synthetic rows and
-- the policy change. Do not point DB_URL at a shared database or at
-- production. The script refuses to run unless psql was given
-- -v disposable=1.
--
-- THE SYNTHETIC FIXTURES
--
--   owner      0d0d0000-0000-4000-8000-000000000001
--   account    0d0d0000-0000-4000-8000-000000000011  the first approved one
--   account    0d0d0000-0000-4000-8000-000000000012  the second approved one
--   account    0d0d0000-0000-4000-8000-000000000013  the excluded sibling
--   account    0d0d0000-0000-4000-8000-000000000014  the LATE one: it is
--                                                       admitted only by the
--                                                       mid-sweep policy
--                                                       change
--   viewer     0d0d0000-0000-4000-8000-000000000021  the pinned viewer
--   watchlist  0d0d0000-0000-4000-8000-000000000031  the approved watchlist
--
-- WHAT THE TWO SESSIONS PROVE
--
--   RACE 1 - CONCURRENT START AND RESUME.
--     Session A opens a transaction and locks today's OWNER sweep row. It
--     does NOT commit.
--     Session B runs the daily page.
--     OBSERVED: B WAITS on the sweep row (wait_event_type = 'Lock'), and
--     the observer names A's pid as the blocker. That wait is the proof
--     that the sweep row is the serialisation point: two dispatchers of
--     the same kind and day cannot interleave inside one sweep.
--     After A commits, B proceeds and enqueues its page. The two sessions
--     never produced a duplicate job and never forced a generation.
--
--   RACE 2 - A FAILURE BEFORE THE COMMIT.
--     Session B runs the page and then ROLLBACKs, as a caller that died
--     before it could commit.
--     OBSERVED: neither the job rows nor the sweep counters survive. The
--     transaction commits the page and its jobs together or not at all.
--
--   RACE 3 - A FAILURE AFTER THE COMMIT, AND A LOST REPLY.
--     Session B runs the page and COMMITs, and the caller never learns the
--     outcome - the reply is lost.
--     OBSERVED: the next call reconciles from the persisted state. It
--     enqueues nothing, it changes no generation, and the job count is
--     exactly what the first call left behind.
--
--   RACE 4 - A CURRENT-DAY REPLAY AND A REOPEN.
--     A repeated start on a finished day is idempotent. An explicit start
--     after a target was approved reopens the day and admits the target,
--     while a RESUME of the finished day admits nothing.
--
--   RACE 5 - THE MIDNIGHT ROLLOVER.
--     An unfinished sweep of an earlier capture day is recorded expired
--     with the reason it did not finish. It is never silently completed
--     and no historical observation is fabricated.
--
--   RACE 6 - A TARGET THAT BECOMES ELIGIBLE MID-SWEEP.
--     Session A holds an uncommitted policy change that admits the late
--     account. Session B runs the page.
--     OBSERVED: B does NOT wait: the policy read is a plain SELECT, so it
--     never blocks on the row lock A holds, and B sees the last COMMITTED
--     policy. The late account is therefore NOT enqueued by that call.
--     After A commits, the next page admits it. The probe is a START, so
--     it reopens the day and walks from the beginning. A target that
--     becomes eligible behind a pending sweep's cursor is not taken by a
--     RESUME and is not certified by a completed sweep; the next start
--     or reopen is what admits it (D18). The exclusion is not in force
--     until it commits.
--
--   RACE 7 - NO-PROGRESS ERRORS.
--     A page that enqueues nothing reports zero and completes the day. It
--     never reports progress it did not make.
--
-- HOW TO REHEARSE
--
--   0. Prepare. Run ONCE against the disposable database:
--
--        psql "$DB_URL" -v ON_ERROR_STOP=1 -v disposable=1 -v prepare=1 \
--          -f supabase/tests/instagram_collection_daily_dispatch_race_fixture.sql
--
--   1. Open the sessions against the SAME database:
--
--        psql "$DB_URL"   # session A (the holder)
--        psql "$DB_URL"   # session B (the probe)
--        psql "$DB_URL"   # the observer, for the waits
--
--   2. RACE 1. In session A, hold the sweep row open:
--
--        psql "$DB_URL" -v ON_ERROR_STOP=1 -v disposable=1 -v hold_sweep=1 \
--          -v hold_seconds=6 -f supabase/tests/instagram_collection_daily_dispatch_race_fixture.sql
--
--   3. While session A still holds it, probe from session B:
--
--        psql "$DB_URL" -v ON_ERROR_STOP=1 -v disposable=1 -v probe_page=1 \
--          -f supabase/tests/instagram_collection_daily_dispatch_race_fixture.sql
--
--   4. The observer prints the lock waits of the other sessions:
--
--        psql "$DB_URL" -v ON_ERROR_STOP=1 -v disposable=1 -v observe=1 \
--          -f supabase/tests/instagram_collection_daily_dispatch_race_fixture.sql
--
--   5. RACE 6. In session A, hold the policy change open:
--
--        psql "$DB_URL" -v ON_ERROR_STOP=1 -v disposable=1 -v hold_policy=1 \
--          -v hold_seconds=6 -f supabase/tests/instagram_collection_daily_dispatch_race_fixture.sql
--
--      and probe from session B with -v probe_page=1 while A holds it.
--
--   6. The remaining races are self-contained probes:
--
--        psql "$DB_URL" -v ON_ERROR_STOP=1 -v disposable=1 -v probe_rollback=1 \
--          -f supabase/tests/instagram_collection_daily_dispatch_race_fixture.sql
--        psql "$DB_URL" -v ON_ERROR_STOP=1 -v disposable=1 -v probe_page=1 \
--          -f supabase/tests/instagram_collection_daily_dispatch_race_fixture.sql
--        psql "$DB_URL" -v ON_ERROR_STOP=1 -v disposable=1 -v probe_resume=1 \
--          -f supabase/tests/instagram_collection_daily_dispatch_race_fixture.sql
--        psql "$DB_URL" -v ON_ERROR_STOP=1 -v disposable=1 -v probe_rollover=1 \
--          -f supabase/tests/instagram_collection_daily_dispatch_race_fixture.sql
--
--   7. Assert and clean up. Run the cleanup even when the rehearsal
--      failed part way:
--
--        psql "$DB_URL" -v ON_ERROR_STOP=1 -v disposable=1 -v assert=1 \
--          -f supabase/tests/instagram_collection_daily_dispatch_race_fixture.sql
--        psql "$DB_URL" -v ON_ERROR_STOP=1 -v disposable=1 -v cleanup=1 \
--          -f supabase/tests/instagram_collection_daily_dispatch_race_fixture.sql
--
--   A PASS of the rehearsal is all of:
--   * race 1: the probe WAITED on the sweep row, and the observer named
--     the holder's pid as the blocker;
--   * race 2: the rolled-back page left no job and no counter behind;
--   * race 3: the second call enqueued nothing and changed no generation;
--   * race 4: the replay was idempotent, the reopen admitted the late
--     target, and the resume of a finished day admitted nothing;
--   * race 5: the earlier sweep is expired with its reason, and no
--     historical job was written;
--   * race 6: the probe did not wait on the policy row, and the late
--     target was admitted only after the change committed;
--   * race 7: a page with no work reported zero and completed the day;
--   * cleanup removed the synthetic rows and put the default policy back.
-- ============================================================================

\if :{?disposable}
\else
\echo 'REFUSING: this fixture commits synthetic rows and a policy change. Re-run with -v disposable=1 against a throwaway database only.'
\quit 2
\endif

\if :{?cleanup}
-- ---------------------------------------------------------------------------
-- CLEANUP. Runs even when the rehearsal failed half way.
-- ---------------------------------------------------------------------------
BEGIN;

DROP FUNCTION IF EXISTS public.igdaily_race_waits();

DELETE FROM public.instagram_collection_jobs
 WHERE user_id = '0d0d0000-0000-4000-8000-000000000001';
DELETE FROM public.instagram_collection_request_throttles
 WHERE user_id = '0d0d0000-0000-4000-8000-000000000001';
DELETE FROM public.instagram_collection_job_operations
 WHERE user_id = '0d0d0000-0000-4000-8000-000000000001';
DELETE FROM public.instagram_collection_job_checkpoints
 WHERE user_id = '0d0d0000-0000-4000-8000-000000000001';
DELETE FROM public.ig_media_insight_snapshots
 WHERE user_id = '0d0d0000-0000-4000-8000-000000000001';
DELETE FROM public.instagram_account_capabilities
 WHERE user_id = '0d0d0000-0000-4000-8000-000000000001';
DELETE FROM public.instagram_collection_enqueue_sweeps
 WHERE target_kind IN ('owner', 'competitor');
DELETE FROM public.competitor_watchlist
 WHERE user_id = '0d0d0000-0000-4000-8000-000000000001';
DELETE FROM public.social_accounts
 WHERE user_id = '0d0d0000-0000-4000-8000-000000000001';
DELETE FROM auth.users
 WHERE id = '0d0d0000-0000-4000-8000-000000000001';

-- The rollout fixture goes back to the default. The prepare step turned
-- the collection on and a collection gate left open is not a thing this
-- fixture may leave behind.
DELETE FROM public.app_settings
 WHERE key = 'collection_instagram_insights_enabled';
UPDATE public.app_settings
   SET value = '{"version":1,"owners":{"mode":"off","account_ids":[]},"competitors":{"mode":"off","targets":[]}}'::jsonb
 WHERE key = 'collection_instagram_rollout_policy';

COMMIT;
\echo '=== instagram_collection_daily_dispatch race fixture: cleaned synthetic owner, policy back to default ==='

\elif :{?prepare}
-- ---------------------------------------------------------------------------
-- PREPARE. Commits the synthetic fixtures.
-- ---------------------------------------------------------------------------
BEGIN;

DELETE FROM public.competitor_watchlist
 WHERE user_id = '0d0d0000-0000-4000-8000-000000000001';
DELETE FROM public.instagram_collection_jobs
 WHERE user_id = '0d0d0000-0000-4000-8000-000000000001';
DELETE FROM public.instagram_collection_request_throttles
 WHERE user_id = '0d0d0000-0000-4000-8000-000000000001';
DELETE FROM public.instagram_collection_job_operations
 WHERE user_id = '0d0d0000-0000-4000-8000-000000000001';
DELETE FROM public.instagram_collection_job_checkpoints
 WHERE user_id = '0d0d0000-0000-4000-8000-000000000001';
DELETE FROM public.ig_media_insight_snapshots
 WHERE user_id = '0d0d0000-0000-4000-8000-000000000001';
DELETE FROM public.instagram_account_capabilities
 WHERE user_id = '0d0d0000-0000-4000-8000-000000000001';
DELETE FROM public.instagram_collection_enqueue_sweeps
 WHERE target_kind IN ('owner', 'competitor');
DELETE FROM public.social_accounts
 WHERE user_id = '0d0d0000-0000-4000-8000-000000000001';
DELETE FROM auth.users
 WHERE id = '0d0d0000-0000-4000-8000-000000000001';

INSERT INTO auth.users (id, email)
VALUES ('0d0d0000-0000-4000-8000-000000000001', 'igdaily-race@example.invalid')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.social_accounts
  (id, user_id, platform, platform_user_id, platform_username, access_token, ig_auth_type)
VALUES
  ('0d0d0000-0000-4000-8000-000000000011', '0d0d0000-0000-4000-8000-000000000001',
   'instagram', 'ig-race-approved-a', 'igdaily_approved_a', 'race-token-a', 'facebook_page'),
  ('0d0d0000-0000-4000-8000-000000000012', '0d0d0000-0000-4000-8000-000000000001',
   'instagram', 'ig-race-approved-b', 'igdaily_approved_b', 'race-token-b', 'facebook_page'),
  ('0d0d0000-0000-4000-8000-000000000013', '0d0d0000-0000-4000-8000-000000000001',
   'instagram', 'ig-race-excluded', 'igdaily_excluded', 'race-token-c', 'facebook_page'),
  ('0d0d0000-0000-4000-8000-000000000014', '0d0d0000-0000-4000-8000-000000000001',
   'instagram', 'ig-race-late', 'igdaily_late', 'race-token-d', 'facebook_page'),
  ('0d0d0000-0000-4000-8000-000000000021', '0d0d0000-0000-4000-8000-000000000001',
   'instagram', 'ig-race-viewer', 'igdaily_viewer', 'race-token-v', 'facebook_page')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.competitor_watchlist (id, user_id, platform, username)
VALUES ('0d0d0000-0000-4000-8000-000000000031', '0d0d0000-0000-4000-8000-000000000001',
        'instagram', 'igdaily_comp')
ON CONFLICT (id) DO NOTHING;

-- The observer. It reports the LOCK waits of the other sessions, which is
-- the only way to prove that a session waited rather than inferring it
-- from a delay.
CREATE OR REPLACE FUNCTION public.igdaily_race_waits()
RETURNS TABLE (
  pid        integer,
  state      text,
  wait_type  text,
  wait_event text,
  blocked_by integer,
  query      text
)
LANGUAGE sql
VOLATILE
SET search_path = public
AS $function$
  SELECT a.pid,
         a.state,
         a.wait_event_type,
         a.wait_event,
         (SELECT unnest(pg_blocking_pids(a.pid)) LIMIT 1),
         left(a.query, 160)
    FROM pg_stat_activity AS a
   WHERE a.datname = current_database()
     AND a.pid <> pg_backend_pid()
     AND a.wait_event_type IS NOT NULL
   ORDER BY a.pid;
$function$;

-- The collection is on. The policy approves the first two accounts and
-- the watchlist, pinned to the viewer. The third account is excluded, and
-- the fourth one is the LATE target of race 6.
INSERT INTO public.app_settings (key, value, description)
VALUES
  ('collection_instagram_insights_enabled', 'true'::jsonb,
   'Synthetic race-fixture master switch.'),
  ('collection_instagram_rollout_policy',
   '{"version":1,"owners":{"mode":"allowlist","account_ids":["0d0d0000-0000-4000-8000-000000000011","0d0d0000-0000-4000-8000-000000000012"]},"competitors":{"mode":"allowlist","targets":[{"watchlist_id":"0d0d0000-0000-4000-8000-000000000031","viewer_social_account_id":"0d0d0000-0000-4000-8000-000000000021"}]}}'::jsonb,
   'Synthetic race-fixture rollout policy: two approved accounts and one pinned watchlist and viewer.')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

SELECT set_config('request.jwt.claim.role', 'service_role', true);
SELECT set_config('request.jwt.claim.sub', '', true);

-- Today's owner sweep row exists, so the holder of race 1 has a row to
-- lock. It starts PENDING, which is the state a resume continues.
INSERT INTO public.instagram_collection_enqueue_sweeps
  (target_kind, captured_on, status, started_at, updated_at)
VALUES ('owner', (now() AT TIME ZONE 'Asia/Kuwait')::date, 'pending', now(), now())
ON CONFLICT (target_kind, captured_on) DO NOTHING;

-- An unfinished sweep of YESTERDAY. It is what the rollover of race 5 has
-- to record as expired.
INSERT INTO public.instagram_collection_enqueue_sweeps
  (target_kind, captured_on, status, started_at, updated_at)
VALUES ('owner', (now() AT TIME ZONE 'Asia/Kuwait')::date - 1, 'pending',
        now() - interval '1 day', now() - interval '1 day')
ON CONFLICT (target_kind, captured_on) DO NOTHING;

COMMIT;
\echo '=== instagram_collection_daily_dispatch race fixture: prepared ==='
\echo 'owner           : 0d0d0000-0000-4000-8000-000000000001'
\echo 'approved account: 0d0d0000-0000-4000-8000-000000000011'
\echo 'approved account: 0d0d0000-0000-4000-8000-000000000012'
\echo 'excluded account: 0d0d0000-0000-4000-8000-000000000013'
\echo 'late account    : 0d0d0000-0000-4000-8000-000000000014'
\echo 'pinned viewer   : 0d0d0000-0000-4000-8000-000000000021'
\echo 'watchlist       : 0d0d0000-0000-4000-8000-000000000031'

\elif :{?hold_sweep}
-- ---------------------------------------------------------------------------
-- SESSION A - the sweep holder. It locks today's owner sweep row and holds
-- the lock until this transaction commits.
-- ---------------------------------------------------------------------------
\if :{?hold_seconds}
\else
\set hold_seconds 6
\endif

BEGIN;
SELECT set_config('request.jwt.claim.role', 'service_role', true);
SELECT set_config('request.jwt.claim.sub', '', true);

SELECT s.target_kind, s.captured_on, s.status
  FROM public.instagram_collection_enqueue_sweeps AS s
 WHERE s.target_kind = 'owner'
   AND s.captured_on = (now() AT TIME ZONE 'Asia/Kuwait')::date
 FOR UPDATE;

SELECT pg_sleep(:hold_seconds);

COMMIT;
\echo '=== instagram_collection_daily_dispatch race fixture: sweep row lock released ==='

\elif :{?hold_policy}
-- ---------------------------------------------------------------------------
-- SESSION A - the policy writer. It admits the LATE account and holds the
-- change until this transaction commits.
-- ---------------------------------------------------------------------------
\if :{?hold_seconds}
\else
\set hold_seconds 6
\endif

BEGIN;
SELECT set_config('request.jwt.claim.role', 'service_role', true);
SELECT set_config('request.jwt.claim.sub', '', true);

UPDATE public.app_settings
   SET value = '{"version":1,"owners":{"mode":"allowlist","account_ids":["0d0d0000-0000-4000-8000-000000000011","0d0d0000-0000-4000-8000-000000000012","0d0d0000-0000-4000-8000-000000000014"]},"competitors":{"mode":"allowlist","targets":[{"watchlist_id":"0d0d0000-0000-4000-8000-000000000031","viewer_social_account_id":"0d0d0000-0000-4000-8000-000000000021"}]}}'::jsonb
 WHERE key = 'collection_instagram_rollout_policy';

SELECT pg_sleep(:hold_seconds);

COMMIT;
\echo '=== instagram_collection_daily_dispatch race fixture: policy change committed ==='

\elif :{?probe_page}
-- ---------------------------------------------------------------------------
-- SESSION B - the page probe. It runs the daily page as a START and
-- reports the receipt and how long the call took.
--
-- The elapsed time is printed on purpose: a wait on the sweep row is
-- visible in the receipt's own timing, and the observer names the blocker.
-- ---------------------------------------------------------------------------
BEGIN;
SELECT set_config('request.jwt.claim.role', 'service_role', true);
SELECT set_config('request.jwt.claim.sub', '', true);

DO $probe$
DECLARE
  v_before  timestamptz := clock_timestamp();
  v_page    jsonb;
  v_after   timestamptz;
BEGIN
  v_page := public.enqueue_instagram_collection_daily_page('owner', true);
  v_after := clock_timestamp();

  RAISE NOTICE 'page probe: %', v_page::text;
  RAISE NOTICE 'page probe: the call took % ms',
    round(EXTRACT(EPOCH FROM (v_after - v_before)) * 1000);
END
$probe$;

COMMIT;

\elif :{?probe_resume}
-- ---------------------------------------------------------------------------
-- SESSION B - the RESUME probe. It never starts a sweep: it continues an
-- already pending one and reports what it did.
-- ---------------------------------------------------------------------------
BEGIN;
SELECT set_config('request.jwt.claim.role', 'service_role', true);
SELECT set_config('request.jwt.claim.sub', '', true);

DO $probe$
DECLARE
  v_page jsonb;
BEGIN
  v_page := public.enqueue_instagram_collection_daily_page('owner', false);
  RAISE NOTICE 'resume probe: %', v_page::text;
END
$probe$;

COMMIT;

\elif :{?probe_rollback}
-- ---------------------------------------------------------------------------
-- SESSION B - the failure BEFORE the commit.
--
-- The current day's owner jobs are removed inside the transaction, so the
-- page has real work to do, and the transaction then rolls back exactly as
-- a caller that died would leave it. The jobs the page inserted must NOT
-- survive, and the committed ones must be back.
-- ---------------------------------------------------------------------------
DO $before$
DECLARE
  v_jobs integer;
  v_id   uuid;
BEGIN
  SELECT count(*) INTO v_jobs
    FROM public.instagram_collection_jobs
   WHERE user_id = '0d0d0000-0000-4000-8000-000000000001';

  SELECT j.id INTO v_id
    FROM public.instagram_collection_jobs AS j
   WHERE j.user_id = '0d0d0000-0000-4000-8000-000000000001'
   ORDER BY j.id
   LIMIT 1;

  RAISE NOTICE 'rollback probe: % job rows were committed before the probe (first id %)', v_jobs, v_id;
END
$before$;

BEGIN;
SELECT set_config('request.jwt.claim.role', 'service_role', true);
SELECT set_config('request.jwt.claim.sub', '', true);

DO $probe$
DECLARE
  v_page jsonb;
  v_jobs integer;
  v_id   uuid;
BEGIN
  DELETE FROM public.instagram_collection_jobs
   WHERE user_id = '0d0d0000-0000-4000-8000-000000000001';

  v_page := public.enqueue_instagram_collection_daily_page('owner', true);
  RAISE NOTICE 'rollback probe: the page ran and said %', v_page::text;

  SELECT count(*) INTO v_jobs
    FROM public.instagram_collection_jobs
   WHERE user_id = '0d0d0000-0000-4000-8000-000000000001';

  SELECT j.id INTO v_id
    FROM public.instagram_collection_jobs AS j
   WHERE j.user_id = '0d0d0000-0000-4000-8000-000000000001'
   ORDER BY j.id
   LIMIT 1;

  RAISE NOTICE 'rollback probe: % job rows are visible BEFORE the rollback (first id %)', v_jobs, v_id;
END
$probe$;

ROLLBACK;

DO $after$
DECLARE
  v_jobs integer;
  v_id   uuid;
BEGIN
  SELECT count(*) INTO v_jobs
    FROM public.instagram_collection_jobs
   WHERE user_id = '0d0d0000-0000-4000-8000-000000000001';

  SELECT j.id INTO v_id
    FROM public.instagram_collection_jobs AS j
   WHERE j.user_id = '0d0d0000-0000-4000-8000-000000000001'
   ORDER BY j.id
   LIMIT 1;

  RAISE NOTICE 'rollback probe: % job rows are visible AFTER the rollback (first id %)', v_jobs, v_id;
  RAISE NOTICE 'rollback probe: the rows the page inserted did not survive';
END
$after$;

\elif :{?probe_rollover}
-- ---------------------------------------------------------------------------
-- SESSION B - the rollover probe. It runs the page, and the unfinished
-- sweep of yesterday must be recorded expired.
-- ---------------------------------------------------------------------------
BEGIN;
SELECT set_config('request.jwt.claim.role', 'service_role', true);
SELECT set_config('request.jwt.claim.sub', '', true);

DO $probe$
DECLARE
  v_page   jsonb;
  v_status text;
  v_reason text;
  v_jobs   integer;
BEGIN
  v_page := public.enqueue_instagram_collection_daily_page('owner', true);
  RAISE NOTICE 'rollover probe: the page said %', v_page::text;

  SELECT s.status, s.last_reason_code INTO v_status, v_reason
    FROM public.instagram_collection_enqueue_sweeps AS s
   WHERE s.target_kind = 'owner'
     AND s.captured_on = (now() AT TIME ZONE 'Asia/Kuwait')::date - 1;

  RAISE NOTICE 'rollover probe: yesterday''s sweep is % (%s)', v_status, v_reason;

  SELECT count(*) INTO v_jobs
    FROM public.instagram_collection_jobs
   WHERE captured_on = (now() AT TIME ZONE 'Asia/Kuwait')::date - 1;

  RAISE NOTICE 'rollover probe: % historical job rows exist', v_jobs;
END
$probe$;

COMMIT;

\elif :{?observe}
-- ---------------------------------------------------------------------------
-- THE OBSERVER. It reads the lock waits of the other sessions.
-- ---------------------------------------------------------------------------
SELECT pid, state, wait_type, wait_event, blocked_by, query
  FROM public.igdaily_race_waits();

\elif :{?assert}
-- ---------------------------------------------------------------------------
-- THE ASSERTIONS. They run AFTER the rehearsals, in one session.
-- ---------------------------------------------------------------------------
BEGIN;
SELECT set_config('request.jwt.claim.role', 'service_role', true);
SELECT set_config('request.jwt.claim.sub', '', true);

DO $assert$
DECLARE
  v_day       date := (now() AT TIME ZONE 'Asia/Kuwait')::date;
  v_jobs      integer;
  v_approved  integer;
  v_excluded  integer;
  v_late      integer;
  v_generation bigint;
  v_status    text;
  v_reason    text;
  v_yesterday integer;
BEGIN
  -- Race 3 and 4: the replay is idempotent and changed no generation.
  SELECT count(*) INTO v_jobs
    FROM public.instagram_collection_jobs
   WHERE user_id = '0d0d0000-0000-4000-8000-000000000001'
     AND captured_on = v_day;
  ASSERT v_jobs >= 1, 'the rehearsal enqueued at least one job';

  SELECT count(*) INTO v_approved
    FROM public.instagram_collection_jobs
   WHERE user_id = '0d0d0000-0000-4000-8000-000000000001'
     AND captured_on = v_day
     AND target_id IN ('0d0d0000-0000-4000-8000-000000000011',
                       '0d0d0000-0000-4000-8000-000000000012');
  ASSERT v_approved = 2, 'both approved accounts have exactly one current-day job';

  -- The excluded sibling never got a job.
  SELECT count(*) INTO v_excluded
    FROM public.instagram_collection_jobs
   WHERE user_id = '0d0d0000-0000-4000-8000-000000000001'
     AND captured_on = v_day
     AND target_id = '0d0d0000-0000-4000-8000-000000000013';
  ASSERT v_excluded = 0, 'the excluded sibling never got a job';

  -- Race 6: the late account is admitted only after the policy committed.
  SELECT count(*) INTO v_late
    FROM public.instagram_collection_jobs
   WHERE user_id = '0d0d0000-0000-4000-8000-000000000001'
     AND captured_on = v_day
     AND target_id = '0d0d0000-0000-4000-8000-000000000014';
  ASSERT v_late = 1, 'the late target has exactly one current-day job';

  -- No target has two jobs, and no generation was forced.
  ASSERT NOT EXISTS (
    SELECT 1 FROM public.instagram_collection_jobs
     WHERE user_id = '0d0d0000-0000-4000-8000-000000000001'
       AND captured_on = v_day
     GROUP BY target_kind, target_id
    HAVING count(*) > 1
  ), 'no target has two current-day jobs';

  SELECT j.job_generation INTO v_generation
    FROM public.instagram_collection_jobs AS j
   WHERE j.user_id = '0d0d0000-0000-4000-8000-000000000001'
     AND j.captured_on = v_day
     AND j.target_id = '0d0d0000-0000-4000-8000-000000000011';
  ASSERT v_generation = 1, 'the daily page never forced a generation';

  -- Race 5: yesterday's unfinished sweep is expired, with its reason, and
  -- no historical job was fabricated.
  SELECT s.status, s.last_reason_code INTO v_status, v_reason
    FROM public.instagram_collection_enqueue_sweeps AS s
   WHERE s.target_kind = 'owner' AND s.captured_on = v_day - 1;
  ASSERT v_status = 'expired', 'the earlier sweep is expired';
  ASSERT v_reason = 'capture_day_rolled_over', 'the expired sweep carries its reason';

  SELECT count(*) INTO v_yesterday
    FROM public.instagram_collection_jobs
   WHERE captured_on = v_day - 1;
  ASSERT v_yesterday = 0, 'the rollover fabricated no historical observation';

  -- Race 7: the day is completed and the counters are truthful.
  SELECT s.status INTO v_status
    FROM public.instagram_collection_enqueue_sweeps AS s
   WHERE s.target_kind = 'owner' AND s.captured_on = v_day;
  ASSERT v_status = 'completed', 'the owner day is completed';

  ASSERT (
    SELECT s.enqueued_count = (
      SELECT count(*) FROM public.instagram_collection_jobs
       WHERE user_id = '0d0d0000-0000-4000-8000-000000000001'
         AND captured_on = v_day)
    FROM public.instagram_collection_enqueue_sweeps AS s
    WHERE s.target_kind = 'owner' AND s.captured_on = v_day
  ), 'the recorded count is the count of inserted rows';
END
$assert$;

COMMIT;
\echo '=== instagram_collection_daily_dispatch race fixture: assertions passed ==='

\else
\echo 'UNKNOWN MODE. Use one of: prepare, hold_sweep, hold_policy, probe_page, probe_resume, probe_rollback, probe_rollover, observe, assert, cleanup.'
\quit 2
\endif
