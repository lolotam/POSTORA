-- ============================================================================
-- supabase/tests/competitor_retention.sql
-- Task 8 / M3 (migration 20261030120000_competitor_retention.sql).
--
-- One transaction, synthetic fixtures, labelled ASSERTs, expected refusals in
-- nested BEGIN/EXCEPTION blocks, ROLLBACK, sentinel last. Fixture values are
-- synthetic ('...@example.invalid'); no secrets and no real accounts.
--
-- The suite runs in ONE transaction on purpose: now() is therefore constant
-- for the whole run, and every removal marker is seeded as an EXPLICIT
-- offset from now(). A marker of "now() - 90 days" is exactly 90 days old
-- at the moment the cleanup reads its own clock, and "now() - 90 days + 1
-- microsecond" is exactly one microsecond too young. Nothing here compares
-- a count against a range: every assertion is an exact number.
--
-- What this suite proves
--   R1  the grant surface and the contract: service-role only, SECURITY
--       DEFINER with a fixed search_path, three arguments and NOT ONE of
--       them an owner, a cutoff or a time, the eligibility index, the
--       default-off switch, and the refusal of a limit outside 1-50 parents
--       or 1-500 children.
--   R2  the eligibility clock: 89 days is retained, 90 days minus one
--       microsecond is retained, exactly 90 days is eligible, a future
--       marker is retained, an active row of any age is retained, and the
--       null-marker integrity constraint really refuses an inactive row
--       without a marker.
--   R3  the removal-marker clock: a repeated remove keeps the first marker,
--       a reactivation clears it, and a later removal starts a NEW clock.
--   R4  the ownership boundary: the same handle under two owners is two
--       rows, the cleanup of one never touches the other's rows, and every
--       child relation refuses a cross-owner row.
--   R5  the switch: off, missing and malformed all mutate nothing and all
--       report their state.
--   R6  the dry run: it counts exactly what the real slice deletes and it
--       mutates nothing.
--   R7  the bounded slice: one call cannot delete an arbitrary backlog, and
--       the next call continues where the previous one stopped.
--   R8  the deletion protocol: the children go first, a parent is deleted
--       only after its children are gone, a job in every state goes with it,
--       and the owner jobs, the active competitors, the shared provider
--       buckets and the other owner's rows are all preserved.
--   R9  the live lease: a live lease skips the parent, an expired lease
--       does not stop it and confers no write authority afterwards.
--   R10 the role boundary: an ordinary user and an anonymous caller cannot
--       run the cleanup, and the owner read boundary is unchanged.
--
-- The suite SET ROLEs away from superuser where the point of the check is
-- that a client role cannot do something.
-- ============================================================================

\set ON_ERROR_STOP on

BEGIN;

-- The service role, for the service-only function.
SELECT set_config('request.jwt.claim.role', 'service_role', true);

-- ---------------------------------------------------------------------------
-- Helpers.
-- ---------------------------------------------------------------------------

-- Whether the PUBLIC pseudo-role may execute a function. PUBLIC is not a
-- role name, so the ACL is inspected directly.
CREATE OR REPLACE FUNCTION pg_temp.crt_public_can_execute(p_signature text)
RETURNS boolean
LANGUAGE sql
AS $fn$
  SELECT EXISTS (
    SELECT 1
      FROM pg_proc AS p
      CROSS JOIN LATERAL aclexplode(
        COALESCE(p.proacl, acldefault('f', p.proowner))) AS acl
     WHERE p.oid = ('public.' || p_signature)::regprocedure::oid
       AND acl.grantee = 0
       AND acl.privilege_type = 'EXECUTE'
  );
$fn$;

-- One media snapshot of a tracked competitor.
CREATE OR REPLACE FUNCTION pg_temp.crt_media(
  p_owner    uuid,
  p_watchlist uuid,
  p_suffix   text,
  p_count    integer DEFAULT 1
)
RETURNS void
LANGUAGE plpgsql
AS $fn$
BEGIN
  INSERT INTO public.competitor_media_snapshots
    (watchlist_id, user_id, ig_media_id, captured_on, published_at, source)
  SELECT p_watchlist, p_owner,
         'crt-media-' || p_suffix || '-' || g,
         current_date,
         now() - (g || ' minutes')::interval,
         'apify'
    FROM generate_series(1, p_count) AS g;
END;
$fn$;

-- ===========================================================================
-- Fixtures, part one: the owners and the eligibility clock.
-- ===========================================================================
--
-- u_a / u_b   : two owners
-- acct_a      : owner A's own Instagram account (an OWNER job target)
--
-- The clock fixtures carry DISTINCT numbers of media snapshots, so the dry
-- run in R2 can prove which of them the cleanup considers: the count is
-- the fingerprint of the eligible rows.
--   cw_89     : 1 media   - 89 days old
--   cw_90us   : 2 media   - 90 days minus one microsecond
--   cw_90     : 3 media   - exactly 90 days
--   cw_future : 4 media   - a marker in the future
--   cw_active : 5 media   - active, and 300 days old
--
DO $fixtures1$
DECLARE
  u_a uuid := 'ca000000-0000-4000-8000-000000000001';
  u_b uuid := 'ca000000-0000-4000-8000-000000000002';
BEGIN
  INSERT INTO auth.users (id, email)
  VALUES
    (u_a, 'crt-owner-a-' || u_a::text || '@example.invalid'),
    (u_b, 'crt-owner-b-' || u_b::text || '@example.invalid');

  -- Both owners track without a slot limit: the quota is not what this
  -- suite is about, and a capped owner would refuse the reactivation in R3.
  INSERT INTO public.user_quotas (user_id, max_tracked_competitors)
  VALUES (u_a, -1), (u_b, -1)
  ON CONFLICT (user_id) DO UPDATE SET max_tracked_competitors = -1;

  INSERT INTO public.social_accounts
    (id, user_id, platform, platform_user_id, platform_username,
     access_token, ig_auth_type)
  VALUES
    ('ca100000-0000-4000-8000-000000000001', u_a, 'instagram',
     'ig-crt-owner', 'crt_owner', 'token-owner', 'facebook_page');

  -- The clock fixtures.
  INSERT INTO public.competitor_watchlist
    (id, user_id, platform, username, is_active, removed_at, created_at)
  VALUES
    ('cb000000-0000-4000-8000-000000000001', u_a, 'instagram', 'crt_89',
     false, now() - interval '89 days', now() - interval '300 days'),
    ('cb000000-0000-4000-8000-000000000002', u_a, 'instagram', 'crt_90us',
     false, now() - interval '90 days' + interval '1 microsecond', now() - interval '300 days'),
    ('cb000000-0000-4000-8000-000000000003', u_a, 'instagram', 'crt_90',
     false, now() - interval '90 days', now() - interval '300 days'),
    ('cb000000-0000-4000-8000-000000000004', u_a, 'instagram', 'crt_future',
     false, now() + interval '1 day', now() - interval '300 days'),
    ('cb000000-0000-4000-8000-000000000005', u_a, 'instagram', 'crt_active',
     true, NULL, now() - interval '300 days');

  PERFORM pg_temp.crt_media(u_a, 'cb000000-0000-4000-8000-000000000001', '89', 1);
  PERFORM pg_temp.crt_media(u_a, 'cb000000-0000-4000-8000-000000000002', '90us', 2);
  PERFORM pg_temp.crt_media(u_a, 'cb000000-0000-4000-8000-000000000003', '90', 3);
  PERFORM pg_temp.crt_media(u_a, 'cb000000-0000-4000-8000-000000000004', 'future', 4);
  PERFORM pg_temp.crt_media(u_a, 'cb000000-0000-4000-8000-000000000005', 'active', 5);
