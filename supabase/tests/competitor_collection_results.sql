-- ============================================================================
-- supabase/tests/competitor_collection_results.sql
-- Task 7 prerequisite (migration 20261029150000_competitor_collection_results.sql).
--
-- One transaction, synthetic fixtures, labelled ASSERTs, expected refusals in
-- nested BEGIN/EXCEPTION blocks, ROLLBACK, sentinel last. Fixture values are
-- synthetic ('...@example.invalid'); no secrets and no real accounts.
--
-- What this suite proves
--   C1  the grant surface: both new functions are service-role only, they
--       are SECURITY DEFINER with a fixed search_path, and no browser role
--       can execute them.
--   C2  the due-target read: only active, due entries are returned, the
--       weekly gate excludes the rest, the order is stable, the cursor pages
--       and a mismatched cursor is refused.
--   C3  the official capture: one profile row and the media rows are
--       written with the verified source, the durable operations are
--       recorded, the watchlist is published and the job completes - in one
--       transaction.
--   C4  a replay writes no second row, no second operation and does not
--       move the freshness stamp.
--   C5  the bounds: the payload keys, the media count, the duplicate media
--       id, the required fields and the metric rules are all enforced.
--   C6  a failure with no viewer is recordable: the entry becomes an error,
--       the weekly gate stays closed and the job stays retryable.
--   C7  the confirmed unavailable target: the entry becomes unavailable, the
--       weekly gate opens and the historical capture is untouched.
--   C8  the context rules: an official result needs the trusted live
--       context, an apify result may run without one, and a captured
--       context that moved is refused either way.
--   C9  the fences: a stale token, a wrong generation, an expired lease, a
--       removed target and a foreign job are each refused, and NONE of them
--       leaves a snapshot, a status change or a success timestamp behind.
--   C10 the atomicity: a write that fails half way leaves no profile row,
--       no watchlist publication and no completed job.
--   C11 the role boundary: an ordinary user cannot call either function.
--   C12 the review regressions: missing profile/media keys, the weekly gate
--       reason, a moved context on a failure outcome, and a lease that
--       expires while the writes wait.
--
-- The suite SET ROLEs away from superuser where the point of the check is
-- that a client role cannot do something.
-- ============================================================================

\set ON_ERROR_STOP on

BEGIN;

-- ---------------------------------------------------------------------------
-- The rollout fixture.
--
-- R1 (20261031090000_instagram_collection_rollout_controls.sql) made the
-- rollout admission a default-off gate. This suite exercises the competitor
-- result write, not the rollout, so it installs an explicit synthetic
-- policy that admits every otherwise eligible target. The transaction
-- rolls back, so nothing survives the suite.
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
-- comp_ok     : the official capture target
-- comp_noview : the no-viewer failure target
-- comp_unavail: the confirmed unavailable target
-- comp_apify  : the apify target
-- comp_gated  : an entry inside its weekly window
-- comp_removed: a removed entry
-- comp_b      : owner B's target
-- ---------------------------------------------------------------------------
DO $fixtures$
DECLARE
  u_a        uuid := 'cc000000-0000-4000-8000-000000000001';
  u_b        uuid := 'cc000000-0000-4000-8000-000000000002';
  viewer_a   uuid := 'cc100000-0000-4000-8000-000000000001';
  comp_ok      uuid := 'cc200000-0000-4000-8000-000000000001';
  comp_noview  uuid := 'cc200000-0000-4000-8000-000000000002';
  comp_unavail uuid := 'cc200000-0000-4000-8000-000000000003';
  comp_apify   uuid := 'cc200000-0000-4000-8000-000000000004';
  comp_gated   uuid := 'cc200000-0000-4000-8000-000000000005';
  comp_removed uuid := 'cc200000-0000-4000-8000-000000000006';
  comp_b       uuid := 'cc200000-0000-4000-8000-000000000007';
  comp_retry   uuid := 'cc200000-0000-4000-8000-000000000008';
  comp_fence   uuid := 'cc200000-0000-4000-8000-000000000009';
  comp_atomic  uuid := 'cc200000-0000-4000-8000-00000000000a';
BEGIN
  INSERT INTO auth.users (id, email)
  VALUES
    (u_a, 'ccr-owner-a-' || u_a::text || '@example.invalid'),
    (u_b, 'ccr-owner-b-' || u_b::text || '@example.invalid');

  INSERT INTO public.social_accounts
    (id, user_id, platform, platform_user_id, platform_username,
     access_token, ig_auth_type)
  VALUES
    (viewer_a, u_a, 'instagram', 'ig-ccr-viewer', 'ccr_viewer', 'token-viewer', 'facebook_page');

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
    (comp_ok,       u_a, 'instagram', 'ccr_ok'),
    (comp_noview,   u_a, 'instagram', 'ccr_noview'),
    (comp_unavail,  u_a, 'instagram', 'ccr_unavail'),
    (comp_apify,    u_a, 'instagram', 'ccr_apify'),
    (comp_gated,    u_a, 'instagram', 'ccr_gated'),
    (comp_removed,  u_a, 'instagram', 'ccr_removed'),
    (comp_b,        u_b, 'instagram', 'ccr_b'),
    (comp_retry,    u_a, 'instagram', 'ccr_retry'),
    (comp_fence,    u_a, 'instagram', 'ccr_fence'),
    (comp_atomic,   u_a, 'instagram', 'ccr_atomic');

  -- One entry is inside its weekly window, so it is not due.
  UPDATE public.competitor_watchlist
     SET next_retry_at = now() + interval '7 days'
   WHERE id = comp_gated;

  -- One entry is removed, so it is not due and it is not a valid target.
  UPDATE public.competitor_watchlist
     SET is_active = false, removed_at = now()
   WHERE id = comp_removed;
END
$fixtures$;

-- The service role, for the service-only functions.
SELECT set_config('request.jwt.claim.role', 'service_role', true);

-- ---------------------------------------------------------------------------
-- Helpers.
-- ---------------------------------------------------------------------------

-- Enqueue one competitor job for an owned watchlist entry.
CREATE OR REPLACE FUNCTION pg_temp.ccr_enqueue(p_owner uuid, p_watchlist uuid)
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
CREATE OR REPLACE FUNCTION pg_temp.ccr_claim(p_watchlist uuid)
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
CREATE OR REPLACE FUNCTION pg_temp.ccr_public_can_execute(p_signature text)
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

-- The claim context of the first capture, shared by the sections that
-- continue its work. A live lease is never handed out twice, so the
-- sections that write reuse the claim C3 took.
CREATE TEMP TABLE ccr_ctx (
  label      text PRIMARY KEY,
  job_id     uuid NOT NULL,
  token      uuid NOT NULL,
  generation bigint NOT NULL
) ON COMMIT DROP;

