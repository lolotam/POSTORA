-- ============================================================================
-- supabase/tests/instagram_tracking_schema.sql
-- Task 3b schema slice (migration 20261026130000_instagram_insight_tracking_schema.sql).
--
-- One transaction, synthetic fixtures, labelled ASSERTs, expected refusals in
-- nested BEGIN/EXCEPTION blocks, ROLLBACK, sentinel last. Fixture values are
-- synthetic ('...@example.invalid'); no secrets and no real accounts.
--
-- What this suite proves
--   S1  the grant surface: RLS on, one owner-read policy per table, no client
--       write privilege on any snapshot table, no client write privilege on
--       the watchlist at all, and the function grants.
--   S2  owners read their own rows and nobody else's, in every table.
--   S3  an authenticated client cannot write a snapshot, and cannot write,
--       update or delete a watchlist row directly; anon cannot read anything.
--   S4  the service role cannot write a cross-owner row either: the composite
--       foreign keys refuse it.
--   S5  the optional post link is unambiguous: an owned platform_posts match is
--       accepted, an arbitrary post id is refused, two owned posts for one
--       media id resolve to null and are refused, and deleting the post
--       nulls only the optional reference.
--   S6  invalid values are refused: negative metrics, an unknown source, an
--       unknown status, an illegal handle, an inverted provider window.
--   S7  the daily unique keys hold, and the handle is normalised and unique
--       per owner.
--   S8  the identity is immutable and the server-owned columns are server
--       owned, even when the grant surface is widened.
--   S9  the owner path works: add, relabel, soft-remove, reactivate - and the
--       snapshot history survives the removal. Reactivation of a previously
--       synced row (ok, unavailable, error) works through both RPCs and
--       resets status to pending. An inactive insert carries removed_at.
--   S10 the entitlement resolves override -> plan -> free, past_due still
--       entitles, and the admin exemption is at the read boundary only.
--   S11 the quota is atomic under READ COMMITTED: N+1 is denied, label edits
--       and removals are not, and a reactivation is quota-checked. An
--       already-active handle added again at the cap does not reset status
--       and does not take another slot. This single connection does not
--       prove two concurrent sessions; that rehearsal is the race fixture.
--   S12 a downgrade denies ONLY new activations: the entries above the limit
--       keep their history and can still be tidied up.
--   S13 deleting the parent cascades safely, and deleting a post keeps the
--       snapshot.
--   S14 a parent's ownership cannot be moved out from under a snapshot.
--   S15 NULL is not 0.
--
-- The suite SET ROLEs away from superuser where the point of the check is
-- that a client role cannot do something: the service role bypasses RLS, so
-- the ownership checks and the composite foreign keys are the only thing
-- under test there.
-- ============================================================================

\set ON_ERROR_STOP on

BEGIN;

-- ---------------------------------------------------------------------------
-- Fixtures. Written as superuser, where RLS does not apply.
--
-- u_a / u_b   : two owners with one Instagram account and one post each
-- u_admin      : an admin owner
-- u_quota      : an owner with a two-competitor override
-- u_down       : an owner used for the downgrade case
-- ---------------------------------------------------------------------------
DO $fixtures$
DECLARE
  u_a      uuid := 'a3a3a3a3-a3a3-4a3a-8a3a-a3a3a3a3a3a3';
  u_b      uuid := 'b3b3b3b3-b3b3-4b3b-8b3b-b3b3b3b3b3b3';
  u_admin  uuid := 'c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c3c3';
  u_quota  uuid := 'd3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d3d3';
  u_down   uuid := 'e3e3e3e3-e3e3-4e3e-8e3e-e3e3e3e3e3e3';
  acct_a   uuid := 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a4a4';
  acct_b   uuid := 'b4b4b4b4-b4b4-4b4b-8b4b-b4b4b4b4b4b4';
  post_a   uuid := 'a5a5a5a5-a5a5-4a5a-8a5a-a5a5a5a5a5a5';
  post_b   uuid := 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b5b5';
  plan_free     uuid := 'f1f1f1f1-f1f1-4f1f-8f1f-f1f1f1f1f1f1';
  plan_pro      uuid := 'f2f2f2f2-f2f2-4f2f-8f2f-f2f2f2f2f2f2';
  plan_business uuid := 'f3f3f3f3-f3f3-4f3f-8f3f-f3f3f3f3f3f3';
BEGIN
  INSERT INTO auth.users (id, email)
  VALUES
    (u_a,     'itk-owner-a-'  || u_a::text     || '@example.invalid'),
    (u_b,     'itk-owner-b-'  || u_b::text     || '@example.invalid'),
    (u_admin, 'itk-admin-'    || u_admin::text || '@example.invalid'),
    (u_quota, 'itk-quota-'    || u_quota::text || '@example.invalid'),
    (u_down,  'itk-down-'     || u_down::text  || '@example.invalid');

  INSERT INTO public.social_accounts
    (id, user_id, platform, platform_user_id, platform_username,
     access_token, ig_auth_type)
  VALUES
    (acct_a, u_a, 'instagram', 'ig-itk-a', 'itk_a', 'token-a', 'facebook_page'),
    (acct_b, u_b, 'instagram', 'ig-itk-b', 'itk_b', 'token-b', 'facebook_page');

  INSERT INTO public.posts (id, user_id, caption, platforms, status)
  VALUES
    (post_a, u_a, 'owner a post', ARRAY['instagram']::text[], 'completed'),
    (post_b, u_b, 'owner b post', ARRAY['instagram']::text[], 'completed');

  -- One owned platform_posts row: media 'ig-itk-media-1' was published by
  -- post_a through acct_a. Everything else has no owned match.
  INSERT INTO public.platform_posts
    (post_id, social_account_id, platform, platform_post_id, status)
  VALUES
    (post_a, acct_a, 'instagram', 'ig-itk-media-1', 'success');

  INSERT INTO public.user_roles (user_id, role) VALUES (u_admin, 'admin');
END
$fixtures$;

-- The three plans the approved entitlement is seeded into. The schema-only
-- baseline carries no rows, so the suite supplies them; the competitor limit
-- is left NULL on 'free' and 'business' on purpose, so the seeding
-- statement can be observed (S10).
INSERT INTO public.subscription_plans (id, name, slug, is_active, sort_order)
VALUES
  ('f1f1f1f1-f1f1-4f1f-8f1f-f1f1f1f1f1f1', 'Free',     'free',     true, 1),
  ('f2f2f2f2-f2f2-4f2f-8f2f-f2f2f2f2f2f2', 'Pro',      'pro',      true, 2),
  ('f3f3f3f3-f3f3-4f3f-8f3f-f3f3f3f3f3f3', 'Business', 'business', true, 3);

-- ===========================================================================
-- S1 - the grant surface.
--
-- Positive controls first: the service role can read and write, the owner
-- can read, and anon can do nothing at all.
-- ===========================================================================
DO $s1$
DECLARE
  v_tables TEXT[] := ARRAY[
    'ig_media_insight_snapshots',
    'ig_account_insight_daily',
    'ig_account_profile_observations',
    'competitor_watchlist',
    'competitor_profile_snapshots',
    'competitor_media_snapshots'
  ];
  v_snapshot_tables TEXT[] := ARRAY[
    'ig_media_insight_snapshots',
    'ig_account_insight_daily',
    'ig_account_profile_observations',
    'competitor_profile_snapshots',
    'competitor_media_snapshots'
  ];
  v_table TEXT;
  v_fn   TEXT;
  v_saved_search_path text;
  v_owner_qual text;
BEGIN
  -- Captured once, before any deparse pin, so a later restore puts back the
  -- path this transaction actually started with.
  v_saved_search_path := current_setting('search_path');

  FOREACH v_table IN ARRAY v_tables LOOP
    ASSERT (SELECT relrowsecurity FROM pg_class
             WHERE oid = ('public.' || v_table)::regclass),
      format('S1 RLS is enabled on %s', v_table);

    -- Exactly one policy, and it is the owner read.
    ASSERT (SELECT count(*) FROM pg_policies
             WHERE schemaname = 'public' AND tablename = v_table) = 1,
      format('S1 %s carries exactly one policy', v_table);
    ASSERT (SELECT cmd FROM pg_policies
             WHERE schemaname = 'public' AND tablename = v_table
               AND policyname = 'Owners can read their own rows') = 'SELECT',
      format('S1 %s has an owner SELECT policy', v_table);
    ASSERT (SELECT roles FROM pg_policies
             WHERE schemaname = 'public' AND tablename = v_table
               AND policyname = 'Owners can read their own rows') = '{authenticated}',
      format('S1 %s owner policy is scoped to authenticated', v_table);

    -- pg_policies.qual / pg_get_expr schema-qualifies auth.uid() only when
    -- auth is not on search_path. supabase_admin's path includes auth, so
    -- the same tree prints (uid() = user_id) there and (auth.uid() = user_id)
    -- when auth is hidden. Read under pg_catalog, where the qualification is
    -- stable, and require that exact predicate: a different column, a
    -- different function, or a wider boolean prints a different string.
    -- set_config(..., true) is transaction-local. Put the caller's path
    -- back before the assertion, including when the read fails.
    BEGIN
      PERFORM pg_catalog.set_config('search_path', 'pg_catalog', true);
      SELECT pg_catalog.pg_get_expr(p.polqual, p.polrelid)
        INTO v_owner_qual
        FROM pg_catalog.pg_policy p
        JOIN pg_catalog.pg_class c ON c.oid = p.polrelid
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public'
         AND c.relname = v_table
         AND p.polname = 'Owners can read their own rows';
      PERFORM pg_catalog.set_config('search_path', v_saved_search_path, true);
    EXCEPTION WHEN OTHERS THEN
      PERFORM pg_catalog.set_config('search_path', v_saved_search_path, true);
      RAISE;
    END;
    ASSERT v_owner_qual = '(auth.uid() = user_id)',
      format('S1 %s owner policy is owner-scoped (canonical qual %s)',
             v_table, coalesce(v_owner_qual, '<null>'));
  END LOOP;

  ASSERT current_setting('search_path') = v_saved_search_path,
    'S1 search_path restored after policy deparse';

  -- The snapshot tables are service-write-only: an owner may read, and no
  -- client role may write.
  FOREACH v_table IN ARRAY v_snapshot_tables LOOP
    ASSERT has_table_privilege('authenticated', 'public.' || v_table, 'SELECT'),
      format('S1 authenticated can SELECT %s', v_table);
    ASSERT NOT has_table_privilege('authenticated', 'public.' || v_table, 'INSERT'),
      format('S1 authenticated cannot INSERT into %s', v_table);
    ASSERT NOT has_table_privilege('authenticated', 'public.' || v_table, 'UPDATE'),
      format('S1 authenticated cannot UPDATE %s', v_table);
    ASSERT NOT has_table_privilege('authenticated', 'public.' || v_table, 'DELETE'),
      format('S1 authenticated cannot DELETE from %s', v_table);
    ASSERT NOT has_table_privilege('anon', 'public.' || v_table, 'SELECT'),
      format('S1 anon cannot SELECT %s', v_table);
    ASSERT has_table_privilege('service_role', 'public.' || v_table, 'SELECT'),
      format('S1 service_role can SELECT %s', v_table);
    ASSERT has_table_privilege('service_role', 'public.' || v_table, 'INSERT'),
      format('S1 service_role can INSERT into %s', v_table);
    ASSERT has_table_privilege('service_role', 'public.' || v_table, 'UPDATE'),
      format('S1 service_role can UPDATE %s', v_table);
    ASSERT has_table_privilege('service_role', 'public.' || v_table, 'DELETE'),
      format('S1 service_role can DELETE from %s', v_table);
  END LOOP;

  -- The watchlist: owner reads only. No client write path, and no physical
  -- owner delete at all.
  ASSERT has_table_privilege('authenticated', 'public.competitor_watchlist', 'SELECT'),
    'S1 authenticated can SELECT competitor_watchlist';
  ASSERT NOT has_table_privilege('authenticated', 'public.competitor_watchlist', 'INSERT'),
    'S1 authenticated cannot INSERT into competitor_watchlist';
  ASSERT NOT has_table_privilege('authenticated', 'public.competitor_watchlist', 'UPDATE'),
    'S1 authenticated cannot UPDATE competitor_watchlist';
  ASSERT NOT has_table_privilege('authenticated', 'public.competitor_watchlist', 'DELETE'),
    'S1 authenticated cannot DELETE from competitor_watchlist';
  ASSERT NOT has_table_privilege('anon', 'public.competitor_watchlist', 'SELECT'),
    'S1 anon cannot SELECT competitor_watchlist';
  ASSERT has_table_privilege('service_role', 'public.competitor_watchlist', 'INSERT'),
    'S1 service_role can INSERT into competitor_watchlist';
  ASSERT has_table_privilege('service_role', 'public.competitor_watchlist', 'DELETE'),
    'S1 service_role can DELETE from competitor_watchlist';

  -- The functions.
  FOREACH v_fn IN ARRAY ARRAY[
    'public.effective_competitor_quota(uuid)',
    'public.resolve_ig_media_post_link(uuid, text)'
  ] LOOP
    ASSERT NOT has_function_privilege('anon', v_fn, 'EXECUTE'),
      format('S1 anon cannot execute %s', v_fn);
    ASSERT NOT has_function_privilege('authenticated', v_fn, 'EXECUTE'),
      format('S1 authenticated cannot execute %s', v_fn);
    ASSERT has_function_privilege('service_role', v_fn, 'EXECUTE'),
      format('S1 service_role can execute %s', v_fn);
  END LOOP;

  FOREACH v_fn IN ARRAY ARRAY[
    'public.enforce_competitor_watchlist_guards()',
    'public.guard_ig_media_insight_post_link()',
    'public.assert_competitor_watchlist_quota(uuid)',
    'public.normalize_competitor_username(text)'
  ] LOOP
    ASSERT NOT has_function_privilege('anon', v_fn, 'EXECUTE'),
      format('S1 anon cannot execute %s', v_fn);
    ASSERT NOT has_function_privilege('authenticated', v_fn, 'EXECUTE'),
      format('S1 authenticated cannot execute %s', v_fn);
  END LOOP;

  ASSERT NOT has_function_privilege('anon', 'public.read_own_competitor_quota()', 'EXECUTE'),
    'S1 anon cannot execute read_own_competitor_quota';
  ASSERT has_function_privilege('authenticated', 'public.read_own_competitor_quota()', 'EXECUTE'),
    'S1 authenticated can execute read_own_competitor_quota';
  ASSERT has_function_privilege('authenticated', 'public.add_competitor_watchlist(text, text)', 'EXECUTE'),
    'S1 authenticated can execute add_competitor_watchlist';
  ASSERT has_function_privilege('authenticated', 'public.update_competitor_watchlist(uuid, text, boolean)', 'EXECUTE'),
    'S1 authenticated can execute update_competitor_watchlist';
  ASSERT NOT has_function_privilege('anon', 'public.add_competitor_watchlist(text, text)', 'EXECUTE'),
    'S1 anon cannot execute add_competitor_watchlist';
  ASSERT NOT has_function_privilege('anon', 'public.update_competitor_watchlist(uuid, text, boolean)', 'EXECUTE'),
    'S1 anon cannot execute update_competitor_watchlist';

  -- The owner read boundary takes no owner argument, so a normal caller
  -- cannot ask about a foreign owner.
  ASSERT (SELECT pronargs FROM pg_proc
           WHERE oid = 'public.read_own_competitor_quota()'::regprocedure) = 0,
    'S1 read_own_competitor_quota takes no owner argument';
