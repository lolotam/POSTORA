-- ============================================================================
-- supabase/tests/instagram_durable_collection_jobs.sql
-- Task 3c/4 prerequisite (migration 20261026150000_instagram_durable_collection_jobs.sql).
--
-- One transaction, synthetic fixtures, labelled ASSERTs, expected refusals in
-- nested BEGIN/EXCEPTION blocks, ROLLBACK, sentinel last. Fixture values are
-- synthetic ('...@example.invalid'); no secrets and no real accounts.
--
-- What this suite proves
--   D1  the grant surface: RLS on and no policies on every new table, no
--       browser privilege on any of them, the owner functions reachable by
--       authenticated only, the service functions reachable by the service
--       role only.
--   D2  the owner boundary: the owner comes from auth.uid(), a foreign
--       target is refused with no row created, and a caller without an
--       authenticated session cannot enqueue at all.
--   D3  the accepted-request throttle is shared, durable and per target: the
--       second request inside the window is refused with a typed reason, and
--       another owner is unaffected.
--   D4  the claim: it returns a token, a generation and a context, it is
--       exclusive while the lease is live, and the per-kind limits are
--       clamped.
--   D5  the fenced write: a snapshot lands, NULL is not 0, and the post
--       link comes from the owned platform_posts lookup.
--   D6  the fences: a stale token, a wrong generation, a replaced
--       credential and an inactive target are each refused. The replaced
--       credential is refused by the snapshot RPC, the progress RPC, every
--       completion outcome and job parking. NONE of them leaves a snapshot,
--       a checkpoint or a success timestamp behind.
--   D7  the competitor viewer: it must be an owned, active, page-linked
--       account with a read-ok capability and an insights scope, and
--       without it neither a write nor a success is possible.
--   D8  the query kinds are independent: a failed old query stays retained
--       and retryable while fresh media advances.
--   D9  a failure advances no success and keeps the captured history.
--   D10 the completion truth: full success is refused while work is open or
--       the inventory was capped, a budget partial advances last_partial_at
--       only, and a full success advances last_success_at.
--   D11 the bounds: the payload sizes, the metric whitelist, the null
--       semantics and the cursor shape are all enforced.
--   D12 the owner status projection carries no lease, no cursor and no
--       provider text, and another owner cannot read it.
--   D13 the parent delete cascades the work, and the service role cannot
--       write a cross-owner row.
--   D14 the provider throttle bucket and the capped backoff ladder.
--   D15 a force bumps the generation, retires the live claim and leaves the
--       previous generation's history alone.
--   D16 an expired lease is recoverable.
--   D17 the scheduled enqueue is idempotent: the same request twice leaves
--       one row at the same generation.
--   D20 a terminal-only generation is reclaimed for finalization, a changed
--       connection starts an empty revision, and a future failure waits.
--   D18 the service functions refuse a caller without the service role.
--
-- The suite SET ROLEs away from superuser where the point of the check is
-- that a client role cannot do something. The service role bypasses RLS, so
-- the ownership checks and the composite foreign keys are the only thing
-- under test there.
--
-- Every test claims its own target, so the claim queue is deterministic in
-- one transaction: a job that is already leased is never handed out again.
-- ============================================================================

\set ON_ERROR_STOP on

BEGIN;

-- ---------------------------------------------------------------------------
-- Fixtures. Written as superuser, where RLS does not apply.
--
-- u_a / u_b   : two owners, one Instagram account each
-- u_admin      : an admin owner
-- acct_a1      : the main owner job
-- acct_a2      : the independent query kinds
-- acct_a3      : a direct-login account (never a valid competitor viewer)
-- acct_a4      : the payload bounds, and the delete cascade
-- acct_a5      : the truncated inventory
-- acct_a6      : the provider throttle
-- acct_a7      : the forced re-collection
-- acct_a8      : the expired lease
-- acct_a9      : the scheduled enqueue
-- acct_b       : owner B's account
-- comp_a       : owner A's tracked competitor
-- ---------------------------------------------------------------------------
DO $fixtures$
DECLARE
  u_a      uuid := 'aa000000-0000-4000-8000-000000000001';
  u_b      uuid := 'bb000000-0000-4000-8000-000000000002';
  u_admin  uuid := 'cc000000-0000-4000-8000-000000000003';
  acct_a1  uuid := 'a1000000-0000-4000-8000-000000000001';
  acct_a2  uuid := 'a1000000-0000-4000-8000-000000000002';
  acct_a3  uuid := 'a1000000-0000-4000-8000-000000000003';
  acct_a4  uuid := 'a1000000-0000-4000-8000-000000000004';
  acct_a5  uuid := 'a1000000-0000-4000-8000-000000000005';
  acct_a6  uuid := 'a1000000-0000-4000-8000-000000000006';
  acct_a7  uuid := 'a1000000-0000-4000-8000-000000000007';
  acct_a8  uuid := 'a1000000-0000-4000-8000-000000000008';
  acct_a9  uuid := 'a1000000-0000-4000-8000-000000000009';
  acct_b   uuid := 'b1000000-0000-4000-8000-000000000001';
  comp_a   uuid := 'c1000000-0000-4000-8000-000000000001';
  post_a   uuid := 'd1000000-0000-4000-8000-000000000001';
  post_a2  uuid := 'd1000000-0000-4000-8000-000000000002';
  post_b   uuid := 'd1000000-0000-4000-8000-000000000003';
BEGIN
  INSERT INTO auth.users (id, email)
  VALUES
    (u_a,     'igjobs-owner-a-'  || u_a::text     || '@example.invalid'),
    (u_b,     'igjobs-owner-b-'  || u_b::text     || '@example.invalid'),
    (u_admin, 'igjobs-admin-'    || u_admin::text || '@example.invalid');

  INSERT INTO public.social_accounts
    (id, user_id, platform, platform_user_id, platform_username,
     access_token, ig_auth_type)
  VALUES
    (acct_a1, u_a, 'instagram', 'ig-a-1', 'igjobs_a1', 'token-a1', 'facebook_page'),
    (acct_a2, u_a, 'instagram', 'ig-a-2', 'igjobs_a2', 'token-a2', 'facebook_page'),
    (acct_a3, u_a, 'instagram', 'ig-a-3', 'igjobs_a3', 'token-a3', 'business_login'),
    (acct_a4, u_a, 'instagram', 'ig-a-4', 'igjobs_a4', 'token-a4', 'facebook_page'),
    (acct_a5, u_a, 'instagram', 'ig-a-5', 'igjobs_a5', 'token-a5', 'facebook_page'),
    (acct_a6, u_a, 'instagram', 'ig-a-6', 'igjobs_a6', 'token-a6', 'facebook_page'),
    (acct_a7, u_a, 'instagram', 'ig-a-7', 'igjobs_a7', 'token-a7', 'facebook_page'),
    (acct_a8, u_a, 'instagram', 'ig-a-8', 'igjobs_a8', 'token-a8', 'facebook_page'),
    (acct_a9, u_a, 'instagram', 'ig-a-9', 'igjobs_a9', 'token-a9', 'facebook_page'),
    (acct_b,  u_b, 'instagram', 'ig-b-1', 'igjobs_b',  'token-b',  'facebook_page');

  -- The protected capability rows. The credential generation is the fence
  -- the durable work is bound to.
  INSERT INTO public.instagram_account_capabilities
    (social_account_id, user_id, platform, login_kind, permission_read_state,
     granted_scopes, scopes_read_at, credential_generation)
  VALUES
    (acct_a1, u_a, 'instagram', 'page_linked', 'ok',
     ARRAY['instagram_basic', 'instagram_manage_insights', 'pages_read_engagement'],
     now(), 3),
    (acct_a2, u_a, 'instagram', 'page_linked', 'ok',
     ARRAY['instagram_basic', 'instagram_manage_insights', 'pages_read_engagement'],
     now(), 1),
    (acct_a3, u_a, 'instagram', 'direct', 'ok',
     ARRAY['instagram_business_basic', 'instagram_business_manage_insights'],
     now(), 1),
    (acct_a4, u_a, 'instagram', 'page_linked', 'ok',
     ARRAY['instagram_basic', 'instagram_manage_insights', 'pages_read_engagement'],
     now(), 1),
    (acct_a5, u_a, 'instagram', 'page_linked', 'ok',
     ARRAY['instagram_basic', 'instagram_manage_insights', 'pages_read_engagement'],
     now(), 1),
    (acct_a6, u_a, 'instagram', 'page_linked', 'ok',
     ARRAY['instagram_basic', 'instagram_manage_insights', 'pages_read_engagement'],
     now(), 1),
    (acct_a7, u_a, 'instagram', 'page_linked', 'ok',
     ARRAY['instagram_basic', 'instagram_manage_insights', 'pages_read_engagement'],
     now(), 1),
    (acct_a8, u_a, 'instagram', 'page_linked', 'ok',
     ARRAY['instagram_basic', 'instagram_manage_insights', 'pages_read_engagement'],
     now(), 1),
    (acct_a9, u_a, 'instagram', 'page_linked', 'ok',
     ARRAY['instagram_basic', 'instagram_manage_insights', 'pages_read_engagement'],
     now(), 1),
    (acct_b,  u_b, 'instagram', 'page_linked', 'ok',
     ARRAY['instagram_basic', 'instagram_manage_insights', 'pages_read_engagement'],
     now(), 1);

  INSERT INTO public.posts (id, user_id, caption, platforms, status)
  VALUES
    (post_a,  u_a, 'owner a post',   ARRAY['instagram']::text[], 'completed'),
    (post_a2, u_a, 'owner a post 2', ARRAY['instagram']::text[], 'completed'),
    (post_b,  u_b, 'owner b post',   ARRAY['instagram']::text[], 'completed');

  -- 'ig-m-owned' was published by exactly one owned post; 'ig-m-amb' was
  -- published by two, so it must stay unlinked.
  INSERT INTO public.platform_posts
    (post_id, social_account_id, platform, platform_post_id, status)
  VALUES
    (post_a,  acct_a1, 'instagram', 'ig-m-owned', 'success'),
    (post_a,  acct_a1, 'instagram', 'ig-m-amb',   'success'),
    (post_a2, acct_a1, 'instagram', 'ig-m-amb',   'success'),
    (post_b,  acct_b,  'instagram', 'ig-m-owned', 'success');

  INSERT INTO public.competitor_watchlist (id, user_id, platform, username)
  VALUES (comp_a, u_a, 'instagram', 'igjobs_comp');

  INSERT INTO public.user_roles (user_id, role) VALUES (u_admin, 'admin');
END
$fixtures$;

-- The plan rows the tracked-competitor quota reads. The schema-only
-- baseline carries no plan rows, so the suite supplies them.
INSERT INTO public.subscription_plans (id, name, slug, is_active, sort_order)
VALUES
  ('f1f1f1f1-f1f1-4f1f-8f1f-f1f1f1f1f1f1', 'Free',     'free',     true, 1),
  ('f2f2f2f2-f2f2-4f2f-8f2f-f2f2f2f2f2f2', 'Pro',      'pro',      true, 2),
  ('f3f3f3f3-f3f3-4f3f-8f3f-f3f3f3f3f3f3', 'Business', 'business', true, 3);

-- The claim context of the main owner job, shared by the sections that
-- continue its work. A live lease is never handed out twice, so the
-- sections that write must reuse the claim D4 took.
CREATE TEMP TABLE igjobs_claim_ctx (
  label      text PRIMARY KEY,
  job_id     uuid NOT NULL,
  token      uuid NOT NULL,
  generation bigint NOT NULL
) ON COMMIT DROP;

-- ===========================================================================
-- D1 - the grant surface.
-- ===========================================================================
DO $d1$
DECLARE
  v_tables TEXT[] := ARRAY[
    'instagram_collection_jobs',
    'instagram_collection_job_operations',
    'instagram_collection_job_checkpoints',
    'instagram_collection_request_throttles',
    'instagram_provider_throttle_buckets'
  ];
  v_t TEXT;
BEGIN
  FOR v_t IN SELECT unnest(v_tables) LOOP
    ASSERT (SELECT relrowsecurity FROM pg_class
             WHERE oid = format('public.%I', v_t)::regclass),
      'D1 ' || v_t || ' has RLS enabled';

    ASSERT (SELECT count(*) = 0 FROM pg_policies
             WHERE schemaname = 'public' AND tablename = v_t),
      'D1 ' || v_t || ' has no policy at all';

    ASSERT NOT has_table_privilege('anon', format('public.%I', v_t), 'SELECT'),
      'D1 anon cannot read ' || v_t;
    ASSERT NOT has_table_privilege('anon', format('public.%I', v_t), 'INSERT'),
      'D1 anon cannot write ' || v_t;
    ASSERT NOT has_table_privilege('authenticated', format('public.%I', v_t), 'SELECT'),
      'D1 authenticated cannot read ' || v_t;
    ASSERT NOT has_table_privilege('authenticated', format('public.%I', v_t), 'INSERT'),
      'D1 authenticated cannot write ' || v_t;
    ASSERT has_table_privilege('service_role', format('public.%I', v_t), 'SELECT'),
      'D1 the service role reads ' || v_t;
    ASSERT has_table_privilege('service_role', format('public.%I', v_t), 'INSERT'),
      'D1 the service role writes ' || v_t;
  END LOOP;

  -- The owner functions belong to an authenticated session.
  ASSERT has_function_privilege('authenticated',
           'public.enqueue_instagram_collection_job(text,uuid,text)', 'EXECUTE'),
    'D1 authenticated can enqueue';
  ASSERT has_function_privilege('authenticated',
           'public.read_instagram_collection_job_status(text,uuid,date)', 'EXECUTE'),
    'D1 authenticated can read their own status';
  ASSERT NOT has_function_privilege('anon',
           'public.enqueue_instagram_collection_job(text,uuid,text)', 'EXECUTE'),
    'D1 anon cannot enqueue';
  ASSERT NOT has_function_privilege('service_role',
           'public.enqueue_instagram_collection_job(text,uuid,text)', 'EXECUTE'),
    'D1 the service role cannot use the owner enqueue';
  ASSERT NOT has_function_privilege('anon',
           'public.read_instagram_collection_job_status(text,uuid,date)', 'EXECUTE'),
    'D1 anon cannot read a status';

  -- The service functions belong to the service role only.
  ASSERT has_function_privilege('service_role',
           'public.claim_instagram_collection_jobs(text,integer)', 'EXECUTE'),
    'D1 the service role can claim';
  ASSERT has_function_privilege('service_role',
           'public.enqueue_instagram_collection_jobs_service(uuid,jsonb)', 'EXECUTE'),
    'D1 the service role can enqueue for a boundary';
  ASSERT has_function_privilege('service_role',
           'public.persist_instagram_collection_snapshot(uuid,uuid,bigint,jsonb)', 'EXECUTE'),
    'D1 the service role can persist a snapshot';
  ASSERT has_function_privilege('service_role',
           'public.complete_instagram_collection_job(uuid,uuid,bigint,text,text)', 'EXECUTE'),
    'D1 the service role can complete a job';
  ASSERT NOT has_function_privilege('authenticated',
           'public.claim_instagram_collection_jobs(text,integer)', 'EXECUTE'),
    'D1 authenticated cannot claim';
  ASSERT NOT has_function_privilege('authenticated',
           'public.persist_instagram_collection_snapshot(uuid,uuid,bigint,jsonb)', 'EXECUTE'),
    'D1 authenticated cannot persist a snapshot';
  ASSERT NOT has_function_privilege('anon',
           'public.claim_instagram_collection_jobs(text,integer)', 'EXECUTE'),
    'D1 anon cannot claim';

  -- The internal helpers are nobody's business.
  ASSERT NOT has_function_privilege('authenticated',
           'public.ig_collection_metric_int(jsonb,text)', 'EXECUTE'),
    'D1 authenticated cannot call the metric helper';
  ASSERT NOT has_function_privilege('anon',
           'public.ig_collection_throttle_accept(text,uuid,text,uuid,interval)', 'EXECUTE'),
    'D1 anon cannot call the throttle helper';