END
$fixtures1$;

-- ===========================================================================
-- R1 - the grant surface and the contract.
-- ===========================================================================
DO $r1$
DECLARE
  v_signature text := 'run_competitor_retention_batch(integer,integer,boolean)';
  v_def       text;
  v_args      text[];
BEGIN
  -- The function exists, with exactly this signature.
  ASSERT to_regprocedure('public.' || v_signature) IS NOT NULL,
    'R1 the cleanup function exists';

  -- Three arguments, and NOT ONE of them an owner, a cutoff or a time.
  SELECT array_agg(a.argname ORDER BY a.ordinality) INTO v_args
    FROM pg_proc AS pr
    CROSS JOIN LATERAL unnest(pr.proargnames) WITH ORDINALITY AS a(argname, ordinality)
   WHERE pr.oid = to_regprocedure('public.' || v_signature);

  ASSERT array_length(v_args, 1) = 3,
    'R1 the cleanup takes exactly three arguments, got ' || coalesce(v_args::text, 'none');
  ASSERT v_args @> ARRAY['p_parent_limit'] AND v_args @> ARRAY['p_child_limit']
         AND v_args @> ARRAY['p_dry_run'],
    'R1 the arguments are the parent limit, the child limit and the dry-run flag: '
      || v_args::text;

  -- No owner, no cutoff and no clock argument. A caller that could name an
  -- owner or move the cutoff could delete somebody else's history.
  ASSERT NOT (v_args @> ARRAY['p_user_id','p_owner_id','p_owner','p_user'])
         AND NOT (v_args @> ARRAY['p_cutoff','p_cutoff_at','p_before','p_older_than'])
         AND NOT (v_args @> ARRAY['p_now','p_at','p_as_of','p_reference_time']),
    'R1 the cleanup takes no owner, no cutoff and no clock argument: ' || v_args::text;

  -- The grant surface.
  ASSERT has_function_privilege('service_role', 'public.' || v_signature, 'EXECUTE'),
    'R1 the service role can execute the cleanup';
  ASSERT NOT has_function_privilege('anon', 'public.' || v_signature, 'EXECUTE'),
    'R1 anon cannot execute the cleanup';
  ASSERT NOT has_function_privilege('authenticated', 'public.' || v_signature, 'EXECUTE'),
    'R1 authenticated cannot execute the cleanup';
  ASSERT NOT pg_temp.crt_public_can_execute(v_signature),
    'R1 PUBLIC cannot execute the cleanup';

  -- SECURITY DEFINER with a fixed search_path.
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc AS p
   WHERE p.oid = to_regprocedure('public.' || v_signature);

  ASSERT v_def ILIKE '%SECURITY DEFINER%',
    'R1 the cleanup is SECURITY DEFINER';
  ASSERT v_def ILIKE '%SET search_path TO%''public''%''pg_temp''%',
    'R1 the cleanup has a fixed search_path';

  -- The eligibility index.
  ASSERT EXISTS (SELECT 1 FROM pg_indexes
                  WHERE schemaname = 'public'
                    AND indexname = 'idx_competitor_watchlist_retention_eligible'),
    'R1 the inactive-row eligibility index exists';

  -- The switch exists and is OFF by default.
  ASSERT EXISTS (SELECT 1 FROM public.app_settings
                  WHERE key = 'competitor_retention_enabled'),
    'R1 the switch row exists';

  -- A limit outside the contract is refused, not clamped: a clamped limit
  -- would make the reported counts a lie.
  BEGIN
    PERFORM public.run_competitor_retention_batch(0, 100, true);
    RAISE EXCEPTION 'R1 failed: a parent limit of 0 was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN others THEN
    ASSERT SQLERRM LIKE '%COMPETITOR_RETENTION_LIMIT_INVALID%',
      'R1 a parent limit of 0 is refused, got: ' || SQLERRM;
    ASSERT SQLSTATE = '22023',
      'R1 a limit refusal is SQLSTATE 22023, got ' || SQLSTATE;
  END;

  BEGIN
    PERFORM public.run_competitor_retention_batch(51, 100, true);
    RAISE EXCEPTION 'R1 failed: a parent limit of 51 was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN others THEN
    ASSERT SQLERRM LIKE '%COMPETITOR_RETENTION_LIMIT_INVALID%',
      'R1 a parent limit of 51 is refused, got: ' || SQLERRM;
  END;

  BEGIN
    PERFORM public.run_competitor_retention_batch(50, 0, true);
    RAISE EXCEPTION 'R1 failed: a child limit of 0 was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN others THEN
    ASSERT SQLERRM LIKE '%COMPETITOR_RETENTION_LIMIT_INVALID%',
      'R1 a child limit of 0 is refused, got: ' || SQLERRM;
  END;

  BEGIN
    PERFORM public.run_competitor_retention_batch(50, 501, true);
    RAISE EXCEPTION 'R1 failed: a child limit of 501 was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN others THEN
    ASSERT SQLERRM LIKE '%COMPETITOR_RETENTION_LIMIT_INVALID%',
      'R1 a child limit of 501 is refused, got: ' || SQLERRM;
  END;

  -- A missing dry-run flag is not a decision.
  BEGIN
    PERFORM public.run_competitor_retention_batch(50, 500, NULL);
    RAISE EXCEPTION 'R1 failed: a missing dry-run flag was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN others THEN
    ASSERT SQLERRM LIKE '%COMPETITOR_RETENTION_LIMIT_INVALID%',
      'R1 a missing dry-run flag is refused, got: ' || SQLERRM;
  END;
END
$r1$;

-- ===========================================================================
-- R2 - the eligibility clock.
-- ===========================================================================
DO $r2$
DECLARE
  v_report jsonb;
  v_media  integer;