END
$s1$;

-- ===========================================================================
-- S1b - the parent-key guard can see the key it created.
--
-- indkey is a zero-based int2vector. Casting it to smallint[] keeps that
-- lower bound, so it is not equal to a one-based ARRAY literal of the same
-- attribute numbers. The migration must not use that comparison.
-- ===========================================================================
DO $s1b$
DECLARE
  v_table text;
  v_saved_search_path text;
  v_policy_gap_detail text;
BEGIN
  ASSERT current_setting('transaction_isolation') = 'read committed',
    'S1b this suite runs under READ COMMITTED';

  FOREACH v_table IN ARRAY ARRAY['social_accounts', 'posts'] LOOP
    ASSERT EXISTS (
             SELECT 1
               FROM pg_index i
              WHERE i.indrelid = format('public.%I', v_table)::regclass
                AND i.indisunique
                AND i.indisvalid
                AND i.indimmediate
                AND i.indnkeyatts = 2
                AND i.indpred IS NULL
                AND (
                      SELECT array_agg(a.attname::text ORDER BY k.ord)
                        FROM unnest(i.indkey::smallint[]) WITH ORDINALITY AS k(attnum, ord)
                        JOIN pg_attribute a
                          ON a.attrelid = i.indrelid
                         AND a.attnum = k.attnum
                         AND a.attnum > 0
                         AND NOT a.attisdropped
                    ) = ARRAY['id', 'user_id']::text[]
           ),
      format('S1b %s has an exact UNIQUE (id, user_id)', v_table);

    ASSERT NOT EXISTS (
             SELECT 1
               FROM pg_index i
              WHERE i.indrelid = format('public.%I', v_table)::regclass
                AND i.indisunique
                AND i.indnkeyatts = 2
                AND i.indkey::smallint[] = ARRAY[
                      (SELECT attnum::smallint FROM pg_attribute
                        WHERE attrelid = format('public.%I', v_table)::regclass
                          AND attname = 'id'),
                      (SELECT attnum::smallint FROM pg_attribute
                        WHERE attrelid = format('public.%I', v_table)::regclass
                          AND attname = 'user_id')
                    ]
           ),
      format('S1b %s indkey is not equal to a one-based ARRAY literal', v_table);
  END LOOP;

  ASSERT (
    SELECT array_lower(i.indkey::smallint[], 1)
      FROM pg_index i
     WHERE i.indrelid = 'public.posts'::regclass
       AND i.indisunique
       AND i.indnkeyatts = 2
     LIMIT 1
  ) = 0,
    'S1b indkey casts are zero-based';

  -- Same canonical deparse as S1. The view's qual column is pg_get_expr,
  -- so this read has to run while auth is hidden, then the path goes back.
  v_saved_search_path := current_setting('search_path');
  BEGIN
    PERFORM pg_catalog.set_config('search_path', 'pg_catalog', true);
    SELECT string_agg(
             format('%s qual=%s cmd=%s roles=%s permissive=%s',
                    tablename,
                    coalesce(qual, '<null>'),
                    cmd,
                    roles::text,
                    permissive),
             '; ' ORDER BY tablename)
      INTO v_policy_gap_detail
      FROM pg_catalog.pg_policies
     WHERE schemaname = 'public'
       AND policyname = 'Owners can read their own rows'
       AND tablename IN (
             'ig_media_insight_snapshots',
             'ig_account_insight_daily',
             'ig_account_profile_observations',
             'competitor_watchlist',
             'competitor_profile_snapshots',
             'competitor_media_snapshots'
           )
       AND NOT (
             cmd = 'SELECT'
             AND roles::text = '{authenticated}'
             AND qual = '(auth.uid() = user_id)'
             AND permissive = 'PERMISSIVE'
           );
    PERFORM pg_catalog.set_config('search_path', v_saved_search_path, true);
  EXCEPTION WHEN OTHERS THEN
    PERFORM pg_catalog.set_config('search_path', v_saved_search_path, true);
    RAISE;
  END;
  ASSERT v_policy_gap_detail IS NULL,
    format('S1b the owner-read policies match the contract a second policy pass must not skip past (mismatches %s)',
           coalesce(v_policy_gap_detail, '<null>'));
  ASSERT current_setting('search_path') = v_saved_search_path,
    'S1b search_path restored after policy deparse';
END
$s1b$;

-- ===========================================================================
-- S2 - the seed data.
--
-- Written as the service role on purpose: that is the writer the collector
-- will be, and it bypasses RLS, so the composite foreign keys are the only
-- thing standing between a cross-owner row and the database.
-- ===========================================================================
SET LOCAL ROLE service_role;

DO $s2$
DECLARE
  u_a     uuid := 'a3a3a3a3-a3a3-4a3a-8a3a-a3a3a3a3a3a3';
  u_b     uuid := 'b3b3b3b3-b3b3-4b3b-8b3b-b3b3b3b3b3b3';
  acct_a  uuid := 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a4a4';
  acct_b  uuid := 'b4b4b4b4-b4b4-4b4b-8b4b-b4b4b4b4b4b4';
  post_a  uuid := 'a5a5a5a5-a5a5-4a5a-8a5a-a5a5a5a5a5a5';
  wl_a    uuid := 'a6a6a6a6-a6a6-4a6a-8a6a-a6a6a6a6a6a6';
  wl_b    uuid := 'b6b6b6b6-b6b6-4b6b-8b6b-b6b6b6b6b6b6';
BEGIN
  -- Owner A: one media snapshot (linked to its own published post), one
  -- account day, one profile observation.
  INSERT INTO public.ig_media_insight_snapshots
    (user_id, social_account_id, post_id, ig_media_id, media_product_type,
     media_type, product, thumbnail_url, caption, permalink, published_at,
     captured_on, captured_at, views, reach, likes, comments, saved, shares,
     total_interactions, status)
  VALUES
    (u_a, acct_a, post_a, 'ig-itk-media-1', 'REELS', 'VIDEO', 'sku-1',
     'https://cdn.example.invalid/itk-1.jpg', 'a reel caption',
     'https://www.instagram.com/reel/itk-media-1/',
     '2026-10-20T09:00:00Z', '2026-10-26', '2026-10-26T03:05:00Z',
     1200, 900, 40, 5, 3, 7, 55, 'ok');

  INSERT INTO public.ig_account_insight_daily
    (user_id, social_account_id, metric_date, provider_date, period_start,
     period_end, provider_timezone, reach, views, accounts_engaged,
     total_interactions, likes, comments, saves, shares, follows, unfollows,
     status)
  VALUES
    (u_a, acct_a, '2026-10-25', '2026-10-25', '2026-10-25T00:00:00Z',
     '2026-10-26T00:00:00Z', 'UTC', 5000, 4200, 300, 190, 80, 12, 20, 30,
     6, 1, 'ok');

  INSERT INTO public.ig_account_profile_observations
    (user_id, social_account_id, observed_at, observed_on, followers_count,
     media_count, status)
  VALUES
    (u_a, acct_a, '2026-10-26T03:06:00Z', '2026-10-26', 1234, 87, 'ok');

  -- Owner B: one media snapshot with no post link (media published outside
  -- Postora) and one account day.
  INSERT INTO public.ig_media_insight_snapshots
    (user_id, social_account_id, ig_media_id, media_product_type, media_type,
     permalink, published_at, captured_on, captured_at, views, reach, likes,
     comments, saved, shares, total_interactions, status)
  VALUES
    (u_b, acct_b, 'ig-itk-media-b', 'FEED', 'IMAGE',
     'https://www.instagram.com/p/itk-media-b/',
     '2026-10-21T09:00:00Z', '2026-10-26', '2026-10-26T03:07:00Z',
     300, 220, 11, 2, 1, 3, 17, 'ok');

  INSERT INTO public.ig_account_insight_daily
    (user_id, social_account_id, metric_date, provider_date, reach, views,
     status)
  VALUES
    (u_b, acct_b, '2026-10-25', '2026-10-25', 800, 640, 'ok');

  -- The watchlist rows, one per owner. Owner A's entry has not been
  -- captured yet, so a later status write is a real change.
  INSERT INTO public.competitor_watchlist (id, user_id, platform, username, label, status)
  VALUES
    (wl_a, u_a, 'instagram', 'itk_comp_a', 'Competitor A', 'pending'),
    (wl_b, u_b, 'instagram', 'itk_comp_b', 'Competitor B', 'ok');

  INSERT INTO public.competitor_profile_snapshots
    (watchlist_id, user_id, captured_on, followers_count, media_count, source, status)
  VALUES
    (wl_a, u_a, '2026-10-26', 5000, 120, 'official', 'ok');

  INSERT INTO public.competitor_media_snapshots
    (watchlist_id, user_id, ig_media_id, captured_on, media_product_type,
     media_type, permalink, published_at, like_count, comments_count,
     view_count, source, status)
  VALUES
    (wl_a, u_a, 'ig-comp-media-1', '2026-10-26', 'REELS', 'VIDEO',
     'https://www.instagram.com/reel/itk-comp-media-1/',
     '2026-10-24T09:00:00Z', 90, 4, 1500, 'official', 'ok');
END
$s2$;

RESET ROLE;

-- ===========================================================================
-- S2b - the owner reads their own rows and nobody else's.
-- ===========================================================================
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'a3a3a3a3-a3a3-4a3a-8a3a-a3a3a3a3a3a3', true);

DO $s2b$
BEGIN
  ASSERT (SELECT count(*) FROM public.ig_media_insight_snapshots) = 1,
    'S2b owner A reads exactly their own media snapshot';
  ASSERT (SELECT count(*) FROM public.ig_account_insight_daily) = 1,
    'S2b owner A reads exactly their own account day';
  ASSERT (SELECT count(*) FROM public.ig_account_profile_observations) = 1,
    'S2b owner A reads exactly their own profile observation';
  ASSERT (SELECT count(*) FROM public.competitor_watchlist) = 1,
    'S2b owner A reads exactly their own watchlist row';
  ASSERT (SELECT count(*) FROM public.competitor_profile_snapshots) = 1,
    'S2b owner A reads exactly their own competitor profile snapshot';
  ASSERT (SELECT count(*) FROM public.competitor_media_snapshots) = 1,
    'S2b owner A reads exactly their own competitor media snapshot';
END
$s2b$;

SELECT set_config('request.jwt.claim.sub', 'b3b3b3b3-b3b3-4b3b-8b3b-b3b3b3b3b3b3', true);

DO $s2c$
BEGIN
  ASSERT (SELECT count(*) FROM public.ig_media_insight_snapshots) = 1,
    'S2c owner B reads exactly their own media snapshot';
  ASSERT (SELECT count(*) FROM public.ig_account_insight_daily) = 1,
    'S2c owner B reads exactly their own account day';
  ASSERT (SELECT count(*) FROM public.ig_account_profile_observations) = 0,
    'S2c owner B sees no profile observation of another owner';
  ASSERT (SELECT count(*) FROM public.competitor_watchlist) = 1,
    'S2c owner B reads exactly their own watchlist row';
  ASSERT (SELECT count(*) FROM public.competitor_profile_snapshots) = 0,
    'S2c owner B sees no competitor profile snapshot of another owner';
  ASSERT (SELECT count(*) FROM public.competitor_media_snapshots) = 0,
    'S2c owner B sees no competitor media snapshot of another owner';
END
$s2c$;

RESET ROLE;

-- ===========================================================================
-- S3 - a client cannot write.
-- ===========================================================================
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'a3a3a3a3-a3a3-4a3a-8a3a-a3a3a3a3a3a3', true);

