-- supabase/tests/deferred_publishes.sql
-- Deferred publishing and the stale-processing sweeper (migration 20261029180000).
-- One transaction, synthetic fixtures, labelled ASSERTs, ROLLBACK, sentinel last.
-- Assumes the migration is already applied. No secrets and no real accounts.
BEGIN;

DO $$
DECLARE
  u_a uuid := 'd1d1d1d1-1111-4111-8111-d1d1d1d1d1d1';
  acct_ig uuid := 'd2d2d2d2-2222-4222-8222-d2d2d2d2d2d2';
  acct_th uuid := 'd3d3d3d3-3333-4333-8333-d3d3d3d3d3d3';
BEGIN
  INSERT INTO auth.users (id, email) VALUES (u_a, 'deferred-publishes-a@example.invalid');
  INSERT INTO public.user_quotas (user_id, max_posts_per_day, max_posts_per_month, max_media_uploads_per_day)
  VALUES (u_a, -1, -1, -1)
  ON CONFLICT (user_id) DO UPDATE SET
    max_posts_per_day = EXCLUDED.max_posts_per_day,
    max_posts_per_month = EXCLUDED.max_posts_per_month,
    max_media_uploads_per_day = EXCLUDED.max_media_uploads_per_day;
  INSERT INTO public.social_accounts (id, user_id, platform, platform_user_id, platform_username, access_token, is_active)
  VALUES
    (acct_ig, u_a, 'instagram', 'dp-ig', 'dp_ig', 'tok-ig', true),
    (acct_th, u_a, 'threads', 'dp-th', 'dp_th', 'tok-th', true);

  -- P1: a pending deferred row that is due; P2: one leased to another run;
  -- P3: one not yet due; P4: a TikTok-style pending row with no deferral.
  INSERT INTO public.posts (id, user_id, platforms, status, processing_started_at, metadata) VALUES
    ('e0000000-0000-4000-8000-000000000001', u_a, ARRAY['instagram'], 'processing', now(), jsonb_build_object('selected_account_ids', jsonb_build_array(acct_ig))),
    ('e0000000-0000-4000-8000-000000000002', u_a, ARRAY['instagram'], 'processing', now(), NULL),
    ('e0000000-0000-4000-8000-000000000003', u_a, ARRAY['instagram'], 'processing', now(), NULL),
    ('e0000000-0000-4000-8000-000000000004', u_a, ARRAY['tiktok'], 'processing', now() - interval '2 hours', NULL);
  INSERT INTO public.platform_posts (id, post_id, social_account_id, platform, status, response_data) VALUES
    ('f0000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-000000000001', acct_ig, 'instagram', 'pending',
      jsonb_build_object('deferred', jsonb_build_object('container_id', 'c1', 'next_check_at', now() - interval '1 minute'))),
    ('f0000000-0000-4000-8000-000000000002', 'e0000000-0000-4000-8000-000000000002', acct_ig, 'instagram', 'pending',
      jsonb_build_object('deferred', jsonb_build_object('container_id', 'c2', 'next_check_at', now() - interval '1 minute', 'claimed_until', now() + interval '2 minutes'))),
    ('f0000000-0000-4000-8000-000000000003', 'e0000000-0000-4000-8000-000000000003', acct_ig, 'instagram', 'pending',
      jsonb_build_object('deferred', jsonb_build_object('container_id', 'c3', 'next_check_at', now() + interval '1 minute'))),
    ('f0000000-0000-4000-8000-000000000004', 'e0000000-0000-4000-8000-000000000004', NULL, 'tiktok', 'pending',
      jsonb_build_object('tiktok_publish_id', 'p4'));
END $$;

-- D1-D3: the claim leases only due, unleased deferred rows, once.
DO $$
DECLARE
  v_claimed uuid[];
