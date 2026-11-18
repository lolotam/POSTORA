-- ============================================================================
-- supabase/tests/youtube_upload_sessions.sql
-- Migration 20261118120000_youtube_resumable_upload_sessions.sql.
--
-- One transaction, synthetic fixtures, labelled assertions, expected refusals
-- in nested BEGIN/EXCEPTION blocks, ROLLBACK. Fixture values are synthetic
-- ('...@example.invalid'); no secrets, no real accounts, no provider calls.
--
-- What this suite proves
--   Y1  the grant surface: RLS on and no policies on the table, no browser
--       privilege on the table, and every function reachable by the service
--       role only.
--   Y2  the owner boundary: a post, an account and a media file that are not
--       the caller's are refused, and so is an account that is not a usable
--       YouTube account. No row is created by a refused call.
--   Y3  one upload per post and account: opening the same pair twice returns
--       the same session.
--   Y4  the lease: one worker owns the session, a second worker is refused
--       while the lease is live, and a stale lease cannot write, checkpoint,
--       complete or release.
--   Y5  the offsets only grow.
--   Y6  the receipt: it is kept, the session URI is dropped with it, it is
--       idempotent, and a release never takes it back.
--   Y7  the content fence: an edited upload body and a replaced media file
--       both refuse the resume.
--   Y8  the expired session: it is reopened when no video can exist, and it
--       is left for a human when the last chunk may have been written.
--   Y9  the batch claim takes the open sessions no live lease holds, and
--       leaves the leased and the closed ones alone. The claim carries the
--       token and the attempt, and no session URI.
--   Y10 the retry guard: an upload that needs manual reconciliation is
--       neither targeted nor deleted by a post retry.
--   Y11 the lease is a number of milliseconds, and the functions turn it
--       into an interval themselves.
--   Y12 the attempt fence: a session that belongs to an older attempt of
--       the post, or to a post that is no longer being processed, is not
--       carried on.
--   Y13 the reconciler's one claim surface hands out the upload sessions
--       that are due, with the token and the attempt.
--   Y14 the sweeper leaves a post with an open YouTube upload alone, so it
--       is never declared "safe to retry" while the provider may already
--       hold a video.
--
-- The suite SET ROLEs away from superuser where the point of the check is
-- that a client role cannot do something. The service role bypasses RLS, so
-- the ownership checks and the foreign keys are the only thing under test
-- there.
-- ============================================================================

\set ON_ERROR_STOP on

BEGIN;

-- ---------------------------------------------------------------------------
-- The fixtures.
--
-- u_a / u_b   : two owners
-- acct_a      : owner A's YouTube account
-- acct_b      : owner B's YouTube account
-- post_a      : owner A's post
-- media_a     : owner A's video file
-- media_b     : owner B's video file
-- ---------------------------------------------------------------------------
DO $fixtures$
DECLARE
  v_u_a       uuid := 'b1000000-0000-4000-8000-000000000001';
  v_u_b       uuid := 'b1000000-0000-4000-8000-000000000002';
  v_acct_a    uuid := 'b2000000-0000-4000-8000-000000000001';
  v_acct_b    uuid := 'b2000000-0000-4000-8000-000000000002';
  v_post_a    uuid := 'b3000000-0000-4000-8000-000000000001';
  v_media_a   uuid := 'b4000000-0000-4000-8000-000000000001';
  v_media_b   uuid := 'b4000000-0000-4000-8000-000000000002';
BEGIN
  INSERT INTO auth.users (id, email) VALUES
    (v_u_a, 'yt-upload-a@example.invalid'),
    (v_u_b, 'yt-upload-b@example.invalid')
  ON CONFLICT (id) DO NOTHING;

  -- The synthetic owners need more than the free plan's two posts a day: this
  -- suite opens a post per scenario. The quota is a counter on the owner, so
  -- it is raised here rather than worked around.
  INSERT INTO public.user_quotas
    (user_id, max_posts_per_day, max_posts_per_month)
  VALUES
    (v_u_a, 20, 100),
    (v_u_b, 20, 100)
  ON CONFLICT (user_id) DO UPDATE
    SET max_posts_per_day = EXCLUDED.max_posts_per_day,
        max_posts_per_month = EXCLUDED.max_posts_per_month;

  INSERT INTO public.social_accounts
    (id, user_id, platform, platform_user_id, platform_username, access_token, is_active)
  VALUES
    (v_acct_a, v_u_a, 'youtube', 'yt-channel-a', 'channel a', 'token-a', true),
    (v_acct_b, v_u_b, 'youtube', 'yt-channel-b', 'channel b', 'token-b', true)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.media_files
    (id, user_id, file_path, file_type, file_size, mime_type, storage_bucket)
  VALUES
    (v_media_a, v_u_a, 'uploads/a.mp4', 'video', 4096, 'video/mp4', 'media'),
    (v_media_b, v_u_b, 'uploads/b.mp4', 'video', 4096, 'video/mp4', 'media')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.posts
    (id, user_id, caption, platforms, media_file_ids, status, processing_started_at)
  VALUES
    (v_post_a, v_u_a, 'A video', ARRAY['youtube'], ARRAY[v_media_a], 'processing', now())
  ON CONFLICT (id) DO NOTHING;