DO $s3$
BEGIN
  -- A snapshot write of any kind is refused: the metric, the capture day and
  -- the owner are all server facts.
  BEGIN
    INSERT INTO public.ig_media_insight_snapshots
      (user_id, social_account_id, ig_media_id, published_at, captured_on, views)
    VALUES
      ('a3a3a3a3-a3a3-4a3a-8a3a-a3a3a3a3a3a3',
       'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a4a4',
       'ig-forged', now(), current_date, 999);
    RAISE EXCEPTION 'S3 failed: an authenticated client inserted a snapshot'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN insufficient_privilege THEN
    ASSERT SQLSTATE = '42501',
      'a privilege refusal is SQLSTATE 42501, got ' || SQLSTATE || ' ' || SQLERRM;
  END;

  BEGIN
    UPDATE public.ig_media_insight_snapshots SET views = 999999
     WHERE ig_media_id = 'ig-itk-media-1';
    RAISE EXCEPTION 'S3 failed: an authenticated client updated a snapshot'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN insufficient_privilege THEN
    ASSERT SQLSTATE = '42501',
      'a privilege refusal is SQLSTATE 42501, got ' || SQLSTATE || ' ' || SQLERRM;
  END;

  BEGIN
    DELETE FROM public.ig_media_insight_snapshots WHERE ig_media_id = 'ig-itk-media-1';
    RAISE EXCEPTION 'S3 failed: an authenticated client deleted a snapshot'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN insufficient_privilege THEN
    ASSERT SQLSTATE = '42501',
      'a privilege refusal is SQLSTATE 42501, got ' || SQLSTATE || ' ' || SQLERRM;
  END;

  BEGIN
    INSERT INTO public.ig_account_insight_daily
      (user_id, social_account_id, metric_date, provider_date, reach)
    VALUES
      ('a3a3a3a3-a3a3-4a3a-8a3a-a3a3a3a3a3a3',
       'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a4a4',
       current_date, current_date, 1);
    RAISE EXCEPTION 'S3 failed: an authenticated client inserted an account day'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN insufficient_privilege THEN
    ASSERT SQLSTATE = '42501',
      'a privilege refusal is SQLSTATE 42501, got ' || SQLSTATE || ' ' || SQLERRM;
  END;

  -- The watchlist is written through the owner RPC only. A direct write is
  -- refused, and so is a physical delete.
  BEGIN
    INSERT INTO public.competitor_watchlist (user_id, platform, username)
    VALUES ('a3a3a3a3-a3a3-4a3a-8a3a-a3a3a3a3a3a3', 'instagram', 'direct_write');
    RAISE EXCEPTION 'S3 failed: an authenticated client inserted a watchlist row'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN insufficient_privilege THEN
    ASSERT SQLSTATE = '42501',
      'a privilege refusal is SQLSTATE 42501, got ' || SQLSTATE || ' ' || SQLERRM;
  END;

  BEGIN
    UPDATE public.competitor_watchlist SET label = 'direct'
     WHERE username = 'itk_comp_a';
    RAISE EXCEPTION 'S3 failed: an authenticated client updated a watchlist row'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN insufficient_privilege THEN
    ASSERT SQLSTATE = '42501',
      'a privilege refusal is SQLSTATE 42501, got ' || SQLSTATE || ' ' || SQLERRM;
  END;

  BEGIN
    DELETE FROM public.competitor_watchlist WHERE username = 'itk_comp_a';
    RAISE EXCEPTION 'S3 failed: an authenticated client deleted a watchlist row'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN insufficient_privilege THEN
    ASSERT SQLSTATE = '42501',
      'a privilege refusal is SQLSTATE 42501, got ' || SQLSTATE || ' ' || SQLERRM;
  END;
END
$s3$;

RESET ROLE;

SET LOCAL ROLE anon;

DO $s3b$
BEGIN
  BEGIN
    PERFORM count(*) FROM public.ig_media_insight_snapshots;
    RAISE EXCEPTION 'S3b failed: anon read a media snapshot'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN insufficient_privilege THEN
    ASSERT SQLSTATE = '42501',
      'a privilege refusal is SQLSTATE 42501, got ' || SQLSTATE || ' ' || SQLERRM;
  END;

  BEGIN
    PERFORM count(*) FROM public.ig_account_insight_daily;
    RAISE EXCEPTION 'S3b failed: anon read an account day'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN insufficient_privilege THEN
    ASSERT SQLSTATE = '42501',
      'a privilege refusal is SQLSTATE 42501, got ' || SQLSTATE || ' ' || SQLERRM;
  END;

  BEGIN
    PERFORM count(*) FROM public.competitor_watchlist;
    RAISE EXCEPTION 'S3b failed: anon read a watchlist row'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN insufficient_privilege THEN
    ASSERT SQLSTATE = '42501',
      'a privilege refusal is SQLSTATE 42501, got ' || SQLSTATE || ' ' || SQLERRM;
  END;

  BEGIN
    PERFORM count(*) FROM public.competitor_profile_snapshots;
    RAISE EXCEPTION 'S3b failed: anon read a competitor profile snapshot'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN insufficient_privilege THEN
    ASSERT SQLSTATE = '42501',
      'a privilege refusal is SQLSTATE 42501, got ' || SQLSTATE || ' ' || SQLERRM;
  END;
END
$s3b$;

RESET ROLE;

-- ===========================================================================
-- S4 - the service role cannot write a cross-owner row either.
--
-- The service role bypasses RLS, so these refusals are the composite
-- foreign keys at work, not a policy.
-- ===========================================================================
SET LOCAL ROLE service_role;

DO $s4$
DECLARE
  u_a     uuid := 'a3a3a3a3-a3a3-4a3a-8a3a-a3a3a3a3a3a3';
  u_b     uuid := 'b3b3b3b3-b3b3-4b3b-8b3b-b3b3b3b3b3b3';
  acct_a  uuid := 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a4a4';
  post_b  uuid := 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b5b5';
  wl_a    uuid := 'a6a6a6a6-a6a6-4a6a-8a6a-a6a6a6a6a6a6';
BEGIN
  -- A snapshot that names owner A's account but owner B as the owner.
  BEGIN
    INSERT INTO public.ig_media_insight_snapshots
      (user_id, social_account_id, ig_media_id, published_at, captured_on)
    VALUES (u_b, acct_a, 'ig-cross-owner', now(), current_date);
    RAISE EXCEPTION 'S4 failed: a cross-owner media snapshot was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN foreign_key_violation THEN
    ASSERT SQLERRM LIKE '%ig_media_insight_snapshots_account_owner_fkey%',
      'S4 cross-owner media snapshot is refused by the account ownership key, got: ' || SQLERRM;
  END;

  BEGIN
    INSERT INTO public.ig_account_insight_daily
      (user_id, social_account_id, metric_date, provider_date)
    VALUES (u_b, acct_a, current_date, current_date);
    RAISE EXCEPTION 'S4 failed: a cross-owner account day was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN foreign_key_violation THEN
    ASSERT SQLERRM LIKE '%ig_account_insight_daily_account_owner_fkey%',
      'S4 cross-owner account day is refused by the account ownership key, got: ' || SQLERRM;
  END;

  BEGIN
    INSERT INTO public.ig_account_profile_observations
      (user_id, social_account_id, observed_at, observed_on)
    VALUES (u_b, acct_a, now(), current_date);
    RAISE EXCEPTION 'S4 failed: a cross-owner profile observation was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN foreign_key_violation THEN
    ASSERT SQLERRM LIKE '%ig_account_profile_observations_account_owner_fkey%',
      'S4 cross-owner profile observation is refused by the account ownership key, got: ' || SQLERRM;
  END;

  -- A competitor snapshot that names owner A's watchlist entry but owner B.
  -- A distinct capture day, so the refusal under test is the ownership one
  -- and not the daily uniqueness key.
  BEGIN
    INSERT INTO public.competitor_profile_snapshots
      (watchlist_id, user_id, captured_on, source)
    VALUES (wl_a, u_b, current_date - 1, 'official');
    RAISE EXCEPTION 'S4 failed: a cross-owner competitor profile snapshot was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN foreign_key_violation THEN
    ASSERT SQLERRM LIKE '%competitor_profile_snapshots_owner_fkey%',
      'S4 cross-owner competitor profile is refused by the watchlist ownership key, got: ' || SQLERRM;
  END;

  BEGIN
    INSERT INTO public.competitor_media_snapshots
      (watchlist_id, user_id, ig_media_id, captured_on, published_at, source)
    VALUES (wl_a, u_b, 'ig-cross', current_date - 1, now(), 'official');
    RAISE EXCEPTION 'S4 failed: a cross-owner competitor media snapshot was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN foreign_key_violation THEN
    ASSERT SQLERRM LIKE '%competitor_media_snapshots_owner_fkey%',
      'S4 cross-owner competitor media is refused by the watchlist ownership key, got: ' || SQLERRM;
  END;

  -- Nothing survived any of the refusals.
  ASSERT (SELECT count(*) FROM public.ig_media_insight_snapshots) = 2,
    'S4 no refused media snapshot was written';
  ASSERT (SELECT count(*) FROM public.ig_account_insight_daily) = 2,
    'S4 no refused account day was written';
  ASSERT (SELECT count(*) FROM public.competitor_media_snapshots) = 1,
    'S4 no refused competitor media snapshot was written';
END
$s4$;

RESET ROLE;

-- A snapshot that points at another owner's post. The link guard refuses it
-- first, so the guard is switched off for this one statement to prove that
-- the COMPOSITE POST FOREIGN KEY is what stops it.
ALTER TABLE public.ig_media_insight_snapshots
  DISABLE TRIGGER trg_ig_media_insight_snapshots_post_link;

SET LOCAL ROLE service_role;

DO $s4b$
DECLARE
  u_a    uuid := 'a3a3a3a3-a3a3-4a3a-8a3a-a3a3a3a3a3a3';
  acct_a uuid := 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a4a4';
  post_b uuid := 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b5b5';
BEGIN
  BEGIN
    INSERT INTO public.ig_media_insight_snapshots
      (user_id, social_account_id, post_id, ig_media_id, published_at, captured_on)
    VALUES (u_a, acct_a, post_b, 'ig-itk-media-2', now(), current_date);
    RAISE EXCEPTION 'S4 failed: a foreign post link was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN foreign_key_violation THEN
    ASSERT SQLERRM LIKE '%ig_media_insight_snapshots_post_owner_fkey%',
      'S4 a foreign post link is refused by the post ownership key, got: ' || SQLERRM;
  END;

  ASSERT (SELECT count(*) FROM public.ig_media_insight_snapshots
           WHERE ig_media_id = 'ig-itk-media-2') = 0,
    'S4 the refused foreign post link left no row';
END
$s4b$;

RESET ROLE;

ALTER TABLE public.ig_media_insight_snapshots
  ENABLE TRIGGER trg_ig_media_insight_snapshots_post_link;

-- ===========================================================================
-- S5 - the optional post link.
-- ===========================================================================
SET LOCAL ROLE service_role;

DO $s5$
DECLARE
  u_a     uuid := 'a3a3a3a3-a3a3-4a3a-8a3a-a3a3a3a3a3a3';
  acct_a  uuid := 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a4a4';
  post_a  uuid := 'a5a5a5a5-a5a5-4a5a-8a5a-a5a5a5a5a5a5';
BEGIN
  -- The owned match resolves.
  ASSERT public.resolve_ig_media_post_link(acct_a, 'ig-itk-media-1') = post_a,
    'S5 the resolver returns the single owned post';
  ASSERT public.resolve_ig_media_post_link(acct_a, 'ig-itk-media-unknown') IS NULL,
    'S5 the resolver returns null for an unknown media id';

  -- A snapshot whose post link is not backed by an owned platform_posts row
  -- is refused, even for the service role.
  BEGIN
    INSERT INTO public.ig_media_insight_snapshots
      (user_id, social_account_id, post_id, ig_media_id, published_at, captured_on)
    VALUES (u_a, acct_a, post_a, 'ig-itk-media-9', now(), current_date);
    RAISE EXCEPTION 'S5 failed: an unbacked post link was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN check_violation THEN
    ASSERT SQLERRM LIKE '%IG_MEDIA_POST_LINK_INVALID%',
      'S5 the unbacked post link is refused with the link error';
  END;

  -- Another owner's post is refused by the same guard.
  BEGIN
    INSERT INTO public.ig_media_insight_snapshots
      (user_id, social_account_id, post_id, ig_media_id, published_at, captured_on)
    VALUES (u_a, acct_a, 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b5b5', 'ig-itk-media-2',
              now(), current_date);
    RAISE EXCEPTION 'S5 failed: a foreign post link was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN check_violation THEN
    ASSERT SQLERRM LIKE '%IG_MEDIA_POST_LINK_INVALID%',
      'S5 a foreign post link is refused with the link error';
  END;

  -- The same post for the media it actually published is accepted.
  INSERT INTO public.ig_media_insight_snapshots
    (user_id, social_account_id, post_id, ig_media_id, published_at, captured_on, views)
  VALUES (u_a, acct_a, post_a, 'ig-itk-media-1', now(), current_date - 1, 10);
  ASSERT (SELECT count(*) FROM public.ig_media_insight_snapshots
           WHERE ig_media_id = 'ig-itk-media-1') = 2,
    'S5 an owned post link is accepted';

  -- Two owned posts published the same media id. Neither is "the" post.
  INSERT INTO public.posts (id, user_id, caption, platforms, status)
  VALUES ('a8a8a8a8-a8a8-4a8a-8a8a-a8a8a8a8a8a8', u_a, 'second post',
          ARRAY['instagram']::text[], 'completed');
  INSERT INTO public.platform_posts
    (post_id, social_account_id, platform, platform_post_id, status)
  VALUES
    (post_a, acct_a, 'instagram', 'ig-ambiguous', 'success'),
    ('a8a8a8a8-a8a8-4a8a-8a8a-a8a8a8a8a8a8', acct_a, 'instagram', 'ig-ambiguous', 'success');

  ASSERT public.resolve_ig_media_post_link(acct_a, 'ig-ambiguous') IS NULL,
    'S5 two owned posts for one media id resolve to null';

  BEGIN
    INSERT INTO public.ig_media_insight_snapshots
      (user_id, social_account_id, post_id, ig_media_id, published_at, captured_on)
    VALUES (u_a, acct_a, post_a, 'ig-ambiguous', now(), current_date);
    RAISE EXCEPTION 'S5 failed: an ambiguous post link was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN check_violation THEN
    ASSERT SQLERRM LIKE '%IG_MEDIA_POST_LINK_INVALID%',
      'S5 an ambiguous post link is refused with the link error, got: ' || SQLERRM;
  END;

  ASSERT (SELECT count(*) FROM public.ig_media_insight_snapshots
           WHERE ig_media_id = 'ig-ambiguous') = 0,
    'S5 the refused ambiguous post link left no row';
