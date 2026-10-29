-- ============================================================================
-- supabase/tests/instagram_tracking_schema_race_fixture.sql
--
-- FIXTURE, NOT A SUITE. scripts/db-harness.sh does not run it. A single
-- connection cannot prove that two activations are serialised. The SQL
-- suite's sequential checks are not that proof, and this file must not be
-- described as if they were.
--
-- DISPOSABLE DATABASES ONLY. The prepare path COMMITS a synthetic owner.
-- Do not point DB_URL at a shared database or at production. The script
-- refuses to run unless psql was given -v disposable=1. There is no
-- --cleanup switch; psql does not have one.
--
-- WHAT THE QUOTA LOCK ACTUALLY GUARANTEES
--
--   assert_competitor_watchlist_quota locks the owner's user_quotas row,
--   then counts active watchlist rows. Under READ COMMITTED that count sees
--   a row the previous waiter committed. Under REPEATABLE READ or
--   SERIALIZABLE the same lock still orders the waiters, but the count
--   keeps the transaction snapshot and misses that row, so both can pass.
--   The function refuses those levels with COMPETITOR_QUOTA_ISOLATION
--   (SQLSTATE 0A000) instead of pretending the limit held.
--
--   The two-session script below is READ COMMITTED, which is PostgREST's
--   level. It has to be run for real before the race is called proven.
--   PGlite has one connection and cannot run it.
--
-- HOW TO REHEARSE
--
--   0. Prepare. Run ONCE against the disposable database:
--
--        psql "$DB_URL" -v ON_ERROR_STOP=1 -v disposable=1 \
--          -f supabase/tests/instagram_tracking_schema_race_fixture.sql
--
--      Creates owner 0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f, sets
--      user_quotas.max_tracked_competitors = 1 (an override, not NULL),
--      and deletes any watchlist rows for that owner.
--
--   1. SESSION A, leave the transaction open:
--
--        psql "$DB_URL"
--        => BEGIN;
--        => INSERT INTO public.competitor_watchlist (user_id, platform, username)
--        =>   VALUES ('0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f', 'instagram', 'race_a');
--
--   2. SESSION B, in a second psql. This statement must BLOCK. If it
--      returns immediately, the rehearsal has failed.
--
--        psql "$DB_URL"
--        => BEGIN;
--        => INSERT INTO public.competitor_watchlist (user_id, platform, username)
--        =>   VALUES ('0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f', 'instagram', 'race_b');
--
--   3. SESSION A:
--
--        => COMMIT;
--
--   4. SESSION B then fails and must be rolled back:
--
--        => ERROR:  COMPETITOR_QUOTA_EXCEEDED: You are tracking 1 of the 1
--           competitors your plan allows. ...
--        => SQLSTATE 23514
--        => ROLLBACK;
--
--      Both sessions stay on the default READ COMMITTED. Do not
--      SET TRANSACTION ISOLATION LEVEL. At REPEATABLE READ the insert
--      fails closed with COMPETITOR_QUOTA_ISOLATION and never reaches
--      the lock-wait this rehearsal is watching for.
--
--   5. Verify:
--
--        => SELECT count(*) FROM public.competitor_watchlist
--        =>  WHERE user_id = '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f'
--        =>    AND is_active;
--        => -- exactly 1
--        => SELECT max_tracked_competitors FROM public.user_quotas
--        =>  WHERE user_id = '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f';
--        => -- exactly 1, not NULL
--
--   6. Cleanup. This deletes the synthetic owner and the rows hanging off
--      it. Run it even when the rehearsal failed part way:
--
--        psql "$DB_URL" -v ON_ERROR_STOP=1 -v disposable=1 -v cleanup=1 \
--          -f supabase/tests/instagram_tracking_schema_race_fixture.sql
--
--   7. Optional, separate from the lock wait. Proves the unsupported
--      isolation level is refused, then rolls back. It does not need the
--      prepare step and it must not leave a row:
--
--        psql "$DB_URL" -v ON_ERROR_STOP=1 -v disposable=1 -v isolation_probe=1 \
--          -f supabase/tests/instagram_tracking_schema_race_fixture.sql
--
-- A PASS of the two-session rehearsal is all of:
--
--   * Session B's INSERT blocks while session A's transaction is open.
--   * After session A commits, session B's INSERT is refused with
--     COMPETITOR_QUOTA_EXCEEDED (SQLSTATE 23514).
--   * Exactly one active watchlist row remains.
--   * max_tracked_competitors for that owner is still 1.
--   * Cleanup has removed that owner, that quota row and that watchlist row.
-- ============================================================================

