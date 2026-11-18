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
--   Y3  the admission is ATOMIC: the private session and the public pending
--       platform_posts row are created together, or not at all. One upload per
--       post and account: admitting the same pair twice returns the same
--       session and the same public row.
--   Y4  the lease: one worker owns the session, a second worker is refused
--       while the lease is live, and a stale lease cannot write, checkpoint,
--       complete, release or settle.
--   Y5  the offsets only grow, and the uncertainty that a video may exist is
--       never cleared by a checkpoint.
--   Y6  the receipt: it is kept, the session URI is dropped with it, it is
--       idempotent, and a release never takes it back.
--   Y7  the content fence is the LIVE post: an edited title, an edited
--       visibility and a replaced media file refuse the resume, while the
--       attempt-only runtime metadata of the same post does not.
--   Y8  the expired session: it is reopened when no video can exist, and it
--       is left for a human when the last chunk may have been written.
--   Y9  the batch claim takes the open sessions no live lease holds, and
--       leaves the leased and the closed ones alone. The claim carries the
--       token and the attempt, and no session URI.
--   Y10 the retry guard: an upload that needs manual reconciliation AND an
--       upload that already holds a receipt are neither targeted nor deleted
--       by a post retry.
--   Y11 the lease is a number of milliseconds, and the functions turn it
--       into an interval themselves.
--   Y12 the attempt fence: a session that belongs to an older attempt of the
--       post, or to a post that is no longer being processed, is not
--       carried on.
--   Y13 the reconciler's one claim surface hands out the upload sessions
--       that are due, with the token and the attempt.
--   Y14 the sweeper leaves a post with an open YouTube upload alone, so it
--       is never declared "safe to retry" while the provider may already
--       hold a video.
--   Y15 the target authorization: an account the post no longer selects is
--       refused, and the account must still be a YouTube target of the post.
--   Y16 every window after the admission is eligible: an upload whose
--       provider session was never opened, and a stored receipt whose public
--       row is still pending.
--   Y17 the terminal settlement is fenced: the worker that holds the lease
--       settles the public row and the parent, a worker that lost the lease
--       settles nothing, and a takeover leaves the old worker unable to
--       mutate anything.
--   Y18 the receipt-only projection settles the public row without a lease
--       and without touching the provider.
--   Y19 the claim limit is SHARED: a notification candidate takes a slot, so
--       the upload step only gets what is left.
--   Y20 the terminal handoff: a live lease is not taken over, a stale owner
--       settles nothing, and the receipt is handed to the owner that has to
--       settle it.
--   Y21 the continuation cap: the live lease protects the session at the cap,
--       and the dispatch that reached the cap is consumable by its own lease.
--   Y22 the exhausted session settles its public row with a reason.
--   Y23 the receipt projection does not overwrite a cancellation.
--   Y24 the fanout of a dead worker is closed by the next one.
--   Y25 a lost sibling receipt is UNKNOWN: terminal, manual and not retryable.
--   Y26 the admission refuses a snapshot the live post no longer matches, and
--       the write authority is the live state, not the lease.
--   Y27 the media sendability rule is the shared one.
--   Y28 the closure waits for the worker of the attempt to go quiet.
--   Y29 the sweeper offers no retry for an ambiguous destination.
--   Y30 the pending row of a cancelled post is closed without rolling the
--       parent, and a superseded attempt is left alone.
--   Y31 a late worker cannot make an unknown destination retryable, and the
--       settlement is idempotent.
--   Y32 the safe restart: a retried upload that never sent a byte is started
--       again, an upload that may hold a video is never retried, and an
--       inherited session keeps its fence.
--   Y33 the terminal-result recovery: the session whose worker died is
--       settled with a safe outcome, a live lease is respected, and a
--       cancelled or superseded post keeps its own outcome.
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
    (user_id, max_posts_per_day, max_posts_per_month, max_media_uploads_per_day)
  VALUES
    (v_u_a, 100, 500, 1000),
    (v_u_b, 100, 500, 1000)
  ON CONFLICT (user_id) DO UPDATE
    SET max_posts_per_day = EXCLUDED.max_posts_per_day,
        max_posts_per_month = EXCLUDED.max_posts_per_month,
        max_media_uploads_per_day = EXCLUDED.max_media_uploads_per_day;

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
-- One scenario, one post, one account, one media file.
--
-- Every scenario needs its own post and account: the session is unique per
-- post and account, so two scenarios that shared a pair would share a
-- session, and one scenario's lease would refuse the next one.
-- ---------------------------------------------------------------------------
CREATE FUNCTION pg_temp.new_youtube_fixture(p_suffix text)
RETURNS TABLE (owner_id uuid, account_id uuid, post_id uuid, media_id uuid)
LANGUAGE plpgsql
AS $$
DECLARE
  v_owner   uuid := 'b1000000-0000-4000-8000-000000000001';
  v_account uuid := gen_random_uuid();
  v_post    uuid := gen_random_uuid();
  v_media   uuid := gen_random_uuid();
BEGIN
  INSERT INTO public.social_accounts
    (id, user_id, platform, platform_user_id, platform_username, access_token, is_active)
  VALUES (v_account, v_owner, 'youtube', 'yt-' || p_suffix, p_suffix, 'token-' || p_suffix, true);

  INSERT INTO public.media_files
    (id, user_id, file_path, file_type, file_size, mime_type, storage_bucket)
  VALUES (v_media, v_owner, 'uploads/' || p_suffix || '.mp4', 'video', 4096, 'video/mp4', 'media');

  INSERT INTO public.posts
    (id, user_id, caption, platforms, media_file_ids, status, processing_started_at, metadata)
  VALUES (v_post, v_owner, 'A video', ARRAY['youtube'], ARRAY[v_media], 'processing', now(),
    jsonb_build_object('selected_account_ids', jsonb_build_array(v_account::text)));

  RETURN QUERY SELECT v_owner, v_account, v_post, v_media;
END
$$;

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
      'public.admit_youtube_upload(uuid,uuid,uuid,uuid,bigint,bigint,jsonb,timestamptz,uuid[],timestamptz,jsonb)', 'EXECUTE'),
    'Y1 anon may not admit an upload';
  ASSERT NOT has_function_privilege('authenticated',
      'public.admit_youtube_upload(uuid,uuid,uuid,uuid,bigint,bigint,jsonb,timestamptz,uuid[],timestamptz,jsonb)', 'EXECUTE'),
    'Y1 authenticated may not admit an upload';
  ASSERT NOT has_function_privilege('authenticated',
      'public.checkpoint_youtube_upload_session(uuid,uuid,bigint,bigint,text,boolean,timestamptz,text)', 'EXECUTE'),
    'Y1 authenticated may not checkpoint a session';
  ASSERT NOT has_function_privilege('authenticated',
      'public.complete_youtube_upload_session(uuid,uuid,text)', 'EXECUTE'),
    'Y1 authenticated may not complete a session';
  ASSERT NOT has_function_privilege('authenticated',
      'public.settle_youtube_upload_session(uuid,uuid,text,text,text,jsonb)', 'EXECUTE'),
    'Y1 authenticated may not settle an upload';
  ASSERT NOT has_function_privilege('authenticated',
      'public.project_youtube_upload_receipt(uuid)', 'EXECUTE'),
    'Y1 authenticated may not project a receipt';
  ASSERT NOT has_function_privilege('authenticated',
      'public.claim_youtube_upload_sessions(integer,bigint,integer)', 'EXECUTE'),
    'Y1 authenticated may not take the sessions of a later worker';
  ASSERT NOT has_function_privilege('anon',
      'public.recover_youtube_upload_terminal_results(integer)', 'EXECUTE'),
    'Y1 anon may not recover a terminal session';
  ASSERT NOT has_function_privilege('authenticated',
      'public.recover_youtube_upload_terminal_results(integer)', 'EXECUTE'),
    'Y1 authenticated may not recover a terminal session';
  ASSERT NOT has_function_privilege('anon',
      'public.youtube_upload_terminal_outcome(text,boolean)', 'EXECUTE'),
    'Y1 anon may not read the terminal outcome';
  ASSERT NOT has_function_privilege('authenticated',
      'public.youtube_upload_terminal_outcome(text,boolean)', 'EXECUTE'),
    'Y1 authenticated may not read the terminal outcome';

  ASSERT has_function_privilege('service_role',
      'public.admit_youtube_upload(uuid,uuid,uuid,uuid,bigint,bigint,jsonb,timestamptz,uuid[],timestamptz,jsonb)', 'EXECUTE'),
    'Y1 the service role may admit an upload';
  ASSERT has_function_privilege('service_role',
      'public.checkpoint_youtube_upload_session(uuid,uuid,bigint,bigint,text,boolean,timestamptz,text)', 'EXECUTE'),
    'Y1 the service role may checkpoint a session';
  ASSERT has_function_privilege('service_role',
      'public.settle_youtube_upload_session(uuid,uuid,text,text,text,jsonb)', 'EXECUTE'),
    'Y1 the service role may settle an upload';
  ASSERT has_function_privilege('service_role',
      'public.project_youtube_upload_receipt(uuid)', 'EXECUTE'),
    'Y1 the service role may project a receipt';
  ASSERT has_function_privilege('service_role',
      'public.claim_youtube_upload_sessions(integer,bigint,integer)', 'EXECUTE'),
    'Y1 the service role may take the sessions of a later worker';
  ASSERT has_function_privilege('service_role',
      'public.recover_youtube_upload_terminal_results(integer)', 'EXECUTE'),
    'Y1 the service role may recover a terminal session';
  ASSERT has_function_privilege('service_role',
      'public.youtube_upload_terminal_outcome(text,boolean)', 'EXECUTE'),
    'Y1 the service role may read the terminal outcome';

  RAISE NOTICE 'PASS Y1: the session table and its functions are service role only';
END
$y1_grants$;

-- ---------------------------------------------------------------------------
-- Y2: the owner boundary.
-- ---------------------------------------------------------------------------
DO $y2_owner$
DECLARE
  v_acct_a  uuid;
  v_post_a  uuid;
  v_media_a uuid;
  v_u_a     uuid := 'b1000000-0000-4000-8000-000000000001';
  v_u_b     uuid := 'b1000000-0000-4000-8000-000000000002';
  v_acct_b  uuid := 'b2000000-0000-4000-8000-000000000002';
  v_media_b uuid := 'b4000000-0000-4000-8000-000000000002';
  v_count   integer;
BEGIN
  -- This scenario owns its post, its account and its media file.
  SELECT f.account_id, f.post_id, f.media_id
    INTO v_acct_a, v_post_a, v_media_a
    FROM pg_temp.new_youtube_fixture('y2') f;
  -- A post that is not the caller's.
  BEGIN
    PERFORM public.admit_youtube_upload(v_post_a, v_acct_a, v_u_b, v_media_a, 4096, 4096, '{}'::jsonb);
    RAISE EXCEPTION 'Y2 a post that is not the owner''s was admitted';
  EXCEPTION WHEN SQLSTATE 'YUS01' THEN
    RAISE NOTICE 'PASS Y2: a post that is not the owner''s is refused';
  END;

  -- An account that is not the caller's.
  BEGIN
    PERFORM public.admit_youtube_upload(v_post_a, v_acct_b, v_u_a, v_media_a, 4096, 4096, '{}'::jsonb);
    RAISE EXCEPTION 'Y2 an account that is not the owner''s was admitted';
  EXCEPTION WHEN SQLSTATE 'YUS02' THEN
    RAISE NOTICE 'PASS Y2: an account that is not the owner''s is refused';
  END;

  -- A media file that is not the caller's.
  BEGIN
    PERFORM public.admit_youtube_upload(v_post_a, v_acct_a, v_u_a, v_media_b, 4096, 4096, '{}'::jsonb);
    RAISE EXCEPTION 'Y2 a media file that is not the owner''s was admitted';
  EXCEPTION WHEN SQLSTATE 'YUS03' THEN
    RAISE NOTICE 'PASS Y2: a media file that is not the owner''s is refused';
  END;

  -- An account that is not usable.
  UPDATE public.social_accounts SET is_active = false WHERE id = v_acct_a;
  BEGIN
    PERFORM public.admit_youtube_upload(v_post_a, v_acct_a, v_u_a, v_media_a, 4096, 4096, '{}'::jsonb);
    RAISE EXCEPTION 'Y2 an unusable account was admitted';
  EXCEPTION WHEN SQLSTATE 'YUS02' THEN
    RAISE NOTICE 'PASS Y2: an unusable account is refused';
  END;
  UPDATE public.social_accounts SET is_active = true WHERE id = v_acct_a;

  -- A refused call leaves nothing behind: no session and no public row.
  SELECT count(*) INTO v_count FROM public.youtube_upload_sessions WHERE post_id = v_post_a;
  ASSERT v_count = 0, 'Y2 a refused admission creates no session';
  SELECT count(*) INTO v_count FROM public.platform_posts WHERE post_id = v_post_a;
  ASSERT v_count = 0, 'Y2 a refused admission creates no public row';
  RAISE NOTICE 'PASS Y2: a refused admission leaves no session and no public row';
END
$y2_owner$;

-- ---------------------------------------------------------------------------
-- Y3: the admission is atomic.
-- ---------------------------------------------------------------------------
DO $y3_atomic$
DECLARE
  v_acct_a  uuid;
  v_post_a  uuid;
  v_media_a uuid;
  v_u_a       uuid := 'b1000000-0000-4000-8000-000000000001';
  v_admitted  jsonb;
  v_again     jsonb;
  v_row_id    uuid;
  v_session_id uuid;
BEGIN
  -- This scenario owns its post, its account and its media file.
  SELECT f.account_id, f.post_id, f.media_id
    INTO v_acct_a, v_post_a, v_media_a
    FROM pg_temp.new_youtube_fixture('y3') f;
  v_admitted := public.admit_youtube_upload(
    v_post_a, v_acct_a, v_u_a, v_media_a, 4096, 4096,
    '{"snippet":{"title":"A video"}}'::jsonb,
    NULL, ARRAY[v_acct_a]);

  v_session_id := (v_admitted -> 'session' ->> 'id')::uuid;
  v_row_id := (v_admitted ->> 'platform_post_id')::uuid;

  ASSERT v_session_id IS NOT NULL, 'Y3 the admission creates a session';
  ASSERT v_row_id IS NOT NULL, 'Y3 the admission creates the public row in the same call';

  -- The public row exists and is PENDING: that is what the sweeper respects.
  ASSERT (SELECT status FROM public.platform_posts WHERE id = v_row_id) = 'pending',
    'Y3 the public row the admission created is pending';
  ASSERT (SELECT social_account_id FROM public.platform_posts WHERE id = v_row_id) = v_acct_a,
    'Y3 the public row belongs to the account';
  ASSERT (SELECT platform FROM public.platform_posts WHERE id = v_row_id) = 'youtube',
    'Y3 the public row is a YouTube row';

  -- The session points at the public row.
  ASSERT (SELECT platform_post_id FROM public.youtube_upload_sessions WHERE id = v_session_id) = v_row_id,
    'Y3 the session points at the public row';

  -- The resolved targets are kept.
  ASSERT (SELECT target_account_ids FROM public.youtube_upload_sessions WHERE id = v_session_id)
      = ARRAY[v_acct_a],
    'Y3 the session keeps the resolved targets';

  -- Admitting the same pair again returns the same session AND the same row.
  v_again := public.admit_youtube_upload(
    v_post_a, v_acct_a, v_u_a, v_media_a, 4096, 4096,
    '{"snippet":{"title":"A video"}}'::jsonb,
    NULL, ARRAY[v_acct_a]);
  ASSERT (v_again -> 'session' ->> 'id')::uuid = v_session_id,
    'Y3 one upload per post and account';
  ASSERT (v_again ->> 'platform_post_id')::uuid = v_row_id,
    'Y3 the second admission reuses the public row';
  ASSERT (SELECT count(*) FROM public.platform_posts WHERE post_id = v_post_a) = 1,
    'Y3 the account never ends up with two public rows';

  RAISE NOTICE 'PASS Y3: the admission creates the session and the public pending row together';
END
$y3_atomic$;

-- ---------------------------------------------------------------------------
-- Y4: the lease.
-- ---------------------------------------------------------------------------
DO $y4_lease$
DECLARE
  v_acct_a  uuid;
  v_post_a  uuid;
  v_media_a uuid;
  v_u_a       uuid := 'b1000000-0000-4000-8000-000000000001';
  v_session   uuid;
  v_lease_a   uuid := 'c1000000-0000-4000-8000-000000000001';
  v_lease_b   uuid := 'c1000000-0000-4000-8000-000000000002';
  v_stale     uuid := 'c1000000-0000-4000-8000-000000000003';
  v_claimed   jsonb;