END
$s5$;

RESET ROLE;

-- ===========================================================================
-- S6 - invalid values are refused.
-- ===========================================================================
SET LOCAL ROLE service_role;

DO $s6$
DECLARE
  u_a     uuid := 'a3a3a3a3-a3a3-4a3a-8a3a-a3a3a3a3a3a3';
  acct_a  uuid := 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a4a4';
  wl_a    uuid := 'a6a6a6a6-a6a6-4a6a-8a6a-a6a6a6a6a6a6';
BEGIN
  -- A negative metric is not a metric.
  BEGIN
    INSERT INTO public.ig_media_insight_snapshots
      (user_id, social_account_id, ig_media_id, published_at, captured_on, views)
    VALUES (u_a, acct_a, 'ig-negative', now(), current_date, -1);
    RAISE EXCEPTION 'S6 failed: a negative view count was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN check_violation THEN
    ASSERT SQLERRM LIKE '%ig_media_insight_snapshots_views_chk%',
      'S6 a negative view count is refused by the views check, got: ' || SQLERRM;
  END;

  BEGIN
    INSERT INTO public.ig_account_insight_daily
      (user_id, social_account_id, metric_date, provider_date, reach)
    VALUES (u_a, acct_a, current_date - 5, current_date - 5, -3);
    RAISE EXCEPTION 'S6 failed: a negative reach was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN check_violation THEN
    ASSERT SQLERRM LIKE '%ig_account_insight_daily_reach_chk%',
      'S6 a negative reach is refused by the reach check, got: ' || SQLERRM;
  END;

  -- An unknown product type or media type.
  BEGIN
    INSERT INTO public.ig_media_insight_snapshots
      (user_id, social_account_id, ig_media_id, published_at, captured_on,
       media_product_type)
    VALUES (u_a, acct_a, 'ig-badtype', now(), current_date, 'STORYT');
    RAISE EXCEPTION 'S6 failed: an unknown product type was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN check_violation THEN
    ASSERT SQLERRM LIKE '%ig_media_insight_snapshots_product_type_chk%',
      'S6 an unknown product type is refused by the product-type check, got: ' || SQLERRM;
  END;

  -- An unknown source on a competitor snapshot.
  BEGIN
    INSERT INTO public.competitor_profile_snapshots
      (watchlist_id, user_id, captured_on, source)
    VALUES (wl_a, u_a, current_date - 2, 'scraper');
    RAISE EXCEPTION 'S6 failed: an unknown source was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN check_violation THEN
    ASSERT SQLERRM LIKE '%competitor_profile_snapshots_source_chk%',
      'S6 an unknown source is refused by the source check, got: ' || SQLERRM;
  END;

  BEGIN
    INSERT INTO public.competitor_media_snapshots
      (watchlist_id, user_id, ig_media_id, captured_on, published_at, source, like_count)
    VALUES (wl_a, u_a, 'ig-badsource', current_date, now(), 'apify', -2);
    RAISE EXCEPTION 'S6 failed: a negative public count was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN check_violation THEN
    ASSERT SQLERRM LIKE '%competitor_media_snapshots_like_chk%',
      'S6 a negative public count is refused by the like check, got: ' || SQLERRM;
  END;

  -- An unknown status.
  BEGIN
    INSERT INTO public.ig_account_profile_observations
      (user_id, social_account_id, observed_at, observed_on, status)
    VALUES (u_a, acct_a, now(), current_date, 'halfway');
    RAISE EXCEPTION 'S6 failed: an unknown status was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN check_violation THEN
    ASSERT SQLERRM LIKE '%ig_account_profile_observations_status_chk%',
      'S6 an unknown status is refused by the status check, got: ' || SQLERRM;
  END;

  -- An inverted provider window.
  BEGIN
    INSERT INTO public.ig_account_insight_daily
      (user_id, social_account_id, metric_date, provider_date, period_start, period_end)
    VALUES (u_a, acct_a, current_date - 9, current_date - 9,
            '2026-10-26T00:00:00Z', '2026-10-25T00:00:00Z');
    RAISE EXCEPTION 'S6 failed: an inverted provider window was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN check_violation THEN
    ASSERT SQLERRM LIKE '%ig_account_insight_daily_period_chk%',
      'S6 an inverted provider window is refused by the period check, got: ' || SQLERRM;
  END;

  -- An illegal handle: a space, a doubled period, and an over-long handle.
  BEGIN
    INSERT INTO public.competitor_watchlist (user_id, platform, username)
    VALUES (u_a, 'instagram', 'not a handle');
    RAISE EXCEPTION 'S6 failed: a handle with a space was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN check_violation THEN
    ASSERT SQLERRM LIKE '%competitor_watchlist_username_chk%',
      'S6 a handle with a space is refused by the username check, got: ' || SQLERRM;
  END;

  BEGIN
    INSERT INTO public.competitor_watchlist (user_id, platform, username)
    VALUES (u_a, 'instagram', 'double..period');
    RAISE EXCEPTION 'S6 failed: a handle with a doubled period was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN check_violation THEN
    ASSERT SQLERRM LIKE '%competitor_watchlist_username_chk%',
      'S6 a doubled period is refused by the username check, got: ' || SQLERRM;
  END;

  BEGIN
    INSERT INTO public.competitor_watchlist (user_id, platform, username)
    VALUES (u_a, 'instagram', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    RAISE EXCEPTION 'S6 failed: a 35 character handle was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN check_violation THEN
    ASSERT SQLERRM LIKE '%competitor_watchlist_username_chk%',
      'S6 an over-long handle is refused by the username check, got: ' || SQLERRM;
  END;

  -- The handle is normalised on the way in, whatever the writer.
  INSERT INTO public.competitor_watchlist (user_id, platform, username)
  VALUES (u_a, 'instagram', '@Mixed_Case.Handle');
  ASSERT (SELECT username FROM public.competitor_watchlist
           WHERE user_id = u_a AND label IS NULL
             AND username LIKE '%mixed%') = 'mixed_case.handle',
    'S6 the handle is trimmed, de-@-ed and lower cased by the database';
END
$s6$;

RESET ROLE;

-- ===========================================================================
-- S7 - the daily unique keys and the per-owner handle uniqueness.
-- ===========================================================================
SET LOCAL ROLE service_role;

DO $s7$
DECLARE
  u_a     uuid := 'a3a3a3a3-a3a3-4a3a-8a3a-a3a3a3a3a3a3';
  u_b     uuid := 'b3b3b3b3-b3b3-4b3b-8b3b-b3b3b3b3b3b3';
  acct_a  uuid := 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a4a4';
  wl_a    uuid := 'a6a6a6a6-a6a6-4a6a-8a6a-a6a6a6a6a6a6';
BEGIN
  -- The same media on the same capture day is the same row.
  BEGIN
    INSERT INTO public.ig_media_insight_snapshots
      (user_id, social_account_id, ig_media_id, published_at, captured_on)
    VALUES (u_a, acct_a, 'ig-itk-media-1', now(), '2026-10-26');
    RAISE EXCEPTION 'S7 failed: a duplicate (account, media, day) was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN unique_violation THEN
    ASSERT SQLERRM LIKE '%ig_media_insight_snapshots_capture_key%',
      'S7 a duplicate media day is refused by the capture key, got: ' || SQLERRM;
  END;

  -- The same account on the same metric day is the same row.
  BEGIN
    INSERT INTO public.ig_account_insight_daily
      (user_id, social_account_id, metric_date, provider_date)
    VALUES (u_a, acct_a, '2026-10-25', '2026-10-25');
    RAISE EXCEPTION 'S7 failed: a duplicate (account, metric day) was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN unique_violation THEN
    ASSERT SQLERRM LIKE '%ig_account_insight_daily_day_key%',
      'S7 a duplicate metric day is refused by the day key, got: ' || SQLERRM;
  END;

  -- The same competitor on the same capture day is the same row.
  BEGIN
    INSERT INTO public.competitor_profile_snapshots
      (watchlist_id, user_id, captured_on, source)
    VALUES (wl_a, u_a, '2026-10-26', 'official');
    RAISE EXCEPTION 'S7 failed: a duplicate (watchlist, day) was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN unique_violation THEN
    ASSERT SQLERRM LIKE '%competitor_profile_snapshots_capture_key%',
      'S7 a duplicate competitor day is refused by the capture key, got: ' || SQLERRM;
  END;

  BEGIN
    INSERT INTO public.competitor_media_snapshots
      (watchlist_id, user_id, ig_media_id, captured_on, published_at, source)
    VALUES (wl_a, u_a, 'ig-comp-media-1', '2026-10-26', now(), 'official');
    RAISE EXCEPTION 'S7 failed: a duplicate (watchlist, media, day) was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN unique_violation THEN
    ASSERT SQLERRM LIKE '%competitor_media_snapshots_capture_key%',
      'S7 a duplicate competitor media day is refused by the capture key, got: ' || SQLERRM;
  END;

  -- The handle is unique per owner, and the same handle may be tracked by a
  -- different owner.
  BEGIN
    INSERT INTO public.competitor_watchlist (user_id, platform, username)
    VALUES (u_a, 'instagram', 'mixed_case.handle');
    RAISE EXCEPTION 'S7 failed: the same owner tracked a handle twice'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN unique_violation THEN
    ASSERT SQLERRM LIKE '%competitor_watchlist_owner_handle_key%',
      'S7 a duplicate handle is refused by the owner handle key, got: ' || SQLERRM;
  END;

  INSERT INTO public.competitor_watchlist (user_id, platform, username)
  VALUES (u_b, 'instagram', 'mixed_case.handle');
  ASSERT (SELECT count(*) FROM public.competitor_watchlist
           WHERE username = 'mixed_case.handle') = 2,
    'S7 two owners may track the same competitor';
END
$s7$;

RESET ROLE;

-- ===========================================================================
-- S8 - the identity is immutable and the server-owned columns are server
-- owned.
--
-- The shipped grant surface already refuses a browser write (S1/S3). This
-- section widens that surface on purpose, inside this transaction, to prove
-- that the TRIGGER is the real gate: a grant added later still cannot let a
-- browser set the tracking status.
-- ===========================================================================
-- The temporary grant is deliberately WIDE: it hands the browser role the
-- privilege to write the server-owned status AND to attempt a rename or a
-- re-parent. Only the TRIGGER can stop those, which is the point of this
-- section.
GRANT UPDATE (status, label, username, user_id, is_active) ON public.competitor_watchlist TO authenticated;
CREATE POLICY "Owners can update their own rows" ON public.competitor_watchlist
  FOR UPDATE TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'a3a3a3a3-a3a3-4a3a-8a3a-a3a3a3a3a3a3', true);

DO $s8$
DECLARE
  wl_a uuid := 'a6a6a6a6-a6a6-4a6a-8a6a-a6a6a6a6a6a6';
BEGIN
  -- The server-owned status is refused even with the grant in place.
  BEGIN
    UPDATE public.competitor_watchlist SET status = 'ok' WHERE id = wl_a;
    RAISE EXCEPTION 'S8 failed: a browser set the tracking status'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN insufficient_privilege THEN
    ASSERT SQLERRM LIKE '%COMPETITOR_STATE_PROTECTED%',
      'S8 the protected status is refused with the protected-state error';
  END;

  -- The label is the owner's, and it works.
  UPDATE public.competitor_watchlist SET label = 'Renamed by the owner' WHERE id = wl_a;
  ASSERT (SELECT label FROM public.competitor_watchlist WHERE id = wl_a)
           = 'Renamed by the owner',
    'S8 the owner may relabel their own entry';

  -- The handle cannot be renamed.
  BEGIN
    UPDATE public.competitor_watchlist SET username = 'renamed_handle' WHERE id = wl_a;
    RAISE EXCEPTION 'S8 failed: the handle was renamed'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN check_violation THEN
    ASSERT SQLERRM LIKE '%COMPETITOR_IDENTITY_IMMUTABLE%',
      'S8 the rename is refused with the identity error';
  END;

  -- The entry cannot be moved to another account.
  BEGIN
    UPDATE public.competitor_watchlist
       SET user_id = 'b3b3b3b3-b3b3-4b3b-8b3b-b3b3b3b3b3b3'
     WHERE id = wl_a;
    RAISE EXCEPTION 'S8 failed: the entry was moved to another account'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN check_violation THEN
    ASSERT SQLERRM LIKE '%COMPETITOR_IDENTITY_IMMUTABLE%',
      'S8 the re-parent is refused with the identity error';
  END;

  ASSERT (SELECT username FROM public.competitor_watchlist WHERE id = wl_a)
           = 'itk_comp_a',
    'S8 the handle survived the refused rename';
END
$s8$;

RESET ROLE;

-- The service role IS the collector: it may write the server-owned columns.
SET LOCAL ROLE service_role;

DO $s8b$
DECLARE
  wl_a uuid := 'a6a6a6a6-a6a6-4a6a-8a6a-a6a6a6a6a6a6';