-- A successful official payload.
CREATE OR REPLACE FUNCTION pg_temp.ccr_ok_payload()
RETURNS jsonb
LANGUAGE sql
AS $fn$
  SELECT jsonb_build_object(
    'outcome', 'completed',
    'source', 'official',
    'profile', jsonb_build_object(
      'metrics', jsonb_build_object(
        'followers_count', 54200,
        'media_count', 120)),
    'media', jsonb_build_array(
      jsonb_build_object(
        'ig_media_id', 'ccr-media-1',
        'media_product_type', 'REELS',
        'media_type', 'VIDEO',
        'published_at', '2026-10-28T12:00:00Z',
        'metrics', jsonb_build_object(
          'like_count', 1500,
          'comments_count', 45,
          'view_count', 12000)),
      jsonb_build_object(
        'ig_media_id', 'ccr-media-2',
        'media_product_type', 'FEED',
        'media_type', 'IMAGE',
        'published_at', '2026-10-27T12:00:00Z',
        'metrics', jsonb_build_object(
          'like_count', NULL,
          'comments_count', 3,
          'view_count', NULL))));
$fn$;

-- ===========================================================================
-- C1 - the grant surface.
-- ===========================================================================
DO $c1$
DECLARE
  v_functions TEXT[] := ARRAY[
    'persist_competitor_collection_result(uuid,uuid,bigint,jsonb)',
    'list_due_competitor_collection_targets(integer,timestamptz,uuid)'
  ];
  v_f TEXT;
  v_def TEXT;
BEGIN
  FOREACH v_f IN ARRAY v_functions LOOP
    ASSERT has_function_privilege('service_role', 'public.' || v_f, 'EXECUTE'),
      'C1 the service role can execute ' || v_f;
    ASSERT NOT has_function_privilege('anon', 'public.' || v_f, 'EXECUTE'),
      'C1 anon cannot execute ' || v_f;
    ASSERT NOT has_function_privilege('authenticated', 'public.' || v_f, 'EXECUTE'),
      'C1 authenticated cannot execute ' || v_f;
    ASSERT NOT pg_temp.ccr_public_can_execute(v_f),
      'C1 PUBLIC cannot execute ' || v_f;

    SELECT pg_get_functiondef(p.oid) INTO v_def
      FROM pg_proc AS p
      JOIN pg_namespace AS n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = split_part(v_f, '(', 1);

    ASSERT v_def ILIKE '%SECURITY DEFINER%',
      'C1 ' || v_f || ' is SECURITY DEFINER';
    ASSERT v_def ILIKE '%SET search_path TO%''public''%''pg_temp''%',
      'C1 ' || v_f || ' has a fixed search_path';
  END LOOP;
END
$c1$;

-- ===========================================================================
-- C2 - the due-target read.
-- ===========================================================================
DO $c2$
DECLARE
  v_rows integer;
  v_ids  text[];
  v_due  text;
  v_next uuid;
BEGIN
  SELECT array_agg(t ->> 'watchlist_id') INTO v_ids
    FROM public.list_due_competitor_collection_targets(50, NULL, NULL) AS t;

  ASSERT v_ids @> ARRAY[
    'cc200000-0000-4000-8000-000000000001',
    'cc200000-0000-4000-8000-000000000002',
    'cc200000-0000-4000-8000-000000000003',
    'cc200000-0000-4000-8000-000000000004'
  ],
    'C2 the active, never gated entries are due';

  ASSERT NOT (v_ids @> ARRAY[
    'cc200000-0000-4000-8000-000000000005'
  ]),
    'C2 an entry inside its weekly window is not due';

  ASSERT NOT (v_ids @> ARRAY[
    'cc200000-0000-4000-8000-000000000006'
  ]),
    'C2 a removed entry is not due';

  -- The read is service-scoped and returns every owner's due entries. The
  -- OWNER SCOPE is enforced where it matters: the durable enqueue verifies
  -- each target against the owner it is enqueued for.
  ASSERT v_ids @> ARRAY[
    'cc200000-0000-4000-8000-000000000007'
  ],
    'C2 another owner''s due entry is returned to the service reader';

  -- The page is bounded.
  SELECT count(*)::integer INTO v_rows
    FROM public.list_due_competitor_collection_targets(2, NULL, NULL) AS t;
  ASSERT v_rows = 2, 'C2 the page size is honoured';

  -- The order is stable and the cursor pages.
  SELECT t ->> 'due_at' INTO v_due
    FROM public.list_due_competitor_collection_targets(1, NULL, NULL) AS t;

  SELECT (t ->> 'watchlist_id')::uuid INTO v_next
    FROM public.list_due_competitor_collection_targets(1, NULL, NULL) AS t;

  SELECT count(*)::integer INTO v_rows
    FROM public.list_due_competitor_collection_targets(50, (v_due)::timestamptz, v_next) AS t;

  ASSERT v_rows > 0, 'C2 the cursor returns the rest of the list';

  -- A cursor with only half of its parts is refused.
  BEGIN
    PERFORM public.list_due_competitor_collection_targets(50, now(), NULL);
    RAISE EXCEPTION 'C2 failed: a half cursor was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT LIKE '%IG_COMPETITOR_CURSOR_INVALID%' THEN
      RAISE EXCEPTION 'C2 expected IG_COMPETITOR_CURSOR_INVALID, got: %', SQLERRM;
    END IF;
  END;
END
$c2$;

-- ===========================================================================
-- C3 - the official capture.
-- ===========================================================================
DO $c3$
DECLARE
  v_job        uuid;
  v_claim      RECORD;
  v_result     jsonb;
  v_watchlist  uuid := 'cc200000-0000-4000-8000-000000000001';