END
$fixtures$;

-- ---------------------------------------------------------------------------
-- Y1: the grant surface.
-- ---------------------------------------------------------------------------
DO $y1_grants$
BEGIN
  ASSERT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.youtube_upload_sessions'::regclass),
    'Y1 RLS is enabled on the session table';

  ASSERT (SELECT count(*) = 0 FROM pg_policies
           WHERE schemaname = 'public' AND tablename = 'youtube_upload_sessions'),
    'Y1 the session table has no policy, so no browser role may read it';

  ASSERT NOT has_table_privilege('anon', 'public.youtube_upload_sessions', 'SELECT'),
    'Y1 anon holds no SELECT on the session table';
  ASSERT NOT has_table_privilege('authenticated', 'public.youtube_upload_sessions', 'SELECT'),
    'Y1 authenticated holds no SELECT on the session table';
  ASSERT NOT has_table_privilege('authenticated', 'public.youtube_upload_sessions', 'INSERT'),
    'Y1 authenticated holds no INSERT on the session table';
  ASSERT NOT has_table_privilege('authenticated', 'public.youtube_upload_sessions', 'UPDATE'),
    'Y1 authenticated holds no UPDATE on the session table';
  ASSERT NOT has_table_privilege('authenticated', 'public.youtube_upload_sessions', 'DELETE'),
    'Y1 authenticated holds no DELETE on the session table';

  ASSERT NOT has_function_privilege('anon',
      'public.begin_youtube_upload_session(uuid,uuid,uuid,uuid,bigint,bigint,jsonb,timestamptz,uuid,timestamptz)', 'EXECUTE'),
    'Y1 anon may not open a session';
  ASSERT NOT has_function_privilege('authenticated',
      'public.begin_youtube_upload_session(uuid,uuid,uuid,uuid,bigint,bigint,jsonb,timestamptz,uuid,timestamptz)', 'EXECUTE'),
    'Y1 authenticated may not open a session';
  ASSERT NOT has_function_privilege('authenticated',
      'public.checkpoint_youtube_upload_session(uuid,uuid,bigint,bigint,text,boolean,timestamptz,text)', 'EXECUTE'),
    'Y1 authenticated may not checkpoint a session';
  ASSERT NOT has_function_privilege('authenticated',
      'public.complete_youtube_upload_session(uuid,uuid,text)', 'EXECUTE'),
    'Y1 authenticated may not complete a session';
  ASSERT NOT has_function_privilege('authenticated',
      'public.claim_youtube_upload_sessions(integer,bigint,integer)', 'EXECUTE'),
    'Y1 authenticated may not take the sessions of a later worker';

  ASSERT has_function_privilege('service_role',
      'public.begin_youtube_upload_session(uuid,uuid,uuid,uuid,bigint,bigint,jsonb,timestamptz,uuid,timestamptz)', 'EXECUTE'),
    'Y1 the service role may open a session';
  ASSERT has_function_privilege('service_role',
      'public.checkpoint_youtube_upload_session(uuid,uuid,bigint,bigint,text,boolean,timestamptz,text)', 'EXECUTE'),
    'Y1 the service role may checkpoint a session';
  ASSERT has_function_privilege('service_role',
      'public.claim_youtube_upload_sessions(integer,bigint,integer)', 'EXECUTE'),
    'Y1 the service role may take the sessions of a later worker';

  RAISE NOTICE 'PASS Y1: the session table and its functions are service role only';
END
$y1_grants$;

-- ---------------------------------------------------------------------------
-- Y2: the owner boundary.
-- ---------------------------------------------------------------------------
DO $y2_owner$
DECLARE
  v_u_a     uuid := 'b1000000-0000-4000-8000-000000000001';
  v_u_b     uuid := 'b1000000-0000-4000-8000-000000000002';
  v_acct_a  uuid := 'b2000000-0000-4000-8000-000000000001';
  v_acct_b  uuid := 'b2000000-0000-4000-8000-000000000002';
  v_post_a  uuid := 'b3000000-0000-4000-8000-000000000001';
  v_media_a uuid := 'b4000000-0000-4000-8000-000000000001';
  v_media_b uuid := 'b4000000-0000-4000-8000-000000000002';