BEGIN
  UPDATE public.competitor_watchlist
     SET status = 'ok',
         source = 'official',
         last_synced_at = now(),
         last_error = NULL,
         last_error_code = NULL,
         next_retry_at = NULL
   WHERE id = wl_a;
  ASSERT (SELECT status FROM public.competitor_watchlist WHERE id = wl_a) = 'ok',
    'S8b the service role may record the tracking status';
  ASSERT (SELECT source FROM public.competitor_watchlist WHERE id = wl_a) = 'official',
    'S8b the service role may record the capture source';

  -- The removal marker follows the active flag for EVERY writer: a
  -- service-role deactivation stamps it even though the writer did not.
  UPDATE public.competitor_watchlist SET is_active = false WHERE id = wl_a;
  ASSERT (SELECT removed_at FROM public.competitor_watchlist WHERE id = wl_a)
           IS NOT NULL,
    'S8b a service-role removal stamps the removal marker';
  UPDATE public.competitor_watchlist SET is_active = true WHERE id = wl_a;
  ASSERT (SELECT removed_at FROM public.competitor_watchlist WHERE id = wl_a) IS NULL,
    'S8b a service-role reactivation clears the removal marker';
  ASSERT (SELECT status FROM public.competitor_watchlist WHERE id = wl_a) = 'ok',
    'S8b a service-role reactivation does not reset tracking status';
END
$s8b$;

RESET ROLE;

DROP POLICY "Owners can update their own rows" ON public.competitor_watchlist;
REVOKE UPDATE (status, label, username, user_id, is_active) ON public.competitor_watchlist FROM authenticated;

-- ===========================================================================
-- S9 - the owner path: add, relabel, soft-remove, reactivate.
-- ===========================================================================
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'a3a3a3a3-a3a3-4a3a-8a3a-a3a3a3a3a3a3', true);

DO $s9$
DECLARE
  u_a    uuid := 'a3a3a3a3-a3a3-4a3a-8a3a-a3a3a3a3a3a3';
  v_res  jsonb;
  v_id   uuid;
BEGIN
  -- Add a competitor, with a handle that needs normalising.
  v_res := public.add_competitor_watchlist('@New_Competitor', 'New one');
  v_id := (v_res->>'watchlist_id')::uuid;
  ASSERT v_res->>'username' = 'new_competitor',
    'S9 the added handle is normalised by the owner path';
  ASSERT v_res->>'is_active' = 'true',
    'S9 the added entry is active';
  ASSERT (SELECT status FROM public.competitor_watchlist WHERE id = v_id) = 'pending',
    'S9 a new entry starts pending, before the first capture';

  -- Adding the same handle again is not a second row.
  v_res := public.add_competitor_watchlist('new_competitor');
  ASSERT v_res->>'already_tracked' = 'true',
    'S9 adding a tracked handle again is a no-op on the identity';
  ASSERT (SELECT count(*) FROM public.competitor_watchlist
           WHERE user_id = u_a AND username = 'new_competitor') = 1,
    'S9 the handle is tracked once';

  -- Relabel.
  v_res := public.update_competitor_watchlist(v_id, 'Renamed label', NULL);
  ASSERT v_res->>'label' = 'Renamed label',
    'S9 the owner relabelled their entry';

  -- Soft removal: the row stays, the removal marker is set.
  v_res := public.update_competitor_watchlist(v_id, NULL, false);
  ASSERT v_res->>'is_active' = 'false',
    'S9 the removal deactivated the entry';
  ASSERT (v_res->>'removed_at') IS NOT NULL,
    'S9 the removal stamped removed_at';
  ASSERT (SELECT count(*) FROM public.competitor_watchlist
           WHERE id = v_id AND is_active) = 0,
    'S9 the removed entry is no longer active';

  -- Another owner cannot touch this entry.
  PERFORM set_config('request.jwt.claim.sub',
                     'b3b3b3b3-b3b3-4b3b-8b3b-b3b3b3b3b3b3', true);
  BEGIN
    PERFORM public.update_competitor_watchlist(v_id, 'stolen', NULL);
    RAISE EXCEPTION 'S9 failed: another owner updated the entry'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN no_data_found THEN
    ASSERT SQLERRM LIKE '%COMPETITOR_NOT_FOUND%',
      'S9 a foreign owner gets not-found, never the row';
  END;
END
$s9$;

RESET ROLE;

-- The history of a removed entry is written by the collector (the service
-- role) - the owner has no write path to the snapshot tables at all.
SET LOCAL ROLE service_role;

DO $s9b$
DECLARE
  u_a uuid := 'a3a3a3a3-a3a3-4a3a-8a3a-a3a3a3a3a3a3';
  v_id uuid;
BEGIN
  SELECT id INTO v_id FROM public.competitor_watchlist
   WHERE user_id = u_a AND username = 'new_competitor';

  INSERT INTO public.competitor_profile_snapshots
    (watchlist_id, user_id, captured_on, followers_count, media_count, source, status)
  VALUES (v_id, u_a, '2026-10-26', 42, 3, 'official', 'ok');
END
$s9b$;

RESET ROLE;

-- The owner still reads that history, and can reactivate the entry.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'a3a3a3a3-a3a3-4a3a-8a3a-a3a3a3a3a3a3', true);

DO $s9c$
DECLARE
  u_a uuid := 'a3a3a3a3-a3a3-4a3a-8a3a-a3a3a3a3a3a3';
  v_id uuid;
  v_res jsonb;
BEGIN
  SELECT id INTO v_id FROM public.competitor_watchlist
   WHERE user_id = u_a AND username = 'new_competitor';

  ASSERT (SELECT count(*) FROM public.competitor_profile_snapshots
           WHERE watchlist_id = v_id) = 1,
    'S9 the history of a removed entry is retained';

  -- Reactivation clears the removal marker.
  v_res := public.update_competitor_watchlist(v_id, NULL, true);
  ASSERT v_res->>'is_active' = 'true',
    'S9 the reactivation reactivated the entry';
  ASSERT (v_res->>'removed_at') IS NULL,
    'S9 the reactivation cleared removed_at';
  ASSERT v_res->>'status' = 'pending',
    'S9 a reactivation of a not-yet-synced row stays pending';
END
$s9c$;

RESET ROLE;

-- ===========================================================================
-- S9d - removal marker, synced reactivation, duplicate add, spoof.
--
-- Sequential. A committed active row at the cap is the outcome the
-- same-handle race has to land on. It is not a two-session proof; the race
-- fixture is the rehearsal that still has to be run on a real server.
-- ===========================================================================
INSERT INTO auth.users (id, email)
VALUES ('17171717-1717-4171-8171-171717171717',
        'itk-sync-17171717-1717-4171-8171-171717171717@example.invalid');

INSERT INTO public.user_quotas (user_id, max_tracked_competitors)
VALUES ('17171717-1717-4171-8171-171717171717', 10)
ON CONFLICT (user_id) DO UPDATE
  SET max_tracked_competitors = EXCLUDED.max_tracked_competitors;

-- The CHECK is structural. With the normalising trigger off, an inactive
-- row without removed_at and an active row with one are both refused.
ALTER TABLE public.competitor_watchlist DISABLE TRIGGER trg_competitor_watchlist_guards;

DO $s9d_chk$
DECLARE
  u_sync uuid := '17171717-1717-4171-8171-171717171717';
BEGIN
  BEGIN
    INSERT INTO public.competitor_watchlist (user_id, platform, username, is_active)
    VALUES (u_sync, 'instagram', 'chk_inactive', false);
    RAISE EXCEPTION 'S9d failed: an inactive row without removed_at was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN check_violation THEN
    ASSERT SQLERRM LIKE '%competitor_watchlist_removal_chk%',
      'S9d an inactive row without removed_at is refused by the removal check, got: ' || SQLERRM;
  END;

  BEGIN
    INSERT INTO public.competitor_watchlist
      (user_id, platform, username, is_active, removed_at)
    VALUES (u_sync, 'instagram', 'chk_active', true, now());
    RAISE EXCEPTION 'S9d failed: an active row with removed_at was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN check_violation THEN
    ASSERT SQLERRM LIKE '%competitor_watchlist_removal_chk%',
      'S9d an active row with removed_at is refused by the removal check, got: ' || SQLERRM;
  END;
END
$s9d_chk$;

ALTER TABLE public.competitor_watchlist ENABLE TRIGGER trg_competitor_watchlist_guards;

SET LOCAL ROLE service_role;

DO $s9d$
DECLARE
  u_sync uuid := '17171717-1717-4171-8171-171717171717';
  v_kept timestamptz := timestamptz '2026-01-15 00:00:00+00';
  v_id uuid;
  v_live uuid;
BEGIN
  INSERT INTO public.competitor_watchlist (user_id, platform, username, is_active)
  VALUES (u_sync, 'instagram', 'rm_blank', false);
  ASSERT (SELECT removed_at FROM public.competitor_watchlist
           WHERE user_id = u_sync AND username = 'rm_blank') = now(),
    'S9d an inactive insert with no marker is stamped now, not an earlier time';

  INSERT INTO public.competitor_watchlist
    (user_id, platform, username, is_active, removed_at)
  VALUES (u_sync, 'instagram', 'rm_known', false, v_kept);
  ASSERT (SELECT removed_at FROM public.competitor_watchlist
           WHERE user_id = u_sync AND username = 'rm_known') = v_kept,
    'S9d a service inactive insert keeps the removal instant it was given';

  UPDATE public.competitor_watchlist
     SET label = 'still removed'
   WHERE user_id = u_sync AND username = 'rm_known';
  ASSERT (SELECT removed_at FROM public.competitor_watchlist
           WHERE user_id = u_sync AND username = 'rm_known') = v_kept,
    'S9d a label edit keeps the first removal timestamp';

  UPDATE public.competitor_watchlist
     SET last_error = 'bookkeeping',
         removed_at = now()
   WHERE user_id = u_sync AND username = 'rm_known';
  ASSERT (SELECT removed_at FROM public.competitor_watchlist
           WHERE user_id = u_sync AND username = 'rm_known') = v_kept,
    'S9d service bookkeeping keeps the first removal timestamp';
  ASSERT (SELECT last_error FROM public.competitor_watchlist
           WHERE user_id = u_sync AND username = 'rm_known') = 'bookkeeping',
    'S9d service bookkeeping can still record an error';

  INSERT INTO public.competitor_watchlist
    (user_id, platform, username, is_active, removed_at, status)
  VALUES (u_sync, 'instagram', 'rm_stale', true, v_kept, 'ok');
  ASSERT (SELECT removed_at FROM public.competitor_watchlist
           WHERE user_id = u_sync AND username = 'rm_stale') IS NULL,
    'S9d an active insert clears a stale removal marker';
  ASSERT (SELECT status FROM public.competitor_watchlist
           WHERE user_id = u_sync AND username = 'rm_stale') = 'ok',
    'S9d an active service insert keeps the status it was given';

  UPDATE public.competitor_watchlist
     SET is_active = false
   WHERE user_id = u_sync AND username = 'rm_stale';
  ASSERT (SELECT removed_at FROM public.competitor_watchlist
           WHERE user_id = u_sync AND username = 'rm_stale') = now(),
    'S9d a deactivation with no marker is stamped now';

  UPDATE public.competitor_watchlist
     SET is_active = true
   WHERE user_id = u_sync AND username = 'rm_stale';
  ASSERT (SELECT removed_at FROM public.competitor_watchlist
           WHERE user_id = u_sync AND username = 'rm_stale') IS NULL,
    'S9d a service reactivation clears the removal marker';
  ASSERT (SELECT status FROM public.competitor_watchlist
           WHERE user_id = u_sync AND username = 'rm_stale') = 'ok',
    'S9d a service reactivation does not reset status';

  -- The live active row whose status must survive a duplicate add.
  INSERT INTO public.competitor_watchlist
    (user_id, platform, username, is_active, status, source, last_error, last_synced_at)
  VALUES (u_sync, 'instagram', 'sync_live', true, 'ok', 'official', NULL,
          timestamptz '2026-10-20 03:04:05+00')
  RETURNING id INTO v_live;

  INSERT INTO public.competitor_profile_snapshots
    (watchlist_id, user_id, captured_on, followers_count, media_count, source, status)
  VALUES (v_live, u_sync, '2026-10-20', 11, 2, 'official', 'ok');

  -- Previously synced removals. One row per status, per RPC.
  INSERT INTO public.competitor_watchlist
    (user_id, platform, username, is_active, removed_at, status, source,
     last_error, last_synced_at)
  VALUES
    (u_sync, 'instagram', 'ok_add', false, timestamptz '2026-09-01 00:00:00+00',
     'ok', 'official', 'previous failure', timestamptz '2026-10-20 03:04:05+00'),
    (u_sync, 'instagram', 'ok_upd', false, timestamptz '2026-09-02 00:00:00+00',
     'ok', 'official', 'previous failure', timestamptz '2026-10-20 03:04:05+00'),
    (u_sync, 'instagram', 'unavail_add', false, timestamptz '2026-09-03 00:00:00+00',
     'unavailable', 'official', 'not a business', timestamptz '2026-10-20 03:04:05+00'),
    (u_sync, 'instagram', 'unavail_upd', false, timestamptz '2026-09-04 00:00:00+00',
     'unavailable', 'official', 'not a business', timestamptz '2026-10-20 03:04:05+00'),
    (u_sync, 'instagram', 'error_add', false, timestamptz '2026-09-05 00:00:00+00',
     'error', 'official', 'temporary failure', timestamptz '2026-10-20 03:04:05+00'),
    (u_sync, 'instagram', 'error_upd', false, timestamptz '2026-09-06 00:00:00+00',
     'error', 'official', 'temporary failure', timestamptz '2026-10-20 03:04:05+00'),
    (u_sync, 'instagram', 'spoof_target', false, timestamptz '2026-09-07 00:00:00+00',
     'ok', 'official', 'keep me', timestamptz '2026-10-20 03:04:05+00'),
    (u_sync, 'instagram', 'blocked_ok', false, timestamptz '2026-09-08 00:00:00+00',
     'ok', 'official', 'still there', timestamptz '2026-10-20 03:04:05+00');

  INSERT INTO public.competitor_profile_snapshots
    (watchlist_id, user_id, captured_on, followers_count, media_count, source, status)
  SELECT id, u_sync, '2026-10-19', 4, 1, 'official', 'ok'
    FROM public.competitor_watchlist
   WHERE user_id = u_sync
     AND username IN ('ok_add', 'ok_upd', 'unavail_add', 'unavail_upd',
                      'error_add', 'error_upd', 'spoof_target', 'blocked_ok');

  SELECT id INTO v_id FROM public.competitor_watchlist
   WHERE user_id = u_sync AND username = 'ok_add';
  ASSERT (SELECT count(*) FROM public.competitor_profile_snapshots
           WHERE watchlist_id = v_id) = 1,
    'S9d the synced history was stored before reactivation';