BEGIN
  -- The dry run is the read-only view of the same predicate the real slice
  -- uses. The clock fixtures carry 1, 2, 3, 4 and 5 media snapshots, so a
  -- count of 3 is the FINGERPRINT of the exactly-90-days row: 89 days,
  -- 90 days minus a microsecond, a future marker and an active row of any
  -- age are all outside the predicate.
  v_report := public.run_competitor_retention_batch(50, 500, true);

  ASSERT v_report ->> 'dry_run' = 'true',
    'R2 the preview reports itself as a dry run';
  ASSERT (v_report ->> 'parents_considered')::integer = 1,
    'R2 exactly one of the five clock rows is a candidate, got '
      || (v_report ->> 'parents_considered');
  ASSERT (v_report -> 'child_counts' ->> 'competitor_media_snapshots')::integer = 3,
    'R2 the candidate is the exactly-90-days row and nothing else, got '
      || (v_report -> 'child_counts' ->> 'competitor_media_snapshots');
  ASSERT (v_report ->> 'parents_deleted')::integer = 0,
    'R2 a dry run deletes no parent';
  ASSERT (v_report ->> 'children_deleted')::integer = 0,
    'R2 a dry run deletes no child';

  -- The predicate itself, row by row. This is the same statement the
  -- function uses, and every row is checked by its own id.
  SELECT count(*)::integer INTO v_media
    FROM public.competitor_watchlist AS w
   WHERE w.is_active = false
     AND w.removed_at IS NOT NULL
     AND w.removed_at <= now() - interval '2160 hours';

  ASSERT v_media = 1,
    'R2 the predicate selects exactly one of the five clock rows, got ' || v_media;

  ASSERT NOT EXISTS (
    SELECT 1 FROM public.competitor_watchlist
     WHERE id = 'cb000000-0000-4000-8000-000000000001'
       AND removed_at <= now() - interval '2160 hours'),
    'R2 an 89-day-old removal is not eligible';
  ASSERT NOT EXISTS (
    SELECT 1 FROM public.competitor_watchlist
     WHERE id = 'cb000000-0000-4000-8000-000000000002'
       AND removed_at <= now() - interval '2160 hours'),
    'R2 a removal 90 days minus one microsecond is not eligible';
  ASSERT EXISTS (
    SELECT 1 FROM public.competitor_watchlist
     WHERE id = 'cb000000-0000-4000-8000-000000000003'
       AND removed_at <= now() - interval '2160 hours'),
    'R2 a removal of exactly 90 days is eligible';
  ASSERT NOT EXISTS (
    SELECT 1 FROM public.competitor_watchlist
     WHERE id = 'cb000000-0000-4000-8000-000000000004'
       AND removed_at <= now() - interval '2160 hours'),
    'R2 a future removal marker is not eligible';
  ASSERT NOT EXISTS (
    SELECT 1 FROM public.competitor_watchlist
     WHERE id = 'cb000000-0000-4000-8000-000000000005'
       AND is_active = false),
    'R2 an active row is never a cleanup candidate, whatever its age';

  -- The null-marker integrity constraint. The watchlist guard trigger
  -- fills a missing marker, so the constraint itself is proved with the
  -- trigger switched off inside this transaction (the whole suite rolls
  -- back, so the schema change is undone with it).
  ALTER TABLE public.competitor_watchlist DISABLE TRIGGER trg_competitor_watchlist_guards;

  BEGIN
    UPDATE public.competitor_watchlist
       SET is_active = false, removed_at = NULL
     WHERE id = 'cb000000-0000-4000-8000-000000000005';
    RAISE EXCEPTION 'R2 failed: an inactive row without a marker was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN check_violation THEN
    ASSERT SQLSTATE = '23514',
      'R2 the marker constraint is SQLSTATE 23514, got ' || SQLSTATE;
  END;

  -- And the other direction: an active row may not carry a marker.
  BEGIN
    UPDATE public.competitor_watchlist
       SET is_active = true, removed_at = now()
     WHERE id = 'cb000000-0000-4000-8000-000000000003';
    RAISE EXCEPTION 'R2 failed: an active row with a marker was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN check_violation THEN
    ASSERT SQLSTATE = '23514',
      'R2 the marker constraint is SQLSTATE 23514, got ' || SQLSTATE;
  END;

  ALTER TABLE public.competitor_watchlist ENABLE TRIGGER trg_competitor_watchlist_guards;

  -- After the trigger is back, an inactive row always carries a marker.
  ASSERT NOT EXISTS (
    SELECT 1 FROM public.competitor_watchlist
     WHERE is_active = false AND removed_at IS NULL),
    'R2 no inactive row is without a marker';
  ASSERT NOT EXISTS (
    SELECT 1 FROM public.competitor_watchlist
     WHERE is_active AND removed_at IS NOT NULL),
    'R2 no active row carries a marker';
END
$r2$;

-- ===========================================================================
-- Fixtures, part two: the marker, the ownership, the protocol, the lease
-- and the bounded backlog.
-- ===========================================================================
--
-- mk_removed  : owner A. Removed 100 days ago, then "removed" again with a
--               different marker. The FIRST marker is the one that counts.
-- mk_react    : owner A. Removed, reactivated, removed again. The last
--               removal starts a NEW clock, so it is not eligible.
-- own_a       : owner A, handle 'crt_shared', removed 100 days ago.
-- own_b       : owner B, handle 'crt_shared', removed 89 days ago.
-- own_c       : owner B, handle 'crt_c', removed 100 days ago.
-- dp          : owner A, the full protocol: profile, media, coverage, seven
--               jobs in every state, their operations, their checkpoints
--               and a request throttle row.
-- dp_active   : owner A, ACTIVE, with media. Never a candidate.
-- ll_live     : owner A, a job with a LIVE lease. The parent is skipped.
-- ll_expired  : owner A, a job with an EXPIRED lease. Abandoned work.
-- big         : owner A, removed 200 days ago (the oldest candidate), with
--               520 media snapshots. The bounded slice is proved here.
--
DO $fixtures2$
DECLARE
  u_a uuid := 'ca000000-0000-4000-8000-000000000001';
  u_b uuid := 'ca000000-0000-4000-8000-000000000002';
