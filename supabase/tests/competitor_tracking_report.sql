-- ============================================================================
-- supabase/tests/competitor_tracking_report.sql
-- Task 8 / M2 (migration 20261030110000_competitor_tracking_report.sql).
--
-- One transaction, synthetic fixtures, labelled ASSERTs, expected refusals in
-- nested BEGIN/EXCEPTION blocks, ROLLBACK, sentinel last. Fixture values are
-- synthetic ('...@example.invalid'); no secrets and no real accounts.
--
-- What this suite proves
--   R1  the grant surface: the reader is authenticated-only, it is SECURITY
--       DEFINER with a fixed search_path, anon may not execute it, the
--       service role may not execute it, and an authenticated caller with
--       no verified owner is refused by the reader itself.
--   R2  the request shape: the action, the state, the period, the limit, the
--       watchlist id, an unknown key and a supplied owner are all refused,
--       and a refusal is never an empty payload.
--   R3  the owner boundary: an admin sees only what they track themselves,
--       two owners may track the same handle and each sees only their own
--       row, and an unknown id and another owner's id are refused
--       identically.
--   R4  the lists: the active and the removed list, the entry projection,
--       the cleanup date of a removed entry, and the quota consistency with
--       the existing quota reader.
--   R5  the cursor: the 20 default, the 50 maximum, the limit+1 page, the
--       sub-millisecond tie and its identity, the concurrent insertion, the
--       invalid cursor, the cross-filter cursor and the cross-owner cursor.
--   R6  the S = 3 days baseline: exactly at the cutoff, exactly at
--       cutoff - 3 days, cutoff - 3 days - 1 microsecond, later than the
--       cutoff, and a source change between the two ends.
--   R7  the profile observations: at most 32 of them and the truncation
--       flag when the history is longer.
--   R8  the media: the latest observation per media item is selected before
--       the page is cut, the baseline holds at most 12 preceding media of
--       the same cohort, and the cohorts do not mix.
--   R9  the coverage and the job projection: the capture evidence is
--       returned and the lease, the claim token, the credential context and
--       the raw error text are not.
--   R10 the bounds: the media scan reports its own incompleteness instead
--       of presenting a short baseline as a complete one.
--
-- The suite SET ROLEs away from superuser where the point of the check is
-- that a client role cannot do something: a superuser bypasses the ACLs, so
-- a grant check that does not change role proves nothing.
-- ============================================================================

\set ON_ERROR_STOP on

BEGIN;

-- ---------------------------------------------------------------------------
-- Fixtures. Written as superuser, where RLS does not apply.
--
-- u_a       : the main owner, unlimited by an explicit override
-- u_b       : the second owner, a finite override, tracks the SAME handle
-- u_admin   : an admin, unlimited, tracks more than fifty entries
--
-- The profile observations of the growth fixtures use EXPLICIT instants. The
-- suite runs in one transaction, so now() is constant, and the growth rules
-- are about exact boundaries: a baseline has to land exactly on the cutoff
-- or exactly three days before it, and one microsecond either side of the
-- window has to be refused. Those instants cannot be relative to now().
-- ---------------------------------------------------------------------------
DO $fixtures$
DECLARE
  u_a     uuid := 'd1000000-0000-4000-8000-000000000001';
  u_b     uuid := 'd1000000-0000-4000-8000-000000000002';
  u_admin uuid := 'd1000000-0000-4000-8000-000000000003';
