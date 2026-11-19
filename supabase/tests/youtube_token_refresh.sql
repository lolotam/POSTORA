-- ============================================================================
-- supabase/tests/youtube_token_refresh.sql
-- Migration 20261118230000_youtube_refreshed_token_rpc.sql.
--
-- One transaction, synthetic fixtures, labelled assertions, ROLLBACK. Fixture
-- values are synthetic; no secrets, no real accounts, no provider calls.
--
-- What this suite proves
--   T1 the grant surface: the token store is the service role's alone, so the
--      browser roles may not run it.
--   T2 the compare-and-set: the token is stored when the row still carries
--      the credential the refresh was asked with, and NOTHING is stored when it
--      does not, so a refresh that raced another writer loses.
--   T3 a call that cannot store -- a missing account, a missing argument, an
--      account that is not there -- stores nothing and answers false.
-- ============================================================================

BEGIN;

-- The synthetic owner of the accounts below.
INSERT INTO auth.users (id, email) VALUES
  ('b1000000-0000-4000-8000-000000000001', 'yt-token-a@example.invalid')
  ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- T1: THE GRANT SURFACE.
--
-- The caller is the worker, never the browser: the function writes a row that
-- only the service role may write, and it is granted to the service role
-- alone.
-- ---------------------------------------------------------------------------
DO $t1_grants$
BEGIN
  ASSERT NOT has_function_privilege('anon',
           'public.store_youtube_refreshed_token(uuid,text,text,timestamptz,text,timestamptz)', 'EXECUTE'),
    'T1 anon may not store a refreshed token';
  ASSERT NOT has_function_privilege('authenticated',
           'public.store_youtube_refreshed_token(uuid,text,text,timestamptz,text,timestamptz)', 'EXECUTE'),
    'T1 authenticated may not store a refreshed token';
  ASSERT has_function_privilege('service_role',
           'public.store_youtube_refreshed_token(uuid,text,text,timestamptz,text,timestamptz)', 'EXECUTE'),
    'T1 the service role may store a refreshed token';

  RAISE NOTICE 'PASS T1: the token store is the service role''s alone';
END
$t1_grants$;

-- ---------------------------------------------------------------------------
-- T2: THE COMPARE-AND-SET.
--
-- The rule the filters proved, in the database: the token is stored only if
-- the row still carries the credential the refresh was asked with.
-- ---------------------------------------------------------------------------
DO $t2_compare_and_set$
DECLARE
  v_owner   uuid := 'b1000000-0000-4000-8000-000000000001';
  v_account uuid := gen_random_uuid();
  v_before  timestamptz := '2026-11-18T11:00:00.000Z'::timestamptz;
  v_after   timestamptz := '2026-11-18T12:00:00.000Z'::timestamptz;
  v_stored  boolean;
BEGIN
  INSERT INTO public.social_accounts
    (id, user_id, platform, platform_user_id, platform_username, access_token,
     refresh_token, token_expires_at, is_active)
  VALUES (v_account, v_owner, 'youtube', 'yt-t2', 't2', 'access-before',
          'refresh-before', v_before, true);

  -- The row still carries the credential the refresh was asked with.
  v_stored := public.store_youtube_refreshed_token(
    v_account, 'refresh-before', 'access-before', v_before, 'access-after', v_after);
  ASSERT v_stored,
    'T2 the token is stored when the row still carries the credential';
  ASSERT (SELECT access_token FROM public.social_accounts WHERE id = v_account) = 'access-after',
    'T2 the row carries the fresh token';
  ASSERT (SELECT token_expires_at FROM public.social_accounts WHERE id = v_account) = v_after,
    'T2 the row carries the fresh expiry';

  -- The row has moved on: the refresh stores nothing.
  v_stored := public.store_youtube_refreshed_token(
    v_account, 'refresh-before', 'access-before', v_before, 'access-later', v_after + interval '1 hour');
  ASSERT NOT v_stored,
    'T2 the token is not stored when the row has moved on';
  ASSERT (SELECT access_token FROM public.social_accounts WHERE id = v_account) = 'access-after',
    'T2 the newer credential is kept';

  -- A refresh token that is not the one on the row is a different credential.
  v_stored := public.store_youtube_refreshed_token(
    v_account, 'refresh-other', 'access-after', v_after, 'access-other', v_after);
  ASSERT NOT v_stored,
    'T2 the token is not stored when the refresh token has changed';

  -- A NULL credential on the row is compared as a credential, not as "any".
  UPDATE public.social_accounts SET access_token = NULL WHERE id = v_account;
  v_stored := public.store_youtube_refreshed_token(
    v_account, 'refresh-before', 'access-after', v_after, 'access-other', v_after);
  ASSERT NOT v_stored,
    'T2 the token is not stored when the access token has changed';

  RAISE NOTICE 'PASS T2: the compare-and-set stores only what it may';
END
$t2_compare_and_set$;

-- ---------------------------------------------------------------------------
-- T3: A CALL THAT CANNOT STORE STORES NOTHING.
-- ---------------------------------------------------------------------------
DO $t3_refusals$
DECLARE
  v_owner   uuid := 'b1000000-0000-4000-8000-000000000001';
  v_account uuid := gen_random_uuid();
  v_now     timestamptz := now();
BEGIN
  INSERT INTO public.social_accounts
    (id, user_id, platform, platform_user_id, platform_username, access_token,
     refresh_token, token_expires_at, is_active)
  VALUES (v_account, v_owner, 'youtube', 'yt-t3', 't3', 'access-before',
          'refresh-before', v_now, true);

  ASSERT NOT public.store_youtube_refreshed_token(
    NULL, 'refresh-before', 'access-before', v_now, 'access-after', v_now),
    'T3 a missing account stores nothing';
  ASSERT NOT public.store_youtube_refreshed_token(
    v_account, 'refresh-before', 'access-before', v_now, NULL, v_now),
    'T3 a missing token stores nothing';
  ASSERT NOT public.store_youtube_refreshed_token(
    v_account, 'refresh-before', 'access-before', v_now, 'access-after', NULL),
    'T3 a missing expiry stores nothing';
  ASSERT NOT public.store_youtube_refreshed_token(
    gen_random_uuid(), 'refresh-before', 'access-before', v_now, 'access-after', v_now),
    'T3 an account that is not there stores nothing';

  ASSERT (SELECT access_token FROM public.social_accounts WHERE id = v_account) = 'access-before',
    'T3 the row keeps its credential';

  RAISE NOTICE 'PASS T3: a call that cannot store stores nothing';
END
$t3_refusals$;

ROLLBACK;

\echo '=== youtube_token_refresh: ALL CHECKS PASSED ==='