END
$d1$;

-- ===========================================================================
-- D2 - the owner boundary.
-- ===========================================================================
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'aa000000-0000-4000-8000-000000000001', true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);

DO $d2$
DECLARE
  v_result jsonb;
BEGIN
  -- The owner's own account is accepted, and the owner comes from the
  -- session, not from the arguments.
  v_result := public.enqueue_instagram_collection_job(
    'owner', 'a1000000-0000-4000-8000-000000000001', 'normal');

  ASSERT (v_result ->> 'accepted')::boolean,
    'D2 the owner enqueue was accepted';
  ASSERT v_result ->> 'job_id' IS NOT NULL,
    'D2 the owner enqueue returned a job id';

  -- Another owner's account is refused.
  BEGIN
    PERFORM public.enqueue_instagram_collection_job(
      'owner', 'b1000000-0000-4000-8000-000000000001', 'normal');
    RAISE EXCEPTION 'D2 failed: owner A enqueued owner B''s account'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT LIKE '%IG_COLLECTION_TARGET_NOT_FOUND%' THEN
      RAISE EXCEPTION 'D2 expected IG_COLLECTION_TARGET_NOT_FOUND, got: %', SQLERRM;
    END IF;
  END;

  -- A target that is not an Instagram account is refused as well.
  BEGIN
    PERFORM public.enqueue_instagram_collection_job(
      'owner', 'd1000000-0000-4000-8000-000000000001', 'normal');
    RAISE EXCEPTION 'D2 failed: a post id was accepted as a target'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT LIKE '%IG_COLLECTION_TARGET_NOT_FOUND%' THEN
      RAISE EXCEPTION 'D2 expected IG_COLLECTION_TARGET_NOT_FOUND, got: %', SQLERRM;
    END IF;
  END;

  -- The mode is a whitelist, not a free text.
  BEGIN
    PERFORM public.enqueue_instagram_collection_job(
      'owner', 'a1000000-0000-4000-8000-000000000001', 'everything');
    RAISE EXCEPTION 'D2 failed: an unknown mode was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT LIKE '%IG_COLLECTION_INVALID_MODE%' THEN
      RAISE EXCEPTION 'D2 expected IG_COLLECTION_INVALID_MODE, got: %', SQLERRM;
    END IF;
  END;
END
$d2$;

RESET ROLE;

-- The rows the accepted enqueue wrote. Read as superuser: the client roles
-- have no privilege on the raw state at all.
DO $d2a$
BEGIN
  ASSERT (SELECT count(*) = 1 FROM public.instagram_collection_jobs),
    'D2 exactly one job row exists';

  ASSERT (SELECT count(*) = 0 FROM public.instagram_collection_jobs
           WHERE social_account_id = 'b1000000-0000-4000-8000-000000000001'),
    'D2 no job row was created for the foreign target';
END
$d2a$;

-- A caller without an authenticated session cannot enqueue at all.
SET LOCAL ROLE anon;
DO $d2b$
BEGIN
  BEGIN
    PERFORM public.enqueue_instagram_collection_job(
      'owner', 'a1000000-0000-4000-8000-000000000001', 'normal');
    RAISE EXCEPTION 'D2b failed: anon enqueued a collection job'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN insufficient_privilege THEN
    ASSERT SQLSTATE = '42501',
      'D2b a privilege refusal is SQLSTATE 42501, got ' || SQLSTATE;
  END;
END
$d2b$;
RESET ROLE;

-- ===========================================================================
-- D3 - the accepted-request throttle.
-- ===========================================================================
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'aa000000-0000-4000-8000-000000000001', true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);

DO $d3$
DECLARE
  v_result jsonb;
BEGIN
  -- The window was already consumed by the D2 enqueue of the same target.
  v_result := public.enqueue_instagram_collection_job(
    'owner', 'a1000000-0000-4000-8000-000000000001', 'normal');

  ASSERT NOT (v_result ->> 'accepted')::boolean,
    'D3 the second request inside the window was refused';
  ASSERT v_result ->> 'reason' = 'throttled',
    'D3 the refusal carries the typed reason';
  ASSERT (v_result ->> 'retry_after_seconds')::integer > 0,
    'D3 the refusal says when to retry';

  -- Another owner is not affected by somebody else's window.
  PERFORM set_config('request.jwt.claim.sub', 'bb000000-0000-4000-8000-000000000002', true);
  v_result := public.enqueue_instagram_collection_job(
    'owner', 'b1000000-0000-4000-8000-000000000001', 'normal');
  ASSERT (v_result ->> 'accepted')::boolean,
    'D3 another owner is not throttled by a foreign window';
  PERFORM set_config('request.jwt.claim.sub', 'aa000000-0000-4000-8000-000000000001', true);
END
$d3$;

RESET ROLE;

-- The throttle state is durable, and it is keyed by target rather than by
-- capture day, so the window carries across midnight.
DO $d3a$
BEGIN
  ASSERT (SELECT count(*) = 1
            FROM public.instagram_collection_request_throttles
           WHERE scope = 'user_request'
             AND target_kind = 'owner'
             AND target_id = 'a1000000-0000-4000-8000-000000000001'
             AND last_accepted_at IS NOT NULL),
    'D3 the throttle state is durable';

  ASSERT (SELECT count(*) = 2 FROM public.instagram_collection_request_throttles),
    'D3 the throttle is tracked per target, not globally';
END
$d3a$;

-- ===========================================================================
-- D4 - the claim.
-- ===========================================================================
SELECT set_config('request.jwt.claim.role', 'service_role', true);
SELECT set_config('request.jwt.claim.sub', '', true);

DO $d4$
DECLARE
  v_claim   jsonb;
  v_again   integer;
  v_job_id  uuid;
BEGIN
  SELECT * INTO v_claim
    FROM public.claim_instagram_collection_jobs('owner', 100) AS c
   WHERE c ->> 'job_id' = (SELECT id::text FROM public.instagram_collection_jobs
                            WHERE social_account_id = 'a1000000-0000-4000-8000-000000000001');

  ASSERT FOUND, 'D4 the owner job was claimed';
  ASSERT v_claim ->> 'claim_token' IS NOT NULL,
    'D4 the claim returned a token';
  ASSERT (v_claim ->> 'job_generation')::bigint = 1,
    'D4 the claim returned the job generation';
  ASSERT (v_claim -> 'context' ->> 'viewer_social_account_id')
       = 'a1000000-0000-4000-8000-000000000001',
    'D4 the owner job is bound to its own account';
  ASSERT (v_claim -> 'context' ->> 'credential_generation')::bigint = 3,
    'D4 the claim captured the connection generation';
  ASSERT (v_claim -> 'context' ->> 'capability_present')::boolean,
    'D4 the claim reports the capability state';
  ASSERT (v_claim -> 'context' ->> 'login_kind') = 'page_linked',
    'D4 the claim reports the trusted login kind';

  v_job_id := (v_claim ->> 'job_id')::uuid;

  INSERT INTO igjobs_claim_ctx (label, job_id, token, generation)
  VALUES ('a1', v_job_id, (v_claim ->> 'claim_token')::uuid,
          (v_claim ->> 'job_generation')::bigint);

  -- The claim is exclusive while the lease is live.
  SELECT count(*) INTO v_again
    FROM public.claim_instagram_collection_jobs('owner', 100) AS c
   WHERE c ->> 'job_id' = v_job_id::text;

  ASSERT v_again = 0,
    'D4 a live lease is not handed out twice';

  -- The per-kind limit is clamped: 25 owner jobs, 50 competitor jobs.
  ASSERT (SELECT count(*) <= 25
            FROM public.claim_instagram_collection_jobs('owner', 500)),
    'D4 the owner claim is capped at 25';
  ASSERT (SELECT count(*) <= 50
            FROM public.claim_instagram_collection_jobs('competitor', 500)),
    'D4 the competitor claim is capped at 50';
END
$d4$;

-- ===========================================================================
-- D5 - the fenced write.
-- ===========================================================================
DO $d5$
DECLARE
  v_claim  jsonb;
  v_job    uuid;
  v_token  uuid;
  v_gen    bigint;
  v_result jsonb;
BEGIN
  SELECT job_id, token, generation
    INTO v_job, v_token, v_gen
    FROM igjobs_claim_ctx
   WHERE label = 'a1';

  -- The inventory checkpoint: one page, coverage established.
  v_result := public.record_instagram_collection_job_progress(
    v_job, v_token, v_gen,
    jsonb_build_object(
      'kind', 'inventory',
      'cursor', 'cursor-token-1',
      'remaining_ids', jsonb_build_array('ig-m-owned'),
      'pages_fetched', 1,
      'oldest_returned_at', '2026-07-01T00:00:00Z',
      'window_start', '2026-07-29',
      'window_end', '2026-10-27',
      'partial', false,
      'truncated', false,
      'window_covered', true));

  ASSERT (v_result ->> 'inventory') = 'recorded',
    'D5 the inventory checkpoint was recorded';

  -- A captured media item. NULL stays NULL, a real zero stays a zero.
  v_result := public.persist_instagram_collection_snapshot(
    v_job, v_token, v_gen,
    jsonb_build_object(
      'kind', 'owner_media',
      'items', jsonb_build_array(jsonb_build_object(
        'ig_media_id', 'ig-m-owned',
        'media_product_type', 'REELS',
        'media_type', 'VIDEO',
        'published_at', '2026-10-20T10:00:00Z',
        'status', 'ok',
        'metrics', jsonb_build_object(
          'views', 120, 'reach', NULL, 'likes', 0,
          'total_interactions', 12)))));

  ASSERT (v_result ->> 'written')::integer = 1,
    'D5 one snapshot row was written';

  ASSERT (SELECT views FROM public.ig_media_insight_snapshots
           WHERE ig_media_id = 'ig-m-owned') = 120,
    'D5 the captured value was stored';
  ASSERT (SELECT reach FROM public.ig_media_insight_snapshots
           WHERE ig_media_id = 'ig-m-owned') IS NULL,
    'D5 an unavailable metric is NULL, not 0';
  ASSERT (SELECT likes FROM public.ig_media_insight_snapshots
           WHERE ig_media_id = 'ig-m-owned') = 0,
    'D5 a real zero stays a zero';
  ASSERT (SELECT post_id FROM public.ig_media_insight_snapshots
           WHERE ig_media_id = 'ig-m-owned') = 'd1000000-0000-4000-8000-000000000001',
    'D5 the owned post link was resolved';

  -- The operation checkpoint advanced with the write.
  ASSERT (SELECT state FROM public.instagram_collection_job_operations
           WHERE job_id = v_job AND operation_key = 'media:ig-m-owned') = 'success',
    'D5 the media operation is recorded as a success';
  ASSERT (SELECT count(*) = 1 FROM public.instagram_collection_job_operations
           WHERE job_id = v_job AND operation_kind = 'media'),
    'D5 exactly one media operation exists';

  -- An ambiguous post link stays NULL rather than picking one.
  v_result := public.persist_instagram_collection_snapshot(
    v_job, v_token, v_gen,
    jsonb_build_object(
      'kind', 'owner_media',
      'items', jsonb_build_array(jsonb_build_object(
        'ig_media_id', 'ig-m-amb',
        'published_at', '2026-10-19T10:00:00Z',
        'status', 'ok',
        'metrics', jsonb_build_object('views', 5)))));

  ASSERT (v_result ->> 'written')::integer = 1,
    'D5 the ambiguous media was still captured';
  ASSERT (SELECT post_id FROM public.ig_media_insight_snapshots
           WHERE ig_media_id = 'ig-m-amb') IS NULL,
    'D5 an ambiguous post link stays NULL';

  -- The captured day is the job's, not the payload's.
  ASSERT (SELECT captured_on FROM public.ig_media_insight_snapshots
           WHERE ig_media_id = 'ig-m-owned')
       = (SELECT captured_on FROM public.instagram_collection_jobs WHERE id = v_job),
    'D5 the capture day comes from the job';

  -- The owner and the account come from the job, never from the payload.
  ASSERT (SELECT user_id FROM public.ig_media_insight_snapshots
           WHERE ig_media_id = 'ig-m-owned') = 'aa000000-0000-4000-8000-000000000001',
    'D5 the snapshot owner is the job owner';
