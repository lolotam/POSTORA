-- Durable "Publish now" and "Retry" requests (migration 20261106120000).
-- One transaction, synthetic fixtures, labelled ASSERTs, ROLLBACK, sentinel
-- last. Assumes the migration is applied. No secrets and no real accounts.
BEGIN;

DO $$
DECLARE
  u_a uuid := 'a1a1a1a1-1111-4111-8111-a1a1a1a1a1a1';
  u_b uuid := 'b1b1b1b1-1111-4111-8111-b1b1b1b1b1b1';
  acct_fb uuid := 'a2a2a2a2-2222-4222-8222-a2a2a2a2a2a2';
  acct_ig uuid := 'a3a3a3a3-3333-4333-8333-a3a3a3a3a3a3';
  acct_th uuid := 'a4a4a4a4-4444-4444-8444-a4a4a4a4a4a4';
  acct_b  uuid := 'b2b2b2b2-2222-4222-8222-b2b2b2b2b2b2';
  p_new       uuid := 'c0000000-0000-4000-8000-000000000001';
  p_scheduled uuid := 'c0000000-0000-4000-8000-000000000002';
  p_failed    uuid := 'c0000000-0000-4000-8000-000000000003';
  p_partial   uuid := 'c0000000-0000-4000-8000-000000000004';
  p_running   uuid := 'c0000000-0000-4000-8000-000000000005';
  p_tiktok    uuid := 'c0000000-0000-4000-8000-000000000006';
  p_insert    uuid := 'c0000000-0000-4000-8000-000000000007';
  v_stamp timestamptz;
  v_result jsonb;
  v_rows int;