BEGIN
  INSERT INTO auth.users (id, email)
  VALUES
    (u_a,     'ctr-owner-a-'     || u_a::text     || '@example.invalid'),
    (u_b,     'ctr-owner-b-'     || u_b::text     || '@example.invalid'),
    (u_admin, 'ctr-owner-admin-' || u_admin::text || '@example.invalid');

  -- The fixture entitlements. The trigger that guards the watchlist checks
  -- the quota on every activation, so the owners that need many rows get an
  -- explicit override.
  INSERT INTO public.user_quotas (user_id, max_tracked_competitors)
  VALUES (u_a, -1), (u_b, 3)
  ON CONFLICT (user_id) DO UPDATE SET max_tracked_competitors = EXCLUDED.max_tracked_competitors;

  INSERT INTO public.user_roles (user_id, role)
  VALUES (u_admin, 'admin')
  ON CONFLICT DO NOTHING;

  -- The tracked entries of u_a.
  INSERT INTO public.competitor_watchlist
    (id, user_id, platform, username, label, is_active, removed_at, status, created_at)
  VALUES
    ('d2000000-0000-4000-8000-000000000001', u_a, 'instagram', 'rich',      'Rich',   true,  NULL,                  'ok',      '2026-01-01 00:00:00.000001+00'),
    ('d2000000-0000-4000-8000-000000000002', u_a, 'instagram', 'edge_cut',  NULL,     true,  NULL,                  'ok',      '2026-01-01 00:00:00.000002+00'),
    ('d2000000-0000-4000-8000-000000000003', u_a, 'instagram', 'edge_low',  NULL,     true,  NULL,                  'ok',      '2026-01-01 00:00:00.000003+00'),
    ('d2000000-0000-4000-8000-000000000004', u_a, 'instagram', 'edge_below',NULL,     true,  NULL,                  'ok',      '2026-01-01 00:00:00.000004+00'),
    ('d2000000-0000-4000-8000-000000000005', u_a, 'instagram', 'edge_above',NULL,     true,  NULL,                  'ok',      '2026-01-01 00:00:00.000005+00'),
    ('d2000000-0000-4000-8000-000000000006', u_a, 'instagram', 'edge_switch',NULL,    true,  NULL,                  'ok',      '2026-01-01 00:00:00.000006+00'),
    ('d2000000-0000-4000-8000-000000000007', u_a, 'instagram', 'edge_same', NULL,     true,  NULL,                  'ok',      '2026-01-01 00:00:00.000007+00'),
    ('d2000000-0000-4000-8000-000000000008', u_a, 'instagram', 'obs_cap',   NULL,     true,  NULL,                  'ok',      '2026-01-01 00:00:00.000008+00'),
    ('d2000000-0000-4000-8000-000000000009', u_a, 'instagram', 'media_one', NULL,     true,  NULL,                  'ok',      '2026-01-01 00:00:00.000009+00'),
    ('d2000000-0000-4000-8000-00000000000b', u_a, 'instagram', 'shared',    'Shared', true,  NULL,                  'ok',      '2026-01-01 00:00:00.000012+00'),
    -- The two removed entries.
    ('d2000000-0000-4000-8000-00000000000a', u_a, 'instagram', 'gone_one',  NULL,     false, '2026-05-01 00:00:00+00', 'ok',      '2026-01-01 00:00:00.000010+00'),
    ('d2000000-0000-4000-8000-00000000000c', u_a, 'instagram', 'gone_two',  NULL,     false, '2026-10-01 00:00:00+00', 'error',   '2026-01-01 00:00:00.000011+00'),
    -- The two entries that share one creation instant to the microsecond.
    ('d2000000-0000-4000-8000-0000000000a1', u_a, 'instagram', 'tie_low',   NULL,     true,  NULL,                  'ok',      '2026-01-01 00:00:00.500000+00'),
    ('d2000000-0000-4000-8000-0000000000a2', u_a, 'instagram', 'tie_high',  NULL,     true,  NULL,                  'ok',      '2026-01-01 00:00:00.500000+00');

  -- The paging entries of u_a: fifty-two of them, one second apart.
  INSERT INTO public.competitor_watchlist
    (id, user_id, platform, username, created_at)
  SELECT ('d2000000-0000-4000-8000-' || lpad((9000 + g)::text, 12, '0'))::uuid,
         u_a, 'instagram', 'page_' || lpad(g::text, 2, '0'),
         '2026-02-01 00:00:00+00'::timestamptz + (g || ' seconds')::interval
    FROM generate_series(0, 51) AS g;

  -- u_b tracks the SAME handle as u_a. Two owners, one handle, two rows.
  INSERT INTO public.competitor_watchlist
    (id, user_id, platform, username, created_at)
  VALUES ('d2000000-0000-4000-8000-0000000000b1', u_b, 'instagram', 'shared',
          '2026-01-01 00:00:00.000020+00');

  -- The admin tracks more than fifty entries.
  INSERT INTO public.competitor_watchlist
    (id, user_id, platform, username, created_at)
  SELECT ('d2000000-0000-4000-8000-' || lpad((7000 + g)::text, 12, '0'))::uuid,
         u_admin, 'instagram', 'adm_' || lpad(g::text, 2, '0'),
         '2026-03-01 00:00:00+00'::timestamptz + (g || ' seconds')::interval
    FROM generate_series(0, 51) AS g;

  -- -------------------------------------------------------------------------
  -- The profile observations.
  --
  -- The capture day is part of the identity of a profile snapshot
  -- (watchlist_id, captured_on), so two observations of one entry cannot
  -- share a day. Every fixture below therefore sits on its own day, and the
  -- microsecond edges are exercised on entries of their own.
  --
  -- The growth instants of the rich entry:
  --   observed L  2026-10-20 12:00:00
  --   7 days  ->  cutoff 2026-10-13 12:00:00, window from 2026-10-10 12:00:00
  --   30 days ->  cutoff 2026-09-20 12:00:00, window from 2026-09-17 12:00:00
  -- -------------------------------------------------------------------------
  INSERT INTO public.competitor_profile_snapshots
    (watchlist_id, user_id, captured_on, captured_at, followers_count, media_count, source, status)
  VALUES
    -- The rich entry.
    ('d2000000-0000-4000-8000-000000000001', u_a, '2026-10-20', '2026-10-20 12:00:00+00', 1000, 50, 'official', 'ok'),
    ('d2000000-0000-4000-8000-000000000001', u_a, '2026-10-13', '2026-10-13 12:00:00+00',  900, 48, 'official', 'ok'),
    ('d2000000-0000-4000-8000-000000000001', u_a, '2026-10-10', '2026-10-10 12:00:00+00',  880, 47, 'official', 'ok'),
    ('d2000000-0000-4000-8000-000000000001', u_a, '2026-09-20', '2026-09-20 12:00:00+00',  800, 44, 'official', 'ok'),
    ('d2000000-0000-4000-8000-000000000001', u_a, '2026-09-17', '2026-09-17 11:59:59.999999+00', 700, 40, 'official', 'ok'),
    -- Exactly at the 7 day cutoff.
    ('d2000000-0000-4000-8000-000000000002', u_a, '2026-10-20', '2026-10-20 12:00:00+00', 1000, 50, 'official', 'ok'),
    ('d2000000-0000-4000-8000-000000000002', u_a, '2026-10-13', '2026-10-13 12:00:00+00',  900, 48, 'official', 'ok'),
    -- Exactly three days before the cutoff.
    ('d2000000-0000-4000-8000-000000000003', u_a, '2026-10-20', '2026-10-20 12:00:00+00', 1000, 50, 'official', 'ok'),
    ('d2000000-0000-4000-8000-000000000003', u_a, '2026-10-10', '2026-10-10 12:00:00+00',  900, 48, 'official', 'ok'),
    -- One microsecond before the window opens.
    ('d2000000-0000-4000-8000-000000000004', u_a, '2026-10-20', '2026-10-20 12:00:00+00', 1000, 50, 'official', 'ok'),
    ('d2000000-0000-4000-8000-000000000004', u_a, '2026-10-10', '2026-10-10 11:59:59.999999+00', 900, 48, 'official', 'ok'),
    -- One microsecond after the cutoff.
    ('d2000000-0000-4000-8000-000000000005', u_a, '2026-10-20', '2026-10-20 12:00:00+00', 1000, 50, 'official', 'ok'),
    ('d2000000-0000-4000-8000-000000000005', u_a, '2026-10-13', '2026-10-13 12:00:00.000001+00', 900, 48, 'official', 'ok'),
    -- The source changed between the baseline and the observation.
    ('d2000000-0000-4000-8000-000000000006', u_a, '2026-10-20', '2026-10-20 12:00:00+00', 1000, 50, 'official', 'ok'),
    ('d2000000-0000-4000-8000-000000000006', u_a, '2026-10-15', '2026-10-15 12:00:00+00',  950, 49, 'apify',    'ok'),
    ('d2000000-0000-4000-8000-000000000006', u_a, '2026-10-12', '2026-10-12 12:00:00+00',  900, 48, 'official', 'ok'),
    -- The control of the previous one: the same shape without the switch.
    ('d2000000-0000-4000-8000-000000000007', u_a, '2026-10-20', '2026-10-20 12:00:00+00', 1000, 50, 'official', 'ok'),
    ('d2000000-0000-4000-8000-000000000007', u_a, '2026-10-12', '2026-10-12 12:00:00+00',  900, 48, 'official', 'ok');

  -- The long daily history of the observation-cap entry: forty days.
  INSERT INTO public.competitor_profile_snapshots
    (watchlist_id, user_id, captured_on, captured_at, followers_count, media_count, source, status)
  SELECT 'd2000000-0000-4000-8000-000000000008', u_a,
         ('2026-01-05'::date + g),
         ('2026-01-05'::date + g) + interval '06:00:00',
         1000 + g, 10, 'official', 'ok'
    FROM generate_series(0, 39) AS g;

  -- A failed capture of the rich entry: it is NOT an observation and must
  -- never be used as the observed end of a growth comparison.
  INSERT INTO public.competitor_profile_snapshots
    (watchlist_id, user_id, captured_on, captured_at, followers_count, media_count, source, status)
  VALUES ('d2000000-0000-4000-8000-000000000001', u_a, '2026-10-25', '2026-10-25 12:00:00+00', 4242, 51, 'official', 'error');

  -- -------------------------------------------------------------------------
  -- The media of the media entry.
  --
  -- The instants are relative to now() on purpose: the maturity rule is
  -- "published at least 48 hours ago", and a fixed instant would make the
  -- suite depend on the day it runs.
  --
  --   m_reel_00 .. m_reel_13  fourteen reels, all older than the target
  --   m_reel_target           the newest reel, mature, with a baseline
  --   m_feed_01 .. m_feed_03  three feeds
  --   m_feed_target           a feed, whose cohort is the feeds only
  --   m_unknown               an unknown product type, which has no basis
  --   m_dup                   one media captured on two days
  -- -------------------------------------------------------------------------
  INSERT INTO public.competitor_media_snapshots
    (watchlist_id, user_id, ig_media_id, captured_on, captured_at,
     media_product_type, media_type, published_at, like_count, comments_count,
     view_count, source, status)
  SELECT 'd2000000-0000-4000-8000-000000000009', u_a,
         'm_reel_' || lpad(g::text, 2, '0'),
         (now() - interval '40 days')::date + g,
         now() - interval '40 days' + (g || ' days')::interval,
         'REELS', 'VIDEO',
         now() - interval '40 days' + (g || ' days')::interval,
         NULL, NULL, 1000 + g * 10, 'official', 'ok'
    FROM generate_series(0, 13) AS g;

  INSERT INTO public.competitor_media_snapshots
    (watchlist_id, user_id, ig_media_id, captured_on, captured_at,
     media_product_type, media_type, published_at, like_count, comments_count,
     view_count, source, status)
  VALUES
    ('d2000000-0000-4000-8000-000000000009', u_a, 'm_reel_target',
     (now() - interval '10 days')::date, now() - interval '10 days',
     'REELS', 'VIDEO', now() - interval '10 days', NULL, NULL, 5000, 'official', 'ok'),
    ('d2000000-0000-4000-8000-000000000009', u_a, 'm_feed_01',
     (now() - interval '35 days')::date, now() - interval '35 days',
     'FEED', 'IMAGE', now() - interval '35 days', 100, 10, NULL, 'official', 'ok'),
    ('d2000000-0000-4000-8000-000000000009', u_a, 'm_feed_02',
     (now() - interval '30 days')::date, now() - interval '30 days',
     'FEED', 'IMAGE', now() - interval '30 days', 200, 20, NULL, 'official', 'ok'),
    ('d2000000-0000-4000-8000-000000000009', u_a, 'm_feed_03',
     (now() - interval '25 days')::date, now() - interval '25 days',
     'FEED', 'CAROUSEL_ALBUM', now() - interval '25 days', 300, 30, NULL, 'official', 'ok'),
    ('d2000000-0000-4000-8000-000000000009', u_a, 'm_feed_target',
     (now() - interval '10 days')::date, now() - interval '10 days',
     'FEED', 'IMAGE', now() - interval '10 days', 500, 50, NULL, 'official', 'ok'),
    ('d2000000-0000-4000-8000-000000000009', u_a, 'm_unknown',
     (now() - interval '10 days')::date, now() - interval '10 days',
     NULL, 'VIDEO', now() - interval '10 days', 70, 7, NULL, 'official', 'ok');

  -- One media captured on two days. Only the LATEST observation may be
  -- displayed, and only one of them may be.
  INSERT INTO public.competitor_media_snapshots
    (watchlist_id, user_id, ig_media_id, captured_on, captured_at,
     media_product_type, media_type, published_at, like_count, comments_count,
     view_count, source, status)
  VALUES
    ('d2000000-0000-4000-8000-000000000009', u_a, 'm_dup',
     (now() - interval '12 days')::date, now() - interval '12 days',
     'REELS', 'VIDEO', now() - interval '12 days', NULL, NULL, 111, 'official', 'ok'),
    ('d2000000-0000-4000-8000-000000000009', u_a, 'm_dup',
     (now() - interval '11 days')::date, now() - interval '11 days',
     'REELS', 'VIDEO', now() - interval '12 days', NULL, NULL, 222, 'official', 'ok');

  -- -------------------------------------------------------------------------
  -- The capture coverage of the rich entry.
  -- -------------------------------------------------------------------------
  INSERT INTO public.competitor_capture_coverage
    (watchlist_id, user_id, captured_on, captured_at, source, job_generation,
     capture_started_at, capture_ended_at, oldest_returned_at,
     ordering_verified, cursor_present, exhausted, truncated, gap_reason)
  VALUES
    ('d2000000-0000-4000-8000-000000000001', u_a, '2026-10-20', '2026-10-20 12:00:05+00',
     'official', 3, '2026-10-20 12:00:00+00', '2026-10-20 12:00:05+00', '2026-10-01 09:00:00+00',
     true, false, true, false, NULL),
    ('d2000000-0000-4000-8000-000000000001', u_a, '2026-10-19', '2026-10-19 12:00:05+00',
     'official', 2, '2026-10-19 12:00:00+00', '2026-10-19 12:00:05+00', '2026-10-01 09:00:00+00',
     false, true, false, true, 'media_cap_reached');

  -- -------------------------------------------------------------------------
  -- The collection job of the rich entry, with a lease and a credential
  -- context. Neither may ever reach the owner.
  -- -------------------------------------------------------------------------
  INSERT INTO public.social_accounts
    (id, user_id, platform, platform_user_id, platform_username, access_token, ig_auth_type)
  VALUES ('d3000000-0000-4000-8000-000000000001', u_a, 'instagram', 'ig-ctr-viewer',
          'ctr_viewer', 'token-synthetic', 'facebook_page');

  INSERT INTO public.instagram_collection_jobs
    (id, user_id, target_kind, target_id, watchlist_id, captured_on, job_generation,
     status, due_at, lease_token, lease_expires_at, attempts, last_attempt_at,
     last_partial_at, last_success_at, last_reason_code,
     context_viewer_social_account_id, context_credential_generation, context_login_kind)
  VALUES ('d4000000-0000-4000-8000-000000000001', u_a, 'competitor',
          'd2000000-0000-4000-8000-000000000001', 'd2000000-0000-4000-8000-000000000001',
          '2026-10-20', 3, 'leased', now() + interval '1 hour',
          'd5000000-0000-4000-8000-000000000001', now() + interval '30 minutes',
          2, now() - interval '5 minutes', now() - interval '2 days', now() - interval '1 day',
          NULL,
          'd3000000-0000-4000-8000-000000000001', 7, 'page_linked');

  -- The raw provider error of a failed entry. It must never be displayed.
  UPDATE public.competitor_watchlist
     SET last_error = 'provider said: token abcdef is invalid for user 42',
         last_error_code = 'token_invalid'
   WHERE id = 'd2000000-0000-4000-8000-00000000000c';

  -- -------------------------------------------------------------------------
  -- The flooded entry.
  --
  -- One media item captured on more days than the media scan may read. The
  -- scan is capped, the pool of distinct media is one row, and the baseline
  -- of that row cannot be proven - which the reader has to say instead of
  -- presenting an empty baseline as a complete one.
  -- -------------------------------------------------------------------------
  INSERT INTO public.competitor_watchlist
    (id, user_id, platform, username, created_at)
  VALUES ('d2000000-0000-4000-8000-00000000000d', u_a, 'instagram', 'media_flood',
          '2026-01-01 00:00:00.000014+00');

  INSERT INTO public.competitor_media_snapshots
    (watchlist_id, user_id, ig_media_id, captured_on, captured_at,
     media_product_type, media_type, published_at, like_count, comments_count,
     view_count, source, status)
  SELECT 'd2000000-0000-4000-8000-00000000000d', u_a, 'm_flood',
         d.captured_on,
         d.captured_on + interval '06:00:00',
         'REELS', 'VIDEO',
         '2013-01-05 12:00:00+00'::timestamptz,
         NULL, NULL, 900, 'official', 'ok'
    FROM (
      SELECT generate_series('2013-01-01'::date, '2026-10-30'::date, '1 day'::interval)::date AS captured_on
    ) d;