BEGIN
  -- This scenario owns its post, its account and its media file.
  SELECT f.account_id, f.post_id, f.media_id
    INTO v_acct_a, v_post_a, v_media_a
    FROM pg_temp.new_youtube_fixture('y4') f;
  v_session := (public.admit_youtube_upload(
      v_post_a, v_acct_a, v_u_a, v_media_a, 4096, 4096, '{}'::jsonb)
    -> 'session' ->> 'id')::uuid;

  -- The first worker takes it.
  v_claimed := public.claim_youtube_upload_session(v_session, v_lease_a, 180000);
  ASSERT (v_claimed ->> 'id')::uuid = v_session, 'Y4 the worker holds the session';

  -- A second worker is refused while the lease is live.
  BEGIN
    PERFORM public.claim_youtube_upload_session(v_session, v_lease_b, 180000);
    RAISE EXCEPTION 'Y4 a second worker took a live session';
  EXCEPTION WHEN SQLSTATE 'YUS07' THEN
    RAISE NOTICE 'PASS Y4: a second worker is refused while the lease is live';
  END;

  -- A stale lease cannot write, checkpoint, complete, release or settle.
  UPDATE public.youtube_upload_sessions
     SET lease_expires_at = now() - interval '1 second'
   WHERE id = v_session;

  BEGIN
    PERFORM public.checkpoint_youtube_upload_session(v_session, v_stale, 10, 10, NULL, NULL, NULL, NULL);
    RAISE EXCEPTION 'Y4 a stale worker checkpointed';
  EXCEPTION WHEN SQLSTATE 'YUS09' THEN
    RAISE NOTICE 'PASS Y4: a stale lease cannot checkpoint';
  END;

  BEGIN
    PERFORM public.complete_youtube_upload_session(v_session, v_stale, 'video-stale');
    RAISE EXCEPTION 'Y4 a stale worker completed';
  EXCEPTION WHEN SQLSTATE 'YUS09' THEN
    RAISE NOTICE 'PASS Y4: a stale lease cannot complete';
  END;

  BEGIN
    PERFORM public.release_youtube_upload_session(v_session, v_stale, 'failed', 'stale');
    RAISE EXCEPTION 'Y4 a stale worker released';
  EXCEPTION WHEN SQLSTATE 'YUS09' THEN
    RAISE NOTICE 'PASS Y4: a stale lease cannot release';
  END;

  BEGIN
    PERFORM public.settle_youtube_upload_session(v_session, v_stale, 'failed', NULL, 'stale', '{}'::jsonb);
    RAISE EXCEPTION 'Y4 a stale worker settled';
  EXCEPTION WHEN SQLSTATE 'YUS09' THEN
    RAISE NOTICE 'PASS Y4: a stale lease cannot settle';
  END;

  ASSERT (SELECT status FROM public.platform_posts
           WHERE post_id = v_post_a AND social_account_id = v_acct_a) = 'pending',
    'Y4 a stale worker settles nothing';

  RAISE NOTICE 'PASS Y4: one session has one owner';
END
$y4_lease$;

-- ---------------------------------------------------------------------------
-- Y5: the offsets only grow, and the uncertainty is sticky.
-- ---------------------------------------------------------------------------
DO $y5_offsets$
DECLARE
  v_acct_a  uuid;
  v_post_a  uuid;
  v_media_a uuid;
  v_u_a       uuid := 'b1000000-0000-4000-8000-000000000001';
  v_session   uuid;
  v_lease     uuid := 'c2000000-0000-4000-8000-000000000001';
BEGIN
  -- This scenario owns its post, its account and its media file.
  SELECT f.account_id, f.post_id, f.media_id
    INTO v_acct_a, v_post_a, v_media_a
    FROM pg_temp.new_youtube_fixture('y5') f;
  v_session := (public.admit_youtube_upload(
      v_post_a, v_acct_a, v_u_a, v_media_a, 4096, 4096, '{}'::jsonb)
    -> 'session' ->> 'id')::uuid;
  PERFORM public.claim_youtube_upload_session(v_session, v_lease, 180000);

  PERFORM public.checkpoint_youtube_upload_session(v_session, v_lease, 1000, 1000,
    'https://upload.example.invalid/session/one', false, NULL, 'resumable');
  ASSERT (SELECT confirmed_bytes FROM public.youtube_upload_sessions WHERE id = v_session) = 1000,
    'Y5 the confirmed offset is recorded';
  ASSERT (SELECT session_uri FROM public.youtube_upload_sessions WHERE id = v_session)
      = 'https://upload.example.invalid/session/one',
    'Y5 the session URI is recorded';

  -- A smaller offset does not walk it back.
  PERFORM public.checkpoint_youtube_upload_session(v_session, v_lease, 500, 500, NULL, NULL, NULL, NULL);
  ASSERT (SELECT confirmed_bytes FROM public.youtube_upload_sessions WHERE id = v_session) = 1000,
    'Y5 the confirmed offset only grows';
  ASSERT (SELECT bytes_sent FROM public.youtube_upload_sessions WHERE id = v_session) = 1000,
    'Y5 the written offset only grows';

  -- The uncertainty is STICKY: a checkpoint that says "no video yet" cannot
  -- clear a record that says the last chunk may have been written.
  PERFORM public.checkpoint_youtube_upload_session(v_session, v_lease, 4096, 4096, NULL, true, NULL, 'resumable');
  ASSERT (SELECT video_may_exist FROM public.youtube_upload_sessions WHERE id = v_session),
    'Y5 the uncertainty is recorded';
  PERFORM public.checkpoint_youtube_upload_session(v_session, v_lease, 4096, 4096, NULL, false, NULL, 'resumable');
  ASSERT (SELECT video_may_exist FROM public.youtube_upload_sessions WHERE id = v_session),
    'Y5 a checkpoint never clears the uncertainty that a video may exist';

  RAISE NOTICE 'PASS Y5: the offsets only grow and the uncertainty is sticky';
END
$y5_offsets$;

-- ---------------------------------------------------------------------------
-- Y6: the receipt.
-- ---------------------------------------------------------------------------
DO $y6_receipt$
DECLARE
  v_acct_a  uuid;
  v_post_a  uuid;
  v_media_a uuid;
  v_u_a       uuid := 'b1000000-0000-4000-8000-000000000001';
  v_session   uuid;
  v_lease     uuid := 'c3000000-0000-4000-8000-000000000001';
  v_video     text := 'yt-video-fixture-1';
BEGIN
  -- This scenario owns its post, its account and its media file.
  SELECT f.account_id, f.post_id, f.media_id
    INTO v_acct_a, v_post_a, v_media_a
    FROM pg_temp.new_youtube_fixture('y6') f;
  v_session := (public.admit_youtube_upload(
      v_post_a, v_acct_a, v_u_a, v_media_a, 4096, 4096, '{}'::jsonb)
    -> 'session' ->> 'id')::uuid;
  PERFORM public.claim_youtube_upload_session(v_session, v_lease, 180000);
  PERFORM public.checkpoint_youtube_upload_session(v_session, v_lease, 100, 100,
    'https://upload.example.invalid/session/two', false, NULL, NULL);

  PERFORM public.complete_youtube_upload_session(v_session, v_lease, v_video);
  ASSERT (SELECT state FROM public.youtube_upload_sessions WHERE id = v_session) = 'uploaded',
    'Y6 the session holds the receipt';
  ASSERT (SELECT video_id FROM public.youtube_upload_sessions WHERE id = v_session) = v_video,
    'Y6 the receipt is the video id';
  ASSERT (SELECT session_uri FROM public.youtube_upload_sessions WHERE id = v_session) IS NULL,
    'Y6 the session URI is dropped with the receipt';

  -- It is idempotent for the same video id.
  PERFORM public.complete_youtube_upload_session(v_session, v_lease, v_video);
  ASSERT (SELECT video_id FROM public.youtube_upload_sessions WHERE id = v_session) = v_video,
    'Y6 the same receipt is kept';

  -- A release never takes it back.
  PERFORM public.claim_youtube_upload_session(v_session, v_lease, 180000);
  PERFORM public.release_youtube_upload_session(v_session, v_lease, 'failed', 'no');
  ASSERT (SELECT state FROM public.youtube_upload_sessions WHERE id = v_session) = 'uploaded',
    'Y6 a release never takes a receipt back';

  RAISE NOTICE 'PASS Y6: the receipt is kept, idempotent, and never taken back';
END
$y6_receipt$;

-- ---------------------------------------------------------------------------
-- Y7: the content fence is the LIVE post.
-- ---------------------------------------------------------------------------
DO $y7_fence$
DECLARE
  v_acct_a  uuid;
  v_post_a  uuid;
  v_media_a uuid;
  v_u_a       uuid := 'b1000000-0000-4000-8000-000000000001';
  v_session   uuid;
  v_lease     uuid := 'c4000000-0000-4000-8000-000000000001';
  v_saved_meta jsonb;
BEGIN
  -- This scenario owns its post, its account and its media file.
  SELECT f.account_id, f.post_id, f.media_id
    INTO v_acct_a, v_post_a, v_media_a
    FROM pg_temp.new_youtube_fixture('y7') f;
  v_session := (public.admit_youtube_upload(
      v_post_a, v_acct_a, v_u_a, v_media_a, 4096, 4096, '{}'::jsonb)
    -> 'session' ->> 'id')::uuid;
  PERFORM public.claim_youtube_upload_session(v_session, v_lease, 180000);
  PERFORM public.checkpoint_youtube_upload_session(v_session, v_lease, 10, 10,
    'https://upload.example.invalid/session/three', false, NULL, NULL);

  -- The attempt-only runtime metadata does NOT refuse: a sibling publisher
  -- may write it while the upload is in flight.
  UPDATE public.posts
     SET metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
           'attempt_started_at', now(),
           'attempt_scope', 'fanout',
           'settlement_rollup_at', now(),
           'final_notification_intent', jsonb_build_object('status', 'processing')
         )
   WHERE id = v_post_a;
  PERFORM public.claim_youtube_upload_session(v_session, v_lease, 180000);
  RAISE NOTICE 'PASS Y7: the attempt-only runtime metadata does not refuse the resume';

  -- A changed TITLE does refuse.
  SELECT metadata INTO v_saved_meta FROM public.posts WHERE id = v_post_a;
  UPDATE public.posts
     SET metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('youtube_title', 'A different title')
   WHERE id = v_post_a;
  BEGIN
    PERFORM public.claim_youtube_upload_session(v_session, v_lease, 180000);
    RAISE EXCEPTION 'Y7 a changed title did not refuse the resume';
  EXCEPTION WHEN SQLSTATE 'YUS04' THEN
    RAISE NOTICE 'PASS Y7: a changed title refuses the resume';
  END;
  UPDATE public.posts SET metadata = v_saved_meta WHERE id = v_post_a;

  -- A changed VISIBILITY does refuse.
  UPDATE public.posts
     SET metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('youtube_visibility', 'public')
   WHERE id = v_post_a;
  BEGIN
    PERFORM public.claim_youtube_upload_session(v_session, v_lease, 180000);
    RAISE EXCEPTION 'Y7 a changed visibility did not refuse the resume';
  EXCEPTION WHEN SQLSTATE 'YUS04' THEN
    RAISE NOTICE 'PASS Y7: a changed visibility refuses the resume';
  END;
  UPDATE public.posts SET metadata = v_saved_meta WHERE id = v_post_a;

  -- A changed CAPTION does refuse.
  UPDATE public.posts SET caption = 'A different caption' WHERE id = v_post_a;
  BEGIN
    PERFORM public.claim_youtube_upload_session(v_session, v_lease, 180000);
    RAISE EXCEPTION 'Y7 a changed caption did not refuse the resume';
  EXCEPTION WHEN SQLSTATE 'YUS04' THEN
    RAISE NOTICE 'PASS Y7: a changed caption refuses the resume';
  END;
  UPDATE public.posts SET caption = 'A video' WHERE id = v_post_a;

  -- A REPLACED media file does refuse.
  UPDATE public.media_files SET current_object_version = 2 WHERE id = v_media_a;
  BEGIN
    PERFORM public.claim_youtube_upload_session(v_session, v_lease, 180000);
    RAISE EXCEPTION 'Y7 a replaced media file did not refuse the resume';
  EXCEPTION WHEN SQLSTATE 'YUS04' THEN
    RAISE NOTICE 'PASS Y7: a replaced media file refuses the resume';
  END;
  UPDATE public.media_files SET current_object_version = 1 WHERE id = v_media_a;

  -- The unchanged post is still carried on.
  PERFORM public.claim_youtube_upload_session(v_session, v_lease, 180000);
  RAISE NOTICE 'PASS Y7: the unchanged post is carried on';

  RAISE NOTICE 'PASS Y7: the content fence is the live post';
END
$y7_fence$;

-- ---------------------------------------------------------------------------
-- Y8: the expired session.
-- ---------------------------------------------------------------------------
DO $y8_expired$
DECLARE
  v_acct_a  uuid;
  v_post_a  uuid;
  v_media_a uuid;
  v_u_a       uuid := 'b1000000-0000-4000-8000-000000000001';
  v_session   uuid;
  v_lease     uuid := 'c5000000-0000-4000-8000-000000000001';
  v_admitted  jsonb;
BEGIN
  -- This scenario owns its post, its account and its media file.
  SELECT f.account_id, f.post_id, f.media_id
    INTO v_acct_a, v_post_a, v_media_a
    FROM pg_temp.new_youtube_fixture('y8') f;
  -- No byte ever reached the provider: the session is admitted again.
  -- The provider session was opened, but no chunk was written to it.
  v_session := (public.admit_youtube_upload(
      v_post_a, v_acct_a, v_u_a, v_media_a, 4096, 4096, '{}'::jsonb)
    -> 'session' ->> 'id')::uuid;
  PERFORM public.claim_youtube_upload_session(v_session, v_lease, 180000);
  PERFORM public.checkpoint_youtube_upload_session(v_session, v_lease, 0, 0,
    'https://upload.example.invalid/session/four', false, NULL, NULL);
  UPDATE public.youtube_upload_sessions
     SET session_expires_at = now() - interval '1 minute'
   WHERE id = v_session;

  v_admitted := public.admit_youtube_upload(v_post_a, v_acct_a, v_u_a, v_media_a, 4096, 4096, '{}'::jsonb);
  ASSERT (v_admitted -> 'session' ->> 'state') = 'open',
    'Y8 an expired session that never wrote a byte is admitted again';
  ASSERT (v_admitted -> 'session' ->> 'session_uri') IS NULL,
    'Y8 the admitted again session has no provider session';
  ASSERT (v_admitted -> 'session' ->> 'confirmed_bytes')::bigint = 0,
    'Y8 the admitted again session starts from the beginning';

  -- A byte reached the provider: only a human may decide.
  PERFORM public.claim_youtube_upload_session(v_session, v_lease, 180000);
  PERFORM public.checkpoint_youtube_upload_session(v_session, v_lease, 4096, 4096,
    'https://upload.example.invalid/session/five', true, NULL, NULL);
  UPDATE public.youtube_upload_sessions
     SET session_expires_at = now() - interval '1 minute'
   WHERE id = v_session;

  v_admitted := public.admit_youtube_upload(v_post_a, v_acct_a, v_u_a, v_media_a, 4096, 4096, '{}'::jsonb);
  ASSERT (v_admitted -> 'session' ->> 'state') = 'reconcile',
    'Y8 an expired session that wrote a byte is left for a human';
  ASSERT (v_admitted -> 'session' ->> 'session_uri') IS NOT NULL,
    'Y8 the session that needs a human keeps its provider session';

  RAISE NOTICE 'PASS Y8: an expired session is reopened only when no video can exist';
END
$y8_expired$;

-- ---------------------------------------------------------------------------
-- Y9: the batch claim.
-- ---------------------------------------------------------------------------
DO $y9_batch$
DECLARE
  v_acct_a  uuid;
  v_post_a  uuid;
  v_media_a uuid;
  v_u_a       uuid := 'b1000000-0000-4000-8000-000000000001';
  v_session   uuid;
  v_lease     uuid := 'c6000000-0000-4000-8000-000000000001';
  v_named     integer;
  v_token     integer;
  v_attempt   integer;