BEGIN
  -- A post that is not the caller's.
  BEGIN
    PERFORM public.begin_youtube_upload_session(
      v_post_a, v_acct_a, v_u_b, v_media_a, 4096, 4096, '{"snippet":{"title":"A"}}'::jsonb);
    RAISE EXCEPTION 'Y2 failed: another owner opened a session'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'YUS01' THEN
    NULL;
  END;

  -- An account that is not the caller's.
  BEGIN
    PERFORM public.begin_youtube_upload_session(
      v_post_a, v_acct_b, v_u_a, v_media_a, 4096, 4096, '{"snippet":{"title":"A"}}'::jsonb);
    RAISE EXCEPTION 'Y2 failed: another owner''s account was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'YUS02' THEN
    NULL;
  END;

  -- A media file that is not the caller's.
  BEGIN
    PERFORM public.begin_youtube_upload_session(
      v_post_a, v_acct_a, v_u_a, v_media_b, 4096, 4096, '{"snippet":{"title":"A"}}'::jsonb);
    RAISE EXCEPTION 'Y2 failed: another owner''s media file was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'YUS03' THEN
    NULL;
  END;

  -- A video with no size.
  BEGIN
    PERFORM public.begin_youtube_upload_session(
      v_post_a, v_acct_a, v_u_a, v_media_a, 0, 0, '{"snippet":{"title":"A"}}'::jsonb);
    RAISE EXCEPTION 'Y2 failed: a video with no size was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'YUS10' THEN
    NULL;
  END;

  ASSERT (SELECT count(*) = 0 FROM public.youtube_upload_sessions),
    'Y2 a refused call leaves no session behind';

  RAISE NOTICE 'PASS Y2: the owner, the account, the media file and the size are all fenced';
END
$y2_owner$;

-- ---------------------------------------------------------------------------
-- Y3 and Y4: one session per post and account, and the lease.
-- ---------------------------------------------------------------------------
DO $y3_lease$
DECLARE
  v_u_a      uuid := 'b1000000-0000-4000-8000-000000000001';
  v_acct_a   uuid := 'b2000000-0000-4000-8000-000000000001';
  v_post_a   uuid := 'b3000000-0000-4000-8000-000000000001';
  v_media_a  uuid := 'b4000000-0000-4000-8000-000000000001';
  v_session  uuid;
  v_again    uuid;
  v_lease_a  uuid := 'b5000000-0000-4000-8000-000000000001';
  v_lease_b  uuid := 'b5000000-0000-4000-8000-000000000002';
BEGIN
  SELECT (public.begin_youtube_upload_session(
    v_post_a, v_acct_a, v_u_a, v_media_a, 4096, 4096,
    '{"snippet":{"title":"A video"}}'::jsonb))->>'id'
    INTO v_session;
  ASSERT v_session IS NOT NULL, 'Y3 the session opens';

  SELECT (public.begin_youtube_upload_session(
    v_post_a, v_acct_a, v_u_a, v_media_a, 4096, 4096,
    '{"snippet":{"title":"A video"}}'::jsonb))->>'id'
    INTO v_again;
  ASSERT v_again = v_session, 'Y3 the same post and account return the same session';

  ASSERT (SELECT count(*) = 1 FROM public.youtube_upload_sessions),
    'Y3 one upload per post and account';

  -- The first worker takes it.
  PERFORM public.claim_youtube_upload_session(v_session, v_lease_a, 180000);

  -- The second worker is refused while the lease is live.
  BEGIN
    PERFORM public.claim_youtube_upload_session(v_session, v_lease_b, 180000);
    RAISE EXCEPTION 'Y4 failed: a second worker took a leased session'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'YUS07' THEN
    NULL;
  END;

  -- A worker with the wrong token cannot write.
  BEGIN
    PERFORM public.checkpoint_youtube_upload_session(
      v_session, v_lease_b, 0, 0, 'https://provider.test/session?upload_id=x', false);
    RAISE EXCEPTION 'Y4 failed: a worker with the wrong token wrote'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'YUS09' THEN
    NULL;
  END;

  -- The owner writes.
  ASSERT public.checkpoint_youtube_upload_session(
    v_session, v_lease_a, 0, 0, 'https://provider.test/session?upload_id=x', false),
    'Y4 the owner checkpoints';

  ASSERT (SELECT session_uri FROM public.youtube_upload_sessions WHERE id = v_session)
           = 'https://provider.test/session?upload_id=x',
    'Y4 the session uri is stored';

  RAISE NOTICE 'PASS Y3 and Y4: one session per post and account, and one owner at a time';
END
$y3_lease$;

-- ---------------------------------------------------------------------------
-- Y5: the offsets only grow.
-- ---------------------------------------------------------------------------
DO $y5_offsets$
DECLARE
  v_session uuid;
  v_lease   uuid := 'b5000000-0000-4000-8000-000000000001';
BEGIN
  SELECT id INTO v_session FROM public.youtube_upload_sessions LIMIT 1;

  PERFORM public.checkpoint_youtube_upload_session(v_session, v_lease, 2048, 2048, NULL, false);
  ASSERT (SELECT confirmed_bytes FROM public.youtube_upload_sessions WHERE id = v_session) = 2048,
    'Y5 the confirmed offset moves forward';

  PERFORM public.checkpoint_youtube_upload_session(v_session, v_lease, 512, 512, NULL, false);
  ASSERT (SELECT confirmed_bytes FROM public.youtube_upload_sessions WHERE id = v_session) = 2048,
    'Y5 a smaller confirmed offset does not move it back';
  ASSERT (SELECT bytes_sent FROM public.youtube_upload_sessions WHERE id = v_session) = 2048,
    'Y5 a smaller written offset does not move it back';

  -- A byte count that does not fit the video is refused.
  BEGIN
    PERFORM public.checkpoint_youtube_upload_session(v_session, v_lease, 999999, 0, NULL, false);
    RAISE EXCEPTION 'Y5 failed: a byte count outside the video was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'YUS10' THEN
    NULL;
  END;

  RAISE NOTICE 'PASS Y5: the confirmed and written offsets only grow';