BEGIN
  SELECT array_agg(platform_post_id) INTO v_claimed FROM public.claim_deferred_publishes(10);
  ASSERT v_claimed = ARRAY['f0000000-0000-4000-8000-000000000001'::uuid],
    format('D1 only the due, unleased deferred row is claimed (got %s)', v_claimed);
  ASSERT (SELECT (response_data #>> '{deferred,claimed_until}')::timestamptz > now()
            FROM public.platform_posts WHERE id = 'f0000000-0000-4000-8000-000000000001'),
    'D2 the claimed row carries a lease';
  ASSERT (SELECT count(*) FROM public.claim_deferred_publishes(10)) = 0,
    'D3 a second run takes nothing while the lease holds';
END $$;

-- S1-S5: the sweeper.
DO $$
DECLARE
  u_a uuid := 'd1d1d1d1-1111-4111-8111-d1d1d1d1d1d1';
  acct_ig uuid := 'd2d2d2d2-2222-4222-8222-d2d2d2d2d2d2';
  acct_th uuid := 'd3d3d3d3-3333-4333-8333-d3d3d3d3d3d3';
  v_result jsonb;
BEGIN
  -- S-A: stranded, two selected accounts, Instagram already succeeded, Threads has no row.
  INSERT INTO public.posts (id, user_id, platforms, status, processing_started_at, metadata) VALUES
    ('e0000000-0000-4000-8000-0000000000a1', u_a, ARRAY['instagram','threads'], 'processing', now() - interval '1 hour',
      jsonb_build_object('selected_account_ids', jsonb_build_array(acct_ig, acct_th))),
  -- S-B: stranded, no rows at all, no selection recorded.
    ('e0000000-0000-4000-8000-0000000000b1', u_a, ARRAY['instagram'], 'processing', now() - interval '1 hour', NULL),
  -- S-C: processing for only five minutes.
    ('e0000000-0000-4000-8000-0000000000c1', u_a, ARRAY['threads'], 'processing', now() - interval '5 minutes',
      jsonb_build_object('selected_account_ids', jsonb_build_array(acct_th)));
  INSERT INTO public.platform_posts (post_id, social_account_id, platform, status, platform_post_id)
  VALUES ('e0000000-0000-4000-8000-0000000000a1', acct_ig, 'instagram', 'success', 'ig-media-1');

  v_result := public.sweep_stale_processing_posts(interval '20 minutes');

  ASSERT (SELECT status FROM public.platform_posts
           WHERE post_id = 'e0000000-0000-4000-8000-0000000000a1' AND social_account_id = acct_th) = 'failed',
    'S1 the selected account without a row gets a failed row';
  ASSERT (SELECT error_message FROM public.platform_posts
           WHERE post_id = 'e0000000-0000-4000-8000-0000000000a1' AND social_account_id = acct_th)
         = 'Publishing was interrupted before it finished. Safe to retry.',
    'S2 the failed row says it is safe to retry';
  ASSERT (SELECT status FROM public.posts WHERE id = 'e0000000-0000-4000-8000-0000000000a1') = 'completed',
    'S3 a post with one success rolls up to completed';
  ASSERT (SELECT status FROM public.posts WHERE id = 'e0000000-0000-4000-8000-0000000000b1') = 'failed',
    'S4 a stranded post with nothing published becomes failed';
  ASSERT (SELECT status FROM public.posts WHERE id = 'e0000000-0000-4000-8000-0000000000c1') = 'processing',
    'S5 a recent post is left alone';
  ASSERT (SELECT status FROM public.posts WHERE id = 'e0000000-0000-4000-8000-000000000004') = 'processing',
    'S6 a post with a pending row (TikTok, deferred) is left alone however old';
  ASSERT (v_result ->> 'rows_failed')::int = 1, format('S7 one failed row was written (got %s)', v_result);
END $$;

-- G1: only the service role may call either function.
DO $$
BEGIN
  ASSERT NOT has_function_privilege('authenticated', 'public.claim_deferred_publishes(integer, interval)', 'EXECUTE'),
    'G1 authenticated cannot claim deferred publishes';
  ASSERT NOT has_function_privilege('anon', 'public.sweep_stale_processing_posts(interval)', 'EXECUTE'),
    'G2 anon cannot sweep';
  ASSERT has_function_privilege('service_role', 'public.sweep_stale_processing_posts(interval)', 'EXECUTE'),
    'G3 the service role can sweep';
END $$;

-- R1-R7: the pending row is written only for an account of the post's owner
-- (migration 20261030090000), checked in SQL rather than by the caller.
DO $$
DECLARE
  u_a uuid := 'd1d1d1d1-1111-4111-8111-d1d1d1d1d1d1';
  u_b uuid := 'd4d4d4d4-4444-4444-8444-d4d4d4d4d4d4';
  acct_ig uuid := 'd2d2d2d2-2222-4222-8222-d2d2d2d2d2d2';
  acct_b uuid := 'd5d5d5d5-5555-4555-8555-d5d5d5d5d5d5';
  post_r uuid := 'e0000000-0000-4000-8000-0000000000d1';
  v_id uuid;
  v_refused boolean;
BEGIN
  INSERT INTO auth.users (id, email) VALUES (u_b, 'deferred-publishes-b@example.invalid');
  INSERT INTO public.social_accounts (id, user_id, platform, platform_user_id, platform_username, access_token, is_active)
  VALUES (acct_b, u_b, 'instagram', 'dp-b-ig', 'dp_b_ig', 'tok-b', true);
  INSERT INTO public.posts (id, user_id, platforms, status, processing_started_at)
  VALUES (post_r, u_a, ARRAY['instagram'], 'processing', now());

  -- R1: the same tenant works; the platform is the account's, not the caller's.
  v_id := public.record_deferred_platform_post(post_r, acct_ig, jsonb_build_object('deferred', jsonb_build_object('container_id', 'cr1')));
  ASSERT v_id IS NOT NULL, 'R1 the function returns the new row id';
  ASSERT (SELECT status = 'pending' AND platform = 'instagram' AND post_id = post_r AND social_account_id = acct_ig
                 AND response_data #>> '{deferred,container_id}' = 'cr1'
            FROM public.platform_posts WHERE id = v_id),
    'R2 a pending row carrying the deferral is written for the post owner''s account';

  -- R3: another tenant's account is refused, and nothing is written for it.
  v_refused := false;
  BEGIN
    PERFORM public.record_deferred_platform_post(post_r, acct_b, '{}'::jsonb);
  EXCEPTION WHEN foreign_key_violation THEN
    v_refused := true;
  END;
  ASSERT v_refused, 'R3 a cross-tenant pairing raises foreign_key_violation';
  ASSERT NOT EXISTS (SELECT 1 FROM public.platform_posts WHERE social_account_id = acct_b),
    'R4 the refused pairing wrote no row';

  -- R5: a post or account that does not exist is refused the same way.
  v_refused := false;
  BEGIN
    PERFORM public.record_deferred_platform_post('e0000000-0000-4000-8000-00000000dead', acct_ig, '{}'::jsonb);
  EXCEPTION WHEN foreign_key_violation THEN
    v_refused := true;
  END;
  ASSERT v_refused, 'R5 an unknown post is refused';
  v_refused := false;
  BEGIN
    PERFORM public.record_deferred_platform_post(post_r, 'd5d5d5d5-5555-4555-8555-00000000dead', '{}'::jsonb);
  EXCEPTION WHEN foreign_key_violation THEN
    v_refused := true;
  END;
  ASSERT v_refused, 'R6 an unknown account is refused';

  -- R7: a missing payload is stored as an empty object, not NULL.
  v_id := public.record_deferred_platform_post(post_r, acct_ig, NULL);
  ASSERT (SELECT response_data = '{}'::jsonb FROM public.platform_posts WHERE id = v_id),
    'R7 a NULL payload becomes an empty object';
END $$;

-- G4-G7: only the service role may call it, and it runs with a pinned search_path.
DO $$
BEGIN
  ASSERT NOT has_function_privilege('authenticated', 'public.record_deferred_platform_post(uuid, uuid, jsonb)', 'EXECUTE'),
    'G4 authenticated cannot record a deferred row';
  ASSERT NOT has_function_privilege('anon', 'public.record_deferred_platform_post(uuid, uuid, jsonb)', 'EXECUTE'),
    'G5 anon cannot record a deferred row';
  ASSERT has_function_privilege('service_role', 'public.record_deferred_platform_post(uuid, uuid, jsonb)', 'EXECUTE'),
    'G6 the service role can record a deferred row';
  ASSERT (SELECT prosecdef AND 'search_path=public' = ANY (proconfig)
            FROM pg_proc WHERE oid = 'public.record_deferred_platform_post(uuid, uuid, jsonb)'::regprocedure),
    'G7 the function is SECURITY DEFINER with search_path pinned';
END $$;

ROLLBACK;

\echo '=== deferred_publishes: ALL CHECKS PASSED ==='