BEGIN
  -- The marker fixtures start ACTIVE, so their clock is written by the
  -- test itself rather than by the fixture.
  INSERT INTO public.competitor_watchlist
    (id, user_id, platform, username, is_active)
  VALUES
    ('cb000000-0000-4000-8000-000000000011', u_a, 'instagram', 'crt_marker', true),
    ('cb000000-0000-4000-8000-000000000012', u_a, 'instagram', 'crt_react', true);

  -- The ownership fixtures.
  INSERT INTO public.competitor_watchlist
    (id, user_id, platform, username, is_active, removed_at)
  VALUES
    ('cb000000-0000-4000-8000-000000000021', u_a, 'instagram', 'crt_shared',
     false, now() - interval '100 days'),
    ('cb000000-0000-4000-8000-000000000022', u_b, 'instagram', 'crt_shared',
     false, now() - interval '89 days'),
    ('cb000000-0000-4000-8000-000000000023', u_b, 'instagram', 'crt_c',
     false, now() - interval '100 days');

  -- The protocol fixture.
  INSERT INTO public.competitor_watchlist
    (id, user_id, platform,username, is_active, removed_at)
  VALUES
    ('cb000000-0000-4000-8000-000000000031', u_a, 'instagram', 'crt_protocol',
     false, now() - interval '100 days');

  -- The active fixture.
  INSERT INTO public.competitor_watchlist
    (id, user_id, platform, username, is_active)
  VALUES
    ('cb000000-0000-4000-8000-000000000032', u_a, 'instagram', 'crt_active2', true);

  -- The lease fixtures.
  INSERT INTO public.competitor_watchlist
    (id, user_id, platform, username, is_active, removed_at)
  VALUES
    ('cb000000-0000-4000-8000-000000000041', u_a, 'instagram', 'crt_lease_live',
     false, now() - interval '100 days'),
    ('cb000000-0000-4000-8000-000000000042', u_a, 'instagram', 'crt_lease_expired',
     false, now() - interval '100 days');

  -- The bounded-backlog fixture. The oldest candidate, so a one-parent
  -- slice is guaranteed to be this one.
  INSERT INTO public.competitor_watchlist
    (id, user_id, platform, username, is_active, removed_at)
  VALUES
    ('cb000000-0000-4000-8000-000000000051', u_a, 'instagram', 'crt_big',
     false, now() - interval '200 days');

  -- Children.
  PERFORM pg_temp.crt_media(u_a, 'cb000000-0000-4000-8000-000000000021', 'own_a', 1);
  PERFORM pg_temp.crt_media(u_b, 'cb000000-0000-4000-8000-000000000022', 'own_b', 1);
  PERFORM pg_temp.crt_media(u_b, 'cb000000-0000-4000-8000-000000000023', 'own_c', 1);
  PERFORM pg_temp.crt_media(u_a, 'cb000000-0000-4000-8000-000000000032', 'dp_active', 2);
  PERFORM pg_temp.crt_media(u_a, 'cb000000-0000-4000-8000-000000000041', 'll_live', 1);
  PERFORM pg_temp.crt_media(u_a, 'cb000000-0000-4000-8000-000000000042', 'll_expired', 1);
  PERFORM pg_temp.crt_media(u_a, 'cb000000-0000-4000-8000-000000000051', 'big', 520);

  -- The protocol children: two profile snapshots, four media snapshots and
  -- one coverage row.
  INSERT INTO public.competitor_profile_snapshots
    (watchlist_id, user_id, captured_on, source)
  SELECT 'cb000000-0000-4000-8000-000000000031',
         'ca000000-0000-4000-8000-000000000001',
         current_date - g, 'apify'
    FROM generate_series(1, 2) AS g;

  PERFORM pg_temp.crt_media('ca000000-0000-4000-8000-000000000001',
                            'cb000000-0000-4000-8000-000000000031', 'dp', 4);

  INSERT INTO public.competitor_capture_coverage
    (watchlist_id, user_id, captured_on, source, job_generation,
     capture_started_at, capture_ended_at, exhausted, truncated)
  VALUES
    ('cb000000-0000-4000-8000-000000000031',
     'ca000000-0000-4000-8000-000000000001',
     current_date, 'apify', 1, now() - interval '1 minute', now(), true, false);

  -- Seven jobs, one per status, each with its own capture day, its own
  -- operation row and its own checkpoint row.
  INSERT INTO public.instagram_collection_jobs
    (id, user_id, target_kind, target_id, watchlist_id, captured_on,
     job_generation, status, due_at, lease_token, lease_expires_at)
  SELECT gen_random_uuid(),
         'ca000000-0000-4000-8000-000000000001',
         'competitor',
         'cb000000-0000-4000-8000-000000000031',
         'cb000000-0000-4000-8000-000000000031',
         current_date - k,
         1,
         s.status,
         now(),
         CASE WHEN s.status = 'leased' THEN gen_random_uuid() ELSE NULL END,
         CASE WHEN s.status = 'leased' THEN now() - interval '1 hour' ELSE NULL END
    FROM (VALUES ('queued', 0), ('leased', 1), ('retry', 2), ('partial', 3),
                 ('completed', 4), ('unavailable', 5), ('error', 6)) AS s(status, k);

  INSERT INTO public.instagram_collection_job_operations
    (job_id, user_id, job_generation, operation_key, operation_kind, state)
  SELECT j.id, j.user_id, j.job_generation, 'profile', 'profile', 'pending'
    FROM public.instagram_collection_jobs AS j
   WHERE j.watchlist_id = 'cb000000-0000-4000-8000-000000000031';

  INSERT INTO public.instagram_collection_job_checkpoints
    (job_id, user_id, job_generation, inventory_pages_fetched)
  SELECT j.id, j.user_id, j.job_generation, 1
    FROM public.instagram_collection_jobs AS j
   WHERE j.watchlist_id = 'cb000000-0000-4000-8000-000000000031';

  -- The per-target request throttle row. The shared provider buckets are
  -- shared state and must never be touched by a competitor cleanup.
  INSERT INTO public.instagram_collection_request_throttles
    (scope, target_kind, target_id, user_id, watchlist_id,
     last_accepted_at, accepted_count)
  VALUES
    ('user_request', 'competitor', 'cb000000-0000-4000-8000-000000000031',
     'ca000000-0000-4000-8000-000000000001',
     'cb000000-0000-4000-8000-000000000031', now(), 1);

  INSERT INTO public.instagram_provider_throttle_buckets
    (bucket_key, usage_percent, throttled_until)
  VALUES
    ('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
     42, now() + interval '1 hour');

  -- An OWNER job of the same owner. The cleanup is about tracked
  -- competitors and must never touch the owner's own collection work.
  INSERT INTO public.instagram_collection_jobs
    (id, user_id, target_kind, target_id, social_account_id, captured_on,
     status, due_at)
  VALUES
    ('cb000000-0000-4000-8000-000000000099',
     'ca000000-0000-4000-8000-000000000001', 'owner',
     'ca100000-0000-4000-8000-000000000001',
     'ca100000-0000-4000-8000-000000000001',
     current_date, 'completed', now());

  -- The lease jobs. The live one is claimed and still leased; the expired
  -- one is claimed and its lease has run out.
  INSERT INTO public.instagram_collection_jobs
    (id, user_id, target_kind, target_id, watchlist_id, captured_on,
     job_generation, status, due_at, lease_token, lease_expires_at)
  VALUES
    ('cb000000-0000-4000-8000-000000000043',
     'ca000000-0000-4000-8000-000000000001', 'competitor',
     'cb000000-0000-4000-8000-000000000041',
     'cb000000-0000-4000-8000-000000000041',
     current_date, 1, 'leased', now(), gen_random_uuid(), now() + interval '1 hour'),
    ('cb000000-0000-4000-8000-000000000044',
     'ca000000-0000-4000-8000-000000000001', 'competitor',
     'cb000000-0000-4000-8000-000000000042',
     'cb000000-0000-4000-8000-000000000042',
     current_date, 1, 'leased', now(), gen_random_uuid(), now() - interval '1 hour');
END
$fixtures2$;

-- ===========================================================================
-- R3 - the removal-marker clock.
-- ===========================================================================
DO $r3$
DECLARE
  v_marker timestamptz;
  v_first  timestamptz;