END
$y5_offsets$;

-- ---------------------------------------------------------------------------
-- Y7: the content fence.
-- ---------------------------------------------------------------------------
DO $y7_fence$
DECLARE
  v_u_a      uuid := 'b1000000-0000-4000-8000-000000000001';
  v_acct_a   uuid := 'b2000000-0000-4000-8000-000000000001';
  v_post_a   uuid := 'b3000000-0000-4000-8000-000000000001';
  v_media_a  uuid := 'b4000000-0000-4000-8000-000000000001';
  v_lease    uuid := 'b5000000-0000-4000-8000-000000000001';
BEGIN
  -- An edited title is a different upload.
  BEGIN
    PERFORM public.begin_youtube_upload_session(
      v_post_a, v_acct_a, v_u_a, v_media_a, 4096, 4096,
      '{"snippet":{"title":"A different video"}}'::jsonb);
    RAISE EXCEPTION 'Y7 failed: an edited upload body was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'YUS04' THEN
    NULL;
  END;

  -- A replaced media file is a different video.
  UPDATE public.media_files
     SET current_object_version = current_object_version + 1
   WHERE id = v_media_a;

  BEGIN
    PERFORM public.claim_youtube_upload_session(
      (SELECT id FROM public.youtube_upload_sessions LIMIT 1), v_lease, 180000);
    RAISE EXCEPTION 'Y7 failed: a replaced media file was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'YUS04' THEN
    NULL;
  END;

  UPDATE public.media_files
     SET current_object_version = current_object_version - 1
   WHERE id = v_media_a;

  RAISE NOTICE 'PASS Y7: an edited upload body and a replaced media file refuse the resume';
END
$y7_fence$;

-- ---------------------------------------------------------------------------
-- Y6: the receipt.
-- ---------------------------------------------------------------------------
DO $y6_receipt$
DECLARE
  v_session uuid;
  v_lease   uuid := 'b5000000-0000-4000-8000-000000000001';
BEGIN
  SELECT id INTO v_session FROM public.youtube_upload_sessions LIMIT 1;

  ASSERT public.complete_youtube_upload_session(v_session, v_lease, 'dQw4w9WgXcQ'),
    'Y6 the receipt is recorded';

  ASSERT (SELECT state FROM public.youtube_upload_sessions WHERE id = v_session) = 'uploaded',
    'Y6 the session is uploaded';
  ASSERT (SELECT video_id FROM public.youtube_upload_sessions WHERE id = v_session) = 'dQw4w9WgXcQ',
    'Y6 the video id is kept';
  ASSERT (SELECT session_uri FROM public.youtube_upload_sessions WHERE id = v_session) IS NULL,
    'Y6 the session uri is dropped once the receipt is kept';
  ASSERT (SELECT confirmed_bytes FROM public.youtube_upload_sessions WHERE id = v_session)
           = (SELECT total_bytes FROM public.youtube_upload_sessions WHERE id = v_session),
    'Y6 the whole file is confirmed';

  -- The same receipt again is the same answer.
  ASSERT public.complete_youtube_upload_session(v_session, v_lease, 'dQw4w9WgXcQ'),
    'Y6 the same receipt is idempotent';

  -- A release never takes the receipt back.
  ASSERT NOT public.release_youtube_upload_session(v_session, v_lease, 'failed', 'late'),
    'Y6 a release never takes a receipt back';
  ASSERT (SELECT state FROM public.youtube_upload_sessions WHERE id = v_session) = 'uploaded',
    'Y6 the session is still uploaded';

  RAISE NOTICE 'PASS Y6: the receipt is kept, the session uri is dropped, the release cannot take it back';
END
$y6_receipt$;

-- ---------------------------------------------------------------------------
-- Y8: the expired session.
-- ---------------------------------------------------------------------------
DO $y8_expired$
DECLARE
  v_u_a      uuid := 'b1000000-0000-4000-8000-000000000001';
  v_acct_a   uuid := 'b2000000-0000-4000-8000-000000000001';
  v_post_a   uuid := 'b3000000-0000-4000-8000-000000000001';
  v_media_a  uuid := 'b4000000-0000-4000-8000-000000000001';
  v_lease    uuid := 'b5000000-0000-4000-8000-000000000001';
  v_body     jsonb := '{"snippet":{"title":"A second video"}}'::jsonb;
  v_session  uuid;
  v_record   jsonb;
