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
  VALUES (post_t, u_a, 'synthetic image', ARRAY['instagram','threads'], 'failed', claim_at, now(), 'manual');
  INSERT INTO public.platform_posts (post_id, social_account_id, platform, status, platform_post_id)
  VALUES (post_t, acct_ig, 'instagram', 'failed', NULL);
  expected := jsonb_build_object(
    'user_id', u_a, 'caption', 'synthetic image', 'media_file_ids', NULL,
    'metadata', '{}'::jsonb, 'platforms', ARRAY['instagram','threads'], 'scheduled_at', NULL,
    'publish_requested_at', NULL, 'source', 'manual'
  );
  payload := jsonb_build_object('deferred', jsonb_build_object(
    'kind', 'threads', 'media_type', 'IMAGE', 'container_id', 'image-container-1',
    'attempt_started_at', claim_at, 'attempts', 0,
    'first_deferred_at', claim_at, 'give_up_at', claim_at + interval '30 minutes',
    'next_check_at', claim_at + interval '1 minute'
  ), 'content_fence', expected, 'account_updated_at',
    (SELECT updated_at FROM public.social_accounts WHERE id = acct_th));

  -- Pinterest may stamp derived History metadata without changing publishing inputs.
  -- Sibling rollup stamps settlement_rollup_at to identify legitimate provenance.
  UPDATE public.posts SET metadata = jsonb_build_object('pinterest_post_type', 'image', 'settlement_rollup_at', claim_at) WHERE id = post_t;
  row_t := public.record_threads_image_checkpoint(post_t, acct_th, payload, claim_at, expected);
  ASSERT row_t IS NOT NULL, 'T1 checkpoint admission returns a row UUID';
  ASSERT (SELECT status FROM public.posts WHERE id = post_t) = 'processing',
    'T2 an earlier same-attempt failure rollup admits the image and restores processing';
  ASSERT (SELECT status = 'pending' AND platform_post_id IS NULL
            AND response_data #>> '{deferred,media_type}' = 'IMAGE'
            FROM public.platform_posts WHERE id = row_t),
    'T3 the checkpoint is pending IMAGE and never uses the container as provider post ID';

  UPDATE public.platform_posts SET status = 'success' WHERE post_id = post_t AND social_account_id = acct_ig;
  UPDATE public.posts SET status = 'completed',
    metadata = jsonb_build_object('pinterest_post_type', 'image', 'settlement_rollup_at', claim_at) WHERE id = post_t;
  row_again := public.record_threads_image_checkpoint(post_t, acct_th, payload, claim_at, expected);
  ASSERT row_again = row_t, 'T4 a repeated acknowledged or recovered checkpoint returns the same UUID';
  ASSERT (SELECT status FROM public.posts WHERE id = post_t) = 'processing',
    'T4b an earlier same-attempt success rollup also restores processing';
  ASSERT (SELECT count(*) FROM public.platform_posts
           WHERE post_id = post_t AND social_account_id = acct_th) = 1,
    'T5 checkpoint recovery never inserts a duplicate';

  -- Restore clean metadata for subsequent pre-send fence assertions
  UPDATE public.posts SET metadata = '{"pinterest_post_type":"image"}'::jsonb WHERE id = post_t;

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

  -- Even a direct caller without scheduler expectations cannot overwrite the
  -- active attempt while this durable row is pending.
  refused := false;
  BEGIN
    UPDATE public.posts SET status = 'processing', processing_started_at = claim_at + interval '1 second' WHERE id = post_t;
  EXCEPTION WHEN serialization_failure THEN refused := true;
  END;
  ASSERT refused AND (SELECT processing_started_at FROM public.posts WHERE id = post_t) = claim_at,
    'T5d a direct processing claim cannot replace a pending image attempt';
  -- Supply an internally consistent old identity to reach the stale-claim guard.
  refused := false;
  BEGIN
    PERFORM public.record_threads_image_checkpoint(post_t, acct_th,
      jsonb_set(payload, '{deferred,attempt_started_at}', to_jsonb(claim_at - interval '1 second')),
      claim_at - interval '1 second', expected);
  EXCEPTION WHEN serialization_failure THEN refused := true;
  END;
  ASSERT refused, 'T6 a stale processing claim is refused';

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
  ASSERT (SELECT status FROM public.posts WHERE id = post_t) = 'processing',
    'T18c terminal checkpoint replay never resurrects or finalizes the parent outside the fenced attempt finalizer';
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

-- T27-T48: bounded original-request ownership, definitely-unsent release and
-- atomic attempt finalization (migration 20261117120000).
DO $$
DECLARE
  u_a uuid := 'd1d1d1d1-1111-4111-8111-d1d1d1d1d1d1';
  acct_th uuid := 'd3d3d3d3-3333-4333-8333-d3d3d3d3d3d3';
  acct_b uuid := 'd5d5d5d5-5555-4555-8555-d5d5d5d5d5d5';
  post_i uuid := 'e0000000-0000-4000-8000-0000000000e4';
  row_i uuid;
  claim_at timestamptz := now();
  expected jsonb;
  payload jsonb;
  claimed jsonb;
  saved jsonb;
  lease_at timestamptz;
  finalized jsonb;