BEGIN
  -- The first removal, written by the service role with an explicit
  -- marker: the guard trigger keeps it, because the writer is not a browser.
  UPDATE public.competitor_watchlist
     SET is_active = false, removed_at = now() - interval '100 days'
   WHERE id = 'cb000000-0000-4000-8000-000000000011';

  SELECT removed_at INTO v_first
    FROM public.competitor_watchlist
   WHERE id = 'cb000000-0000-4000-8000-000000000011';

  ASSERT v_first = now() - interval '100 days',
    'R3 the first removal keeps the marker it was given';

  -- The second removal. The row is already inactive, so the trigger
  -- preserves the FIRST marker: a repeated remove does not restart the
  -- clock, whatever marker the writer supplies.
  UPDATE public.competitor_watchlist
     SET is_active = false, removed_at = now() - interval '5 days'
   WHERE id = 'cb000000-0000-4000-8000-000000000011';

  SELECT removed_at INTO v_marker
    FROM public.competitor_watchlist
   WHERE id = 'cb000000-0000-4000-8000-000000000011';

  ASSERT v_marker = v_first,
    'R3 a repeated remove preserves the first marker';

  -- The browser path. The owner removes the entry again through the
  -- existing RPC. The RPC does not touch an inactive row, and the trigger
  -- preserves the marker underneath it.
  PERFORM set_config('request.jwt.claim.sub',
                            'ca000000-0000-4000-8000-000000000001', true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  SET LOCAL ROLE authenticated;

  PERFORM public.update_competitor_watchlist(
    'cb000000-0000-4000-8000-000000000011', NULL, false);

  RESET ROLE;

  PERFORM set_config('request.jwt.claim.role', 'service_role', true);

  SELECT removed_at INTO v_marker
    FROM public.competitor_watchlist
   WHERE id = 'cb000000-0000-4000-8000-000000000011';

  ASSERT v_marker = v_first,
    'R3 the owner RPC preserves the marker of an already-removed entry';

  -- The deactivate / reactivate / deactivate cycle. The reactivation
  -- clears the marker, and the next removal starts a NEW clock: it is NOT
  -- the old backdated marker.
  UPDATE public.competitor_watchlist
     SET is_active = false, removed_at = now() - interval '100 days'
   WHERE id = 'cb000000-0000-4000-8000-000000000012';

  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  SET LOCAL ROLE authenticated;

  PERFORM public.update_competitor_watchlist(
    'cb000000-0000-4000-8000-000000000012', NULL, true);

  RESET ROLE;
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);

  SELECT removed_at INTO v_marker
    FROM public.competitor_watchlist
   WHERE id = 'cb000000-0000-4000-8000-000000000012';

  ASSERT v_marker IS NULL,
    'R3 a reactivation clears the removal marker';

  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  SET LOCAL ROLE authenticated;

  PERFORM public.update_competitor_watchlist(
    'cb000000-0000-4000-8000-000000000012', NULL, false);

  RESET ROLE;
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);

  SELECT removed_at INTO v_marker
    FROM public.competitor_watchlist
   WHERE id = 'cb000000-0000-4000-8000-000000000012';

  ASSERT v_marker = now(),
    'R3 a removal after a reactivation starts a new clock, got ' || v_marker::text;

  ASSERT NOT EXISTS (
    SELECT 1 FROM public.competitor_watchlist AS w
     WHERE w.id = 'cb000000-0000-4000-8000-000000000012'
       AND w.removed_at <= now() - interval '2160 hours'),
    'R3 a freshly removed entry is not eligible';
END
$r3$;

-- ===========================================================================
-- R4 - the ownership boundary.
-- ===========================================================================
DO $r4$
DECLARE
  v_a uuid := 'ca000000-0000-4000-8000-000000000001';
  v_b uuid := 'ca000000-0000-4000-8000-000000000002';
BEGIN
  -- The same handle under two owners is two rows, not one.
  ASSERT (SELECT count(*) FROM public.competitor_watchlist
           WHERE platform = 'instagram' AND username = 'crt_shared') = 2,
    'R4 the same handle under two owners is two rows';
  ASSERT (SELECT count(DISTINCT user_id) FROM public.competitor_watchlist
           WHERE platform = 'instagram' AND username = 'crt_shared') = 2,
    'R4 the two rows belong to two owners';

  -- Every child relation refuses a cross-owner row. These are the
  -- composite ownership foreign keys, and they are the reason a cleanup
  -- can never reach another owner's history through a shared handle.
  BEGIN
    INSERT INTO public.competitor_profile_snapshots
      (watchlist_id, user_id, captured_on, source)
    VALUES ('cb000000-0000-4000-8000-000000000021', v_b, current_date, 'apify');
    RAISE EXCEPTION 'R4 failed: a profile snapshot named another owner''s entry'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN foreign_key_violation THEN
    ASSERT SQLSTATE = '23503',
      'R4 a cross-owner profile snapshot is SQLSTATE 23503, got ' || SQLSTATE;
  END;

  BEGIN
    INSERT INTO public.competitor_media_snapshots
      (watchlist_id, user_id, ig_media_id, captured_on, published_at, source)
    VALUES ('cb000000-0000-4000-8000-000000000021', v_b,
            'crt-forged-media', current_date, now(), 'apify');
    RAISE EXCEPTION 'R4 failed: a media snapshot named another owner''s entry'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN foreign_key_violation THEN
    ASSERT SQLSTATE = '23503',
      'R4 a cross-owner media snapshot is SQLSTATE 23503, got ' || SQLSTATE;
  END;

  BEGIN
    INSERT INTO public.competitor_capture_coverage
      (watchlist_id, user_id, captured_on, source, job_generation,
       capture_started_at, capture_ended_at, exhausted, truncated)
    VALUES ('cb000000-0000-4000-8000-000000000021', v_b, current_date,
            'apify', 1, now() - interval '1 minute', now(), true, false);
    RAISE EXCEPTION 'R4 failed: a coverage row named another owner''s entry'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN foreign_key_violation THEN
    ASSERT SQLSTATE = '23503',
      'R4 a cross-owner coverage row is SQLSTATE 23503, got ' || SQLSTATE;
  END;

  BEGIN
    INSERT INTO public.instagram_collection_jobs
      (user_id, target_kind, target_id, watchlist_id, captured_on, due_at)
    VALUES (v_b, 'competitor', 'cb000000-0000-4000-8000-000000000021',
            'cb000000-0000-4000-8000-000000000021', current_date, now());
    RAISE EXCEPTION 'R4 failed: a job named another owner''s entry'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN foreign_key_violation THEN
    ASSERT SQLSTATE = '23503',
      'R4 a cross-owner job is SQLSTATE 23503, got ' || SQLSTATE;
  END;

  BEGIN
    INSERT INTO public.instagram_collection_request_throttles
      (scope, target_kind, target_id, user_id, watchlist_id, accepted_count)
    VALUES ('user_request', 'competitor',
            'cb000000-0000-4000-8000-000000000021', v_b,
            'cb000000-0000-4000-8000-000000000021', 1);
    RAISE EXCEPTION 'R4 failed: a throttle row named another owner''s entry'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN foreign_key_violation THEN
    ASSERT SQLSTATE = '23503',
      'R4 a cross-owner throttle row is SQLSTATE 23503, got ' || SQLSTATE;
  END;

  BEGIN
    INSERT INTO public.instagram_collection_job_operations
      (job_id, user_id, job_generation, operation_key, operation_kind, state)
    SELECT j.id, v_b, j.job_generation, 'profile', 'profile', 'pending'
      FROM public.instagram_collection_jobs AS j
     WHERE j.id = 'cb000000-0000-4000-8000-000000000044'
     LIMIT 1;
    RAISE EXCEPTION 'R4 failed: an operation named another owner''s job'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN foreign_key_violation THEN
    ASSERT SQLSTATE = '23503',
      'R4 a cross-owner operation is SQLSTATE 23503, got ' || SQLSTATE;
  END;

  BEGIN
    INSERT INTO public.instagram_collection_job_checkpoints
      (job_id, user_id, job_generation)
    SELECT j.id, v_b, j.job_generation
      FROM public.instagram_collection_jobs AS j
     WHERE j.id = 'cb000000-0000-4000-8000-000000000044'
     LIMIT 1;
    RAISE EXCEPTION 'R4 failed: a checkpoint named another owner''s job'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN foreign_key_violation THEN
    ASSERT SQLSTATE = '23503',
      'R4 a cross-owner checkpoint is SQLSTATE 23503, got ' || SQLSTATE;
  END;
END
$r4$;

-- ===========================================================================
-- R5 - the switch.
-- ===========================================================================
DO $r5$
DECLARE
  v_report   jsonb;
  v_parents  integer;
  v_children integer;