END
$fixtures$;

-- ---------------------------------------------------------------------------
-- Helpers.
-- ---------------------------------------------------------------------------

-- The reader, called by whoever the current role is.
CREATE OR REPLACE FUNCTION pg_temp.ctr(p_request jsonb)
RETURNS jsonb
LANGUAGE sql
AS $fn$
  SELECT public.read_own_competitor_tracking_report(p_request);
$fn$;

-- The id of an entry inside a returned array.
CREATE OR REPLACE FUNCTION pg_temp.ctr_entry_id(p_entries jsonb, p_username text)
RETURNS uuid
LANGUAGE sql
AS $fn$
  SELECT (e ->> 'watchlist_id')::uuid
    FROM jsonb_array_elements(p_entries) AS e
   WHERE e ->> 'username' = p_username;
$fn$;

-- ===========================================================================
-- R1 - the grant surface.
-- ===========================================================================
DO $r1$
DECLARE
  v_sig    text := 'read_own_competitor_tracking_report(jsonb)';
  v_def    text;
  v_config text[];
BEGIN
  -- The function exists with the real signature.
  ASSERT to_regprocedure('public.' || v_sig) IS NOT NULL,
    'R1 the reader exists with the documented signature';

  SELECT p.prosecdef, p.proconfig
    INTO v_def, v_config
    FROM pg_proc p
   WHERE p.oid = ('public.' || v_sig)::regprocedure;

  ASSERT v_def, 'R1 the reader is SECURITY DEFINER';
  ASSERT v_config IS NOT NULL AND array_to_string(v_config, ',') LIKE '%search_path=public%',
    'R1 the reader pins its search_path, got ' || coalesce(array_to_string(v_config, ','), '<null>');

  -- The browser roles.
  ASSERT has_function_privilege('authenticated', 'public.' || v_sig, 'EXECUTE'),
    'R1 authenticated may execute the reader';
  ASSERT NOT has_function_privilege('anon', 'public.' || v_sig, 'EXECUTE'),
    'R1 anon may NOT execute the reader';
  ASSERT NOT has_function_privilege('service_role', 'public.' || v_sig, 'EXECUTE'),
    'R1 the service role may NOT execute the reader';
  ASSERT NOT has_function_privilege('public', 'public.' || v_sig, 'EXECUTE'),
    'R1 PUBLIC may NOT execute the reader';
END
$r1$;

-- anon is refused by the ACL.
SET LOCAL ROLE anon;
DO $r1_anon$
BEGIN
  BEGIN
    PERFORM pg_temp.ctr('{"action":"list","state":"active"}');
    RAISE EXCEPTION 'R1 failed: anon executed the reader'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN insufficient_privilege THEN
    ASSERT SQLSTATE = '42501',
      'R1 the anon refusal is SQLSTATE 42501, got ' || SQLSTATE;
  END;
END
$r1_anon$;
RESET ROLE;

-- The service role is refused by the ACL.
SET LOCAL ROLE service_role;
DO $r1_service$
BEGIN
  BEGIN
    PERFORM pg_temp.ctr('{"action":"list","state":"active"}');
    RAISE EXCEPTION 'R1 failed: the service role executed the reader'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN insufficient_privilege THEN
    ASSERT SQLSTATE = '42501',
      'R1 the service-role refusal is SQLSTATE 42501, got ' || SQLSTATE;
  END;
END
$r1_service$;
RESET ROLE;

-- An authenticated caller with no verified owner is refused by the reader
-- itself: the ACL let it through, the identity did not exist.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '', true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
DO $r1_noowner$
BEGIN
  BEGIN
    PERFORM pg_temp.ctr('{"action":"list","state":"active"}');
    RAISE EXCEPTION 'R1 failed: a caller without an owner executed the reader'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN insufficient_privilege THEN
    ASSERT SQLERRM LIKE 'COMPETITOR_REPORT_UNAUTHENTICATED%',
      'R1 the unowned refusal names its reason, got ' || SQLERRM;
  END;
END
$r1_noowner$;

-- From here on the caller is u_a.
SELECT set_config('request.jwt.claim.sub', 'd1000000-0000-4000-8000-000000000001', true);