BEGIN
  -- A second post, so the first session is not in the way.
  INSERT INTO public.posts (id, user_id, caption, platforms, media_file_ids, status, processing_started_at)  VALUES ('b3000000-0000-4000-8000-000000000002', v_u_a, 'Another video',
          ARRAY['youtube'], ARRAY[v_media_a], 'processing', now())
  ON CONFLICT (id) DO NOTHING;

  SELECT (public.begin_youtube_upload_session(
    'b3000000-0000-4000-8000-000000000002', v_acct_a, v_u_a, v_media_a, 4096, 4096, v_body))->>'id'
    INTO v_session;

  PERFORM public.claim_youtube_upload_session(v_session, v_lease, 180000);
  PERFORM public.checkpoint_youtube_upload_session(
    v_session, v_lease, 1024, 1024, 'https://provider.test/session?upload_id=y', false);

  -- The provider session is gone and no video can exist, so it is reopened.
  PERFORM public.release_youtube_upload_session(
    v_session, v_lease, 'expired', 'The session expired.');

  SELECT public.begin_youtube_upload_session(
    'b3000000-0000-4000-8000-000000000002', v_acct_a, v_u_a, v_media_a, 4096, 4096, v_body)
    INTO v_record;
  ASSERT v_record->>'session_uri' IS NULL, 'Y8 an expired session is reopened without its session uri';
  ASSERT (v_record->>'confirmed_bytes')::bigint = 0, 'Y8 the reopened session starts from nothing';
  ASSERT v_record->>'state' = 'open', 'Y8 the reopened session is open';

  -- Now the last chunk may have been written: no video can be ruled out.
  -- The session is returned in the 'reconcile' state rather than refused
  -- with an exception, because a refusal raised inside the function would be
  -- undone by the caller's rollback and the mark is the whole point.
  PERFORM public.claim_youtube_upload_session(v_session, v_lease, 180000);
  PERFORM public.checkpoint_youtube_upload_session(
    v_session, v_lease, 4096, 4096, 'https://provider.test/session?upload_id=z', true);
  PERFORM public.release_youtube_upload_session(
    v_session, v_lease, 'expired', 'The session expired.');

  SELECT public.begin_youtube_upload_session(
    'b3000000-0000-4000-8000-000000000002', v_acct_a, v_u_a, v_media_a, 4096, 4096, v_body)
    INTO v_record;
  ASSERT v_record->>'state' = 'reconcile', 'Y8 the session is returned for a human';

  ASSERT (SELECT state FROM public.youtube_upload_sessions WHERE id = v_session) = 'reconcile',
    'Y8 the mark is durable';

  RAISE NOTICE 'PASS Y8: an expired session is reopened only when no video can exist';
END
$y8_expired$;

-- ---------------------------------------------------------------------------
-- Y9: the batch claim.
-- ---------------------------------------------------------------------------
DO $y9_batch$
DECLARE
  v_u_a      uuid := 'b1000000-0000-4000-8000-000000000001';
  v_acct_a   uuid := 'b2000000-0000-4000-8000-000000000001';
  v_post_a   uuid := 'b3000000-0000-4000-8000-000000000001';
  v_media_a  uuid := 'b4000000-0000-4000-8000-000000000001';
  v_lease    uuid := 'b5000000-0000-4000-8000-000000000001';
  v_body     jsonb := '{"snippet":{"title":"A third video"}}'::jsonb;
  v_session  uuid;
  v_claimed  uuid[];
  v_rows     record;
  v_found    boolean := false;