END
$d5$;

-- ===========================================================================
-- D6 - the fences.
--
-- Each refusal must leave the snapshot tables exactly as they were.
-- ===========================================================================
DO $d6$
DECLARE
  v_claim  jsonb;
  v_job    uuid;
  v_token  uuid;
  v_gen    bigint;
  v_before integer;
  v_payload jsonb := jsonb_build_object(
    'kind', 'owner_media',
    'items', jsonb_build_array(jsonb_build_object(
      'ig_media_id', 'ig-m-fenced',
      'published_at', '2026-10-18T10:00:00Z',
      'status', 'ok',
      'metrics', jsonb_build_object('views', 7))));
BEGIN
  SELECT job_id, token, generation
    INTO v_job, v_token, v_gen
    FROM igjobs_claim_ctx
   WHERE label = 'a1';

  SELECT count(*) INTO v_before FROM public.ig_media_insight_snapshots;

  -- 1. A token that is not the live lease.
  BEGIN
    PERFORM public.persist_instagram_collection_snapshot(
      v_job, gen_random_uuid(), v_gen, v_payload);
    RAISE EXCEPTION 'D6 failed: a forged claim token was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT LIKE '%IG_COLLECTION_CLAIM_STALE%' THEN
      RAISE EXCEPTION 'D6 expected IG_COLLECTION_CLAIM_STALE, got: %', SQLERRM;
    END IF;
  END;

  BEGIN
    PERFORM public.record_instagram_collection_job_progress(
      v_job, gen_random_uuid(), v_gen,
      jsonb_build_object('kind', 'inventory', 'pages_fetched', 77));
    RAISE EXCEPTION 'D6 failed: progress accepted a forged claim token'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT LIKE '%IG_COLLECTION_CLAIM_STALE%' THEN
      RAISE EXCEPTION 'D6 expected IG_COLLECTION_CLAIM_STALE from progress, got: %', SQLERRM;
    END IF;
  END;

  -- 2. A generation that is not the current one.
  BEGIN
    PERFORM public.persist_instagram_collection_snapshot(
      v_job, v_token, v_gen + 1, v_payload);
    RAISE EXCEPTION 'D6 failed: a stale job generation was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT LIKE '%IG_COLLECTION_CLAIM_STALE%' THEN
      RAISE EXCEPTION 'D6 expected IG_COLLECTION_CLAIM_STALE, got: %', SQLERRM;
    END IF;
  END;

  BEGIN
    PERFORM public.complete_instagram_collection_job(
      v_job, v_token, v_gen + 1, 'completed', NULL);
    RAISE EXCEPTION 'D6 failed: completion accepted a stale job generation'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT LIKE '%IG_COLLECTION_CLAIM_STALE%' THEN
      RAISE EXCEPTION 'D6 expected IG_COLLECTION_CLAIM_STALE from completion, got: %', SQLERRM;
    END IF;
  END;

  -- 3. A credential that was replaced after the provider call.
  --    The same refusal has to cover every result RPC, not only the snapshot.
  UPDATE public.instagram_account_capabilities
     SET credential_generation = credential_generation + 1
   WHERE social_account_id = 'a1000000-0000-4000-8000-000000000001';

  BEGIN
    PERFORM public.persist_instagram_collection_snapshot(
      v_job, v_token, v_gen, v_payload);
    RAISE EXCEPTION 'D6 failed: a write landed after the credential changed'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT LIKE '%IG_COLLECTION_CREDENTIAL_CHANGED%' THEN
      RAISE EXCEPTION 'D6 expected IG_COLLECTION_CREDENTIAL_CHANGED, got: %', SQLERRM;
    END IF;
  END;

  BEGIN
    PERFORM public.record_instagram_collection_job_progress(
      v_job, v_token, v_gen,
      jsonb_build_object('kind', 'inventory', 'pages_fetched', 77));
    RAISE EXCEPTION 'D6 failed: progress overwrote the checkpoint after the credential changed'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT LIKE '%IG_COLLECTION_CREDENTIAL_CHANGED%' THEN
      RAISE EXCEPTION 'D6 expected IG_COLLECTION_CREDENTIAL_CHANGED from progress, got: %', SQLERRM;
    END IF;
  END;

  ASSERT (SELECT inventory_pages_fetched
            FROM public.instagram_collection_job_checkpoints
           WHERE job_id = v_job AND job_generation = v_gen) = 1,
    'D6 progress did not overwrite the checkpoint';

  BEGIN
    PERFORM public.complete_instagram_collection_job(
      v_job, v_token, v_gen, 'completed', NULL);
    RAISE EXCEPTION 'D6 failed: completion advanced success after the credential changed'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT LIKE '%IG_COLLECTION_CREDENTIAL_CHANGED%' THEN
      RAISE EXCEPTION 'D6 expected IG_COLLECTION_CREDENTIAL_CHANGED from completion, got: %', SQLERRM;
    END IF;
  END;

  BEGIN
    PERFORM public.complete_instagram_collection_job(
      v_job, v_token, v_gen, 'partial', NULL);
    RAISE EXCEPTION 'D6 failed: a partial completion landed after the credential changed'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT LIKE '%IG_COLLECTION_CREDENTIAL_CHANGED%' THEN
      RAISE EXCEPTION 'D6 expected IG_COLLECTION_CREDENTIAL_CHANGED from partial, got: %', SQLERRM;
    END IF;
  END;

  BEGIN
    PERFORM public.complete_instagram_collection_job(
      v_job, v_token, v_gen, 'retry', 'provider_error');
    RAISE EXCEPTION 'D6 failed: a retry completion landed after the credential changed'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT LIKE '%IG_COLLECTION_CREDENTIAL_CHANGED%' THEN
      RAISE EXCEPTION 'D6 expected IG_COLLECTION_CREDENTIAL_CHANGED from retry, got: %', SQLERRM;
    END IF;
  END;

  BEGIN
    PERFORM public.complete_instagram_collection_job(
      v_job, v_token, v_gen, 'unavailable', 'metric_unavailable');
    RAISE EXCEPTION 'D6 failed: an unavailable completion landed after the credential changed'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT LIKE '%IG_COLLECTION_CREDENTIAL_CHANGED%' THEN
      RAISE EXCEPTION 'D6 expected IG_COLLECTION_CREDENTIAL_CHANGED from unavailable, got: %', SQLERRM;
    END IF;
  END;

  BEGIN
    PERFORM public.complete_instagram_collection_job(
      v_job, v_token, v_gen, 'error', 'provider_error');
    RAISE EXCEPTION 'D6 failed: an error completion landed after the credential changed'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT LIKE '%IG_COLLECTION_CREDENTIAL_CHANGED%' THEN
      RAISE EXCEPTION 'D6 expected IG_COLLECTION_CREDENTIAL_CHANGED from error, got: %', SQLERRM;
    END IF;
  END;

  BEGIN
    PERFORM public.record_instagram_provider_throttle(
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      40, now() + interval '5 minutes', v_job, v_token, v_gen);
    RAISE EXCEPTION 'D6 failed: a stale worker parked the job after the credential changed'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT LIKE '%IG_COLLECTION_CREDENTIAL_CHANGED%' THEN
      RAISE EXCEPTION 'D6 expected IG_COLLECTION_CREDENTIAL_CHANGED from throttle, got: %', SQLERRM;
    END IF;
  END;

  ASSERT (SELECT status FROM public.instagram_collection_jobs WHERE id = v_job) = 'leased',
    'D6 the refused results left the job leased';
  ASSERT (SELECT last_success_at FROM public.instagram_collection_jobs WHERE id = v_job) IS NULL,
    'D6 the refused completion did not advance last_success_at';
  ASSERT (SELECT last_partial_at FROM public.instagram_collection_jobs WHERE id = v_job) IS NULL,
    'D6 the refused partial did not advance last_partial_at';
  ASSERT (SELECT count(*) = 0 FROM public.instagram_provider_throttle_buckets
           WHERE bucket_key = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
    'D6 the refused throttle did not record a bucket';

  -- 4. A target that is no longer active.
  UPDATE public.instagram_account_capabilities
     SET credential_generation = 3
   WHERE social_account_id = 'a1000000-0000-4000-8000-000000000001';

  UPDATE public.social_accounts
     SET is_active = false
   WHERE id = 'a1000000-0000-4000-8000-000000000001';

  BEGIN
    PERFORM public.persist_instagram_collection_snapshot(
      v_job, v_token, v_gen, v_payload);
    RAISE EXCEPTION 'D6 failed: a write landed for an inactive target'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT LIKE '%IG_COLLECTION_TARGET_INACTIVE%' THEN
      RAISE EXCEPTION 'D6 expected IG_COLLECTION_TARGET_INACTIVE, got: %', SQLERRM;
    END IF;
  END;

  BEGIN
    PERFORM public.record_instagram_collection_job_progress(
      v_job, v_token, v_gen,
      jsonb_build_object('kind', 'inventory', 'pages_fetched', 77));
    RAISE EXCEPTION 'D6 failed: progress landed for an inactive target'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT LIKE '%IG_COLLECTION_TARGET_INACTIVE%' THEN
      RAISE EXCEPTION 'D6 expected IG_COLLECTION_TARGET_INACTIVE from progress, got: %', SQLERRM;
    END IF;
  END;

  BEGIN
    PERFORM public.complete_instagram_collection_job(
      v_job, v_token, v_gen, 'completed', NULL);
    RAISE EXCEPTION 'D6 failed: completion landed for an inactive target'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT LIKE '%IG_COLLECTION_TARGET_INACTIVE%' THEN
      RAISE EXCEPTION 'D6 expected IG_COLLECTION_TARGET_INACTIVE from completion, got: %', SQLERRM;
    END IF;
  END;

  UPDATE public.social_accounts
     SET is_active = true
   WHERE id = 'a1000000-0000-4000-8000-000000000001';

  -- Nothing landed.
  ASSERT (SELECT count(*) FROM public.ig_media_insight_snapshots) = v_before,
    'D6 no refused write left a snapshot behind';
  ASSERT (SELECT count(*) FROM public.instagram_collection_job_operations
           WHERE job_id = v_job AND operation_key = 'media:ig-m-fenced') = 0,
    'D6 no refused write left a checkpoint behind';
END
$d6$;

-- ===========================================================================
-- D7 - the competitor viewer.
-- ===========================================================================
DO $d7$
DECLARE
  v_claim  jsonb;
  v_job    uuid;
  v_token  uuid;
  v_gen    bigint;
  v_result jsonb;
  v_payload jsonb := jsonb_build_object(
    'kind', 'competitor_media',
    'items', jsonb_build_array(jsonb_build_object(
      'ig_media_id', 'ig-comp-1',
      'source', 'official',
      'published_at', '2026-10-21T10:00:00Z',
      'status', 'ok',
      'metrics', jsonb_build_object('like_count', 4, 'view_count', 9))));
BEGIN
  -- The competitor job.
  v_result := public.enqueue_instagram_collection_jobs_service(
    'aa000000-0000-4000-8000-000000000001',
    jsonb_build_array(jsonb_build_object(
      'target_kind', 'competitor',
      'target_id', 'c1000000-0000-4000-8000-000000000001',
      'mode', 'normal')));
  ASSERT (v_result ->> 'accepted')::integer = 1,
    'D7 the competitor job was enqueued';

  SELECT * INTO v_claim
    FROM public.claim_instagram_collection_jobs('competitor', 100) AS c;

  ASSERT FOUND, 'D7 the competitor job was claimed';
  v_job   := (v_claim ->> 'job_id')::uuid;
  v_token := (v_claim ->> 'claim_token')::uuid;
  v_gen   := (v_claim ->> 'job_generation')::bigint;

  -- Without a bound viewer there is no context, so no write is possible.
  ASSERT (v_claim -> 'context' ->> 'viewer_social_account_id') IS NULL,
    'D7 a competitor job starts without a viewer';
  ASSERT (v_claim -> 'context' ->> 'credential_generation') IS NULL,
    'D7 a competitor job starts without a credential generation';

  BEGIN
    PERFORM public.persist_instagram_collection_snapshot(
      v_job, v_token, v_gen, v_payload);
    RAISE EXCEPTION 'D7 failed: a competitor write landed without a viewer'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT LIKE '%IG_COLLECTION_CONTEXT_MISSING%' THEN
      RAISE EXCEPTION 'D7 expected IG_COLLECTION_CONTEXT_MISSING, got: %', SQLERRM;
    END IF;
  END;

  -- A supplied boolean does not stand in for a captured viewer.
  BEGIN
    PERFORM public.record_instagram_collection_job_progress(
      v_job, v_token, v_gen,
      jsonb_build_object(
        'kind', 'inventory',
        'pages_fetched', 77,
        'context_captured', true));
    RAISE EXCEPTION 'D7 failed: inventory landed before a viewer was captured'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT LIKE '%IG_COLLECTION_CONTEXT_MISSING%' THEN
      RAISE EXCEPTION 'D7 expected IG_COLLECTION_CONTEXT_MISSING from progress, got: %', SQLERRM;
    END IF;
  END;

  ASSERT (SELECT count(*) = 0 FROM public.instagram_collection_job_checkpoints
           WHERE job_id = v_job),
    'D7 pre-context progress left no checkpoint';

  BEGIN
    PERFORM public.complete_instagram_collection_job(
      v_job, v_token, v_gen, 'completed', NULL);
    RAISE EXCEPTION 'D7 failed: a competitor job completed without a viewer'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT LIKE '%IG_COLLECTION_CONTEXT_MISSING%'
       AND SQLERRM NOT LIKE '%IG_COLLECTION_NOTHING_CAPTURED%' THEN
      RAISE EXCEPTION 'D7 expected a context refusal, got: %', SQLERRM;
    END IF;
  END;

  -- Another owner's viewer is refused.
  BEGIN
    PERFORM public.attach_instagram_collection_job_viewer_context(
      v_job, v_token, v_gen, 'b1000000-0000-4000-8000-000000000001');
    RAISE EXCEPTION 'D7 failed: a foreign viewer was bound'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT LIKE '%IG_COLLECTION_VIEWER_NOT_OWNED%' THEN
      RAISE EXCEPTION 'D7 expected IG_COLLECTION_VIEWER_NOT_OWNED, got: %', SQLERRM;
    END IF;
  END;

  -- A direct Instagram login cannot query a competitor.
  BEGIN
    PERFORM public.attach_instagram_collection_job_viewer_context(
      v_job, v_token, v_gen, 'a1000000-0000-4000-8000-000000000003');
    RAISE EXCEPTION 'D7 failed: a direct-login viewer was bound'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT LIKE '%IG_COLLECTION_VIEWER_UNSUPPORTED_LOGIN%' THEN
      RAISE EXCEPTION 'D7 expected IG_COLLECTION_VIEWER_UNSUPPORTED_LOGIN, got: %', SQLERRM;
    END IF;
  END;

  -- The owned, page-linked, scope-carrying viewer is accepted.
  v_result := public.attach_instagram_collection_job_viewer_context(
    v_job, v_token, v_gen, 'a1000000-0000-4000-8000-000000000002');

  ASSERT (v_result ->> 'viewer_social_account_id')
       = 'a1000000-0000-4000-8000-000000000002',
    'D7 the owned viewer was bound';
  ASSERT (v_result ->> 'credential_generation')::bigint = 1,
    'D7 the viewer credential generation was captured';
  ASSERT (v_result ->> 'login_kind') = 'page_linked',
    'D7 the viewer login kind was captured';

  -- And now the write lands.
  v_result := public.persist_instagram_collection_snapshot(
    v_job, v_token, v_gen, v_payload);

  ASSERT (v_result ->> 'written')::integer = 1,
    'D7 the competitor snapshot was written';
  ASSERT (SELECT count(*) = 1 FROM public.competitor_media_snapshots
           WHERE ig_media_id = 'ig-comp-1'),
    'D7 the competitor media snapshot exists';
  ASSERT (SELECT user_id FROM public.competitor_media_snapshots
           WHERE ig_media_id = 'ig-comp-1') = 'aa000000-0000-4000-8000-000000000001',
    'D7 the competitor snapshot carries the job owner';
  ASSERT (SELECT source FROM public.competitor_media_snapshots
           WHERE ig_media_id = 'ig-comp-1') = 'official',
    'D7 the competitor snapshot carries the source';
END
$d7$;

-- ===========================================================================
-- D8 - the query kinds are independent, and an old failure stays retained.
-- ===========================================================================
DO $d8$
DECLARE
  v_claim  jsonb;
  v_job    uuid;
  v_token  uuid;
  v_gen    bigint;
  v_result jsonb;
BEGIN
  -- The scheduled enqueue of the second account, then its claim.
  v_result := public.enqueue_instagram_collection_jobs_service(
    'aa000000-0000-4000-8000-000000000001',
    jsonb_build_array(jsonb_build_object(
      'target_kind', 'owner',
      'target_id', 'a1000000-0000-4000-8000-000000000002',
      'mode', 'normal')));
  ASSERT (v_result ->> 'accepted')::integer = 1,
    'D8 the second account was enqueued';

  SELECT * INTO v_claim
    FROM public.claim_instagram_collection_jobs('owner', 100) AS c
   WHERE c ->> 'job_id' = (SELECT id::text FROM public.instagram_collection_jobs
                            WHERE social_account_id = 'a1000000-0000-4000-8000-000000000002');

  ASSERT FOUND, 'D8 the second job was claimed';
  v_job   := (v_claim ->> 'job_id')::uuid;
  v_token := (v_claim ->> 'claim_token')::uuid;
  v_gen   := (v_claim ->> 'job_generation')::bigint;

  INSERT INTO igjobs_claim_ctx (label, job_id, token, generation)
  VALUES ('a2', v_job, v_token, v_gen);

  -- An old provider date fails.
  v_result := public.record_instagram_collection_job_progress(
    v_job, v_token, v_gen,
    jsonb_build_object(
      'kind', 'operations',
      'items', jsonb_build_array(jsonb_build_object(
        'operation_key', 'account_day:2026-09-01:interactions',
        'operation_kind', 'account_day',
        'provider_date', '2026-09-01',
        'query_kind', 'interactions',
        'state', 'failed',
        'reason_code', 'provider_error'))));

  ASSERT (v_result ->> 'recorded')::integer = 1,
    'D8 the failure was recorded';
  ASSERT (SELECT state FROM public.instagram_collection_job_operations
           WHERE job_id = v_job
             AND operation_key = 'account_day:2026-09-01:interactions') = 'failed',
    'D8 the failed operation is retained';
  ASSERT (SELECT retry_at FROM public.instagram_collection_job_operations
           WHERE job_id = v_job
             AND operation_key = 'account_day:2026-09-01:interactions') IS NOT NULL,
    'D8 the failed operation carries a retry time';

  -- The two query kinds of one provider date are separate operations.
  v_result := public.persist_instagram_collection_snapshot(
    v_job, v_token, v_gen,
    jsonb_build_object(
      'kind', 'owner_account_day',
      'items', jsonb_build_array(jsonb_build_object(
        'provider_date', '2026-10-26',
        'metric_date', '2026-10-26',
        'query_kind', 'interactions',
        'period_start', '2026-10-26T00:00:00Z',
        'period_end', '2026-10-27T00:00:00Z',
        'provider_timezone', 'Asia/Kuwait',
        'status', 'ok',
        'metrics', jsonb_build_object('reach', 100, 'views', 250)))));

  ASSERT (v_result ->> 'written')::integer = 1,
    'D8 the interactions capture was written';
  ASSERT (SELECT count(*) = 1 FROM public.ig_account_insight_daily
           WHERE metric_date = '2026-10-26'),
    'D8 the account day row exists';
  ASSERT (SELECT reach FROM public.ig_account_insight_daily
           WHERE metric_date = '2026-10-26') = 100,
    'D8 the interaction metrics were stored';
  -- The interactions query does not write the follow breakdown, and a metric
  -- that belongs to the other query kind is refused rather than dropped.
  BEGIN
    PERFORM public.persist_instagram_collection_snapshot(
      v_job, v_token, v_gen,
      jsonb_build_object(
        'kind', 'owner_account_day',
        'items', jsonb_build_array(jsonb_build_object(
          'provider_date', '2026-10-26',
          'metric_date', '2026-10-26',
          'query_kind', 'interactions',
          'status', 'ok',
          'metrics', jsonb_build_object('reach', 100, 'follows', 3)))));
    RAISE EXCEPTION 'D8 failed: the interactions query accepted a follow metric'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT LIKE '%IG_COLLECTION_INVALID_PAYLOAD%' THEN
      RAISE EXCEPTION 'D8 expected IG_COLLECTION_INVALID_PAYLOAD, got: %', SQLERRM;
    END IF;
  END;

  ASSERT (SELECT follows FROM public.ig_account_insight_daily
           WHERE metric_date = '2026-10-26') IS NULL,
    'D8 the interactions capture wrote no follow breakdown';

  -- The follow breakdown is an independent operation of the same day.
  ASSERT (SELECT count(*) = 1 FROM public.instagram_collection_job_operations
           WHERE job_id = v_job
             AND operation_key = 'account_day:2026-10-26:interactions'),
    'D8 the interactions operation exists';
  ASSERT (SELECT count(*) = 0 FROM public.instagram_collection_job_operations
           WHERE job_id = v_job
             AND operation_key = 'account_day:2026-10-26:follow_breakdown'),
    'D8 the follow breakdown is still its own operation';

  -- The follow breakdown writes its own columns and leaves the interaction
  -- metrics alone.
  v_result := public.persist_instagram_collection_snapshot(
    v_job, v_token, v_gen,
    jsonb_build_object(
      'kind', 'owner_account_day',
      'items', jsonb_build_array(jsonb_build_object(
        'provider_date', '2026-10-26',
        'metric_date', '2026-10-26',
        'query_kind', 'follow_breakdown',
        'status', 'ok',
        'metrics', jsonb_build_object('follows', 3, 'unfollows', 1)))));

  ASSERT (v_result ->> 'written')::integer = 1,
    'D8 the follow breakdown capture was written';
  ASSERT (SELECT follows FROM public.ig_account_insight_daily
           WHERE metric_date = '2026-10-26') = 3,
    'D8 the follow breakdown metrics were stored';
  ASSERT (SELECT unfollows FROM public.ig_account_insight_daily
           WHERE metric_date = '2026-10-26') = 1,
    'D8 the unfollow count was stored';
  ASSERT (SELECT reach FROM public.ig_account_insight_daily
           WHERE metric_date = '2026-10-26') = 100,
    'D8 the follow breakdown left the interaction metrics alone';
  ASSERT (SELECT count(*) = 1 FROM public.ig_account_insight_daily
           WHERE metric_date = '2026-10-26'),
    'D8 the two kinds share one account-day row';
  ASSERT (SELECT count(*) = 1 FROM public.instagram_collection_job_operations
           WHERE job_id = v_job
             AND operation_key = 'account_day:2026-10-26:follow_breakdown'),
    'D8 the follow breakdown operation exists now';

  -- A fresh media item advances while the old failure is retained.
  v_result := public.persist_instagram_collection_snapshot(
    v_job, v_token, v_gen,
    jsonb_build_object(
      'kind', 'owner_media',
      'items', jsonb_build_array(jsonb_build_object(
        'ig_media_id', 'ig-m-fresh',
        'published_at', '2026-10-25T10:00:00Z',
        'status', 'ok',
        'metrics', jsonb_build_object('views', 42)))));

  ASSERT (v_result ->> 'written')::integer = 1,
    'D8 the fresh media advanced';
  ASSERT (SELECT state FROM public.instagram_collection_job_operations
           WHERE job_id = v_job
             AND operation_key = 'account_day:2026-09-01:interactions') = 'failed',
    'D8 the old failure is still retained and retryable';
  ASSERT (SELECT count(*) FROM public.instagram_collection_job_operations
           WHERE job_id = v_job AND state IN ('pending', 'failed')),
    'D8 exactly one operation is still open';

  -- A finished operation is never reset by a later progress record.
  v_result := public.record_instagram_collection_job_progress(
    v_job, v_token, v_gen,
    jsonb_build_object(
      'kind', 'operations',
      'items', jsonb_build_array(jsonb_build_object(
        'operation_key', 'media:ig-m-fresh',
        'operation_kind', 'media',
        'state', 'failed',
        'reason_code', 'late_failure'))));

  ASSERT (SELECT state FROM public.instagram_collection_job_operations
           WHERE job_id = v_job AND operation_key = 'media:ig-m-fresh') = 'success',
    'D8 a finished operation is never reset';
END
$d8$;

-- ===========================================================================
-- D9 - a failure advances no success and keeps the captured history.
-- ===========================================================================
DO $d9$
DECLARE
  v_claim  jsonb;
  v_job    uuid;
  v_token  uuid;
  v_gen    bigint;
  v_result jsonb;
BEGIN
  SELECT job_id, token, generation
    INTO v_job, v_token, v_gen
    FROM igjobs_claim_ctx
   WHERE label = 'a2';

  v_result := public.complete_instagram_collection_job(
    v_job, v_token, v_gen, 'retry', 'provider_error');

  ASSERT (v_result ->> 'status') = 'retry',
    'D9 the job was queued for a retry';
  ASSERT (SELECT last_success_at FROM public.instagram_collection_jobs
           WHERE id = v_job) IS NULL,
    'D9 a retry advances no success';
  ASSERT (SELECT last_attempt_at FROM public.instagram_collection_jobs
           WHERE id = v_job) IS NOT NULL,
    'D9 the attempt was recorded';
  ASSERT (SELECT last_reason_code FROM public.instagram_collection_jobs
           WHERE id = v_job) = 'provider_error',
    'D9 the typed reason was recorded';
  ASSERT (SELECT retry_at FROM public.instagram_collection_jobs
           WHERE id = v_job) > now(),
    'D9 the retry is scheduled in the future';

  -- The captured history survives the failure.
  ASSERT (SELECT count(*) = 1 FROM public.ig_media_insight_snapshots
           WHERE ig_media_id = 'ig-m-fresh'),
    'D9 the captured history survives a failed attempt';
END
$d9$;

-- ===========================================================================
-- D10 - the completion truth.
-- ===========================================================================
DO $d10$
DECLARE
  v_claim  jsonb;
  v_job    uuid;
  v_token  uuid;
  v_gen    bigint;
  v_result jsonb;
BEGIN
  -- The owner job of the first account: it has a captured media item and a
  -- complete inventory, so it can complete.
  SELECT job_id, token, generation
    INTO v_job, v_token, v_gen
    FROM igjobs_claim_ctx
   WHERE label = 'a1';

  -- An open operation blocks a full success.
  PERFORM public.record_instagram_collection_job_progress(
    v_job, v_token, v_gen,
    jsonb_build_object(
      'kind', 'operations',
      'items', jsonb_build_array(jsonb_build_object(
        'operation_key', 'media:ig-m-open',
        'operation_kind', 'media',
        'state', 'pending'))));

  BEGIN
    PERFORM public.complete_instagram_collection_job(
      v_job, v_token, v_gen, 'completed', NULL);
    RAISE EXCEPTION 'D10 failed: a job with an open operation completed'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT LIKE '%IG_COLLECTION_INCOMPLETE%' THEN
      RAISE EXCEPTION 'D10 expected IG_COLLECTION_INCOMPLETE, got: %', SQLERRM;
    END IF;
  END;

  ASSERT (SELECT last_success_at FROM public.instagram_collection_jobs
           WHERE id = v_job) IS NULL,
    'D10 a refused completion advances no success';

  -- A budget partial advances the partial marker only.
  v_result := public.complete_instagram_collection_job(
    v_job, v_token, v_gen, 'partial', NULL);

  ASSERT (v_result ->> 'status') = 'partial',
    'D10 the job was queued as a partial';
  ASSERT (SELECT last_partial_at FROM public.instagram_collection_jobs
           WHERE id = v_job) IS NOT NULL,
    'D10 the partial marker advanced';
  ASSERT (SELECT last_success_at FROM public.instagram_collection_jobs
           WHERE id = v_job) IS NULL,
    'D10 a partial advances no success';
  ASSERT (SELECT due_at FROM public.instagram_collection_jobs
           WHERE id = v_job) > now(),
    'D10 a partial is queued again';
END
$d10$;

-- A capped inventory never becomes a full success.
DO $d10b$
DECLARE
  v_claim  jsonb;
  v_job    uuid;
  v_token  uuid;
  v_gen    bigint;
  v_result jsonb;
BEGIN
  -- The fifth account carries the truncated-inventory case.
  v_result := public.enqueue_instagram_collection_jobs_service(
    'aa000000-0000-4000-8000-000000000001',
    jsonb_build_array(jsonb_build_object(
      'target_kind', 'owner',
      'target_id', 'a1000000-0000-4000-8000-000000000005',
      'mode', 'normal')));
  ASSERT (v_result ->> 'accepted')::integer = 1,
    'D10b the fifth account was enqueued';

  SELECT * INTO v_claim
    FROM public.claim_instagram_collection_jobs('owner', 100) AS c
   WHERE c ->> 'job_id' = (SELECT id::text FROM public.instagram_collection_jobs
                            WHERE social_account_id = 'a1000000-0000-4000-8000-000000000005');

  v_job   := (v_claim ->> 'job_id')::uuid;
  v_token := (v_claim ->> 'claim_token')::uuid;
  v_gen   := (v_claim ->> 'job_generation')::bigint;

  PERFORM public.record_instagram_collection_job_progress(
    v_job, v_token, v_gen,
    jsonb_build_object(
      'kind', 'inventory',
      'pages_fetched', 4,
      'oldest_returned_at', '2026-09-15T00:00:00Z',
      'window_start', '2026-07-29',
      'window_end', '2026-10-27',
      'partial', true,
      'truncated', true,
      'window_covered', false,
      'gap_reason', 'cap_reached'));

  BEGIN
    PERFORM public.complete_instagram_collection_job(
      v_job, v_token, v_gen, 'completed', NULL);
    RAISE EXCEPTION 'D10b failed: a truncated inventory completed'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT LIKE '%IG_COLLECTION_INVENTORY_TRUNCATED%' THEN
      RAISE EXCEPTION 'D10b expected IG_COLLECTION_INVENTORY_TRUNCATED, got: %', SQLERRM;
    END IF;
  END;

  ASSERT (SELECT inventory_truncated FROM public.instagram_collection_job_checkpoints
           WHERE job_id = v_job AND job_generation = v_gen),
    'D10b the truncation is visible in the checkpoint';

  -- An uncovered inventory is refused as well.
  PERFORM public.record_instagram_collection_job_progress(
    v_job, v_token, v_gen,
    jsonb_build_object(
      'kind', 'inventory',
      'truncated', false,
      'window_covered', false));

  BEGIN
    PERFORM public.complete_instagram_collection_job(
      v_job, v_token, v_gen, 'completed', NULL);
    RAISE EXCEPTION 'D10b failed: an uncovered inventory completed'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT LIKE '%IG_COLLECTION_COVERAGE_INCOMPLETE%' THEN
      RAISE EXCEPTION 'D10b expected IG_COLLECTION_COVERAGE_INCOMPLETE, got: %', SQLERRM;
    END IF;
  END;

  -- With the coverage established and every operation finished, a full
  -- success is accepted.
  PERFORM public.record_instagram_collection_job_progress(
    v_job, v_token, v_gen,
    jsonb_build_object(
      'kind', 'inventory',
      'truncated', false,
      'window_covered', true));

  PERFORM public.persist_instagram_collection_snapshot(
    v_job, v_token, v_gen,
    jsonb_build_object(
      'kind', 'owner_media',
      'items', jsonb_build_array(jsonb_build_object(
        'ig_media_id', 'ig-m-complete',
        'published_at', '2026-10-24T10:00:00Z',
        'status', 'ok',
        'metrics', jsonb_build_object('views', 11)))));

  v_result := public.complete_instagram_collection_job(
    v_job, v_token, v_gen, 'completed', NULL);

  ASSERT (v_result ->> 'status') = 'completed',
    'D10b the fully covered job completed';
  ASSERT (SELECT last_success_at FROM public.instagram_collection_jobs
           WHERE id = v_job) IS NOT NULL,
    'D10b the full success advanced the success marker';
END
$d10b$;

-- ===========================================================================
-- D11 - the bounds and the metric rules.
-- ===========================================================================
DO $d11$
DECLARE
  v_claim  jsonb;
  v_job    uuid;
  v_token  uuid;
  v_gen    bigint;
  v_result jsonb;
BEGIN
  v_result := public.enqueue_instagram_collection_jobs_service(
    'aa000000-0000-4000-8000-000000000001',
    jsonb_build_array(jsonb_build_object(
      'target_kind', 'owner',
      'target_id', 'a1000000-0000-4000-8000-000000000004',
      'mode', 'normal')));
  ASSERT (v_result ->> 'accepted')::integer = 1,
    'D11 the fourth account was enqueued';

  SELECT * INTO v_claim
    FROM public.claim_instagram_collection_jobs('owner', 100) AS c
   WHERE c ->> 'job_id' = (SELECT id::text FROM public.instagram_collection_jobs
                            WHERE social_account_id = 'a1000000-0000-4000-8000-000000000004');

  v_job   := (v_claim ->> 'job_id')::uuid;
  v_token := (v_claim ->> 'claim_token')::uuid;
  v_gen   := (v_claim ->> 'job_generation')::bigint;

  -- An unknown metric key is refused.
  BEGIN
    PERFORM public.persist_instagram_collection_snapshot(
      v_job, v_token, v_gen,
      jsonb_build_object(
        'kind', 'owner_media',
        'items', jsonb_build_array(jsonb_build_object(
          'ig_media_id', 'ig-m-bad',
          'published_at', '2026-10-18T10:00:00Z',
          'metrics', jsonb_build_object('followers_count', 5)))));
    RAISE EXCEPTION 'D11 failed: a metric outside the whitelist was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT LIKE '%IG_COLLECTION_INVALID_PAYLOAD%' THEN
      RAISE EXCEPTION 'D11 expected IG_COLLECTION_INVALID_PAYLOAD, got: %', SQLERRM;
    END IF;
  END;

  -- A negative metric is refused rather than stored.
  BEGIN
    PERFORM public.persist_instagram_collection_snapshot(
      v_job, v_token, v_gen,
      jsonb_build_object(
        'kind', 'owner_media',
        'items', jsonb_build_array(jsonb_build_object(
          'ig_media_id', 'ig-m-bad',
          'published_at', '2026-10-18T10:00:00Z',
          'metrics', jsonb_build_object('views', -1)))));
    RAISE EXCEPTION 'D11 failed: a negative metric was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT LIKE '%IG_COLLECTION_METRIC_INVALID%' THEN
      RAISE EXCEPTION 'D11 expected IG_COLLECTION_METRIC_INVALID, got: %', SQLERRM;
    END IF;
  END;

  -- A fractional metric is refused too.
  BEGIN
    PERFORM public.persist_instagram_collection_snapshot(
      v_job, v_token, v_gen,
      jsonb_build_object(
        'kind', 'owner_media',
        'items', jsonb_build_array(jsonb_build_object(
          'ig_media_id', 'ig-m-bad',
          'published_at', '2026-10-18T10:00:00Z',
          'metrics', jsonb_build_object('views', 1.5)))));
    RAISE EXCEPTION 'D11 failed: a fractional metric was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT LIKE '%IG_COLLECTION_METRIC_INVALID%' THEN
      RAISE EXCEPTION 'D11 expected IG_COLLECTION_METRIC_INVALID, got: %', SQLERRM;
    END IF;
  END;

  -- An unknown snapshot kind is refused: there is no way to name a table.
  BEGIN
    PERFORM public.persist_instagram_collection_snapshot(
      v_job, v_token, v_gen,
      jsonb_build_object('kind', 'drop_table', 'items', '[]'::jsonb));
    RAISE EXCEPTION 'D11 failed: an unknown snapshot kind was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT LIKE '%IG_COLLECTION_INVALID_PAYLOAD%' THEN
      RAISE EXCEPTION 'D11 expected IG_COLLECTION_INVALID_PAYLOAD, got: %', SQLERRM;
    END IF;
  END;

  -- The item batch is bounded.
  BEGIN
    PERFORM public.persist_instagram_collection_snapshot(
      v_job, v_token, v_gen,
      jsonb_build_object(
        'kind', 'owner_media',
        'items', (SELECT jsonb_agg(jsonb_build_object(
                    'ig_media_id', 'ig-m-' || g,
                    'published_at', '2026-10-18T10:00:00Z'))
                  FROM generate_series(1, 101) g)));
    RAISE EXCEPTION 'D11 failed: an oversized item batch was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT LIKE '%IG_COLLECTION_BATCH_TOO_LARGE%' THEN
      RAISE EXCEPTION 'D11 expected IG_COLLECTION_BATCH_TOO_LARGE, got: %', SQLERRM;
    END IF;
  END;

  -- The operation batch is bounded.
  BEGIN
    PERFORM public.record_instagram_collection_job_progress(
      v_job, v_token, v_gen,
      jsonb_build_object(
        'kind', 'operations',
        'items', (SELECT jsonb_agg(jsonb_build_object(
                    'operation_key', 'media:ig-m-' || g,
                    'operation_kind', 'media',
                    'state', 'pending'))
                  FROM generate_series(1, 201) g)));
    RAISE EXCEPTION 'D11 failed: an oversized operation batch was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT LIKE '%IG_COLLECTION_BATCH_TOO_LARGE%' THEN
      RAISE EXCEPTION 'D11 expected IG_COLLECTION_BATCH_TOO_LARGE, got: %', SQLERRM;
    END IF;
  END;

  -- The remaining-id list is bounded.
  BEGIN
    PERFORM public.record_instagram_collection_job_progress(
      v_job, v_token, v_gen,
      jsonb_build_object(
        'kind', 'inventory',
        'remaining_ids', (SELECT jsonb_agg(to_jsonb('ig-m-' || g))
                            FROM generate_series(1, 501) g)));
    RAISE EXCEPTION 'D11 failed: an oversized remaining-id list was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT LIKE '%IG_COLLECTION_BATCH_TOO_LARGE%' THEN
      RAISE EXCEPTION 'D11 expected IG_COLLECTION_BATCH_TOO_LARGE, got: %', SQLERRM;
    END IF;
  END;

  -- A cursor is an opaque provider token, never a URL and never a token.
  BEGIN
    PERFORM public.record_instagram_collection_job_progress(
      v_job, v_token, v_gen,
      jsonb_build_object(
        'kind', 'inventory',
        'cursor', 'https://graph.facebook.com/v22.0/me/media?after=abc'));
    RAISE EXCEPTION 'D11 failed: a provider URL was accepted as a cursor'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT LIKE '%IG_COLLECTION_INVALID_PAYLOAD%' THEN
      RAISE EXCEPTION 'D11 expected IG_COLLECTION_INVALID_PAYLOAD, got: %', SQLERRM;
    END IF;
  END;

  BEGIN
    PERFORM public.record_instagram_collection_job_progress(
      v_job, v_token, v_gen,
      jsonb_build_object(
        'kind', 'inventory',
        'cursor', 'abc?access_token=SECRET'));
    RAISE EXCEPTION 'D11 failed: a credential-bearing cursor was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT LIKE '%IG_COLLECTION_INVALID_PAYLOAD%' THEN
      RAISE EXCEPTION 'D11 expected IG_COLLECTION_INVALID_PAYLOAD, got: %', SQLERRM;
    END IF;
  END;

  -- A reason code is a typed token, never provider text.
  BEGIN
    PERFORM public.complete_instagram_collection_job(
      v_job, v_token, v_gen, 'error', 'Error: {"message": "token ABC123 is invalid"}');
    RAISE EXCEPTION 'D11 failed: provider text was accepted as a reason code'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT LIKE '%IG_COLLECTION_REASON_INVALID%' THEN
      RAISE EXCEPTION 'D11 expected IG_COLLECTION_REASON_INVALID, got: %', SQLERRM;
    END IF;
  END;

  -- Nothing landed.
  ASSERT (SELECT count(*) FROM public.ig_media_insight_snapshots
           WHERE ig_media_id = 'ig-m-bad') = 0,
    'D11 no refused payload left a snapshot behind';
END
$d11$;

-- ===========================================================================
-- D12 - the owner status projection.
-- ===========================================================================
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'aa000000-0000-4000-8000-000000000001', true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);