-- ===========================================================================
-- R2 - the request shape.
-- ===========================================================================
DO $r2$
DECLARE
  v_bad jsonb[] := ARRAY[
    '{"action":"list","state":"active","user_id":"d1000000-0000-4000-8000-000000000002"}'::jsonb,
    '{"action":"list","state":"active","unknown_key":1}'::jsonb,
    '{"action":"list"}'::jsonb,
    '{"action":"list","state":"pending"}'::jsonb,
    '{"action":"list","state":"active","watchlist_id":"d2000000-0000-4000-8000-000000000001"}'::jsonb,
    '{"action":"list","state":"active","period_days":7}'::jsonb,
    '{"action":"detail"}'::jsonb,
    '{"action":"detail","watchlist_id":"d2000000-0000-4000-8000-000000000001"}'::jsonb,
    '{"action":"detail","watchlist_id":"d2000000-0000-4000-8000-000000000001","period_days":14}'::jsonb,
    '{"action":"detail","watchlist_id":"d2000000-0000-4000-8000-000000000001","period_days":7.5}'::jsonb,
    '{"action":"detail","watchlist_id":"not-a-uuid","period_days":7}'::jsonb,
    '{"action":"detail","watchlist_id":123,"period_days":7}'::jsonb,
    '{"action":"detail","watchlist_id":"d2000000-0000-4000-8000-000000000001","period_days":7,"state":"active"}'::jsonb,
    '{"action":"list","state":"active","limit":0}'::jsonb,
    '{"action":"list","state":"active","limit":51}'::jsonb,
    '{"action":"list","state":"active","limit":1.5}'::jsonb,
    '{"action":"list","state":"active","limit":"20"}'::jsonb,
    '{"action":"unknown"}'::jsonb,
    '[]'::jsonb,
    '"list"'::jsonb,
    'null'::jsonb
  ];
  v_req   jsonb;
  v_state text;
  v_msg   text;
BEGIN
  FOREACH v_req IN ARRAY v_bad LOOP
    BEGIN
      PERFORM pg_temp.ctr(v_req);
      RAISE EXCEPTION 'R2 failed: the reader accepted a malformed request: %', v_req::text
        USING ERRCODE = 'assert_failure';
    EXCEPTION WHEN invalid_parameter_value THEN
      ASSERT SQLSTATE = '22023',
        'R2 a malformed request is SQLSTATE 22023, got ' || SQLSTATE;
      v_msg := SQLERRM;
      ASSERT v_msg LIKE 'COMPETITOR_REPORT_INVALID_REQUEST%',
        'R2 a malformed request names its reason, got ' || v_msg;
      -- The refusal carries no caller-supplied text and no table name.
      ASSERT v_msg NOT LIKE '%competitor_watchlist%'
         AND v_msg NOT LIKE '%SELECT%'
         AND v_msg NOT LIKE '%d1000000%',
        'R2 the refusal is sanitized, got ' || v_msg;
    END;
  END LOOP;

  -- A request that is not an object at all.
  BEGIN
    PERFORM pg_temp.ctr(NULL);
    RAISE EXCEPTION 'R2 failed: the reader accepted a null request'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN invalid_parameter_value THEN
    ASSERT SQLERRM LIKE 'COMPETITOR_REPORT_INVALID_REQUEST%',
      'R2 a null request names its reason, got ' || SQLERRM;
  END;

  -- The valid shapes are accepted, and a refusal is never an empty payload.
  FOR v_state IN SELECT unnest(ARRAY['active', 'removed']) LOOP
    DECLARE
      v_ok jsonb;
    BEGIN
      v_ok := pg_temp.ctr(jsonb_build_object('action', 'list', 'state', v_state));
      ASSERT jsonb_typeof(v_ok) = 'object', 'R2 a successful read is an object';
      ASSERT v_ok ->> 'version' = '1', 'R2 the envelope carries its version';
      ASSERT jsonb_typeof(v_ok -> 'entries') = 'array',
        'R2 the list carries an entries array';
      ASSERT v_ok ? 'quota', 'R2 the envelope carries the quota';
      ASSERT v_ok ? 'next_cursor', 'R2 the envelope carries the cursor';
    END;
  END LOOP;

  DECLARE
    v_ok jsonb;
  BEGIN
    v_ok := pg_temp.ctr(jsonb_build_object(
      'action', 'detail',
      'watchlist_id', 'd2000000-0000-4000-8000-000000000001',
      'period_days', 7));
    ASSERT jsonb_typeof(v_ok) = 'object', 'R2 a successful detail read is an object';
    ASSERT jsonb_typeof(v_ok -> 'entry') = 'object', 'R2 the detail carries the entry';
    ASSERT jsonb_typeof(v_ok -> 'media') = 'array', 'R2 the detail carries the media array';
  END;
END
$r2$;

-- ===========================================================================
-- R3 - the owner boundary.
-- ===========================================================================
DO $r3$
DECLARE
  v_missing jsonb;
  v_foreign jsonb;
  v_a_shared jsonb;
  v_b_shared jsonb;
  v_admin_list jsonb;
  v_count   integer;
BEGIN
  -- An unknown entry and another owner's entry are refused IDENTICALLY.
  BEGIN
    PERFORM pg_temp.ctr(jsonb_build_object(
      'action', 'detail',
      'watchlist_id', 'd2000000-0000-4000-8000-0000000000ff',
      'period_days', 7));
    RAISE EXCEPTION 'R3 failed: an unknown entry was readable'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN no_data_found THEN
    v_missing := jsonb_build_object('state', SQLSTATE, 'message', SQLERRM);
  END;

  BEGIN
    PERFORM pg_temp.ctr(jsonb_build_object(
      'action', 'detail',
      'watchlist_id', 'd2000000-0000-4000-8000-0000000000b1',
      'period_days', 7));
    RAISE EXCEPTION 'R3 failed: another owner''s entry was readable'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN no_data_found THEN
    v_foreign := jsonb_build_object('state', SQLSTATE, 'message', SQLERRM);
  END;

  ASSERT v_missing IS NOT NULL AND v_foreign IS NOT NULL,
    'R3 both refusals happened';
  ASSERT v_missing = v_foreign,
    'R3 an unknown entry and another owner''s entry are refused identically';

  -- Two owners, one handle, two rows.
  --
  -- The shared entry is not on the first page of the list (the paging
  -- entries are newer), so the list is walked to the end to find it.
  v_a_shared := pg_temp.ctr(jsonb_build_object('action', 'list', 'state', 'active', 'limit', 50));
  LOOP
    SELECT count(*) INTO v_count
      FROM jsonb_array_elements(v_a_shared -> 'entries') e
     WHERE e ->> 'username' = 'shared';
    EXIT WHEN v_count > 0 OR (v_a_shared ->> 'next_cursor') IS NULL;
    v_a_shared := pg_temp.ctr(jsonb_build_object(
      'action', 'list', 'state', 'active', 'limit', 50, 'cursor', v_a_shared ->> 'next_cursor'));
  END LOOP;

  ASSERT v_count = 1, 'R3 the owner sees exactly one row for the shared handle';
  ASSERT pg_temp.ctr_entry_id(v_a_shared -> 'entries', 'shared')
         = 'd2000000-0000-4000-8000-00000000000b'::uuid,
    'R3 the owner sees their own row for the shared handle';

  -- The other owner sees their own row, with their own id.
  PERFORM set_config('request.jwt.claim.sub', 'd1000000-0000-4000-8000-000000000002', true);
  v_b_shared := pg_temp.ctr(jsonb_build_object(
    'action', 'detail',
    'watchlist_id', 'd2000000-0000-4000-8000-0000000000b1',
    'period_days', 7));
  ASSERT (v_b_shared -> 'entry' ->> 'username') = 'shared',
    'R3 the second owner reads their own row for the shared handle';
  ASSERT (v_b_shared -> 'entry' ->> 'watchlist_id')
         = 'd2000000-0000-4000-8000-0000000000b1',
    'R3 the second owner reads their own id for the shared handle';

  -- The first owner cannot read the second owner's row of the same handle.
  PERFORM set_config('request.jwt.claim.sub', 'd1000000-0000-4000-8000-000000000001', true);
  BEGIN
    PERFORM pg_temp.ctr(jsonb_build_object(
      'action', 'detail',
      'watchlist_id', 'd2000000-0000-4000-8000-0000000000b1',
      'period_days', 7));
    RAISE EXCEPTION 'R3 failed: another owner''s row of the shared handle was readable'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN no_data_found THEN
    ASSERT SQLERRM LIKE 'COMPETITOR_REPORT_NOT_FOUND%',
      'R3 the cross-owner refusal names its reason, got ' || SQLERRM;
  END;

  -- An admin is not an exception: they see what they track themselves.
  PERFORM set_config('request.jwt.claim.sub', 'd1000000-0000-4000-8000-000000000003', true);
  v_admin_list := pg_temp.ctr(jsonb_build_object('action', 'list', 'state', 'active'));
  SELECT count(*) INTO v_count
    FROM jsonb_array_elements(v_admin_list -> 'entries') e
   WHERE e ->> 'username' NOT LIKE 'adm\_%';
  ASSERT v_count = 0, 'R3 the admin sees only their own entries';
  ASSERT (v_admin_list -> 'quota' ->> 'unlimited') = 'true',
    'R3 the admin is unlimited';
  ASSERT (v_admin_list -> 'quota' ->> 'max_tracked_competitors')::integer = -1,
    'R3 the admin quota is -1';

  -- The admin cannot read another owner's entry either.
  BEGIN
    PERFORM pg_temp.ctr(jsonb_build_object(
      'action', 'detail',
      'watchlist_id', 'd2000000-0000-4000-8000-000000000001',
      'period_days', 7));
    RAISE EXCEPTION 'R3 failed: the admin read another owner''s entry'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN no_data_found THEN
    ASSERT SQLERRM LIKE 'COMPETITOR_REPORT_NOT_FOUND%',
      'R3 the admin refusal names its reason, got ' || SQLERRM;
  END;
  PERFORM set_config('request.jwt.claim.sub', 'd1000000-0000-4000-8000-000000000001', true);
