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
  p_story     uuid := 'c0000000-0000-4000-8000-000000000008';
  p_leased    uuid := 'c0000000-0000-4000-8000-000000000009';
  p_marker    uuid := 'c0000000-0000-4000-8000-00000000000a';
  p_resched   uuid := 'c0000000-0000-4000-8000-00000000000b';
  p_feed_ok   uuid := 'c0000000-0000-4000-8000-00000000000e';
  p_all_ok    uuid := 'c0000000-0000-4000-8000-00000000000f';
  p_foreign   uuid := 'c0000000-0000-4000-8000-000000000010';
  p_array_md  uuid := 'c0000000-0000-4000-8000-000000000011';
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
  -- T3: an edit that saves the post for immediate publishing is pinned the same way.
  UPDATE public.posts SET publish_requested_at = now() + interval '3 hours' WHERE id = p_new;
  ASSERT (SELECT publish_requested_at FROM public.posts WHERE id = p_new) = now(),
    'T3 an edited request time is pinned to now()';
  UPDATE public.posts SET publish_requested_at = NULL WHERE id = p_new;

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
  -- The fixture ages the stamp, which the pin trigger would reset to now().
  PERFORM set_config('session_replication_role', 'replica', true);
  UPDATE public.posts
     SET publish_requested_at = now() - interval '1 minute',
         metadata = jsonb_set(metadata, '{retry_request,requested_at}', to_jsonb(now() - interval '1 minute'))
   WHERE id = p_failed;
  PERFORM set_config('session_replication_role', 'origin', true);
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

  -- R15: an Instagram story that went live does not stop the feed post's retry.
  INSERT INTO public.posts (id, user_id, platforms, status, source)
  VALUES (p_story, u_a, ARRAY['instagram'], 'completed', 'manual');
  INSERT INTO public.platform_posts (post_id, social_account_id, platform, status, response_data) VALUES
    (p_story, acct_ig, 'instagram', 'success', '{"ig_post_subtype": "story"}'),
    (p_story, acct_ig, 'instagram', 'failed', NULL);
  v_result := public.request_post_retry(p_story, u_a);
  ASSERT v_result->'account_ids' = to_jsonb(ARRAY[acct_ig]),
    'R15 the account whose story succeeded is retried for its failed feed post';
  ASSERT (SELECT count(*) FROM public.platform_posts WHERE post_id = p_story AND status = 'success') = 1,
    'R15b the story''s success result is kept for process-post''s retry guard';

  -- R18/R19: Instagram feed post live, story failed: the story is retried. Both live: nothing is.
  INSERT INTO public.posts (id, user_id, platforms, status, source) VALUES
    (p_feed_ok, u_a, ARRAY['instagram'], 'completed', 'manual'),
    (p_all_ok,  u_a, ARRAY['instagram'], 'completed', 'manual');
  INSERT INTO public.platform_posts (post_id, social_account_id, platform, status, response_data) VALUES
    (p_feed_ok, acct_ig, 'instagram', 'success', '{"ig_post_subtype": "feed"}'),
    (p_feed_ok, acct_ig, 'instagram', 'failed',  '{"ig_post_subtype": "story"}'),
    (p_all_ok,  acct_ig, 'instagram', 'success', '{"ig_post_subtype": "feed"}'),
    (p_all_ok,  acct_ig, 'instagram', 'success', '{"ig_post_subtype": "story"}');
  ASSERT public.request_post_retry(p_feed_ok, u_a, ARRAY[acct_ig])->'account_ids' = to_jsonb(ARRAY[acct_ig]),
    'R18 the account whose feed post is live is retried for its failed story';
  ASSERT public.request_post_retry(p_all_ok, u_a, ARRAY[acct_ig])->>'reason' = 'no_targets',
    'R19 an Instagram account with nothing failed is not retried';

  -- R16/R17: an agent retry's live action lease blocks a second run; an expired one does not.
  INSERT INTO public.posts (id, user_id, platforms, status, source, action_claim_id, action_claimed_at)
  VALUES (p_leased, u_a, ARRAY['facebook'], 'failed', 'manual', gen_random_uuid(), now());
  INSERT INTO public.platform_posts (post_id, social_account_id, platform, status)
  VALUES (p_leased, acct_fb, 'facebook', 'failed');
  ASSERT public.request_post_retry(p_leased, u_a)->>'reason' = 'not_retryable',
    'R16 a post under a live agent retry lease is not retried again';
  UPDATE public.posts SET action_claimed_at = now() - interval '20 minutes' WHERE id = p_leased;
  ASSERT public.request_post_retry(p_leased, u_a)->>'status' = 'accepted',
    'R17 an expired lease no longer blocks a retry';

  -- R20: a failed result naming another user's account is never an inferred target.
  INSERT INTO public.posts (id, user_id, platforms, status, source)
  VALUES (p_foreign, u_a, ARRAY['facebook'], 'failed', 'manual');
  INSERT INTO public.platform_posts (post_id, social_account_id, platform, status) VALUES
    (p_foreign, acct_fb, 'facebook', 'failed'),
    (p_foreign, acct_b,  'facebook', 'failed');
  ASSERT public.request_post_retry(p_foreign, u_a)->'account_ids' = to_jsonb(ARRAY[acct_fb]),
    'R20 inferred targets keep only the owner''s accounts';
  ASSERT EXISTS (SELECT 1 FROM public.platform_posts WHERE post_id = p_foreign AND social_account_id = acct_b),
    'R20b the other user''s result row is left alone';

  -- R21: metadata that is not an object is replaced, so the marker is a real key.
  INSERT INTO public.posts (id, user_id, platforms, status, source, metadata)
  VALUES (p_array_md, u_a, ARRAY['facebook'], 'failed', 'manual', '["x"]'::jsonb);
  INSERT INTO public.platform_posts (post_id, social_account_id, platform, status)
  VALUES (p_array_md, acct_fb, 'facebook', 'failed');
  ASSERT public.request_post_retry(p_array_md, u_a)->>'status' = 'accepted', 'R21 retry accepted';
  ASSERT (SELECT jsonb_typeof(metadata) = 'object' AND metadata ? 'retry_request'
            FROM public.posts WHERE id = p_array_md),
    'R21b the retry marker is stored as an object key';

  -- M1: a malformed retry marker written by the owner does not break "Publish now".
  INSERT INTO public.posts (id, user_id, platforms, status, source, metadata)
  VALUES (p_marker, u_a, ARRAY['facebook'], 'pending', 'manual', '{"retry_request": {"requested_at": "garbage"}}');
  ASSERT public.request_immediate_publish(p_marker, u_a) = now(),
    'M1 a malformed marker reads as no queued retry';

  -- S1-S3: a later reschedule or unschedule beats a request nobody has claimed.
  INSERT INTO public.posts (id, user_id, platforms, status, source)
  VALUES (p_resched, u_a, ARRAY['facebook'], 'pending', 'manual');
  PERFORM public.request_immediate_publish(p_resched, u_a);
  UPDATE public.posts SET scheduled_at = now() + interval '1 day', status = 'scheduled' WHERE id = p_resched;
  ASSERT (SELECT publish_requested_at FROM public.posts WHERE id = p_resched) IS NULL,
    'S1 rescheduling drops the unclaimed publish request';
  UPDATE public.posts SET scheduled_at = NULL, status = 'pending' WHERE id = p_scheduled;
  ASSERT (SELECT publish_requested_at FROM public.posts WHERE id = p_scheduled) IS NULL,
    'S2 unscheduling a post published early drops its unclaimed request';
  UPDATE public.posts SET scheduled_at = now() + interval '1 day' WHERE id = p_failed;
  ASSERT (SELECT publish_requested_at FROM public.posts WHERE id = p_failed) = now() - interval '1 minute',
    'S3 a queued retry keeps its request so its marker still applies';
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