BEGIN
  -- This scenario owns its post, its account and its media file.
  SELECT f.account_id, f.post_id, f.media_id
    INTO v_acct_a, v_post_a, v_media_a
    FROM pg_temp.new_youtube_fixture('y9') f;
  v_session := (public.admit_youtube_upload(
      v_post_a, v_acct_a, v_u_a, v_media_a, 4096, 4096, '{}'::jsonb)
    -> 'session' ->> 'id')::uuid;
  PERFORM public.claim_youtube_upload_session(v_session, v_lease, 180000);
  PERFORM public.checkpoint_youtube_upload_session(v_session, v_lease, 100, 100,
    'https://upload.example.invalid/session/six', false, NULL, NULL);

  -- The lease is live: the session is not taken away from the worker.
  ASSERT (SELECT count(*) FROM public.claim_youtube_upload_sessions(5, 180000, 24)
           WHERE session_id = v_session) = 0,
    'Y9 a session with a live lease is not handed out';

  -- The lease is gone and the session is due: it is handed out with a token.
  --
  -- ONE claim pass: the claim takes the work, so it is asked once and every
  -- property is read out of the same answer.
  UPDATE public.youtube_upload_sessions
     SET lease_expires_at = now() - interval '1 second'
   WHERE id = v_session;
  SELECT
    count(*) FILTER (WHERE session_id = v_session),
    count(*) FILTER (WHERE session_id = v_session AND lease_token IS NOT NULL),
    count(*) FILTER (WHERE session_id = v_session AND attempt_started_at IS NOT NULL)
    INTO v_named, v_token, v_attempt
    FROM public.claim_youtube_upload_sessions(5, 180000, 24);
  ASSERT v_named = 1,
    'Y9 a due session with no live lease is handed out';
  ASSERT v_token = 1,
    'Y9 the claim carries the lease token';
  ASSERT v_attempt = 1,
    'Y9 the claim carries the attempt';

  -- The session URI is NOT in the claim.
  ASSERT NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'claim_youtube_upload_sessions'
       AND column_name = 'session_uri'),
    'Y9 the claim does not carry the session URI at all';

  -- A session that is not due is not handed out.
  UPDATE public.youtube_upload_sessions
     SET lease_expires_at = now() - interval '1 second',
         next_check_at = now() + interval '10 minutes'
   WHERE id = v_session;
  ASSERT (SELECT count(*) FROM public.claim_youtube_upload_sessions(5, 180000, 24)
           WHERE session_id = v_session) = 0,
    'Y9 a session that is not due is not handed out';

  RAISE NOTICE 'PASS Y9: the batch claim hands out the due sessions with a token and no URI';
END
$y9_batch$;

-- ---------------------------------------------------------------------------
-- Y10: the retry guard.
-- ---------------------------------------------------------------------------
DO $y10_retry$
DECLARE
  v_acct_a  uuid;
  v_post_a  uuid;
  v_media_a uuid;
  v_u_a       uuid := 'b1000000-0000-4000-8000-000000000001';
  v_session   uuid;
  v_lease     uuid := 'c7000000-0000-4000-8000-000000000001';
  v_answer    jsonb;
  v_row_id    uuid;
BEGIN
  -- This scenario owns its post, its account and its media file.
  SELECT f.account_id, f.post_id, f.media_id
    INTO v_acct_a, v_post_a, v_media_a
    FROM pg_temp.new_youtube_fixture('y10') f;
  v_session := (public.admit_youtube_upload(
      v_post_a, v_acct_a, v_u_a, v_media_a, 4096, 4096, '{}'::jsonb)
    -> 'session' ->> 'id')::uuid;
  v_row_id := (SELECT platform_post_id FROM public.youtube_upload_sessions WHERE id = v_session);

  -- A session that needs a human is not retried.
  UPDATE public.youtube_upload_sessions SET state = 'reconcile' WHERE id = v_session;
  UPDATE public.posts SET status = 'failed' WHERE id = v_post_a;
  UPDATE public.platform_posts SET status = 'failed' WHERE id = v_row_id;

  v_answer := public.request_post_retry(v_post_a, v_u_a, ARRAY[v_acct_a]);
  ASSERT v_answer ->> 'status' = 'refused',
    'Y10 an upload that needs a human is not retried';

  -- A session that already holds a RECEIPT is not retried either: the video
  -- exists, and a retry would put a second one on the channel.
  UPDATE public.youtube_upload_sessions
     SET state = 'uploaded', video_id = 'yt-video-fixture-2'
   WHERE id = v_session;
  UPDATE public.posts SET status = 'failed' WHERE id = v_post_a;
  UPDATE public.platform_posts SET status = 'failed' WHERE id = v_row_id;

  v_answer := public.request_post_retry(v_post_a, v_u_a, ARRAY[v_acct_a]);
  ASSERT v_answer ->> 'status' = 'refused',
    'Y10 an upload that holds a receipt is not retried';

  RAISE NOTICE 'PASS Y10: an uncertain or receipted upload is never retried blindly';
END
$y10_retry$;

-- ---------------------------------------------------------------------------
-- Y11: the lease is a number of milliseconds.
-- ---------------------------------------------------------------------------
DO $y11_lease_ms$
DECLARE
  v_acct_a  uuid;
  v_post_a  uuid;
  v_media_a uuid;
  v_u_a       uuid := 'b1000000-0000-4000-8000-000000000001';
  v_session   uuid;
  v_lease     uuid := 'c8000000-0000-4000-8000-000000000001';
  v_expires   timestamptz;
BEGIN
  -- This scenario owns its post, its account and its media file.
  SELECT f.account_id, f.post_id, f.media_id
    INTO v_acct_a, v_post_a, v_media_a
    FROM pg_temp.new_youtube_fixture('y11') f;
  v_session := (public.admit_youtube_upload(
      v_post_a, v_acct_a, v_u_a, v_media_a, 4096, 4096, '{}'::jsonb)
    -> 'session' ->> 'id')::uuid;

  -- 180000 ms is three minutes.
  PERFORM public.claim_youtube_upload_session(v_session, v_lease, 180000);
  SELECT lease_expires_at INTO v_expires FROM public.youtube_upload_sessions WHERE id = v_session;
  ASSERT v_expires BETWEEN now() + interval '2 minutes 55 seconds' AND now() + interval '3 minutes 5 seconds',
    'Y11 a lease of 180000 milliseconds is three minutes';

  -- A lease of zero is refused: an unbounded lease is not a lease.
  BEGIN
    PERFORM public.claim_youtube_upload_session(v_session, v_lease, 0);
    RAISE EXCEPTION 'Y11 a lease of zero was accepted';
  EXCEPTION WHEN SQLSTATE 'YUS09' THEN
    RAISE NOTICE 'PASS Y11: a lease of zero is refused';
  END;

  -- The batch claim takes the same shape.
  BEGIN
    PERFORM public.claim_youtube_upload_sessions(5, 0, 24);
    RAISE EXCEPTION 'Y11 a batch lease of zero was accepted';
  EXCEPTION WHEN SQLSTATE 'YUS09' THEN
    RAISE NOTICE 'PASS Y11: the batch claim refuses a lease of zero';
  END;

  RAISE NOTICE 'PASS Y11: the lease is a number of milliseconds';
END
$y11_lease_ms$;

-- ---------------------------------------------------------------------------
-- Y12: the attempt fence.
-- ---------------------------------------------------------------------------
DO $y12_attempt$
DECLARE
  v_acct_a  uuid;
  v_post_a  uuid;
  v_media_a uuid;
  v_u_a       uuid := 'b1000000-0000-4000-8000-000000000001';
  v_session   uuid;
  v_lease     uuid := 'c9000000-0000-4000-8000-000000000001';
  v_attempt   timestamptz;
BEGIN
  -- This scenario owns its post, its account and its media file.
  SELECT f.account_id, f.post_id, f.media_id
    INTO v_acct_a, v_post_a, v_media_a
    FROM pg_temp.new_youtube_fixture('y12') f;
  v_attempt := (SELECT processing_started_at FROM public.posts WHERE id = v_post_a);
  v_session := (public.admit_youtube_upload(
      v_post_a, v_acct_a, v_u_a, v_media_a, 4096, 4096, '{}'::jsonb, v_attempt)
    -> 'session' ->> 'id')::uuid;

  -- The post moved on to a newer attempt.
  UPDATE public.posts SET processing_started_at = now() + interval '1 second' WHERE id = v_post_a;
  BEGIN
    PERFORM public.claim_youtube_upload_session(v_session, v_lease, 180000);
    RAISE EXCEPTION 'Y12 an older attempt was carried on';
  EXCEPTION WHEN SQLSTATE 'YUS11' THEN
    RAISE NOTICE 'PASS Y12: a session of an older attempt is refused';
  END;
  UPDATE public.posts SET processing_started_at = v_attempt WHERE id = v_post_a;

  -- The post is no longer being processed.
  UPDATE public.posts SET status = 'failed' WHERE id = v_post_a;
  BEGIN
    PERFORM public.claim_youtube_upload_session(v_session, v_lease, 180000);
    RAISE EXCEPTION 'Y12 a settled post was carried on';
  EXCEPTION WHEN SQLSTATE 'YUS12' THEN
    RAISE NOTICE 'PASS Y12: a post that is no longer processing is refused';
  END;
  UPDATE public.posts SET status = 'processing' WHERE id = v_post_a;

  RAISE NOTICE 'PASS Y12: the attempt fence holds';
END
$y12_attempt$;

-- ---------------------------------------------------------------------------
-- Y13: the reconciler's claim surface.
-- ---------------------------------------------------------------------------
DO $y13_reconciler$
DECLARE
  v_acct_a  uuid;
  v_post_a  uuid;
  v_media_a uuid;
  v_u_a       uuid := 'b1000000-0000-4000-8000-000000000001';
  v_session   uuid;
  v_lease     uuid := 'ca000000-0000-4000-8000-000000000001';
  v_total     integer;
  v_named     integer;
  v_token     integer;
  v_attempt   integer;
  v_no_row    integer;
BEGIN
  -- This scenario owns its post, its account and its media file.
  SELECT f.account_id, f.post_id, f.media_id
    INTO v_acct_a, v_post_a, v_media_a
    FROM pg_temp.new_youtube_fixture('y13') f;
  v_session := (public.admit_youtube_upload(
      v_post_a, v_acct_a, v_u_a, v_media_a, 4096, 4096, '{}'::jsonb)
    -> 'session' ->> 'id')::uuid;
  PERFORM public.claim_youtube_upload_session(v_session, v_lease, 180000);
  PERFORM public.checkpoint_youtube_upload_session(v_session, v_lease, 100, 100,
    'https://upload.example.invalid/session/seven', false, NULL, NULL);
  UPDATE public.youtube_upload_sessions
     SET lease_expires_at = now() - interval '1 second'
   WHERE id = v_session;
  -- ONE claim pass: the claim takes the work, so it is asked once and every
  -- property is read out of the same answer.
  SELECT
    count(*) FILTER (WHERE kind = 'youtube_upload_continuation' AND candidate_id = v_session),
    count(*) FILTER (WHERE kind = 'youtube_upload_continuation' AND candidate_id = v_session),
    count(*) FILTER (WHERE kind = 'youtube_upload_continuation' AND candidate_id = v_session AND claim_id IS NOT NULL),
    count(*) FILTER (WHERE kind = 'youtube_upload_continuation' AND candidate_id = v_session AND attempt_started_at IS NOT NULL),
    count(*) FILTER (WHERE kind = 'youtube_upload_continuation' AND candidate_id = v_session AND platform_post_id IS NULL)
    INTO v_total, v_named, v_token, v_attempt, v_no_row
    FROM public.claim_post_completion_work(5, interval '3 minutes');
  ASSERT v_total = 1,
    'Y13 the reconciler hands out the upload continuation';
  ASSERT v_named = 1,
    'Y13 the continuation names the session';
  ASSERT v_token = 1,
    'Y13 the continuation carries the claim token';
  ASSERT v_attempt = 1,
    'Y13 the continuation carries the attempt';
  ASSERT v_no_row = 1,
    'Y13 the continuation carries no public row id';

  RAISE NOTICE 'PASS Y13: the reconciler claim carries the upload continuation';
END
$y13_reconciler$;

-- ---------------------------------------------------------------------------
-- Y14: the sweeper leaves an open upload alone.
-- ---------------------------------------------------------------------------
DO $y14_sweeper$
DECLARE
  v_acct_a  uuid;
  v_post_a  uuid;
  v_media_a uuid;
  v_u_a       uuid := 'b1000000-0000-4000-8000-000000000001';
  v_session   uuid;
  v_lease     uuid := 'cb000000-0000-4000-8000-000000000001';
  v_answer    jsonb;
BEGIN
  -- This scenario owns its post, its account and its media file.
  SELECT f.account_id, f.post_id, f.media_id
    INTO v_acct_a, v_post_a, v_media_a
    FROM pg_temp.new_youtube_fixture('y14') f;
  v_session := (public.admit_youtube_upload(
      v_post_a, v_acct_a, v_u_a, v_media_a, 4096, 4096, '{}'::jsonb)
    -> 'session' ->> 'id')::uuid;
  PERFORM public.claim_youtube_upload_session(v_session, v_lease, 180000);
  PERFORM public.checkpoint_youtube_upload_session(v_session, v_lease, 4096, 4096,
    'https://upload.example.invalid/session/eight', true, NULL, NULL);

  -- The post has been processing for far longer than the sweeper's window.
  UPDATE public.posts SET processing_started_at = now() - interval '1 hour' WHERE id = v_post_a;

  v_answer := public.sweep_stale_processing_posts();
  ASSERT (v_answer ->> 'posts')::integer = 0,
    'Y14 the sweeper leaves a post with an open YouTube upload alone';
  ASSERT (SELECT status FROM public.posts WHERE id = v_post_a) = 'processing',
    'Y14 the post is still processing';

  RAISE NOTICE 'PASS Y14: the sweeper leaves an open YouTube upload alone';
END
$y14_sweeper$;

-- ---------------------------------------------------------------------------
-- Y15: the target authorization.
-- ---------------------------------------------------------------------------
DO $y15_target$
DECLARE
  v_acct_a  uuid;
  v_post_a  uuid;
  v_media_a uuid;
  v_u_a       uuid := 'b1000000-0000-4000-8000-000000000001';
  v_session   uuid;
  v_lease     uuid := 'cc000000-0000-4000-8000-000000000001';
BEGIN
  -- This scenario owns its post, its account and its media file.
  SELECT f.account_id, f.post_id, f.media_id
    INTO v_acct_a, v_post_a, v_media_a
    FROM pg_temp.new_youtube_fixture('y15') f;
  v_session := (public.admit_youtube_upload(
      v_post_a, v_acct_a, v_u_a, v_media_a, 4096, 4096, '{}'::jsonb)
    -> 'session' ->> 'id')::uuid;

  -- The post selects the account: the upload is carried on.
  UPDATE public.posts
     SET metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
           'selected_account_ids', jsonb_build_array(v_acct_a::text))
   WHERE id = v_post_a;
  PERFORM public.claim_youtube_upload_session(v_session, v_lease, 180000);
  RAISE NOTICE 'PASS Y15: a selected account is carried on';

  -- The customer took the account out of the post: the upload is refused.
  UPDATE public.posts
     SET metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
           'selected_account_ids', jsonb_build_array('00000000-0000-4000-8000-000000000000'::text))
   WHERE id = v_post_a;
  BEGIN
    PERFORM public.claim_youtube_upload_session(v_session, v_lease, 180000);
    RAISE EXCEPTION 'Y15 an account the post no longer selects was carried on';
  EXCEPTION WHEN SQLSTATE 'YUS15' THEN
    RAISE NOTICE 'PASS Y15: an account the post no longer selects is refused';
  END;

  -- The post no longer publishes to YouTube at all.
  UPDATE public.posts SET platforms = ARRAY['instagram'] WHERE id = v_post_a;
  BEGIN
    PERFORM public.claim_youtube_upload_session(v_session, v_lease, 180000);
    RAISE EXCEPTION 'Y15 an upload to a platform the post dropped was carried on';
  EXCEPTION WHEN SQLSTATE 'YUS15' THEN
    RAISE NOTICE 'PASS Y15: a post that no longer publishes to YouTube refuses the upload';
  END;

  RAISE NOTICE 'PASS Y15: only an authorized YouTube target is carried on';
END
$y15_target$;

-- ---------------------------------------------------------------------------
-- Y16: every window after the admission is eligible.
-- ---------------------------------------------------------------------------
DO $y16_windows$
DECLARE
  v_acct_a  uuid;
  v_post_a  uuid;
  v_media_a uuid;
  v_u_a       uuid := 'b1000000-0000-4000-8000-000000000001';
  v_session   uuid;
  v_lease     uuid := 'cd000000-0000-4000-8000-000000000001';