BEGIN
  v_job := pg_temp.ccr_enqueue('cc000000-0000-4000-8000-000000000001', v_watchlist);
  ASSERT v_job IS NOT NULL, 'C3 the job was enqueued';

  SELECT * INTO v_claim FROM pg_temp.ccr_claim(v_watchlist);
  ASSERT FOUND, 'C3 the job was claimed';

  -- The viewer is bound before the provider call, as the accepted contract
  -- requires.
  PERFORM public.attach_instagram_collection_job_viewer_context(
    v_claim.job_id, v_claim.token, v_claim.generation,
    'cc100000-0000-4000-8000-000000000001');

  v_result := public.persist_competitor_collection_result(
    v_claim.job_id, v_claim.token, v_claim.generation, pg_temp.ccr_ok_payload());

  INSERT INTO ccr_ctx (label, job_id, token, generation)
  VALUES ('ok', v_claim.job_id, v_claim.token, v_claim.generation);

  ASSERT v_result ->> 'outcome' = 'completed',
    'C3 the capture completed';
  ASSERT v_result ->> 'source' = 'official',
    'C3 the capture is filed as official';
  ASSERT (v_result ->> 'written')::integer = 3,
    'C3 one profile and two media rows were written';

  ASSERT (SELECT count(*) = 1 FROM public.competitor_profile_snapshots
           WHERE watchlist_id = v_watchlist),
    'C3 exactly one profile snapshot exists';
  ASSERT (SELECT count(*) = 2 FROM public.competitor_media_snapshots
           WHERE watchlist_id = v_watchlist),
    'C3 exactly two media snapshots exist';
  ASSERT (SELECT source FROM public.competitor_profile_snapshots
           WHERE watchlist_id = v_watchlist) = 'official',
    'C3 the profile snapshot carries the verified source';
  ASSERT (SELECT media_product_type FROM public.competitor_media_snapshots
           WHERE watchlist_id = v_watchlist AND ig_media_id = 'ccr-media-1') = 'REELS',
    'C3 the media product type is stored as it was reported';

  -- NULL means unavailable, never zero.
  ASSERT (SELECT like_count FROM public.competitor_media_snapshots
           WHERE watchlist_id = v_watchlist AND ig_media_id = 'ccr-media-2') IS NULL,
    'C3 a missing count stayed NULL';
  ASSERT (SELECT view_count FROM public.competitor_media_snapshots
           WHERE watchlist_id = v_watchlist AND ig_media_id = 'ccr-media-2') IS NULL,
    'C3 a missing view count stayed NULL';

  -- The durable operations.
  ASSERT (SELECT count(*) = 3 FROM public.instagram_collection_job_operations
           WHERE job_id = v_claim.job_id AND job_generation = v_claim.generation
             AND state = 'success'),
    'C3 the profile and both media operations were recorded';

  -- The watchlist publication and the job outcome.
  ASSERT (SELECT status FROM public.competitor_watchlist WHERE id = v_watchlist) = 'ok',
    'C3 the entry is published as ok';
  ASSERT (SELECT source FROM public.competitor_watchlist WHERE id = v_watchlist) = 'official',
    'C3 the entry carries the source';
  ASSERT (SELECT last_synced_at FROM public.competitor_watchlist WHERE id = v_watchlist)
           IS NOT NULL,
    'C3 the freshness stamp moved';
  ASSERT (SELECT next_retry_at FROM public.competitor_watchlist WHERE id = v_watchlist) IS NULL,
    'C3 a successful capture opens no retry gate';
  ASSERT (SELECT status FROM public.instagram_collection_jobs WHERE id = v_claim.job_id) = 'completed',
    'C3 the job completed';
  ASSERT (SELECT last_success_at FROM public.instagram_collection_jobs WHERE id = v_claim.job_id)
           IS NOT NULL,
    'C3 the success stamp moved';
  ASSERT (SELECT lease_token FROM public.instagram_collection_jobs WHERE id = v_claim.job_id) IS NULL,
    'C3 the lease was released';
END
$c3$;

-- ===========================================================================
-- C4 - a replay writes nothing twice.
-- ===========================================================================
DO $c4$
DECLARE
  v_watchlist uuid := 'cc200000-0000-4000-8000-000000000001';
  v_before    timestamptz;
  v_after     timestamptz;
  v_job       uuid;
  v_token     uuid;
  v_gen       bigint;
BEGIN
  SELECT last_synced_at INTO v_before
    FROM public.competitor_watchlist WHERE id = v_watchlist;

  SELECT job_id, token, generation INTO v_job, v_token, v_gen
    FROM ccr_ctx WHERE label = 'ok';

  -- The same claim, the same payload, replayed. The job is already
  -- completed, so the fence refuses the second write: the state is already
  -- correct and a second write is impossible.
  BEGIN
    PERFORM public.persist_competitor_collection_result(
      v_job, v_token, v_gen, pg_temp.ccr_ok_payload());
    RAISE EXCEPTION 'C4 failed: a completed job accepted a second write'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT LIKE '%IG_COLLECTION_CLAIM_STALE%' THEN
      RAISE EXCEPTION 'C4 expected IG_COLLECTION_CLAIM_STALE, got: %', SQLERRM;
    END IF;
  END;

  SELECT last_synced_at INTO v_after
    FROM public.competitor_watchlist WHERE id = v_watchlist;

  ASSERT v_before = v_after,
    'C4 the replay did not move the freshness stamp';
  ASSERT (SELECT count(*) = 1 FROM public.competitor_profile_snapshots
           WHERE watchlist_id = v_watchlist),
    'C4 the replay wrote no second profile row';
  ASSERT (SELECT count(*) = 2 FROM public.competitor_media_snapshots
           WHERE watchlist_id = v_watchlist),
    'C4 the replay wrote no second media row';
  ASSERT (SELECT count(*) = 3 FROM public.instagram_collection_job_operations
           WHERE job_id = v_job AND job_generation = v_gen),
    'C4 the replay wrote no second operation';
END
$c4$;

DO $c4b$
DECLARE
  v_watchlist uuid := 'cc200000-0000-4000-8000-000000000001';
  v_before    timestamptz;
  v_after     timestamptz;
  v_claim     RECORD;
BEGIN
  SELECT last_synced_at INTO v_before
    FROM public.competitor_watchlist WHERE id = v_watchlist;

  -- A forced re-collection of the SAME day. It writes the same rows again.
  PERFORM public.enqueue_instagram_collection_jobs_service(
    'cc000000-0000-4000-8000-000000000001',
    jsonb_build_array(jsonb_build_object(
      'target_kind', 'competitor',
      'target_id', v_watchlist::text,
      'mode', 'force')));

  SELECT * INTO v_claim FROM pg_temp.ccr_claim(v_watchlist);
  ASSERT FOUND, 'C4b the forced job was claimed';

  PERFORM public.attach_instagram_collection_job_viewer_context(
    v_claim.job_id, v_claim.token, v_claim.generation,
    'cc100000-0000-4000-8000-000000000001');

  PERFORM public.persist_competitor_collection_result(
    v_claim.job_id, v_claim.token, v_claim.generation, pg_temp.ccr_ok_payload());

  SELECT last_synced_at INTO v_after
    FROM public.competitor_watchlist WHERE id = v_watchlist;

  ASSERT (SELECT count(*) = 1 FROM public.competitor_profile_snapshots
           WHERE watchlist_id = v_watchlist),
    'C4b the forced capture wrote no second profile row';
  ASSERT (SELECT count(*) = 2 FROM public.competitor_media_snapshots
           WHERE watchlist_id = v_watchlist),
    'C4b the forced capture wrote no second media row';
  ASSERT v_before = v_after,
    'C4b the forced capture did not move the freshness stamp';
  ASSERT (SELECT count(*) = 3 FROM public.instagram_collection_job_operations
           WHERE job_id = v_claim.job_id AND job_generation = v_claim.generation),
    'C4b the forced generation has its own operation rows';