END
$s9d$;

RESET ROLE;

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '17171717-1717-4171-8171-171717171717', true);

DO $s9e$
DECLARE
  u_sync uuid := '17171717-1717-4171-8171-171717171717';
  v_res jsonb;
  v_id uuid;
  v_active integer;
BEGIN
  SELECT count(*)::integer INTO v_active
    FROM public.competitor_watchlist
   WHERE user_id = u_sync AND is_active;

  v_res := public.add_competitor_watchlist('sync_live');
  ASSERT v_res->>'already_tracked' = 'true',
    'S9e adding an active handle is already tracked';
  ASSERT v_res->>'reactivated' = 'false',
    'S9e adding an active handle does not report a reactivation';
  ASSERT v_res->>'status' = 'ok',
    'S9e adding an active handle does not reset status';
  ASSERT NOT jsonb_exists(v_res, 'quota'),
    'S9e the already-tracked response does not carry a quota payload';
  ASSERT (SELECT count(*) FROM public.competitor_watchlist
           WHERE user_id = u_sync AND is_active) = v_active,
    'S9e adding an active handle does not take another slot';
  ASSERT (SELECT count(*) FROM public.competitor_profile_snapshots s
            JOIN public.competitor_watchlist w ON w.id = s.watchlist_id
           WHERE w.user_id = u_sync AND w.username = 'sync_live') = 1,
    'S9e the live row keeps its history';

  v_res := public.add_competitor_watchlist('ok_add');
  ASSERT v_res->>'reactivated' = 'true',
    'S9e add reactivates a previously ok row';
  ASSERT v_res->>'status' = 'pending',
    'S9e add resets a previously ok row to pending';
  ASSERT (v_res->>'removed_at') IS NULL,
    'S9e add clears removed_at on reactivation';
  SELECT id INTO v_id FROM public.competitor_watchlist
   WHERE user_id = u_sync AND username = 'ok_add';
  ASSERT (SELECT source FROM public.competitor_watchlist WHERE id = v_id) = 'official',
    'S9e reactivation does not rewrite source';
  ASSERT (SELECT last_error FROM public.competitor_watchlist WHERE id = v_id) = 'previous failure',
    'S9e reactivation does not clear the stored error';
  ASSERT (SELECT last_synced_at FROM public.competitor_watchlist WHERE id = v_id)
           = timestamptz '2026-10-20 03:04:05+00',
    'S9e reactivation does not rewrite last_synced_at';
  ASSERT (SELECT count(*) FROM public.competitor_profile_snapshots
           WHERE watchlist_id = v_id) = 1,
    'S9e reactivation keeps the ok row history';

  SELECT id INTO v_id FROM public.competitor_watchlist
   WHERE user_id = u_sync AND username = 'ok_upd';
  v_res := public.update_competitor_watchlist(v_id, NULL, true);
  ASSERT v_res->>'is_active' = 'true',
    'S9e update reactivates a previously ok row';
  ASSERT v_res->>'status' = 'pending',
    'S9e update resets a previously ok row to pending';
  ASSERT (v_res->>'removed_at') IS NULL,
    'S9e update clears removed_at on reactivation';
  ASSERT (SELECT count(*) FROM public.competitor_profile_snapshots
           WHERE watchlist_id = v_id) = 1,
    'S9e update reactivation keeps the ok row history';

  v_res := public.add_competitor_watchlist('unavail_add');
  ASSERT v_res->>'status' = 'pending',
    'S9e add resets a previously unavailable row to pending';
  ASSERT v_res->>'reactivated' = 'true',
    'S9e add reactivates a previously unavailable row';
  SELECT id INTO v_id FROM public.competitor_watchlist
   WHERE user_id = u_sync AND username = 'unavail_upd';
  v_res := public.update_competitor_watchlist(v_id, NULL, true);
  ASSERT v_res->>'status' = 'pending',
    'S9e update resets a previously unavailable row to pending';

  v_res := public.add_competitor_watchlist('error_add');
  ASSERT v_res->>'status' = 'pending',
    'S9e add resets a previously error row to pending';
  ASSERT v_res->>'reactivated' = 'true',
    'S9e add reactivates a previously error row';
  SELECT id INTO v_id FROM public.competitor_watchlist
   WHERE user_id = u_sync AND username = 'error_upd';
  v_res := public.update_competitor_watchlist(v_id, NULL, true);
  ASSERT v_res->>'status' = 'pending',
    'S9e update resets a previously error row to pending';
  ASSERT (SELECT count(*) FROM public.competitor_profile_snapshots
           WHERE watchlist_id = v_id) = 1,
    'S9e update reactivation keeps the error row history';
END
$s9e$;

RESET ROLE;

-- Widened grants. The trigger, not the privilege, has to stop a browser
-- from writing status or sync columns, including on the way back to active.
GRANT INSERT (
  user_id, platform, username, is_active, status, source, last_error, last_synced_at
) ON public.competitor_watchlist TO authenticated;
GRANT UPDATE (
  status, source, last_error, last_error_code, last_synced_at, next_retry_at,
  is_active, label, removed_at
) ON public.competitor_watchlist TO authenticated;
CREATE POLICY "Owners can insert their own rows" ON public.competitor_watchlist
  FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Owners can update their own rows" ON public.competitor_watchlist
  FOR UPDATE TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '17171717-1717-4171-8171-171717171717', true);

DO $s9f$
DECLARE
  u_sync uuid := '17171717-1717-4171-8171-171717171717';
  v_id uuid;
BEGIN
  SELECT id INTO v_id FROM public.competitor_watchlist
   WHERE user_id = u_sync AND username = 'spoof_target';

  BEGIN
    UPDATE public.competitor_watchlist
       SET is_active = true,
           status = 'pending',
           source = 'apify',
           last_error = 'spoof',
           last_synced_at = now()
     WHERE id = v_id;
    RAISE EXCEPTION 'S9f failed: a browser set status while reactivating'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN insufficient_privilege THEN
    ASSERT SQLSTATE = '42501',
      'S9f the spoof is SQLSTATE 42501, got ' || SQLSTATE;
    ASSERT SQLERRM LIKE '%COMPETITOR_STATE_PROTECTED%',
      'S9f a caller-supplied pending status is refused, got: ' || SQLERRM;
  END;

  ASSERT (SELECT is_active FROM public.competitor_watchlist WHERE id = v_id) = false,
    'S9f the refused spoof left the row inactive';
  ASSERT (SELECT status FROM public.competitor_watchlist WHERE id = v_id) = 'ok',
    'S9f the refused spoof left status ok';
  ASSERT (SELECT source FROM public.competitor_watchlist WHERE id = v_id) = 'official',
    'S9f the refused spoof left source official';
  ASSERT (SELECT last_error FROM public.competitor_watchlist WHERE id = v_id) = 'keep me',
    'S9f the refused spoof left the stored error';

  BEGIN
    INSERT INTO public.competitor_watchlist
      (user_id, platform, username, is_active, status, source, last_error, last_synced_at)
    VALUES (u_sync, 'instagram', 'spoof_insert', true, 'ok', 'apify', 'spoof', now());
    RAISE EXCEPTION 'S9f failed: a browser insert set tracking status'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN insufficient_privilege THEN
    ASSERT SQLERRM LIKE '%COMPETITOR_STATE_PROTECTED%',
      'S9f a browser insert of status ok is refused, got: ' || SQLERRM;
  END;

  ASSERT (SELECT count(*) FROM public.competitor_watchlist
           WHERE user_id = u_sync AND username = 'spoof_insert') = 0,
    'S9f the refused insert left no row';

  -- The trigger, not the caller, performs the pending reset.
  UPDATE public.competitor_watchlist
     SET is_active = true
   WHERE id = v_id;
  ASSERT (SELECT status FROM public.competitor_watchlist WHERE id = v_id) = 'pending',
    'S9f a browser reactivation that does not write status is reset to pending';
  ASSERT (SELECT source FROM public.competitor_watchlist WHERE id = v_id) = 'official',
    'S9f that reactivation leaves source alone';
  ASSERT (SELECT last_error FROM public.competitor_watchlist WHERE id = v_id) = 'keep me',
    'S9f that reactivation leaves the stored error';
  ASSERT (SELECT removed_at FROM public.competitor_watchlist WHERE id = v_id) IS NULL,
    'S9f that reactivation clears removed_at';
  ASSERT (SELECT count(*) FROM public.competitor_profile_snapshots
           WHERE watchlist_id = v_id) = 1,
    'S9f that reactivation keeps the history';
END
$s9f$;

RESET ROLE;

DROP POLICY "Owners can insert their own rows" ON public.competitor_watchlist;
DROP POLICY "Owners can update their own rows" ON public.competitor_watchlist;
REVOKE INSERT (
  user_id, platform, username, is_active, status, source, last_error, last_synced_at
) ON public.competitor_watchlist FROM authenticated;
REVOKE UPDATE (
  status, source, last_error, last_error_code, last_synced_at, next_retry_at,
  is_active, label, removed_at
) ON public.competitor_watchlist FROM authenticated;

-- Exactly at the cap: the active rows fill the override. blocked_ok is
-- still inactive. Adding the live handle must stay idempotent. Reactivating
-- blocked_ok must be the quota error, not the state-protection error.
UPDATE public.user_quotas
   SET max_tracked_competitors = (
         SELECT count(*)::integer
           FROM public.competitor_watchlist
          WHERE user_id = '17171717-1717-4171-8171-171717171717'
            AND is_active
       )
 WHERE user_id = '17171717-1717-4171-8171-171717171717';

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '17171717-1717-4171-8171-171717171717', true);

DO $s9g$
DECLARE
  u_sync uuid := '17171717-1717-4171-8171-171717171717';
  v_res jsonb;
  v_blocked uuid;
  v_live uuid;
  v_removed_at timestamptz;
  v_active integer;
BEGIN
  SELECT id, removed_at INTO v_blocked, v_removed_at
    FROM public.competitor_watchlist
   WHERE user_id = u_sync AND username = 'blocked_ok';
  SELECT id INTO v_live
    FROM public.competitor_watchlist
   WHERE user_id = u_sync AND username = 'sync_live';
  SELECT count(*)::integer INTO v_active
    FROM public.competitor_watchlist
   WHERE user_id = u_sync AND is_active;

  v_res := public.add_competitor_watchlist('sync_live');
  ASSERT v_res->>'already_tracked' = 'true',
    'S9g adding the active handle at the cap is already tracked';
  ASSERT v_res->>'status' = 'ok',
    'S9g adding the active handle at the cap does not reset status';
  ASSERT (SELECT count(*) FROM public.competitor_watchlist
           WHERE user_id = u_sync AND is_active) = v_active,
    'S9g adding the active handle at the cap does not take another slot';

  BEGIN
    PERFORM public.add_competitor_watchlist('blocked_ok');
    RAISE EXCEPTION 'S9g failed: an over-quota add reactivation was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN check_violation THEN
    ASSERT SQLSTATE = '23514',
      'S9g the over-quota add is a check violation, got ' || SQLSTATE || ' ' || SQLERRM;
    ASSERT SQLERRM LIKE 'COMPETITOR_QUOTA_EXCEEDED:%',
      'S9g the over-quota add is the quota error, got: ' || SQLERRM;
  END;

  BEGIN
    PERFORM public.update_competitor_watchlist(v_blocked, NULL, true);
    RAISE EXCEPTION 'S9g failed: an over-quota update reactivation was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN check_violation THEN
    ASSERT SQLERRM LIKE 'COMPETITOR_QUOTA_EXCEEDED:%',
      'S9g the over-quota update is the quota error, got: ' || SQLERRM;
  END;

  ASSERT (SELECT is_active FROM public.competitor_watchlist WHERE id = v_blocked) = false,
    'S9g the refused reactivation left the row inactive';
  ASSERT (SELECT status FROM public.competitor_watchlist WHERE id = v_blocked) = 'ok',
    'S9g the refused reactivation left status ok';
  ASSERT (SELECT removed_at FROM public.competitor_watchlist WHERE id = v_blocked) = v_removed_at,
    'S9g the refused reactivation kept the removal timestamp';
  ASSERT (SELECT count(*) FROM public.competitor_profile_snapshots
           WHERE watchlist_id = v_blocked) = 1,
    'S9g the refused reactivation kept the history';

  v_res := public.update_competitor_watchlist(v_blocked, 'label at the cap', NULL);
  ASSERT v_res->>'label' = 'label at the cap',
    'S9g a label edit is accepted while over the cap for a new activation';
  ASSERT (SELECT removed_at FROM public.competitor_watchlist WHERE id = v_blocked) = v_removed_at,
    'S9g the label edit kept the removal timestamp';
  ASSERT (SELECT status FROM public.competitor_watchlist WHERE id = v_blocked) = 'ok',
    'S9g the label edit left status ok';

  v_res := public.update_competitor_watchlist(v_live, NULL, false);
  ASSERT v_res->>'is_active' = 'false',
    'S9g a removal is accepted at the cap';
  ASSERT (v_res->>'removed_at') IS NOT NULL,
    'S9g the removal stamped removed_at';
  ASSERT (SELECT count(*) FROM public.competitor_profile_snapshots
           WHERE watchlist_id = v_live) = 1,
    'S9g the removed live row keeps its history';

  v_res := public.add_competitor_watchlist('blocked_ok');
  ASSERT v_res->>'reactivated' = 'true',
    'S9g the freed slot reactivates the previously ok row';
  ASSERT v_res->>'status' = 'pending',
    'S9g that reactivation resets status to pending';
  ASSERT (SELECT count(*) FROM public.competitor_profile_snapshots
           WHERE watchlist_id = v_blocked) = 1,
    'S9g the reactivated row keeps its history';