BEGIN
  -- This scenario owns its post, its account and its media file.
  SELECT f.account_id, f.post_id, f.media_id
    INTO v_acct_a, v_post_a, v_media_a
    FROM pg_temp.new_youtube_fixture('y16') f;
  v_session := (public.admit_youtube_upload(
      v_post_a, v_acct_a, v_u_a, v_media_a, 4096, 4096, '{}'::jsonb)
    -> 'session' ->> 'id')::uuid;

  -- The provider session was never opened and no byte was written: the
  -- session is handed out, because no video can exist.
  ASSERT (SELECT count(*) FROM public.claim_youtube_upload_sessions(5, 180000, 24)
           WHERE session_id = v_session) = 1,
    'Y16 an upload whose provider session was never opened is handed out';

  -- The receipt exists and the public row is still pending: the receipt is
  -- handed out so it can be projected.
  UPDATE public.youtube_upload_sessions
     SET state = 'uploaded', video_id = 'yt-video-fixture-3',
         confirmed_bytes = total_bytes, bytes_sent = total_bytes,
         lease_token = NULL, lease_expires_at = NULL
   WHERE id = v_session;
  ASSERT (SELECT count(*) FROM public.claim_youtube_upload_sessions(5, 180000, 24)
           WHERE session_id = v_session) = 1,
    'Y16 a stored receipt whose public row is pending is handed out';

  -- The public row is already settled: there is nothing to project, so the
  -- session is not handed out again.
  UPDATE public.platform_posts
     SET status = 'success', platform_post_id = 'yt-video-fixture-3'
   WHERE post_id = v_post_a AND social_account_id = v_acct_a;
  ASSERT (SELECT count(*) FROM public.claim_youtube_upload_sessions(5, 180000, 24)
           WHERE session_id = v_session) = 0,
    'Y16 a receipt whose public row is already settled is not handed out';

  RAISE NOTICE 'PASS Y16: every window after the admission has a recovery path';
END
$y16_windows$;

-- ---------------------------------------------------------------------------
-- Y17: the terminal settlement is fenced.
-- ---------------------------------------------------------------------------
DO $y17_settle$
DECLARE
  v_acct_a  uuid;
  v_post_a  uuid;
  v_media_a uuid;
  v_u_a       uuid := 'b1000000-0000-4000-8000-000000000001';
  v_session   uuid;
  v_lease_a   uuid := 'ce000000-0000-4000-8000-000000000001';
  v_lease_b   uuid := 'ce000000-0000-4000-8000-000000000002';
  v_row_id    uuid;
  v_settled   jsonb;
BEGIN
  -- This scenario owns its post, its account and its media file.
  SELECT f.account_id, f.post_id, f.media_id
    INTO v_acct_a, v_post_a, v_media_a
    FROM pg_temp.new_youtube_fixture('y17') f;
  v_session := (public.admit_youtube_upload(
      v_post_a, v_acct_a, v_u_a, v_media_a, 4096, 4096, '{}'::jsonb)
    -> 'session' ->> 'id')::uuid;
  v_row_id := (SELECT platform_post_id FROM public.youtube_upload_sessions WHERE id = v_session);

  PERFORM public.claim_youtube_upload_session(v_session, v_lease_a, 180000);

  -- The lease expires and another worker takes over.
  UPDATE public.youtube_upload_sessions SET lease_expires_at = now() - interval '1 second' WHERE id = v_session;
  PERFORM public.claim_youtube_upload_session(v_session, v_lease_b, 180000);

  -- The old worker cannot settle anything.
  BEGIN
    PERFORM public.settle_youtube_upload_session(v_session, v_lease_a, 'success', 'yt-video-old', NULL, '{}'::jsonb);
    RAISE EXCEPTION 'Y17 the old worker settled the row';
  EXCEPTION WHEN SQLSTATE 'YUS09' THEN
    RAISE NOTICE 'PASS Y17: a worker that lost the lease settles nothing';
  END;
  ASSERT (SELECT status FROM public.platform_posts WHERE id = v_row_id) = 'pending',
    'Y17 the public row is untouched by the old worker';

  -- The new owner settles it.
  v_settled := public.settle_youtube_upload_session(
    v_session, v_lease_b, 'success', 'yt-video-new', NULL, '{}'::jsonb);
  ASSERT (v_settled ->> 'settled') = 'true', 'Y17 the owner settles the upload';
  ASSERT (SELECT status FROM public.platform_posts WHERE id = v_row_id) = 'success',
    'Y17 the public row is settled';
  ASSERT (SELECT platform_post_id FROM public.platform_posts WHERE id = v_row_id) = 'yt-video-new',
    'Y17 the public row holds the video id';
  ASSERT (SELECT state FROM public.youtube_upload_sessions WHERE id = v_session) = 'uploaded',
    'Y17 the session holds the receipt';
  ASSERT (SELECT video_id FROM public.youtube_upload_sessions WHERE id = v_session) = 'yt-video-new',
    'Y17 the receipt is the video id';

  -- The old worker still cannot mutate anything afterwards.
  BEGIN
    PERFORM public.settle_youtube_upload_session(v_session, v_lease_a, 'failed', NULL, 'old', '{}'::jsonb);
    RAISE EXCEPTION 'Y17 the old worker settled the row after the takeover';
  EXCEPTION WHEN SQLSTATE 'YUS09' THEN
    RAISE NOTICE 'PASS Y17: the old worker cannot mutate anything after a takeover';
  END;
  ASSERT (SELECT status FROM public.platform_posts WHERE id = v_row_id) = 'success',
    'Y17 the public row still holds the new receipt';

  RAISE NOTICE 'PASS Y17: the terminal settlement is fenced to the owner and the attempt';
END
$y17_settle$;

-- ---------------------------------------------------------------------------
-- Y18: the receipt-only projection.
-- ---------------------------------------------------------------------------
DO $y18_projection$
DECLARE
  v_acct_a  uuid;
  v_post_a  uuid;
  v_media_a uuid;
  v_u_a       uuid := 'b1000000-0000-4000-8000-000000000001';
  v_session   uuid;
  v_lease     uuid := 'cf000000-0000-4000-8000-000000000001';
  v_row_id    uuid;
  v_projected jsonb;
BEGIN
  -- This scenario owns its post, its account and its media file.
  SELECT f.account_id, f.post_id, f.media_id
    INTO v_acct_a, v_post_a, v_media_a
    FROM pg_temp.new_youtube_fixture('y18') f;
  v_session := (public.admit_youtube_upload(
      v_post_a, v_acct_a, v_u_a, v_media_a, 4096, 4096, '{}'::jsonb)
    -> 'session' ->> 'id')::uuid;
  v_row_id := (SELECT platform_post_id FROM public.youtube_upload_sessions WHERE id = v_session);

  PERFORM public.claim_youtube_upload_session(v_session, v_lease, 180000);
  PERFORM public.checkpoint_youtube_upload_session(v_session, v_lease, 4096, 4096,
    'https://upload.example.invalid/session/nine', true, NULL, NULL);
  PERFORM public.complete_youtube_upload_session(v_session, v_lease, 'yt-video-fixture-4');

  -- The acknowledgement was lost after the database had already stored the
  -- receipt: the receipt is projected onto the public row.
  v_projected := public.project_youtube_upload_receipt(v_session);
  ASSERT (v_projected ->> 'settled') = 'true', 'Y18 the receipt is projected';
  ASSERT (SELECT status FROM public.platform_posts WHERE id = v_row_id) = 'success',
    'Y18 the public row is settled by the projection';
  ASSERT (SELECT platform_post_id FROM public.platform_posts WHERE id = v_row_id) = 'yt-video-fixture-4',
    'Y18 the public row holds the video id';
  ASSERT (SELECT post_id FROM public.platform_posts WHERE id = v_row_id) = v_post_a,
    'Y18 the projection settles the row of its own post';

  -- It is idempotent: a second projection settles nothing and says so.
  v_projected := public.project_youtube_upload_receipt(v_session);
  ASSERT (v_projected ->> 'settled') = 'true' AND (v_projected ->> 'already') = 'true',
    'Y18 the projection is idempotent';

  -- A session without a receipt has nothing to project.
  BEGIN
    PERFORM public.project_youtube_upload_receipt(gen_random_uuid());
    RAISE EXCEPTION 'Y18 a session that is not there was projected';
  EXCEPTION WHEN SQLSTATE 'YUS08' THEN
    RAISE NOTICE 'PASS Y18: a session that is not there has no receipt to project';
  END;

  RAISE NOTICE 'PASS Y18: the receipt-only projection settles the public row';
END
$y18_projection$;

-- ---------------------------------------------------------------------------
-- Y19: the claim limit is shared.
-- ---------------------------------------------------------------------------
DO $y19_limit$
DECLARE
  v_acct_a  uuid;
  v_post_a  uuid;
  v_media_a uuid;
  v_u_a       uuid := 'b1000000-0000-4000-8000-000000000001';
  v_notif     uuid := 'b3000000-0000-4000-8000-000000000002';
  v_notif_acct uuid := 'b2000000-0000-4000-8000-000000000003';
  v_notif_row  uuid := 'b5000000-0000-4000-8000-000000000001';
  v_session   uuid;
  v_lease     uuid := 'd0000000-0000-4000-8000-000000000001';
  v_attempt   timestamptz := now();
  v_content   jsonb;
  v_count     integer;
  v_total     integer;
  v_notifications integer;
  v_uploads   integer;
BEGIN
  -- This scenario owns its post, its account and its media file.
  SELECT f.account_id, f.post_id, f.media_id
    INTO v_acct_a, v_post_a, v_media_a
    FROM pg_temp.new_youtube_fixture('y19') f;
  -- An upload session that is due.
  v_session := (public.admit_youtube_upload(
      v_post_a, v_acct_a, v_u_a, v_media_a, 4096, 4096, '{}'::jsonb)
    -> 'session' ->> 'id')::uuid;
  PERFORM public.claim_youtube_upload_session(v_session, v_lease, 180000);
  PERFORM public.checkpoint_youtube_upload_session(v_session, v_lease, 100, 100,
    'https://upload.example.invalid/session/ten', false, NULL, NULL);
  UPDATE public.youtube_upload_sessions
     SET lease_expires_at = now() - interval '1 second'
   WHERE id = v_session;

  -- A ready legacy notification candidate.
  INSERT INTO public.social_accounts
    (id, user_id, platform, platform_user_id, platform_username, access_token, is_active)
  VALUES (v_notif_acct, v_u_a, 'instagram', 'ig-notify', 'notify', 'token-n', true)
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.posts
    (id, user_id, caption, platforms, status, processing_started_at, source, metadata)
  VALUES (v_notif, v_u_a, 'a notification post', ARRAY['instagram'], 'processing', v_attempt, 'manual', '{}'::jsonb)
  ON CONFLICT (id) DO NOTHING;

  SELECT jsonb_build_object(
           'user_id', x.user_id, 'caption', x.caption, 'media_file_ids', x.media_file_ids,
           'metadata', public.normalize_threads_internal_metadata(x.metadata), 'platforms', x.platforms,
           'scheduled_at', x.scheduled_at, 'publish_requested_at', x.publish_requested_at, 'source', x.source)
    INTO v_content FROM public.posts x WHERE x.id = v_notif;
  PERFORM public.enroll_post_notification_recovery(v_notif, v_attempt, v_content, ARRAY[v_notif_acct], ARRAY[]::uuid[]);

  -- The attempt's own result row: the fanout closes over the rows of the
  -- attempt, so a candidate without one is never ready.
  INSERT INTO public.platform_posts
    (id, post_id, social_account_id, platform, status, created_at, response_data)
  VALUES (v_notif_row, v_notif, v_notif_acct, 'instagram', 'failed', v_attempt, '{}'::jsonb);
  PERFORM public.close_post_fanout(v_notif, v_attempt, v_content, ARRAY[v_notif_row], ARRAY[]::uuid[]);
  UPDATE public.posts
     SET metadata = jsonb_set(
           metadata, '{legacy_notification_candidate}',
           (metadata -> 'legacy_notification_candidate') || jsonb_build_object('ready', 'true'))
   WHERE id = v_notif;

  -- The limit of one: the notification candidate takes the slot, so the
  -- upload is not claimed in the same pass.
  SELECT
    count(*),
    count(*) FILTER (WHERE kind = 'notification_only' AND post_id = v_notif),
    count(*) FILTER (WHERE kind = 'youtube_upload_continuation' AND candidate_id = v_session)
    INTO v_total, v_notifications, v_uploads
    FROM public.claim_post_completion_work(1, interval '3 minutes');
  ASSERT v_total <= 1, 'Y19 the shared limit is honoured: at most one piece of work for a limit of one';
  ASSERT v_notifications = 1,
    'Y19 the notification candidate took the slot';
  ASSERT v_uploads = 0,
    'Y19 the upload only gets what is left of the limit';
  ASSERT (SELECT lease_expires_at FROM public.youtube_upload_sessions WHERE id = v_session) <= now(),
    'Y19 the upload session was not claimed behind the limit';

  -- With a limit of two, the upload gets the slot that is left.
  SELECT
    count(*),
    count(*) FILTER (WHERE kind = 'youtube_upload_continuation' AND candidate_id = v_session)
    INTO v_total, v_uploads
    FROM public.claim_post_completion_work(2, interval '3 minutes');
  ASSERT v_total <= 2, 'Y19 a limit of two hands out at most two pieces of work';
  ASSERT v_uploads = 1,
    'Y19 the upload takes the slot the notification did not';

  RAISE NOTICE 'PASS Y19: every kind draws from the same limit';
END
$y19_limit$;

-- ---------------------------------------------------------------------------
-- Y20: the terminal handoff.
--
-- The receipt is kept and the lease is kept with it: the worker that stored
-- the receipt is the one that has to settle the public row, and the
-- settlement is fenced on the lease it was given. A worker that lost the
-- lease settles nothing.
-- ---------------------------------------------------------------------------
DO $y20_handoff$
DECLARE
  v_acct_a  uuid;
  v_post_a  uuid;
  v_media_a uuid;
  v_acct_b  uuid;
  v_post_b  uuid;
  v_media_b uuid;
  v_u_a     uuid := 'b1000000-0000-4000-8000-000000000001';
  v_session uuid;
  v_session_b uuid;
  v_lease   uuid := 'e0000000-0000-4000-8000-000000000001';
  v_lease_b uuid := 'e0000000-0000-4000-8000-000000000002';
  v_row_id  uuid;
  v_settled jsonb;
BEGIN
  -- This scenario owns its post, its account and its media file.
  SELECT f.account_id, f.post_id, f.media_id
    INTO v_acct_a, v_post_a, v_media_a
    FROM pg_temp.new_youtube_fixture('y20') f;
  v_session := (public.admit_youtube_upload(
      v_post_a, v_acct_a, v_u_a, v_media_a, 4096, 4096, '{}'::jsonb)
    -> 'session' ->> 'id')::uuid;
  v_row_id := (SELECT platform_post_id FROM public.youtube_upload_sessions WHERE id = v_session);

  PERFORM public.claim_youtube_upload_session(v_session, v_lease, 180000);
  PERFORM public.checkpoint_youtube_upload_session(v_session, v_lease, 4096, 4096,
    'https://upload.example.invalid/session/y20', true, NULL, NULL);
  PERFORM public.complete_youtube_upload_session(v_session, v_lease, 'yt-video-y20');

  -- The lease is KEPT: the owner still has to settle the public row.
  ASSERT (SELECT lease_token FROM public.youtube_upload_sessions WHERE id = v_session) = v_lease,
    'Y20 the owner keeps its lease after the receipt';

  -- A live lease is not taken over.
  BEGIN
    PERFORM public.claim_youtube_upload_session(v_session,
      'e0000000-0000-4000-8000-000000000003', 180000);
    RAISE EXCEPTION 'Y20 a live lease was taken over';
  EXCEPTION WHEN SQLSTATE 'YUS07' THEN
    RAISE NOTICE 'PASS Y20: a live lease is not taken over';
  END;

  -- The owner settles with the lease it was given.
  v_settled := public.settle_youtube_upload_session(v_session, v_lease, 'success', 'yt-video-y20');
  ASSERT (v_settled ->> 'settled') = 'true', 'Y20 the owner settles its own session';
  ASSERT (SELECT status FROM public.platform_posts WHERE id = v_row_id) = 'success',
    'Y20 the public row carries the outcome';
  ASSERT (SELECT lease_token FROM public.youtube_upload_sessions WHERE id = v_session) IS NULL,
    'Y20 the settlement releases the lease';

  -- A worker that lost the lease settles nothing.
  BEGIN
    PERFORM public.settle_youtube_upload_session(v_session, v_lease, 'failed', NULL, 'a stale owner');
    RAISE EXCEPTION 'Y20 a stale owner settled the session';
  EXCEPTION WHEN SQLSTATE 'YUS09' THEN
    RAISE NOTICE 'PASS Y20: a stale owner settles nothing';
  END;

  -- The same handoff for a session that was released without a receipt.
  SELECT f.account_id, f.post_id, f.media_id
    INTO v_acct_b, v_post_b, v_media_b
    FROM pg_temp.new_youtube_fixture('y20b') f;
  v_session_b := (public.admit_youtube_upload(
      v_post_b, v_acct_b, v_u_a, v_media_b, 4096, 4096, '{}'::jsonb)
    -> 'session' ->> 'id')::uuid;
  PERFORM public.claim_youtube_upload_session(v_session_b, v_lease_b, 180000);
  PERFORM public.release_youtube_upload_session(v_session_b, v_lease_b, 'failed',
    'the provider refused the upload');
  ASSERT (SELECT lease_token FROM public.youtube_upload_sessions WHERE id = v_session_b) = v_lease_b,
    'Y20 the owner keeps its lease after a release';
  v_settled := public.settle_youtube_upload_session(v_session_b, v_lease_b, 'failed', NULL,
    'the provider refused the upload');
  ASSERT (v_settled ->> 'settled') = 'true',
    'Y20 the owner settles the outcome it released the session for';
  ASSERT (SELECT status FROM public.platform_posts
           WHERE id = (SELECT platform_post_id FROM public.youtube_upload_sessions WHERE id = v_session_b)) = 'failed',
    'Y20 the public row carries the failure';

  RAISE NOTICE 'PASS Y20: the receipt is handed to the owner that has to settle it';