END
$c4b$;

-- ===========================================================================
-- C5 - the bounds.
-- ===========================================================================
DO $c5$
DECLARE
  v_watchlist uuid := 'cc200000-0000-4000-8000-000000000002';
  v_job       uuid;
  v_claim     RECORD;
  v_media     jsonb;
  v_i         integer;
BEGIN
  v_job := pg_temp.ccr_enqueue('cc000000-0000-4000-8000-000000000001', v_watchlist);
  SELECT * INTO v_claim FROM pg_temp.ccr_claim(v_watchlist);
  ASSERT FOUND, 'C5 the job was claimed';

  -- The viewer is bound, so the refusals below are about the PAYLOAD and
  -- not about the context.
  PERFORM public.attach_instagram_collection_job_viewer_context(
    v_claim.job_id, v_claim.token, v_claim.generation,
    'cc100000-0000-4000-8000-000000000001');

  -- The payload may not carry an owner, a watchlist id or a capture day.
  BEGIN
    PERFORM public.persist_competitor_collection_result(
      v_claim.job_id, v_claim.token, v_claim.generation,
      pg_temp.ccr_ok_payload() || jsonb_build_object('user_id', 'x'));
    RAISE EXCEPTION 'C5 failed: a payload with an owner was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT LIKE '%IG_COMPETITOR_RESULT_INVALID%' THEN
      RAISE EXCEPTION 'C5 expected IG_COMPETITOR_RESULT_INVALID, got: %', SQLERRM;
    END IF;
  END;

  -- More than thirty media rows.
  v_media := '[]'::jsonb;
  FOR v_i IN 1..31 LOOP
    v_media := v_media || jsonb_build_array(jsonb_build_object(
      'ig_media_id', 'ccr-over-' || v_i,
      'published_at', '2026-10-28T12:00:00Z',
      'metrics', jsonb_build_object()));
  END LOOP;

  BEGIN
    PERFORM public.persist_competitor_collection_result(
      v_claim.job_id, v_claim.token, v_claim.generation,
      jsonb_build_object(
        'outcome', 'completed',
        'source', 'official',
        'profile', jsonb_build_object('metrics', jsonb_build_object()),
        'media', v_media));
    RAISE EXCEPTION 'C5 failed: thirty one media rows were accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT LIKE '%IG_COMPETITOR_RESULT_TOO_MANY_MEDIA%' THEN
      RAISE EXCEPTION 'C5 expected IG_COMPETITOR_RESULT_TOO_MANY_MEDIA, got: %', SQLERRM;
    END IF;
  END;

  -- The same media id twice in one capture.
  BEGIN
    PERFORM public.persist_competitor_collection_result(
      v_claim.job_id, v_claim.token, v_claim.generation,
      jsonb_build_object(
        'outcome', 'completed',
        'source', 'official',
        'profile', jsonb_build_object('metrics', jsonb_build_object()),
        'media', jsonb_build_array(
          jsonb_build_object(
            'ig_media_id', 'ccr-dup',
            'published_at', '2026-10-28T12:00:00Z',
            'metrics', jsonb_build_object()),
          jsonb_build_object(
            'ig_media_id', 'ccr-dup',
            'published_at', '2026-10-28T12:00:00Z',
            'metrics', jsonb_build_object()))));
    RAISE EXCEPTION 'C5 failed: a duplicated media id was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT LIKE '%IG_COMPETITOR_RESULT_DUPLICATE_MEDIA%' THEN
      RAISE EXCEPTION 'C5 expected IG_COMPETITOR_RESULT_DUPLICATE_MEDIA, got: %', SQLERRM;
    END IF;
  END;

  -- A media row without a publication instant.
  BEGIN
    PERFORM public.persist_competitor_collection_result(
      v_claim.job_id, v_claim.token, v_claim.generation,
      jsonb_build_object(
        'outcome', 'completed',
        'source', 'official',
        'profile', jsonb_build_object('metrics', jsonb_build_object()),
        'media', jsonb_build_array(jsonb_build_object(
          'ig_media_id', 'ccr-no-time',
          'metrics', jsonb_build_object()))));
    RAISE EXCEPTION 'C5 failed: a media row without a publication time was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT LIKE '%IG_COMPETITOR_RESULT_INVALID%' THEN
      RAISE EXCEPTION 'C5 expected IG_COMPETITOR_RESULT_INVALID, got: %', SQLERRM;
    END IF;
  END;

  -- A negative count is refused: the provider maps it to NULL, the
  -- database never stores a negative metric.
  BEGIN
    PERFORM public.persist_competitor_collection_result(
      v_claim.job_id, v_claim.token, v_claim.generation,
      jsonb_build_object(
        'outcome', 'completed',
        'source', 'official',
        'profile', jsonb_build_object('metrics', jsonb_build_object()),
        'media', jsonb_build_array(jsonb_build_object(
          'ig_media_id', 'ccr-negative',
          'published_at', '2026-10-28T12:00:00Z',
          'metrics', jsonb_build_object('like_count', -1)))));
    RAISE EXCEPTION 'C5 failed: a negative count was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT LIKE '%IG_COLLECTION_METRIC_INVALID%' THEN
      RAISE EXCEPTION 'C5 expected IG_COLLECTION_METRIC_INVALID, got: %', SQLERRM;
    END IF;
  END;

  -- An unknown media product type is refused.
  BEGIN
    PERFORM public.persist_competitor_collection_result(
      v_claim.job_id, v_claim.token, v_claim.generation,
      jsonb_build_object(
        'outcome', 'completed',
        'source', 'official',
        'profile', jsonb_build_object('metrics', jsonb_build_object()),
        'media', jsonb_build_array(jsonb_build_object(
          'ig_media_id', 'ccr-bad-type',
          'media_product_type', 'STORYTALE',
          'published_at', '2026-10-28T12:00:00Z',
          'metrics', jsonb_build_object()))));
    RAISE EXCEPTION 'C5 failed: an unknown product type was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT LIKE '%IG_COMPETITOR_RESULT_INVALID%' THEN
      RAISE EXCEPTION 'C5 expected IG_COMPETITOR_RESULT_INVALID, got: %', SQLERRM;
    END IF;
  END;

  -- A failure needs a reason code.
  BEGIN
    PERFORM public.persist_competitor_collection_result(
      v_claim.job_id, v_claim.token, v_claim.generation,
      jsonb_build_object('outcome', 'retry'));
    RAISE EXCEPTION 'C5 failed: a failure without a reason was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT LIKE '%IG_COMPETITOR_RESULT_REASON_REQUIRED%' THEN
      RAISE EXCEPTION 'C5 expected IG_COMPETITOR_RESULT_REASON_REQUIRED, got: %', SQLERRM;
    END IF;
  END;

  -- A source that is neither official nor apify.
  BEGIN
    PERFORM public.persist_competitor_collection_result(
      v_claim.job_id, v_claim.token, v_claim.generation,
      jsonb_build_object(
        'outcome', 'completed',
        'source', 'scraped',
        'profile', jsonb_build_object('metrics', jsonb_build_object()),
        'media', jsonb_build_array()));
    RAISE EXCEPTION 'C5 failed: an unknown source was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT LIKE '%IG_COMPETITOR_RESULT_INVALID%' THEN
      RAISE EXCEPTION 'C5 expected IG_COMPETITOR_RESULT_INVALID, got: %', SQLERRM;
    END IF;
  END;

  -- None of the refusals wrote anything.
  ASSERT (SELECT count(*) = 0 FROM public.competitor_profile_snapshots
           WHERE watchlist_id = v_watchlist),
    'C5 a refused payload wrote no profile row';
  ASSERT (SELECT status FROM public.competitor_watchlist WHERE id = v_watchlist) = 'pending',
    'C5 a refused payload left the entry untouched';
  ASSERT (SELECT status FROM public.instagram_collection_jobs WHERE id = v_claim.job_id) = 'leased',
    'C5 a refused payload left the job leased';