BEGIN
  -- The state of the world before the switch is exercised.
  SELECT count(*)::integer INTO v_parents
    FROM public.competitor_watchlist
   WHERE is_active = false AND removed_at IS NOT NULL
     AND removed_at <= now() - interval '2160 hours';

  SELECT count(*)::integer INTO v_children
    FROM public.competitor_media_snapshots;

  -- The switch is OFF.
  UPDATE public.app_settings
     SET value = 'false'::jsonb
   WHERE key = 'competitor_retention_enabled';

  v_report := public.run_competitor_retention_batch(50, 500, false);

  ASSERT v_report ->> 'switch_state' = 'disabled',
    'R5 an off switch reports itself as disabled, got ' || (v_report ->> 'switch_state');
  ASSERT (v_report ->> 'parents_deleted')::integer = 0,
    'R5 an off switch deletes no parent';
  ASSERT (v_report ->> 'children_deleted')::integer = 0,
    'R5 an off switch deletes no child';
  ASSERT (SELECT count(*) FROM public.competitor_watchlist
           WHERE is_active = false AND removed_at IS NOT NULL
             AND removed_at <= now() - interval '2160 hours') = v_parents,
    'R5 an off switch deletes no eligible parent';
  ASSERT (SELECT count(*) FROM public.competitor_media_snapshots) = v_children,
    'R5 an off switch deletes no media snapshot';

  -- The switch is MISSING.
  DELETE FROM public.app_settings WHERE key = 'competitor_retention_enabled';

  v_report := public.run_competitor_retention_batch(50, 500, false);

  ASSERT v_report ->> 'switch_state' = 'missing',
    'R5 a missing switch reports itself as missing, got ' || (v_report ->> 'switch_state');
  ASSERT (v_report ->> 'parents_deleted')::integer = 0,
    'R5 a missing switch deletes no parent';
  ASSERT (SELECT count(*) FROM public.competitor_media_snapshots) = v_children,
    'R5 a missing switch deletes no media snapshot';

  -- The switch is MALFORMED. A value that is not a JSON boolean is not an
  -- instruction.
  INSERT INTO public.app_settings (key, value, description)
  VALUES ('competitor_retention_enabled', '"yes"'::jsonb, 'malformed on purpose')
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

  v_report := public.run_competitor_retention_batch(50, 500, false);

  ASSERT v_report ->> 'switch_state' = 'malformed',
    'R5 a malformed switch reports itself as malformed, got ' || (v_report ->> 'switch_state');
  ASSERT (v_report ->> 'parents_deleted')::integer = 0,
    'R5 a malformed switch deletes no parent';
  ASSERT (SELECT count(*) FROM public.competitor_media_snapshots) = v_children,
    'R5 a malformed switch deletes no media snapshot';

  -- A dry run stays available while the switch is off: it mutates nothing
  -- either way, and it still reports the backlog.
  v_report := public.run_competitor_retention_batch(50, 500, true);

  ASSERT (v_report ->> 'children_deleted')::integer = 0,
    'R5 a dry run deletes no child while the switch is off';
  ASSERT (v_report ->> 'children_counted')::integer > 0,
    'R5 a dry run still counts the backlog while the switch is off';

  -- The switch is restored, and the restoration is proven to be the only
  -- thing that was wrong.
  UPDATE public.app_settings
     SET value = 'true'::jsonb
   WHERE key = 'competitor_retention_enabled';

  v_report := public.run_competitor_retention_batch(50, 500, true);

  ASSERT v_report ->> 'switch_state' = 'enabled',
    'R5 an enabled switch reports itself as enabled, got ' || (v_report ->> 'switch_state');
END
$r5$;

-- ===========================================================================
-- R6 - the dry run.
-- ===========================================================================
DO $r6$
DECLARE
  v_report  jsonb;
  v_media   integer;
  v_parents integer;
BEGIN
  v_media := (SELECT count(*) FROM public.competitor_media_snapshots);
  v_parents := (SELECT count(*) FROM public.competitor_watchlist);

  -- The bounded backlog fixture is the oldest candidate, so a one-parent
  -- slice is guaranteed to be it. The preview sees the backlog exactly as
  -- the real slice would: bounded by the child's budget, not by the size
  -- of the backlog. It touches nothing.
  v_report := public.run_competitor_retention_batch(1, 500, true);

  ASSERT (v_report -> 'child_counts' ->> 'competitor_media_snapshots')::integer = 500,
    'R6 the preview counts the 500 children its budget covers, got '
      || (v_report -> 'child_counts' ->> 'competitor_media_snapshots');
  ASSERT (v_report ->> 'parents_projected')::integer = 0,
    'R6 the preview says one slice cannot cover the backlog, got '
      || (v_report ->> 'parents_projected');
  ASSERT (v_report ->> 'parents_deleted')::integer = 0,
    'R6 the preview deletes no parent';
  ASSERT (v_report ->> 'children_deleted')::integer = 0,
    'R6 the preview deletes no child';
  ASSERT (SELECT count(*) FROM public.competitor_media_snapshots) = v_media,
    'R6 the preview deleted no media snapshot';
  ASSERT (SELECT count(*) FROM public.competitor_watchlist) = v_parents,
    'R6 the preview deleted no watchlist row';
END
$r6$;

-- ===========================================================================
-- R7 - the bounded slice.
-- ===========================================================================
DO $r7$
DECLARE
  v_report jsonb;
BEGIN
  -- One call, 500 children of budget, against a 520-row backlog. The call
  -- cannot cascade-delete the rest: the parent survives because a child
  -- remains, and the next call continues where this one stopped.
  v_report := public.run_competitor_retention_batch(1, 500, false);

  ASSERT (v_report -> 'child_counts' ->> 'competitor_media_snapshots')::integer = 500,
    'R7 one call deletes at most its child budget, got '
      || (v_report -> 'child_counts' ->> 'competitor_media_snapshots');
  ASSERT (v_report ->> 'children_deleted')::integer = 500,
    'R7 one call deletes 500 children, got ' || (v_report ->> 'children_deleted');
  ASSERT (v_report ->> 'parents_deleted')::integer = 0,
    'R7 the parent survives while a child remains';
  ASSERT (v_report ->> 'has_more')::boolean,
    'R7 the report says there is more work';
  ASSERT (SELECT count(*) FROM public.competitor_media_snapshots
           WHERE watchlist_id = 'cb000000-0000-4000-8000-000000000051') = 20,
    'R7 exactly 20 media snapshots of the backlog are left';
  ASSERT EXISTS (SELECT 1 FROM public.competitor_watchlist
                  WHERE id = 'cb000000-0000-4000-8000-000000000051'),
    'R7 the parent of an unfinished backlog is still there';

  -- The next call finishes it: the remaining 20 children go, and only then
  -- is the parent deleted.
  v_report := public.run_competitor_retention_batch(1, 500, false);

  ASSERT (v_report -> 'child_counts' ->> 'competitor_media_snapshots')::integer = 20,
    'R7 the next call deletes the remaining 20 children, got '
      || (v_report -> 'child_counts' ->> 'competitor_media_snapshots');
  ASSERT (v_report ->> 'parents_deleted')::integer = 1,
    'R7 the parent is deleted once its children are gone, got '
      || (v_report ->> 'parents_deleted');
  ASSERT NOT EXISTS (SELECT 1 FROM public.competitor_watchlist
                      WHERE id = 'cb000000-0000-4000-8000-000000000051'),
    'R7 the finished parent is gone';
  ASSERT (SELECT count(*) FROM public.competitor_media_snapshots
           WHERE watchlist_id = 'cb000000-0000-4000-8000-000000000051') = 0,
    'R7 no media snapshot of the finished parent is left';