END
$y20_handoff$;

-- ---------------------------------------------------------------------------
-- Y21: the continuation cap.
--
-- The dispatch that brings the count to the cap is consumable by the lease it
-- was handed. A later claim is refused while that lease is live, and the
-- session is classified only once the lease is gone.
-- ---------------------------------------------------------------------------
DO $y21_cap$
DECLARE
  v_acct_a  uuid;
  v_post_a  uuid;
  v_media_a uuid;
  v_u_a     uuid := 'b1000000-0000-4000-8000-000000000001';
  v_session uuid;
  v_lease   uuid;
  v_row_id  uuid;
  v_claimed integer;
BEGIN
  -- This scenario owns its post, its account and its media file.
  SELECT f.account_id, f.post_id, f.media_id
    INTO v_acct_a, v_post_a, v_media_a
    FROM pg_temp.new_youtube_fixture('y21') f;
  v_session := (public.admit_youtube_upload(
      v_post_a, v_acct_a, v_u_a, v_media_a, 4096, 4096, '{}'::jsonb)
    -> 'session' ->> 'id')::uuid;
  v_row_id := (SELECT platform_post_id FROM public.youtube_upload_sessions WHERE id = v_session);

  -- The session is one continuation short of the cap.
  UPDATE public.youtube_upload_sessions SET continuation_count = 23 WHERE id = v_session;

  -- The batch hands the session out. That dispatch is the one that brings the
  -- count to the cap.
  SELECT lease_token INTO v_lease
    FROM public.claim_youtube_upload_sessions(20, 180000, 24)
   WHERE session_id = v_session;
  ASSERT v_lease IS NOT NULL, 'Y21 the batch handed the session out';
  ASSERT (SELECT continuation_count FROM public.youtube_upload_sessions WHERE id = v_session) = 24,
    'Y21 the dispatch brought the count to the cap';

  -- The worker consumes the dispatch it was handed. The cap does not refuse
  -- the very dispatch that reached it.
  PERFORM public.claim_youtube_upload_session(v_session, v_lease, 180000);
  ASSERT (SELECT lease_token FROM public.youtube_upload_sessions WHERE id = v_session) = v_lease,
    'Y21 the holder of the live lease may consume the dispatch that reached the cap';

  -- Another worker is refused while the lease is live.
  BEGIN
    PERFORM public.claim_youtube_upload_session(v_session,
      'e1000000-0000-4000-8000-000000000009', 180000);
    RAISE EXCEPTION 'Y21 a second worker took the session at the cap';
  EXCEPTION WHEN SQLSTATE 'YUS07' THEN
    RAISE NOTICE 'PASS Y21: the live lease protects the session at the cap';
  END;

  -- The lease runs out. Now the cap refuses the claim, and the batch
  -- classifies the session instead.
  UPDATE public.youtube_upload_sessions
     SET lease_expires_at = now() - interval '1 second'
   WHERE id = v_session;

  BEGIN
    PERFORM public.claim_youtube_upload_session(v_session,
      'e1000000-0000-4000-8000-000000000010', 180000);
    RAISE EXCEPTION 'Y21 a claim at the cap was allowed without a lease';
  EXCEPTION WHEN SQLSTATE 'YUS13' THEN
    RAISE NOTICE 'PASS Y21: the cap refuses a claim that holds no live lease';
  END;

  -- The batch classifies it, and the public row is settled with it.
  SELECT count(*) INTO v_claimed FROM public.claim_youtube_upload_sessions(20, 180000, 24);
  ASSERT (SELECT state FROM public.youtube_upload_sessions WHERE id = v_session) <> 'open',
    'Y21 the exhausted session is classified once the lease is gone';
  ASSERT (SELECT status FROM public.platform_posts WHERE id = v_row_id) <> 'pending',
    'Y21 the public row of the exhausted session is settled, not left pending';

  RAISE NOTICE 'PASS Y21: the dispatch that reached the cap is consumable by its own lease';
END
$y21_cap$;

-- ---------------------------------------------------------------------------
-- Y22: the classification settles the public row.
--
-- A session that cannot be carried on any further is not left invisible: its
-- public row is settled, with the reason that says whether a video may exist.
-- ---------------------------------------------------------------------------
DO $y22_classify$
DECLARE
  v_acct_a  uuid;
  v_post_a  uuid;
  v_media_a uuid;
  v_u_a     uuid := 'b1000000-0000-4000-8000-000000000001';
  v_session uuid;
  v_row_id  uuid;
  v_result  jsonb;
BEGIN
  -- A session that wrote bytes: a video may exist, so the outcome is manual.
  SELECT f.account_id, f.post_id, f.media_id
    INTO v_acct_a, v_post_a, v_media_a
    FROM pg_temp.new_youtube_fixture('y22') f;
  v_session := (public.admit_youtube_upload(
      v_post_a, v_acct_a, v_u_a, v_media_a, 4096, 4096, '{}'::jsonb)
    -> 'session' ->> 'id')::uuid;
  v_row_id := (SELECT platform_post_id FROM public.youtube_upload_sessions WHERE id = v_session);
  PERFORM public.claim_youtube_upload_session(v_session,
    'e2000000-0000-4000-8000-000000000001', 180000);
  PERFORM public.checkpoint_youtube_upload_session(v_session,
    'e2000000-0000-4000-8000-000000000001', 4096, 4096,
    'https://upload.example.invalid/session/y22', true, NULL, NULL);
  UPDATE public.youtube_upload_sessions
     SET lease_expires_at = now() - interval '1 second',
         session_expires_at = now() - interval '1 second'
   WHERE id = v_session;

  v_result := public.youtube_upload_classify_terminal(v_session);
  ASSERT (v_result ->> 'classified') = 'true', 'Y22 the exhausted session is classified';
  ASSERT (v_result ->> 'reason') = 'youtube_upload_reconcile_required',
    'Y22 a session that wrote bytes asks for a human';
  ASSERT (v_result ->> 'state') = 'reconcile', 'Y22 the session is left for a human';
  ASSERT (SELECT status FROM public.platform_posts WHERE id = v_row_id) = 'failed',
    'Y22 the public row of the manual outcome is settled';
  ASSERT (SELECT error_message FROM public.platform_posts WHERE id = v_row_id)
      = 'youtube_upload_reconcile_required',
    'Y22 the public row carries the manual reason';
  ASSERT (SELECT status FROM public.posts WHERE id = v_post_a) = 'failed',
    'Y22 the parent is rolled up with the public row';

  -- A session that never wrote a byte is a definitive failure, and a retry is
  -- safe.
  SELECT f.account_id, f.post_id, f.media_id
    INTO v_acct_a, v_post_a, v_media_a
    FROM pg_temp.new_youtube_fixture('y22b') f;
  v_session := (public.admit_youtube_upload(
      v_post_a, v_acct_a, v_u_a, v_media_a, 4096, 4096, '{}'::jsonb)
    -> 'session' ->> 'id')::uuid;
  v_row_id := (SELECT platform_post_id FROM public.youtube_upload_sessions WHERE id = v_session);

  v_result := public.youtube_upload_classify_terminal(v_session);
  ASSERT (v_result ->> 'reason') = 'youtube_upload_unsent',
    'Y22 a session that never wrote a byte is a definitive failure';
  ASSERT (SELECT status FROM public.platform_posts WHERE id = v_row_id) = 'failed',
    'Y22 the public row of the definitive outcome is settled';
  ASSERT (SELECT error_message FROM public.platform_posts WHERE id = v_row_id) = 'youtube_upload_unsent',
    'Y22 the public row carries the definitive reason';

  -- The retry is allowed again: nothing ever reached the provider.
  v_result := public.request_post_retry(v_post_a, v_u_a, ARRAY[v_acct_a]);
  ASSERT (v_result ->> 'status') = 'accepted',
    'Y22 a session that never wrote a byte may be retried';
  ASSERT (v_result -> 'account_ids') @> to_jsonb(ARRAY[v_acct_a]),
    'Y22 the retry names the account it targets';

  RAISE NOTICE 'PASS Y22: the exhausted session settles its public row with a reason';
END
$y22_classify$;

-- ---------------------------------------------------------------------------
-- Y23: the receipt projection does not overwrite a cancellation.
--
-- The receipt stays on the session. The public row and the parent keep the
-- outcome the owner gave them.
-- ---------------------------------------------------------------------------
DO $y23_cancel$
DECLARE
  v_acct_a  uuid;
  v_post_a  uuid;
  v_media_a uuid;
  v_u_a     uuid := 'b1000000-0000-4000-8000-000000000001';
  v_session uuid;
  v_lease   uuid := 'e3000000-0000-4000-8000-000000000001';
  v_row_id  uuid;
BEGIN
  -- This scenario owns its post, its account and its media file.
  SELECT f.account_id, f.post_id, f.media_id
    INTO v_acct_a, v_post_a, v_media_a
    FROM pg_temp.new_youtube_fixture('y23') f;
  v_session := (public.admit_youtube_upload(
      v_post_a, v_acct_a, v_u_a, v_media_a, 4096, 4096, '{}'::jsonb)
    -> 'session' ->> 'id')::uuid;
  v_row_id := (SELECT platform_post_id FROM public.youtube_upload_sessions WHERE id = v_session);

  PERFORM public.claim_youtube_upload_session(v_session, v_lease, 180000);
  PERFORM public.checkpoint_youtube_upload_session(v_session, v_lease, 4096, 4096,
    'https://upload.example.invalid/session/y23', true, NULL, NULL);
  PERFORM public.complete_youtube_upload_session(v_session, v_lease, 'yt-video-y23');

  -- The owner cancels the post after the receipt was stored.
  UPDATE public.posts SET status = 'failed' WHERE id = v_post_a;

  -- The late projection is refused: it may not overwrite the cancellation.
  BEGIN
    PERFORM public.project_youtube_upload_receipt(v_session);
    RAISE EXCEPTION 'Y23 a late receipt overwrote a cancellation';
  EXCEPTION WHEN SQLSTATE 'YUS12' THEN
    RAISE NOTICE 'PASS Y23: the late receipt does not overwrite the cancellation';
  END;

  -- The private receipt is kept: the video exists, and the customer can be
  -- told about it by hand.
  ASSERT (SELECT video_id FROM public.youtube_upload_sessions WHERE id = v_session) = 'yt-video-y23',
    'Y23 the receipt is kept on the session';
  -- The public row and the parent keep the outcome the owner gave them.
  ASSERT (SELECT status FROM public.platform_posts WHERE id = v_row_id) = 'pending',
    'Y23 the public row keeps the state it had';
  ASSERT (SELECT status FROM public.posts WHERE id = v_post_a) = 'failed',
    'Y23 the parent keeps the cancellation';

  RAISE NOTICE 'PASS Y23: the receipt projection does not overwrite a cancellation';
END
$y23_cancel$;

-- ---------------------------------------------------------------------------
-- Y24: the fanout closure of an upload whose worker died.
--
-- The candidate is enrolled before the admission, the upload is admitted and
-- settled, and the closure runs afterwards: the post is finished with the
-- notification that was waiting for it.
-- ---------------------------------------------------------------------------
DO $y24_fanout$
DECLARE
  v_acct_a  uuid;
  v_post_a  uuid;
  v_media_a uuid;
  v_u_a     uuid := 'b1000000-0000-4000-8000-000000000001';
  v_attempt timestamptz;
  v_content jsonb;
  v_session uuid;
  v_lease   uuid := 'e4000000-0000-4000-8000-000000000001';
  v_row_id  uuid;
  v_recovered jsonb;
BEGIN
  -- This scenario owns its post, its account and its media file.
  SELECT f.account_id, f.post_id, f.media_id
    INTO v_acct_a, v_post_a, v_media_a
    FROM pg_temp.new_youtube_fixture('y24') f;

  -- The worker that owned this attempt is gone: the attempt is older than the
  -- worker lifetime, so no worker of it can write another result row and the
  -- closure may be made.
  UPDATE public.posts
     SET processing_started_at = now() - public.youtube_upload_attempt_quiet_after() - interval '1 second'
   WHERE id = v_post_a;
  SELECT processing_started_at INTO v_attempt FROM public.posts WHERE id = v_post_a;

  SELECT jsonb_build_object(
           'user_id', x.user_id, 'caption', x.caption, 'media_file_ids', x.media_file_ids,
           'metadata', public.normalize_threads_internal_metadata(x.metadata), 'platforms', x.platforms,
           'scheduled_at', x.scheduled_at, 'publish_requested_at', x.publish_requested_at, 'source', x.source)
    INTO v_content FROM public.posts x WHERE x.id = v_post_a;

  -- The notification candidate is enrolled BEFORE the admission, the way the
  -- publishing worker does it.
  PERFORM public.enroll_post_notification_recovery(v_post_a, v_attempt, v_content,
    ARRAY[v_acct_a], ARRAY[]::uuid[]);

  -- The upload is admitted: the session and the public pending row are created
  -- in one step.
  v_session := (public.admit_youtube_upload(
      v_post_a, v_acct_a, v_u_a, v_media_a, 4096, 4096, '{}'::jsonb)
    -> 'session' ->> 'id')::uuid;
  v_row_id := (SELECT platform_post_id FROM public.youtube_upload_sessions WHERE id = v_session);

  -- The worker dies here: the fanout is never closed.
  ASSERT (SELECT metadata #>> '{legacy_notification_candidate,fanout_closed}'
            FROM public.posts WHERE id = v_post_a) = 'false',
    'Y24 the candidate is still open after the crash';
  ASSERT (SELECT metadata #>> '{legacy_notification_candidate,ready}'
            FROM public.posts WHERE id = v_post_a) = 'false',
    'Y24 the candidate is not ready after the crash';

  -- A later worker finishes the upload and settles the public row.
  PERFORM public.claim_youtube_upload_session(v_session, v_lease, 180000);
  PERFORM public.checkpoint_youtube_upload_session(v_session, v_lease, 4096, 4096,
    'https://upload.example.invalid/session/y24', true, NULL, NULL);
  PERFORM public.complete_youtube_upload_session(v_session, v_lease, 'yt-video-y24');
  PERFORM public.settle_youtube_upload_session(v_session, v_lease, 'success', 'yt-video-y24');
  ASSERT (SELECT status FROM public.platform_posts WHERE id = v_row_id) = 'success',
    'Y24 the public row is settled';

  -- The closure runs. The scope is complete: the attempt owns a row for the
  -- one destination of the candidate.
  v_recovered := public.recover_youtube_upload_fanout(v_session, NULL);
  ASSERT (v_recovered ->> 'recovered') = 'true',
    'Y24 the fanout is closed through the notification-enrolled path';
  ASSERT (SELECT metadata #>> '{legacy_notification_candidate,fanout_closed}'
            FROM public.posts WHERE id = v_post_a) = 'true',
    'Y24 the fanout is closed';
  ASSERT (SELECT metadata #>> '{legacy_notification_candidate,ready}'
            FROM public.posts WHERE id = v_post_a) = 'true',
    'Y24 the candidate is ready';
  ASSERT (SELECT status FROM public.posts WHERE id = v_post_a) = 'completed',
    'Y24 the parent is rolled up by the closure';

  -- A second closure is harmless: the scope is the same.
  v_recovered := public.recover_youtube_upload_fanout(v_session, NULL);
  ASSERT (v_recovered ->> 'recovered') = 'true',
    'Y24 the closure is idempotent';

  RAISE NOTICE 'PASS Y24: the fanout of a dead worker is closed by the next one';
END
$y24_fanout$;

-- ---------------------------------------------------------------------------
-- Y25: a mixed destination with a lost receipt is UNKNOWN, not unsent.
--
-- The YouTube destination finished and the other one has no row. The platforms
-- that are not YouTube write their result row AFTER the provider call, so the
-- missing row does NOT prove that the destination never started: the provider
-- call may have succeeded and the receipt may have been lost with the worker.
--
-- So the destination is terminalised with a NON-RETRYABLE reason, the scope
-- becomes complete, the fanout closes, and the parent reaches a finite
-- outcome. The successful sibling keeps its result, and the retry gate
-- refuses the unknown destination, so nothing can be published twice.
-- ---------------------------------------------------------------------------
DO $y25_mixed$
DECLARE
  v_acct_a  uuid;
  v_post_a  uuid;
  v_media_a uuid;
  v_ig      uuid := 'e5000000-0000-4000-8000-000000000001';
  v_u_a     uuid := 'b1000000-0000-4000-8000-000000000001';
  v_attempt timestamptz;
  v_content jsonb;
  v_session uuid;
  v_lease   uuid := 'e5000000-0000-4000-8000-000000000002';
  v_recovered jsonb;
  v_retry   jsonb;
  v_ig_row  uuid;