END
$s9g$;

RESET ROLE;

-- ===========================================================================
-- S10 - the entitlement resolves override -> plan -> free.
-- ===========================================================================

-- The seeding statement from the migration, run against a plan row whose
-- competitor limit is still NULL. The harness applies the migration to a
-- schema-only baseline with no rows, so the seeding cannot be observed from
-- the migration itself; this asserts the same statement's behaviour.
UPDATE public.subscription_plans
   SET max_tracked_competitors = COALESCE(max_tracked_competitors, 5)
 WHERE slug = 'free';
UPDATE public.subscription_plans
   SET max_tracked_competitors = COALESCE(max_tracked_competitors, 20)
 WHERE slug = 'pro';
UPDATE public.subscription_plans
   SET max_tracked_competitors = COALESCE(max_tracked_competitors, 30)
 WHERE slug = 'business';

DO $s10$
BEGIN
  ASSERT (SELECT max_tracked_competitors FROM public.subscription_plans WHERE slug = 'free') = 5,
    'S10 the free plan is seeded with 5';
  ASSERT (SELECT max_tracked_competitors FROM public.subscription_plans WHERE slug = 'pro') = 20,
    'S10 the pro plan is seeded with 20';
  ASSERT (SELECT max_tracked_competitors FROM public.subscription_plans WHERE slug = 'business') = 30,
    'S10 the business plan is seeded with 30';

  -- An administrator-edited limit survives a replay of the seeding.
  UPDATE public.subscription_plans SET max_tracked_competitors = 7 WHERE slug = 'business';
  UPDATE public.subscription_plans
     SET max_tracked_competitors = COALESCE(max_tracked_competitors, 30)
   WHERE slug = 'business';
  ASSERT (SELECT max_tracked_competitors FROM public.subscription_plans WHERE slug = 'business') = 7,
    'S10 a replay does not overwrite an administrator-edited limit';
  UPDATE public.subscription_plans SET max_tracked_competitors = 30 WHERE slug = 'business';
END
$s10$;

DO $s10b$
DECLARE
  u_a       uuid := 'a3a3a3a3-a3a3-4a3a-8a3a-a3a3a3a3a3a3';
  u_quota   uuid := 'd3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d3d3';
  u_admin   uuid := 'c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c3c3';
  u_plain   uuid := 'f9f9f9f9-f9f9-4f9f-8f9f-f9f9f9f9f9f9';
  plan_free     uuid := 'f1f1f1f1-f1f1-4f1f-8f1f-f1f1f1f1f1f1';
  plan_pro      uuid := 'f2f2f2f2-f2f2-4f2f-8f2f-f2f2f2f2f2f2';
  plan_business uuid := 'f3f3f3f3-f3f3-4f3f-8f3f-f3f3f3f3f3f3';
BEGIN
  INSERT INTO auth.users (id, email)
  VALUES (u_plain, 'itk-plain-' || u_plain::text || '@example.invalid');

  -- No subscription at all -> the free fallback.
  ASSERT public.effective_competitor_quota(u_plain) = 5,
    'S10b a user without a subscription falls back to the free limit';

  -- handle_subscription_change() calls set_user_quotas_for_plan(), which
  -- refuses a non-admin auth.uid() and allows a session with no end-user
  -- identity. RESET ROLE does not clear request.jwt.claim.sub, so the
  -- subject from the owner sections is still in force here. These rows are
  -- superuser fixtures. Empty string is what auth.uid()'s nullif treats as
  -- absent. The plan-change trigger still runs.
  PERFORM set_config('request.jwt.claim.sub', '', true);
  ASSERT auth.uid() IS NULL,
    'S10b subscription fixtures run with no end-user identity';

  -- An active subscription entitles.
  INSERT INTO public.user_subscriptions (user_id, plan_id, status, current_period_end)
  VALUES (u_plain, plan_pro, 'active', now() + interval '30 days');
  ASSERT public.effective_competitor_quota(u_plain) = 20,
    'S10b an active pro subscription resolves to 20';

  -- past_due still entitles: dunning is not a downgrade.
  UPDATE public.user_subscriptions SET status = 'past_due' WHERE user_id = u_plain;
  ASSERT public.effective_competitor_quota(u_plain) = 20,
    'S10b a past_due subscription still entitles';

  -- A cancelled subscription does not.
  UPDATE public.user_subscriptions SET status = 'cancelled' WHERE user_id = u_plain;
  ASSERT public.effective_competitor_quota(u_plain) = 5,
    'S10b a cancelled subscription falls back to the free limit';

  -- The business plan resolves to its own limit.
  UPDATE public.user_subscriptions SET status = 'active', plan_id = plan_business WHERE user_id = u_plain;
  ASSERT public.effective_competitor_quota(u_plain) = 30,
    'S10b an active business subscription resolves to 30';

  -- An override wins over the plan, in both directions.
  UPDATE public.user_quotas SET max_tracked_competitors = 2 WHERE user_id = u_plain;
  ASSERT public.effective_competitor_quota(u_plain) = 2,
    'S10b an override wins over the plan';
  UPDATE public.user_quotas SET max_tracked_competitors = -1 WHERE user_id = u_plain;
  ASSERT public.effective_competitor_quota(u_plain) = -1,
    'S10b an override of -1 is unlimited';

  -- An override survives a plan change: the plan change clears the OTHER
  -- overrides, not a deliberate competitor override.
  UPDATE public.user_quotas SET max_tracked_competitors = 3 WHERE user_id = u_plain;
  UPDATE public.user_subscriptions SET plan_id = plan_free WHERE user_id = u_plain;
  ASSERT public.effective_competitor_quota(u_plain) = 3,
    'S10b an explicit competitor override survives a plan change';

  -- The resolver carries no admin bypass: it reports the stored entitlement.
  UPDATE public.user_quotas SET max_tracked_competitors = NULL WHERE user_id = u_admin;
  ASSERT public.effective_competitor_quota(u_admin) = 5,
    'S10b the resolver does not exempt an admin';
END
$s10b$;

-- The owner read boundary: an admin reads unlimited, an owner reads their own.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c3c3', true);

DO $s10c$
DECLARE
  v_res jsonb;
BEGIN
  v_res := public.read_own_competitor_quota();
  ASSERT v_res->>'max_tracked_competitors' = '-1',
    'S10c an admin reads an unlimited competitor quota';
  ASSERT v_res->>'unlimited' = 'true',
    'S10c the admin quota reports unlimited';
END
$s10c$;

SELECT set_config('request.jwt.claim.sub', 'a3a3a3a3-a3a3-4a3a-8a3a-a3a3a3a3a3a3', true);

DO $s10d$
DECLARE
  v_res jsonb;
BEGIN
  v_res := public.read_own_competitor_quota();
  ASSERT v_res->>'max_tracked_competitors' = '5',
    'S10d an owner reads their own resolved limit';
  ASSERT (v_res->>'tracked_active')::integer >= 1,
    'S10d the owner quota reports the active entry count';
END
$s10d$;

RESET ROLE;

-- ===========================================================================
-- S11 - the quota is atomic.
--
-- u_quota has an override of two. The third concurrent entry is refused, a
-- label edit and a removal are not, and a reactivation is checked again.
-- ===========================================================================
UPDATE public.user_quotas SET max_tracked_competitors = 2 WHERE user_id = 'd3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d3d3';

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'd3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d3d3', true);

DO $s11$
DECLARE
  u_quota uuid := 'd3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d3d3';
  v_res   jsonb;
  v_one   uuid;
  v_two   uuid;
  v_three uuid;
BEGIN
  v_res := public.add_competitor_watchlist('quota_one');
  v_one := (v_res->>'watchlist_id')::uuid;
  v_res := public.add_competitor_watchlist('quota_two');
  v_two := (v_res->>'watchlist_id')::uuid;

  ASSERT (SELECT count(*) FROM public.competitor_watchlist
           WHERE user_id = u_quota AND is_active) = 2,
    'S11 the limit of two allows two active entries';

  -- The N+1th is refused, with a stable, UI-safe error.
  BEGIN
    PERFORM public.add_competitor_watchlist('quota_three');
    RAISE EXCEPTION 'S11 failed: the third entry was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN check_violation THEN
    ASSERT SQLERRM LIKE 'COMPETITOR_QUOTA_EXCEEDED:%',
      'S11 the refusal carries the typed quota code, got: ' || SQLERRM;
    ASSERT SQLSTATE = '23514',
      'S11 the refusal is a check violation';
  END;

  ASSERT (SELECT count(*) FROM public.competitor_watchlist
           WHERE user_id = u_quota AND is_active) = 2,
    'S11 the refused add left no row';

  -- A label edit is accepted even at the limit.
  v_res := public.update_competitor_watchlist(v_one, 'Still editable', NULL);
  ASSERT v_res->>'label' = 'Still editable',
    'S11 a label edit is accepted at the limit';

  -- A removal is accepted even at the limit, and frees the slot.
  v_res := public.update_competitor_watchlist(v_two, NULL, false);
  ASSERT v_res->>'is_active' = 'false',
    'S11 a removal is accepted at the limit';
  ASSERT (SELECT count(*) FROM public.competitor_watchlist
           WHERE user_id = u_quota AND is_active) = 1,
    'S11 the removal freed the slot';

  -- The freed slot can be used again.
  v_res := public.add_competitor_watchlist('quota_three');
  v_three := (v_res->>'watchlist_id')::uuid;
  ASSERT v_res->>'watchlist_id' IS NOT NULL,
    'S11 the freed slot accepts a new entry';

  -- Now the limit is reached again. A reactivation is quota-checked. The
  -- limit is tightened by the ADMIN side (the owner can read their own
  -- quota row, never write it), so the reactivation is attempted after.
  PERFORM public.update_competitor_watchlist(v_three, NULL, false);
  ASSERT (SELECT count(*) FROM public.competitor_watchlist
           WHERE user_id = u_quota AND is_active) = 1,
    'S11 the second removal freed the slot again';
END
$s11$;

RESET ROLE;

UPDATE public.user_quotas SET max_tracked_competitors = 1 WHERE user_id = 'd3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d3d3';

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'd3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d3d3', true);

DO $s11b$
DECLARE
  u_quota uuid := 'd3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d3d3';
  v_two   uuid;
BEGIN
  SELECT id INTO v_two FROM public.competitor_watchlist
   WHERE user_id = u_quota AND username = 'quota_two';

  ASSERT (SELECT count(*) FROM public.competitor_watchlist
           WHERE user_id = u_quota AND is_active) = 1,
    'S11b the tightened limit leaves one active entry';

  BEGIN
    PERFORM public.update_competitor_watchlist(v_two, NULL, true);
    RAISE EXCEPTION 'S11 failed: a reactivation above the limit was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN check_violation THEN
    ASSERT SQLERRM LIKE 'COMPETITOR_QUOTA_EXCEEDED:%',
      'S11 the reactivation is refused with the typed quota code';
  END;

  ASSERT (SELECT is_active FROM public.competitor_watchlist WHERE id = v_two) = false,
    'S11 the refused reactivation left the entry inactive';
END
$s11b$;

RESET ROLE;

-- A direct write by the service role is quota-checked too: the trigger is
-- not an owner-only gate.
SET LOCAL ROLE service_role;

DO $s11b$
DECLARE
  u_quota uuid := 'd3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d3d3';
BEGIN
  BEGIN
    INSERT INTO public.competitor_watchlist (user_id, platform, username)
    VALUES (u_quota, 'instagram', 'service_direct');
    RAISE EXCEPTION 'S11b failed: a direct service insert above the limit was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN check_violation THEN
    ASSERT SQLERRM LIKE 'COMPETITOR_QUOTA_EXCEEDED:%',
      'S11b the direct insert is refused with the typed quota code';
  END;

  ASSERT (SELECT count(*) FROM public.competitor_watchlist
           WHERE user_id = u_quota AND username = 'service_direct') = 0,
    'S11b the refused direct insert left no row';
END
$s11b$;

RESET ROLE;

-- An admin is exempt at the enforcement boundary, not in the resolver.
UPDATE public.user_quotas SET max_tracked_competitors = 0 WHERE user_id = 'c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c3c3';

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c3c3', true);

DO $s11c$
DECLARE
  i integer;
BEGIN
  FOR i IN 1..6 LOOP
    PERFORM public.add_competitor_watchlist('admin_comp_' || i::text);
  END LOOP;
  ASSERT (SELECT count(*) FROM public.competitor_watchlist
           WHERE user_id = 'c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c3c3' AND is_active) = 6,
    'S11c an admin is exempt from the tracked-competitor limit';
END
$s11c$;

RESET ROLE;

