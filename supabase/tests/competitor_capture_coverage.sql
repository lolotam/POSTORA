-- ============================================================================
-- supabase/tests/competitor_capture_coverage.sql
-- Task 8 / M1 (migration 20261030100000_competitor_capture_coverage.sql).
--
-- One transaction, synthetic fixtures, labelled ASSERTs, expected refusals in
-- nested BEGIN/EXCEPTION blocks, ROLLBACK, sentinel last. Fixture values are
-- synthetic ('...@example.invalid'); no secrets and no real accounts.
--
-- What this suite proves
--   C1  the grant surface: the v2 writer is service-role only, it is
--       SECURITY DEFINER with a fixed search_path, no browser role can
--       execute it, the v1 writer is still callable and unchanged, and the
--       coverage table is owner-readable and service-writable.
--   C2  a valid same-owner capture writes the profile snapshot, the media
--       snapshots AND the coverage row - in one transaction, with exactly
--       the evidence that was submitted.
--   C3  the fences: a forged claim token, a forged generation, an expired
--       lease, a removed target, a foreign job and a forged owner are each
--       refused, and NONE of them leaves a coverage row behind.
--   C4  the malformed refusals: a missing coverage object, a malformed
--       instant, an inverted capture window, a missing instant, a
--       non-boolean flag, an unknown key, an unknown gap reason, an
--       inconsistent gap/exhausted pair, a truncated capture without a gap
--       and a coverage on a FAILED outcome are all refused, with no partial
--       write of any kind.
--   C5  a same-day replay is idempotent: one coverage row, one profile
--       row, the same media rows, and the freshness stamp unmoved.
--   C6  a forced newer generation supersedes the coverage of that day.
--   C7  a stale worker cannot overwrite the coverage of a newer generation.
--   C8  a legacy v1 capture has UNKNOWN coverage: the v1 writer still
--       works and it stores no coverage row at all.
--   C9  bounded completion is not full inventory: a capped capture finishes
--       its job, advances last_partial_at and PRESERVES the prior
--       last_success_at.
--   C10 the role boundary and the owner read: an ordinary user cannot call
--       the v2 writer, cannot write a coverage row, reads their own
--       coverage and reads NOTHING of another owner.
--
-- The suite SET ROLEs away from superuser where the point of the check is
-- that a client role cannot do something.
-- ============================================================================

\set ON_ERROR_STOP on

BEGIN;

-- ---------------------------------------------------------------------------
-- The rollout fixture.
--
-- R1 (20261030150000_instagram_collection_rollout_controls.sql) made the
-- rollout admission a default-off gate. This suite exercises the v2
-- competitor result write, not the rollout, so it installs an explicit
-- synthetic policy that admits every otherwise eligible target. The
-- transaction rolls back, so nothing survives the suite.
-- ---------------------------------------------------------------------------
INSERT INTO public.app_settings (key, value, description)
VALUES
  ('collection_instagram_insights_enabled', 'true'::jsonb,
   'Synthetic harness master switch.'),
  ('collection_instagram_rollout_policy',
   '{"version":1,"owners":{"mode":"all","account_ids":[]},"competitors":{"mode":"all","targets":[]}}'::jsonb,
   'Synthetic harness rollout policy: every otherwise eligible target.')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

-- ---------------------------------------------------------------------------
-- Fixtures. Written as superuser, where RLS does not apply.
--
-- u_a / u_b   : two owners
-- viewer_a    : owner A's page-linked viewer with a read-ok capability
-- ccc_main    : the official capture target
-- ccc_bounds  : the fence target
-- ccc_bounds2 : the malformed-payload target
-- ccc_replay  : the replay / generation target
-- ccc_partial : the capped capture target
-- ccc_legacy  : the v1 target
-- ccc_b       : owner B's target
-- ---------------------------------------------------------------------------
DO $fixtures$
DECLARE
  u_a         uuid := 'ce000000-0000-4000-8000-000000000001';
  u_b         uuid := 'ce000000-0000-4000-8000-000000000002';
  viewer_a    uuid := 'ce100000-0000-4000-8000-000000000001';
  ccc_main    uuid := 'ce200000-0000-4000-8000-000000000001';
  ccc_bounds  uuid := 'ce200000-0000-4000-8000-000000000002';
  ccc_bounds2 uuid := 'ce200000-0000-4000-8000-000000000003';
  ccc_replay  uuid := 'ce200000-0000-4000-8000-000000000004';
  ccc_partial uuid := 'ce200000-0000-4000-8000-000000000005';
  ccc_legacy  uuid := 'ce200000-0000-4000-8000-000000000006';
  ccc_b       uuid := 'ce200000-0000-4000-8000-000000000007';
BEGIN
  INSERT INTO auth.users (id, email)
  VALUES
    (u_a, 'ccc-owner-a-' || u_a::text || '@example.invalid'),
    (u_b, 'ccc-owner-b-' || u_b::text || '@example.invalid');

  INSERT INTO public.social_accounts
    (id, user_id, platform, platform_user_id, platform_username,
     access_token, ig_auth_type)
  VALUES
    (viewer_a, u_a, 'instagram', 'ig-ccc-viewer', 'ccc_viewer', 'token-viewer', 'facebook_page');

  INSERT INTO public.instagram_account_capabilities
    (social_account_id, user_id, platform, login_kind, permission_read_state,
     granted_scopes, scopes_read_at, credential_generation)
  VALUES
    (viewer_a, u_a, 'instagram', 'page_linked', 'ok',
     ARRAY['instagram_basic', 'instagram_manage_insights', 'pages_read_engagement'],
     now(), 3);

  -- The tracked entries. The owner tracks more than the free plan allows,
  -- so the quota is unlimited for this synthetic owner only.
  INSERT INTO public.user_quotas (user_id, max_tracked_competitors)
  VALUES (u_a, -1)
  ON CONFLICT (user_id) DO UPDATE SET max_tracked_competitors = -1;

  INSERT INTO public.competitor_watchlist (id, user_id, platform, username)
  VALUES
    (ccc_main,    u_a, 'instagram', 'ccc_main'),
    (ccc_bounds,  u_a, 'instagram', 'ccc_bounds'),
    (ccc_bounds2, u_a, 'instagram', 'ccc_bounds2'),
    (ccc_replay,  u_a, 'instagram', 'ccc_replay'),
    (ccc_partial, u_a, 'instagram', 'ccc_partial'),
    (ccc_legacy,  u_a, 'instagram', 'ccc_legacy'),
    (ccc_b,       u_b, 'instagram', 'ccc_b');