BEGIN
  -- This scenario owns its post, its account and its media file.
  SELECT f.account_id, f.post_id, f.media_id
    INTO v_acct_a, v_post_a, v_media_a
    FROM pg_temp.new_youtube_fixture('y25') f;
  -- The post has a second destination.
  INSERT INTO public.social_accounts
    (id, user_id, platform, platform_user_id, platform_username, access_token, is_active)
  VALUES (v_ig, v_u_a, 'instagram', 'ig-y25', 'y25', 'token-ig', true)
  ON CONFLICT (id) DO NOTHING;
  UPDATE public.posts
     SET platforms = ARRAY['youtube', 'instagram'],
         metadata = metadata || jsonb_build_object(
           'selected_account_ids', jsonb_build_array(v_acct_a::text, v_ig::text))
   WHERE id = v_post_a;

  -- The worker that owned this attempt is gone.
  UPDATE public.posts
     SET processing_started_at = now() - public.youtube_upload_attempt_quiet_after() - interval '1 second'
   WHERE id = v_post_a;
  SELECT processing_started_at INTO v_attempt FROM public.posts WHERE id = v_post_a;
  SELECT jsonb_build_object(
           'user_id', x.user_id, 'caption', x.caption, 'media_file_ids', x.media_file_ids,
           'metadata', public.normalize_threads_internal_metadata(x.metadata), 'platforms', x.platforms,
           'scheduled_at', x.scheduled_at, 'publish_requested_at', x.publish_requested_at, 'source', x.source)
    INTO v_content FROM public.posts x WHERE x.id = v_post_a;

  PERFORM public.enroll_post_notification_recovery(v_post_a, v_attempt, v_content,
    ARRAY[v_acct_a, v_ig], ARRAY[]::uuid[]);

  v_session := (public.admit_youtube_upload(
      v_post_a, v_acct_a, v_u_a, v_media_a, 4096, 4096, '{}'::jsonb)
    -> 'session' ->> 'id')::uuid;
  PERFORM public.claim_youtube_upload_session(v_session, v_lease, 180000);
  PERFORM public.checkpoint_youtube_upload_session(v_session, v_lease, 4096, 4096,
    'https://upload.example.invalid/session/y25', true, NULL, NULL);
  PERFORM public.complete_youtube_upload_session(v_session, v_lease, 'yt-video-y25');
  PERFORM public.settle_youtube_upload_session(v_session, v_lease, 'success', 'yt-video-y25');

  -- The sibling has no row. Its outcome is unknown, so it is terminalised
  -- with a reason that is not a retry offer.
  v_recovered := public.recover_youtube_upload_fanout(v_session, NULL);
  ASSERT (v_recovered ->> 'recovered') = 'true',
    'Y25 the fanout is closed once the scope is complete';
  ASSERT (v_recovered -> 'unknown_account_ids') @> to_jsonb(ARRAY[v_ig]),
    'Y25 the unknown destination is named';

  SELECT id INTO v_ig_row FROM public.platform_posts
   WHERE post_id = v_post_a AND social_account_id = v_ig;
  ASSERT v_ig_row IS NOT NULL,
    'Y25 the unknown destination has a result row';
  ASSERT (SELECT status FROM public.platform_posts WHERE id = v_ig_row) = 'failed',
    'Y25 the unknown destination is terminal';
  ASSERT (SELECT error_message FROM public.platform_posts WHERE id = v_ig_row)
           = 'partner_publish_reconcile_required',
    'Y25 the unknown destination carries the stable public reason';
  ASSERT (SELECT response_data ->> 'publish_outcome' FROM public.platform_posts WHERE id = v_ig_row)
           = 'uncertain',
    'Y25 the unknown destination is marked as an unknown outcome';

  -- The successful sibling keeps its result.
  ASSERT (SELECT status FROM public.platform_posts
           WHERE id = (SELECT platform_post_id FROM public.youtube_upload_sessions WHERE id = v_session)) = 'success',
    'Y25 the successful sibling keeps its result';

  -- The parent reaches a finite outcome.
  ASSERT (SELECT status FROM public.posts WHERE id = v_post_a) = 'completed',
    'Y25 the parent is finished by the closure';
  ASSERT (SELECT metadata #>> '{legacy_notification_candidate,fanout_closed}'
            FROM public.posts WHERE id = v_post_a) = 'true',
    'Y25 the fanout is closed';
  ASSERT (SELECT metadata #>> '{legacy_notification_candidate,fanout_state}'
            FROM public.posts WHERE id = v_post_a) = 'youtube_upload_unknown_scope',
    'Y25 the candidate records the unknown scope';
  ASSERT (SELECT metadata #>> '{legacy_notification_candidate,fanout_recovery_reason}'
            FROM public.posts WHERE id = v_post_a) IS NOT NULL,
    'Y25 the terminal state carries an actionable reason';

  -- The retry gate refuses the unknown destination: a retry could publish a
  -- second time.
  v_retry := public.request_post_retry(v_post_a, v_u_a, ARRAY[v_ig]);
  ASSERT (v_retry ->> 'status') = 'refused',
    'Y25 the unknown destination is not retried';
  ASSERT (v_retry ->> 'reason') = 'no_targets',
    'Y25 the refusal says there is nothing safe to retry';

  -- The refusal did not delete the evidence, and did not move the post.
  ASSERT (SELECT count(*) FROM public.platform_posts WHERE id = v_ig_row) = 1,
    'Y25 the unknown result row is kept';
  ASSERT (SELECT status FROM public.posts WHERE id = v_post_a) = 'completed',
    'Y25 the refused retry left the post alone';

  RAISE NOTICE 'PASS Y25: a lost sibling receipt is unknown, terminal and not retryable';
END
$y25_mixed$;

-- ---------------------------------------------------------------------------
-- Y26: the write authority is the live state, not the lease.
-- ---------------------------------------------------------------------------
DO $y26_authority$
DECLARE
  v_acct_a  uuid;
  v_post_a  uuid;
  v_media_a uuid;
  v_u_a     uuid := 'b1000000-0000-4000-8000-000000000001';
  v_session uuid;
  v_lease   uuid := 'e6000000-0000-4000-8000-000000000001';
  v_content jsonb;
  v_verdict jsonb;
BEGIN
  -- The admission compares the caller's snapshot with the LIVE post.
  SELECT f.account_id, f.post_id, f.media_id
    INTO v_acct_a, v_post_a, v_media_a
    FROM pg_temp.new_youtube_fixture('y26') f;
  SELECT jsonb_build_object(
           'user_id', x.user_id, 'caption', x.caption, 'media_file_ids', x.media_file_ids,
           'metadata', public.normalize_threads_internal_metadata(x.metadata), 'platforms', x.platforms,
           'scheduled_at', x.scheduled_at, 'publish_requested_at', x.publish_requested_at, 'source', x.source)
    INTO v_content FROM public.posts x WHERE x.id = v_post_a;

  -- The customer changed the title while the caller had the old one.
  UPDATE public.posts SET caption = 'A different video' WHERE id = v_post_a;
  BEGIN
    PERFORM public.admit_youtube_upload(v_post_a, v_acct_a, v_u_a, v_media_a, 4096, 4096,
      '{}'::jsonb, NULL, ARRAY[v_acct_a], NULL, v_content);
    RAISE EXCEPTION 'Y26 a stale snapshot was admitted';
  EXCEPTION WHEN SQLSTATE 'YUS04' THEN
    RAISE NOTICE 'PASS Y26: the admission refuses a snapshot the live post no longer matches';
  END;

  -- The live snapshot is admitted.
  v_session := (public.admit_youtube_upload(v_post_a, v_acct_a, v_u_a, v_media_a, 4096, 4096,
      '{}'::jsonb, NULL, ARRAY[v_acct_a], NULL,
      (SELECT jsonb_build_object(
                'user_id', x.user_id, 'caption', x.caption, 'media_file_ids', x.media_file_ids,
                'metadata', public.normalize_threads_internal_metadata(x.metadata), 'platforms', x.platforms,
                'scheduled_at', x.scheduled_at, 'publish_requested_at', x.publish_requested_at, 'source', x.source)
         FROM public.posts x WHERE x.id = v_post_a))
    -> 'session' ->> 'id')::uuid;
  PERFORM public.claim_youtube_upload_session(v_session, v_lease, 180000);

  -- The lease alone says nothing: the live state is asked about.
  v_verdict := public.youtube_upload_effect_authority(v_session, v_lease);
  ASSERT (v_verdict ->> 'authorized') = 'true', 'Y26 the live state authorises the write';

  -- The title changed again, in the same attempt.
  UPDATE public.posts SET caption = 'Yet another video' WHERE id = v_post_a;
  v_verdict := public.youtube_upload_effect_authority(v_session, v_lease);
  ASSERT (v_verdict ->> 'authorized') = 'false', 'Y26 a changed title stops the write';
  ASSERT (v_verdict ->> 'reason') = 'content_changed',
    'Y26 the reason names the content that changed';

  -- The post was cancelled after the claim and before the write.
  UPDATE public.posts SET caption = 'A different video', status = 'failed' WHERE id = v_post_a;
  v_verdict := public.youtube_upload_effect_authority(v_session, v_lease);
  ASSERT (v_verdict ->> 'authorized') = 'false', 'Y26 a cancelled post stops the write';
  ASSERT (v_verdict ->> 'reason') = 'post_not_processing',
    'Y26 the reason names the cancelled post';

  RAISE NOTICE 'PASS Y26: the write authority is the live state, not the lease';
END
$y26_authority$;

-- ---------------------------------------------------------------------------
-- Y27: the media sendability rule is the shared one.
-- ---------------------------------------------------------------------------
DO $y27_media$
DECLARE
  v_acct_a  uuid;
  v_post_a  uuid;
  v_media_a uuid;
  v_u_a     uuid := 'b1000000-0000-4000-8000-000000000001';
  v_session uuid;
  v_lease   uuid := 'e7000000-0000-4000-8000-000000000001';
  v_verdict jsonb;
BEGIN
  -- This scenario owns its post, its account and its media file.
  SELECT f.account_id, f.post_id, f.media_id
    INTO v_acct_a, v_post_a, v_media_a
    FROM pg_temp.new_youtube_fixture('y27') f;
  v_session := (public.admit_youtube_upload(
      v_post_a, v_acct_a, v_u_a, v_media_a, 4096, 4096, '{}'::jsonb)
    -> 'session' ->> 'id')::uuid;
  PERFORM public.claim_youtube_upload_session(v_session, v_lease, 180000);

  -- The file is still being scanned: the upload waits.
  UPDATE public.media_files SET scan_state = 'pending' WHERE id = v_media_a;
  v_verdict := public.youtube_upload_effect_authority(v_session, v_lease);
  ASSERT (v_verdict ->> 'authorized') = 'false', 'Y27 a file that is being scanned stops the write';
  ASSERT (v_verdict ->> 'reason') = 'media_pending', 'Y27 the reason names the scan';

  -- The scan rejected the file: the upload may never send it.
  UPDATE public.media_files SET scan_state = 'rejected' WHERE id = v_media_a;
  v_verdict := public.youtube_upload_effect_authority(v_session, v_lease);
  ASSERT (v_verdict ->> 'authorized') = 'false', 'Y27 a rejected file stops the write';
  ASSERT (v_verdict ->> 'reason') = 'media_rejected', 'Y27 the reason names the rejection';

  -- The scan cleared the file: the write is authorised again.
  UPDATE public.media_files SET scan_state = 'available' WHERE id = v_media_a;
  v_verdict := public.youtube_upload_effect_authority(v_session, v_lease);
  ASSERT (v_verdict ->> 'authorized') = 'true', 'Y27 an available file authorises the write';

  RAISE NOTICE 'PASS Y27: the media sendability rule is the shared one';
END
$y27_media$;

-- ---------------------------------------------------------------------------
-- Y28: the closure waits for the worker of the attempt to go quiet.
--
-- A live worker may still write the row the scope is missing, so the closure
-- is refused while the attempt is young. The reconciler drives it again, so
-- the wait is bounded and the post is not held open for ever.
-- ---------------------------------------------------------------------------
DO $y28_quiet$
DECLARE
  v_acct_a  uuid;
  v_post_a  uuid;
  v_media_a uuid;
  v_u_a     uuid := 'b1000000-0000-4000-8000-000000000001';
  v_attempt timestamptz;
  v_content jsonb;
  v_session uuid;
  v_lease   uuid := 'e8000000-0000-4000-8000-000000000001';
  v_recovered jsonb;
  v_reconciled jsonb;
  v_quiet   timestamptz;
BEGIN
  -- This scenario owns its post, its account and its media file.
  SELECT f.account_id, f.post_id, f.media_id
    INTO v_acct_a, v_post_a, v_media_a
    FROM pg_temp.new_youtube_fixture('y28') f;
  SELECT processing_started_at INTO v_attempt FROM public.posts WHERE id = v_post_a;
  SELECT jsonb_build_object(
           'user_id', x.user_id, 'caption', x.caption, 'media_file_ids', x.media_file_ids,
           'metadata', public.normalize_threads_internal_metadata(x.metadata), 'platforms', x.platforms,
           'scheduled_at', x.scheduled_at, 'publish_requested_at', x.publish_requested_at, 'source', x.source)
    INTO v_content FROM public.posts x WHERE x.id = v_post_a;

  PERFORM public.enroll_post_notification_recovery(v_post_a, v_attempt, v_content,
    ARRAY[v_acct_a], ARRAY[]::uuid[]);

  v_session := (public.admit_youtube_upload(
      v_post_a, v_acct_a, v_u_a, v_media_a, 4096, 4096, '{}'::jsonb)
    -> 'session' ->> 'id')::uuid;
  PERFORM public.claim_youtube_upload_session(v_session, v_lease, 180000);
  PERFORM public.complete_youtube_upload_session(v_session, v_lease, 'yt-video-y28');
  PERFORM public.settle_youtube_upload_session(v_session, v_lease, 'success', 'yt-video-y28');

  -- The worker of this attempt may still be running: the closure waits.
  v_recovered := public.recover_youtube_upload_fanout(v_session, NULL);
  ASSERT (v_recovered ->> 'recovered') = 'false',
    'Y28 a running attempt is not closed';
  ASSERT (v_recovered ->> 'reason') = 'attempt_may_still_be_running',
    'Y28 the reason says the attempt may still be running';
  ASSERT (SELECT metadata #>> '{legacy_notification_candidate,fanout_closed}'
            FROM public.posts WHERE id = v_post_a) = 'false',
    'Y28 the fanout is not closed while the attempt is running';
  ASSERT (SELECT status FROM public.posts WHERE id = v_post_a) = 'processing',
    'Y28 the post is not finished while the attempt is running';

  -- The attempt goes quiet: the post, the session and the candidate all move
  -- to the same older attempt, which is what an attempt whose worker has been
  -- gone for a while looks like.
  v_quiet := now() - public.youtube_upload_attempt_quiet_after() - interval '1 second';
  UPDATE public.posts
     SET processing_started_at = v_quiet,
         metadata = (metadata - 'attempt_started_at' - 'legacy_notification_candidate')
                    || jsonb_build_object(
                         'attempt_started_at', v_quiet,
                         'legacy_notification_candidate', (metadata -> 'legacy_notification_candidate')
                           || jsonb_build_object('attempt_started_at', v_quiet))
   WHERE id = v_post_a;
  UPDATE public.youtube_upload_sessions
     SET attempt_started_at = v_quiet
   WHERE id = v_session;

  -- The driver closes it.
  v_reconciled := public.reconcile_youtube_upload_fanouts(5);
  ASSERT (v_reconciled ->> 'fanouts_recovered') = '1',
    'Y28 the driver closes the fanout once the attempt is quiet';
  ASSERT (SELECT metadata #>> '{legacy_notification_candidate,fanout_closed}'
            FROM public.posts WHERE id = v_post_a) = 'true',
    'Y28 the fanout is closed by the driver';
  ASSERT (SELECT status FROM public.posts WHERE id = v_post_a) = 'completed',
    'Y28 the parent is finished by the driver';

  RAISE NOTICE 'PASS Y28: the closure waits for the worker of the attempt to go quiet';
END
$y28_quiet$;