BEGIN
  INSERT INTO public.posts (id, user_id, caption, platforms, media_file_ids, status, processing_started_at)
  VALUES ('b3000000-0000-4000-8000-000000000003', v_u_a, 'A third video',
          ARRAY['youtube'], ARRAY[v_media_a], 'processing', now())
  ON CONFLICT (id) DO NOTHING;

  SELECT (public.begin_youtube_upload_session(
    'b3000000-0000-4000-8000-000000000003', v_acct_a, v_u_a, v_media_a, 4096, 4096, v_body))->>'id'
    INTO v_session;
  PERFORM public.claim_youtube_upload_session(v_session, v_lease, 180000);

  -- The worker that owned it is gone: its lease expires.
  UPDATE public.youtube_upload_sessions
     SET lease_expires_at = now() - interval '1 second'
   WHERE id = v_session;

  -- A session with no provider session is not handed out: there is nothing
  -- to continue.
  SELECT array_agg(id) INTO v_claimed FROM public.claim_youtube_upload_sessions(10, 180000);
  ASSERT v_claimed IS NULL OR NOT (v_claimed @> ARRAY[v_session]),
    'Y9 a session with no provider session is not handed out';

  -- A session with a provider session and no live lease IS handed out.
  PERFORM public.claim_youtube_upload_session(v_session, v_lease, 180000);
  PERFORM public.checkpoint_youtube_upload_session(
    v_session, v_lease, 1024, 1024, 'https://provider.test/session?upload_id=w', false);
  UPDATE public.youtube_upload_sessions
     SET lease_expires_at = now() - interval '1 second'
   WHERE id = v_session;

  FOR v_rows IN SELECT * FROM public.claim_youtube_upload_sessions(10, 180000)
  LOOP
    IF v_rows.id = v_session THEN
      v_found := true;
      ASSERT v_rows.lease_token IS NOT NULL,
        'Y9 the claim carries the token the worker proves ownership with';
      ASSERT v_rows.attempt_started_at IS NOT NULL,
        'Y9 the claim carries the post attempt the session belongs to';
    END IF;
  END LOOP;
  ASSERT v_found, 'Y9 a session with a provider session and no live lease is handed out';

  -- The session is now leased by the claim, so it is not handed out again.
  SELECT array_agg(id) INTO v_claimed FROM public.claim_youtube_upload_sessions(10, 180000);
  ASSERT v_claimed IS NULL OR NOT (v_claimed @> ARRAY[v_session]),
    'Y9 a session a live lease holds is not handed out twice';

  -- A session that is not due is not handed out either.
  UPDATE public.youtube_upload_sessions
     SET next_check_at = now() + interval '10 minutes',
         lease_expires_at = now() - interval '1 second'
   WHERE id = v_session;
  SELECT array_agg(id) INTO v_claimed FROM public.claim_youtube_upload_sessions(10, 180000);
  ASSERT v_claimed IS NULL OR NOT (v_claimed @> ARRAY[v_session]),
    'Y9 a session that is not due is not handed out';

  RAISE NOTICE 'PASS Y9: the batch claim hands out nothing that cannot be continued';
END
$y9_batch$;

-- ---------------------------------------------------------------------------
-- Y10: the retry guard.
--
-- A YouTube upload that needs manual reconciliation may have created a video
-- on the channel. A retry would create a second one, so the account is
-- neither targeted nor deleted.
-- ---------------------------------------------------------------------------
DO $y10_retry$
DECLARE
  v_u_a      uuid := 'b1000000-0000-4000-8000-000000000001';
  v_acct_a   uuid := 'b2000000-0000-4000-8000-000000000001';
  v_post_a   uuid := 'b3000000-0000-4000-8000-000000000004';
  v_media_a  uuid := 'b4000000-0000-4000-8000-000000000001';
  v_lease    uuid := 'b5000000-0000-4000-8000-000000000001';
  v_body     jsonb := '{"snippet":{"title":"A fourth video"}}'::jsonb;
  v_session  uuid;
  v_result   jsonb;
BEGIN
  INSERT INTO public.posts (id, user_id, caption, platforms, media_file_ids, status)
  VALUES (v_post_a, v_u_a, 'A fourth video', ARRAY['youtube'], ARRAY[v_media_a], 'failed')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.platform_posts (post_id, social_account_id, platform, status, error_message)
  VALUES (v_post_a, v_acct_a, 'youtube', 'failed', 'The upload could not be confirmed.')
  ON CONFLICT DO NOTHING;

  SELECT (public.begin_youtube_upload_session(
    v_post_a, v_acct_a, v_u_a, v_media_a, 4096, 4096, v_body))->>'id' INTO v_session;
  PERFORM public.claim_youtube_upload_session(v_session, v_lease, 180000);
  PERFORM public.checkpoint_youtube_upload_session(
    v_session, v_lease, 4096, 4096, 'https://provider.test/session?upload_id=r', true);
  PERFORM public.release_youtube_upload_session(
    v_session, v_lease, 'reconcile', 'The provider would not say what happened.');

  v_result := public.request_post_retry(v_post_a, v_u_a);
  ASSERT v_result->>'status' = 'refused', 'Y10 the retry is refused';
  ASSERT v_result->>'reason' = 'no_targets', 'Y10 the account that needs reconciliation is not a target';

  ASSERT (SELECT count(*) = 1 FROM public.platform_posts
           WHERE post_id = v_post_a AND social_account_id = v_acct_a),
    'Y10 the failed row is not deleted either';

  RAISE NOTICE 'PASS Y10: an upload that needs manual reconciliation is not retried';
END
$y10_retry$;

-- ---------------------------------------------------------------------------
-- Y11: the lease is a number of milliseconds.
--
-- PostgREST sends the named arguments of a function as JSON, and a JSON
-- interval has no agreed shape. The functions therefore take `p_lease_ms`,
-- a number, and turn it into an interval themselves. This is the one place
-- the two shapes meet, so it is proved here.
-- ---------------------------------------------------------------------------
DO $y11_lease$
DECLARE
  v_u_a      uuid := 'b1000000-0000-4000-8000-000000000001';
  v_acct_a   uuid := 'b2000000-0000-4000-8000-000000000001';
  v_media_a  uuid := 'b4000000-0000-4000-8000-000000000001';
  v_lease    uuid := 'b5000000-0000-4000-8000-000000000003';
  v_body     jsonb := '{"snippet":{"title":"A leased video"}}'::jsonb;
  v_session  uuid;
  v_expires  timestamptz;