DO $d12$
DECLARE
  v_status jsonb;
  v_text   text;
BEGIN
  v_status := public.read_instagram_collection_job_status(
    'owner', 'a1000000-0000-4000-8000-000000000001', NULL);

  ASSERT v_status ->> 'status' IS NOT NULL,
    'D12 the owner reads their own job status';
  ASSERT v_status ? 'last_success_at',
    'D12 the projection carries the success marker';
  ASSERT v_status ? 'inventory',
    'D12 the projection carries the inventory flags';

  v_text := v_status::text;

  ASSERT v_text NOT ILIKE '%claim_token%',
    'D12 the projection carries no lease token';
  ASSERT v_text NOT ILIKE '%lease_expires_at%',
    'D12 the projection carries no lease expiry';
  ASSERT v_text NOT ILIKE '%cursor%',
    'D12 the projection carries no cursor';
  ASSERT v_text NOT ILIKE '%remaining_ids%',
    'D12 the projection carries no remaining ids';
  ASSERT v_text NOT ILIKE '%access_token%',
    'D12 the projection carries no credential';

  -- Another owner's target is not readable.
  BEGIN
    PERFORM public.read_instagram_collection_job_status(
      'owner', 'b1000000-0000-4000-8000-000000000001', NULL);
    RAISE EXCEPTION 'D12 failed: owner A read owner B''s status'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT LIKE '%IG_COLLECTION_TARGET_NOT_FOUND%' THEN
      RAISE EXCEPTION 'D12 expected IG_COLLECTION_TARGET_NOT_FOUND, got: %', SQLERRM;
    END IF;
  END;