-- ---------------------------------------------------------------------------
-- Y29: the sweeper never offers a retry for an ambiguous destination.
--
-- This is the hole the parent named: the sibling's provider call may have
-- succeeded and its receipt may have been lost, so a row that says "Safe to
-- retry" would offer a retry that can publish a second time.
--
-- The post is old enough for the sweeper, the YouTube upload is settled and
-- its receipt is durable, and the sibling has no row. The sweeper runs
-- before the recovery has, which is the window that matters.
-- ---------------------------------------------------------------------------
DO $y29_sweep$
DECLARE
  v_acct_a  uuid;
  v_post_a  uuid;
  v_media_a uuid;
  v_ig      uuid := 'e9000000-0000-4000-8000-000000000001';
  v_u_a     uuid := 'b1000000-0000-4000-8000-000000000001';
  v_attempt timestamptz;
  v_content jsonb;
  v_session uuid;
  v_lease   uuid := 'e9000000-0000-4000-8000-000000000002';
  v_answer  jsonb;
  v_retry   jsonb;
BEGIN
  -- This scenario owns its post, its account and its media file.
  SELECT f.account_id, f.post_id, f.media_id
    INTO v_acct_a, v_post_a, v_media_a
    FROM pg_temp.new_youtube_fixture('y29') f;
  INSERT INTO public.social_accounts
    (id, user_id, platform, platform_user_id, platform_username, access_token, is_active)
  VALUES (v_ig, v_u_a, 'instagram', 'ig-y29', 'y29', 'token-ig', true)
  ON CONFLICT (id) DO NOTHING;
  UPDATE public.posts
     SET platforms = ARRAY['youtube', 'instagram'],
         metadata = metadata || jsonb_build_object(
           'selected_account_ids', jsonb_build_array(v_acct_a::text, v_ig::text))
   WHERE id = v_post_a;

  -- The attempt is older than the sweeper's window, and older than the worker
  -- lifetime, so the attempt is quiet.
  UPDATE public.posts
     SET processing_started_at = now() - interval '30 minutes'
   WHERE id = v_post_a;
  SELECT processing_started_at INTO v_attempt FROM public.posts WHERE id = v_post_a;
  SELECT jsonb_build_object(
           'user_id', x.user_id, 'caption', x.caption, 'media_file_ids', x.media_file_ids,
           'metadata', public.normalize_threads_internal_metadata(x.metadata), 'platforms', x.platforms,
           'scheduled_at', x.scheduled_at, 'publish_requested_at', x.publish_requested_at, 'source', x.source)
    INTO v_content FROM public.posts x WHERE x.id = v_post_a;

  PERFORM public.enroll_post_notification_recovery(v_post_a, v_attempt, v_content,
    ARRAY[v_acct_a, v_ig], ARRAY[]::uuid[]);

  -- The upload is settled, so its receipt is durable and its row is terminal.
  v_session := (public.admit_youtube_upload(
      v_post_a, v_acct_a, v_u_a, v_media_a, 4096, 4096, '{}'::jsonb)
    -> 'session' ->> 'id')::uuid;
  PERFORM public.claim_youtube_upload_session(v_session, v_lease, 180000);
  PERFORM public.complete_youtube_upload_session(v_session, v_lease, 'yt-video-y29');
  PERFORM public.settle_youtube_upload_session(v_session, v_lease, 'success', 'yt-video-y29');

  -- The sweeper runs.
  v_answer := public.sweep_stale_processing_posts();

  -- No destination is offered a retry.
  ASSERT NOT EXISTS (
    SELECT 1 FROM public.platform_posts
     WHERE post_id = v_post_a AND error_message LIKE '%Safe to retry%'
  ), 'Y29 the sweeper offers no retry for an ambiguous destination';

  -- The sibling is closed with the non-retryable reason instead.
  ASSERT (SELECT error_message FROM public.platform_posts
           WHERE post_id = v_post_a AND social_account_id = v_ig)
           = 'partner_publish_reconcile_required',
    'Y29 the ambiguous destination carries the stable public reason';
  ASSERT (SELECT response_data ->> 'publish_outcome' FROM public.platform_posts
           WHERE post_id = v_post_a AND social_account_id = v_ig) = 'uncertain',
    'Y29 the ambiguous destination is marked as an unknown outcome';

  -- The post still reaches a finite outcome.
  ASSERT (SELECT status FROM public.posts WHERE id = v_post_a) IN ('completed', 'failed'),
    'Y29 the post reaches a finite outcome';

  -- And the destination is still not retryable.
  v_retry := public.request_post_retry(v_post_a, v_u_a, ARRAY[v_ig]);
  ASSERT (v_retry ->> 'status') = 'refused',
    'Y29 the ambiguous destination is not retried';

  RAISE NOTICE 'PASS Y29: the sweeper offers no retry for an ambiguous destination';
END
$y29_sweep$;

-- ---------------------------------------------------------------------------
-- Y30: the pending row of a cancelled post is closed, and the parent keeps
-- the outcome the owner gave it.
-- ---------------------------------------------------------------------------
DO $y30_cancelled$
DECLARE
  v_acct_a  uuid;
  v_post_a  uuid;
  v_media_a uuid;
  v_u_a     uuid := 'b1000000-0000-4000-8000-000000000001';
  v_session uuid;
  v_lease   uuid := 'ea000000-0000-4000-8000-000000000001';
  v_row_id  uuid;
  v_answer  jsonb;
  v_retry   jsonb;
BEGIN
  -- This scenario owns its post, its account and its media file.
  SELECT f.account_id, f.post_id, f.media_id
    INTO v_acct_a, v_post_a, v_media_a
    FROM pg_temp.new_youtube_fixture('y30') f;
  v_session := (public.admit_youtube_upload(
      v_post_a, v_acct_a, v_u_a, v_media_a, 4096, 4096, '{}'::jsonb)
    -> 'session' ->> 'id')::uuid;
  v_row_id := (SELECT platform_post_id FROM public.youtube_upload_sessions WHERE id = v_session);

  -- The owner cancels the post while the upload is open.
  UPDATE public.posts SET status = 'failed' WHERE id = v_post_a;

  -- The row is closed, and only the row.
  v_answer := public.youtube_upload_terminalize_cancelled(v_session);
  ASSERT (v_answer ->> 'terminalized') = 'true',
    'Y30 the pending row of a cancelled post is closed';
  ASSERT (v_answer ->> 'reason') = 'youtube_upload_cancelled',
    'Y30 the reason says the upload never reached the provider';
  ASSERT (SELECT status FROM public.platform_posts WHERE id = v_row_id) = 'failed',
    'Y30 the row is terminal';
  ASSERT (SELECT error_message FROM public.platform_posts WHERE id = v_row_id)
           = 'youtube_upload_cancelled',
    'Y30 the row carries the stable public reason';
  ASSERT (SELECT response_data ->> 'publish_outcome' FROM public.platform_posts WHERE id = v_row_id)
           = 'cancelled',
    'Y30 the row is marked as cancelled';

  -- The parent keeps the outcome the owner gave it.
  ASSERT (SELECT status FROM public.posts WHERE id = v_post_a) = 'failed',
    'Y30 the parent is not rolled up by the cancellation';
  ASSERT (SELECT state FROM public.youtube_upload_sessions WHERE id = v_session) = 'failed',
    'Y30 the session is terminal';
  ASSERT (SELECT lease_token FROM public.youtube_upload_sessions WHERE id = v_session) IS NULL,
    'Y30 the cancelled session releases its lease';

  -- The destination is not retried: the attempt was cancelled.
  v_retry := public.request_post_retry(v_post_a, v_u_a, ARRAY[v_acct_a]);
  ASSERT (v_retry ->> 'status') = 'refused',
    'Y30 the cancelled destination is not retried';

  -- A later attempt owns the post: the old row is not its business.
  UPDATE public.youtube_upload_sessions
     SET state = 'open',
         platform_post_id = v_row_id,
         attempt_started_at = now() - interval '1 hour'
   WHERE id = v_session;
  UPDATE public.platform_posts SET status = 'pending' WHERE id = v_row_id;
  v_answer := public.youtube_upload_terminalize_cancelled(v_session);
  ASSERT (v_answer ->> 'terminalized') = 'false',
    'Y30 a superseded attempt is left alone';
  ASSERT (v_answer ->> 'reason') = 'stale_attempt',
    'Y30 the reason names the attempt that owns the post now';

  RAISE NOTICE 'PASS Y30: the pending row of a cancelled post is closed without rolling the parent';
END
$y30_cancelled$;

-- ---------------------------------------------------------------------------
-- Y31: a late worker cannot make an unknown destination retryable, and the
-- settlement is idempotent.
-- ---------------------------------------------------------------------------
DO $y31_late$
DECLARE
  v_acct_a  uuid;
  v_post_a  uuid;
  v_media_a uuid;
  v_ig      uuid := 'eb000000-0000-4000-8000-000000000001';
  v_u_a     uuid := 'b1000000-0000-4000-8000-000000000001';
  v_attempt timestamptz;
  v_content jsonb;
  v_session uuid;
  v_lease   uuid := 'eb000000-0000-4000-8000-000000000002';
  v_recovered jsonb;
  v_retry   jsonb;
  v_rows    integer;
BEGIN
  -- This scenario owns its post, its account and its media file.
  SELECT f.account_id, f.post_id, f.media_id
    INTO v_acct_a, v_post_a, v_media_a
    FROM pg_temp.new_youtube_fixture('y31') f;
  INSERT INTO public.social_accounts
    (id, user_id, platform, platform_user_id, platform_username, access_token, is_active)
  VALUES (v_ig, v_u_a, 'instagram', 'ig-y31', 'y31', 'token-ig', true)
  ON CONFLICT (id) DO NOTHING;
  UPDATE public.posts
     SET platforms = ARRAY['youtube', 'instagram'],
         metadata = metadata || jsonb_build_object(
           'selected_account_ids', jsonb_build_array(v_acct_a::text, v_ig::text))
   WHERE id = v_post_a;

  -- The worker of this attempt is gone.
  UPDATE public.posts
     SET processing_started_at = now() - public.youtube_upload_attempt_quiet_after() - interval '1 second'
   WHERE id = v_post_a;
  SELECT processing_started_at INTO v_attempt FROM public.posts WHERE id = v_post_a;
  SELECT jsonb_build_object(
           'user_id', x.user_id, 'caption', x.caption, 'media_file_ids', x.media_file_ids,
           'metadata', public.normalize_threads_internal_metadata(x.metadata), 'platforms', x.platforms,
           'scheduled_at', x.scheduled_at, 'publish_requested_at', x.publish_requested_at, 'source', x.source)
    INTO v_content FROM public.posts x WHERE x.id = v_post_a;

  PERFORM public.enroll_post_notification_recovery(v_post_a, v_attempt, v_content,
    ARRAY[v_acct_a, v_ig], ARRAY[]::uuid[]);

  v_session := (public.admit_youtube_upload(
      v_post_a, v_acct_a, v_u_a, v_media_a, 4096, 4096, '{}'::jsonb)
    -> 'session' ->> 'id')::uuid;
  PERFORM public.claim_youtube_upload_session(v_session, v_lease, 180000);
  PERFORM public.complete_youtube_upload_session(v_session, v_lease, 'yt-video-y31');
  PERFORM public.settle_youtube_upload_session(v_session, v_lease, 'success', 'yt-video-y31');

  v_recovered := public.recover_youtube_upload_fanout(v_session, NULL);
  ASSERT (v_recovered ->> 'recovered') = 'true',
    'Y31 the fanout is closed';

  -- The settlement is idempotent: a second pass writes nothing new.
  v_recovered := public.recover_youtube_upload_fanout(v_session, NULL);
  SELECT count(*) INTO v_rows FROM public.platform_posts WHERE post_id = v_post_a;
  ASSERT v_rows = 2,
    'Y31 a second pass writes no extra row';

  -- A late worker writes the sibling's own row. The platform allows more than
  -- one row for an account, and the late row says what really happened.
  INSERT INTO public.platform_posts (post_id, social_account_id, platform, status, error_message, response_data)
  VALUES (v_post_a, v_ig, 'instagram', 'failed', 'the provider refused the media',
          jsonb_build_object('late_worker', true));

  -- The late row does not make the destination retryable: the unknown outcome
  -- is still on record, and a retry could publish a second time.
  v_retry := public.request_post_retry(v_post_a, v_u_a, ARRAY[v_ig]);
  ASSERT (v_retry ->> 'status') = 'refused',
    'Y31 a late worker does not make an unknown destination retryable';

  RAISE NOTICE 'PASS Y31: a late worker cannot make an unknown destination retryable';
END
$y31_late$;

-- ---------------------------------------------------------------------------
-- Y32: the safe restart after a retry.
--
-- The regression of PR441 comment 4610712965: the retry changed the fence,
-- and the fence was compared before the branch that reopens a failed session.
--
-- The composition is real: an upload the provider refused, a retry through
-- request_post_retry, the worker's fresh processing claim, and the admission
-- that starts the upload again.
--
-- The retry changes publish_requested_at, and that is part of the fence, so
-- the fence the first attempt left behind no longer matches the live post. An
-- upload that never sent a byte has to be publishable anyway: nothing reached
-- the provider, so a second attempt cannot create a second video.
--
-- The unsafe counterparts are proved as well: an upload that may already hold
-- a video is never retried, and an upload that is still open keeps its fence.
-- ---------------------------------------------------------------------------
DO $y32_safe_restart$
DECLARE
  v_acct_a  uuid;
  v_post_a  uuid;
  v_media_a uuid;
  v_acct_b  uuid;
  v_post_b  uuid;
  v_media_b uuid;
  v_u_a       uuid := 'b1000000-0000-4000-8000-000000000001';
  v_session   uuid;
  v_session_b uuid;
  v_lease     uuid := 'ec000000-0000-4000-8000-000000000001';
  v_lease_b   uuid := 'ec000000-0000-4000-8000-000000000002';
  v_answer    jsonb;
  v_admitted  jsonb;
  v_attempt   timestamptz;
  v_fence     jsonb;
  v_state     text;
  v_row_status text;