END
$r3$;

-- ===========================================================================
-- R4 - the lists, the entry projection and the quota.
-- ===========================================================================
DO $r4$
DECLARE
  v_active  jsonb;
  v_removed jsonb;
  v_entry   jsonb;
  v_quota   jsonb;
  v_count   integer;
BEGIN
  v_active := pg_temp.ctr(jsonb_build_object('action', 'list', 'state', 'active'));
  v_removed := pg_temp.ctr(jsonb_build_object('action', 'list', 'state', 'removed'));

  -- The two lists do not overlap and cover the owner's entries.
  SELECT count(*) INTO v_count
    FROM jsonb_array_elements(v_active -> 'entries') e
   WHERE e ->> 'is_active' <> 'true';
  ASSERT v_count = 0, 'R4 the active list carries only active entries';

  SELECT count(*) INTO v_count
    FROM jsonb_array_elements(v_removed -> 'entries') e
   WHERE e ->> 'is_active' <> 'false';
  ASSERT v_count = 0, 'R4 the removed list carries only removed entries';

  SELECT count(*) INTO v_count
    FROM jsonb_array_elements(v_removed -> 'entries') e
   WHERE e ->> 'username' NOT IN ('gone_one', 'gone_two');
  ASSERT v_count = 0, 'R4 the removed list carries exactly the removed entries';

  SELECT count(*) INTO v_count
    FROM jsonb_array_elements(v_active -> 'entries') e
   WHERE e ->> 'username' IN ('gone_one', 'gone_two');
  ASSERT v_count = 0, 'R4 the active list carries no removed entry';

  -- The entry projection of a removed entry.
  v_entry := (SELECT e FROM jsonb_array_elements(v_removed -> 'entries') e
                WHERE e ->> 'username' = 'gone_one');
  ASSERT v_entry ->> 'removed_at' = '2026-05-01T00:00:00+00:00',
    'R4 the removal instant is returned, got ' || coalesce(v_entry ->> 'removed_at', '<null>');
  ASSERT v_entry ->> 'cleanup_eligible_at' = '2026-07-30T00:00:00+00:00',
    'R4 the cleanup date is ninety elapsed days later, got '
      || coalesce(v_entry ->> 'cleanup_eligible_at', '<null>');
  ASSERT v_entry ? 'last_error_code' AND NOT (v_entry ? 'last_error'),
    'R4 the entry carries the error code and never the raw error';
  ASSERT NOT (v_entry ? 'user_id'),
    'R4 the entry never carries the owner';

  -- The quota of the envelope is the existing quota reader, in the same
  -- transaction.
  v_quota := public.read_own_competitor_quota();
  ASSERT (v_active -> 'quota') = v_quota,
    'R4 the envelope quota is the existing quota reader';
  ASSERT (v_active -> 'quota' ->> 'unlimited') = 'true',
    'R4 the override makes this owner unlimited';
  ASSERT (v_active -> 'quota' ->> 'remaining') IS NULL,
    'R4 an unlimited owner has no remaining count';
END
$r4$;

-- ===========================================================================
-- R5 - the cursor and the bounds.
-- ===========================================================================
DO $r5$
DECLARE
  v_default  jsonb;
  v_max      jsonb;
  v_page2    jsonb;
  v_total    integer;
  v_distinct integer;
  v_order    text[];
  v_pos_a1   integer;
  v_pos_a2   integer;
  v_conc     jsonb;
  v_count    integer;
BEGIN
  -- The default is twenty rows.
  v_default := pg_temp.ctr(jsonb_build_object('action', 'list', 'state', 'active'));
  ASSERT jsonb_array_length(v_default -> 'entries') = 20,
    'R5 the default page holds twenty entries, got '
      || jsonb_array_length(v_default -> 'entries')::text;
  ASSERT v_default ->> 'next_cursor' IS NOT NULL,
    'R5 the default page of a longer list carries a cursor';

  -- The maximum is fifty rows, and the page after it is the rest.
  SELECT count(*) INTO v_total
    FROM public.competitor_watchlist
   WHERE user_id = 'd1000000-0000-4000-8000-000000000001'::uuid
     AND is_active;
  ASSERT v_total > 50, 'R5 the fixture owner has more than fifty active entries';

  v_max := pg_temp.ctr(jsonb_build_object('action', 'list', 'state', 'active', 'limit', 50));
  ASSERT jsonb_array_length(v_max -> 'entries') = 50,
    'R5 the maximum page holds fifty entries, got '
      || jsonb_array_length(v_max -> 'entries')::text;
  ASSERT v_max ->> 'next_cursor' IS NOT NULL,
    'R5 the maximum page of a longer list carries a cursor';

  v_page2 := pg_temp.ctr(jsonb_build_object(
    'action', 'list', 'state', 'active', 'limit', 50, 'cursor', v_max ->> 'next_cursor'));
  ASSERT jsonb_array_length(v_page2 -> 'entries') = v_total - 50,
    'R5 the second page holds the rest, got '
      || jsonb_array_length(v_page2 -> 'entries')::text;
  ASSERT v_page2 ->> 'next_cursor' IS NULL,
    'R5 the last page carries no cursor';

  -- No entry is returned twice and none is lost.
  SELECT count(DISTINCT e ->> 'watchlist_id') INTO v_distinct
    FROM (
      SELECT jsonb_array_elements(v_max -> 'entries') AS e
      UNION ALL
      SELECT jsonb_array_elements(v_page2 -> 'entries') AS e
    ) x;
  ASSERT v_distinct = v_total, 'R5 the two pages cover every entry exactly once';

  -- The entries are ordered by (created_at DESC, id DESC), and the two
  -- entries that share one creation instant keep their identity order.
  SELECT array_agg(e ->> 'watchlist_id') INTO v_order
    FROM (
      SELECT jsonb_array_elements(v_max -> 'entries') AS e
      UNION ALL
      SELECT jsonb_array_elements(v_page2 -> 'entries') AS e
    ) x;
  v_pos_a1 := array_position(v_order, 'd2000000-0000-4000-8000-0000000000a1');
  v_pos_a2 := array_position(v_order, 'd2000000-0000-4000-8000-0000000000a2');
  ASSERT v_pos_a1 IS NOT NULL AND v_pos_a2 IS NOT NULL,
    'R5 both entries of the shared creation instant are returned';
  ASSERT v_pos_a2 = v_pos_a1 - 1,
    'R5 the shared creation instant is broken by the id, not by an accident';

  -- The first page, read before the concurrent insertion.
  v_conc := pg_temp.ctr(jsonb_build_object('action', 'list', 'state', 'active', 'limit', 5));
END
$r5$;

-- The concurrent insertion. It is written as superuser on purpose: the
-- browser role has no INSERT on the watchlist, which is exactly the point.
RESET ROLE;
INSERT INTO public.competitor_watchlist (id, user_id, platform, username)
VALUES ('d2000000-0000-4000-8000-0000000000c1', 'd1000000-0000-4000-8000-000000000001',
        'instagram', 'concurrent');
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'd1000000-0000-4000-8000-000000000001', true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);

DO $r5_concurrent$
DECLARE
  v_conc   jsonb;
  v_conc2  jsonb;
  v_count  integer;
BEGIN
  v_conc := pg_temp.ctr(jsonb_build_object('action', 'list', 'state', 'active', 'limit', 5));
  v_conc2 := pg_temp.ctr(jsonb_build_object(
    'action', 'list', 'state', 'active', 'limit', 5, 'cursor', v_conc ->> 'next_cursor'));

  SELECT count(*) INTO v_count
    FROM (
      SELECT jsonb_array_elements(v_conc -> 'entries') AS e
      UNION ALL
      SELECT jsonb_array_elements(v_conc2 -> 'entries') AS e
    ) x
   WHERE (x.e ->> 'watchlist_id') IN (
     SELECT e2 ->> 'watchlist_id'
       FROM jsonb_array_elements(v_conc -> 'entries') AS e2);
  ASSERT v_count = 5, 'R5 a concurrent insertion repeats no entry of the first page';
  ASSERT (v_conc2 -> 'entries' @> jsonb_build_array(jsonb_build_object(
            'watchlist_id', 'd2000000-0000-4000-8000-0000000000c1'))) = false,
    'R5 the concurrently inserted entry does not appear behind the cursor';