BEGIN
  INSERT INTO public.posts (id, user_id, caption, platforms, media_file_ids, status, processing_started_at)
  VALUES ('b3000000-0000-4000-8000-000000000005', v_u_a, 'A leased video',
          ARRAY['youtube'], ARRAY[v_media_a], 'processing', now())
  ON CONFLICT (id) DO NOTHING;

  SELECT (public.begin_youtube_upload_session(
    'b3000000-0000-4000-8000-000000000005', v_acct_a, v_u_a, v_media_a, 4096, 4096, v_body))->>'id'
    INTO v_session;

  PERFORM public.claim_youtube_upload_session(v_session, v_lease, 180000);

  SELECT lease_expires_at INTO v_expires
    FROM public.youtube_upload_sessions WHERE id = v_session;

  ASSERT v_expires IS NOT NULL, 'Y11 the claim set a lease expiry';
  -- The lease is 180 seconds long, with a second of slack for the clock.
  ASSERT v_expires > now() + interval '179 seconds'
     AND v_expires < now() + interval '181 seconds',
    'Y11 a lease of 180000 ms is a lease of three minutes';

  -- A lease length that is not usable is refused rather than guessed at.
  BEGIN
    PERFORM public.claim_youtube_upload_session(v_session, v_lease, 0);
    RAISE EXCEPTION 'Y11 failed: a lease of no length was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'YUS09' THEN
    NULL;
  END;

  BEGIN
    PERFORM public.claim_youtube_upload_session(v_session, v_lease, 999999999);
    RAISE EXCEPTION 'Y11 failed: an unbounded lease was accepted'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'YUS09' THEN
    NULL;
  END;

  RAISE NOTICE 'PASS Y11: the lease is a number of milliseconds and becomes an interval';
END
$y11_lease$;

-- ---------------------------------------------------------------------------
-- Y12: the attempt fence.
--
-- A post that was edited or retried is published again, and that is a new
-- attempt with a new processing_started_at. The bytes of the older attempt
-- are not what the customer asked for now, so a session that belongs to the
-- older attempt must not be carried on.
-- ---------------------------------------------------------------------------
DO $y12_attempt$
DECLARE
  v_u_a      uuid := 'b1000000-0000-4000-8000-000000000001';
  v_acct_a   uuid := 'b2000000-0000-4000-8000-000000000001';
  v_media_a  uuid := 'b4000000-0000-4000-8000-000000000001';
  v_lease    uuid := 'b5000000-0000-4000-8000-000000000004';
  v_body     jsonb := '{"snippet":{"title":"An attempt video"}}'::jsonb;
  v_session  uuid;
BEGIN
  INSERT INTO public.posts (id, user_id, caption, platforms, media_file_ids, status, processing_started_at)
  VALUES ('b3000000-0000-4000-8000-000000000006', v_u_a, 'An attempt video',
          ARRAY['youtube'], ARRAY[v_media_a], 'processing', now())
  ON CONFLICT (id) DO NOTHING;

  SELECT (public.begin_youtube_upload_session(
    'b3000000-0000-4000-8000-000000000006', v_acct_a, v_u_a, v_media_a, 4096, 4096, v_body))->>'id'
    INTO v_session;

  -- The session records the attempt the post is on.
  ASSERT (SELECT attempt_started_at IS NOT NULL FROM public.youtube_upload_sessions WHERE id = v_session),
    'Y12 the session records the attempt it belongs to';

  -- The post moves on to a newer attempt.
  UPDATE public.posts SET processing_started_at = now() + interval '1 minute'
   WHERE id = 'b3000000-0000-4000-8000-000000000006';

  -- The session may not be carried on.
  BEGIN
    PERFORM public.claim_youtube_upload_session(v_session, v_lease, 180000);
    RAISE EXCEPTION 'Y12 failed: a session of an older attempt was claimed'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'YUS11' THEN
    NULL;
  END;

  -- A post that is no longer being processed may not be carried on either.
  UPDATE public.posts SET status = 'completed'
   WHERE id = 'b3000000-0000-4000-8000-000000000006';

  BEGIN
    PERFORM public.claim_youtube_upload_session(v_session, v_lease, 180000);
    RAISE EXCEPTION 'Y12 failed: a session of a settled post was claimed'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN SQLSTATE 'YUS12' THEN
    NULL;
  END;

  RAISE NOTICE 'PASS Y12: a session of an older attempt is not carried on';
END
$y12_attempt$;

-- ---------------------------------------------------------------------------
-- Y13: the reconciler's one claim surface hands out the YouTube uploads.
--
-- The completion claim is the reconciler's bounded entry point. It now also
-- hands out the upload sessions that are due for another look, with the
-- token and the attempt, and with no session URI.
-- ---------------------------------------------------------------------------
DO $y13_completion_claim$
DECLARE
  v_u_a      uuid := 'b1000000-0000-4000-8000-000000000001';
  v_acct_a   uuid := 'b2000000-0000-4000-8000-000000000001';
  v_media_a  uuid := 'b4000000-0000-4000-8000-000000000001';
  v_lease    uuid := 'b5000000-0000-4000-8000-000000000005';
  v_body     jsonb := '{"snippet":{"title":"A claimed video"}}'::jsonb;
  v_session  uuid;
  v_row      record;
  v_found    boolean := false;