-- ===========================================================================
-- S12 - a downgrade denies ONLY new activations.
--
-- u_down tracks eight competitors under an override of eight, then the
-- override is lifted and the free limit (five) applies. The eight existing
-- entries keep their history; only a NEW activation is refused.
-- ===========================================================================
UPDATE public.user_quotas SET max_tracked_competitors = 8 WHERE user_id = 'e3e3e3e3-e3e3-4e3e-8e3e-e3e3e3e3e3e3';

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'e3e3e3e3-e3e3-4e3e-8e3e-e3e3e3e3e3e3', true);

DO $s12$
DECLARE
  u_down  uuid := 'e3e3e3e3-e3e3-4e3e-8e3e-e3e3e3e3e3e3';
  i       integer;
  v_id    uuid;
BEGIN
  FOR i IN 1..8 LOOP
    PERFORM public.add_competitor_watchlist('down_comp_' || i::text);
  END LOOP;
  ASSERT (SELECT count(*) FROM public.competitor_watchlist
           WHERE user_id = u_down AND is_active) = 8,
    'S12 eight entries are tracked under the override of eight';

  -- The history of the first entry.
  SELECT id INTO v_id FROM public.competitor_watchlist
   WHERE user_id = u_down AND username = 'down_comp_1';
END
$s12$;

RESET ROLE;

-- The override is lifted: the free plan's five now applies, and the owner
-- is over the limit.
UPDATE public.user_quotas SET max_tracked_competitors = NULL WHERE user_id = 'e3e3e3e3-e3e3-4e3e-8e3e-e3e3e3e3e3e3';

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'e3e3e3e3-e3e3-4e3e-8e3e-e3e3e3e3e3e3', true);

DO $s12b$
DECLARE
  u_down uuid := 'e3e3e3e3-e3e3-4e3e-8e3e-e3e3e3e3e3e3';
  v_id   uuid;
BEGIN
  ASSERT (SELECT count(*) FROM public.competitor_watchlist
           WHERE user_id = u_down AND is_active) = 8,
    'S12b the entries above the new limit are all still there';

  -- A NEW activation is refused.
  BEGIN
    PERFORM public.add_competitor_watchlist('down_comp_9');
    RAISE EXCEPTION 'S12b failed: a new activation above the limit was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN check_violation THEN
    ASSERT SQLERRM LIKE 'COMPETITOR_QUOTA_EXCEEDED:%',
      'S12b the new activation is refused with the typed quota code';
  END;

  -- A label edit is accepted.
  SELECT id INTO v_id FROM public.competitor_watchlist
   WHERE user_id = u_down AND username = 'down_comp_1';
  PERFORM public.update_competitor_watchlist(v_id, 'Still editable after the downgrade', NULL);
  ASSERT (SELECT label FROM public.competitor_watchlist WHERE id = v_id)
           = 'Still editable after the downgrade',
    'S12b a label edit is accepted above the limit';

  -- A removal is accepted, and the history survives it.
  PERFORM public.update_competitor_watchlist(v_id, NULL, false);
  ASSERT (SELECT count(*) FROM public.competitor_watchlist
           WHERE user_id = u_down AND username = 'down_comp_1' AND is_active) = 0,
    'S12b the removal above the limit is accepted';
END
$s12b$;

RESET ROLE;

-- The history of the removed entry is retained, and its reactivation is
-- refused while the owner is still above the limit.
SET LOCAL ROLE service_role;

DO $s12c$
DECLARE
  u_down uuid := 'e3e3e3e3-e3e3-4e3e-8e3e-e3e3e3e3e3e3';
  v_id   uuid;
BEGIN
  SELECT id INTO v_id FROM public.competitor_watchlist
   WHERE user_id = u_down AND username = 'down_comp_1';

  INSERT INTO public.competitor_profile_snapshots
    (watchlist_id, user_id, captured_on, followers_count, media_count, source, status)
  VALUES (v_id, u_down, '2026-10-26', 321, 9, 'official', 'ok');

  ASSERT (SELECT count(*) FROM public.competitor_profile_snapshots
           WHERE watchlist_id = v_id) = 1,
    'S12c the history of a removed entry is retained';

  -- The service role may not reactivate it either: the limit applies to
  -- every writer.
  BEGIN
    UPDATE public.competitor_watchlist SET is_active = true, removed_at = NULL WHERE id = v_id;
    RAISE EXCEPTION 'S12c failed: a reactivation above the limit was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN check_violation THEN
    ASSERT SQLERRM LIKE 'COMPETITOR_QUOTA_EXCEEDED:%',
      'S12c the reactivation is refused with the typed quota code';
  END;

  ASSERT (SELECT is_active FROM public.competitor_watchlist WHERE id = v_id) = false,
    'S12c the refused reactivation left the entry inactive';
END
$s12c$;

RESET ROLE;

-- ===========================================================================
-- S13 - cascade safety, and the optional post reference.
-- ===========================================================================

-- Deleting a post nulls only the optional reference: the snapshot and its
-- owner survive.
SET LOCAL ROLE service_role;

DO $s13$
DECLARE
  post_a uuid := 'a5a5a5a5-a5a5-4a5a-8a5a-a5a5a5a5a5a5';
  u_a    uuid := 'a3a3a3a3-a3a3-4a3a-8a3a-a3a3a3a3a3a3';
BEGIN
  ASSERT (SELECT confdeltype FROM pg_constraint
           WHERE conname = 'ig_media_insight_snapshots_post_owner_fkey') = 'n',
    'S13 the post link deletes by setting only post_id null';
  ASSERT (SELECT confdeltype FROM pg_constraint
           WHERE conname = 'ig_media_insight_snapshots_account_owner_fkey') = 'c',
    'S13 the account ownership key cascades';
  ASSERT (SELECT confdeltype FROM pg_constraint
           WHERE conname = 'competitor_profile_snapshots_owner_fkey') = 'c',
    'S13 the competitor profile ownership key cascades';
  ASSERT (SELECT confdeltype FROM pg_constraint
           WHERE conname = 'competitor_media_snapshots_owner_fkey') = 'c',
    'S13 the competitor media ownership key cascades';

  DELETE FROM public.posts WHERE id = post_a;

  ASSERT (SELECT count(*) FROM public.ig_media_insight_snapshots
           WHERE user_id = u_a AND ig_media_id = 'ig-itk-media-1') = 2,
    'S13 deleting the post keeps the media snapshots';
  ASSERT (SELECT count(*) FROM public.ig_media_insight_snapshots
           WHERE user_id = u_a AND ig_media_id = 'ig-itk-media-1' AND post_id IS NULL) = 2,
    'S13 deleting the post nulls only the optional post reference';
  ASSERT (SELECT count(*) FROM public.ig_media_insight_snapshots
           WHERE user_id = u_a AND ig_media_id = 'ig-itk-media-1'
             AND user_id = 'a3a3a3a3-a3a3-4a3a-8a3a-a3a3a3a3a3a3') = 2,
    'S13 the owner column is untouched by the post deletion';
END
$s13$;

-- Deleting the watchlist entry cascades its snapshots.
DO $s13b$
DECLARE
  wl_a uuid := 'a6a6a6a6-a6a6-4a6a-8a6a-a6a6a6a6a6a6';
BEGIN
  DELETE FROM public.competitor_watchlist WHERE id = wl_a;
  ASSERT (SELECT count(*) FROM public.competitor_profile_snapshots WHERE watchlist_id = wl_a) = 0,
    'S13b deleting the watchlist entry cascades its profile snapshots';
  ASSERT (SELECT count(*) FROM public.competitor_media_snapshots WHERE watchlist_id = wl_a) = 0,
    'S13b deleting the watchlist entry cascades its media snapshots';
END
$s13b$;

-- Deleting the social account cascades the owner's snapshots.
DO $s13c$
DECLARE
  acct_a uuid := 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a4a4';
BEGIN
  DELETE FROM public.social_accounts WHERE id = acct_a;
  ASSERT (SELECT count(*) FROM public.ig_media_insight_snapshots WHERE social_account_id = acct_a) = 0,
    'S13c deleting the account cascades the media snapshots';
  ASSERT (SELECT count(*) FROM public.ig_account_insight_daily WHERE social_account_id = acct_a) = 0,
    'S13c deleting the account cascades the account days';
  ASSERT (SELECT count(*) FROM public.ig_account_profile_observations WHERE social_account_id = acct_a) = 0,
    'S13c deleting the account cascades the profile observations';
END
$s13c$;

RESET ROLE;

-- ===========================================================================
-- S14 - a parent's ownership cannot be moved out from under a snapshot.
-- ===========================================================================
SET LOCAL ROLE service_role;

DO $s14$
DECLARE
  acct_b uuid := 'b4b4b4b4-b4b4-4b4b-8b4b-b4b4b4b4b4b4';
  post_b uuid := 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b5b5';
BEGIN
  -- Re-parenting an account that has snapshots is refused, not cascaded.
  BEGIN
    UPDATE public.social_accounts
       SET user_id = 'a3a3a3a3-a3a3-4a3a-8a3a-a3a3a3a3a3a3'
     WHERE id = acct_b;
    RAISE EXCEPTION 'S14 failed: an account was re-parented under its snapshots'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN foreign_key_violation THEN
    ASSERT SQLSTATE = '23503',
      'S14 re-parenting an account is a foreign-key refusal, got ' || SQLSTATE || ' ' || SQLERRM;
  END;

  ASSERT (SELECT user_id FROM public.social_accounts WHERE id = acct_b)
           = 'b3b3b3b3-b3b3-4b3b-8b3b-b3b3b3b3b3b3',
    'S14 the account kept its owner';

  -- The same for a post that is still referenced. Owner B's media gets a
  -- published link first, so the snapshot really does reference the post.
  INSERT INTO public.platform_posts
    (post_id, social_account_id, platform, platform_post_id, status)
  VALUES (post_b, acct_b, 'instagram', 'ig-itk-media-b', 'success');

  UPDATE public.ig_media_insight_snapshots
     SET post_id = post_b, ig_media_id = 'ig-itk-media-b'
   WHERE user_id = 'b3b3b3b3-b3b3-4b3b-8b3b-b3b3b3b3b3b3'
     AND ig_media_id = 'ig-itk-media-b';

  BEGIN
    UPDATE public.posts
       SET user_id = 'a3a3a3a3-a3a3-4a3a-8a3a-a3a3a3a3a3a3'
     WHERE id = post_b;
    RAISE EXCEPTION 'S14 failed: a post was re-parented under its snapshots'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN foreign_key_violation THEN
    ASSERT SQLSTATE = '23503',
      'S14 re-parenting a post is a foreign-key refusal, got ' || SQLSTATE || ' ' || SQLERRM;
  END;

  ASSERT (SELECT user_id FROM public.posts WHERE id = post_b)
           = 'b3b3b3b3-b3b3-4b3b-8b3b-b3b3b3b3b3b3',
    'S14 the post kept its owner';
END
$s14$;

RESET ROLE;

-- ===========================================================================
-- S15 - NULL is not 0.
-- ===========================================================================
SET LOCAL ROLE service_role;

DO $s15$
DECLARE
  u_b     uuid := 'b3b3b3b3-b3b3-4b3b-8b3b-b3b3b3b3b3b3';
  acct_b  uuid := 'b4b4b4b4-b4b4-4b4b-8b4b-b4b4b4b4b4b4';
BEGIN
  -- A metric the provider did not report stays NULL. It is not a zero, and
  -- the row is not a failed capture.
  INSERT INTO public.ig_media_insight_snapshots
    (user_id, social_account_id, ig_media_id, published_at, captured_on,
     views, reach, likes, status)
  VALUES (u_b, acct_b, 'ig-null-metric', now(), current_date, NULL, NULL, NULL, 'ok');

  ASSERT (SELECT views FROM public.ig_media_insight_snapshots
           WHERE ig_media_id = 'ig-null-metric') IS NULL,
    'S15 an unreported metric stays null';
  ASSERT (SELECT views IS NULL FROM public.ig_media_insight_snapshots
           WHERE ig_media_id = 'ig-null-metric') = true,
    'S15 an unreported metric is null, not zero';
  ASSERT (SELECT status FROM public.ig_media_insight_snapshots
           WHERE ig_media_id = 'ig-null-metric') = 'ok',
    'S15 an unreported metric does not make the capture a failure';

  -- The same for the public competitor counts.
  INSERT INTO public.competitor_media_snapshots
    (watchlist_id, user_id, ig_media_id, captured_on, published_at, source,
     like_count, comments_count, view_count, status)
  VALUES
    ('b6b6b6b6-b6b6-4b6b-8b6b-b6b6b6b6b6b6', u_b, 'ig-null-public',
     current_date, now(), 'official', NULL, NULL, NULL, 'unavailable');

  ASSERT (SELECT like_count FROM public.competitor_media_snapshots
           WHERE ig_media_id = 'ig-null-public') IS NULL,
    'S15 an unreported public count stays null';
  ASSERT (SELECT status FROM public.competitor_media_snapshots
           WHERE ig_media_id = 'ig-null-public') = 'unavailable',
    'S15 an unavailable public count is typed, not zero';
END
$s15$;

RESET ROLE;

-- Deleting the owner removes the watchlist with it (auth.users cascade).
DO $s16$
DECLARE
  u_b uuid := 'b3b3b3b3-b3b3-4b3b-8b3b-b3b3b3b3b3b3';
BEGIN
  DELETE FROM auth.users WHERE id = u_b;
  ASSERT (SELECT count(*) FROM public.competitor_watchlist WHERE user_id = u_b) = 0,
    'S16 deleting the owner removes their watchlist';
END
$s16$;

ROLLBACK;

\echo '=== instagram_tracking_schema: ALL CHECKS PASSED ==='