END
$c5$;

-- ===========================================================================
-- C6 - a failure with no viewer is recordable.
-- ===========================================================================
DO $c6$
DECLARE
  v_watchlist uuid := 'cc200000-0000-4000-8000-000000000008';
  v_job       uuid;
  v_claim     RECORD;
  v_result    jsonb;
  v_synced    timestamptz;
BEGIN
  -- A previous capture, so the failure can be shown to keep it.
  INSERT INTO public.competitor_profile_snapshots
    (watchlist_id, user_id, captured_on, captured_at, capture_timezone,
     followers_count, media_count, source, status)
  VALUES
    (v_watchlist, 'cc000000-0000-4000-8000-000000000001',
     (now() AT TIME ZONE 'Asia/Kuwait')::date - 1, now(), 'Asia/Kuwait',
     100, 10, 'official', 'ok');

  UPDATE public.competitor_watchlist
     SET status = 'ok', last_synced_at = now(), source = 'official'
   WHERE id = v_watchlist;

  SELECT last_synced_at INTO v_synced
    FROM public.competitor_watchlist WHERE id = v_watchlist;

  v_job := pg_temp.ccr_enqueue('cc000000-0000-4000-8000-000000000001', v_watchlist);
  SELECT * INTO v_claim FROM pg_temp.ccr_claim(v_watchlist);
  ASSERT FOUND, 'C6 the job was claimed';

  v_result := public.persist_competitor_collection_result(
    v_claim.job_id, v_claim.token, v_claim.generation,
    jsonb_build_object(
      'outcome', 'retry',
      'reason_code', 'apify_disabled',
      'error_message', 'No usable Instagram viewer is connected for this owner.'));

  ASSERT v_result ->> 'outcome' = 'retry',
    'C6 the failure was recorded';
  ASSERT (SELECT status FROM public.competitor_watchlist WHERE id = v_watchlist) = 'error',
    'C6 the entry is an error';
  ASSERT (SELECT last_error_code FROM public.competitor_watchlist WHERE id = v_watchlist) = 'apify_disabled',
    'C6 the entry carries the stable reason code';
  ASSERT (SELECT last_error FROM public.competitor_watchlist WHERE id = v_watchlist) IS NOT NULL,
    'C6 the entry carries a bounded message';
  ASSERT (SELECT next_retry_at FROM public.competitor_watchlist WHERE id = v_watchlist) IS NULL,
    'C6 a temporary failure opens no weekly gate';
  ASSERT (SELECT last_synced_at FROM public.competitor_watchlist WHERE id = v_watchlist) = v_synced,
    'C6 the freshness stamp did not move';
  ASSERT (SELECT count(*) = 1 FROM public.competitor_profile_snapshots
           WHERE watchlist_id = v_watchlist),
    'C6 the historical capture is untouched';
  ASSERT (SELECT status FROM public.instagram_collection_jobs WHERE id = v_claim.job_id) = 'retry',
    'C6 the job stays retryable';
  ASSERT (SELECT lease_token FROM public.instagram_collection_jobs WHERE id = v_claim.job_id) IS NULL,
    'C6 the lease was released';
  ASSERT (SELECT state FROM public.instagram_collection_job_operations
           WHERE job_id = v_claim.job_id AND job_generation = v_claim.generation
             AND operation_key = 'profile') = 'failed',
    'C6 the failure is a durable operation record';
END
$c6$;

-- ===========================================================================
-- C7 - the confirmed unavailable target opens the weekly gate.
-- ===========================================================================
DO $c7$
DECLARE
  v_watchlist uuid := 'cc200000-0000-4000-8000-000000000003';
  v_job       uuid;
  v_claim     RECORD;
  v_result    jsonb;
  v_before    timestamptz;
  v_after     timestamptz;
BEGIN
  INSERT INTO public.competitor_profile_snapshots
    (watchlist_id, user_id, captured_on, captured_at, capture_timezone,
     followers_count, media_count, source, status)
  VALUES
    (v_watchlist, 'cc000000-0000-4000-8000-000000000001',
     (now() AT TIME ZONE 'Asia/Kuwait')::date - 1, now(), 'Asia/Kuwait',
     100, 10, 'official', 'ok');

  UPDATE public.competitor_watchlist
     SET status = 'ok', last_synced_at = now(), source = 'official'
   WHERE id = v_watchlist;

  SELECT last_synced_at INTO v_before
    FROM public.competitor_watchlist WHERE id = v_watchlist;

  v_job := pg_temp.ccr_enqueue('cc000000-0000-4000-8000-000000000001', v_watchlist);
  SELECT * INTO v_claim FROM pg_temp.ccr_claim(v_watchlist);
  ASSERT FOUND, 'C7 the job was claimed';

  v_result := public.persist_competitor_collection_result(
    v_claim.job_id, v_claim.token, v_claim.generation,
    jsonb_build_object(
      'outcome', 'unavailable',
      'reason_code', 'target_unavailable',
      'error_message', 'The provider could not analyse this target.'));

  ASSERT v_result ->> 'outcome' = 'unavailable',
    'C7 the unavailable verdict was recorded';
  ASSERT (SELECT status FROM public.competitor_watchlist WHERE id = v_watchlist) = 'unavailable',
    'C7 the entry is unavailable';
  ASSERT (SELECT next_retry_at FROM public.competitor_watchlist WHERE id = v_watchlist)
           > now() + interval '6 days',
    'C7 the weekly gate is open';
  ASSERT (SELECT last_synced_at FROM public.competitor_watchlist WHERE id = v_watchlist) = v_before,
    'C7 the freshness stamp did not move';
  ASSERT (SELECT count(*) = 1 FROM public.competitor_profile_snapshots
           WHERE watchlist_id = v_watchlist),
    'C7 the historical capture is untouched';
  ASSERT (SELECT status FROM public.instagram_collection_jobs WHERE id = v_claim.job_id) = 'unavailable',
    'C7 the job is terminally unavailable';
  ASSERT (SELECT due_at FROM public.instagram_collection_jobs WHERE id = v_claim.job_id)
           > now() + interval '6 days',
    'C7 the job carries the weekly due date';