END
$d12$;

RESET ROLE;

-- Back to the service role for the sections that drive the worker path.
SELECT set_config('request.jwt.claim.role', 'service_role', true);

-- ===========================================================================
-- D13 - the parent delete and the cross-owner negative.
-- ===========================================================================
DO $d13$
DECLARE
  v_jobs integer;
BEGIN
  -- The service role cannot write a cross-owner job row: the composite
  -- foreign key refuses it.
  BEGIN
    INSERT INTO public.instagram_collection_jobs
      (user_id, target_kind, target_id, social_account_id, captured_on)
    VALUES
      ('bb000000-0000-4000-8000-000000000002', 'owner',
       'a1000000-0000-4000-8000-000000000001',
       'a1000000-0000-4000-8000-000000000001', current_date);
    RAISE EXCEPTION 'D13 failed: the service role wrote a cross-owner job'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN foreign_key_violation THEN
    ASSERT SQLSTATE = '23503',
      'D13 a foreign key refusal is SQLSTATE 23503, got ' || SQLSTATE;
  END;

  -- The same for an operation row.
  BEGIN
    INSERT INTO public.instagram_collection_job_operations
      (job_id, user_id, job_generation, operation_key, operation_kind, state)
    SELECT id, 'bb000000-0000-4000-8000-000000000002', 1, 'media:forged', 'media', 'pending'
      FROM public.instagram_collection_jobs
     WHERE social_account_id = 'a1000000-0000-4000-8000-000000000004'
     LIMIT 1;
    RAISE EXCEPTION 'D13 failed: the service role wrote a cross-owner operation'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN foreign_key_violation THEN
    ASSERT SQLSTATE = '23503',
      'D13 a foreign key refusal is SQLSTATE 23503, got ' || SQLSTATE;
  END;

  -- Deleting the parent account cascades the work.
  SELECT count(*) INTO v_jobs
    FROM public.instagram_collection_jobs
   WHERE social_account_id = 'a1000000-0000-4000-8000-000000000004';

  ASSERT v_jobs = 1, 'D13 the fourth account has a job before the delete';

  DELETE FROM public.social_accounts
   WHERE id = 'a1000000-0000-4000-8000-000000000004';

  SELECT count(*) INTO v_jobs
    FROM public.instagram_collection_jobs
   WHERE social_account_id = 'a1000000-0000-4000-8000-000000000004';

  ASSERT v_jobs = 0, 'D13 deleting the account cascaded its job';

  ASSERT (SELECT count(*) = 0 FROM public.instagram_collection_job_operations o
           WHERE NOT EXISTS (SELECT 1 FROM public.instagram_collection_jobs j
                              WHERE j.id = o.job_id)),
    'D13 no operation outlived its job';

  -- Deleting a tracked competitor cascades its work too.
  ASSERT (SELECT count(*) = 1 FROM public.instagram_collection_jobs
           WHERE watchlist_id = 'c1000000-0000-4000-8000-000000000001'),
    'D13 the competitor job exists before the delete';

  DELETE FROM public.competitor_watchlist
   WHERE id = 'c1000000-0000-4000-8000-000000000001';

  ASSERT (SELECT count(*) = 0 FROM public.instagram_collection_jobs
           WHERE watchlist_id = 'c1000000-0000-4000-8000-000000000001'),
    'D13 deleting the watchlist entry cascaded its job';