BEGIN
  -- This scenario owns its post, its account and its media file.
  SELECT f.account_id, f.post_id, f.media_id
    INTO v_acct_a, v_post_a, v_media_a
    FROM pg_temp.new_youtube_fixture('y32') f;

  -- The first attempt: the upload is admitted, and the provider refuses it
  -- before a single byte is written.
  v_session := (public.admit_youtube_upload(
      v_post_a, v_acct_a, v_u_a, v_media_a, 4096, 4096, '{"title":"A video"}'::jsonb)
    -> 'session' ->> 'id')::uuid;
  PERFORM public.claim_youtube_upload_session(v_session, v_lease, 180000);
  PERFORM public.release_youtube_upload_session(v_session, v_lease, 'failed',
    'the provider refused the upload');
  PERFORM public.settle_youtube_upload_session(v_session, v_lease, 'failed', NULL,
    'the provider refused the upload', '{}'::jsonb);

  SELECT state INTO v_state FROM public.youtube_upload_sessions WHERE id = v_session;
  ASSERT v_state = 'failed',
    'Y32 the refused upload is a failed session';

  -- The customer retries the post.
  v_answer := public.request_post_retry(v_post_a, v_u_a, ARRAY[v_acct_a]);
  ASSERT v_answer ->> 'status' = 'accepted',
    'Y32 an upload that never sent a byte is retried';

  -- The worker takes the post again. This is the claim the processing claim
  -- makes: the post is claimed and the attempt starts again.
  UPDATE public.posts
     SET status = 'processing', processing_started_at = now()
   WHERE id = v_post_a;
  SELECT processing_started_at INTO v_attempt FROM public.posts WHERE id = v_post_a;

  -- The retry left the fence of the first attempt behind: publish_requested_at
  -- is part of it, and the retry changed it.
  SELECT content_fence INTO v_fence FROM public.youtube_upload_sessions WHERE id = v_session;
  ASSERT v_fence IS DISTINCT FROM public.youtube_upload_live_fence(v_post_a, v_media_a, 4096, v_acct_a),
    'Y32 the retry leaves the fence of the first attempt behind';

  -- The admission of the new attempt starts the upload again.
  v_admitted := public.admit_youtube_upload(
      v_post_a, v_acct_a, v_u_a, v_media_a, 4096, 4096, '{"title":"A video"}'::jsonb,
      v_attempt, ARRAY[v_acct_a], NULL, NULL);
  ASSERT (v_admitted -> 'session' ->> 'state') = 'open',
    'Y32 the retried upload is started again';
  ASSERT (v_admitted -> 'session' ->> 'session_uri') IS NULL,
    'Y32 the restarted upload has no provider session';
  ASSERT (v_admitted -> 'session' ->> 'confirmed_bytes')::bigint = 0,
    'Y32 the restarted upload starts from the beginning';
  ASSERT (v_admitted -> 'session' ->> 'attempt_started_at')::timestamptz = v_attempt,
    'Y32 the restarted upload belongs to the attempt that is running';

  -- The refreshed fence is the live one, so the write authority holds.
  SELECT content_fence INTO v_fence FROM public.youtube_upload_sessions WHERE id = v_session;
  ASSERT v_fence = public.youtube_upload_live_fence(v_post_a, v_media_a, 4096, v_acct_a),
    'Y32 the restarted upload carries the live fence';
  PERFORM public.claim_youtube_upload_session(v_session, v_lease, 180000);
  ASSERT public.youtube_upload_effect_authority(v_session, v_lease) ->> 'authorized' = 'true',
    'Y32 the restarted upload may still be written';

  -- The public row of the new attempt is pending again.
  SELECT pp.status INTO v_row_status
    FROM public.platform_posts pp
   WHERE pp.id = (SELECT platform_post_id FROM public.youtube_upload_sessions WHERE id = v_session);
  ASSERT v_row_status = 'pending',
    'Y32 the retried upload has a pending public row again';

  -- THE UNSAFE COUNTERPART
  --
  -- A byte reached the provider, so a video may exist. The upload is left for
  -- a human and the retry is refused: a second attempt could put a second
  -- video on the channel.
  SELECT f.account_id, f.post_id, f.media_id
    INTO v_acct_b, v_post_b, v_media_b
    FROM pg_temp.new_youtube_fixture('y32b') f;
  v_session_b := (public.admit_youtube_upload(
      v_post_b, v_acct_b, v_u_a, v_media_b, 4096, 4096, '{}'::jsonb)
    -> 'session' ->> 'id')::uuid;
  PERFORM public.claim_youtube_upload_session(v_session_b, v_lease_b, 180000);
  PERFORM public.checkpoint_youtube_upload_session(v_session_b, v_lease_b, 4096, 4096,
    'https://upload.example.invalid/session/y32b', true, NULL, NULL);
  PERFORM public.release_youtube_upload_session(v_session_b, v_lease_b, 'reconcile',
    'the last chunk may have been written');
  PERFORM public.settle_youtube_upload_session(v_session_b, v_lease_b, 'failed', NULL,
    'the last chunk may have been written', '{}'::jsonb);

  SELECT state INTO v_state FROM public.youtube_upload_sessions WHERE id = v_session_b;
  ASSERT v_state = 'reconcile',
    'Y32 an upload that may hold a video is left for a human';

  v_answer := public.request_post_retry(v_post_b, v_u_a, ARRAY[v_acct_b]);
  ASSERT v_answer ->> 'status' = 'refused',
    'Y32 an upload that may hold a video is never retried';

  -- AN INHERITED SESSION KEEPS ITS FENCE
  --
  -- The session is still open, so it holds a provider session that carries
  -- the old attempt's content. The admission refuses it, exactly as before.
  SELECT f.account_id, f.post_id, f.media_id
    INTO v_acct_b, v_post_b, v_media_b
    FROM pg_temp.new_youtube_fixture('y32c') f;
  v_session_b := (public.admit_youtube_upload(
      v_post_b, v_acct_b, v_u_a, v_media_b, 4096, 4096, '{}'::jsonb)
    -> 'session' ->> 'id')::uuid;
  UPDATE public.posts SET publish_requested_at = now() WHERE id = v_post_b;

  BEGIN
    PERFORM public.admit_youtube_upload(
      v_post_b, v_acct_b, v_u_a, v_media_b, 4096, 4096, '{}'::jsonb);
    RAISE EXCEPTION 'Y32 an inherited session was restarted';
  EXCEPTION WHEN SQLSTATE 'YUS04' THEN
    RAISE NOTICE 'PASS Y32: an inherited session keeps its fence';
  END;

  RAISE NOTICE 'PASS Y32: a retried upload that never sent a byte is started again';
END
$y32_safe_restart$;

-- ---------------------------------------------------------------------------
-- Y33: the terminal-result recovery.
--
-- The regression of PR441 comment 4610712974: the session was terminal and the
-- public row was still pending, and nothing settled it.
--
-- The lost-worker window: a worker that gives up releases the session into a
-- terminal state and dies before it settles the public row. The session is
-- terminal, the row is pending, and the post waits in 'processing' for an
-- outcome that never comes.
--
-- The recovery is proved here: the live lease is respected, the expired lease
-- is not, the row is closed with the reason the record supports, nothing
-- uncertain is ever retried, and the other destinations keep their receipt.
-- ---------------------------------------------------------------------------
DO $y33_terminal_recovery$
DECLARE
  v_acct_a  uuid;
  v_post_a  uuid;
  v_media_a uuid;
  v_acct_b  uuid;
  v_post_b  uuid;
  v_media_b uuid;
  v_acct_c  uuid;
  v_post_c  uuid;
  v_media_c uuid;
  v_acct_d  uuid;
  v_post_d  uuid;
  v_media_d uuid;
  v_ig      uuid := 'ed000000-0000-4000-8000-00000000000a';
  v_u_a       uuid := 'b1000000-0000-4000-8000-000000000001';
  v_session   uuid;
  v_session_b uuid;
  v_session_c uuid;
  v_session_d uuid;
  v_lease     uuid := 'ed000000-0000-4000-8000-000000000001';
  v_lease_b   uuid := 'ed000000-0000-4000-8000-000000000002';
  v_lease_c   uuid := 'ed000000-0000-4000-8000-000000000003';
  v_lease_d   uuid := 'ed000000-0000-4000-8000-000000000004';
  v_row_id    uuid;
  v_row_status text;
  v_reason    text;
  v_outcome   text;
  v_state     text;
  v_answer    jsonb;
  v_retry     jsonb;
  v_case      record;
BEGIN
  -- THE RULE
  --
  -- The outcome of a session that cannot be carried on is one rule: a video
  -- that may exist is a manual outcome, a video that cannot exist is a
  -- definitive one, and a session that was already marked for a human stays
  -- marked.
  FOR v_case IN
    SELECT * FROM (VALUES
      ('reconcile', false, 'youtube_upload_reconcile_required'),
      ('open',      true,  'youtube_upload_reconcile_required'),
      ('failed',    false, 'youtube_upload_rejected'),
      ('expired',   false, 'youtube_upload_unsent')
    ) AS c(pre_state, may_exist, reason)
  LOOP
    ASSERT (public.youtube_upload_terminal_outcome(v_case.pre_state, v_case.may_exist) ->> 'reason')
             = v_case.reason,
      'Y33 the outcome of a session that cannot be carried on follows the state and the facts';
  END LOOP;

  -- THE LOST-WORKER WINDOW
  --
  -- This scenario owns its post, its account and its media file.
  SELECT f.account_id, f.post_id, f.media_id
    INTO v_acct_a, v_post_a, v_media_a
    FROM pg_temp.new_youtube_fixture('y33') f;
  v_session := (public.admit_youtube_upload(
      v_post_a, v_acct_a, v_u_a, v_media_a, 4096, 4096, '{}'::jsonb)
    -> 'session' ->> 'id')::uuid;
  v_row_id := (SELECT platform_post_id FROM public.youtube_upload_sessions WHERE id = v_session);

  -- The worker gives up: the session is terminal, and it keeps the lease
  -- because it still has to settle the public row.
  PERFORM public.claim_youtube_upload_session(v_session, v_lease, 180000);
  PERFORM public.release_youtube_upload_session(v_session, v_lease, 'failed',
    'the provider refused the upload');

  -- And the worker dies before the settlement.
  SELECT status INTO v_row_status FROM public.platform_posts WHERE id = v_row_id;
  ASSERT v_row_status = 'pending',
    'Y33 the public row of a dead worker is still pending';
  ASSERT (SELECT status FROM public.posts WHERE id = v_post_a) = 'processing',
    'Y33 the post waits for an outcome that never comes';

  -- THE LIVE LEASE IS RESPECTED
  --
  -- The worker may still be alive: it holds the lease and it is about to
  -- settle the row itself.
  v_answer := public.recover_youtube_upload_terminal_results(5);
  ASSERT (v_answer ->> 'settled')::integer = 0,
    'Y33 a worker that still holds the lease is left alone';
  SELECT status INTO v_row_status FROM public.platform_posts WHERE id = v_row_id;
  ASSERT v_row_status = 'pending',
    'Y33 the row of a live worker is not settled';

  -- THE LEASE EXPIRES
  UPDATE public.youtube_upload_sessions
     SET lease_expires_at = now() - interval '1 minute'
   WHERE id = v_session;

  -- THE RECOVERY
  v_answer := public.recover_youtube_upload_terminal_results(5);
  ASSERT (v_answer ->> 'settled')::integer = 1,
    'Y33 the terminal session with a pending row is settled';

  SELECT status, error_message, response_data ->> 'publish_outcome'
    INTO v_row_status, v_reason, v_outcome
    FROM public.platform_posts WHERE id = v_row_id;
  ASSERT v_row_status = 'failed',
    'Y33 the pending row is closed';
  ASSERT v_reason = 'youtube_upload_rejected',
    'Y33 the row carries the stable public reason';
  ASSERT v_outcome IS NULL,
    'Y33 a proven failure is not marked as uncertain';
  ASSERT (SELECT state FROM public.youtube_upload_sessions WHERE id = v_session) = 'failed',
    'Y33 the session is terminal';
  ASSERT (SELECT status FROM public.posts WHERE id = v_post_a) = 'failed',
    'Y33 the post reaches a finite outcome';

  -- The retry is possible again: nothing ever reached the provider.
  v_retry := public.request_post_retry(v_post_a, v_u_a, ARRAY[v_acct_a]);
  ASSERT (v_retry ->> 'status') = 'accepted',
    'Y33 a proven failure may be retried';

  -- THE UNCERTAIN CASE
  --
  -- A byte reached the provider, so a video may exist. The row is closed with
  -- the manual reason and the outcome is marked as unknown, so neither the
  -- database nor the browser offers a blind retry.
  SELECT f.account_id, f.post_id, f.media_id
    INTO v_acct_b, v_post_b, v_media_b
    FROM pg_temp.new_youtube_fixture('y33b') f;
  v_session_b := (public.admit_youtube_upload(
      v_post_b, v_acct_b, v_u_a, v_media_b, 4096, 4096, '{}'::jsonb)
    -> 'session' ->> 'id')::uuid;
  PERFORM public.claim_youtube_upload_session(v_session_b, v_lease_b, 180000);
  PERFORM public.checkpoint_youtube_upload_session(v_session_b, v_lease_b, 4096, 4096,
    'https://upload.example.invalid/session/y33b', true, NULL, NULL);
  PERFORM public.release_youtube_upload_session(v_session_b, v_lease_b, 'reconcile',
    'the last chunk may have been written');
  UPDATE public.youtube_upload_sessions
     SET lease_expires_at = now() - interval '1 minute'
   WHERE id = v_session_b;

  v_answer := public.recover_youtube_upload_terminal_results(5);
  ASSERT (v_answer ->> 'manual')::integer = 1,
    'Y33 the uncertain session is closed for a human';
  SELECT status, error_message, response_data ->> 'publish_outcome'
    INTO v_row_status, v_reason, v_outcome
    FROM public.platform_posts
   WHERE id = (SELECT platform_post_id FROM public.youtube_upload_sessions WHERE id = v_session_b);
  ASSERT v_row_status = 'failed',
    'Y33 the uncertain row is closed';
  ASSERT v_reason = 'youtube_upload_reconcile_required',
    'Y33 the uncertain row carries the manual reason';
  ASSERT v_outcome = 'uncertain',
    'Y33 the uncertain row is marked as unknown';
  v_retry := public.request_post_retry(v_post_b, v_u_a, ARRAY[v_acct_b]);
  ASSERT (v_retry ->> 'status') = 'refused',
    'Y33 an uncertain upload is never retried';

  -- THE CANCELLED POST
  --
  -- The owner cancels the post. The recovery does not settle the row: a
  -- cancelled post keeps its own outcome, and the cancellation path closes the
  -- row with its own reason.
  SELECT f.account_id, f.post_id, f.media_id
    INTO v_acct_c, v_post_c, v_media_c
    FROM pg_temp.new_youtube_fixture('y33c') f;
  v_session_c := (public.admit_youtube_upload(
      v_post_c, v_acct_c, v_u_a, v_media_c, 4096, 4096, '{}'::jsonb)
    -> 'session' ->> 'id')::uuid;
  PERFORM public.claim_youtube_upload_session(v_session_c, v_lease_c, 180000);
  PERFORM public.release_youtube_upload_session(v_session_c, v_lease_c, 'failed',
    'the provider refused the upload');
  UPDATE public.posts SET status = 'failed' WHERE id = v_post_c;
  UPDATE public.youtube_upload_sessions
     SET lease_expires_at = now() - interval '1 minute'
   WHERE id = v_session_c;

  v_answer := public.recover_youtube_upload_terminal_results(5);
  SELECT status INTO v_row_status
    FROM public.platform_posts
   WHERE id = (SELECT platform_post_id FROM public.youtube_upload_sessions WHERE id = v_session_c);
  ASSERT v_row_status = 'pending',
    'Y33 the recovery does not settle the row of a cancelled post';

  -- The repair driver closes it, with the reason of the cancellation.
  v_answer := public.reconcile_youtube_upload_fanouts(5);
  SELECT status, error_message INTO v_row_status, v_reason
    FROM public.platform_posts
   WHERE id = (SELECT platform_post_id FROM public.youtube_upload_sessions WHERE id = v_session_c);
  ASSERT v_row_status = 'failed',
    'Y33 the pending row of a cancelled post is closed';
  ASSERT v_reason = 'youtube_upload_cancelled',
    'Y33 the cancelled row carries the reason of the cancellation';
  ASSERT (SELECT status FROM public.posts WHERE id = v_post_c) = 'failed',
    'Y33 the cancelled post keeps its own outcome';

  -- A LATER ATTEMPT OWNS THE POST
  --
  -- The row of a superseded attempt keeps its own outcome: the recovery does
  -- not settle it.
  SELECT f.account_id, f.post_id, f.media_id
    INTO v_acct_d, v_post_d, v_media_d
    FROM pg_temp.new_youtube_fixture('y33d') f;
  v_session_d := (public.admit_youtube_upload(
      v_post_d, v_acct_d, v_u_a, v_media_d, 4096, 4096, '{}'::jsonb)
    -> 'session' ->> 'id')::uuid;
  PERFORM public.claim_youtube_upload_session(v_session_d, v_lease_d, 180000);
  PERFORM public.release_youtube_upload_session(v_session_d, v_lease_d, 'failed',
    'the provider refused the upload');
  UPDATE public.posts SET processing_started_at = now() + interval '1 hour' WHERE id = v_post_d;
  UPDATE public.youtube_upload_sessions
     SET lease_expires_at = now() - interval '1 minute'
   WHERE id = v_session_d;

  v_answer := public.recover_youtube_upload_terminal_results(5);
  SELECT status INTO v_row_status
    FROM public.platform_posts
   WHERE id = (SELECT platform_post_id FROM public.youtube_upload_sessions WHERE id = v_session_d);
  ASSERT v_row_status = 'pending',
    'Y33 the row of a superseded attempt is left alone';

  -- THE OTHER DESTINATIONS ARE PRESERVED
  --
  -- A destination that succeeded keeps its receipt, and the post reaches the
  -- outcome that the success gives it.
  SELECT f.account_id, f.post_id, f.media_id
    INTO v_acct_a, v_post_a, v_media_a
    FROM pg_temp.new_youtube_fixture('y33e') f;
  INSERT INTO public.social_accounts
    (id, user_id, platform, platform_user_id, platform_username, access_token, is_active)
  VALUES (v_ig, v_u_a, 'instagram', 'ig-y33e', 'y33e', 'token-ig', true)
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.platform_posts (post_id, social_account_id, platform, status)
  VALUES (v_post_a, v_ig, 'instagram', 'success');
  v_session := (public.admit_youtube_upload(
      v_post_a, v_acct_a, v_u_a, v_media_a, 4096, 4096, '{}'::jsonb)
    -> 'session' ->> 'id')::uuid;
  PERFORM public.claim_youtube_upload_session(v_session, v_lease, 180000);
  PERFORM public.release_youtube_upload_session(v_session, v_lease, 'failed',
    'the provider refused the upload');
  UPDATE public.youtube_upload_sessions
     SET lease_expires_at = now() - interval '1 minute'
   WHERE id = v_session;

  v_answer := public.recover_youtube_upload_terminal_results(5);
  ASSERT (SELECT status FROM public.platform_posts
           WHERE post_id = v_post_a AND social_account_id = v_ig) = 'success',
    'Y33 the receipt of the other destination is preserved';
  ASSERT (SELECT status FROM public.posts WHERE id = v_post_a) = 'completed',
    'Y33 the post reaches the outcome the success gives it';

  RAISE NOTICE 'PASS Y33: the terminal session whose worker died is settled with a safe outcome';
END
$y33_terminal_recovery$;

ROLLBACK;

\echo '=== youtube_upload_sessions: ALL CHECKS PASSED ==='