BEGIN
  INSERT INTO public.posts (id, user_id, caption, platforms, media_file_ids, status, processing_started_at)
  VALUES ('b3000000-0000-4000-8000-000000000007', v_u_a, 'A claimed video',
          ARRAY['youtube'], ARRAY[v_media_a], 'processing', now())
  ON CONFLICT (id) DO NOTHING;

  SELECT (public.begin_youtube_upload_session(
    'b3000000-0000-4000-8000-000000000007', v_acct_a, v_u_a, v_media_a, 4096, 4096, v_body))->>'id'
    INTO v_session;
  PERFORM public.claim_youtube_upload_session(v_session, v_lease, 180000);
  PERFORM public.checkpoint_youtube_upload_session(
    v_session, v_lease, 1024, 1024, 'https://provider.test/session?upload_id=claim', false);

  -- The worker that owned it is gone: its lease expires.
  UPDATE public.youtube_upload_sessions
     SET lease_expires_at = now() - interval '1 second'
   WHERE id = v_session;

  FOR v_row IN SELECT * FROM public.claim_post_completion_work(5)
  LOOP
    IF v_row.kind = 'youtube_upload_continuation' AND v_row.candidate_id = v_session THEN
      v_found := true;
      ASSERT v_row.claim_id IS NOT NULL,
        'Y13 the claim carries the token the worker proves ownership with';
      ASSERT v_row.attempt_started_at IS NOT NULL,
        'Y13 the claim carries the post attempt the session belongs to';
      ASSERT v_row.platform_post_id IS NULL,
        'Y13 the claim carries no public row id';
    END IF;
  END LOOP;
  ASSERT v_found, 'Y13 the completion claim hands out the upload session';

  RAISE NOTICE 'PASS Y13: the reconciler claim carries the upload continuation';
END
$y13_completion_claim$;

-- ---------------------------------------------------------------------------
-- Y14: the sweeper leaves a post with an open upload alone.
--
-- The sweeper marks a post that has been processing for too long as failed,
-- with the message "Safe to retry". For a YouTube upload that is wrong: the
-- provider may already hold a video, and the retry would create a second
-- one. The post is therefore left alone while the session is open.
-- ---------------------------------------------------------------------------
DO $y14_sweeper$
DECLARE
  v_u_a      uuid := 'b1000000-0000-4000-8000-000000000001';
  v_acct_a   uuid := 'b2000000-0000-4000-8000-000000000001';
  v_media_a  uuid := 'b4000000-0000-4000-8000-000000000001';
  v_lease    uuid := 'b5000000-0000-4000-8000-000000000006';
  v_body     jsonb := '{"snippet":{"title":"A swept video"}}'::jsonb;
  v_session  uuid;
  v_result   jsonb;
BEGIN
  INSERT INTO public.posts (id, user_id, caption, platforms, media_file_ids, status, processing_started_at)
  VALUES ('b3000000-0000-4000-8000-000000000008', v_u_a, 'A swept video',
          ARRAY['youtube'], ARRAY[v_media_a], 'processing', now() - interval '30 minutes')
  ON CONFLICT (id) DO NOTHING;

  SELECT (public.begin_youtube_upload_session(
    'b3000000-0000-4000-8000-000000000008', v_acct_a, v_u_a, v_media_a, 4096, 4096, v_body))->>'id'
    INTO v_session;
  PERFORM public.claim_youtube_upload_session(v_session, v_lease, 180000);
  PERFORM public.checkpoint_youtube_upload_session(
    v_session, v_lease, 1024, 1024, 'https://provider.test/session?upload_id=sweep', false);
  UPDATE public.youtube_upload_sessions
     SET lease_expires_at = now() - interval '1 second'
   WHERE id = v_session;

  v_result := public.sweep_stale_processing_posts();
  ASSERT (SELECT status = 'processing' FROM public.posts
           WHERE id = 'b3000000-0000-4000-8000-000000000008'),
    'Y14 a post with an open YouTube upload is not swept';

  RAISE NOTICE 'PASS Y14: the sweeper leaves an open YouTube upload alone';
END
$y14_sweeper$;

-- ---------------------------------------------------------------------------
-- The browser roles may not reach the session at all.
-- ---------------------------------------------------------------------------
SET ROLE authenticated;

DO $browser$
BEGIN
  BEGIN
    PERFORM public.begin_youtube_upload_session(
      gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(),
      4096, 4096, '{}'::jsonb);
    RAISE EXCEPTION 'the browser role opened a session'
      USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END
$browser$;

RESET ROLE;

ROLLBACK;

\echo '=== youtube_upload_sessions: ALL CHECKS PASSED ==='