END
$d13$;

-- ===========================================================================
-- D14 - the provider throttle and the backoff ladder.
-- ===========================================================================
DO $d14$
DECLARE
  v_claim  jsonb;
  v_job    uuid;
  v_token  uuid;
  v_gen    bigint;
  v_result jsonb;
  v_bucket constant text := '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
BEGIN
  -- The bucket key must be a digest, not a credential.
  BEGIN
    PERFORM public.record_instagram_provider_throttle(
      'not-a-digest', 85, now() + interval '5 minutes', NULL, NULL, NULL);
    RAISE EXCEPTION 'D14 failed: a non-digest bucket key was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT LIKE '%IG_COLLECTION_INVALID_BUCKET_KEY%' THEN
      RAISE EXCEPTION 'D14 expected IG_COLLECTION_INVALID_BUCKET_KEY, got: %', SQLERRM;
    END IF;
  END;

  -- The usage percent is bounded.
  BEGIN
    PERFORM public.record_instagram_provider_throttle(
      v_bucket, 120, now() + interval '5 minutes', NULL, NULL, NULL);
    RAISE EXCEPTION 'D14 failed: an out-of-range usage percent was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT LIKE '%IG_COLLECTION_INVALID_USAGE%' THEN
      RAISE EXCEPTION 'D14 expected IG_COLLECTION_INVALID_USAGE, got: %', SQLERRM;
    END IF;
  END;

  v_result := public.record_instagram_provider_throttle(
    v_bucket, 85, now() + interval '5 minutes', NULL, NULL, NULL);

  ASSERT (v_result ->> 'bucket_key') = v_bucket,
    'D14 the bucket was recorded';
  ASSERT (SELECT usage_percent FROM public.instagram_provider_throttle_buckets
           WHERE bucket_key = v_bucket) = 85,
    'D14 the shared usage is persisted';
  ASSERT (SELECT throttled_until FROM public.instagram_provider_throttle_buckets
           WHERE bucket_key = v_bucket) IS NOT NULL,
    'D14 the shared backoff is persisted';

  -- A job-scoped throttle parks the job under the claim fence.
  v_result := public.enqueue_instagram_collection_jobs_service(
    'aa000000-0000-4000-8000-000000000001',
    jsonb_build_array(jsonb_build_object(
      'target_kind', 'owner',
      'target_id', 'a1000000-0000-4000-8000-000000000006',
      'mode', 'normal')));
  ASSERT (v_result ->> 'accepted')::integer = 1,
    'D14 the sixth account was enqueued';

  SELECT * INTO v_claim
    FROM public.claim_instagram_collection_jobs('owner', 100) AS c
   WHERE c ->> 'job_id' = (SELECT id::text FROM public.instagram_collection_jobs
                            WHERE social_account_id = 'a1000000-0000-4000-8000-000000000006');

  v_job   := (v_claim ->> 'job_id')::uuid;
  v_token := (v_claim ->> 'claim_token')::uuid;
  v_gen   := (v_claim ->> 'job_generation')::bigint;

  v_result := public.record_instagram_provider_throttle(
    v_bucket, 85, now() + interval '5 minutes', v_job, v_token, v_gen);

  ASSERT (v_result ->> 'status') = 'retry',
    'D14 the throttled job was parked as a retry';
  ASSERT (SELECT status FROM public.instagram_collection_jobs WHERE id = v_job) = 'retry',
    'D14 the job status is retry';
  ASSERT (SELECT due_at FROM public.instagram_collection_jobs WHERE id = v_job) > now(),
    'D14 the parked job is scheduled in the future';
  ASSERT (SELECT last_reason_code FROM public.instagram_collection_jobs
           WHERE id = v_job) = 'provider_throttled',
    'D14 the parked job carries the typed reason';

  -- A stale worker cannot park the job.
  BEGIN
    PERFORM public.record_instagram_provider_throttle(
      v_bucket, 90, now() + interval '5 minutes', v_job, gen_random_uuid(), v_gen);
    RAISE EXCEPTION 'D14 failed: a stale worker parked the job'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT LIKE '%IG_COLLECTION_CLAIM_STALE%' THEN
      RAISE EXCEPTION 'D14 expected IG_COLLECTION_CLAIM_STALE, got: %', SQLERRM;
    END IF;
  END;

  -- The backoff ladder is capped.
  ASSERT public.ig_collection_backoff_interval(1) = interval '1 minute',
    'D14 the first backoff is one minute';
  ASSERT public.ig_collection_backoff_interval(2) = interval '5 minutes',
    'D14 the second backoff is five minutes';
  ASSERT public.ig_collection_backoff_interval(3) = interval '15 minutes',
    'D14 the third backoff is fifteen minutes';
  ASSERT public.ig_collection_backoff_interval(4) = interval '1 hour',
    'D14 the fourth backoff is one hour';
  ASSERT public.ig_collection_backoff_interval(99) = interval '6 hours',
    'D14 the backoff is capped at six hours';
END
$d14$;

-- ===========================================================================
-- D15 - a force bumps the generation and retires the live claim.
-- ===========================================================================
DO $d15$
DECLARE
  v_claim  jsonb;
  v_job    uuid;
  v_token  uuid;
  v_gen    bigint;
  v_result jsonb;
BEGIN
  v_result := public.enqueue_instagram_collection_jobs_service(
    'aa000000-0000-4000-8000-000000000001',
    jsonb_build_array(jsonb_build_object(
      'target_kind', 'owner',
      'target_id', 'a1000000-0000-4000-8000-000000000007',
      'mode', 'normal')));
  ASSERT (v_result ->> 'accepted')::integer = 1,
    'D15 the seventh account was enqueued';

  SELECT * INTO v_claim
    FROM public.claim_instagram_collection_jobs('owner', 100) AS c
   WHERE c ->> 'job_id' = (SELECT id::text FROM public.instagram_collection_jobs
                            WHERE social_account_id = 'a1000000-0000-4000-8000-000000000007');

  v_job   := (v_claim ->> 'job_id')::uuid;
  v_token := (v_claim ->> 'claim_token')::uuid;
  v_gen   := (v_claim ->> 'job_generation')::bigint;

  -- Some work from the first revision, so the force has history to leave
  -- alone.
  PERFORM public.record_instagram_collection_job_progress(
    v_job, v_token, v_gen,
    jsonb_build_object(
      'kind', 'operations',
      'items', jsonb_build_array(jsonb_build_object(
        'operation_key', 'media:ig-m-gen1',
        'operation_kind', 'media',
        'state', 'pending'))));

  -- The owner forces a re-collection. The caller identity is the session
  -- claim, which is what the function checks.
  PERFORM set_config('request.jwt.claim.sub', 'aa000000-0000-4000-8000-000000000001', true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);

  v_result := public.enqueue_instagram_collection_job(
    'owner', 'a1000000-0000-4000-8000-000000000007', 'force');

  PERFORM set_config('request.jwt.claim.role', 'service_role', true);

  ASSERT (v_result ->> 'accepted')::boolean,
    'D15 the force was accepted';
  ASSERT (v_result ->> 'reason') = 'forced',
    'D15 the force carries the typed reason';
  ASSERT (v_result ->> 'job_generation')::bigint = v_gen + 1,
    'D15 the force bumped the job generation';

  ASSERT (SELECT status FROM public.instagram_collection_jobs WHERE id = v_job) = 'queued',
    'D15 the forced job is queued';
  ASSERT (SELECT lease_token FROM public.instagram_collection_jobs WHERE id = v_job) IS NULL,
    'D15 the force retired the live lease';
  ASSERT (SELECT context_credential_generation
            FROM public.instagram_collection_jobs WHERE id = v_job) IS NULL,
    'D15 the force cleared the connection context';

  -- The retired claim can no longer write.
  BEGIN
    PERFORM public.persist_instagram_collection_snapshot(
      v_job, v_token, v_gen,
      jsonb_build_object(
        'kind', 'owner_media',
        'items', jsonb_build_array(jsonb_build_object(
          'ig_media_id', 'ig-m-stale',
          'published_at', '2026-10-18T10:00:00Z',
          'metrics', jsonb_build_object('views', 1)))));
    RAISE EXCEPTION 'D15 failed: the retired claim wrote a snapshot'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT LIKE '%IG_COLLECTION_CLAIM_STALE%' THEN
      RAISE EXCEPTION 'D15 expected IG_COLLECTION_CLAIM_STALE, got: %', SQLERRM;
    END IF;
  END;

  ASSERT (SELECT count(*) FROM public.ig_media_insight_snapshots
           WHERE ig_media_id = 'ig-m-stale') = 0,
    'D15 the retired claim left no snapshot behind';

  -- The previous generation's history is untouched.
  ASSERT (SELECT count(*) FROM public.instagram_collection_job_operations
           WHERE job_id = v_job AND job_generation = v_gen) = 1,
    'D15 the previous generation keeps its history';

  -- And the new revision starts with no checkpoints of its own.
  ASSERT (SELECT count(*) FROM public.instagram_collection_job_operations
           WHERE job_id = v_job AND job_generation = v_gen + 1) = 0,
    'D15 the forced revision starts empty';

  -- A normal enqueue after the force does not discard it. The window the
  -- force consumed is expired first, so the normal request actually reaches
  -- the job row.
  UPDATE public.instagram_collection_request_throttles
     SET last_accepted_at = now() - interval '20 minutes'
   WHERE target_id = 'a1000000-0000-4000-8000-000000000007';

  PERFORM set_config('request.jwt.claim.sub', 'aa000000-0000-4000-8000-000000000001', true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);

  v_result := public.enqueue_instagram_collection_job(
    'owner', 'a1000000-0000-4000-8000-000000000007', 'normal');

  PERFORM set_config('request.jwt.claim.role', 'service_role', true);

  ASSERT (v_result ->> 'accepted')::boolean,
    'D15 the normal enqueue after the force was accepted';
  ASSERT (v_result ->> 'reason') = 'already_enqueued',
    'D15 the normal enqueue found the existing row';
  ASSERT (SELECT job_generation FROM public.instagram_collection_jobs
           WHERE id = v_job) = v_gen + 1,
    'D15 the normal enqueue did not discard the force';
END
$d15$;

-- ===========================================================================
-- D16 - an expired lease is recoverable.
-- ===========================================================================
DO $d16$
DECLARE
  v_claim  jsonb;
  v_job    uuid;
  v_first  uuid;
  v_second uuid;
  v_result jsonb;