-- S4-S5: the browser reschedules as authenticated. Regression (PR #390 review):
-- the reschedule trigger called a helper authenticated may not execute, which
-- failed every browser reschedule, with or without a request. Own transaction:
-- PL/pgSQL checks that privilege once per transaction, so an earlier firing as
-- the superuser would hide it.
BEGIN;
INSERT INTO auth.users (id, email) VALUES ('a1a1a1a1-1111-4111-8111-a1a1a1a1a1a1', 'publish-requests-a@example.invalid');
INSERT INTO public.user_quotas (user_id, max_posts_per_day, max_posts_per_month, max_media_uploads_per_day)
VALUES ('a1a1a1a1-1111-4111-8111-a1a1a1a1a1a1', -1, -1, -1)
ON CONFLICT (user_id) DO UPDATE SET
  max_posts_per_day = EXCLUDED.max_posts_per_day,
  max_posts_per_month = EXCLUDED.max_posts_per_month,
  max_media_uploads_per_day = EXCLUDED.max_media_uploads_per_day;
INSERT INTO public.posts (id, user_id, platforms, status, scheduled_at, publish_requested_at, source) VALUES
  ('c0000000-0000-4000-8000-00000000000c', 'a1a1a1a1-1111-4111-8111-a1a1a1a1a1a1', ARRAY['facebook'], 'scheduled', now() + interval '1 day', NULL, 'manual'),
  ('c0000000-0000-4000-8000-00000000000d', 'a1a1a1a1-1111-4111-8111-a1a1a1a1a1a1', ARRAY['facebook'], 'pending', NULL, now(), 'manual');
SELECT set_config('request.jwt.claims', '{"sub":"a1a1a1a1-1111-4111-8111-a1a1a1a1a1a1","role":"authenticated"}', true);
SELECT set_config('request.jwt.claim.sub', 'a1a1a1a1-1111-4111-8111-a1a1a1a1a1a1', true);
SET LOCAL ROLE authenticated;
DO $$
DECLARE
  v_rows int;
BEGIN
  UPDATE public.posts SET scheduled_at = scheduled_at + interval '1 hour'
   WHERE id = 'c0000000-0000-4000-8000-00000000000c';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  ASSERT v_rows = 1, 'S4 the owner can reschedule a post that has no request';
  UPDATE public.posts SET scheduled_at = now() + interval '1 day', status = 'scheduled'
   WHERE id = 'c0000000-0000-4000-8000-00000000000d';
  ASSERT (SELECT publish_requested_at FROM public.posts WHERE id = 'c0000000-0000-4000-8000-00000000000d') IS NULL,
    'S5 an owner reschedule drops the unclaimed request';
END $$;
ROLLBACK;

\echo '=== publish_requests: ALL CHECKS PASSED ==='