END
$fixtures$;

-- The service role, for the service-only functions.
SELECT set_config('request.jwt.claim.role', 'service_role', true);

-- ---------------------------------------------------------------------------
-- Helpers.
-- ---------------------------------------------------------------------------

-- Enqueue one competitor job for an owned watchlist entry.
CREATE OR REPLACE FUNCTION pg_temp.ccc_enqueue(p_owner uuid, p_watchlist uuid)
RETURNS uuid
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_result jsonb;
BEGIN
  SELECT public.enqueue_instagram_collection_jobs_service(
    p_owner,
    jsonb_build_array(jsonb_build_object(
      'target_kind', 'competitor',
      'target_id', p_watchlist::text,
      'mode', 'normal'))) INTO v_result;

  RETURN (v_result -> 'results' -> 0 ->> 'job_id')::uuid;
END;
$fn$;

-- Claim the work of one watchlist entry and return its claim context.
CREATE OR REPLACE FUNCTION pg_temp.ccc_claim(p_watchlist uuid)
RETURNS TABLE(job_id uuid, token uuid, generation bigint)
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_claim jsonb;
BEGIN
  SELECT c INTO v_claim
    FROM public.claim_instagram_collection_jobs('competitor', 50) AS c
   WHERE c ->> 'watchlist_id' = p_watchlist::text;

  IF v_claim IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY SELECT
    (v_claim ->> 'job_id')::uuid,
    (v_claim ->> 'claim_token')::uuid,
    (v_claim ->> 'job_generation')::bigint;
END;
$fn$;

-- Whether the PUBLIC pseudo-role may execute a function. PUBLIC is not a
-- role name, so the ACL is inspected directly.
CREATE OR REPLACE FUNCTION pg_temp.ccc_public_can_execute(p_signature text)
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