BEGIN
  v_result := public.enqueue_instagram_collection_jobs_service(
    'aa000000-0000-4000-8000-000000000001',
    jsonb_build_array(jsonb_build_object(
      'target_kind', 'owner',
      'target_id', 'a1000000-0000-4000-8000-000000000008',
      'mode', 'normal')));
  ASSERT (v_result ->> 'accepted')::integer = 1,
    'D16 the eighth account was enqueued';

  SELECT * INTO v_claim
    FROM public.claim_instagram_collection_jobs('owner', 100) AS c
   WHERE c ->> 'job_id' = (SELECT id::text FROM public.instagram_collection_jobs
                            WHERE social_account_id = 'a1000000-0000-4000-8000-000000000008');

  v_job   := (v_claim ->> 'job_id')::uuid;
  v_first := (v_claim ->> 'claim_token')::uuid;

  ASSERT v_first IS NOT NULL, 'D16 the job was claimed';

  -- The worker died: the lease runs out.
  UPDATE public.instagram_collection_jobs
     SET lease_expires_at = now() - interval '1 minute'
   WHERE id = v_job;

  SELECT * INTO v_claim
    FROM public.claim_instagram_collection_jobs('owner', 100) AS c
   WHERE c ->> 'job_id' = v_job::text;

  ASSERT FOUND, 'D16 the expired lease was recoverable';
  v_second := (v_claim ->> 'claim_token')::uuid;

  ASSERT v_second <> v_first,
    'D16 the recovered claim has a new token';
  ASSERT (SELECT attempts FROM public.instagram_collection_jobs WHERE id = v_job) = 2,
    'D16 the recovered attempt was counted';

  -- The old token is dead.
  BEGIN
    PERFORM public.record_instagram_collection_job_progress(
      v_job, v_first, 1, jsonb_build_object('kind', 'inventory', 'pages_fetched', 1));
    RAISE EXCEPTION 'D16 failed: the expired token still worked'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT LIKE '%IG_COLLECTION_CLAIM_STALE%' THEN
      RAISE EXCEPTION 'D16 expected IG_COLLECTION_CLAIM_STALE, got: %', SQLERRM;
    END IF;
  END;
END
$d16$;

-- ===========================================================================
-- D17 - the scheduled enqueue is idempotent.
--
-- The service path is the cron / admin boundary. It takes the owner as an
-- argument and verifies it against the target row.
-- ===========================================================================
DO $d17$
DECLARE
  v_first  jsonb;
  v_second jsonb;
  v_jobs   integer;
BEGIN
  v_first := public.enqueue_instagram_collection_jobs_service(
    'aa000000-0000-4000-8000-000000000001',
    jsonb_build_array(jsonb_build_object(
      'target_kind', 'owner',
      'target_id', 'a1000000-0000-4000-8000-000000000009',
      'mode', 'normal')));

  v_second := public.enqueue_instagram_collection_jobs_service(
    'aa000000-0000-4000-8000-000000000001',
    jsonb_build_array(jsonb_build_object(
      'target_kind', 'owner',
      'target_id', 'a1000000-0000-4000-8000-000000000009',
      'mode', 'normal')));

  ASSERT (v_first ->> 'accepted')::integer = 1,
    'D17 the first scheduled enqueue was accepted';
  ASSERT (v_second ->> 'accepted')::integer = 1,
    'D17 the second scheduled enqueue was accepted';
  ASSERT (v_first -> 'results' -> 0 ->> 'job_id')
       = (v_second -> 'results' -> 0 ->> 'job_id'),
    'D17 the repeated scheduled enqueue returned the same job';
  ASSERT (v_first -> 'results' -> 0 ->> 'job_generation')
       = (v_second -> 'results' -> 0 ->> 'job_generation'),
    'D17 the repeated scheduled enqueue did not bump the generation';

  SELECT count(*) INTO v_jobs
    FROM public.instagram_collection_jobs
   WHERE social_account_id = 'a1000000-0000-4000-8000-000000000009';

  ASSERT v_jobs = 1,
    'D17 exactly one job row exists for the scheduled target';

  -- The owner argument is verified against the target, not trusted.
  BEGIN
    PERFORM public.enqueue_instagram_collection_jobs_service(
      'bb000000-0000-4000-8000-000000000002',
      jsonb_build_array(jsonb_build_object(
        'target_kind', 'owner',
        'target_id', 'a1000000-0000-4000-8000-000000000009',
        'mode', 'normal')));
    RAISE EXCEPTION 'D17 failed: the service enqueue took an unverified owner'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT LIKE '%IG_COLLECTION_TARGET_NOT_FOUND%' THEN
      RAISE EXCEPTION 'D17 expected IG_COLLECTION_TARGET_NOT_FOUND, got: %', SQLERRM;
    END IF;
  END;

  -- The batch is bounded.
  BEGIN
    PERFORM public.enqueue_instagram_collection_jobs_service(
      'aa000000-0000-4000-8000-000000000001',
      (SELECT jsonb_agg(jsonb_build_object(
                'target_kind', 'owner',
                'target_id', 'a1000000-0000-4000-8000-000000000009',
                'mode', 'normal'))
         FROM generate_series(1, 51)));
    RAISE EXCEPTION 'D17 failed: an oversized batch was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT LIKE '%IG_COLLECTION_BATCH_TOO_LARGE%' THEN
      RAISE EXCEPTION 'D17 expected IG_COLLECTION_BATCH_TOO_LARGE, got: %', SQLERRM;
    END IF;
  END;
END
$d17$;

-- ===========================================================================
-- D19 - captured-context invalidation, a dead lease, and a foreign job.
--
-- A reclaim whose credential generation or login kind changed advances the
-- job generation. The previous generation's terminal operation stays history
-- and cannot be reported as a new success. A reclaim whose generation still
-- matches keeps the revision.
-- ===========================================================================
DO $d19$
DECLARE
  v_claim   jsonb;
  v_job     uuid;
  v_token   uuid;
  v_gen     bigint;
  v_again   jsonb;
  v_live    bigint;
BEGIN
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);

  PERFORM public.enqueue_instagram_collection_jobs_service(
    'aa000000-0000-4000-8000-000000000001',
    jsonb_build_array(jsonb_build_object(
      'target_kind', 'owner',
      'target_id', 'a1000000-0000-4000-8000-000000000003',
      'mode', 'normal')));

  SELECT * INTO v_claim
    FROM public.claim_instagram_collection_jobs('owner', 100) AS c
   WHERE c ->> 'social_account_id' = 'a1000000-0000-4000-8000-000000000003';

  ASSERT FOUND, 'D19 the direct-login owner job was claimed';
  v_job   := (v_claim ->> 'job_id')::uuid;
  v_token := (v_claim ->> 'claim_token')::uuid;
  v_gen   := (v_claim ->> 'job_generation')::bigint;
  ASSERT v_gen = 1, 'D19 the first claim is generation 1';
  ASSERT (v_claim -> 'context' ->> 'login_kind') = 'direct',
    'D19 the claim captured the direct login kind';

  PERFORM public.record_instagram_collection_job_progress(
    v_job, v_token, v_gen,
    jsonb_build_object(
      'kind', 'operations',
      'items', jsonb_build_array(jsonb_build_object(
        'operation_key', 'media:ig-d19-open',
        'operation_kind', 'media',
        'state', 'pending'))));

  PERFORM public.persist_instagram_collection_snapshot(
    v_job, v_token, v_gen,
    jsonb_build_object(
      'kind', 'owner_media',
      'items', jsonb_build_array(jsonb_build_object(
        'ig_media_id', 'ig-d19-done',
        'published_at', '2026-10-20T10:00:00Z',
        'status', 'ok',
        'metrics', jsonb_build_object('views', 4)))));

  -- Same connection: reclaim keeps the revision and its history.
  UPDATE public.instagram_collection_jobs
     SET lease_expires_at = clock_timestamp() - interval '1 second'
   WHERE id = v_job;

  SELECT * INTO v_again
    FROM public.claim_instagram_collection_jobs('owner', 100) AS c
   WHERE c ->> 'job_id' = v_job::text;

  ASSERT FOUND, 'D19 a same-generation lease was recoverable';
  ASSERT (v_again ->> 'job_generation')::bigint = v_gen,
    'D19 a matching credential generation did not bump the job';
  ASSERT (SELECT count(*) FROM public.instagram_collection_job_operations
           WHERE job_id = v_job AND job_generation = v_gen AND state = 'success') = 1,
    'D19 the same-generation reclaim kept the captured operation';
  v_token := (v_again ->> 'claim_token')::uuid;

  -- The live token, with the lease already in the past, writes nothing.
  UPDATE public.instagram_collection_jobs
     SET lease_expires_at = clock_timestamp() - interval '1 second'
   WHERE id = v_job;

  BEGIN
    PERFORM public.record_instagram_collection_job_progress(
      v_job, v_token, v_gen,
      jsonb_build_object('kind', 'inventory', 'pages_fetched', 77));
    RAISE EXCEPTION 'D19 failed: an expired lease still recorded progress'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT LIKE '%IG_COLLECTION_CLAIM_STALE%' THEN
      RAISE EXCEPTION 'D19 expected IG_COLLECTION_CLAIM_STALE, got: %', SQLERRM;
    END IF;
  END;

  ASSERT (SELECT count(*) = 0 FROM public.instagram_collection_job_checkpoints
           WHERE job_id = v_job AND inventory_pages_fetched = 77),
    'D19 the expired lease left no checkpoint';

  -- Restore a live lease, then replace the credential.
  UPDATE public.instagram_collection_jobs
     SET lease_expires_at = clock_timestamp() + interval '5 minutes'
   WHERE id = v_job;

  UPDATE public.instagram_account_capabilities
     SET credential_generation = credential_generation + 1
   WHERE social_account_id = 'a1000000-0000-4000-8000-000000000003';

  SELECT credential_generation INTO v_live
    FROM public.instagram_account_capabilities
   WHERE social_account_id = 'a1000000-0000-4000-8000-000000000003';

  BEGIN
    PERFORM public.record_instagram_collection_job_progress(
      v_job, v_token, v_gen,
      jsonb_build_object('kind', 'inventory', 'pages_fetched', 77));
    RAISE EXCEPTION 'D19 failed: progress landed after the credential changed'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT LIKE '%IG_COLLECTION_CREDENTIAL_CHANGED%' THEN
      RAISE EXCEPTION 'D19 expected IG_COLLECTION_CREDENTIAL_CHANGED, got: %', SQLERRM;
    END IF;
  END;

  BEGIN
    PERFORM public.complete_instagram_collection_job(
      v_job, v_token, v_gen, 'completed', NULL);
    RAISE EXCEPTION 'D19 failed: the old generation was completed after the credential changed'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT LIKE '%IG_COLLECTION_CREDENTIAL_CHANGED%' THEN
      RAISE EXCEPTION 'D19 expected IG_COLLECTION_CREDENTIAL_CHANGED from completion, got: %', SQLERRM;
    END IF;
  END;

  UPDATE public.instagram_collection_jobs
     SET lease_expires_at = clock_timestamp() - interval '1 second'
   WHERE id = v_job;

  SELECT * INTO v_again
    FROM public.claim_instagram_collection_jobs('owner', 100) AS c
   WHERE c ->> 'job_id' = v_job::text;

  ASSERT (v_again ->> 'job_generation')::bigint = v_gen + 1,
    'D19 a changed credential generation advanced the job generation';
  ASSERT (v_again -> 'context' ->> 'credential_generation')::bigint = v_live,
    'D19 the new revision captured the new credential generation';
  ASSERT (SELECT count(*) FROM public.instagram_collection_job_operations
           WHERE job_id = v_job AND job_generation = v_gen AND state = 'success') = 1,
    'D19 the previous generation kept its terminal operation';
  ASSERT (SELECT count(*) FROM public.instagram_collection_job_operations
           WHERE job_id = v_job AND job_generation = v_gen + 1) = 0,
    'D19 the new revision did not inherit the old operations';

  v_token := (v_again ->> 'claim_token')::uuid;

  BEGIN
    PERFORM public.complete_instagram_collection_job(
      v_job, v_token, v_gen + 1, 'completed', NULL);
    RAISE EXCEPTION 'D19 failed: old-generation work was reported as newly complete'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT LIKE '%IG_COLLECTION_NOTHING_CAPTURED%'
       AND SQLERRM NOT LIKE '%IG_COLLECTION_COVERAGE_INCOMPLETE%'
       AND SQLERRM NOT LIKE '%IG_COLLECTION_INCOMPLETE%' THEN
      RAISE EXCEPTION 'D19 expected a not-complete refusal, got: %', SQLERRM;
    END IF;
  END;

  ASSERT (SELECT last_success_at FROM public.instagram_collection_jobs WHERE id = v_job) IS NULL,
    'D19 the new revision did not advance last_success_at';

  -- A login-kind change is the same invalidation, even when the generation
  -- number is unchanged.
  UPDATE public.instagram_collection_jobs
     SET lease_expires_at = clock_timestamp() - interval '1 second'
   WHERE id = v_job;

  UPDATE public.instagram_account_capabilities
     SET login_kind = 'page_linked'
   WHERE social_account_id = 'a1000000-0000-4000-8000-000000000003';

  SELECT * INTO v_again
    FROM public.claim_instagram_collection_jobs('owner', 100) AS c
   WHERE c ->> 'job_id' = v_job::text;

  ASSERT (v_again ->> 'job_generation')::bigint = v_gen + 2,
    'D19 a changed login kind advanced the job generation';
  ASSERT (v_again -> 'context' ->> 'login_kind') = 'page_linked',
    'D19 the new revision captured the new login kind';
  ASSERT (SELECT count(*) FROM public.instagram_collection_job_operations
           WHERE job_id = v_job AND job_generation = v_gen AND state = 'success') = 1,
    'D19 the login-kind change left the old operation in place';

  -- A job id that is not this owner's work is not a write target.
  BEGIN
    PERFORM public.record_instagram_collection_job_progress(
      'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      (v_again ->> 'claim_token')::uuid,
      (v_again ->> 'job_generation')::bigint,
      jsonb_build_object('kind', 'inventory', 'pages_fetched', 1));
    RAISE EXCEPTION 'D19 failed: a foreign job id accepted progress'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT LIKE '%IG_COLLECTION_JOB_NOT_FOUND%' THEN
      RAISE EXCEPTION 'D19 expected IG_COLLECTION_JOB_NOT_FOUND, got: %', SQLERRM;
    END IF;
  END;

  -- needs_reauth is not a usable target for a result write.
  UPDATE public.social_accounts
     SET needs_reauth = true
   WHERE id = 'a1000000-0000-4000-8000-000000000003';

  BEGIN
    PERFORM public.record_instagram_collection_job_progress(
      v_job,
      (v_again ->> 'claim_token')::uuid,
      (v_again ->> 'job_generation')::bigint,
      jsonb_build_object('kind', 'inventory', 'pages_fetched', 3));
    RAISE EXCEPTION 'D19 failed: progress landed for an account that needs reauth'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT LIKE '%IG_COLLECTION_TARGET_INACTIVE%' THEN
      RAISE EXCEPTION 'D19 expected IG_COLLECTION_TARGET_INACTIVE, got: %', SQLERRM;
    END IF;
  END;

  ASSERT (SELECT count(*) = 0 FROM public.instagram_collection_job_checkpoints
           WHERE job_id = v_job AND inventory_pages_fetched = 3),
    'D19 the reauth refusal left no checkpoint';