END
$c7$;

-- ===========================================================================
-- C8 - the context rules.
-- ===========================================================================
DO $c8$
DECLARE
  v_watchlist uuid := 'cc200000-0000-4000-8000-000000000004';
  v_job       uuid;
  v_claim     RECORD;
  v_result    jsonb;
BEGIN
  v_job := pg_temp.ccr_enqueue('cc000000-0000-4000-8000-000000000001', v_watchlist);
  SELECT * INTO v_claim FROM pg_temp.ccr_claim(v_watchlist);
  ASSERT FOUND, 'C8 the job was claimed';

  -- An official result without a viewer is refused.
  BEGIN
    PERFORM public.persist_competitor_collection_result(
      v_claim.job_id, v_claim.token, v_claim.generation, pg_temp.ccr_ok_payload());
    RAISE EXCEPTION 'C8 failed: an official result landed without a viewer'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT LIKE '%IG_COLLECTION_CONTEXT_MISSING%' THEN
      RAISE EXCEPTION 'C8 expected IG_COLLECTION_CONTEXT_MISSING, got: %', SQLERRM;
    END IF;
  END;

  -- An apify result may run without a viewer. No context is invented.
  v_result := public.persist_competitor_collection_result(
    v_claim.job_id, v_claim.token, v_claim.generation,
    jsonb_build_object(
      'outcome', 'completed',
      'source', 'apify',
      'profile', jsonb_build_object('metrics', jsonb_build_object('followers_count', 10)),
      'media', jsonb_build_array(jsonb_build_object(
        'ig_media_id', 'ccr-apify-1',
        'published_at', '2026-10-28T12:00:00Z',
        'metrics', jsonb_build_object('like_count', 3)))));

  ASSERT v_result ->> 'outcome' = 'completed',
    'C8 the apify result was accepted without a viewer';
  ASSERT (SELECT source FROM public.competitor_profile_snapshots
           WHERE watchlist_id = v_watchlist) = 'apify',
    'C8 the apify source is stored';
  ASSERT (SELECT context_viewer_social_account_id FROM public.instagram_collection_jobs
           WHERE id = v_claim.job_id) IS NULL,
    'C8 no viewer was invented for the apify result';
END
$c8$;

DO $c8b$
DECLARE
  v_watchlist uuid := 'cc200000-0000-4000-8000-000000000001';
  v_claim     RECORD;
BEGIN
  -- The same job again, with a context that moved under it.
  SELECT id, lease_token, job_generation INTO v_claim
    FROM public.instagram_collection_jobs
   WHERE watchlist_id = v_watchlist AND status = 'completed';

  ASSERT FOUND, 'C8b the earlier job was found';

  -- Re-claim a fresh generation for the same target.
  UPDATE public.instagram_collection_jobs
     SET status = 'queued', lease_token = NULL, lease_expires_at = NULL,
         job_generation = job_generation + 1
   WHERE id = v_claim.id;

  SELECT * INTO v_claim FROM pg_temp.ccr_claim(v_watchlist);
  ASSERT FOUND, 'C8b the job was claimed again';

  PERFORM public.attach_instagram_collection_job_viewer_context(
    v_claim.job_id, v_claim.token, v_claim.generation,
    'cc100000-0000-4000-8000-000000000001');

  -- The connection is replaced under the claim.
  UPDATE public.instagram_account_capabilities
     SET credential_generation = credential_generation + 1
   WHERE social_account_id = 'cc100000-0000-4000-8000-000000000001';

  -- The official result is refused.
  BEGIN
    PERFORM public.persist_competitor_collection_result(
      v_claim.job_id, v_claim.token, v_claim.generation, pg_temp.ccr_ok_payload());
    RAISE EXCEPTION 'C8b failed: an official result landed after a reconnect'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT LIKE '%IG_COLLECTION_CREDENTIAL_CHANGED%' THEN
      RAISE EXCEPTION 'C8b expected IG_COLLECTION_CREDENTIAL_CHANGED, got: %', SQLERRM;
    END IF;
  END;

  -- The apify result is refused too: a captured context that moved is
  -- honoured, not ignored.
  BEGIN
    PERFORM public.persist_competitor_collection_result(
      v_claim.job_id, v_claim.token, v_claim.generation,
      jsonb_build_object(
        'outcome', 'completed',
        'source', 'apify',
        'profile', jsonb_build_object('metrics', jsonb_build_object()),
        'media', jsonb_build_array()));
    RAISE EXCEPTION 'C8b failed: an apify result landed after a reconnect'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT LIKE '%IG_COLLECTION_CREDENTIAL_CHANGED%' THEN
      RAISE EXCEPTION 'C8b expected IG_COLLECTION_CREDENTIAL_CHANGED, got: %', SQLERRM;
    END IF;
  END;

  ASSERT (SELECT count(*) = 1 FROM public.competitor_profile_snapshots
           WHERE watchlist_id = v_watchlist),
    'C8b the refused results wrote no second profile row';
END
$c8b$;

-- ===========================================================================
-- C9 - the fences.
-- ===========================================================================
DO $c9$
DECLARE
  v_watchlist uuid := 'cc200000-0000-4000-8000-000000000009';
  v_job       uuid;
  v_claim     RECORD;