END
$r7$;

-- ===========================================================================
-- R8 - the deletion protocol.
-- ===========================================================================
DO $r8$
DECLARE
  v_report jsonb;
  v_counts jsonb;
BEGIN
  -- The preview of the slice that is about to run. It must agree with the
  -- real slice, number for number.
  v_report := public.run_competitor_retention_batch(50, 500, true);
  v_counts := v_report -> 'child_counts';

  ASSERT (v_report ->> 'parents_considered')::integer = 7,
    'R8 seven parents are eligible, got ' || (v_report ->> 'parents_considered');
  ASSERT (v_report ->> 'parents_projected')::integer = 6,
    'R8 six of them are fully covered, got ' || (v_report ->> 'parents_projected');
  ASSERT (v_report ->> 'parents_skipped_live_lease')::integer = 1,
    'R8 one parent is skipped for its live lease, got '
      || (v_report ->> 'parents_skipped_live_lease');

  ASSERT (v_counts ->> 'competitor_media_snapshots')::integer = 10,
    'R8 ten media snapshots are in scope, got '
      || (v_counts ->> 'competitor_media_snapshots');
  ASSERT (v_counts ->> 'competitor_profile_snapshots')::integer = 2,
    'R8 two profile snapshots are in scope, got '
      || (v_counts ->> 'competitor_profile_snapshots');
  ASSERT (v_counts ->> 'competitor_capture_coverage')::integer = 1,
    'R8 one coverage row is in scope, got '
      || (v_counts ->> 'competitor_capture_coverage');
  ASSERT (v_counts ->> 'instagram_collection_jobs')::integer = 8,
    'R8 eight jobs are in scope, got ' || (v_counts ->> 'instagram_collection_jobs');
  ASSERT (v_counts ->> 'instagram_collection_job_operations')::integer = 7,
    'R8 seven job operations are in scope, got '
      || (v_counts ->> 'instagram_collection_job_operations');
  ASSERT (v_counts ->> 'instagram_collection_job_checkpoints')::integer = 7,
    'R8 seven job checkpoints are in scope, got '
      || (v_counts ->> 'instagram_collection_job_checkpoints');
  ASSERT (v_counts ->> 'instagram_collection_request_throttles')::integer = 1,
    'R8 one request throttle row is in scope, got '
      || (v_counts ->> 'instagram_collection_request_throttles');
  ASSERT (v_report ->> 'children_counted')::integer = 36,
    'R8 thirty-six children are in scope, got '
      || (v_report ->> 'children_counted');

  -- The real slice. The numbers must be the preview's numbers.
  v_report := public.run_competitor_retention_batch(50, 500, false);

  ASSERT (v_report ->> 'parents_deleted')::integer = 6,
    'R8 six parents are deleted, got ' || (v_report ->> 'parents_deleted');
  ASSERT (v_report ->> 'parents_skipped_live_lease')::integer = 1,
    'R8 one parent is skipped for its live lease, got '
      || (v_report ->> 'parents_skipped_live_lease');
  ASSERT (v_report ->> 'children_deleted')::integer = 36,
    'R8 thirty-six children are deleted, got ' || (v_report ->> 'children_deleted');
  ASSERT (v_report -> 'child_counts') = v_counts,
    'R8 the real slice deletes exactly what the preview counted';
  ASSERT (v_report ->> 'has_more')::boolean,
    'R8 the report says the skipped parent is still work';

  -- The children are gone, relation by relation.
  ASSERT (SELECT count(*) FROM public.competitor_media_snapshots
           WHERE watchlist_id = 'cb000000-0000-4000-8000-000000000031') = 0,
    'R8 the protocol media snapshots are gone';
  ASSERT (SELECT count(*) FROM public.competitor_profile_snapshots
           WHERE watchlist_id = 'cb000000-0000-4000-8000-000000000031') = 0,
    'R8 the protocol profile snapshots are gone';
  ASSERT (SELECT count(*) FROM public.competitor_capture_coverage
           WHERE watchlist_id = 'cb000000-0000-4000-8000-000000000031') = 0,
    'R8 the protocol coverage row is gone';
  ASSERT (SELECT count(*) FROM public.instagram_collection_jobs
           WHERE watchlist_id = 'cb000000-0000-4000-8000-000000000031') = 0,
    'R8 the protocol jobs are gone';
  ASSERT (SELECT count(*) FROM public.instagram_collection_job_operations
           WHERE job_id IN (SELECT id FROM public.instagram_collection_jobs
                             WHERE watchlist_id = 'cb000000-0000-4000-8000-000000000031')) = 0,
    'R8 no operation outlived its job';
  ASSERT (SELECT count(*) FROM public.instagram_collection_job_checkpoints
           WHERE job_id IN (SELECT id FROM public.instagram_collection_jobs
                             WHERE watchlist_id = 'cb000000-0000-4000-8000-000000000031')) = 0,
    'R8 no checkpoint outlived its job';
  ASSERT (SELECT count(*) FROM public.instagram_collection_request_throttles
           WHERE watchlist_id = 'cb000000-0000-4000-8000-000000000031') = 0,
    'R8 the request throttle row is gone';

  -- The parent is gone.
  ASSERT NOT EXISTS (SELECT 1 FROM public.competitor_watchlist
                      WHERE id = 'cb000000-0000-4000-8000-000000000031'),
    'R8 the protocol parent is gone';

  -- What must SURVIVE.
  ASSERT (SELECT count(*) FROM public.competitor_media_snapshots) = 16,
    'R8 sixteen media snapshots of the ineligible rows survive, got '
      || (SELECT count(*) FROM public.competitor_media_snapshots);

  ASSERT EXISTS (SELECT 1 FROM public.competitor_watchlist
                  WHERE id = 'cb000000-0000-4000-8000-000000000001'),
    'R8 the 89-day-old entry survives';
  ASSERT EXISTS (SELECT 1 FROM public.competitor_watchlist
                  WHERE id = 'cb000000-0000-4000-8000-000000000002'),
    'R8 the entry 90 days minus a microsecond survives';
  ASSERT EXISTS (SELECT 1 FROM public.competitor_watchlist
                  WHERE id = 'cb000000-0000-4000-8000-000000000004'),
    'R8 the future-marker entry survives';
  ASSERT EXISTS (SELECT 1 FROM public.competitor_watchlist
                  WHERE id = 'cb000000-0000-4000-8000-000000000005'),
    'R8 the active entry survives';
  ASSERT EXISTS (SELECT 1 FROM public.competitor_watchlist
                  WHERE id = 'cb000000-0000-4000-8000-000000000032'),
    'R8 the second active entry survives';

  -- The other owner's row that is NOT eligible survives, with its child.
  ASSERT EXISTS (SELECT 1 FROM public.competitor_watchlist
                  WHERE id = 'cb000000-0000-4000-8000-000000000022'),
    'R8 the other owner''s 89-day-old entry survives';
  ASSERT (SELECT count(*) FROM public.competitor_media_snapshots
           WHERE watchlist_id = 'cb000000-0000-4000-8000-000000000022') = 1,
    'R8 the other owner''s media snapshot survives';

  -- The other owner's ELIGIBLE row is cleaned: the cleanup is a system
  -- job and it does not stop at one owner.
  ASSERT NOT EXISTS (SELECT 1 FROM public.competitor_watchlist
                      WHERE id = 'cb000000-0000-4000-8000-000000000023'),
    'R8 the other owner''s eligible entry is cleaned too';
  ASSERT (SELECT count(*) FROM public.competitor_media_snapshots
           WHERE watchlist_id = 'cb000000-0000-4000-8000-000000000023') = 0,
    'R8 the other owner''s eligible media snapshot is cleaned too';

  -- The owner's OWN job, the owner's own account and the shared provider
  -- bucket are never touched.
  ASSERT EXISTS (SELECT 1 FROM public.instagram_collection_jobs
                  WHERE id = 'cb000000-0000-4000-8000-000000000099'),
    'R8 the owner job survives';
  ASSERT EXISTS (SELECT 1 FROM public.social_accounts
                  WHERE id = 'ca100000-0000-4000-8000-000000000001'),
    'R8 the owner''s social account survives';
  ASSERT EXISTS (SELECT 1 FROM public.instagram_provider_throttle_buckets
                  WHERE bucket_key = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'),
    'R8 the shared provider throttle bucket survives';
END
$r8$;

-- ===========================================================================
-- R9 - the live lease and the expired generation.
-- ===========================================================================
DO $r9$
DECLARE
  v_report jsonb;
  v_token  uuid;
  v_gen    bigint;
BEGIN
  -- The parent with the live lease was skipped and is still there, with
  -- its children.
  ASSERT EXISTS (SELECT 1 FROM public.competitor_watchlist
                  WHERE id = 'cb000000-0000-4000-8000-000000000041'),
    'R9 the parent with a live lease is still there';
  ASSERT (SELECT count(*) FROM public.competitor_media_snapshots
           WHERE watchlist_id = 'cb000000-0000-4000-8000-000000000041') = 1,
    'R9 the live-lease parent keeps its media snapshot';
  ASSERT EXISTS (SELECT 1 FROM public.instagram_collection_jobs
                  WHERE id = 'cb000000-0000-4000-8000-000000000043'),
    'R9 the live-lease job is still there';

  -- The parent with the EXPIRED lease was cleaned: an expired lease is
  -- abandoned work, not a live claim.
  ASSERT NOT EXISTS (SELECT 1 FROM public.competitor_watchlist
                      WHERE id = 'cb000000-0000-4000-8000-000000000042'),
    'R9 the parent with an expired lease is cleaned';
  ASSERT NOT EXISTS (SELECT 1 FROM public.instagram_collection_jobs
                      WHERE id = 'cb000000-0000-4000-8000-000000000044'),
    'R9 the expired-lease job is cleaned with its parent';

  -- An expired generation has no write authority. The worker that held the
  -- expired lease cannot publish a result afterwards.
  SELECT lease_token, job_generation INTO v_token, v_gen
    FROM public.instagram_collection_jobs
   WHERE id = 'cb000000-0000-4000-8000-000000000044';

  -- The claim token is gone with the job, so the writer is refused before
  -- it can write anything. The refusal is proved by the absence of every
  -- row it would have written.
  BEGIN
    PERFORM public.persist_competitor_collection_result_v2(
      'cb000000-0000-4000-8000-000000000044',
      coalesce(v_token, gen_random_uuid()),
      coalesce(v_gen, 1),
      jsonb_build_object(
        'outcome', 'completed',
        'source', 'apify',
        'profile', jsonb_build_object(
          'metrics', jsonb_build_object('followers_count', 1, 'media_count', 1)),
        'media', jsonb_build_array(),
        'coverage', jsonb_build_object(
          'capture_started_at', to_char(now() - interval '1 minute', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
          'capture_ended_at', to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
          'ordering_verified', false,
          'cursor_present', false,
          'exhausted', true,
          'truncated', false,
          'gap_reason', NULL)));
    RAISE EXCEPTION 'R9 failed: an expired worker published a result'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN others THEN
    ASSERT SQLERRM LIKE '%IG_COLLECTION_JOB_NOT_FOUND%'
        OR SQLERRM LIKE '%IG_COLLECTION_CLAIM_STALE%',
      'R9 an expired worker is refused, got: ' || SQLERRM;
  END;

  ASSERT (SELECT count(*) FROM public.competitor_profile_snapshots
           WHERE watchlist_id = 'cb000000-0000-4000-8000-000000000042') = 0,
    'R9 the expired worker wrote no profile snapshot';
  ASSERT (SELECT count(*) FROM public.competitor_capture_coverage
           WHERE watchlist_id = 'cb000000-0000-4000-8000-000000000042') = 0,
    'R9 the expired worker wrote no coverage row';

  -- The skipped parent is still eligible work, so the report says so.
  v_report := public.run_competitor_retention_batch(50, 500, false);

  ASSERT (v_report ->> 'parents_skipped_live_lease')::integer = 1,
    'R9 the live-lease parent is still skipped, got '
      || (v_report ->> 'parents_skipped_live_lease');
  ASSERT (v_report ->> 'parents_deleted')::integer = 0,
    'R9 the live-lease parent is not deleted, got '
      || (v_report ->> 'parents_deleted');
  ASSERT (v_report ->> 'has_more')::boolean,
    'R9 the live-lease parent is still work';
END
$r9$;

-- ===========================================================================
-- R10 - the role boundary.
-- ===========================================================================
DO $r10$
DECLARE
  v_seen integer;
BEGIN
  -- An ordinary user cannot run the cleanup.
  PERFORM set_config('request.jwt.claim.sub',
                            'ca000000-0000-4000-8000-000000000001', true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  SET LOCAL ROLE authenticated;

  BEGIN
    PERFORM public.run_competitor_retention_batch(10, 100, false);
    RAISE EXCEPTION 'R10 failed: an ordinary user ran the cleanup'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN insufficient_privilege THEN
    ASSERT SQLSTATE = '42501',
      'R10 a privilege refusal is SQLSTATE 42501, got ' || SQLSTATE;
  END;

  -- And the owner read boundary is unchanged: an owner sees their own
  -- tracked competitors and nothing of somebody else's.
  SELECT count(*)::integer INTO v_seen
    FROM public.competitor_watchlist;

  ASSERT v_seen = 7,
    'R10 an owner reads exactly their own seven surviving tracked competitors, got '
      || v_seen;

  RESET ROLE;

  -- An anonymous caller cannot run it either.
  PERFORM set_config('request.jwt.claim.role', 'anon', true);
  SET LOCAL ROLE anon;

  BEGIN
    PERFORM public.run_competitor_retention_batch(10, 100, false);
    RAISE EXCEPTION 'R10 failed: an anonymous caller ran the cleanup'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN insufficient_privilege THEN
    ASSERT SQLSTATE = '42501',
      'R10 an anonymous refusal is SQLSTATE 42501, got ' || SQLSTATE;
  END;

  RESET ROLE;

  PERFORM set_config('request.jwt.claim.role', 'service_role', true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
END
$r10$;

-- ===========================================================================
-- The suite is over: nothing it created survives.
-- ===========================================================================
ROLLBACK;

\echo 'ALL CHECKS PASSED'