END
$r5_concurrent$;

-- The cursor is refused when it is unusable, foreign or from another filter.
DO $r5_cursor$
DECLARE
  v_active   jsonb;
  v_cursor   text;
BEGIN
  v_active := pg_temp.ctr(jsonb_build_object('action', 'list', 'state', 'active', 'limit', 3));
  v_cursor := v_active ->> 'next_cursor';

  -- Not a cursor at all.
  BEGIN
    PERFORM pg_temp.ctr(jsonb_build_object('action', 'list', 'state', 'active', 'cursor', 'not-a-cursor'));
    RAISE EXCEPTION 'R5 failed: a broken cursor was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN invalid_parameter_value THEN
    ASSERT SQLERRM LIKE 'COMPETITOR_REPORT_INVALID_CURSOR%',
      'R5 a broken cursor names its reason, got ' || SQLERRM;
  END;

  -- A cursor of another filter: the active list does not page the removed
  -- list.
  BEGIN
    PERFORM pg_temp.ctr(jsonb_build_object('action', 'list', 'state', 'removed', 'cursor', v_cursor));
    RAISE EXCEPTION 'R5 failed: a cursor of another filter was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN invalid_parameter_value THEN
    ASSERT SQLERRM LIKE 'COMPETITOR_REPORT_INVALID_CURSOR%',
      'R5 a cross-filter cursor names its reason, got ' || SQLERRM;
  END;

  -- A cursor of another owner.
  PERFORM set_config('request.jwt.claim.sub', 'd1000000-0000-4000-8000-000000000002', true);
  BEGIN
    PERFORM pg_temp.ctr(jsonb_build_object('action', 'list', 'state', 'active', 'cursor', v_cursor));
    RAISE EXCEPTION 'R5 failed: a cursor of another owner was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN invalid_parameter_value THEN
    ASSERT SQLERRM LIKE 'COMPETITOR_REPORT_INVALID_CURSOR%',
      'R5 a cross-owner cursor names its reason, got ' || SQLERRM;
  END;
  PERFORM set_config('request.jwt.claim.sub', 'd1000000-0000-4000-8000-000000000001', true);

  -- A cursor of another entry: the detail cursor is bound to its entry.
  BEGIN
    PERFORM pg_temp.ctr(jsonb_build_object(
      'action', 'detail',
      'watchlist_id', 'd2000000-0000-4000-8000-000000000009',
      'period_days', 7,
      'cursor', v_cursor));
    RAISE EXCEPTION 'R5 failed: a cursor of another entry was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN invalid_parameter_value THEN
    ASSERT SQLERRM LIKE 'COMPETITOR_REPORT_INVALID_CURSOR%',
      'R5 a cross-entry cursor names its reason, got ' || SQLERRM;
  END;

  -- A cursor longer than the bound.
  BEGIN
    PERFORM pg_temp.ctr(jsonb_build_object(
      'action', 'list', 'state', 'active', 'cursor', repeat('a', 2049)));
    RAISE EXCEPTION 'R5 failed: an oversized cursor was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN invalid_parameter_value THEN
    ASSERT SQLERRM LIKE 'COMPETITOR_REPORT_INVALID_CURSOR%',
      'R5 an oversized cursor names its reason, got ' || SQLERRM;
  END;
END
$r5_cursor$;

-- ===========================================================================
-- R6 - the S = 3 days baseline.
-- ===========================================================================
DO $r6$
DECLARE
  v_rich  jsonb;
  v_g7    jsonb;
  v_g30   jsonb;
  v_edge  jsonb;
  v_growth jsonb;
BEGIN
  -- The rich entry: one baseline exactly at the 7 day cutoff, one exactly
  -- three days before it, and one exactly at the 30 day cutoff.
  v_rich := pg_temp.ctr(jsonb_build_object(
    'action', 'detail',
    'watchlist_id', 'd2000000-0000-4000-8000-000000000001',
    'period_days', 7));
  v_g7 := v_rich -> 'entry' -> 'growth' -> '7';
  v_g30 := v_rich -> 'entry' -> 'growth' -> '30';

  ASSERT v_g7 ->> 'reason' IS NULL,
    'R6 the 7 day baseline at the cutoff is usable, reason '
      || coalesce(v_g7 ->> 'reason', '<null>');
  ASSERT v_g7 ->> 'baseline_at' = '2026-10-13T12:00:00+00:00',
    'R6 the 7 day baseline is the newest observation inside the window, got '
      || coalesce(v_g7 ->> 'baseline_at', '<null>');
  ASSERT v_g7 ->> 'observed_at' = '2026-10-20T12:00:00+00:00',
    'R6 the observed end is the latest successful observation, got '
      || coalesce(v_g7 ->> 'observed_at', '<null>');
  ASSERT (v_g7 ->> 'absolute')::numeric = 100,
    'R6 the 7 day change is 100, got ' || coalesce(v_g7 ->> 'absolute', '<null>');
  ASSERT (v_g7 ->> 'percent')::numeric = round(100.0 * 100 / 900, 6),
    'R6 the 7 day percentage is the change over the baseline, got '
      || coalesce(v_g7 ->> 'percent', '<null>');
  ASSERT (v_g7 ->> 'interval_days')::numeric = 7,
    'R6 the 7 day interval is seven days, got '
      || coalesce(v_g7 ->> 'interval_days', '<null>');

  -- The failed capture of a later day is never the observed end.
  ASSERT v_g7 ->> 'observed_at' <> '2026-10-25T12:00:00+00:00',
    'R6 a failed capture is not an observation';

  ASSERT v_g30 ->> 'reason' IS NULL,
    'R6 the 30 day baseline at the cutoff is usable, reason '
      || coalesce(v_g30 ->> 'reason', '<null>');
  ASSERT v_g30 ->> 'baseline_at' = '2026-09-20T12:00:00+00:00',
    'R6 the 30 day baseline is the newest observation inside the window, got '
      || coalesce(v_g30 ->> 'baseline_at', '<null>');
  ASSERT (v_g30 ->> 'absolute')::numeric = 200,
    'R6 the 30 day change is 200, got ' || coalesce(v_g30 ->> 'absolute', '<null>');
  ASSERT (v_g30 ->> 'interval_days')::numeric = 30,
    'R6 the 30 day interval is thirty days, got '
      || coalesce(v_g30 ->> 'interval_days', '<null>');

  -- The baseline does not depend on the displayed period.
  v_edge := pg_temp.ctr(jsonb_build_object(
    'action', 'detail',
    'watchlist_id', 'd2000000-0000-4000-8000-000000000001',
    'period_days', 30));
  ASSERT (v_edge -> 'entry' -> 'growth' -> '7') = v_g7,
    'R6 the 7 day baseline is the same whichever period is displayed';

  -- Exactly at the cutoff.
  v_edge := pg_temp.ctr(jsonb_build_object(
    'action', 'detail',
    'watchlist_id', 'd2000000-0000-4000-8000-000000000002',
    'period_days', 7));
  v_growth := v_edge -> 'entry' -> 'growth' -> '7';
  ASSERT v_growth ->> 'reason' IS NULL,
    'R6 a baseline exactly at the cutoff is accepted, reason '
      || coalesce(v_growth ->> 'reason', '<null>');
  ASSERT v_growth ->> 'baseline_at' = '2026-10-13T12:00:00+00:00',
    'R6 the baseline exactly at the cutoff is the one at the cutoff';

  -- Exactly three days before the cutoff.
  v_edge := pg_temp.ctr(jsonb_build_object(
    'action', 'detail',
    'watchlist_id', 'd2000000-0000-4000-8000-000000000003',
    'period_days', 7));
  v_growth := v_edge -> 'entry' -> 'growth' -> '7';
  ASSERT v_growth ->> 'reason' IS NULL,
    'R6 a baseline exactly three days before the cutoff is accepted, reason '
      || coalesce(v_growth ->> 'reason', '<null>');
  ASSERT v_growth ->> 'baseline_at' = '2026-10-10T12:00:00+00:00',
    'R6 the baseline at the edge of the window is the one at the edge';

  -- One microsecond before the window opens.
  v_edge := pg_temp.ctr(jsonb_build_object(
    'action', 'detail',
    'watchlist_id', 'd2000000-0000-4000-8000-000000000004',
    'period_days', 7));
  v_growth := v_edge -> 'entry' -> 'growth' -> '7';
  ASSERT v_growth ->> 'reason' = 'no_comparable_baseline',
    'R6 a baseline one microsecond too old is refused, reason '
      || coalesce(v_growth ->> 'reason', '<null>');
  ASSERT v_growth ->> 'absolute' IS NULL AND v_growth ->> 'percent' IS NULL,
    'R6 a refused baseline produces no numbers';

  -- One microsecond after the cutoff.
  v_edge := pg_temp.ctr(jsonb_build_object(
    'action', 'detail',
    'watchlist_id', 'd2000000-0000-4000-8000-000000000005',
    'period_days', 7));
  v_growth := v_edge -> 'entry' -> 'growth' -> '7';
  ASSERT v_growth ->> 'reason' = 'no_comparable_baseline',
    'R6 a baseline later than the cutoff is refused, reason '
      || coalesce(v_growth ->> 'reason', '<null>');

  -- The source changed between the two ends.
  v_edge := pg_temp.ctr(jsonb_build_object(
    'action', 'detail',
    'watchlist_id', 'd2000000-0000-4000-8000-000000000006',
    'period_days', 7));
  v_growth := v_edge -> 'entry' -> 'growth' -> '7';
  ASSERT v_growth ->> 'reason' = 'source_changed',
    'R6 an observed source change disqualifies the comparison, reason '
      || coalesce(v_growth ->> 'reason', '<null>');
  ASSERT v_growth ->> 'absolute' IS NULL AND v_growth ->> 'percent' IS NULL,
    'R6 a disqualified comparison produces no numbers';

  -- The control: the same shape without the switch is comparable, so the
  -- refusal above is the switch and not the shape.
  v_edge := pg_temp.ctr(jsonb_build_object(
    'action', 'detail',
    'watchlist_id', 'd2000000-0000-4000-8000-000000000007',
    'period_days', 7));
  v_growth := v_edge -> 'entry' -> 'growth' -> '7';
  ASSERT v_growth ->> 'reason' IS NULL,
    'R6 the same shape without a source change is comparable, reason '
      || coalesce(v_growth ->> 'reason', '<null>');
  ASSERT (v_growth ->> 'absolute')::numeric = 100,
    'R6 the comparable control has a real change';

  -- An entry that was never captured has no baseline and no profile.
  v_edge := pg_temp.ctr(jsonb_build_object(
    'action', 'detail',
    'watchlist_id', 'd2000000-0000-4000-8000-000000000009',
    'period_days', 7));
  v_growth := v_edge -> 'entry' -> 'growth' -> '7';
  ASSERT v_growth ->> 'reason' = 'first_observation',
    'R6 an entry that was never captured says so, reason '
      || coalesce(v_growth ->> 'reason', '<null>');
  ASSERT v_growth ->> 'absolute' IS NULL AND v_growth ->> 'percent' IS NULL,
    'R6 an entry that was never captured has no numbers';
  ASSERT v_edge -> 'entry' ? 'profile',
    'R6 the entry always carries the profile key';
  ASSERT (v_edge -> 'entry' ->> 'profile') IS NULL,
    'R6 an entry that was never captured has no profile';