BEGIN
  v_job := pg_temp.ccr_enqueue('cc000000-0000-4000-8000-000000000001', v_watchlist);
  SELECT * INTO v_claim FROM pg_temp.ccr_claim(v_watchlist);
  ASSERT FOUND, 'C9 the job was claimed';

  -- A stale claim token.
  BEGIN
    PERFORM public.persist_competitor_collection_result(
      v_claim.job_id, gen_random_uuid(), v_claim.generation, pg_temp.ccr_ok_payload());
    RAISE EXCEPTION 'C9 failed: a stale claim token was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT LIKE '%IG_COLLECTION_CLAIM_STALE%' THEN
      RAISE EXCEPTION 'C9 expected IG_COLLECTION_CLAIM_STALE, got: %', SQLERRM;
    END IF;
  END;

  -- A wrong generation.
  BEGIN
    PERFORM public.persist_competitor_collection_result(
      v_claim.job_id, v_claim.token, v_claim.generation + 1, pg_temp.ccr_ok_payload());
    RAISE EXCEPTION 'C9 failed: a wrong generation was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT LIKE '%IG_COLLECTION_CLAIM_STALE%' THEN
      RAISE EXCEPTION 'C9 expected IG_COLLECTION_CLAIM_STALE, got: %', SQLERRM;
    END IF;
  END;

  -- An expired lease.
  UPDATE public.instagram_collection_jobs
     SET lease_expires_at = clock_timestamp() - interval '1 second'
   WHERE id = v_claim.job_id;

  BEGIN
    PERFORM public.persist_competitor_collection_result(
      v_claim.job_id, v_claim.token, v_claim.generation, pg_temp.ccr_ok_payload());
    RAISE EXCEPTION 'C9 failed: an expired lease was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT LIKE '%IG_COLLECTION_CLAIM_STALE%' THEN
      RAISE EXCEPTION 'C9 expected IG_COLLECTION_CLAIM_STALE, got: %', SQLERRM;
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
    PERFORM public.persist_competitor_collection_result(
      v_claim.job_id, v_claim.token, v_claim.generation, pg_temp.ccr_ok_payload());
    RAISE EXCEPTION 'C9 failed: a removed target was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT LIKE '%IG_COLLECTION_TARGET_INACTIVE%' THEN
      RAISE EXCEPTION 'C9 expected IG_COLLECTION_TARGET_INACTIVE, got: %', SQLERRM;
    END IF;
  END;

  -- A foreign job.
  BEGIN
    PERFORM public.persist_competitor_collection_result(
      gen_random_uuid(), v_claim.token, v_claim.generation, pg_temp.ccr_ok_payload());
    RAISE EXCEPTION 'C9 failed: an unknown job was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT LIKE '%IG_COLLECTION_JOB_NOT_FOUND%' THEN
      RAISE EXCEPTION 'C9 expected IG_COLLECTION_JOB_NOT_FOUND, got: %', SQLERRM;
    END IF;
  END;

  -- None of the refusals left anything behind.
  ASSERT (SELECT count(*) = 0 FROM public.competitor_profile_snapshots
           WHERE watchlist_id = v_watchlist),
    'C9 a refused write left no profile row';
  ASSERT (SELECT status FROM public.competitor_watchlist WHERE id = v_watchlist) = 'pending',
    'C9 a refused write left the entry untouched';
  ASSERT (SELECT last_success_at FROM public.instagram_collection_jobs WHERE id = v_claim.job_id) IS NULL,
    'C9 a refused write advanced no success stamp';
END
$c9$;

-- ===========================================================================
-- C10 - the atomicity.
-- ===========================================================================
DO $c10$
DECLARE
  v_watchlist uuid := 'cc200000-0000-4000-8000-00000000000a';
  v_job       uuid;
  v_claim     RECORD;
BEGIN
  v_job := pg_temp.ccr_enqueue('cc000000-0000-4000-8000-000000000001', v_watchlist);
  SELECT * INTO v_claim FROM pg_temp.ccr_claim(v_watchlist);
  ASSERT FOUND, 'C10 the job was claimed';

  PERFORM public.attach_instagram_collection_job_viewer_context(
    v_claim.job_id, v_claim.token, v_claim.generation,
    'cc100000-0000-4000-8000-000000000001');

  -- The profile is written first and the media row then fails. The whole
  -- transaction has to roll back.
  BEGIN
    PERFORM public.persist_competitor_collection_result(
      v_claim.job_id, v_claim.token, v_claim.generation,
      jsonb_build_object(
        'outcome', 'completed',
        'source', 'official',
        'profile', jsonb_build_object(
          'metrics', jsonb_build_object('followers_count', 7)),
        'media', jsonb_build_array(jsonb_build_object(
          'ig_media_id', 'ccr-atomic',
          'published_at', 'not-a-timestamp',
          'metrics', jsonb_build_object()))));
    RAISE EXCEPTION 'C10 failed: a broken media row was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT LIKE '%IG_COMPETITOR_RESULT_INVALID%' THEN
      RAISE EXCEPTION 'C10 expected IG_COMPETITOR_RESULT_INVALID, got: %', SQLERRM;
    END IF;
  END;

  ASSERT (SELECT count(*) = 0 FROM public.competitor_profile_snapshots
           WHERE watchlist_id = v_watchlist
             AND captured_on = (now() AT TIME ZONE 'Asia/Kuwait')::date),
    'C10 the profile row was rolled back with the failed media row';
  ASSERT (SELECT status FROM public.competitor_watchlist WHERE id = v_watchlist) <> 'ok',
    'C10 the entry was not published';
  ASSERT (SELECT last_synced_at FROM public.competitor_watchlist WHERE id = v_watchlist) IS NULL,
    'C10 the freshness stamp did not move';
  ASSERT (SELECT status FROM public.instagram_collection_jobs WHERE id = v_claim.job_id) = 'leased',
    'C10 the job was not completed';
  ASSERT (SELECT count(*) = 0 FROM public.instagram_collection_job_operations
           WHERE job_id = v_claim.job_id AND job_generation = v_claim.generation
             AND operation_key = 'profile'),
    'C10 the operation record was rolled back too';
END
$c10$;

-- ===========================================================================
-- ---------------------------------------------------------------------------
-- C12 - the review regressions.
--   a. a completed payload with NO profile or NO media key is refused, not
--      published as an all-null capture;
--   b. only target_unavailable may open the weekly gate;
--   c. a captured context that moved refuses a FAILURE outcome too;
--   d. a lease that expires while the writes wait rolls the result back.
-- ---------------------------------------------------------------------------
CREATE FUNCTION pg_temp.ccr_slow_write() RETURNS trigger LANGUAGE plpgsql AS $t$
BEGIN
  PERFORM pg_sleep(0.6);
  RETURN NEW;
END;
$t$;

DO $c12$
DECLARE
  v_owner  uuid := 'cc000000-0000-4000-8000-000000000001';
  v_viewer uuid := 'cc100000-0000-4000-8000-000000000001';
  v_a      uuid := 'cc300000-0000-4000-8000-000000000001';
  v_b      uuid := 'cc300000-0000-4000-8000-000000000002';
  v_d      uuid := 'cc300000-0000-4000-8000-000000000004';
  v_claim  RECORD;
  v_raised boolean;
