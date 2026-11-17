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
    ARRAY[acct_th, acct_th2], ARRAY['f0000000-0000-4000-8000-0000000000f5'::uuid]
  );
  ASSERT (SELECT (metadata->'attempt_target_account_ids') = jsonb_build_array(acct_th::text, acct_th2::text) FROM public.posts WHERE id = post_a05),
    'T66 attempt_target_account_ids persisted in posts.metadata';
  ASSERT (SELECT (metadata->'attempt_retained_platform_post_ids') = jsonb_build_array('f0000000-0000-4000-8000-0000000000f5') FROM public.posts WHERE id = post_a05),
    'T66 attempt_retained_platform_post_ids persisted in posts.metadata';
  ASSERT (SELECT (metadata ? 'attempt_retained_account_ids') FROM public.posts WHERE id = post_a05) = false,
    'T66 attempt_retained_account_ids stripped from posts.metadata';

  -- T67: claim_deferred_publishes claims terminal post row when final notification intent is unconfirmed
  UPDATE public.posts
     SET status = 'completed',
         processing_started_at = claim_at,
         metadata = jsonb_build_object('final_notification_intent', jsonb_build_object(
           'status', 'completed', 'attempt_started_at', claim_at, 'notified', false, 'created_at', now()
         ))
   WHERE id = post_a05;
  UPDATE public.posts p SET metadata=jsonb_set(metadata,'{final_notification_intent,content_hash}',to_jsonb(md5(jsonb_build_object(
    'user_id',p.user_id,'caption',p.caption,'media_file_ids',p.media_file_ids,
    'metadata',public.normalize_threads_internal_metadata(p.metadata),'platforms',p.platforms,
    'scheduled_at',p.scheduled_at,'publish_requested_at',p.publish_requested_at,'source',p.source)::text)))
    WHERE id=post_a05;
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
  p_t80 uuid := 'e0000000-0000-4000-8000-000000000080';
  p_t81 uuid := 'e0000000-0000-4000-8000-000000000081';
  p_t82 uuid := 'e0000000-0000-4000-8000-000000000082';
  attempt_at timestamptz := now() - interval '5 minutes';
  fence_t75 jsonb;
  fence_t78 jsonb;
  fence_t80 jsonb;
  fence_t81 jsonb;
  fence_t82 jsonb;
  payload jsonb;
  res jsonb;
  err_caught boolean;
  first_notification_claim uuid;
  recovered_notification_claim uuid;
  row_s1 uuid := 'f0000000-0000-4000-8000-000000000081';
  row_f1 uuid := 'f0000000-0000-4000-8000-000000000082';
  row_curr uuid := 'f0000000-0000-4000-8000-000000000083';
  row_foreign uuid := 'f0000000-0000-4000-8000-000000000084';
  row_other_post uuid := 'f0000000-0000-4000-8000-000000000085';
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
      'attempt_retained_platform_post_ids', '[]'::jsonb
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
      ARRAY[acct_1], ARRAY[]::uuid[] -- diverges from [acct_1, acct_2]
    );
  EXCEPTION WHEN data_exception THEN
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
      ARRAY[acct_1, acct_2], ARRAY[]::uuid[]
    );
  EXCEPTION WHEN foreign_key_violation THEN
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
      'attempt_target_account_ids', jsonb_build_array(acct_1),
      'final_notification_intent', jsonb_build_object(
        'status', 'completed',
        'attempt_started_at', attempt_at,
        'notified', false,
        'authorized_platform_post_ids', jsonb_build_array('f0000000-0000-4000-8000-000000000078'),
        'created_at', now()
      )
    ));
  INSERT INTO public.platform_posts(id, post_id, social_account_id, platform, status, created_at)
  VALUES ('f0000000-0000-4000-8000-000000000078', p_t78, acct_1, 'threads', 'success', attempt_at);

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

  -- =========================================================================
  -- T80: Two historical rows (same account): one explicit retained success +
  -- another failed/pending row. Unlisted row must not change final status,
  -- hold processing, or appear in final payload.
  -- =========================================================================
  INSERT INTO public.posts (id, user_id, caption, platforms, status, processing_started_at, source, metadata)
  VALUES (p_t80, owner_id, 't80 post', ARRAY['threads'], 'processing', attempt_at, 'manual', '{}'::jsonb);

  fence_t80 := jsonb_build_object(
    'user_id', owner_id, 'caption', 't80 post', 'media_file_ids', NULL,
    'metadata', '{}'::jsonb,
    'platforms', ARRAY['threads'], 'scheduled_at', NULL, 'publish_requested_at', NULL, 'source', 'manual'
  );

  -- Account 1: historical successful row (to be explicitly retained)
  INSERT INTO public.platform_posts (id, post_id, social_account_id, platform, status, created_at, response_data)
  VALUES (row_s1, p_t80, acct_1, 'threads', 'success', attempt_at - interval '2 hours',
    jsonb_build_object('deferred', jsonb_build_object('kind', 'threads', 'media_type', 'IMAGE', 'attempt_started_at', attempt_at - interval '2 hours')));

  -- Account 1: another historical row that is failed (must NOT be included or hold processing)
  INSERT INTO public.platform_posts (id, post_id, social_account_id, platform, status, created_at, response_data)
  VALUES (row_f1, p_t80, acct_1, 'threads', 'failed', attempt_at - interval '1 hour',
    jsonb_build_object('error', 'prior attempt failure'));

  payload := jsonb_build_object(
    'deferred', jsonb_build_object(
      'kind', 'threads', 'media_type', 'IMAGE', 'container_id', 'c-t80',
      'attempt_started_at', attempt_at, 'attempts', 0, 'first_deferred_at', attempt_at,
      'give_up_at', attempt_at + interval '30 minutes', 'next_check_at', attempt_at + interval '1 minute'
    ),
    'content_fence', fence_t80,
    'account_updated_at', (SELECT updated_at FROM public.social_accounts WHERE id = acct_2)
  );

  -- Checkpoint for acct_2 explicitly retains row_s1
  row_curr := public.record_threads_image_checkpoint(
    p_t80, acct_2, payload, attempt_at, fence_t80,
    ARRAY[acct_2], ARRAY[row_s1]
  );

  -- Settled to success after checkpoint
  UPDATE public.platform_posts SET status = 'success' WHERE id = row_curr;

  ASSERT (SELECT (metadata->'attempt_retained_platform_post_ids') = jsonb_build_array(row_s1::text) FROM public.posts WHERE id = p_t80),
    'T80 metadata persists exact row_s1 as retained platform post';

  res := public.finalize_threads_image_attempt(p_t80, attempt_at, fence_t80, ARRAY[acct_2]);
  ASSERT res ->> 'status' = 'completed' AND (res ->> 'notify')::boolean = true,
    format('T80 finalizer completes without being blocked by unlisted failed row (got %s)', res);
  ASSERT res -> 'authorized_platform_post_ids' = jsonb_build_array(row_s1::text, row_curr::text)
      OR res -> 'authorized_platform_post_ids' = jsonb_build_array(row_curr::text, row_s1::text),
    format('T80 authorized platform post IDs contains only row_s1 and row_curr, excluding unlisted row_f1 (got %s)', res -> 'authorized_platform_post_ids');

  -- Also verify claim_threads_image_notification returns authorized_platform_post_ids
  res := public.claim_threads_image_notification(p_t80, attempt_at, 'completed', fence_t80, interval '3 minutes');
  ASSERT (res ->> 'claimed')::boolean = true, 'T80 notification claimed';
  ASSERT res -> 'authorized_platform_post_ids' = jsonb_build_array(row_s1::text, row_curr::text)
      OR res -> 'authorized_platform_post_ids' = jsonb_build_array(row_curr::text, row_s1::text),
    format('T80 claim notification returns durable authorized_platform_post_ids (got %s)', res -> 'authorized_platform_post_ids');

  -- =========================================================================
  -- T81: Foreign post / foreign tenant / non-success row passed as retained
  -- is strictly refused.
  -- =========================================================================
  INSERT INTO public.posts (id, user_id, caption, platforms, status, processing_started_at, source, metadata)
  VALUES (p_t81, owner_id, 't81 post', ARRAY['threads'], 'processing', attempt_at, 'manual', '{}'::jsonb);

  fence_t81 := jsonb_build_object(
    'user_id', owner_id, 'caption', 't81 post', 'media_file_ids', NULL,
    'metadata', '{}'::jsonb,
    'platforms', ARRAY['threads'], 'scheduled_at', NULL, 'publish_requested_at', NULL, 'source', 'manual'
  );

  -- Row on other post (p_t80)
  INSERT INTO public.platform_posts (id, post_id, social_account_id, platform, status, created_at)
  VALUES (row_other_post, p_t80, acct_1, 'threads', 'success', attempt_at - interval '1 hour');

  payload := jsonb_build_object(
    'deferred', jsonb_build_object(
      'kind', 'threads', 'media_type', 'IMAGE', 'container_id', 'c-t81',
      'attempt_started_at', attempt_at, 'attempts', 0, 'first_deferred_at', attempt_at,
      'give_up_at', attempt_at + interval '30 minutes', 'next_check_at', attempt_at + interval '1 minute'
    ),
    'content_fence', fence_t81,
    'account_updated_at', (SELECT updated_at FROM public.social_accounts WHERE id = acct_1)
  );

  -- 1) Foreign post row rejected
  err_caught := false;
  BEGIN
    PERFORM public.record_threads_image_checkpoint(
      p_t81, acct_1, payload, attempt_at, fence_t81,
      ARRAY[acct_1], ARRAY[row_other_post]
    );
  EXCEPTION WHEN OTHERS THEN
    err_caught := true;
  END;
  ASSERT err_caught, 'T81 foreign post row rejected as retained platform post';

  -- 2) Failed row on same post rejected
  INSERT INTO public.platform_posts (id, post_id, social_account_id, platform, status, created_at)
  VALUES ('f0000000-0000-4000-8000-000000000086', p_t81, acct_2, 'threads', 'failed', attempt_at - interval '10 minutes');
  err_caught := false;
  BEGIN
    PERFORM public.record_threads_image_checkpoint(
      p_t81, acct_1, payload, attempt_at, fence_t81,
      ARRAY[acct_1], ARRAY['f0000000-0000-4000-8000-000000000086'::uuid]
    );
  EXCEPTION WHEN OTHERS THEN
    err_caught := true;
  END;
  ASSERT err_caught, 'T81 non-success row rejected as retained platform post';

  -- 3) Foreign tenant account row rejected
  INSERT INTO public.platform_posts (id, post_id, social_account_id, platform, status, created_at)
  VALUES (row_foreign, p_t81, acct_foreign, 'threads', 'success', attempt_at - interval '10 minutes');
  err_caught := false;
  BEGIN
    PERFORM public.record_threads_image_checkpoint(
      p_t81, acct_1, payload, attempt_at, fence_t81,
      ARRAY[acct_1], ARRAY[row_foreign]
    );
  EXCEPTION WHEN OTHERS THEN
    err_caught := true;
  END;
  ASSERT err_caught, 'T81 foreign tenant account row rejected as retained platform post';

  -- =========================================================================
  -- T82: Legacy 5-arg wrapper on a new attempt initializes clean scope
  -- without inheriting stale scope.
  -- =========================================================================
  INSERT INTO public.posts (id, user_id, caption, platforms, status, processing_started_at, source, metadata)
  VALUES (p_t82, owner_id, 't82 post', ARRAY['threads'], 'processing', attempt_at, 'manual',
    jsonb_build_object(
      'selected_account_ids', jsonb_build_array(acct_1),
      'attempt_started_at', attempt_at - interval '1 day',
      'attempt_target_account_ids', jsonb_build_array(acct_1, acct_2),
      'attempt_retained_platform_post_ids', jsonb_build_array(row_s1)
    ));

  fence_t82 := jsonb_build_object(
    'user_id', owner_id, 'caption', 't82 post', 'media_file_ids', NULL,
    'metadata', jsonb_build_object('selected_account_ids', jsonb_build_array(acct_1)),
    'platforms', ARRAY['threads'], 'scheduled_at', NULL, 'publish_requested_at', NULL, 'source', 'manual'
  );

  payload := jsonb_build_object(
    'deferred', jsonb_build_object(
      'kind', 'threads', 'media_type', 'IMAGE', 'container_id', 'c-t82',
      'attempt_started_at', attempt_at, 'attempts', 0, 'first_deferred_at', attempt_at,
      'give_up_at', attempt_at + interval '30 minutes', 'next_check_at', attempt_at + interval '1 minute'
    ),
    'content_fence', fence_t82,
    'account_updated_at', (SELECT updated_at FROM public.social_accounts WHERE id = acct_1)
  );

  -- Calling 5-arg wrapper with fresh attempt_at
  PERFORM public.record_threads_image_checkpoint(
    p_t82, acct_1, payload, attempt_at, fence_t82
  );

  ASSERT (SELECT (metadata->'attempt_target_account_ids') = jsonb_build_array(acct_1::text) FROM public.posts WHERE id = p_t82),
    'T82 5-arg wrapper sets single target account on fresh attempt';
  ASSERT (SELECT (metadata->'attempt_retained_platform_post_ids') = '[]'::jsonb FROM public.posts WHERE id = p_t82),
    'T82 5-arg wrapper clears retained platform post IDs on fresh attempt without stale inheritance';

  -- =========================================================================
  -- T83: A03.1 - All-failed notification intent staged and claimed cleanly
  -- =========================================================================
  DECLARE
    p_t83 uuid := '33000000-0000-4000-8000-000000000083';
    row_f uuid := '44000000-0000-4000-8000-000000000083';
    fence_t83 jsonb;
  BEGIN
    INSERT INTO public.posts (id, user_id, caption, platforms, status, processing_started_at, source, metadata)
    VALUES (p_t83, owner_id, 't83 all-failed', ARRAY['threads'], 'processing', attempt_at, 'manual',
      jsonb_build_object('selected_account_ids', jsonb_build_array(acct_1)));

    fence_t83 := jsonb_build_object(
      'user_id', owner_id, 'caption', 't83 all-failed', 'media_file_ids', NULL,
      'metadata', jsonb_build_object('selected_account_ids', jsonb_build_array(acct_1)),
      'platforms', ARRAY['threads'], 'scheduled_at', NULL, 'publish_requested_at', NULL, 'source', 'manual'
    );

    row_f := public.record_threads_image_checkpoint(p_t83, acct_1, jsonb_build_object(
      'content_fence', fence_t83,
      'account_updated_at', (SELECT updated_at FROM public.social_accounts WHERE id=acct_1),
      'deferred', jsonb_build_object('kind','threads','media_type','IMAGE','container_id','t83-container',
        'attempt_started_at',attempt_at,'first_deferred_at',attempt_at,'next_check_at',attempt_at,
        'give_up_at',attempt_at+interval '30 minutes','attempts',0)
    ), attempt_at, fence_t83, ARRAY[acct_1], ARRAY[]::uuid[]);
    res := public.claim_threads_image_inline_execution(row_f,p_t83,acct_1,'t83-container',attempt_at,fence_t83,'t83-execution');
    ASSERT res IS NOT NULL, 'T83 actual inline execution is claimed';
    res := public.partner_settle_platform_post(row_f,p_t83,acct_1,'threads','failed',NULL,NULL,
      'Synthetic definitive provider refusal',(SELECT response_data FROM public.platform_posts WHERE id=row_f));
    ASSERT res->>'settled'='true' AND res->>'post_status'='processing', 'T83 actual failed settlement preserves managed parent';

    res := public.finalize_threads_image_attempt(p_t83, attempt_at, fence_t83, ARRAY[acct_1]);
    ASSERT res ->> 'status' = 'failed' AND (res ->> 'notify')::boolean = true,
      format('T83 finalizer marks post failed with notify=true (got %s)', res);

    ASSERT (SELECT (metadata #>> '{final_notification_intent,status}') = 'failed'
              FROM public.posts WHERE id = p_t83),
      'T83 final_notification_intent is preserved on failed post (not deleted by status trigger)';
    ASSERT (SELECT (metadata #>> '{final_notification_intent,notified}') = 'false'
              FROM public.posts WHERE id = p_t83),
      'T83 final_notification_intent has notified = false';

    res := public.claim_threads_image_notification(p_t83, attempt_at, 'failed', fence_t83, interval '3 minutes');
    ASSERT (res ->> 'claimed')::boolean = true AND (res ->> 'claim_id') IS NOT NULL,
      format('T83 failed notification intent claimed successfully (got %s)', res);
  END;

  -- =========================================================================
  -- T84: A03.2 - Stale terminal rows from prior attempt do not starve cron
  -- =========================================================================
  DECLARE
    p_t84 uuid := '33000000-0000-4000-8000-000000000084';
    p_due uuid := '33000000-0000-4000-8000-000000000085';
    row_due uuid := '44000000-0000-4000-8000-000000000099';
    attempt_cur timestamptz := now();
    attempt_old timestamptz := now() - interval '2 hours';
    v_claimed uuid[];
    i integer;
  BEGIN
    INSERT INTO public.posts (id, user_id, caption, platforms, status, processing_started_at, source)
    VALUES (p_t84, owner_id, 't84 post', ARRAY['threads'], 'processing', attempt_cur, 'manual');

    FOR i IN 1..5 LOOP
      INSERT INTO public.platform_posts (id, post_id, social_account_id, platform, status, created_at, response_data)
      VALUES (
        gen_random_uuid(), p_t84, acct_1, 'threads', 'failed', attempt_old,
        jsonb_build_object('deferred', jsonb_build_object(
          'kind', 'threads', 'media_type', 'IMAGE',
          'attempt_started_at', attempt_old,
          'claimed_until', NULL
        ))
      );
    END LOOP;

    INSERT INTO public.posts (id, user_id, caption, platforms, status, processing_started_at, source)
    VALUES (p_due, owner_id, 'p_due', ARRAY['threads'], 'processing', attempt_cur, 'manual');

    INSERT INTO public.platform_posts (id, post_id, social_account_id, platform, status, created_at, response_data)
    VALUES (row_due, p_due, acct_1, 'threads', 'pending', attempt_cur,
      jsonb_build_object('deferred', jsonb_build_object(
        'kind', 'threads', 'media_type', 'IMAGE',
        'attempt_started_at', attempt_cur,
        'next_check_at', now() - interval '1 minute',
        'claimed_until', NULL
      )));

    SELECT array_agg(platform_post_id) INTO v_claimed FROM public.claim_deferred_publishes(10);
    ASSERT row_due = ANY(v_claimed), 'T84 row_due was claimed';
    ASSERT NOT EXISTS (
      SELECT 1 FROM unnest(v_claimed) c
      JOIN public.platform_posts p ON p.id = c
      WHERE p.post_id = p_t84
    ), format('T84 none of the stale terminal rows for p_t84 were claimed (got %s)', v_claimed);
  END;

  -- =========================================================================
  -- T85: A04.1 - Account UUID in retained platform post IDs is rejected
  -- =========================================================================
  DECLARE
    p_t85 uuid := '33000000-0000-4000-8000-000000000086';
    fence_t85 jsonb;
    payload_t85 jsonb;
  BEGIN
    INSERT INTO public.posts (id, user_id, caption, platforms, status, processing_started_at, source, metadata)
    VALUES (p_t85, owner_id, 't85 post', ARRAY['threads'], 'processing', attempt_at, 'manual',
      jsonb_build_object('selected_account_ids', jsonb_build_array(acct_1)));

    fence_t85 := jsonb_build_object(
      'user_id', owner_id, 'caption', 't85 post', 'media_file_ids', NULL,
      'metadata', jsonb_build_object('selected_account_ids', jsonb_build_array(acct_1)),
      'platforms', ARRAY['threads'], 'scheduled_at', NULL, 'publish_requested_at', NULL, 'source', 'manual'
    );

    payload_t85 := jsonb_build_object(
      'deferred', jsonb_build_object(
        'kind', 'threads', 'media_type', 'IMAGE', 'container_id', 'c-t85',
        'attempt_started_at', attempt_at, 'attempts', 0, 'first_deferred_at', attempt_at,
        'give_up_at', attempt_at + interval '30 minutes', 'next_check_at', attempt_at + interval '1 minute'
      ),
      'content_fence', fence_t85,
      'account_updated_at', (SELECT updated_at FROM public.social_accounts WHERE id = acct_1)
    );

    INSERT INTO public.platform_posts(id,post_id,social_account_id,platform,status,created_at)
    VALUES(gen_random_uuid(),p_t85,acct_1,'threads','success',attempt_at-interval '2 hours'),
      (gen_random_uuid(),p_t85,acct_1,'threads','success',attempt_at-interval '1 hour');

    err_caught := false;
    BEGIN
      PERFORM public.record_threads_image_checkpoint(
        p_t85, acct_1, payload_t85, attempt_at, fence_t85,
        ARRAY[acct_1], ARRAY[acct_1]
      );
    EXCEPTION WHEN foreign_key_violation THEN
      err_caught := true;
    END;

    ASSERT err_caught, 'T85 social_accounts.id passed in p_retained_platform_post_ids is rejected';
  END;

  -- =========================================================================
  -- T86: A06 - Atomic restore_legacy_pending_post under row lock
  -- =========================================================================
  DECLARE
    p_t86 uuid := '33000000-0000-4000-8000-000000000087';
    fence_t86 jsonb;
  BEGIN
    INSERT INTO public.posts (id, user_id, caption, platforms, status, processing_started_at, source, metadata)
    VALUES (p_t86, owner_id, 't86 post', ARRAY['threads', 'instagram'], 'completed', attempt_at, 'manual',
      jsonb_build_object(
        'selected_account_ids', jsonb_build_array(acct_1),
        'settlement_rollup_at', attempt_at,
        'settlement_rollup_processing_started_at', attempt_at,
        'settlement_rollup_status', 'completed'
      ));

    fence_t86 := jsonb_build_object(
      'user_id', owner_id,
      'metadata', jsonb_build_object('selected_account_ids', jsonb_build_array(acct_1)),
      'caption', 't86 post',
      'media_file_ids', NULL,
      'platforms', ARRAY['threads', 'instagram'],
      'scheduled_at', NULL,
      'publish_requested_at', NULL,
      'source', 'manual'
    );

    res := public.restore_legacy_pending_post(p_t86, attempt_at, fence_t86, true);
    ASSERT (res ->> 'restored')::boolean = true AND res ->> 'status' = 'processing',
      format('T86 restore_legacy_pending_post succeeds (got %s)', res);
    ASSERT (SELECT status FROM public.posts WHERE id = p_t86) = 'processing',
      'T86 post status restored to processing';

    UPDATE public.posts SET status = 'completed' WHERE id = p_t86;
    res := public.restore_legacy_pending_post(p_t86, attempt_at - interval '1 hour', fence_t86, true);
    ASSERT (res ->> 'restored')::boolean = false AND res ->> 'reason' = 'attempt_mismatch',
      format('T86 restore refused on attempt mismatch (got %s)', res);

    res := public.restore_legacy_pending_post(p_t86, attempt_at, jsonb_build_object('caption', 'tampered'), true);
    ASSERT (res ->> 'restored')::boolean = false AND res ->> 'reason' = 'content_mismatch',
      format('T86 restore refused on content mismatch (got %s)', res);
  END;

  -- T87: A leased notice cannot authorize deleted, changed or incomplete retained results.
  DECLARE
    original_intent jsonb;
    retained_row public.platform_posts%ROWTYPE;
  BEGIN
    SELECT metadata->'final_notification_intent' INTO original_intent FROM public.posts WHERE id=p_t80;
    original_intent := original_intent - 'claimed_until' - 'claim_id';
    UPDATE public.posts SET metadata=jsonb_set(metadata,'{final_notification_intent}',original_intent) WHERE id=p_t80;
    SELECT * INTO retained_row FROM public.platform_posts WHERE id=row_s1;
    DELETE FROM public.platform_posts WHERE id=row_s1;
    res := public.claim_threads_image_notification(p_t80,attempt_at,'completed',fence_t80);
    ASSERT res->>'claimed'='false' AND res->>'error'='invalid_result_scope', 'T87 deleted retained row refuses notification';
    INSERT INTO public.platform_posts SELECT (retained_row).*;
    UPDATE public.platform_posts SET status='failed' WHERE id=row_s1;
    res := public.claim_threads_image_notification(p_t80,attempt_at,'completed',fence_t80);
    ASSERT res->>'claimed'='false', 'T87 retained row changed to failed refuses notification';
    UPDATE public.platform_posts SET status='success' WHERE id=row_s1;
    UPDATE public.posts SET metadata=jsonb_set(metadata,'{final_notification_intent,authorized_platform_post_ids}','[]'::jsonb) WHERE id=p_t80;
    res := public.claim_threads_image_notification(p_t80,attempt_at,'completed',fence_t80);
    ASSERT res->>'claimed'='false', 'T87 empty authorized scope refuses notification';
    UPDATE public.posts SET metadata=jsonb_set(metadata,'{final_notification_intent}',original_intent) WHERE id=p_t80;
    res := public.claim_threads_image_notification(p_t80,attempt_at,'completed',fence_t80);
    ASSERT res->>'claimed'='true' AND res #>> ARRAY['authorized_platform_post_statuses',row_s1::text]='success',
      'T87 valid scope returns authoritative current result statuses';
  END;

  -- T88: A pre-M2 image checkpoint has no parent scope metadata. Finalization
  -- freezes the resolved scope so notification claiming remains compatible.
  DECLARE
    legacy_post uuid := gen_random_uuid();
    legacy_row uuid := gen_random_uuid();
    legacy_fence jsonb;
    lease_owner uuid;
    replacement_owner uuid;
  BEGIN
    INSERT INTO public.posts(id,user_id,caption,platforms,status,processing_started_at,source,metadata)
    VALUES(legacy_post,owner_id,'M1 rolling checkpoint',ARRAY['threads'],'processing',attempt_at,'manual',
      jsonb_build_object('selected_account_ids',jsonb_build_array(acct_1)));
    SELECT jsonb_build_object('user_id',user_id,'caption',caption,'media_file_ids',media_file_ids,
      'metadata',public.normalize_threads_internal_metadata(metadata),'platforms',platforms,'scheduled_at',scheduled_at,
      'publish_requested_at',publish_requested_at,'source',source) INTO legacy_fence FROM public.posts WHERE id=legacy_post;
    INSERT INTO public.platform_posts(id,post_id,social_account_id,platform,status,created_at,response_data)
    VALUES(legacy_row,legacy_post,acct_1,'threads','success',attempt_at,jsonb_build_object('deferred',
      jsonb_build_object('kind','threads','media_type','IMAGE','attempt_started_at',attempt_at)));
    res:=public.finalize_threads_image_attempt(legacy_post,attempt_at,legacy_fence);
    ASSERT res->>'status'='completed', 'T88 legacy fallback finalizes';
    res:=public.claim_threads_image_notification(legacy_post,attempt_at,'completed',legacy_fence);
    ASSERT res->>'claimed'='true', 'T88 legacy fallback persists its scope and can claim notice';
    lease_owner:=(res->>'claim_id')::uuid;
    ASSERT public.ack_threads_image_notification_delivery(legacy_post,attempt_at,lease_owner,repeat('a',64)),
      'T89 destination acknowledgement is accepted under the active lease';
    UPDATE public.posts SET metadata=jsonb_set(metadata,'{final_notification_intent,claimed_until}',to_jsonb(now()-interval '1 second')) WHERE id=legacy_post;
    res:=public.claim_threads_image_notification(legacy_post,attempt_at,'completed',legacy_fence);
    replacement_owner:=(res->>'claim_id')::uuid;
    ASSERT res #>> ARRAY['delivery_acks',repeat('a',64)]='true', 'T89 acknowledged destination survives lease rollover';
    ASSERT NOT public.ack_threads_image_notification_delivery(legacy_post,attempt_at,lease_owner,repeat('b',64)),
      'T89 old owner cannot acknowledge replacement deliveries';
    ASSERT public.ack_threads_image_notification_delivery(legacy_post,attempt_at,replacement_owner,repeat('b',64)),
      'T89 replacement owner adds its destination acknowledgement';
    UPDATE public.posts SET caption='Owner changed content' WHERE id=legacy_post;
    ASSERT NOT public.ack_threads_image_notification_delivery(legacy_post,attempt_at,replacement_owner,repeat('c',64)),
      'T89 changed content cannot receive a stale destination acknowledgement';
  END;

  -- T90: Old terminal repairs cannot consume the slot of a due publication.
  DECLARE
    due_post uuid:=gen_random_uuid();
    due_row uuid;
    claimed_row uuid;
  BEGIN
    UPDATE public.platform_posts SET response_data=jsonb_set(response_data,'{deferred,claimed_until}',to_jsonb(now()+interval '1 day'))
      WHERE response_data ? 'deferred';
    INSERT INTO public.posts(id,user_id,caption,platforms,status,processing_started_at,source,metadata)
    VALUES(due_post,owner_id,'Due pending priority',ARRAY['threads'],'processing',attempt_at,'manual','{}');
    due_row:=public.record_deferred_platform_post(due_post,acct_1,jsonb_build_object('deferred',
      jsonb_build_object('kind','threads','media_type','VIDEO','next_check_at',now()-interval '1 minute')));
    UPDATE public.platform_posts SET response_data=jsonb_set(response_data,'{deferred,claimed_until}',to_jsonb(now()-interval '1 second')),
      created_at=now()-interval '1 day' WHERE id=row_curr;
    UPDATE public.posts SET metadata=jsonb_set(metadata,'{final_notification_intent,claimed_until}',to_jsonb(now()-interval '1 second')) WHERE id=p_t80;
    SELECT platform_post_id INTO claimed_row FROM public.claim_deferred_publishes(1);
    ASSERT claimed_row=due_row, 'T90 due pending publication takes priority over older terminal repair';
  END;

  -- T91: Terminal repairs rotate by their last lease, not original creation time.
  DECLARE
    old_post uuid:=gen_random_uuid();
    new_post uuid:=gen_random_uuid();
    old_row uuid:=gen_random_uuid();
    new_row uuid:=gen_random_uuid();
    selected_row uuid;
  BEGIN
    UPDATE public.platform_posts SET response_data=jsonb_set(response_data,'{deferred,claimed_until}',to_jsonb(now()+interval '1 day')) WHERE response_data ? 'deferred';
    INSERT INTO public.posts(id,user_id,platforms,status,processing_started_at,metadata)
    SELECT id,owner_id,ARRAY['threads'],'completed',attempt_at,jsonb_build_object('final_notification_intent',
      jsonb_build_object('status','completed','attempt_started_at',attempt_at,'notified',false)) FROM unnest(ARRAY[old_post,new_post]) id;
    UPDATE public.posts p SET metadata=jsonb_set(metadata,'{final_notification_intent,content_hash}',to_jsonb(md5(jsonb_build_object(
      'user_id',p.user_id,'caption',p.caption,'media_file_ids',p.media_file_ids,
      'metadata',public.normalize_threads_internal_metadata(p.metadata),'platforms',p.platforms,
      'scheduled_at',p.scheduled_at,'publish_requested_at',p.publish_requested_at,'source',p.source)::text)))
      WHERE id=ANY(ARRAY[old_post,new_post]);
    INSERT INTO public.platform_posts(id,post_id,social_account_id,platform,status,created_at,response_data)
    VALUES(old_row,old_post,acct_1,'threads','success',now()-interval '1 day',jsonb_build_object('deferred',jsonb_build_object('kind','threads','media_type','IMAGE','attempt_started_at',attempt_at,'claimed_until',now()-interval '1 second'))),
      (new_row,new_post,acct_1,'threads','success',now(),jsonb_build_object('deferred',jsonb_build_object('kind','threads','media_type','IMAGE','attempt_started_at',attempt_at,'claimed_until',now()-interval '2 seconds')));
    SELECT platform_post_id INTO selected_row FROM public.claim_deferred_publishes(1);
    ASSERT selected_row=new_row, 'T91 recently retried old notification cannot monopolize terminal repairs by original creation order';
    UPDATE public.platform_posts SET response_data=jsonb_set(response_data,'{deferred,claimed_until}',to_jsonb(now()-interval '1 second')) WHERE id=ANY(ARRAY[old_row,new_row]);
    UPDATE public.posts SET caption='Edited after finalization' WHERE id=old_post;
    ASSERT NOT EXISTS (SELECT 1 FROM public.claim_deferred_publishes(100) WHERE platform_post_id=old_row),
      'T92 edited terminal content is excluded from obsolete notice recovery';
    ASSERT (SELECT status='success' FROM public.platform_posts WHERE id=old_row),
      'T92 obsolete intent exclusion preserves publication evidence';
  END;

  -- T93: Only pending rows in the finalizer's current target attempt delay repair.
  DECLARE
    repair_post uuid:=gen_random_uuid();
    image_row uuid:=gen_random_uuid();
    current_pending uuid:=gen_random_uuid();
    repair_fence jsonb;
  BEGIN
    UPDATE public.platform_posts SET response_data=jsonb_set(response_data,'{deferred,claimed_until}',to_jsonb(now()+interval '1 day')) WHERE response_data ? 'deferred';
    INSERT INTO public.posts(id,user_id,caption,platforms,status,processing_started_at,metadata)
    VALUES(repair_post,owner_id,'Scoped terminal repair',ARRAY['threads'],'processing',attempt_at,
      jsonb_build_object('attempt_started_at',attempt_at,'attempt_target_account_ids',jsonb_build_array(acct_1)));
    SELECT jsonb_build_object('user_id',user_id,'caption',caption,'media_file_ids',media_file_ids,
      'metadata',public.normalize_threads_internal_metadata(metadata),'platforms',platforms,'scheduled_at',scheduled_at,
      'publish_requested_at',publish_requested_at,'source',source) INTO repair_fence FROM public.posts WHERE id=repair_post;
    INSERT INTO public.platform_posts(id,post_id,social_account_id,platform,status,created_at,response_data)
    VALUES(image_row,repair_post,acct_1,'threads','success',attempt_at,jsonb_build_object('deferred',jsonb_build_object('kind','threads','media_type','IMAGE','attempt_started_at',attempt_at))),
      (gen_random_uuid(),repair_post,acct_1,'threads','pending',attempt_at-interval '1 hour','{}'),
      (gen_random_uuid(),repair_post,acct_2,'threads','pending',attempt_at,'{}');
    ASSERT EXISTS (SELECT 1 FROM public.claim_deferred_publishes(100) WHERE platform_post_id=image_row),
      'T93 historical and non-target pending rows do not strand current attempt repair';
    UPDATE public.platform_posts SET response_data=jsonb_set(response_data,'{deferred,claimed_until}',to_jsonb(now()-interval '1 second')) WHERE id=image_row;
    INSERT INTO public.platform_posts(id,post_id,social_account_id,platform,status,created_at,response_data)
    VALUES(current_pending,repair_post,acct_1,'threads','pending',attempt_at,'{}');
    ASSERT NOT EXISTS (SELECT 1 FROM public.claim_deferred_publishes(100) WHERE platform_post_id=image_row),
      'T93 current target pending result still blocks premature repair';
    UPDATE public.platform_posts SET created_at=attempt_at-interval '1 hour' WHERE id=current_pending;
    res:=public.finalize_threads_image_attempt(repair_post,attempt_at,repair_fence);
    ASSERT res->>'status'='completed', 'T93 finalizer agrees with scoped repair eligibility';
  END;

  -- T94: Retrying only Instagram must retain an older Threads success without
  -- requiring a new Threads publication in the replacement processing attempt.
  DECLARE
    retry_post uuid:=gen_random_uuid();
    control_post uuid:=gen_random_uuid();
    ig_account uuid:=gen_random_uuid();
    retained_row uuid:=gen_random_uuid();
    video_row uuid;
    requested_at timestamptz;
  BEGIN
    INSERT INTO public.social_accounts(id,user_id,platform,platform_user_id,access_token,is_active)
    VALUES(ig_account,owner_id,'instagram','retained-retry-ig','synthetic-fixture',true);
    INSERT INTO public.posts(id,user_id,platforms,status,processing_started_at,metadata)
    VALUES(retry_post,owner_id,ARRAY['threads','instagram'],'completed',attempt_at-interval '1 hour','{}'),
      (control_post,owner_id,ARRAY['threads','instagram'],'failed',attempt_at-interval '1 hour','{}');
    INSERT INTO public.platform_posts(id,post_id,social_account_id,platform,status,created_at,platform_post_id)
    VALUES(retained_row,retry_post,acct_1,'threads','success',attempt_at-interval '1 hour','retained-thread'),
      (gen_random_uuid(),retry_post,ig_account,'instagram','failed',attempt_at-interval '1 hour',NULL),
      (gen_random_uuid(),control_post,acct_1,'threads','failed',attempt_at-interval '1 hour',NULL),
      (gen_random_uuid(),control_post,ig_account,'instagram','failed',attempt_at-interval '1 hour',NULL);
    res:=public.request_post_retry(retry_post,owner_id,ARRAY[ig_account]);
    ASSERT res->>'status'='accepted', 'T94 actual targeted retry request is accepted';
    requested_at:=(res->>'requested_at')::timestamptz;
    UPDATE public.posts SET status='processing',processing_started_at=requested_at+interval '1 second' WHERE id=retry_post;
    video_row:=public.record_deferred_platform_post(retry_post,ig_account,jsonb_build_object('deferred',jsonb_build_object('kind','instagram','container_id','retained-retry-video')));
    PERFORM public.partner_settle_platform_post(video_row,retry_post,ig_account,'instagram','success','retried-ig-video');
    ASSERT (SELECT status='completed' FROM public.posts WHERE id=retry_post),
      'T94 retained Threads success permits the retried Instagram video to finalize';
    ASSERT (SELECT count(*)=2 FROM public.platform_posts WHERE post_id=retry_post)
      AND (SELECT platform_post_id='retained-thread' AND status='success' FROM public.platform_posts WHERE id=retained_row),
      'T94 targeted retry preserves the exact prior Threads result without another Threads row';

    res:=public.request_post_retry(control_post,owner_id,ARRAY[acct_1,ig_account]);
    requested_at:=(res->>'requested_at')::timestamptz;
    UPDATE public.posts SET status='processing',processing_started_at=requested_at+interval '1 second' WHERE id=control_post;
    video_row:=public.record_deferred_platform_post(control_post,ig_account,jsonb_build_object('deferred',jsonb_build_object('kind','instagram','container_id','retry-both-video')));
    PERFORM public.partner_settle_platform_post(video_row,control_post,ig_account,'instagram','success','retry-both-ig-video');
    ASSERT (SELECT status='processing' FROM public.posts WHERE id=control_post),
      'T94 explicitly retried Threads target still blocks rollup until its current result exists';
  END;

END $$;

-- =========================================================================
-- T95: Track A - Narrow fixed-field atomic RPC stamp_pinterest_post_type
-- =========================================================================
DO $$
DECLARE
  u_pin uuid := gen_random_uuid();
  acct_pin uuid := gen_random_uuid();
  post_pin uuid := gen_random_uuid();
  claim_at timestamptz := now();
  pin_fence jsonb;
  stamped boolean;
BEGIN
  INSERT INTO auth.users (id, email) VALUES (u_pin, 'pin-test@example.invalid');
  INSERT INTO public.social_accounts (id, user_id, platform, platform_user_id, platform_username, access_token, is_active)
  VALUES (acct_pin, u_pin, 'pinterest', 'dp-pin', 'dp_pin', 'tok-pin', true);
  INSERT INTO public.posts (id, user_id, caption, platforms, status, processing_started_at, source, metadata)
  VALUES (post_pin, u_pin, 'pinterest caption', ARRAY['pinterest'], 'processing', claim_at, 'manual',
    jsonb_build_object('extra_key', 'keep_me'));

  pin_fence := jsonb_build_object(
    'user_id', u_pin,
    'caption', 'pinterest caption',
    'media_file_ids', NULL,
    'metadata', jsonb_build_object('extra_key', 'keep_me'),
    'platforms', ARRAY['pinterest'],
    'scheduled_at', NULL,
    'publish_requested_at', NULL,
    'source', 'manual'
  );

  -- Valid stamp
  stamped := public.stamp_pinterest_post_type(post_pin, acct_pin, claim_at, pin_fence, 'image');
  ASSERT stamped = true, 'T95 valid stamp_pinterest_post_type returns true';
  ASSERT (SELECT metadata ->> 'pinterest_post_type' FROM public.posts WHERE id = post_pin) = 'image',
    'T95 metadata has pinterest_post_type = image';
  ASSERT (SELECT metadata ->> 'extra_key' FROM public.posts WHERE id = post_pin) = 'keep_me',
    'T95 original metadata preserved';

  -- Fails closed on stale attempt
  stamped := public.stamp_pinterest_post_type(post_pin, acct_pin, claim_at - interval '1 hour', pin_fence, 'image');
  ASSERT stamped = false, 'T95 stale attempt refused';

  -- Fails closed on content mismatch
  stamped := public.stamp_pinterest_post_type(post_pin, acct_pin, claim_at, jsonb_build_object('caption', 'tampered'), 'image');
  ASSERT stamped = false, 'T95 content mismatch refused';

  -- Fails on invalid post_type
  stamped := public.stamp_pinterest_post_type(post_pin, acct_pin, claim_at, pin_fence, 'invalid_type');
  ASSERT stamped = false, 'T95 invalid post_type refused';

  -- Same-attempt rollup preserves ability to stamp
  UPDATE public.posts SET status = 'completed',
    metadata = metadata || jsonb_build_object('settlement_rollup_at', claim_at, 'settlement_rollup_status', 'completed', 'settlement_rollup_processing_started_at', claim_at)
  WHERE id = post_pin;
  stamped := public.stamp_pinterest_post_type(post_pin, acct_pin, claim_at, pin_fence, 'video');
  ASSERT stamped = true, 'T95 same-attempt rollup allows updating badge';
  ASSERT (SELECT metadata ->> 'pinterest_post_type' FROM public.posts WHERE id = post_pin) = 'video',
    'T95 updated badge to video';
END $$;

-- =========================================================================
-- T96: Track B0 - Pre-claim-only legacy notification recovery
-- =========================================================================
DO $$
DECLARE
  u_b0 uuid := gen_random_uuid();
  acct_ig uuid := gen_random_uuid();
  acct_fb uuid := gen_random_uuid();
  post_b0 uuid := gen_random_uuid();
  row_ig uuid := gen_random_uuid();
  row_fb uuid := gen_random_uuid();
  claim_at timestamptz := now();
  b0_fence jsonb;
  res jsonb;
  work_rows record;
  claimed_candidate jsonb;
BEGIN
  INSERT INTO auth.users (id, email) VALUES (u_b0, 'b0-test@example.invalid');
  INSERT INTO public.social_accounts (id, user_id, platform, platform_user_id, platform_username, access_token, is_active)
  VALUES
    (acct_ig, u_b0, 'instagram', 'dp-b0-ig', 'dp_b0_ig', 'tok-ig', true),
    (acct_fb, u_b0, 'facebook', 'dp-b0-fb', 'dp_b0_fb', 'tok-fb', true);
  INSERT INTO public.posts (id, user_id, caption, platforms, status, processing_started_at, source, metadata)
  VALUES (post_b0, u_b0, 'b0 test post', ARRAY['instagram', 'facebook'], 'processing', claim_at, 'manual', '{}'::jsonb);

  b0_fence := jsonb_build_object(
    'user_id', u_b0,
    'caption', 'b0 test post',
    'media_file_ids', NULL,
    'metadata', '{}'::jsonb,
    'platforms', ARRAY['instagram', 'facebook'],
    'scheduled_at', NULL,
    'publish_requested_at', NULL,
    'source', 'manual'
  );

  -- 1. enroll_post_notification_recovery
  res := public.enroll_post_notification_recovery(
    post_b0, claim_at, b0_fence, ARRAY[acct_ig, acct_fb], ARRAY[]::uuid[]
  );
  ASSERT (res ->> 'enrolled')::boolean = true, format('T96 enroll succeeds (got %s)', res);
  ASSERT (SELECT metadata ? 'legacy_notification_candidate' FROM public.posts WHERE id = post_b0),
    'T96 legacy_notification_candidate stamped on post';

  -- Refuse enroll on content mismatch
  res := public.enroll_post_notification_recovery(
    post_b0, claim_at, jsonb_build_object('caption', 'tampered'), ARRAY[acct_ig, acct_fb], ARRAY[]::uuid[]
  );
  ASSERT (res ->> 'enrolled')::boolean = false, 'T96 enroll refused on content mismatch';

  -- 2. Worker publishes platform posts
  INSERT INTO public.platform_posts (id, post_id, social_account_id, platform, status, created_at, platform_post_id)
  VALUES
    (row_ig, post_b0, acct_ig, 'instagram', 'success', claim_at, 'ig-b0-success'),
    (row_fb, post_b0, acct_fb, 'facebook', 'failed', claim_at, NULL);

  -- 3. close_post_fanout
  res := public.close_post_fanout(
    post_b0, claim_at, b0_fence, ARRAY[row_ig, row_fb], ARRAY[]::uuid[]
  );
  ASSERT (res ->> 'closed')::boolean = true, format('T96 close_post_fanout succeeds (got %s)', res);
  ASSERT res ->> 'status' = 'completed', format('T96 status is completed since 1 succeeded (got %s)', res);

  -- 4. claim_post_completion_work returns notification-only work item
  UPDATE public.posts SET metadata = jsonb_set(
    metadata,
    '{legacy_notification_candidate,claimed_until}',
    to_jsonb(now() - interval '1 second')
  ) WHERE id = post_b0;

  UPDATE public.platform_posts SET response_data = jsonb_set(response_data, '{deferred,claimed_until}', to_jsonb(now() + interval '1 day'))
  WHERE response_data ? 'deferred';

  SELECT * INTO work_rows FROM public.claim_post_completion_work(5) WHERE post_id = post_b0;
  ASSERT work_rows.kind = 'notification_only', format('T96 claim_post_completion_work returns notification_only (got %s)', work_rows.kind);
  ASSERT work_rows.candidate_id IS NOT NULL, 'T96 candidate_id is present';

  -- 5. claim_legacy_notification_candidate
  claimed_candidate := public.claim_legacy_notification_candidate(
    post_b0, claim_at, b0_fence, work_rows.candidate_id
  );
  ASSERT (claimed_candidate ->> 'claimed')::boolean = true, format('T96 candidate claimed (got %s)', claimed_candidate);
  ASSERT (SELECT metadata ->> 'final_notified_at' IS NOT NULL FROM public.posts WHERE id = post_b0),
    'T96 final_notified_at stamped after claim';

  -- Double claim rejected
  claimed_candidate := public.claim_legacy_notification_candidate(
    post_b0, claim_at, b0_fence, work_rows.candidate_id
  );
  ASSERT (claimed_candidate ->> 'claimed')::boolean = false, 'T96 duplicate candidate claim rejected';
END $$;

ROLLBACK;

\echo '=== deferred_publishes: ALL CHECKS PASSED ==='