END
$r6$;

-- ===========================================================================
-- R7 - the profile observations.
-- ===========================================================================
DO $r7$
DECLARE
  v_detail jsonb;
  v_count  integer;
  v_trunc  boolean;
BEGIN
  v_detail := pg_temp.ctr(jsonb_build_object(
    'action', 'detail',
    'watchlist_id', 'd2000000-0000-4000-8000-000000000008',
    'period_days', 7));

  v_count := jsonb_array_length(v_detail -> 'entry' -> 'observations');
  ASSERT v_count = 32, 'R7 at most thirty-two daily observations are returned, got ' || v_count::text;
  v_trunc := (v_detail -> 'entry' ->> 'observations_truncated')::boolean;
  ASSERT v_trunc, 'R7 a truncated observation history says so';

  -- A short history is not truncated.
  v_detail := pg_temp.ctr(jsonb_build_object(
    'action', 'detail',
    'watchlist_id', 'd2000000-0000-4000-8000-000000000001',
    'period_days', 7));
  v_count := jsonb_array_length(v_detail -> 'entry' -> 'observations');
  ASSERT v_count = 5, 'R7 a short history is returned whole, got ' || v_count::text;
  ASSERT (v_detail -> 'entry' ->> 'observations_truncated')::boolean = false,
    'R7 a whole history is not truncated';

  -- The observations are the newest first.
  ASSERT (v_detail -> 'entry' -> 'observations' -> 0 ->> 'captured_at')
         = '2026-10-20T12:00:00+00:00',
    'R7 the newest observation comes first, got '
      || coalesce(v_detail -> 'entry' -> 'observations' -> 0 ->> 'captured_at', '<null>');

  -- The failed capture is not an observation.
  SELECT count(*) INTO v_count
    FROM jsonb_array_elements(v_detail -> 'entry' -> 'observations') o
   WHERE o ->> 'captured_at' = '2026-10-25T12:00:00+00:00';
  ASSERT v_count = 0, 'R7 a failed capture is not an observation';
END
$r7$;

-- ===========================================================================
-- R8 - the media.
-- ===========================================================================
DO $r8$
DECLARE
  v_detail  jsonb;
  v_media   jsonb;
  v_item    jsonb;
  v_count   integer;
  v_dup     integer;
  v_newest  integer;
BEGIN
  v_detail := pg_temp.ctr(jsonb_build_object(
    'action', 'detail',
    'watchlist_id', 'd2000000-0000-4000-8000-000000000009',
    'period_days', 7,
    'limit', 50));
  v_media := v_detail -> 'media';

  -- Every distinct media item appears once, even the one captured twice.
  SELECT count(*) INTO v_count
    FROM jsonb_array_elements(v_media) m
   WHERE m ->> 'ig_media_id' = 'm_dup';
  ASSERT v_count = 1, 'R8 a media captured twice is displayed once, got ' || v_count::text;

  SELECT count(*) INTO v_dup
    FROM jsonb_array_elements(v_media) m
   WHERE m ->> 'ig_media_id' = 'm_dup'
     AND (m ->> 'view_count')::numeric = 222;
  ASSERT v_dup = 1, 'R8 the displayed observation of a media is the latest one';

  -- The distinct media of the fixture.
  SELECT count(DISTINCT m ->> 'ig_media_id') INTO v_count
    FROM jsonb_array_elements(v_media) m;
  ASSERT v_count = 21, 'R8 every distinct media item is returned, got ' || v_count::text;

  -- The reel target: at most twelve preceding media of its own cohort.
  v_item := (SELECT m FROM jsonb_array_elements(v_media) m
              WHERE m ->> 'ig_media_id' = 'm_reel_target');
  ASSERT v_item IS NOT NULL, 'R8 the reel target is displayed';
  ASSERT (v_item ->> 'metric_basis') = 'public_views',
    'R8 a reel is measured by its public views, got '
      || coalesce(v_item ->> 'metric_basis', '<null>');
  ASSERT jsonb_array_length(v_item -> 'baseline') = 12,
    'R8 the baseline holds at most twelve preceding media, got '
      || jsonb_array_length(v_item -> 'baseline')::text;
  ASSERT (v_item -> 'baseline' -> 0 ->> 'ig_media_id') = 'm_dup',
    'R8 the newest preceding media of the cohort comes first, got '
      || coalesce(v_item -> 'baseline' -> 0 ->> 'ig_media_id', '<null>');
  SELECT count(*) INTO v_count
    FROM jsonb_array_elements(v_item -> 'baseline') b
   WHERE b ->> 'ig_media_id' = 'm_reel_13';
  ASSERT v_count = 1, 'R8 the newest preceding reel is in the baseline';
  SELECT count(*) INTO v_count
    FROM jsonb_array_elements(v_item -> 'baseline') b
   WHERE b ->> 'ig_media_id' IN ('m_reel_00', 'm_reel_01', 'm_reel_02');
  ASSERT v_count = 0, 'R8 the thirteenth, fourteenth and fifteenth preceding media are not in the baseline';
  SELECT count(*) INTO v_count
    FROM jsonb_array_elements(v_item -> 'baseline') b
   WHERE b ->> 'ig_media_id' LIKE 'm_feed%';
  ASSERT v_count = 0, 'R8 the cohorts do not mix';

  -- The feed target: its cohort is the feeds only.
  v_item := (SELECT m FROM jsonb_array_elements(v_media) m
              WHERE m ->> 'ig_media_id' = 'm_feed_target');
  ASSERT (v_item ->> 'metric_basis') = 'public_interactions',
    'R8 a feed is measured by its public interactions, got '
      || coalesce(v_item ->> 'metric_basis', '<null>');
  ASSERT jsonb_array_length(v_item -> 'baseline') = 3,
    'R8 the feed baseline holds the three preceding feeds, got '
      || jsonb_array_length(v_item -> 'baseline')::text;
  -- The feed value is the interactions of the candidate, newest first.
  ASSERT (v_item -> 'baseline' -> 0 ->> 'value')::numeric = 330
     AND (v_item -> 'baseline' -> 1 ->> 'value')::numeric = 220
     AND (v_item -> 'baseline' -> 2 ->> 'value')::numeric = 110,
    'R8 the feed baseline values are the interactions of the candidates, got '
      || coalesce(v_item -> 'baseline' -> 0 ->> 'value', '<null>');

  -- An unknown product type has no basis and no baseline.
  v_item := (SELECT m FROM jsonb_array_elements(v_media) m
              WHERE m ->> 'ig_media_id' = 'm_unknown');
  ASSERT v_item ->> 'metric_basis' IS NULL,
    'R8 an unknown product type has no metric basis';
  ASSERT jsonb_array_length(v_item -> 'baseline') = 0,
    'R8 an unknown product type has no baseline';

  -- The media are the newest publication first, and the tie of one
  -- publication instant is broken by the media id, not by an accident.
  -- Three media share the newest publication instant, and 'm_unknown'
  -- sorts after the other two.
  ASSERT (v_media -> 0 ->> 'ig_media_id') = 'm_unknown',
    'R8 the newest media comes first, the tie broken by the media id, got '
      || coalesce(v_media -> 0 ->> 'ig_media_id', '<null>');
  ASSERT (v_media -> 1 ->> 'ig_media_id') = 'm_reel_target'
     AND (v_media -> 2 ->> 'ig_media_id') = 'm_feed_target',
    'R8 the shared publication instant has one total order';
  SELECT count(*) INTO v_newest
    FROM (
      SELECT (m ->> 'published_at')::timestamptz AS published
        FROM jsonb_array_elements(v_media) m
    ) x
   WHERE x.published > (SELECT (m ->> 'published_at')::timestamptz
                           FROM jsonb_array_elements(v_media) m
                          WHERE m ->> 'ig_media_id' = 'm_reel_target');
  ASSERT v_newest = 0, 'R8 nothing is published after the newest media';
