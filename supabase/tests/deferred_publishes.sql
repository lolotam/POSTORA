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

-- T1-T20: durable single-image Threads admission, execution and terminal fencing.
DO $$
DECLARE
  u_a uuid := 'd1d1d1d1-1111-4111-8111-d1d1d1d1d1d1';
  acct_ig uuid := 'd2d2d2d2-2222-4222-8222-d2d2d2d2d2d2';
  acct_th uuid := 'd3d3d3d3-3333-4333-8333-d3d3d3d3d3d3';
  acct_b uuid := 'd5d5d5d5-5555-4555-8555-d5d5d5d5d5d5';
  post_t uuid := 'e0000000-0000-4000-8000-0000000000e1';
  row_t uuid;
  row_again uuid;
  claim_at timestamptz := now();
  lease_at timestamptz;
  expected jsonb;
  payload jsonb;
  saved jsonb;
  refused boolean;
BEGIN
  INSERT INTO public.posts (id, user_id, caption, platforms, status, processing_started_at, posted_at, source)
  VALUES (post_t, u_a, 'synthetic image', ARRAY['instagram','threads'], 'completed', claim_at, now(), 'manual');
  INSERT INTO public.platform_posts (post_id, social_account_id, platform, status, platform_post_id)
  VALUES (post_t, acct_ig, 'instagram', 'success', 'earlier-success');
  expected := jsonb_build_object(
    'user_id', u_a, 'caption', 'synthetic image', 'media_file_ids', NULL,
    'metadata', NULL, 'platforms', ARRAY['instagram','threads'], 'scheduled_at', NULL,
    'publish_requested_at', NULL, 'source', 'manual'
  );
  payload := jsonb_build_object('deferred', jsonb_build_object(
    'kind', 'threads', 'media_type', 'IMAGE', 'container_id', 'image-container-1',
    'attempt_started_at', claim_at, 'attempts', 0,
    'first_deferred_at', claim_at, 'give_up_at', claim_at + interval '30 minutes',
    'next_check_at', claim_at + interval '1 minute'
  ), 'content_fence', expected, 'account_updated_at',
    (SELECT updated_at FROM public.social_accounts WHERE id = acct_th));

  row_t := public.record_threads_image_checkpoint(post_t, acct_th, payload, claim_at, expected);
  ASSERT row_t IS NOT NULL, 'T1 checkpoint admission returns a row UUID';
  ASSERT (SELECT status FROM public.posts WHERE id = post_t) = 'processing',
    'T2 an earlier same-attempt success rollup is restored to processing';
  ASSERT (SELECT status = 'pending' AND platform_post_id IS NULL
            AND response_data #>> '{deferred,media_type}' = 'IMAGE'
            FROM public.platform_posts WHERE id = row_t),
    'T3 the checkpoint is pending IMAGE and never uses the container as provider post ID';

  row_again := public.record_threads_image_checkpoint(post_t, acct_th, payload, claim_at, expected);
  ASSERT row_again = row_t, 'T4 a repeated acknowledged or recovered checkpoint returns the same UUID';
  ASSERT (SELECT count(*) FROM public.platform_posts
           WHERE post_id = post_t AND social_account_id = acct_th) = 1,
    'T5 checkpoint recovery never inserts a duplicate';

  refused := false;
  BEGIN
    PERFORM public.record_threads_image_checkpoint(post_t, acct_th,
      jsonb_set(payload, '{deferred,kind}', 'null'::jsonb, true), claim_at, expected);
  EXCEPTION WHEN check_violation THEN refused := true;
  END;
  ASSERT refused, 'T5b a missing durable kind is rejected';
  refused := false;
  BEGIN
    PERFORM public.record_threads_image_checkpoint(post_t, acct_th,
      jsonb_set(payload, '{deferred,media_type}', 'null'::jsonb, true), claim_at, expected);
  EXCEPTION WHEN check_violation THEN refused := true;
  END;
  ASSERT refused, 'T5c a missing durable media type is rejected';

  -- Keep the durable attempt identity intact, but make the post's stored claim stale.
  -- This reaches the claim guard instead of failing early on mismatched identity.
  UPDATE public.posts SET processing_started_at = claim_at - interval '1 second' WHERE id = post_t;
  refused := false;
  BEGIN
    PERFORM public.record_threads_image_checkpoint(post_t, acct_th, payload, claim_at, expected);
  EXCEPTION WHEN serialization_failure THEN refused := true;
  END;
  ASSERT refused, 'T6 a stale processing claim is refused';
  UPDATE public.posts SET processing_started_at = claim_at WHERE id = post_t;

  refused := false;
  BEGIN
    PERFORM public.record_threads_image_checkpoint(post_t, acct_b, payload, claim_at, expected);
  EXCEPTION WHEN foreign_key_violation THEN refused := true;
  END;
  ASSERT refused, 'T7 another tenant or non-Threads account is refused structurally';

  UPDATE public.posts SET caption = 'changed content' WHERE id = post_t;
  refused := false;
  BEGIN
    PERFORM public.record_threads_image_checkpoint(post_t, acct_th,
      payload || jsonb_build_object('deferred', (payload->'deferred') || jsonb_build_object('container_id', 'changed-container')),
      claim_at, expected);
  EXCEPTION WHEN serialization_failure THEN refused := true;
  END;
  ASSERT refused, 'T8 edited content cannot admit a container from the old content';
  UPDATE public.posts SET caption = 'synthetic image', status = 'pending' WHERE id = post_t;
  refused := false;
  BEGIN
    PERFORM public.record_threads_image_checkpoint(post_t, acct_th,
      payload || jsonb_build_object('deferred', (payload->'deferred') || jsonb_build_object('container_id', 'cancelled-container')),
      claim_at, expected);
  EXCEPTION WHEN serialization_failure THEN refused := true;
  END;
  ASSERT refused, 'T9 cancellation or a queued retry cannot revive the old attempt';
  UPDATE public.posts SET status = 'processing' WHERE id = post_t;

  lease_at := now() + interval '3 minutes';
  UPDATE public.platform_posts
     SET response_data = jsonb_set(response_data, '{deferred,claimed_until}', to_jsonb(lease_at), true)
   WHERE id = row_t;
  UPDATE public.social_accounts SET is_active = false WHERE id = acct_th;
  ASSERT public.claim_threads_image_execution(row_t, lease_at, 'execution-1'),
    'T10 an inactive connection still permits lease-owned bounded abandonment';
  ASSERT NOT public.mark_threads_image_publish_started(row_t, lease_at, 'execution-1', expected),
    'T10b an inactive connection never permits provider publication';
  UPDATE public.social_accounts SET is_active = true WHERE id = acct_th;
  ASSERT NOT public.claim_threads_image_execution(row_t, lease_at, 'execution-2'),
    'T11 a duplicate execution loses before provider work';
  ASSERT NOT public.claim_threads_image_execution(row_t, now() + interval '2 minutes', 'execution-3'),
    'T12 a different or stale lease cannot claim execution';

  UPDATE public.platform_posts
     SET response_data = (response_data || jsonb_build_object('deferred',
           (response_data->'deferred') || jsonb_build_object(
             'claimed_until', now() - interval '1 second',
             'next_check_at', now() - interval '1 second',
             'publish_attempt_id', 'execution-1',
             'publish_outcome', 'uncertain')))
   WHERE id = row_t;
  ASSERT EXISTS (SELECT 1 FROM public.claim_deferred_publishes(10) WHERE platform_post_id = row_t),
    'T13 an expired image lease is reclaimed by the ordinary deferred claim';
  ASSERT (SELECT response_data #>> '{deferred,execution_id}' IS NULL
            AND response_data #>> '{deferred,publish_attempt_id}' = 'execution-1'
            AND response_data #>> '{deferred,publish_outcome}' = 'uncertain'
            FROM public.platform_posts WHERE id = row_t),
    'T14 a new lease clears execution ownership but preserves uncertain-send evidence';
  -- Between lease rollover and the next execution claim, no old or unowned
  -- caller may settle the managed image.
  refused := false;
  BEGIN
    PERFORM public.partner_settle_platform_post(row_t, post_t, acct_th, 'threads', 'failed',
      NULL, NULL, 'old owner during rollover', '{"deferred":{"execution_id":"execution-1"}}'::jsonb);
  EXCEPTION WHEN serialization_failure THEN refused := true;
  END;
  ASSERT refused, 'T14b an old owner cannot settle during the lease-ownership gap';
  ASSERT (SELECT status FROM public.platform_posts WHERE id = row_t) = 'pending',
    'T14c the rollover refusal leaves the checkpoint pending';

  ASSERT public.claim_threads_image_execution(row_t,
    (SELECT (response_data #>> '{deferred,claimed_until}')::timestamptz FROM public.platform_posts WHERE id = row_t),
    'execution-current'), 'T15 the new lease has one current owner';

  saved := (SELECT response_data FROM public.platform_posts WHERE id = row_t);
  UPDATE public.platform_posts SET response_data = jsonb_set(response_data, '{deferred,kind}', 'null'::jsonb, true) WHERE id = row_t;
  ASSERT NOT public.claim_threads_image_execution(row_t,
    (SELECT (response_data #>> '{deferred,claimed_until}')::timestamptz FROM public.platform_posts WHERE id = row_t),
    'missing-kind'), 'T15b execution rejects a missing kind';
  UPDATE public.platform_posts SET response_data = saved WHERE id = row_t;
  UPDATE public.platform_posts SET response_data = jsonb_set(response_data, '{deferred,media_type}', 'null'::jsonb, true) WHERE id = row_t;
  ASSERT NOT public.claim_threads_image_execution(row_t,
    (SELECT (response_data #>> '{deferred,claimed_until}')::timestamptz FROM public.platform_posts WHERE id = row_t),
    'missing-media'), 'T15c execution rejects a missing media type';
  UPDATE public.platform_posts SET response_data = saved WHERE id = row_t;

  ASSERT NOT public.mark_threads_image_publish_started(row_t,
    (SELECT (response_data #>> '{deferred,claimed_until}')::timestamptz FROM public.platform_posts WHERE id = row_t),
    'execution-current', expected), 'T15d an unanswered prior send stays blocked after lease rollover';

  -- Start the independent, proven-unpublished fixture phase for pre-send fences.
  -- The preceding assertions already proved that a real unresolved send is retained and refused.
  UPDATE public.platform_posts
     SET response_data = jsonb_set(response_data, '{deferred}',
       (response_data->'deferred') - 'publish_attempt_id' - 'publish_outcome', true)
   WHERE id = row_t;
  ASSERT public.mark_threads_image_publish_started(row_t,
    (SELECT (response_data #>> '{deferred,claimed_until}')::timestamptz FROM public.platform_posts WHERE id = row_t),
    'execution-current', expected), 'T15d the fenced current owner can mark its one send';
  ASSERT NOT public.mark_threads_image_publish_started(row_t,
    (SELECT (response_data #>> '{deferred,claimed_until}')::timestamptz FROM public.platform_posts WHERE id = row_t),
    'execution-current', expected), 'T15e a second send marker is refused';

  UPDATE public.platform_posts SET response_data = jsonb_set(response_data, '{deferred,publish_attempt_id}', 'null'::jsonb, true) WHERE id = row_t;
  UPDATE public.posts SET caption = 'changed before send' WHERE id = post_t;
  ASSERT NOT public.mark_threads_image_publish_started(row_t,
    (SELECT (response_data #>> '{deferred,claimed_until}')::timestamptz FROM public.platform_posts WHERE id = row_t),
    'execution-current', expected), 'T15f edited content fails the pre-send fence';
  UPDATE public.platform_posts SET response_data = jsonb_set(response_data, '{deferred,publish_attempt_id}', 'null'::jsonb, true) WHERE id = row_t;
  UPDATE public.posts SET caption = 'synthetic image', status = 'failed' WHERE id = post_t;
  ASSERT NOT public.mark_threads_image_publish_started(row_t,
    (SELECT (response_data #>> '{deferred,claimed_until}')::timestamptz FROM public.platform_posts WHERE id = row_t),
    'execution-current', expected), 'T15g cancellation fails the pre-send fence';
  UPDATE public.posts SET status = 'processing' WHERE id = post_t;
  UPDATE public.platform_posts SET response_data = jsonb_set(response_data, '{deferred,publish_attempt_id}', 'null'::jsonb, true) WHERE id = row_t;
  -- updated_at's trigger uses the transaction clock, which is fixed in this suite.
  -- Represent a checkpoint captured before the current credential generation instead.
  UPDATE public.platform_posts SET response_data = jsonb_set(response_data, '{account_updated_at}',
    to_jsonb((SELECT updated_at - interval '1 hour' FROM public.social_accounts WHERE id = acct_th)), true)
   WHERE id = row_t;
  ASSERT NOT public.mark_threads_image_publish_started(row_t,
    (SELECT (response_data #>> '{deferred,claimed_until}')::timestamptz FROM public.platform_posts WHERE id = row_t),
    'execution-current', expected), 'T15h a credential generation change fails the pre-send fence';
  UPDATE public.platform_posts SET response_data = jsonb_set(response_data, '{account_updated_at}',
    to_jsonb((SELECT updated_at FROM public.social_accounts WHERE id = acct_th)), true)
   WHERE id = row_t;

  refused := false;
  BEGIN
    PERFORM public.partner_settle_platform_post(row_t, post_t, acct_th, 'threads', 'failed',
      NULL, NULL, 'stale writer', '{"deferred":{"execution_id":"stale-execution"}}'::jsonb);
  EXCEPTION WHEN serialization_failure THEN refused := true;
  END;
  ASSERT refused, 'T15 a stale execution cannot settle the row';
  ASSERT (SELECT status FROM public.platform_posts WHERE id = row_t) = 'pending',
    'T16 the stale settlement left the checkpoint pending';

  -- The current owner's response carries that exact marker.
  PERFORM public.partner_settle_platform_post(row_t, post_t, acct_th, 'threads', 'success',
    'published-image-1', NULL, NULL,
    (SELECT response_data FROM public.platform_posts WHERE id = row_t));
  ASSERT (SELECT status = 'success' AND platform_post_id = 'published-image-1'
            FROM public.platform_posts WHERE id = row_t),
    'T18 the current owner settles the same row with the real provider ID';

  row_again := public.record_threads_image_checkpoint(post_t, acct_th, payload, claim_at, expected);
  ASSERT row_again = row_t, 'T18b terminal checkpoint replay returns the same settled row';
  ASSERT (SELECT status FROM public.posts WHERE id = post_t) = 'completed',
    'T18c terminal checkpoint replay never resurrects the parent';
  ASSERT (SELECT count(*) FROM public.platform_posts
           WHERE post_id = post_t AND social_account_id = acct_th) = 1,
    'T18d terminal checkpoint replay creates no second operation';
END $$;

-- T19-T24: uncertain image outcomes are durable and excluded from generic retry;
-- a proven failed image remains eligible and successful other-platform rows survive.
DO $$
DECLARE
  u_a uuid := 'd1d1d1d1-1111-4111-8111-d1d1d1d1d1d1';
  acct_th uuid := 'd3d3d3d3-3333-4333-8333-d3d3d3d3d3d3';
  uncertain_post uuid := 'e0000000-0000-4000-8000-0000000000e2';
  proven_post uuid := 'e0000000-0000-4000-8000-0000000000e3';
  result jsonb;
BEGIN
  INSERT INTO public.posts (id, user_id, platforms, status, source) VALUES
    (uncertain_post, u_a, ARRAY['threads'], 'completed', 'manual'),
    (proven_post, u_a, ARRAY['threads'], 'failed', 'manual');
  INSERT INTO public.platform_posts (post_id, social_account_id, platform, status, response_data) VALUES
    (uncertain_post, acct_th, 'threads', 'failed', jsonb_build_object('deferred', jsonb_build_object(
      'kind', 'threads', 'media_type', 'IMAGE', 'container_id', 'uncertain-container',
      'publish_attempt_id', 'execution-uncertain', 'publish_outcome', 'uncertain'))),
    (proven_post, acct_th, 'threads', 'failed', jsonb_build_object('deferred', jsonb_build_object(
      'kind', 'threads', 'media_type', 'IMAGE', 'container_id', 'proven-container')));

  result := public.request_post_retry(uncertain_post, u_a);
  ASSERT result->>'reason' = 'no_targets', 'T19 an uncertain image is not a generic retry target';
  ASSERT EXISTS (SELECT 1 FROM public.platform_posts WHERE post_id = uncertain_post AND status = 'failed'),
    'T20 generic retry cannot delete the uncertainty evidence';
  ASSERT (SELECT status FROM public.posts WHERE id = uncertain_post) = 'completed',
    'T21 the refused uncertain retry does not reopen the parent';

  result := public.request_post_retry(proven_post, u_a);
  ASSERT result->>'status' = 'accepted', format('T22 a proven failed image remains retryable (got %s)', result);
  ASSERT NOT EXISTS (SELECT 1 FROM public.platform_posts WHERE post_id = proven_post),
    'T23 a proven failed row follows the existing retry deletion contract';

  ASSERT NOT has_function_privilege('authenticated', 'public.record_threads_image_checkpoint(uuid,uuid,jsonb,timestamptz,jsonb)', 'EXECUTE'),
    'T24 authenticated cannot admit an image checkpoint';
  ASSERT NOT has_function_privilege('anon', 'public.claim_threads_image_execution(uuid,timestamptz,text)', 'EXECUTE'),
    'T25 anon cannot claim an image execution';
  ASSERT NOT has_function_privilege('authenticated', 'public.mark_threads_image_publish_started(uuid,timestamptz,text,jsonb)', 'EXECUTE'),
    'T25b authenticated cannot mark an image publish';
  ASSERT (SELECT bool_and(prosecdef AND 'search_path=public' = ANY(proconfig))
            FROM pg_proc WHERE oid IN (
              'public.record_threads_image_checkpoint(uuid,uuid,jsonb,timestamptz,jsonb)'::regprocedure,
              'public.claim_threads_image_execution(uuid,timestamptz,text)'::regprocedure,
              'public.mark_threads_image_publish_started(uuid,timestamptz,text,jsonb)'::regprocedure,
              'public.partner_settle_platform_post(uuid,uuid,uuid,text,text,text,text,text,jsonb)'::regprocedure)),
    'T26 checkpoint, execution and settlement functions are security definer with pinned search_path';
END $$;

ROLLBACK;

\echo '=== deferred_publishes: ALL CHECKS PASSED ==='