END
$d19$;

-- ===========================================================================
-- D20 - terminal-only recovery.
--
-- D19 keeps a pending operation, which the older claim predicate already
-- accepted. This section has no pending or failed row. The same connection
-- must get the job back and complete it from the captured snapshot. A
-- changed connection must get a new generation with an empty revision. A
-- failed operation whose retry is still ahead must stay unclaimed.
-- ===========================================================================
DO $d20$
DECLARE
  u_a       uuid := 'aa000000-0000-4000-8000-000000000001';
  acct_same uuid := 'a1000000-0000-4000-8000-000000000010';
  acct_new  uuid := 'a1000000-0000-4000-8000-000000000011';
  acct_wait uuid := 'a1000000-0000-4000-8000-000000000012';
  v_claim   jsonb;
  v_again   jsonb;
  v_done    jsonb;
  v_job     uuid;
  v_token   uuid;
  v_gen     bigint;
  v_live    bigint;
BEGIN
  INSERT INTO public.social_accounts
    (id, user_id, platform, platform_user_id, platform_username,
     access_token, ig_auth_type)
  VALUES
    (acct_same, u_a, 'instagram', 'ig-a-10', 'igjobs_a10', 'token-a10', 'facebook_page'),
    (acct_new,  u_a, 'instagram', 'ig-a-11', 'igjobs_a11', 'token-a11', 'facebook_page'),
    (acct_wait, u_a, 'instagram', 'ig-a-12', 'igjobs_a12', 'token-a12', 'facebook_page');

  INSERT INTO public.instagram_account_capabilities
    (social_account_id, user_id, platform, login_kind, permission_read_state,
     granted_scopes, scopes_read_at, credential_generation)
  VALUES
    (acct_same, u_a, 'instagram', 'page_linked', 'ok',
     ARRAY['instagram_basic', 'instagram_manage_insights', 'pages_read_engagement'],
     now(), 1),
    (acct_new, u_a, 'instagram', 'page_linked', 'ok',
     ARRAY['instagram_basic', 'instagram_manage_insights', 'pages_read_engagement'],
     now(), 1),
    (acct_wait, u_a, 'instagram', 'page_linked', 'ok',
     ARRAY['instagram_basic', 'instagram_manage_insights', 'pages_read_engagement'],
     now(), 1);

  PERFORM set_config('request.jwt.claim.role', 'service_role', true);
  PERFORM set_config('request.jwt.claim.sub', '', true);

  -- Enqueue one target at a time. A claim returns every due queued job it
  -- can hold, so the later cases must not already be leased.
  PERFORM public.enqueue_instagram_collection_jobs_service(
    u_a, jsonb_build_array(jsonb_build_object(
      'target_kind', 'owner', 'target_id', acct_same, 'mode', 'normal')));

  -- Same connection: covered inventory, one success, crash before complete.
  SELECT * INTO v_claim
    FROM public.claim_instagram_collection_jobs('owner', 100) AS c
   WHERE c ->> 'social_account_id' = acct_same::text;
  ASSERT FOUND, 'D20 the same-connection job was claimed';
  v_job   := (v_claim ->> 'job_id')::uuid;
  v_token := (v_claim ->> 'claim_token')::uuid;
  v_gen   := (v_claim ->> 'job_generation')::bigint;

  PERFORM public.record_instagram_collection_job_progress(
    v_job, v_token, v_gen,
    jsonb_build_object('kind', 'inventory', 'pages_fetched', 1, 'window_covered', true));
  PERFORM public.persist_instagram_collection_snapshot(
    v_job, v_token, v_gen,
    jsonb_build_object(
      'kind', 'owner_media',
      'items', jsonb_build_array(jsonb_build_object(
        'ig_media_id', 'ig-d20-same',
        'published_at', '2026-10-20T10:00:00Z',
        'status', 'ok',
        'metrics', jsonb_build_object('views', 1)))));

  ASSERT NOT EXISTS (
    SELECT 1 FROM public.instagram_collection_job_operations
     WHERE job_id = v_job AND state IN ('pending', 'failed')),
    'D20 the same-connection job has no open operation';
  ASSERT EXISTS (
    SELECT 1 FROM public.instagram_collection_job_operations
     WHERE job_id = v_job AND job_generation = v_gen AND state = 'success'),
    'D20 the same-connection job has a terminal success';

  UPDATE public.instagram_collection_jobs
     SET lease_expires_at = clock_timestamp() - interval '1 second'
   WHERE id = v_job;

  SELECT * INTO v_again
    FROM public.claim_instagram_collection_jobs('owner', 100) AS c
   WHERE c ->> 'job_id' = v_job::text;

  ASSERT FOUND, 'D20 a terminal-only expired job was reclaimed';
  ASSERT (v_again ->> 'job_generation')::bigint = v_gen,
    'D20 the same connection kept the generation';
  ASSERT jsonb_array_length(COALESCE(v_again -> 'pending_operations', '[]'::jsonb)) = 0,
    'D20 the reclaim did not present terminal work as pending';
  ASSERT (v_again -> 'checkpoint' ->> 'inventory_pages_fetched')::integer = 1,
    'D20 the reclaim returned the captured inventory';
  v_token := (v_again ->> 'claim_token')::uuid;

  v_done := public.complete_instagram_collection_job(
    v_job, v_token, v_gen, 'completed', NULL);
  ASSERT (v_done ->> 'status') = 'completed',
    'D20 the same generation completed without a new capture';
  ASSERT (SELECT last_success_at FROM public.instagram_collection_jobs WHERE id = v_job) IS NOT NULL,
    'D20 finalizing the same generation advanced last_success_at';
  ASSERT (SELECT count(*) FROM public.instagram_collection_job_operations
           WHERE job_id = v_job AND job_generation = v_gen AND state = 'success') = 1,
    'D20 completion did not rewrite the terminal operation';

  -- Changed connection: the same terminal shape, then a generation bump.
  PERFORM public.enqueue_instagram_collection_jobs_service(
    u_a, jsonb_build_array(jsonb_build_object(
      'target_kind', 'owner', 'target_id', acct_new, 'mode', 'normal')));

  SELECT * INTO v_claim
    FROM public.claim_instagram_collection_jobs('owner', 100) AS c
   WHERE c ->> 'social_account_id' = acct_new::text;
  ASSERT FOUND, 'D20 the changed-connection job was claimed';
  v_job   := (v_claim ->> 'job_id')::uuid;
  v_token := (v_claim ->> 'claim_token')::uuid;
  v_gen   := (v_claim ->> 'job_generation')::bigint;

  PERFORM public.record_instagram_collection_job_progress(
    v_job, v_token, v_gen,
    jsonb_build_object('kind', 'inventory', 'pages_fetched', 1, 'window_covered', true));
  PERFORM public.persist_instagram_collection_snapshot(
    v_job, v_token, v_gen,
    jsonb_build_object(
      'kind', 'owner_media',
      'items', jsonb_build_array(jsonb_build_object(
        'ig_media_id', 'ig-d20-changed',
        'published_at', '2026-10-20T10:00:00Z',
        'status', 'ok',
        'metrics', jsonb_build_object('views', 2)))));

  UPDATE public.instagram_collection_jobs
     SET lease_expires_at = clock_timestamp() - interval '1 second'
   WHERE id = v_job;
  UPDATE public.instagram_account_capabilities
     SET credential_generation = credential_generation + 1
   WHERE social_account_id = acct_new;
  SELECT credential_generation INTO v_live
    FROM public.instagram_account_capabilities
   WHERE social_account_id = acct_new;

  SELECT * INTO v_again
    FROM public.claim_instagram_collection_jobs('owner', 100) AS c
   WHERE c ->> 'job_id' = v_job::text;

  ASSERT FOUND, 'D20 a terminal-only job was reclaimed after the credential changed';
  ASSERT (v_again ->> 'job_generation')::bigint = v_gen + 1,
    'D20 the changed connection advanced the job generation';
  ASSERT (v_again -> 'context' ->> 'credential_generation')::bigint = v_live,
    'D20 the new revision captured the live credential generation';
  ASSERT COALESCE(v_again -> 'checkpoint', '{}'::jsonb) = '{}'::jsonb,
    'D20 the new revision did not inherit the checkpoint';
  ASSERT (SELECT count(*) FROM public.instagram_collection_job_operations
           WHERE job_id = v_job AND job_generation = v_gen AND state = 'success') = 1,
    'D20 the previous generation kept its success';
  ASSERT (SELECT count(*) FROM public.instagram_collection_job_operations
           WHERE job_id = v_job AND job_generation = v_gen + 1) = 0,
    'D20 the new revision has no operations';
  ASSERT (SELECT count(*) FROM public.instagram_collection_job_checkpoints
           WHERE job_id = v_job AND job_generation = v_gen + 1) = 0,
    'D20 the new revision has no checkpoint row';

  v_token := (v_again ->> 'claim_token')::uuid;
  BEGIN
    PERFORM public.complete_instagram_collection_job(
      v_job, v_token, v_gen + 1, 'completed', NULL);
    RAISE EXCEPTION 'D20 failed: the new revision completed from old successes'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT LIKE '%IG_COLLECTION_NOTHING_CAPTURED%'
       AND SQLERRM NOT LIKE '%IG_COLLECTION_COVERAGE_INCOMPLETE%'
       AND SQLERRM NOT LIKE '%IG_COLLECTION_INCOMPLETE%' THEN
      RAISE EXCEPTION 'D20 expected a not-complete refusal, got: %', SQLERRM;
    END IF;
  END;
  ASSERT (SELECT last_success_at FROM public.instagram_collection_jobs WHERE id = v_job) IS NULL,
    'D20 the new revision did not advance last_success_at';

  -- A failure that is not due yet is not finalized and not retried early.
  PERFORM public.enqueue_instagram_collection_jobs_service(
    u_a, jsonb_build_array(jsonb_build_object(
      'target_kind', 'owner', 'target_id', acct_wait, 'mode', 'normal')));

  SELECT * INTO v_claim
    FROM public.claim_instagram_collection_jobs('owner', 100) AS c
   WHERE c ->> 'social_account_id' = acct_wait::text;
  ASSERT FOUND, 'D20 the waiting-failure job was claimed';
  v_job   := (v_claim ->> 'job_id')::uuid;
  v_token := (v_claim ->> 'claim_token')::uuid;
  v_gen   := (v_claim ->> 'job_generation')::bigint;

  PERFORM public.record_instagram_collection_job_progress(
    v_job, v_token, v_gen,
    jsonb_build_object(
      'kind', 'operations',
      'items', jsonb_build_array(jsonb_build_object(
        'operation_key', 'media:ig-d20-wait',
        'operation_kind', 'media',
        'state', 'failed',
        'retry_at', clock_timestamp() + interval '1 hour',
        'reason_code', 'provider_error'))));

  UPDATE public.instagram_collection_jobs
     SET lease_expires_at = clock_timestamp() - interval '1 second'
   WHERE id = v_job;

  SELECT * INTO v_again
    FROM public.claim_instagram_collection_jobs('owner', 100) AS c
   WHERE c ->> 'job_id' = v_job::text;

  ASSERT NOT FOUND, 'D20 a not-yet-due failure was not reclaimed';
  ASSERT (SELECT state FROM public.instagram_collection_job_operations
           WHERE job_id = v_job AND operation_key = 'media:ig-d20-wait') = 'failed',
    'D20 the waiting failure stayed failed';
  ASSERT (SELECT status FROM public.instagram_collection_jobs WHERE id = v_job) = 'leased',
    'D20 the waiting failure stayed on its expired lease';
END
$d20$;

-- ===========================================================================
-- D18 - the service functions refuse a caller without the service role.
-- ===========================================================================
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'aa000000-0000-4000-8000-000000000001', true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);

DO $d18$
BEGIN
  -- An ordinary user cannot claim, even though the function exists.
  BEGIN
    PERFORM public.claim_instagram_collection_jobs('owner', 1);
    RAISE EXCEPTION 'D18 failed: an ordinary user claimed work'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN insufficient_privilege THEN
    ASSERT SQLSTATE = '42501',
      'D18 a privilege refusal is SQLSTATE 42501, got ' || SQLSTATE;
  END;

  -- Nor can they write a snapshot, even with a plausible token.
  BEGIN
    PERFORM public.persist_instagram_collection_snapshot(
      gen_random_uuid(), gen_random_uuid(), 1, jsonb_build_object('kind', 'owner_media'));
    RAISE EXCEPTION 'D18 failed: an ordinary user persisted a snapshot'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN insufficient_privilege THEN
    ASSERT SQLSTATE = '42501',
      'D18 a privilege refusal is SQLSTATE 42501, got ' || SQLSTATE;
  END;
END
$d18$;

RESET ROLE;

SELECT set_config('request.jwt.claim.role', '', true);
SELECT set_config('request.jwt.claim.sub', '', true);

ROLLBACK;

\echo 'ALL CHECKS PASSED'