BEGIN
  INSERT INTO auth.users (id, email) VALUES
    (u_a, 'publish-requests-a@example.invalid'),
    (u_b, 'publish-requests-b@example.invalid');
  INSERT INTO public.user_quotas (user_id, max_posts_per_day, max_posts_per_month, max_media_uploads_per_day)
  VALUES (u_a, -1, -1, -1), (u_b, -1, -1, -1)
  ON CONFLICT (user_id) DO UPDATE SET
    max_posts_per_day = EXCLUDED.max_posts_per_day,
    max_posts_per_month = EXCLUDED.max_posts_per_month,
    max_media_uploads_per_day = EXCLUDED.max_media_uploads_per_day;
  INSERT INTO public.social_accounts (id, user_id, platform, platform_user_id, platform_username, access_token, is_active) VALUES
    (acct_fb, u_a, 'facebook',  'pr-fb', 'pr_fb', 'tok-fb', true),
    (acct_ig, u_a, 'instagram', 'pr-ig', 'pr_ig', 'tok-ig', true),
    (acct_th, u_a, 'threads',   'pr-th', 'pr_th', 'tok-th', true),
    (acct_b,  u_b, 'facebook',  'pr-b',  'pr_b',  'tok-b',  true);

  INSERT INTO public.posts (id, user_id, platforms, status, scheduled_at, source) VALUES
    (p_new,       u_a, ARRAY['facebook'], 'pending',    NULL, 'manual'),
    (p_scheduled, u_a, ARRAY['facebook'], 'scheduled',  now() + interval '1 day', 'manual'),
    (p_failed,    u_a, ARRAY['facebook','instagram'], 'failed', NULL, 'manual'),
    (p_partial,   u_a, ARRAY['facebook','instagram'], 'completed', NULL, 'manual'),
    (p_running,   u_a, ARRAY['facebook'], 'processing', NULL, 'manual'),
    (p_tiktok,    u_a, ARRAY['tiktok'],   'pending',    NULL, 'tiktok_review');
  INSERT INTO public.platform_posts (post_id, social_account_id, platform, status) VALUES
    (p_failed,  acct_fb, 'facebook',  'failed'),
    (p_failed,  acct_ig, 'instagram', 'failed'),
    (p_failed,  NULL,    'facebook',  'failed'),
    (p_partial, acct_fb, 'facebook',  'success'),
    (p_partial, acct_ig, 'instagram', 'failed');

  -- T1: the insert trigger pins a browser-supplied request time to the database clock.
  INSERT INTO public.posts (id, user_id, platforms, status, publish_requested_at, source)
  VALUES (p_insert, u_a, ARRAY['facebook'], 'pending', now() + interval '3 hours', 'manual');
  ASSERT (SELECT publish_requested_at FROM public.posts WHERE id = p_insert) = now(),
    'T1 an inserted request time is pinned to now()';
  ASSERT (SELECT publish_requested_at FROM public.posts WHERE id = p_new) IS NULL,
    'T2 a post inserted without a request keeps it NULL';

  -- I1-I4: "Publish now" on an unscheduled pending post.
  v_stamp := public.request_immediate_publish(p_new, u_a);
  ASSERT v_stamp = now(), 'I1 the owner''s pending post is stamped with now()';
  ASSERT (SELECT scheduled_at FROM public.posts WHERE id = p_new) IS NULL,
    'I2 an unscheduled post stays unscheduled (Calendar and Analytics do not see a schedule)';
  ASSERT (SELECT status FROM public.posts WHERE id = p_new) = 'pending',
    'I3 the stamp leaves the post pending for the claim';
  ASSERT EXISTS (
    SELECT 1 FROM public.posts
     WHERE id = p_new AND status IN ('pending', 'scheduled')
       AND publish_requested_at IS NOT NULL AND publish_requested_at <= now()
  ), 'I4 the scheduler''s request predicate selects the stamped post';

  -- I5/I6: the kick and the scheduler share one compare-and-set; one wins.
  UPDATE public.posts SET status = 'processing', processing_started_at = now()
   WHERE id = p_new AND publish_requested_at = v_stamp AND status IN ('pending', 'scheduled');
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  ASSERT v_rows = 1, 'I5 the first claim with the returned stamp moves the post to processing';
  UPDATE public.posts SET status = 'processing', processing_started_at = now()
   WHERE id = p_new AND publish_requested_at = v_stamp AND status IN ('pending', 'scheduled');
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  ASSERT v_rows = 0, 'I6 a second claim with the same stamp matches no row';

  -- I7: a scheduled post published early is re-timed to now, as before.
  v_stamp := public.request_immediate_publish(p_scheduled, u_a);
  ASSERT v_stamp = now(), 'I7 a scheduled post can be published now';
  ASSERT (SELECT scheduled_at FROM public.posts WHERE id = p_scheduled) = now(),
    'I7b its scheduled_at moves to the time it actually goes out';

  -- I8-I12: nothing else is stamped.
  ASSERT public.request_immediate_publish(p_failed, u_a) IS NULL, 'I8 a failed post is not stamped';
  ASSERT public.request_immediate_publish(p_partial, u_a) IS NULL, 'I9 a completed post is not stamped';
  ASSERT public.request_immediate_publish(p_running, u_a) IS NULL, 'I10 a processing post is not stamped';
  ASSERT public.request_immediate_publish(p_tiktok, u_a) IS NULL, 'I11 a TikTok review post is not stamped';
  ASSERT public.request_immediate_publish(p_insert, u_b) IS NULL, 'I12 another user cannot stamp the post';
  ASSERT public.request_immediate_publish('c0000000-0000-4000-8000-0000000000ff', u_a) IS NULL,
    'I13 a missing post returns NULL';

  -- R1-R6: retry of a failed post targets its failed accounts only.
  v_result := public.request_post_retry(p_failed, u_a);
  ASSERT v_result->>'status' = 'accepted', 'R1 a failed post can be retried';
  ASSERT (SELECT array_agg(x ORDER BY x) FROM jsonb_array_elements_text(v_result->'account_ids') x)
         = (SELECT array_agg(x ORDER BY x) FROM unnest(ARRAY[acct_fb::text, acct_ig::text]) x),
    'R2 the targets are the accounts with a failed result';
  ASSERT (SELECT status FROM public.posts WHERE id = p_failed) = 'pending',
    'R3 the retried post is pending for the claim';
  ASSERT (SELECT publish_requested_at FROM public.posts WHERE id = p_failed) = now(),
    'R4 the retry is stamped';
  ASSERT (SELECT (metadata->'retry_request'->>'requested_at')::timestamptz = publish_requested_at
            AND metadata->'retry_request'->>'prior_status' = 'failed'
            FROM public.posts WHERE id = p_failed),
    'R5 the retry marker carries the same timestamp and the prior status';
  ASSERT (SELECT count(*) FROM public.platform_posts WHERE post_id = p_failed) = 1,
    'R6 the targeted failed results are cleared; the account-less one is kept on record';

  -- R7: a double click finds the post pending and starts nothing.
  v_result := public.request_post_retry(p_failed, u_a);
  ASSERT v_result->>'reason' = 'not_retryable', 'R7 a second retry of a queued post is refused';

  -- R7b: "Publish now" on a queued retry keeps the retry's stamp and marker.
  UPDATE public.posts
     SET publish_requested_at = now() - interval '1 minute',
         metadata = jsonb_set(metadata, '{retry_request,requested_at}', to_jsonb(now() - interval '1 minute'))
   WHERE id = p_failed;
  ASSERT public.request_immediate_publish(p_failed, u_a) = now() - interval '1 minute',
    'R7b publish-now returns the queued retry''s stamp instead of orphaning its marker';
  ASSERT (SELECT publish_requested_at FROM public.posts WHERE id = p_failed) = now() - interval '1 minute',
    'R7c the queued retry''s stamp is unchanged';

  -- R8/R9: a partly published post retries only the account that failed.
  v_result := public.request_post_retry(p_partial, u_a);
  ASSERT v_result->'account_ids' = to_jsonb(ARRAY[acct_ig]), 'R8 the successful account is not republished';
  ASSERT v_result->'platforms' = to_jsonb(ARRAY['instagram']), 'R9 the platforms follow the targets';
  ASSERT (SELECT count(*) FROM public.platform_posts WHERE post_id = p_partial AND status = 'success') = 1,
    'R9b the success result is kept';

  -- R10/R11: explicit accounts drop successes and other users' accounts.
  UPDATE public.posts SET status = 'completed' WHERE id = p_partial;
  v_result := public.request_post_retry(p_partial, u_a, ARRAY[acct_fb, acct_th, acct_b]);
  ASSERT v_result->'account_ids' = to_jsonb(ARRAY[acct_th]),
    'R10 explicit targets keep only the owner''s accounts that have not succeeded';
  UPDATE public.posts SET status = 'completed' WHERE id = p_partial;
  v_result := public.request_post_retry(p_partial, u_a, ARRAY[acct_fb]);
  ASSERT v_result->>'reason' = 'no_targets', 'R11 a retry with nothing left to publish is refused';

  -- R12-R14: refusals.
  ASSERT public.request_post_retry(p_partial, u_b)->>'reason' = 'not_found',
    'R12 another user''s post reads as not found';
  ASSERT public.request_post_retry(p_running, u_a)->>'reason' = 'not_retryable',
    'R13 a processing post cannot be retried';
  UPDATE public.posts SET status = 'failed' WHERE id = p_tiktok;
  ASSERT public.request_post_retry(p_tiktok, u_a)->>'reason' = 'not_retryable',
    'R14 a TikTok review post is retried in TikTok review, not here';