END
$r8$;

-- ===========================================================================
-- R9 - the coverage and the job projection.
-- ===========================================================================
DO $r9$
DECLARE
  v_detail jsonb;
  v_job    jsonb;
  v_raw    text;
  v_count  integer;
BEGIN
  v_detail := pg_temp.ctr(jsonb_build_object(
    'action', 'detail',
    'watchlist_id', 'd2000000-0000-4000-8000-000000000001',
    'period_days', 7));
  v_raw := v_detail::text;

  -- The coverage evidence is returned.
  v_count := jsonb_array_length(v_detail -> 'entry' -> 'coverage');
  ASSERT v_count = 2, 'R9 the capture coverage is returned, got ' || v_count::text;
  ASSERT (v_detail -> 'entry' -> 'coverage' -> 0 ->> 'captured_on') = '2026-10-20',
    'R9 the newest coverage day comes first, got '
      || coalesce(v_detail -> 'entry' -> 'coverage' -> 0 ->> 'captured_on', '<null>');
  ASSERT (v_detail -> 'entry' -> 'coverage' -> 0 ->> 'ordering_verified')::boolean,
    'R9 the coverage carries the ordering evidence';

  -- The job status is returned, without the internals.
  v_job := v_detail -> 'entry' -> 'job';
  ASSERT v_job IS NOT NULL, 'R9 the current job is returned';
  ASSERT v_job ->> 'status' = 'leased', 'R9 the job status is returned, got '
      || coalesce(v_job ->> 'status', '<null>');
  ASSERT v_job ->> 'job_generation' = '3', 'R9 the job generation is returned';

  -- The lease, the claim token, the credential context and the raw error
  -- never reach the owner.
  ASSERT v_raw NOT LIKE '%lease_token%', 'R9 the lease token never reaches the owner';
  ASSERT v_raw NOT LIKE '%lease_expires_at%', 'R9 the lease expiry never reaches the owner';
  ASSERT v_raw NOT LIKE '%claim_token%', 'R9 the claim token never reaches the owner';
  ASSERT v_raw NOT LIKE '%context_viewer%', 'R9 the credential context never reaches the owner';
  ASSERT v_raw NOT LIKE '%credential_generation%', 'R9 the credential generation never reaches the owner';
  ASSERT v_raw NOT LIKE '%login_kind%', 'R9 the login kind never reaches the owner';
  ASSERT v_raw NOT LIKE '%token-synthetic%', 'R9 no credential reaches the owner';
  ASSERT v_raw NOT LIKE '%provider said%', 'R9 the raw provider error never reaches the owner';
  ASSERT v_raw NOT LIKE '%"last_error":%', 'R9 the raw error column never reaches the owner';

  -- The error code of a failed entry is returned, and only the code.
  v_detail := pg_temp.ctr(jsonb_build_object(
    'action', 'detail',
    'watchlist_id', 'd2000000-0000-4000-8000-00000000000c',
    'period_days', 7));
  ASSERT (v_detail -> 'entry' ->> 'last_error_code') = 'token_invalid',
    'R9 the stable error code is returned, got '
      || coalesce(v_detail -> 'entry' ->> 'last_error_code', '<null>');
  ASSERT v_detail::text NOT LIKE '%provider said%',
    'R9 the raw error text of a failed entry never reaches the owner';
END
$r9$;

-- ===========================================================================
-- R10 - the bounds and the incompleteness flag.
-- ===========================================================================
DO $r10$
DECLARE
  v_detail jsonb;
  v_item   jsonb;
  v_count  integer;
BEGIN
  -- The media page of the detail read is bounded and paged.
  v_detail := pg_temp.ctr(jsonb_build_object(
    'action', 'detail',
    'watchlist_id', 'd2000000-0000-4000-8000-000000000009',
    'period_days', 7,
    'limit', 5));
  ASSERT jsonb_array_length(v_detail -> 'media') = 5,
    'R10 the media page holds the requested number of rows, got '
      || jsonb_array_length(v_detail -> 'media')::text;
  ASSERT v_detail ->> 'next_cursor' IS NOT NULL,
    'R10 a longer media list carries a cursor';

  -- A media whose baseline was proven is not incomplete.
  v_item := (SELECT m FROM jsonb_array_elements(v_detail -> 'media') m
              WHERE m ->> 'ig_media_id' = 'm_reel_target');
  ASSERT v_item IS NOT NULL, 'R10 the reel target is on the first media page';
  ASSERT (v_item ->> 'baseline_incomplete')::boolean = false,
    'R10 a proven baseline is not incomplete';

  -- The media of the second page do not repeat the first page.
  DECLARE
    v_page2 jsonb;
  BEGIN
    v_page2 := pg_temp.ctr(jsonb_build_object(
      'action', 'detail',
      'watchlist_id', 'd2000000-0000-4000-8000-000000000009',
      'period_days', 7,
      'limit', 5,
      'cursor', v_detail ->> 'next_cursor'));
    SELECT count(*) INTO v_count
      FROM (
        SELECT jsonb_array_elements(v_detail -> 'media') AS m
        UNION ALL
        SELECT jsonb_array_elements(v_page2 -> 'media') AS m
      ) x
     WHERE (x.m ->> 'ig_media_id') IN (
       SELECT m2 ->> 'ig_media_id'
         FROM jsonb_array_elements(v_detail -> 'media') AS m2);
    ASSERT v_count = 5, 'R10 the second media page repeats nothing';
  END;

  -- A capped scan that cannot prove the eligibility of a baseline says so
  -- instead of presenting an empty baseline as a complete one.
  v_detail := pg_temp.ctr(jsonb_build_object(
    'action', 'detail',
    'watchlist_id', 'd2000000-0000-4000-8000-00000000000d',
    'period_days', 7));
  v_item := (SELECT m FROM jsonb_array_elements(v_detail -> 'media') m
              WHERE m ->> 'ig_media_id' = 'm_flood');
  ASSERT v_item IS NOT NULL, 'R10 the flooded media is still displayed';
  ASSERT (v_item ->> 'baseline_incomplete')::boolean,
    'R10 a capped scan that cannot prove the baseline says so';
  ASSERT jsonb_array_length(v_item -> 'baseline') = 0,
    'R10 an unprovable baseline is empty rather than short';
END
$r10$;

RESET ROLE;

SELECT set_config('request.jwt.claim.role', '', true);
SELECT set_config('request.jwt.claim.sub', '', true);

ROLLBACK;

\echo 'ALL CHECKS PASSED'