-- A successful payload. The coverage is the evidence a provider produced
-- about the target's feed: the walk started, the walk ended, the feed was
-- exhausted, nothing was capped and the provider's order is NOT a verified
-- contract.
CREATE OR REPLACE FUNCTION pg_temp.ccc_payload(
  p_source   text  DEFAULT 'apify',
  p_media    jsonb DEFAULT NULL,
  p_coverage jsonb DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_media    jsonb;
  v_coverage jsonb;
BEGIN
  v_media := COALESCE(p_media, jsonb_build_array(
    jsonb_build_object(
      'ig_media_id', 'ccc-media-1',
      'media_product_type', 'REELS',
      'media_type', 'VIDEO',
      'published_at', '2026-10-28T12:00:00Z',
      'metrics', jsonb_build_object(
        'like_count', 1500, 'comments_count', 45, 'view_count', 12000)),
    jsonb_build_object(
      'ig_media_id', 'ccc-media-2',
      'media_product_type', 'FEED',
      'media_type', 'IMAGE',
      'published_at', '2026-10-27T12:00:00Z',
      'metrics', jsonb_build_object(
        'like_count', NULL, 'comments_count', 3, 'view_count', NULL))
  ));

  v_coverage := COALESCE(p_coverage, jsonb_build_object(
    'capture_started_at', '2026-10-30T02:00:00Z',
    'capture_ended_at',   '2026-10-30T02:00:05Z',
    'oldest_returned_at', '2026-10-27T12:00:00Z',
    'ordering_verified',  false,
    'cursor_present',     false,
    'exhausted',          true,
    'truncated',          false,
    'gap_reason',         NULL
  ));

  RETURN jsonb_build_object(
    'outcome',  'completed',
    'source',   p_source,
    'profile',  jsonb_build_object('metrics', jsonb_build_object(
      'followers_count', 54200, 'media_count', 120)),
    'media',    v_media,
    'coverage', v_coverage);
END;
$fn$;

-- The coverage of a capped capture: the feed was NOT exhausted, the media
-- window was capped and the gap names the cap.
CREATE OR REPLACE FUNCTION pg_temp.ccc_capped_coverage()
RETURNS jsonb
LANGUAGE sql
AS $fn$
  SELECT jsonb_build_object(
    'capture_started_at', '2026-10-30T02:00:00Z',
    'capture_ended_at',   '2026-10-30T02:00:05Z',
    'oldest_returned_at', '2026-10-29T12:00:00Z',
    'ordering_verified',  false,
    'cursor_present',     true,
    'exhausted',          false,
    'truncated',          true,
    'gap_reason',         'media_cap_reached'
  );
$fn$;

-- ===========================================================================
-- C1 - the grant surface.
-- ===========================================================================
DO $c1$
DECLARE
  v_v2 TEXT := 'persist_competitor_collection_result_v2(uuid,uuid,bigint,jsonb)';
  v_v1 TEXT := 'persist_competitor_collection_result(uuid,uuid,bigint,jsonb)';
  v_def TEXT;
  v_owner_qual TEXT;
  v_saved_search_path TEXT;
BEGIN
  -- The v2 writer.
  ASSERT has_function_privilege('service_role', 'public.' || v_v2, 'EXECUTE'),
    'C1 the service role can execute the v2 writer';
  ASSERT NOT has_function_privilege('anon', 'public.' || v_v2, 'EXECUTE'),
    'C1 anon cannot execute the v2 writer';
  ASSERT NOT has_function_privilege('authenticated', 'public.' || v_v2, 'EXECUTE'),
    'C1 authenticated cannot execute the v2 writer';
  ASSERT NOT pg_temp.ccc_public_can_execute(v_v2),
    'C1 PUBLIC cannot execute the v2 writer';

  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc AS p
    JOIN pg_namespace AS n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'persist_competitor_collection_result_v2';

  ASSERT v_def ILIKE '%SECURITY DEFINER%',
    'C1 the v2 writer is SECURITY DEFINER';
  ASSERT v_def ILIKE '%SET search_path TO%''public''%''pg_temp''%',
    'C1 the v2 writer has a fixed search_path';

  -- The v1 writer is UNCHANGED and still callable: the v2 writer is a
  -- separate function, not a replacement.
  ASSERT has_function_privilege('service_role', 'public.' || v_v1, 'EXECUTE'),
    'C1 the service role can still execute the v1 writer';
  ASSERT NOT has_function_privilege('authenticated', 'public.' || v_v1, 'EXECUTE'),
    'C1 authenticated still cannot execute the v1 writer';

  -- The coverage table: owner reads their own rows, the service role
  -- writes, no browser role writes.
  ASSERT has_table_privilege('authenticated', 'public.competitor_capture_coverage', 'SELECT'),
    'C1 the owner role can read the coverage';
  ASSERT NOT has_table_privilege('anon', 'public.competitor_capture_coverage', 'SELECT'),
    'C1 anon cannot read the coverage';
  ASSERT NOT has_table_privilege('authenticated', 'public.competitor_capture_coverage', 'INSERT'),
    'C1 the owner role cannot write the coverage';
  ASSERT NOT has_table_privilege('anon', 'public.competitor_capture_coverage', 'INSERT'),
    'C1 anon cannot write the coverage';
  ASSERT has_table_privilege('service_role', 'public.competitor_capture_coverage', 'INSERT'),
    'C1 the service role can write the coverage';

  -- The owner-read policy is the accepted one.
  --
  -- pg_get_expr schema-qualifies auth.uid() only when auth is NOT on the
  -- search_path, and supabase_admin's path includes auth: the same policy
  -- prints (uid() = user_id) there and (auth.uid() = user_id) when auth is
  -- hidden. The predicate is therefore read under pg_catalog, where the
  -- qualification is stable.
  v_saved_search_path := current_setting('search_path');
  BEGIN
    PERFORM pg_catalog.set_config('search_path', 'pg_catalog', true);
    SELECT pg_catalog.pg_get_expr(p.polqual, p.polrelid)
      INTO v_owner_qual
      FROM pg_catalog.pg_policy p
      JOIN pg_catalog.pg_class c ON c.oid = p.polrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'competitor_capture_coverage'
       AND p.polname = 'Owners can read their own rows';
    PERFORM pg_catalog.set_config('search_path', v_saved_search_path, true);
  EXCEPTION WHEN OTHERS THEN
    PERFORM pg_catalog.set_config('search_path', v_saved_search_path, true);
    RAISE;
  END;

  ASSERT v_owner_qual = '(auth.uid() = user_id)',
    'C1 the coverage carries the owner-read policy (canonical qual '
      || coalesce(v_owner_qual, '<null>') || ')';

  ASSERT (SELECT cmd FROM pg_catalog.pg_policies
           WHERE schemaname = 'public'
             AND tablename = 'competitor_capture_coverage'
             AND policyname = 'Owners can read their own rows') = 'SELECT',
    'C1 the owner-read policy is a SELECT';

  ASSERT (SELECT roles FROM pg_catalog.pg_policies
           WHERE schemaname = 'public'
             AND tablename = 'competitor_capture_coverage'
             AND policyname = 'Owners can read their own rows') = '{authenticated}',
    'C1 the owner-read policy is scoped to authenticated';

  ASSERT current_setting('search_path') = v_saved_search_path,
    'C1 the search_path was restored after the policy deparse';
END
$c1$;

-- ===========================================================================
-- C2 - a valid same-owner capture writes the profile, the media and the
--      coverage atomically.
-- ===========================================================================
DO $c2$
DECLARE
  v_watchlist uuid := 'ce200000-0000-4000-8000-000000000001';
  v_job       uuid;
  v_claim     RECORD;
  v_result    jsonb;
  v_coverage  RECORD;
BEGIN
  v_job := pg_temp.ccc_enqueue('ce000000-0000-4000-8000-000000000001', v_watchlist);
  ASSERT v_job IS NOT NULL, 'C2 the job was enqueued';

  SELECT * INTO v_claim FROM pg_temp.ccc_claim(v_watchlist);
  ASSERT FOUND, 'C2 the job was claimed';

  -- The viewer is bound before the provider call, as the accepted contract
  -- requires for an official result.
  PERFORM public.attach_instagram_collection_job_viewer_context(
    v_claim.job_id, v_claim.token, v_claim.generation,
    'ce100000-0000-4000-8000-000000000001');

  v_result := public.persist_competitor_collection_result_v2(
    v_claim.job_id, v_claim.token, v_claim.generation,
    pg_temp.ccc_payload('official'));

  ASSERT v_result ->> 'version' = '2',
    'C2 the receipt is version 2';
  ASSERT v_result ->> 'outcome' = 'completed',
    'C2 the capture completed';
  ASSERT v_result ->> 'source' = 'official',
    'C2 the capture is filed as official';
  ASSERT (v_result ->> 'written')::integer = 3,
    'C2 one profile and two media rows were written';

  -- The snapshots.
  ASSERT (SELECT count(*) = 1 FROM public.competitor_profile_snapshots
           WHERE watchlist_id = v_watchlist),
    'C2 exactly one profile snapshot exists';
  ASSERT (SELECT count(*) = 2 FROM public.competitor_media_snapshots
           WHERE watchlist_id = v_watchlist),
    'C2 exactly two media snapshots exist';
  ASSERT (SELECT source FROM public.competitor_profile_snapshots
           WHERE watchlist_id = v_watchlist) = 'official',
    'C2 the profile snapshot carries the verified source';

  -- The coverage row: exactly the evidence that was submitted.
  ASSERT (SELECT count(*) = 1 FROM public.competitor_capture_coverage
           WHERE watchlist_id = v_watchlist),
    'C2 exactly one coverage row exists';

  SELECT c.* INTO v_coverage
    FROM public.competitor_capture_coverage AS c
   WHERE c.watchlist_id = v_watchlist;

  ASSERT v_coverage.user_id = 'ce000000-0000-4000-8000-000000000001',
    'C2 the coverage is owned by the capturing owner';
  ASSERT v_coverage.source = 'official',
    'C2 the coverage carries the verified source';
  ASSERT v_coverage.job_generation = v_claim.generation,
    'C2 the coverage carries the job generation';
  ASSERT v_coverage.capture_started_at = '2026-10-30T02:00:00Z',
    'C2 the coverage carries the capture start';
  ASSERT v_coverage.capture_ended_at = '2026-10-30T02:00:05Z',
    'C2 the coverage carries the capture end';
  ASSERT v_coverage.oldest_returned_at = '2026-10-27T12:00:00Z',
    'C2 the coverage carries the oldest returned instant';
  ASSERT v_coverage.ordering_verified = false,
    'C2 an unverified provider order stays unverified';
  ASSERT v_coverage.cursor_present = false,
    'C2 the coverage carries the cursor flag';
  ASSERT v_coverage.exhausted = true,
    'C2 the coverage carries the exhausted flag';
  ASSERT v_coverage.truncated = false,
    'C2 the coverage carries the truncated flag';
  ASSERT v_coverage.gap_reason IS NULL,
    'C2 an exhausted capture has no gap';

  -- The receipt reports the stored coverage.
  ASSERT (v_result -> 'coverage' ->> 'exhausted')::boolean = true,
    'C2 the receipt carries the stored coverage';
  ASSERT (v_result -> 'coverage' ->> 'inventory_complete')::boolean = true,
    'C2 the receipt reports a complete inventory';
  ASSERT (v_result -> 'coverage' ->> 'ordering_verified')::boolean = false,
    'C2 the receipt does not claim a verified order';

  -- The receipt renders the instants in ONE canonical UTC form, so the
  -- caller can compare them with what it submitted whatever the session's
  -- DateStyle and TimeZone are.
  ASSERT (v_result -> 'coverage' ->> 'capture_started_at') = '2026-10-30T02:00:00.000Z',
    'C2 the receipt renders the capture start canonically';
  ASSERT (v_result -> 'coverage' ->> 'capture_ended_at') = '2026-10-30T02:00:05.000Z',
    'C2 the receipt renders the capture end canonically';
  ASSERT (v_result -> 'coverage' ->> 'oldest_returned_at') = '2026-10-27T12:00:00.000Z',
    'C2 the receipt renders the oldest returned instant canonically';
  ASSERT (v_result ->> 'captured_at') ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$',
    'C2 the receipt renders the capture instant canonically';

  -- The job and the watchlist.
  ASSERT (SELECT status FROM public.instagram_collection_jobs WHERE id = v_claim.job_id) = 'completed',
    'C2 the job completed';
  ASSERT (SELECT last_success_at FROM public.instagram_collection_jobs WHERE id = v_claim.job_id)
           IS NOT NULL,
    'C2 a complete inventory advanced the success stamp';
  ASSERT (SELECT last_partial_at FROM public.instagram_collection_jobs WHERE id = v_claim.job_id)
           IS NULL,
    'C2 a complete inventory did not advance the partial stamp';
  ASSERT (SELECT status FROM public.competitor_watchlist WHERE id = v_watchlist) = 'ok',
    'C2 the entry is published as ok';
END
$c2$;

-- ===========================================================================
-- C3 - the fences.
-- ===========================================================================
DO $c3$
DECLARE
  v_watchlist uuid := 'ce200000-0000-4000-8000-000000000002';
  v_job       uuid;
  v_claim     RECORD;
BEGIN
  v_job := pg_temp.ccc_enqueue('ce000000-0000-4000-8000-000000000001', v_watchlist);
  SELECT * INTO v_claim FROM pg_temp.ccc_claim(v_watchlist);
  ASSERT FOUND, 'C3 the job was claimed';

  -- A forged claim token.
  BEGIN
    PERFORM public.persist_competitor_collection_result_v2(
      v_claim.job_id, gen_random_uuid(), v_claim.generation, pg_temp.ccc_payload());
    RAISE EXCEPTION 'C3 failed: a forged claim token was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT LIKE '%IG_COLLECTION_CLAIM_STALE%' THEN
      RAISE EXCEPTION 'C3 expected IG_COLLECTION_CLAIM_STALE, got: %', SQLERRM;
    END IF;
  END;

  -- A forged generation.
  BEGIN
    PERFORM public.persist_competitor_collection_result_v2(
      v_claim.job_id, v_claim.token, v_claim.generation + 1, pg_temp.ccc_payload());
    RAISE EXCEPTION 'C3 failed: a forged generation was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT LIKE '%IG_COLLECTION_CLAIM_STALE%' THEN
      RAISE EXCEPTION 'C3 expected IG_COLLECTION_CLAIM_STALE, got: %', SQLERRM;
    END IF;
  END;

  -- An expired lease.
  UPDATE public.instagram_collection_jobs
     SET lease_expires_at = clock_timestamp() - interval '1 second'
   WHERE id = v_claim.job_id;

  BEGIN
    PERFORM public.persist_competitor_collection_result_v2(
      v_claim.job_id, v_claim.token, v_claim.generation, pg_temp.ccc_payload());
    RAISE EXCEPTION 'C3 failed: an expired lease was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT LIKE '%IG_COLLECTION_CLAIM_STALE%' THEN
      RAISE EXCEPTION 'C3 expected IG_COLLECTION_CLAIM_STALE, got: %', SQLERRM;
    END IF;
  END;

  -- A removed target.
  UPDATE public.instagram_collection_jobs
     SET lease_expires_at = clock_timestamp() + interval '120 seconds'
   WHERE id = v_claim.job_id;

  UPDATE public.competitor_watchlist
     SET is_active = false, removed_at = now()
   WHERE id = v_watchlist;

  BEGIN
    PERFORM public.persist_competitor_collection_result_v2(
      v_claim.job_id, v_claim.token, v_claim.generation, pg_temp.ccc_payload());
    RAISE EXCEPTION 'C3 failed: a removed target was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT LIKE '%IG_COLLECTION_TARGET_INACTIVE%' THEN
      RAISE EXCEPTION 'C3 expected IG_COLLECTION_TARGET_INACTIVE, got: %', SQLERRM;
    END IF;
  END;

  -- A foreign job.
  BEGIN
    PERFORM public.persist_competitor_collection_result_v2(
      gen_random_uuid(), v_claim.token, v_claim.generation, pg_temp.ccc_payload());
    RAISE EXCEPTION 'C3 failed: a foreign job was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT LIKE '%IG_COLLECTION_JOB_NOT_FOUND%' THEN
      RAISE EXCEPTION 'C3 expected IG_COLLECTION_JOB_NOT_FOUND, got: %', SQLERRM;
    END IF;
  END;

  -- A forged owner: the payload may not carry one.
  BEGIN
    PERFORM public.persist_competitor_collection_result_v2(
      v_claim.job_id, v_claim.token, v_claim.generation,
      pg_temp.ccc_payload() || jsonb_build_object('user_id', 'x'));
    RAISE EXCEPTION 'C3 failed: a payload with an owner was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT LIKE '%IG_COMPETITOR_RESULT_INVALID%' THEN
      RAISE EXCEPTION 'C3 expected IG_COMPETITOR_RESULT_INVALID, got: %', SQLERRM;
    END IF;
  END;

  -- NONE of the refusals left anything behind.
  ASSERT (SELECT count(*) = 0 FROM public.competitor_capture_coverage
           WHERE watchlist_id = v_watchlist),
    'C3 a refused write left no coverage row';
  ASSERT (SELECT count(*) = 0 FROM public.competitor_profile_snapshots
           WHERE watchlist_id = v_watchlist),
    'C3 a refused write left no profile row';
  ASSERT (SELECT count(*) = 0 FROM public.competitor_media_snapshots
           WHERE watchlist_id = v_watchlist),
    'C3 a refused write left no media row';
  ASSERT (SELECT last_success_at FROM public.instagram_collection_jobs WHERE id = v_claim.job_id)
           IS NULL,
    'C3 a refused write advanced no success stamp';
END
$c3$;

-- ===========================================================================
-- C4 - the malformed refusals. None of them writes anything.
-- ===========================================================================
DO $c4$
DECLARE
  v_watchlist uuid := 'ce200000-0000-4000-8000-000000000003';
  v_job       uuid;
  v_claim     RECORD;
  v_cases     jsonb;
  v_case      jsonb;
  v_label     text;
  v_marker    text;
  v_payload   jsonb;
  v_raised    boolean;
  v_message   text;
BEGIN
  v_job := pg_temp.ccc_enqueue('ce000000-0000-4000-8000-000000000001', v_watchlist);
  SELECT * INTO v_claim FROM pg_temp.ccc_claim(v_watchlist);
  ASSERT FOUND, 'C4 the job was claimed';

  v_cases := jsonb_build_array(
    jsonb_build_object(
      'label', 'a capture without coverage',
      'marker', 'IG_COMPETITOR_COVERAGE_INVALID',
      'payload', pg_temp.ccc_payload() - 'coverage'),
    jsonb_build_object(
      'label', 'a malformed capture start',
      'marker', 'IG_COMPETITOR_COVERAGE_INVALID',
      'payload', pg_temp.ccc_payload('apify', NULL,
        (pg_temp.ccc_payload() -> 'coverage')
          || jsonb_build_object('capture_started_at', 'not-a-timestamp'))),
    jsonb_build_object(
      'label', 'an inverted capture window',
      'marker', 'IG_COMPETITOR_COVERAGE_INVALID',
      'payload', pg_temp.ccc_payload('apify', NULL,
        (pg_temp.ccc_payload() -> 'coverage')
          || jsonb_build_object(
               'capture_started_at', '2026-10-30T03:00:00Z',
               'capture_ended_at',   '2026-10-30T02:00:00Z'))),
    jsonb_build_object(
      'label', 'a missing capture end',
      'marker', 'IG_COMPETITOR_COVERAGE_INVALID',
      'payload', pg_temp.ccc_payload('apify', NULL,
        (pg_temp.ccc_payload() -> 'coverage') - 'capture_ended_at')),
    jsonb_build_object(
      'label', 'a non-boolean ordering flag',
      'marker', 'IG_COMPETITOR_COVERAGE_INVALID',
      'payload', pg_temp.ccc_payload('apify', NULL,
        (pg_temp.ccc_payload() -> 'coverage')
          || jsonb_build_object('ordering_verified', 'yes'))),
    jsonb_build_object(
      'label', 'a non-boolean cursor flag',
      'marker', 'IG_COMPETITOR_COVERAGE_INVALID',
      'payload', pg_temp.ccc_payload('apify', NULL,
        (pg_temp.ccc_payload() -> 'coverage')
          || jsonb_build_object('cursor_present', 'maybe'))),
    jsonb_build_object(
      'label', 'an unknown coverage key',
      'marker', 'IG_COMPETITOR_COVERAGE_INVALID',
      'payload', pg_temp.ccc_payload('apify', NULL,
        (pg_temp.ccc_payload() -> 'coverage')
          || jsonb_build_object('cursor', 'secret'))),
    jsonb_build_object(
      'label', 'an unknown gap reason',
      'marker', 'IG_COMPETITOR_COVERAGE_INVALID',
      'payload', pg_temp.ccc_payload('apify', NULL,
        (pg_temp.ccc_payload() -> 'coverage')
          || jsonb_build_object(
               'exhausted', false, 'truncated', true, 'gap_reason', 'because'))),
    jsonb_build_object(
      'label', 'an exhausted capture with a gap',
      'marker', 'IG_COMPETITOR_COVERAGE_INVALID',
      'payload', pg_temp.ccc_payload('apify', NULL,
        (pg_temp.ccc_payload() -> 'coverage')
          || jsonb_build_object('gap_reason', 'cursor_loop'))),
    jsonb_build_object(
      'label', 'a truncated capture without a gap',
      'marker', 'IG_COMPETITOR_COVERAGE_INVALID',
      'payload', pg_temp.ccc_payload('apify', NULL,
        (pg_temp.ccc_payload() -> 'coverage')
          || jsonb_build_object(
               'exhausted', false, 'truncated', true, 'gap_reason', NULL))),
    jsonb_build_object(
      'label', 'a failed outcome with coverage',
      'marker', 'IG_COMPETITOR_COVERAGE_INVALID',
      'payload', jsonb_build_object(
        'outcome', 'retry',
        'reason_code', 'provider_error',
        'coverage', pg_temp.ccc_payload() -> 'coverage')),
    jsonb_build_object(
      'label', 'a malformed media instant',
      'marker', 'IG_COMPETITOR_RESULT_INVALID',
      'payload', pg_temp.ccc_payload('apify',
        jsonb_build_array(jsonb_build_object(
          'ig_media_id', 'ccc-broken',
          'published_at', 'not-a-timestamp',
          'metrics', jsonb_build_object())),
        NULL))
  );

  FOR v_case IN SELECT * FROM jsonb_array_elements(v_cases) LOOP
    v_label   := v_case ->> 'label';
    v_marker  := v_case ->> 'marker';
    v_payload := v_case -> 'payload';
    v_raised  := false;
    v_message := '';

    BEGIN
      PERFORM public.persist_competitor_collection_result_v2(
        v_claim.job_id, v_claim.token, v_claim.generation, v_payload);
    EXCEPTION WHEN others THEN
      v_raised  := true;
      v_message := SQLERRM;
    END;

    ASSERT v_raised, 'C4 ' || v_label || ' was accepted';
    ASSERT v_message LIKE '%' || v_marker || '%',
      'C4 ' || v_label || ': expected ' || v_marker || ', got: ' || v_message;
  END LOOP;

  -- None of the refusals wrote anything.
  ASSERT (SELECT count(*) = 0 FROM public.competitor_capture_coverage
           WHERE watchlist_id = v_watchlist),
    'C4 a refused payload wrote no coverage row';
  ASSERT (SELECT count(*) = 0 FROM public.competitor_profile_snapshots
           WHERE watchlist_id = v_watchlist),
    'C4 a refused payload wrote no profile row';
  ASSERT (SELECT count(*) = 0 FROM public.competitor_media_snapshots
           WHERE watchlist_id = v_watchlist),
    'C4 a refused payload wrote no media row';
  ASSERT (SELECT status FROM public.competitor_watchlist WHERE id = v_watchlist) = 'pending',
    'C4 a refused payload left the entry untouched';
  ASSERT (SELECT status FROM public.instagram_collection_jobs WHERE id = v_claim.job_id) = 'leased',
    'C4 a refused payload left the job leased';
  ASSERT (SELECT last_success_at FROM public.instagram_collection_jobs WHERE id = v_claim.job_id)
           IS NULL,
    'C4 a refused payload advanced no success stamp';
END
$c4$;

-- ===========================================================================
-- C5 - a same-day replay is idempotent.
-- ===========================================================================
DO $c5$
DECLARE
  v_watchlist uuid := 'ce200000-0000-4000-8000-000000000004';
  v_job       uuid;
  v_claim     RECORD;
  v_before    timestamptz;
  v_after     timestamptz;
BEGIN
  v_job := pg_temp.ccc_enqueue('ce000000-0000-4000-8000-000000000001', v_watchlist);
  SELECT * INTO v_claim FROM pg_temp.ccc_claim(v_watchlist);
  ASSERT FOUND, 'C5 the job was claimed';

  PERFORM public.persist_competitor_collection_result_v2(
    v_claim.job_id, v_claim.token, v_claim.generation, pg_temp.ccc_payload());

  -- The whole suite is one transaction, so now() never changes inside it.
  -- A distinct past stamp is seeded first, or "unmoved" would be vacuous.
  UPDATE public.competitor_watchlist
     SET last_synced_at = '2026-01-01T00:00:00Z'
   WHERE id = v_watchlist;

  SELECT last_synced_at INTO v_before
    FROM public.competitor_watchlist WHERE id = v_watchlist;

  -- The SAME claim, replayed. The job is already completed, so the fence
  -- refuses the second write.
  BEGIN
    PERFORM public.persist_competitor_collection_result_v2(
      v_claim.job_id, v_claim.token, v_claim.generation, pg_temp.ccc_payload());
    RAISE EXCEPTION 'C5 failed: a completed job accepted a second write'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT LIKE '%IG_COLLECTION_CLAIM_STALE%' THEN
      RAISE EXCEPTION 'C5 expected IG_COLLECTION_CLAIM_STALE, got: %', SQLERRM;
    END IF;
  END;

  ASSERT (SELECT count(*) = 1 FROM public.competitor_capture_coverage
           WHERE watchlist_id = v_watchlist),
    'C5 the replay wrote no second coverage row';
  ASSERT (SELECT count(*) = 1 FROM public.competitor_profile_snapshots
           WHERE watchlist_id = v_watchlist),
    'C5 the replay wrote no second profile row';
  ASSERT (SELECT count(*) = 2 FROM public.competitor_media_snapshots
           WHERE watchlist_id = v_watchlist),
    'C5 the replay wrote no second media row';

  SELECT last_synced_at INTO v_after
    FROM public.competitor_watchlist WHERE id = v_watchlist;
  ASSERT v_before = v_after,
    'C5 the replay did not move the freshness stamp';
END
$c5$;

-- ===========================================================================
-- C6 - a forced newer generation supersedes the coverage of that day.
-- ===========================================================================
DO $c6$
DECLARE
  v_watchlist uuid := 'ce200000-0000-4000-8000-000000000004';
  v_claim     RECORD;
  v_first_gen bigint;
BEGIN
  SELECT job_generation INTO v_first_gen
    FROM public.competitor_capture_coverage WHERE watchlist_id = v_watchlist;
  ASSERT v_first_gen IS NOT NULL, 'C6 the first coverage was stored';

  -- A forced re-collection of the SAME day. It is a NEW generation.
  PERFORM public.enqueue_instagram_collection_jobs_service(
    'ce000000-0000-4000-8000-000000000001',
    jsonb_build_array(jsonb_build_object(
      'target_kind', 'competitor',
      'target_id', v_watchlist::text,
      'mode', 'force')));

  SELECT * INTO v_claim FROM pg_temp.ccc_claim(v_watchlist);
  ASSERT FOUND, 'C6 the forced job was claimed';
  ASSERT v_claim.generation > v_first_gen,
    'C6 the forced job carries a newer generation';

  -- The forced capture observed a capped feed this time.
  PERFORM public.persist_competitor_collection_result_v2(
    v_claim.job_id, v_claim.token, v_claim.generation,
    pg_temp.ccc_payload('apify', NULL, pg_temp.ccc_capped_coverage()));

  -- ONE coverage row for that day, and it is the newer evidence.
  ASSERT (SELECT count(*) = 1 FROM public.competitor_capture_coverage
           WHERE watchlist_id = v_watchlist),
    'C6 the forced capture did not add a second coverage row';
  ASSERT (SELECT job_generation FROM public.competitor_capture_coverage
           WHERE watchlist_id = v_watchlist) = v_claim.generation,
    'C6 the newer generation superseded the coverage';
  ASSERT (SELECT exhausted FROM public.competitor_capture_coverage
           WHERE watchlist_id = v_watchlist) = false,
    'C6 the superseded coverage carries the new evidence';
  ASSERT (SELECT truncated FROM public.competitor_capture_coverage
           WHERE watchlist_id = v_watchlist) = true,
    'C6 the superseded coverage carries the new truncation';
  ASSERT (SELECT gap_reason FROM public.competitor_capture_coverage
           WHERE watchlist_id = v_watchlist) = 'media_cap_reached',
    'C6 the superseded coverage carries the new gap';

  -- The snapshots of the day are still one row each.
  ASSERT (SELECT count(*) = 1 FROM public.competitor_profile_snapshots
           WHERE watchlist_id = v_watchlist),
    'C6 the forced capture wrote no second profile row';
  ASSERT (SELECT count(*) = 2 FROM public.competitor_media_snapshots
           WHERE watchlist_id = v_watchlist),
    'C6 the forced capture wrote no second media row';
END
$c6$;

-- ===========================================================================
-- C7 - a stale worker cannot overwrite the coverage of a newer generation.
-- ===========================================================================
DO $c7$
DECLARE
  v_watchlist uuid := 'ce200000-0000-4000-8000-000000000004';
  v_claim     RECORD;
  v_job       uuid;
  v_stored    bigint;
  v_gap       text;
BEGIN
  SELECT job_generation, gap_reason
    INTO v_stored, v_gap
    FROM public.competitor_capture_coverage WHERE watchlist_id = v_watchlist;
  ASSERT v_stored IS NOT NULL, 'C7 the coverage of the day is stored';

  -- A stale worker: the OLD generation's claim is refused outright.
  BEGIN
    PERFORM public.persist_competitor_collection_result_v2(
      (SELECT id FROM public.instagram_collection_jobs WHERE watchlist_id = v_watchlist),
      (SELECT lease_token FROM public.instagram_collection_jobs WHERE watchlist_id = v_watchlist),
      v_stored - 1, pg_temp.ccc_payload());
    RAISE EXCEPTION 'C7 failed: a stale generation was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT LIKE '%IG_COLLECTION_CLAIM_STALE%' THEN
      RAISE EXCEPTION 'C7 expected IG_COLLECTION_CLAIM_STALE, got: %', SQLERRM;
    END IF;
  END;

  ASSERT (SELECT job_generation FROM public.competitor_capture_coverage
           WHERE watchlist_id = v_watchlist) = v_stored,
    'C7 the stale worker did not move the coverage generation';
  ASSERT (SELECT gap_reason FROM public.competitor_capture_coverage
           WHERE watchlist_id = v_watchlist) = v_gap,
    'C7 the stale worker did not move the coverage evidence';

  -- The generation guard on the upsert itself: a LIVE claim whose revision
  -- is OLDER than the stored coverage must not replace it, even though the
  -- fence accepts the claim. The job's revision is rolled back under the
  -- live claim to reach that state.
  UPDATE public.instagram_collection_jobs
     SET status = 'queued', lease_token = NULL, lease_expires_at = NULL,
         job_generation = v_stored - 1
   WHERE watchlist_id = v_watchlist;

  SELECT * INTO v_claim FROM pg_temp.ccc_claim(v_watchlist);
  ASSERT FOUND, 'C7 the job was claimed again';

  PERFORM public.persist_competitor_collection_result_v2(
    v_claim.job_id, v_claim.token, v_claim.generation, pg_temp.ccc_payload());

  ASSERT (SELECT job_generation FROM public.competitor_capture_coverage
           WHERE watchlist_id = v_watchlist) = v_stored,
    'C7 an older revision did not overwrite the newer coverage';
  ASSERT (SELECT gap_reason FROM public.competitor_capture_coverage
           WHERE watchlist_id = v_watchlist) = v_gap,
    'C7 an older revision did not overwrite the newer evidence';
END
$c7$;

-- ===========================================================================
-- C8 - a legacy v1 capture has UNKNOWN coverage.
-- ===========================================================================
DO $c8$
DECLARE
  v_watchlist uuid := 'ce200000-0000-4000-8000-000000000006';
  v_job       uuid;
  v_claim     RECORD;
  v_result    jsonb;
BEGIN
  v_job := pg_temp.ccc_enqueue('ce000000-0000-4000-8000-000000000001', v_watchlist);
  SELECT * INTO v_claim FROM pg_temp.ccc_claim(v_watchlist);
  ASSERT FOUND, 'C8 the job was claimed';

  -- The v1 writer, unchanged, with the v1 payload shape: no coverage.
  v_result := public.persist_competitor_collection_result(
    v_claim.job_id, v_claim.token, v_claim.generation,
    jsonb_build_object(
      'outcome', 'completed',
      'source', 'apify',
      'profile', jsonb_build_object('metrics', jsonb_build_object('followers_count', 11)),
      'media', jsonb_build_array(jsonb_build_object(
        'ig_media_id', 'ccc-legacy-1',
        'published_at', '2026-10-28T12:00:00Z',
        'metrics', jsonb_build_object('like_count', 3)))));

  ASSERT v_result ->> 'outcome' = 'completed',
    'C8 the v1 writer still completes a capture';
  ASSERT v_result ->> 'version' IS NULL,
    'C8 the v1 receipt is not a v2 receipt';

  -- The observations exist and the coverage does NOT. The absence means
  -- UNKNOWN: it is never backfilled and never invented.
  ASSERT (SELECT count(*) = 1 FROM public.competitor_profile_snapshots
           WHERE watchlist_id = v_watchlist),
    'C8 the v1 capture stored its profile snapshot';
  ASSERT (SELECT count(*) = 0 FROM public.competitor_capture_coverage
           WHERE watchlist_id = v_watchlist),
    'C8 the v1 capture stored no coverage row';
END
$c8$;

-- ===========================================================================
-- C9 - bounded completion is not full inventory.
-- ===========================================================================
DO $c9$
DECLARE
  v_watchlist uuid := 'ce200000-0000-4000-8000-000000000005';
  v_job       uuid;
  v_claim     RECORD;
  v_success   timestamptz;
BEGIN
  -- A first, COMPLETE capture: the success stamp advances.
  v_job := pg_temp.ccc_enqueue('ce000000-0000-4000-8000-000000000001', v_watchlist);
  SELECT * INTO v_claim FROM pg_temp.ccc_claim(v_watchlist);
  ASSERT FOUND, 'C9 the job was claimed';

  PERFORM public.persist_competitor_collection_result_v2(
    v_claim.job_id, v_claim.token, v_claim.generation, pg_temp.ccc_payload());

  SELECT last_success_at INTO v_success
    FROM public.instagram_collection_jobs WHERE id = v_claim.job_id;
  ASSERT v_success IS NOT NULL, 'C9 the complete capture advanced the success stamp';
  ASSERT (SELECT last_partial_at FROM public.instagram_collection_jobs WHERE id = v_claim.job_id)
           IS NULL,
    'C9 the complete capture did not advance the partial stamp';

  -- The whole suite is one transaction, so now() never changes inside it: a
  -- capped capture that wrongly set last_success_at = now() would still
  -- equal the stamp read above. Seed distinct past stamps so "preserved"
  -- and "advanced" are real comparisons.
  v_success := '2026-01-01T00:00:00Z';
  UPDATE public.instagram_collection_jobs
     SET last_success_at = v_success,
         last_partial_at = '2025-12-01T00:00:00Z'
   WHERE id = v_claim.job_id;

  -- A second, CAPPED capture of the same day. It finishes its bounded job
  -- and it does NOT claim a complete inventory.
  PERFORM public.enqueue_instagram_collection_jobs_service(
    'ce000000-0000-4000-8000-000000000001',
    jsonb_build_array(jsonb_build_object(
      'target_kind', 'competitor',
      'target_id', v_watchlist::text,
      'mode', 'force')));

  SELECT * INTO v_claim FROM pg_temp.ccc_claim(v_watchlist);
  ASSERT FOUND, 'C9 the forced job was claimed';

  PERFORM public.persist_competitor_collection_result_v2(
    v_claim.job_id, v_claim.token, v_claim.generation,
    pg_temp.ccc_payload('apify', NULL, pg_temp.ccc_capped_coverage()));

  -- The bounded job FINISHED: it is not left in a claimable status, so the
  -- same impossible-to-expand window is not retried forever.
  ASSERT (SELECT status FROM public.instagram_collection_jobs WHERE id = v_claim.job_id) = 'completed',
    'C9 the capped capture completed its bounded job';
  ASSERT (SELECT lease_token FROM public.instagram_collection_jobs WHERE id = v_claim.job_id) IS NULL,
    'C9 the capped capture released the lease';
  ASSERT (SELECT status FROM public.instagram_collection_jobs WHERE id = v_claim.job_id)
           NOT IN ('queued', 'retry', 'partial', 'leased'),
    'C9 the capped capture is not left claimable';

  -- The partial stamp advanced and the prior full success is preserved.
  ASSERT (SELECT last_partial_at FROM public.instagram_collection_jobs WHERE id = v_claim.job_id)
           > '2025-12-01T00:00:00Z'::timestamptz,
    'C9 the capped capture advanced the partial stamp';
  ASSERT (SELECT last_success_at FROM public.instagram_collection_jobs WHERE id = v_claim.job_id)
           = v_success,
    'C9 the capped capture preserved the prior full-success time';

  -- The watchlist is still published: the observations are real.
  ASSERT (SELECT status FROM public.competitor_watchlist WHERE id = v_watchlist) = 'ok',
    'C9 the capped capture published the entry';

  -- The stored coverage is the partial evidence.
  ASSERT (SELECT (exhausted AND NOT truncated AND gap_reason IS NULL)
            FROM public.competitor_capture_coverage
           WHERE watchlist_id = v_watchlist) = false,
    'C9 the capped capture is not a complete inventory';
END
$c9$;

-- Another owner's coverage, so the owner read can be proved to be scoped.
INSERT INTO public.competitor_capture_coverage
  (watchlist_id, user_id, captured_on, source, job_generation,
   capture_started_at, capture_ended_at, exhausted, truncated)
VALUES
  ('ce200000-0000-4000-8000-000000000007',
   'ce000000-0000-4000-8000-000000000002',
   (now() AT TIME ZONE 'Asia/Kuwait')::date,
   'official', 1, now(), now(), true, false);

-- ===========================================================================
-- C10 - the role boundary and the owner read.
-- ===========================================================================
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'ce000000-0000-4000-8000-000000000001', true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);