BEGIN
  INSERT INTO public.competitor_watchlist (id, user_id, platform, username)
  VALUES
    (v_a, v_owner, 'instagram', 'ccr_review_a'),
    (v_b, v_owner, 'instagram', 'ccr_review_b'),
    (v_d, v_owner, 'instagram', 'ccr_review_d');

  -- a. missing profile / missing media keys.
  PERFORM pg_temp.ccr_enqueue(v_owner, v_a);
  SELECT * INTO v_claim FROM pg_temp.ccr_claim(v_a);
  ASSERT FOUND, 'C12a the job was claimed';

  BEGIN
    PERFORM public.persist_competitor_collection_result(
      v_claim.job_id, v_claim.token, v_claim.generation,
      jsonb_build_object('outcome', 'completed', 'source', 'apify',
                         'media', jsonb_build_array()));
    RAISE EXCEPTION 'C12a failed: a capture without a profile was published'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN invalid_parameter_value THEN
    ASSERT SQLERRM LIKE '%IG_COMPETITOR_RESULT_INVALID%', 'C12a profile refusal: ' || SQLERRM;
  END;

  BEGIN
    PERFORM public.persist_competitor_collection_result(
      v_claim.job_id, v_claim.token, v_claim.generation,
      jsonb_build_object('outcome', 'completed', 'source', 'apify',
                         'profile', jsonb_build_object('metrics', jsonb_build_object())));
    RAISE EXCEPTION 'C12a failed: a capture without a media array was published'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN invalid_parameter_value THEN
    ASSERT SQLERRM LIKE '%IG_COMPETITOR_RESULT_INVALID%', 'C12a media refusal: ' || SQLERRM;
  END;

  ASSERT NOT EXISTS (SELECT 1 FROM public.competitor_profile_snapshots WHERE watchlist_id = v_a),
    'C12a no profile snapshot was written';
  ASSERT (SELECT last_synced_at FROM public.competitor_watchlist WHERE id = v_a) IS NULL,
    'C12a the watchlist was not published';

  -- b. a viewer failure cannot open the weekly gate.
  BEGIN
    PERFORM public.persist_competitor_collection_result(
      v_claim.job_id, v_claim.token, v_claim.generation,
      jsonb_build_object('outcome', 'unavailable', 'reason_code', 'token_invalid'));
    RAISE EXCEPTION 'C12b failed: a viewer token failure parked the target for a week'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN invalid_parameter_value THEN
    ASSERT SQLERRM LIKE '%only target_unavailable%', 'C12b refusal: ' || SQLERRM;
  END;
  ASSERT (SELECT next_retry_at FROM public.competitor_watchlist WHERE id = v_a) IS NULL,
    'C12b the weekly gate stayed closed';

  -- c. a captured context that moved refuses a failure outcome.
  PERFORM pg_temp.ccr_enqueue(v_owner, v_b);
  SELECT * INTO v_claim FROM pg_temp.ccr_claim(v_b);
  ASSERT FOUND, 'C12c the job was claimed';
  PERFORM public.attach_instagram_collection_job_viewer_context(
    v_claim.job_id, v_claim.token, v_claim.generation, v_viewer);

  UPDATE public.instagram_account_capabilities
     SET credential_generation = credential_generation + 1
   WHERE social_account_id = v_viewer;

  v_raised := false;
  BEGIN
    PERFORM public.persist_competitor_collection_result(
      v_claim.job_id, v_claim.token, v_claim.generation,
      jsonb_build_object('outcome', 'retry', 'reason_code', 'provider_error'));
  EXCEPTION WHEN others THEN
    v_raised := true;
  END;
  ASSERT v_raised, 'C12c a failure outcome ignored the moved captured context';
  ASSERT (SELECT status FROM public.instagram_collection_jobs WHERE id = v_claim.job_id) = 'leased',
    'C12c the job lease was not released by the refused write';
  ASSERT (SELECT last_error_code FROM public.competitor_watchlist WHERE id = v_b) IS NULL,
    'C12c the watchlist was not published by the refused write';

  UPDATE public.instagram_account_capabilities
     SET credential_generation = credential_generation - 1
   WHERE social_account_id = v_viewer;

  -- d. the lease expires while the snapshot write waits.
  PERFORM pg_temp.ccr_enqueue(v_owner, v_d);
  SELECT * INTO v_claim FROM pg_temp.ccr_claim(v_d);
  ASSERT FOUND, 'C12d the job was claimed';
  UPDATE public.instagram_collection_jobs
     SET lease_expires_at = clock_timestamp() + interval '300 milliseconds'
   WHERE id = v_claim.job_id;

  CREATE TRIGGER ccr_slow_write BEFORE INSERT ON public.competitor_profile_snapshots
    FOR EACH ROW EXECUTE FUNCTION pg_temp.ccr_slow_write();

  v_raised := false;
  BEGIN
    PERFORM public.persist_competitor_collection_result(
      v_claim.job_id, v_claim.token, v_claim.generation,
      jsonb_build_object('outcome', 'completed', 'source', 'apify',
                         'profile', jsonb_build_object('metrics', jsonb_build_object()),
                         'media', jsonb_build_array()));
  EXCEPTION WHEN serialization_failure THEN
    v_raised := SQLERRM LIKE '%IG_COLLECTION_CLAIM_STALE%';
  END;

  DROP TRIGGER ccr_slow_write ON public.competitor_profile_snapshots;

  ASSERT v_raised, 'C12d an expired worker result was accepted after the write waited';
  ASSERT NOT EXISTS (SELECT 1 FROM public.competitor_profile_snapshots WHERE watchlist_id = v_d),
    'C12d the delayed snapshot rolled back';
  ASSERT (SELECT last_synced_at FROM public.competitor_watchlist WHERE id = v_d) IS NULL,
    'C12d the watchlist was not published';
END
$c12$;

-- C11 - the role boundary.
-- ===========================================================================
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'cc000000-0000-4000-8000-000000000001', true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);

DO $c11$
BEGIN
  BEGIN
    PERFORM public.persist_competitor_collection_result(
      gen_random_uuid(), gen_random_uuid(), 1,
      jsonb_build_object('outcome', 'retry', 'reason_code', 'provider_error'));
    RAISE EXCEPTION 'C11 failed: an ordinary user published a result'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN insufficient_privilege THEN
    ASSERT SQLSTATE = '42501',
      'C11 a privilege refusal is SQLSTATE 42501, got ' || SQLSTATE;
  END;

  BEGIN
    PERFORM public.list_due_competitor_collection_targets(10, NULL, NULL);
    RAISE EXCEPTION 'C11 failed: an ordinary user read the due targets'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN insufficient_privilege THEN
    ASSERT SQLSTATE = '42501',
      'C11 a privilege refusal is SQLSTATE 42501, got ' || SQLSTATE;
  END;
END
$c11$;

RESET ROLE;

SELECT set_config('request.jwt.claim.role', '', true);
SELECT set_config('request.jwt.claim.sub', '', true);

ROLLBACK;

\echo 'ALL CHECKS PASSED'