BEGIN
  INSERT INTO public.posts (id, user_id, caption, platforms, status, processing_started_at, source)
  VALUES (post_i, u_a, 'inline synthetic image', ARRAY['threads'], 'processing', claim_at, 'manual');
  expected := jsonb_build_object(
    'user_id', u_a, 'caption', 'inline synthetic image', 'media_file_ids', NULL,
    'metadata', '{}'::jsonb, 'platforms', ARRAY['threads'], 'scheduled_at', NULL,
    'publish_requested_at', NULL, 'source', 'manual'
  );
  payload := jsonb_build_object('deferred', jsonb_build_object(
    'kind', 'threads', 'media_type', 'IMAGE', 'container_id', 'inline-container-1',
    'attempt_started_at', claim_at, 'attempts', 0,
    'first_deferred_at', claim_at, 'give_up_at', claim_at + interval '30 minutes',
    'next_check_at', claim_at + interval '1 minute'
  ), 'content_fence', expected, 'account_updated_at',
    (SELECT updated_at FROM public.social_accounts WHERE id = acct_th));
  row_i := public.record_threads_image_checkpoint(post_i, acct_th, payload, claim_at, expected);

  ASSERT public.claim_threads_image_inline_execution(row_i, post_i, acct_b,
    'inline-container-1', claim_at, expected, 'inline-cross-owner') IS NULL,
    'T27 inline ownership structurally rejects another account';
  ASSERT public.claim_threads_image_inline_execution(row_i, post_i, acct_th,
    'wrong-container', claim_at, expected, 'inline-wrong-container') IS NULL,
    'T28 inline ownership rejects the wrong container';
  ASSERT public.claim_threads_image_inline_execution(row_i, post_i, acct_th,
    'inline-container-1', claim_at - interval '1 second', expected, 'inline-wrong-attempt') IS NULL,
    'T29 inline ownership rejects the wrong processing attempt';

  claimed := public.claim_threads_image_inline_execution(row_i, post_i, acct_th,
    'inline-container-1', claim_at, expected, 'inline-execution-1');
  lease_at := (claimed #>> '{response_data,deferred,claimed_until}')::timestamptz;
  ASSERT claimed->>'platform_post_id' = row_i::text AND lease_at > now()
    AND claimed #>> '{response_data,deferred,execution_id}' = 'inline-execution-1'
    AND claimed #>> '{response_data,deferred,execution_claimed_until}' = claimed #>> '{response_data,deferred,claimed_until}',
    'T30 inline ownership returns the authoritative row and database lease';
  ASSERT claimed #>> '{response_data,deferred,next_check_at}' = payload #>> '{deferred,next_check_at}',
    'T31 original-request ownership does not rewrite next_check_at';
  ASSERT public.claim_threads_image_inline_execution(row_i, post_i, acct_th,
    'inline-container-1', claim_at, expected, 'inline-execution-2') IS NULL,
    'T32 a duplicate inline execution loses';

  UPDATE public.platform_posts SET response_data = jsonb_set(response_data, '{deferred,next_check_at}',
    to_jsonb(now() - interval '1 minute'), true) WHERE id = row_i;
  ASSERT NOT EXISTS (SELECT 1 FROM public.claim_deferred_publishes(10) WHERE platform_post_id = row_i),
    'T33 cron cannot take a live inline lease';

  ASSERT NOT public.release_threads_image_publish_unsent(row_i, 'inline-container-1', claim_at,
    lease_at, 'inline-execution-1', 'wrong-marker', expected),
    'T34 release rejects a mismatched marker';
  ASSERT public.mark_threads_image_publish_started(row_i, lease_at, 'inline-execution-1', expected),
    'T35 the inline owner can persist its pre-send marker';
  saved := (SELECT response_data FROM public.platform_posts WHERE id = row_i);
  ASSERT NOT public.release_threads_image_publish_unsent(row_i, 'wrong-container', claim_at,
    lease_at, 'inline-execution-1', 'inline-execution-1', expected),
    'T36 release rejects a mismatched container';
  ASSERT NOT public.release_threads_image_publish_unsent(row_i, 'inline-container-1', claim_at,
    lease_at, 'wrong-execution', 'inline-execution-1', expected),
    'T37 release rejects a mismatched execution';
  ASSERT (SELECT response_data FROM public.platform_posts WHERE id = row_i) = saved,
    'T38 refused releases preserve all response data and ownership';

  ASSERT public.release_threads_image_publish_unsent(row_i, 'inline-container-1', claim_at,
    lease_at, 'inline-execution-1', 'inline-execution-1', expected),
    'T39 the exact definitely-unsent release succeeds';
  ASSERT (SELECT response_data #>> '{deferred,publish_attempt_id}' IS NULL
            AND response_data #>> '{deferred,execution_id}' = 'inline-execution-1'
            AND response_data #>> '{deferred,container_id}' = 'inline-container-1'
            AND response_data -> 'content_fence' = expected
            FROM public.platform_posts WHERE id = row_i),
    'T40 release removes only the matching marker';
  ASSERT NOT public.release_threads_image_publish_unsent(row_i, 'inline-container-1', claim_at,
    lease_at, 'inline-execution-1', 'inline-execution-1', expected),
    'T41 release replay is refused without a marker';

  UPDATE public.platform_posts SET response_data = jsonb_set(response_data,
    '{deferred,publish_attempt_id}', to_jsonb('inline-execution-1'::text), true) WHERE id = row_i;
  UPDATE public.posts SET status = 'failed' WHERE id = post_i;
  ASSERT NOT public.release_threads_image_publish_unsent(row_i, 'inline-container-1', claim_at,
    lease_at, 'inline-execution-1', 'inline-execution-1', expected),
    'T42 cancellation refuses release conservatively';
  UPDATE public.posts SET status = 'processing', caption = 'edited before release' WHERE id = post_i;
  ASSERT NOT public.release_threads_image_publish_unsent(row_i, 'inline-container-1', claim_at,
    lease_at, 'inline-execution-1', 'inline-execution-1', expected),
    'T43 edited content refuses release conservatively';
  UPDATE public.posts SET caption = 'inline synthetic image' WHERE id = post_i;
  UPDATE public.social_accounts SET is_active = false WHERE id = acct_th;
  ASSERT NOT public.release_threads_image_publish_unsent(row_i, 'inline-container-1', claim_at,
    lease_at, 'inline-execution-1', 'inline-execution-1', expected),
    'T44 an inactive credential refuses release';
  UPDATE public.social_accounts SET is_active = true WHERE id = acct_th;
  UPDATE public.platform_posts SET response_data = jsonb_set(response_data,
    '{deferred,publish_outcome}', to_jsonb('uncertain'::text), true) WHERE id = row_i;
  ASSERT NOT public.release_threads_image_publish_unsent(row_i, 'inline-container-1', claim_at,
    lease_at, 'inline-execution-1', 'inline-execution-1', expected),
    'T45 a real uncertain send can never be released';

  finalized := public.finalize_threads_image_attempt(post_i, claim_at, expected);
  ASSERT finalized->>'status' = 'processing' AND finalized->>'notify' = 'false'
    AND finalized->>'stale' = 'false', 'T46 pending work cannot finalize or notify';

  UPDATE public.platform_posts SET response_data = (response_data || jsonb_build_object('deferred',
    (response_data->'deferred') - 'publish_attempt_id' - 'publish_outcome')) WHERE id = row_i;
  PERFORM public.partner_settle_platform_post(row_i, post_i, acct_th, 'threads', 'success',
    'published-inline-1', NULL, NULL, (SELECT response_data FROM public.platform_posts WHERE id = row_i));
  finalized := public.finalize_threads_image_attempt(post_i, claim_at, expected);
  ASSERT finalized->>'status' = 'completed' AND finalized->>'notify' = 'true'
    AND finalized->>'stale' = 'false', 'T47 the original attempt claims its one final notification';
  ASSERT public.finalize_threads_image_attempt(post_i, claim_at, expected)->>'notify' = 'false',
    'T48 finalization replay cannot claim a second notification';
  ASSERT public.claim_threads_image_inline_execution(row_i, post_i, acct_th,
    'inline-container-1', claim_at, expected, 'terminal-replay') IS NULL,
    'T49 terminal inline-claim replay creates no execution';

  UPDATE public.posts SET processing_started_at = claim_at + interval '1 second', status = 'processing'
   WHERE id = post_i;
  finalized := public.finalize_threads_image_attempt(post_i, claim_at, expected);
  ASSERT finalized->>'stale' = 'true' AND finalized->>'notify' = 'false'
    AND (SELECT processing_started_at FROM public.posts WHERE id = post_i) = claim_at + interval '1 second',
    'T50 stale finalization cannot change or announce a newer parent';

  ASSERT NOT has_function_privilege('authenticated',
    'public.claim_threads_image_inline_execution(uuid,uuid,uuid,text,timestamptz,jsonb,text)', 'EXECUTE'),
    'T51 authenticated cannot claim inline execution';
  ASSERT NOT has_function_privilege('anon',
    'public.release_threads_image_publish_unsent(uuid,text,timestamptz,timestamptz,text,text,jsonb)', 'EXECUTE'),
    'T52 anon cannot release an image marker';
  ASSERT NOT has_function_privilege('authenticated',
    'public.finalize_threads_image_attempt(uuid,timestamptz,jsonb,uuid[])', 'EXECUTE'),
    'T53 authenticated cannot finalize an image attempt';
  ASSERT (SELECT bool_and(prosecdef AND 'search_path=public' = ANY(proconfig)) FROM pg_proc WHERE oid IN (
    'public.claim_threads_image_inline_execution(uuid,uuid,uuid,text,timestamptz,jsonb,text)'::regprocedure,
    'public.release_threads_image_publish_unsent(uuid,text,timestamptz,timestamptz,text,text,jsonb)'::regprocedure,
    'public.finalize_threads_image_attempt(uuid,timestamptz,jsonb,uuid[])'::regprocedure)),
    'T54 all new RPCs are security definer with a pinned search_path';
END $$;

-- T55: an old image can settle its own row without rolling back edited parent content.
DO $$
DECLARE
  u_a uuid := 'd1d1d1d1-1111-4111-8111-d1d1d1d1d1d1';
  acct_th uuid := 'd3d3d3d3-3333-4333-8333-d3d3d3d3d3d3';
  post_s uuid := 'e0000000-0000-4000-8000-0000000000e5';
  row_s uuid;
  claim_at timestamptz := now();
  expected jsonb;
  payload jsonb;
  claimed jsonb;
BEGIN
  INSERT INTO public.posts (id, user_id, caption, platforms, status, processing_started_at, source)
  VALUES (post_s, u_a, 'stale settlement image', ARRAY['threads'], 'processing', claim_at, 'manual');
  expected := jsonb_build_object(
    'user_id', u_a, 'caption', 'stale settlement image', 'media_file_ids', NULL,
    'metadata', '{}'::jsonb, 'platforms', ARRAY['threads'], 'scheduled_at', NULL,
    'publish_requested_at', NULL, 'source', 'manual'
  );
  payload := jsonb_build_object('deferred', jsonb_build_object(
    'kind', 'threads', 'media_type', 'IMAGE', 'container_id', 'stale-settlement-container',
    'attempt_started_at', claim_at, 'attempts', 0,
    'first_deferred_at', claim_at, 'give_up_at', claim_at + interval '30 minutes',
    'next_check_at', claim_at + interval '1 minute'
  ), 'content_fence', expected, 'account_updated_at',
    (SELECT updated_at FROM public.social_accounts WHERE id = acct_th));
  row_s := public.record_threads_image_checkpoint(post_s, acct_th, payload, claim_at, expected);
  claimed := public.claim_threads_image_inline_execution(row_s, post_s, acct_th,
    'stale-settlement-container', claim_at, expected, 'stale-settlement-execution');
  UPDATE public.posts SET caption = 'newer parent content' WHERE id = post_s;
  PERFORM public.partner_settle_platform_post(row_s, post_s, acct_th, 'threads', 'success',
    'published-stale-image', NULL, NULL, claimed->'response_data');
  ASSERT (SELECT status FROM public.platform_posts WHERE id = row_s) = 'success'
    AND (SELECT status FROM public.posts WHERE id = post_s) = 'processing'
    AND (SELECT caption FROM public.posts WHERE id = post_s) = 'newer parent content',
    'T55 stale image settlement preserves the newer parent while settling the same row';
END $$;

-- T56-T60: selected siblings and status-only cancellation are persisted fences.
DO $$
DECLARE
  u_a uuid := 'd1d1d1d1-1111-4111-8111-d1d1d1d1d1d1';
  acct_ig uuid := 'd2d2d2d2-2222-4222-8222-d2d2d2d2d2d2';
  acct_th uuid := 'd3d3d3d3-3333-4333-8333-d3d3d3d3d3d3';
  post_f uuid := 'e0000000-0000-4000-8000-0000000000e6';
  row_f uuid;
  claim_at timestamptz := now();
  expected jsonb;
  payload jsonb;
  claimed jsonb;
  finalized jsonb;
BEGIN
  INSERT INTO public.posts (id, user_id, caption, platforms, status, processing_started_at, source, metadata)
  VALUES (post_f, u_a, 'selected sibling image', ARRAY['instagram','threads'], 'processing', claim_at, 'manual',
    jsonb_build_object('selected_account_ids', jsonb_build_array(acct_ig, acct_th)));
  expected := jsonb_build_object(
    'user_id', u_a, 'caption', 'selected sibling image', 'media_file_ids', NULL,
    'metadata', jsonb_build_object('selected_account_ids', jsonb_build_array(acct_ig, acct_th)),
    'platforms', ARRAY['instagram','threads'], 'scheduled_at', NULL,
    'publish_requested_at', NULL, 'source', 'manual'
  );
  payload := jsonb_build_object('deferred', jsonb_build_object(
    'kind', 'threads', 'media_type', 'IMAGE', 'container_id', 'selected-sibling-container',
    'attempt_started_at', claim_at, 'attempts', 0,
    'first_deferred_at', claim_at, 'give_up_at', claim_at + interval '30 minutes',
    'next_check_at', claim_at + interval '1 minute'
  ), 'content_fence', expected, 'account_updated_at',
    (SELECT updated_at FROM public.social_accounts WHERE id = acct_th));
  row_f := public.record_threads_image_checkpoint(post_f, acct_th, payload, claim_at, expected);
  claimed := public.claim_threads_image_inline_execution(row_f, post_f, acct_th,
    'selected-sibling-container', claim_at, expected, 'selected-sibling-execution');
  PERFORM public.partner_settle_platform_post(row_f, post_f, acct_th, 'threads', 'success',
    'published-selected-image', NULL, NULL, claimed->'response_data');

  finalized := public.finalize_threads_image_attempt(post_f, claim_at, expected);
  ASSERT finalized->>'status' = 'processing' AND finalized->>'notify' = 'false'
    AND (SELECT status FROM public.posts WHERE id = post_f) = 'processing',
    'T56 a selected sibling without a durable row prevents final status and notification';

  UPDATE public.posts SET status = 'pending' WHERE id = post_f;
  finalized := public.finalize_threads_image_attempt(post_f, claim_at, expected);
  ASSERT finalized->>'status' = 'pending' AND finalized->>'stale' = 'true'
    AND finalized->>'notify' = 'false'
    AND (SELECT status FROM public.posts WHERE id = post_f) = 'pending',
    'T57 status-only pending cancellation is preserved with unchanged content and attempt';
  UPDATE public.posts SET status = 'processing' WHERE id = post_f;

  INSERT INTO public.platform_posts (post_id, social_account_id, platform, status, platform_post_id)
  VALUES (post_f, acct_ig, 'instagram', 'success', 'selected-sibling-instagram');
  finalized := public.finalize_threads_image_attempt(post_f, claim_at, expected);
  ASSERT finalized->>'status' = 'completed' AND finalized->>'stale' = 'false'
    AND finalized->>'notify' = 'true',
    'T58 the original processing attempt finalizes after every selected sibling has a result';

  UPDATE public.posts SET status = 'failed' WHERE id = post_f;
  finalized := public.finalize_threads_image_attempt(post_f, claim_at, expected);
  ASSERT finalized->>'status' = 'failed' AND finalized->>'notify' = 'false'
    AND (SELECT status FROM public.posts WHERE id = post_f) = 'failed',
    'T59 a later status-only terminal change is never overwritten by finalization replay';
END $$;

DO $$
DECLARE
  u_a uuid := 'd1d1d1d1-1111-4111-8111-d1d1d1d1d1d1';
  acct_th uuid := 'd3d3d3d3-3333-4333-8333-d3d3d3d3d3d3';
  post_c uuid := 'e0000000-0000-4000-8000-0000000000e7';
  row_c uuid;
  claim_at timestamptz := now();
  expected jsonb;
  payload jsonb;
  claimed jsonb;
BEGIN
  INSERT INTO public.posts (id, user_id, caption, platforms, status, processing_started_at, source)
  VALUES (post_c, u_a, 'status only cancel image', ARRAY['threads'], 'processing', claim_at, 'manual');
  expected := jsonb_build_object(
    'user_id', u_a, 'caption', 'status only cancel image', 'media_file_ids', NULL,
    'metadata', '{}'::jsonb, 'platforms', ARRAY['threads'], 'scheduled_at', NULL,
    'publish_requested_at', NULL, 'source', 'manual'
  );
  payload := jsonb_build_object('deferred', jsonb_build_object(
    'kind', 'threads', 'media_type', 'IMAGE', 'container_id', 'status-only-cancel-container',
    'attempt_started_at', claim_at, 'attempts', 0,
    'first_deferred_at', claim_at, 'give_up_at', claim_at + interval '30 minutes',
    'next_check_at', claim_at + interval '1 minute'
  ), 'content_fence', expected, 'account_updated_at',
    (SELECT updated_at FROM public.social_accounts WHERE id = acct_th));
  row_c := public.record_threads_image_checkpoint(post_c, acct_th, payload, claim_at, expected);
  claimed := public.claim_threads_image_inline_execution(row_c, post_c, acct_th,
    'status-only-cancel-container', claim_at, expected, 'status-only-cancel-execution');
  UPDATE public.posts SET status = 'pending' WHERE id = post_c;
  PERFORM public.partner_settle_platform_post(row_c, post_c, acct_th, 'threads', 'success',
    'published-status-only-cancel', NULL, NULL, claimed->'response_data');
  ASSERT (SELECT status FROM public.platform_posts WHERE id = row_c) = 'success'
    AND (SELECT status FROM public.posts WHERE id = post_c) = 'pending'
    AND (SELECT caption FROM public.posts WHERE id = post_c) = 'status only cancel image',
    'T60 old image settlement preserves status-only cancellation with identical content and attempt';
END $$;

-- T61-T64: A02 (status-only cancellation vs sibling rollup), A03 (lost settlement ACK replay),
-- and A04 (sibling completeness with multi-account list).
DO $$
DECLARE
  u_a uuid := 'd1d1d1d1-1111-4111-8111-d1d1d1d1d1d1';
  acct_th uuid := 'd3d3d3d3-3333-4333-8333-d3d3d3d3d3d3';
  acct_th2 uuid := 'd4d4d4d4-4444-4444-8444-d4d4d4d4d4d4';
  post_a02 uuid := 'e0000000-0000-4000-8000-0000000000f1';
  post_a03 uuid := 'e0000000-0000-4000-8000-0000000000f2';
  post_a04 uuid := 'e0000000-0000-4000-8000-0000000000f3';
  post_a05 uuid := 'e0000000-0000-4000-8000-0000000000f5';
  row_id uuid;
  row_ack uuid;
  row_th1 uuid;
  claim_at timestamptz := now();
  expected jsonb;
  payload jsonb;
  claimed jsonb;
  finalized jsonb;
  caught_cancel boolean := false;
BEGIN
  -- Insert second Threads account for user u_a
  INSERT INTO public.social_accounts (id, user_id, platform, platform_user_id, platform_username, access_token, is_active)
  VALUES (acct_th2, u_a, 'threads', 'dp-th2', 'dp_th2', 'tok-th2', true)
  ON CONFLICT (id) DO NOTHING;

  -- T61: A02 status-only cancellation rejects admission without settlement_rollup_at
  INSERT INTO public.posts (id, user_id, caption, platforms, status, processing_started_at, source)
  VALUES (post_a02, u_a, 'a02 cancellation post', ARRAY['threads'], 'failed', claim_at, 'manual');

  expected := jsonb_build_object(
    'user_id', u_a, 'caption', 'a02 cancellation post', 'media_file_ids', NULL,
    'metadata', '{}'::jsonb, 'platforms', ARRAY['threads'], 'scheduled_at', NULL,
    'publish_requested_at', NULL, 'source', 'manual'
  );
  payload := jsonb_build_object('deferred', jsonb_build_object(
    'kind', 'threads', 'media_type', 'IMAGE', 'container_id', 'a02-cancel-container',
    'attempt_started_at', claim_at, 'attempts', 0,
    'first_deferred_at', claim_at, 'give_up_at', claim_at + interval '30 minutes',
    'next_check_at', claim_at + interval '1 minute'
  ), 'content_fence', expected, 'account_updated_at',
    (SELECT updated_at FROM public.social_accounts WHERE id = acct_th));

  BEGIN
    PERFORM public.record_threads_image_checkpoint(post_a02, acct_th, payload, claim_at, expected);
  EXCEPTION WHEN serialization_failure THEN
    caught_cancel := true;
  END;
  ASSERT caught_cancel, 'T61 status-only failed cancellation raises serialization_failure on admission';
  ASSERT (SELECT status FROM public.posts WHERE id = post_a02) = 'failed',
    'T61 post remains failed and was not resurrected';

  -- T62: A02 sibling rollup with settlement_rollup_at permits admission and reopens processing
  UPDATE public.posts
     SET metadata = jsonb_build_object('settlement_rollup_at', claim_at + interval '10 seconds')
   WHERE id = post_a02;
  INSERT INTO public.platform_posts (id, post_id, social_account_id, platform, status, response_data, created_at)
  VALUES ('f0000000-0000-4000-8000-0000000000f1', post_a02, acct_th2, 'threads', 'success', '{}'::jsonb, claim_at);

  row_id := public.record_threads_image_checkpoint(post_a02, acct_th, payload, claim_at, expected);
  ASSERT row_id IS NOT NULL, 'T62 checkpoint admitted under legitimate sibling rollup';
  ASSERT (SELECT status FROM public.posts WHERE id = post_a02) = 'processing',
    'T62 post status reopened to processing for sibling admission';

  -- T63: A03 lost settlement ACK replay on already-settled row returns existing ID without modifying parent
  INSERT INTO public.posts (id, user_id, caption, platforms, status, processing_started_at, source)
  VALUES (post_a03, u_a, 'a03 lost ack post', ARRAY['threads'], 'completed', claim_at, 'manual');
  expected := jsonb_build_object(
    'user_id', u_a, 'caption', 'a03 lost ack post', 'media_file_ids', NULL,
    'metadata', '{}'::jsonb, 'platforms', ARRAY['threads'], 'scheduled_at', NULL,
    'publish_requested_at', NULL, 'source', 'manual'
  );
  payload := jsonb_build_object('deferred', jsonb_build_object(
    'kind', 'threads', 'media_type', 'IMAGE', 'container_id', 'a03-ack-container',
    'attempt_started_at', claim_at, 'attempts', 0,
    'first_deferred_at', claim_at, 'give_up_at', claim_at + interval '30 minutes',
    'next_check_at', claim_at + interval '1 minute'
  ), 'content_fence', expected, 'account_updated_at',
    (SELECT updated_at FROM public.social_accounts WHERE id = acct_th));

  INSERT INTO public.platform_posts (id, post_id, social_account_id, platform, status, response_data, created_at)
  VALUES ('f0000000-0000-4000-8000-0000000000f2', post_a03, acct_th, 'threads', 'success', payload, claim_at);

  row_ack := public.record_threads_image_checkpoint(post_a03, acct_th, payload, claim_at, expected);
  ASSERT row_ack = 'f0000000-0000-4000-8000-0000000000f2'::uuid,
    'T63 lost settlement ACK returns existing platform_post id';
  ASSERT (SELECT status FROM public.posts WHERE id = post_a03) = 'completed',
    'T63 parent completed status preserved on lost settlement ACK replay';

  -- T64: A04 sibling completeness with multiple accounts of the same platform (Threads)
  INSERT INTO public.posts (id, user_id, caption, platforms, status, processing_started_at, source, metadata)
  VALUES (post_a04, u_a, 'a04 multi-threads image', ARRAY['threads'], 'processing', claim_at, 'manual',
    jsonb_build_object('selected_account_ids', jsonb_build_array(acct_th, acct_th2)));
  expected := jsonb_build_object(
    'user_id', u_a, 'caption', 'a04 multi-threads image', 'media_file_ids', NULL,
    'metadata', jsonb_build_object('selected_account_ids', jsonb_build_array(acct_th, acct_th2)),
    'platforms', ARRAY['threads'], 'scheduled_at', NULL,
    'publish_requested_at', NULL, 'source', 'manual'
  );
  payload := jsonb_build_object('deferred', jsonb_build_object(
    'kind', 'threads', 'media_type', 'IMAGE', 'container_id', 'a04-container-1',
    'attempt_started_at', claim_at, 'attempts', 0,
    'first_deferred_at', claim_at, 'give_up_at', claim_at + interval '30 minutes',
    'next_check_at', claim_at + interval '1 minute'
  ), 'content_fence', expected, 'account_updated_at',
    (SELECT updated_at FROM public.social_accounts WHERE id = acct_th));

  row_th1 := public.record_threads_image_checkpoint(post_a04, acct_th, payload, claim_at, expected);
  claimed := public.claim_threads_image_inline_execution(row_th1, post_a04, acct_th,
    'a04-container-1', claim_at, expected, 'a04-execution-1');
  PERFORM public.partner_settle_platform_post(row_th1, post_a04, acct_th, 'threads', 'success',
    'published-th1', NULL, NULL, claimed->'response_data');

  -- Finalize with expected account list [acct_th, acct_th2]: only 1 is settled, so status stays processing
  finalized := public.finalize_threads_image_attempt(post_a04, claim_at, expected, ARRAY[acct_th, acct_th2]);
  ASSERT finalized->>'status' = 'processing' AND finalized->>'notify' = 'false',
    'T64 only one of two Threads accounts settled keeps post processing';

  -- Settle second Threads account
  INSERT INTO public.platform_posts (id, post_id, social_account_id, platform, status, platform_post_id)
  VALUES ('f0000000-0000-4000-8000-0000000000f4', post_a04, acct_th2, 'threads', 'success', 'published-th2');

  finalized := public.finalize_threads_image_attempt(post_a04, claim_at, expected, ARRAY[acct_th, acct_th2]);
  ASSERT finalized->>'status' = 'completed' AND finalized->>'notify' = 'true',
    'T64 all expected Threads accounts settled completes the post';

  -- T65: trg_posts_invalidate_rollup_on_cancellation strips rollup provenance on status change to failed
  UPDATE public.posts
     SET status = 'processing',
         metadata = jsonb_build_object('settlement_rollup_at', claim_at, 'settlement_rollup_status', 'failed')
   WHERE id = post_a02;
  ASSERT (SELECT metadata->>'settlement_rollup_at' FROM public.posts WHERE id = post_a02) IS NOT NULL,
    'T65 setup: settlement_rollup_at is present before status change';

  UPDATE public.posts
     SET status = 'failed'
   WHERE id = post_a02;
  ASSERT (SELECT metadata->>'settlement_rollup_at' FROM public.posts WHERE id = post_a02) IS NULL,
    'T65 trg_posts_invalidate_rollup_on_cancellation stripped settlement_rollup_at on update to failed';

  -- T66: record_threads_image_checkpoint persists authoritative target and retained account IDs
  INSERT INTO public.posts (id, user_id, caption, platforms, status, processing_started_at, source, metadata)
  VALUES (post_a05, u_a, 'a06 target and retained account post', ARRAY['threads'], 'processing', claim_at, 'manual', '{}'::jsonb);
  expected := jsonb_build_object(
    'user_id', u_a, 'caption', 'a06 target and retained account post', 'media_file_ids', NULL,
    'metadata', '{}'::jsonb,
    'platforms', ARRAY['threads'], 'scheduled_at', NULL,
    'publish_requested_at', NULL, 'source', 'manual'
  );
  payload := jsonb_build_object('deferred', jsonb_build_object(
    'kind', 'threads', 'media_type', 'IMAGE', 'container_id', 'a06-container-1',
    'attempt_started_at', claim_at, 'attempts', 0,
    'first_deferred_at', claim_at, 'give_up_at', claim_at + interval '30 minutes',
    'next_check_at', claim_at + interval '1 minute'
  ), 'content_fence', expected, 'account_updated_at',
    (SELECT updated_at FROM public.social_accounts WHERE id = acct_th));

  INSERT INTO public.platform_posts (id, post_id, social_account_id, platform, status, platform_post_id)
  VALUES ('f0000000-0000-4000-8000-0000000000f5', post_a05, acct_th2, 'threads', 'success', 'prior-success-th2');

  row_id := public.record_threads_image_checkpoint(
    post_a05, acct_th, payload, claim_at, expected,
    ARRAY[acct_th, acct_th2], ARRAY[acct_th2]
  );
  ASSERT (SELECT (metadata->'attempt_target_account_ids') = jsonb_build_array(acct_th::text, acct_th2::text) FROM public.posts WHERE id = post_a05),
    'T66 attempt_target_account_ids persisted in posts.metadata';
  ASSERT (SELECT (metadata->'attempt_retained_account_ids') = jsonb_build_array(acct_th2::text) FROM public.posts WHERE id = post_a05),
    'T66 attempt_retained_account_ids persisted in posts.metadata';

  -- T67: claim_deferred_publishes claims terminal post row when final notification intent is unconfirmed
  UPDATE public.posts
     SET status = 'completed',
         processing_started_at = claim_at,
         metadata = jsonb_build_object('final_notification_intent', jsonb_build_object(
           'status', 'completed', 'attempt_started_at', claim_at, 'notified', false, 'created_at', now()
         ))
   WHERE id = post_a05;
  UPDATE public.platform_posts
     SET status = 'success',
         response_data = jsonb_build_object('deferred', jsonb_build_object(
           'kind', 'threads', 'media_type', 'IMAGE', 'container_id', 'a06-container-1',
           'attempt_started_at', claim_at, 'next_check_at', now() - interval '10 seconds',
           'claimed_until', now() - interval '10 seconds'
         ))
   WHERE id = row_id;

  ASSERT EXISTS (
    SELECT 1 FROM public.claim_deferred_publishes(10)
     WHERE platform_post_id = row_id
  ), 'T67 claim_deferred_publishes claims terminal row with unconfirmed notification intent';
END $$;

-- A02 rolling compatibility: M1 checkpoints can contain prior-cycle output metadata.
DO $$
DECLARE
  owner_id uuid := 'd1d1d1d1-1111-4111-8111-d1d1d1d1d1d1';
  account_id uuid := 'd3d3d3d3-3333-4333-8333-d3d3d3d3d3d3';
  legacy_post_id uuid := 'e0000000-0000-4000-8000-0000000000f8';
  row_id uuid;
  attempt_at timestamptz := now();
  lease_at timestamptz;
  legacy_fence jsonb;
  current_fence jsonb;
  payload jsonb;
  claimed jsonb;
  saved jsonb;
BEGIN
  INSERT INTO public.posts (id, user_id, caption, platforms, status, processing_started_at, source, metadata)
  VALUES (legacy_post_id, owner_id, 'legacy checkpoint fence', ARRAY['threads'], 'processing', attempt_at, 'manual',
    jsonb_build_object('final_notified_at', attempt_at - interval '1 day'));
  legacy_fence := jsonb_build_object(
    'user_id', owner_id, 'caption', 'legacy checkpoint fence', 'media_file_ids', NULL,
    'metadata', jsonb_build_object('final_notified_at', attempt_at - interval '1 day'),
    'platforms', ARRAY['threads'], 'scheduled_at', NULL, 'publish_requested_at', NULL, 'source', 'manual'
  );
  current_fence := jsonb_set(legacy_fence, '{metadata}',
    public.normalize_threads_internal_metadata(legacy_fence -> 'metadata'));
  payload := jsonb_build_object('deferred', jsonb_build_object(
    'kind', 'threads', 'media_type', 'IMAGE', 'container_id', 'legacy-fence-container',
    'attempt_started_at', attempt_at, 'attempts', 0, 'first_deferred_at', attempt_at,
    'give_up_at', attempt_at + interval '30 minutes', 'next_check_at', attempt_at + interval '1 minute'
  ), 'content_fence', legacy_fence, 'account_updated_at',
    (SELECT updated_at FROM public.social_accounts WHERE id = account_id));
  row_id := public.record_threads_image_checkpoint(legacy_post_id, account_id, payload, attempt_at, legacy_fence);
  ASSERT (SELECT response_data -> 'content_fence' FROM public.platform_posts WHERE id = row_id) = legacy_fence,
    'T68 legacy stored output metadata is retained during rolling compatibility';

  UPDATE public.posts SET caption = 'owner edit' WHERE id = legacy_post_id;
  ASSERT public.claim_threads_image_inline_execution(row_id, legacy_post_id, account_id,
    'legacy-fence-container', attempt_at, current_fence, 'legacy-fence-execution') IS NULL,
    'T69 normalization never permits an actual publishing-input edit';
  UPDATE public.posts SET caption = 'legacy checkpoint fence' WHERE id = legacy_post_id;
  claimed := public.claim_threads_image_inline_execution(row_id, legacy_post_id, account_id,
    'legacy-fence-container', attempt_at, current_fence, 'legacy-fence-execution');
  ASSERT claimed ->> 'platform_post_id' = row_id::text AND claimed IS NOT NULL,
    'T70 an unchanged legacy fence can acquire inline ownership';
  lease_at := (claimed #>> '{response_data,deferred,claimed_until}')::timestamptz;
  ASSERT public.mark_threads_image_publish_started(row_id, lease_at, 'legacy-fence-execution', current_fence),
    'T71 an unchanged legacy fence can persist its publish marker';
  ASSERT public.release_threads_image_publish_unsent(row_id, 'legacy-fence-container', attempt_at,
    lease_at, 'legacy-fence-execution', 'legacy-fence-execution', current_fence),
    'T72 an unchanged legacy fence permits only the exact definitely-unsent release';
  ASSERT public.mark_threads_image_publish_started(row_id, lease_at, 'legacy-fence-execution', current_fence),
    'T73 the same owner can mark again after an acknowledged unsent release';
  saved := (SELECT response_data FROM public.platform_posts WHERE id = row_id);
  PERFORM public.partner_settle_platform_post(row_id, legacy_post_id, account_id, 'threads', 'success',
    'legacy-fence-published', NULL, NULL, saved);
  ASSERT (SELECT status FROM public.platform_posts WHERE id = row_id) = 'success'
    AND (SELECT count(*) FROM public.platform_posts WHERE post_id = legacy_post_id) = 1,
    'T74 legacy fence completion settles the original durable row';
END $$;

-- T75-T79: Round 3 MUST_FIX verifications (A03, A04, A06, A05)
DO $$
DECLARE
  owner_id uuid := 'd1d1d1d1-1111-4111-8111-d1d1d1d1d1d1';
  foreign_id uuid := 'e2e2e2e2-2222-4222-8222-e2e2e2e2e2e2';
  acct_1 uuid := 'd3d3d3d3-3333-4333-8333-d3d3d3d3d3d3';
  acct_2 uuid := 'd4d4d4d4-4444-4444-8444-d4d4d4d4d4d4';
  acct_foreign uuid := 'e3e3e3e3-3333-4333-8333-e3e3e3e3e3e3';
  p_t75 uuid := 'e0000000-0000-4000-8000-000000000075';
  p_t78 uuid := 'e0000000-0000-4000-8000-000000000078';
  p_t79 uuid := 'e0000000-0000-4000-8000-000000000079';
  attempt_at timestamptz := now() - interval '5 minutes';
  fence_t75 jsonb;
  fence_t78 jsonb;
  payload jsonb;
  res jsonb;
  err_caught boolean;
  first_notification_claim uuid;
  recovered_notification_claim uuid;
BEGIN
  -- Setup foreign user and accounts
  INSERT INTO auth.users (id, email) VALUES (foreign_id, 'foreign-user@example.invalid')
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.social_accounts (id, user_id, platform, platform_user_id, platform_username, access_token, is_active)
  VALUES
    (acct_2, owner_id, 'threads', 'dp-th-2', 'dp_th_2', 'tok-th-2', true),
    (acct_foreign, foreign_id, 'threads', 'dp-foreign', 'dp_foreign', 'tok-foreign', true)
  ON CONFLICT (id) DO NOTHING;

  -- =========================================================================
  -- T75: New target account with old unlisted success staying 'processing'
  -- =========================================================================
  INSERT INTO public.posts (id, user_id, caption, platforms, status, processing_started_at, source, metadata)
  VALUES (p_t75, owner_id, 't75 post', ARRAY['threads'], 'processing', attempt_at, 'manual',
    jsonb_build_object(
      'attempt_started_at', attempt_at,
      'attempt_target_account_ids', jsonb_build_array(acct_1, acct_2),
      'attempt_retained_account_ids', '[]'::jsonb
    ));

  fence_t75 := jsonb_build_object(
    'user_id', owner_id, 'caption', 't75 post', 'media_file_ids', NULL,
    'metadata', '{}'::jsonb,
    'platforms', ARRAY['threads'], 'scheduled_at', NULL, 'publish_requested_at', NULL, 'source', 'manual'
  );

  -- Old historical success for acct_1 from prior attempt (not in attempt_retained_account_ids)
  INSERT INTO public.platform_posts (id, post_id, social_account_id, platform, status, created_at, response_data)
  VALUES ('f0000000-0000-4000-8000-000000000071', p_t75, acct_1, 'threads', 'success', attempt_at - interval '1 hour',
    jsonb_build_object('deferred', jsonb_build_object('kind', 'threads', 'media_type', 'IMAGE', 'attempt_started_at', attempt_at - interval '1 hour')));

  -- Current success for acct_2 from this attempt
  INSERT INTO public.platform_posts (id, post_id, social_account_id, platform, status, created_at, response_data)
  VALUES ('f0000000-0000-4000-8000-000000000072', p_t75, acct_2, 'threads', 'success', attempt_at + interval '10 seconds',
    jsonb_build_object('deferred', jsonb_build_object('kind', 'threads', 'media_type', 'IMAGE', 'attempt_started_at', attempt_at)));

  -- finalize_threads_image_attempt: acct_1 was target but its success is from prior attempt and unlisted
  res := public.finalize_threads_image_attempt(p_t75, attempt_at, fence_t75, ARRAY[acct_1, acct_2]);
  ASSERT res ->> 'status' = 'processing' AND (res ->> 'notify')::boolean = false,
    format('T75 unlisted prior success does not satisfy new target; must stay processing (got %s)', res);

  -- =========================================================================
  -- T76: Mismatched explicit scope arguments rejected
  -- =========================================================================
  payload := jsonb_build_object(
    'deferred', jsonb_build_object(
      'kind', 'threads', 'media_type', 'IMAGE', 'container_id', 'c-t76',
      'attempt_started_at', attempt_at, 'attempts', 0, 'first_deferred_at', attempt_at,
      'give_up_at', attempt_at + interval '30 minutes', 'next_check_at', attempt_at + interval '1 minute'
    ),
    'content_fence', fence_t75,
    'account_updated_at', (SELECT updated_at FROM public.social_accounts WHERE id = acct_1)
  );

  err_caught := false;
  BEGIN
    -- Mismatched target accounts against existing attempt_target_account_ids
    PERFORM public.record_threads_image_checkpoint(
      p_t75, acct_1, payload, attempt_at, fence_t75,
      ARRAY[acct_1] -- diverges from [acct_1, acct_2]
    );
  EXCEPTION WHEN OTHERS THEN
    err_caught := true;
  END;
  ASSERT err_caught, 'T76 divergent target scope arguments rejected during checkpointing';

  -- =========================================================================
  -- T77: Foreign tenant account rejected
  -- =========================================================================
  err_caught := false;
  BEGIN
    PERFORM public.record_threads_image_checkpoint(
      p_t75, acct_foreign, payload, attempt_at, fence_t75,
      ARRAY[acct_1, acct_2]
    );
  EXCEPTION WHEN OTHERS THEN
    err_caught := true;
  END;
  ASSERT err_caught, 'T77 foreign tenant account rejected during checkpointing';

  -- =========================================================================
  -- T78: Notification claim lease, dispatch failure simulation, expiry, confirmation
  -- =========================================================================
  INSERT INTO public.posts (id, user_id, caption, platforms, status, processing_started_at, source, metadata)
  VALUES (p_t78, owner_id, 't78 notification post', ARRAY['threads'], 'completed', attempt_at, 'manual',
    jsonb_build_object(
      'attempt_started_at', attempt_at,
      'final_notification_intent', jsonb_build_object(
        'status', 'completed',
        'attempt_started_at', attempt_at,
        'notified', false,
        'created_at', now()
      )
    ));

  fence_t78 := jsonb_build_object(
    'user_id', owner_id, 'caption', 't78 notification post', 'media_file_ids', NULL,
    'metadata', '{}'::jsonb,
    'platforms', ARRAY['threads'], 'scheduled_at', NULL, 'publish_requested_at', NULL, 'source', 'manual'
  );

  -- 1. Initial claim succeeds with lease
  res := public.claim_threads_image_notification(p_t78, attempt_at, 'completed', fence_t78, interval '3 minutes');
  ASSERT (res ->> 'claimed')::boolean = true, format('T78 initial notification claim succeeds (got %s)', res);
  first_notification_claim := (res ->> 'claim_id')::uuid;
  ASSERT first_notification_claim IS NOT NULL, 'T78 notification ownership has a durable claim identity';

  -- 2. Immediate second claim rejected with lease_held
  res := public.claim_threads_image_notification(p_t78, attempt_at, 'completed', fence_t78, interval '3 minutes');
  ASSERT (res ->> 'claimed')::boolean = false AND res ->> 'error' = 'lease_held',
    format('T78 concurrent claim rejected while lease held (got %s)', res);

  -- 3. Simulate dispatch failure / lease expiry by winding back claimed_until
  UPDATE public.posts
     SET metadata = jsonb_set(metadata, '{final_notification_intent,claimed_until}', to_jsonb(now() - interval '1 second'))
   WHERE id = p_t78;

  -- 4. Reclaim after expiry succeeds
  res := public.claim_threads_image_notification(p_t78, attempt_at, 'completed', fence_t78, interval '3 minutes');
  ASSERT (res ->> 'claimed')::boolean = true, format('T78 reclaim after lease expiry succeeds (got %s)', res);
  recovered_notification_claim := (res ->> 'claim_id')::uuid;
  ASSERT recovered_notification_claim IS DISTINCT FROM first_notification_claim, 'T78 lease recovery receives a new owner';
  res := public.confirm_threads_image_notification(p_t78, attempt_at, 'completed', fence_t78, first_notification_claim);
  ASSERT res ->> 'confirmed' = 'false', 'T78 an expired owner cannot confirm the replacement owner delivery';
  ASSERT (SELECT metadata #>> '{final_notification_intent,notified}' FROM public.posts WHERE id = p_t78) = 'false',
    'T78 stale confirmation leaves the new intent recoverable';

  -- 5. Confirm notification delivery
  res := public.confirm_threads_image_notification(p_t78, attempt_at, 'completed', fence_t78, recovered_notification_claim);
  ASSERT (res ->> 'confirmed')::boolean = true, format('T78 notification confirmation succeeds (got %s)', res);
  ASSERT (SELECT (metadata ->> 'final_notified_at') IS NOT NULL FROM public.posts WHERE id = p_t78),
    'T78 final_notified_at stamped on confirmation';

  -- 6. Claim after confirmation rejected with already_notified / intent_unusable
  res := public.claim_threads_image_notification(p_t78, attempt_at, 'completed', fence_t78, interval '3 minutes');
  ASSERT (res ->> 'claimed')::boolean = false, format('T78 claim rejected after confirmation (got %s)', res);

  -- =========================================================================
  -- T79: Owner cancellation invalidates final notification intent
  -- =========================================================================
  INSERT INTO public.posts (id, user_id, caption, platforms, status, processing_started_at, source, metadata)
  VALUES (p_t79, owner_id, 't79 cancel post', ARRAY['threads'], 'completed', attempt_at, 'manual',
    jsonb_build_object(
      'final_notification_intent', jsonb_build_object(
        'status', 'completed',
        'attempt_started_at', attempt_at,
        'notified', false
      )
    ));

  -- User or system resets the post to failed
  UPDATE public.posts SET status = 'failed' WHERE id = p_t79;
  ASSERT (SELECT metadata -> 'final_notification_intent' FROM public.posts WHERE id = p_t79) IS NULL,
    'T79 cancellation trigger strips final_notification_intent on status divergence';

END $$;

ROLLBACK;

\echo '=== deferred_publishes: ALL CHECKS PASSED ==='