END $$;

-- G1-G8: privileges, definer settings and the due-row index.
DO $$
BEGIN
  ASSERT NOT has_function_privilege('authenticated', 'public.request_immediate_publish(uuid, uuid)', 'EXECUTE'),
    'G1 authenticated cannot stamp a publish';
  ASSERT NOT has_function_privilege('anon', 'public.request_immediate_publish(uuid, uuid)', 'EXECUTE'),
    'G2 anon cannot stamp a publish';
  ASSERT has_function_privilege('service_role', 'public.request_immediate_publish(uuid, uuid)', 'EXECUTE'),
    'G3 the service role can stamp a publish';
  ASSERT NOT has_function_privilege('authenticated', 'public.request_post_retry(uuid, uuid, uuid[])', 'EXECUTE'),
    'G4 authenticated cannot queue a retry';
  ASSERT NOT has_function_privilege('anon', 'public.request_post_retry(uuid, uuid, uuid[])', 'EXECUTE'),
    'G5 anon cannot queue a retry';
  ASSERT has_function_privilege('service_role', 'public.request_post_retry(uuid, uuid, uuid[])', 'EXECUTE'),
    'G6 the service role can queue a retry';
  ASSERT (SELECT bool_and(prosecdef AND 'search_path=public' = ANY (proconfig))
            FROM pg_proc
           WHERE oid IN ('public.request_immediate_publish(uuid, uuid)'::regprocedure,
                         'public.request_post_retry(uuid, uuid, uuid[])'::regprocedure)),
    'G7 both functions are SECURITY DEFINER with search_path pinned';
  ASSERT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'posts_publish_requested_due_idx'),
    'G8 the due-request index exists';
END $$;

ROLLBACK;

\echo '=== publish_requests: ALL CHECKS PASSED ==='