\if :{?disposable}
\else
\echo 'REFUSING: this fixture commits synthetic rows. Re-run with -v disposable=1 against a throwaway database only.'
\quit 2
\endif

\if :{?cleanup}
BEGIN;
DELETE FROM public.competitor_media_snapshots
 WHERE user_id = '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f';
DELETE FROM public.competitor_profile_snapshots
 WHERE user_id = '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f';
DELETE FROM public.competitor_watchlist
 WHERE user_id = '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f';
DELETE FROM public.user_subscriptions
 WHERE user_id = '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f';
DELETE FROM public.user_roles
 WHERE user_id = '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f';
DELETE FROM public.user_quotas
 WHERE user_id = '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f';
DO $cleanup_profiles$
BEGIN
  IF to_regclass('public.profiles') IS NOT NULL THEN
    DELETE FROM public.profiles
     WHERE id = '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f';
  END IF;
END
$cleanup_profiles$;
DELETE FROM auth.users
 WHERE id = '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f';
COMMIT;
\echo '=== instagram_tracking_schema race fixture: cleaned synthetic owner ==='
\elif :{?isolation_probe}
-- Rolls back. Safe to run before or after prepare. Not a concurrency proof.
BEGIN ISOLATION LEVEL REPEATABLE READ;
DO $isolation_probe$
DECLARE
  v_user uuid := '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f';
BEGIN
  INSERT INTO auth.users (id, email)
  VALUES (v_user, 'itk-race-iso@example.invalid')
  ON CONFLICT (id) DO NOTHING;

  BEGIN
    INSERT INTO public.competitor_watchlist (user_id, platform, username)
    VALUES (v_user, 'instagram', 'isolation_probe');
    RAISE EXCEPTION 'isolation probe failed open: the insert was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN feature_not_supported THEN
    IF SQLERRM NOT LIKE '%COMPETITOR_QUOTA_ISOLATION%' THEN
      RAISE EXCEPTION 'isolation probe expected COMPETITOR_QUOTA_ISOLATION, got: %', SQLERRM;
    END IF;
  END;

  IF EXISTS (
       SELECT 1 FROM public.competitor_watchlist
        WHERE user_id = v_user AND username = 'isolation_probe'
     ) THEN
    RAISE EXCEPTION 'isolation probe left a watchlist row';
  END IF;
END
$isolation_probe$;
ROLLBACK;
\echo '=== instagram_tracking_schema race fixture: REPEATABLE READ refused, nothing committed ==='
\else
BEGIN;
INSERT INTO auth.users (id, email)
VALUES ('0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f',
        'itk-race-owner@example.invalid')
ON CONFLICT (id) DO NOTHING;

-- 1 is an override. NULL would mean inherit, and the free plan allows 5,
-- so the second concurrent insert would be accepted. The signup trigger
-- may already have inserted this quota row with a NULL limit; the upsert
-- is what makes the rehearsal's limit actually 1.
INSERT INTO public.user_quotas (user_id, max_tracked_competitors)
VALUES ('0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f', 1)
ON CONFLICT (user_id) DO UPDATE
  SET max_tracked_competitors = EXCLUDED.max_tracked_competitors;

DELETE FROM public.competitor_watchlist
 WHERE user_id = '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f';
COMMIT;
\echo '=== instagram_tracking_schema race fixture: prepared (owner, override 1, no watchlist rows) ==='
\endif