DO $c10$
DECLARE
  v_own integer;
  v_other integer;
BEGIN
  BEGIN
    PERFORM public.persist_competitor_collection_result_v2(
      gen_random_uuid(), gen_random_uuid(), 1, pg_temp.ccc_payload());
    RAISE EXCEPTION 'C10 failed: an ordinary user published a result'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN insufficient_privilege THEN
    ASSERT SQLSTATE = '42501',
      'C10 a privilege refusal is SQLSTATE 42501, got ' || SQLSTATE;
  END;

  -- The owner may READ their own coverage.
  SELECT count(*) INTO v_own
    FROM public.competitor_capture_coverage
   WHERE watchlist_id = 'ce200000-0000-4000-8000-000000000001';
  ASSERT v_own = 1, 'C10 the owner reads their own coverage';

  -- The owner may NOT read another owner's coverage.
  SELECT count(*) INTO v_other
    FROM public.competitor_capture_coverage
   WHERE watchlist_id = 'ce200000-0000-4000-8000-000000000007';
  ASSERT v_other = 0, 'C10 the owner reads nothing of another owner';

  -- The owner may NOT write a coverage row.
  BEGIN
    INSERT INTO public.competitor_capture_coverage
      (watchlist_id, user_id, captured_on, source, job_generation,
       capture_started_at, capture_ended_at, exhausted, truncated)
    VALUES
      ('ce200000-0000-4000-8000-000000000001',
       'ce000000-0000-4000-8000-000000000001',
       (now() AT TIME ZONE 'Asia/Kuwait')::date,
       'official', 1, now(), now(), true, false);
    RAISE EXCEPTION 'C10 failed: the owner wrote a coverage row'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN insufficient_privilege THEN
    ASSERT SQLSTATE = '42501',
      'C10 a privilege refusal is SQLSTATE 42501, got ' || SQLSTATE;
  END;
END
$c10$;

RESET ROLE;

SELECT set_config('request.jwt.claim.role', '', true);
SELECT set_config('request.jwt.claim.sub', '', true);

ROLLBACK;

\echo 'ALL CHECKS PASSED'
