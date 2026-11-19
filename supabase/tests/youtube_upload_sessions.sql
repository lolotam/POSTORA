-- ============================================================================
-- supabase/tests/youtube_upload_sessions.sql
-- Migrations 20261118120000_youtube_resumable_upload_sessions.sql and
-- 20261118173000_youtube_pending_handoff_guard.sql.
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
--   Y34 ONE LOCK ORDER: the helper takes the parent before the session, it
--       re-reads the binding between them, and no writer takes a session lock
--       of its own.
--   Y35 the live authority in the last checkpoint: the chunk that completes
--       the upload is refused when the post was cancelled, edited or
--       superseded, and the refused chunk moves nothing.
--   Y36 an explicit reconcile is never taken away by a safe failure, and the
--       settled row carries the uncertain marker even when the final-byte
--       flag says false.
--   Y37 the cancellation repair is not preempted by a classification: the
--       cancelled post keeps its own outcome.
--   Y38 the repairs are bounded (the expiry reset and the exhausted
--       classification, one per pass) and the due upload work is not starved
--       by a backlog of deferred publishes.
--   Y39 a disconnected destination leaves the scope of the attempt, and its
--       possible side effect stays on record.
--   Y40 the admission takes the expected live media version, and a refused
--       admission creates nothing.
--   Y41 the query settings of the provider request travel with the session.
--   Y42 the evidence of a session survives a disconnect: the account link is
--       dropped, the session and its receipt stay.
--   Y43 the media file of an upload is one of the post's own files.
--   Y44 a retry with a replacement file is admitted: the session of the
--       previous attempt is rebound to the file the post names.
--   Y45 a session that may hold a video is never rebound.
--   Y46 the same channel is not published again after a reconnect.
--   Y47 the receipt proves ONE attempt: it answers the attempt that stored it
--       and is refused to another one, which leaves the evidence untouched.
--   Y48 the lease is stamped with the time of the grant, not with the start
--       of the transaction.
--   Y49 a file the post does not name is refused, even beside a NULL element
--       in the list of the post's own files.
--   Y50 an upload that sent a byte is not a definitive failure: the settlement
--       asks about the video the same way the terminal recovery does.
--   Y51 the stale sessions do not take the slots of the bounded repair scan.
--   Y52 a slot that no upload wanted is left to the notification.
--   Y53 the receipt survives a disconnect, and the parent keeps its result.
--   Y54 the mark of a human survives a disconnect.
--   Y55 the lost answer of a settlement that landed does not bring a completed
--       parent back to processing: the guarded restoration refuses it, and the
--       old restoration is what would have done it.
--   Y56 a handoff that is genuinely pending keeps the parent processing.
--   Y57 a parent that rolled up while its row was still open is restored.
--   Y58 the generic restoration of the Threads and fan-out paths is untouched.
--   Y59 the mime type the caller gave is kept with the upload settings.
--   Y60 the media version fence fails closed: a session or a live media that
--       carries no version is refused, and the versions are compared as they
--       are, never with a missing one read as the first.
--   Y61 a new session needs an authorized target: the admission refuses an
--       account the post no longer selects.
--   Y62 a session without an attempt is refused: the attempt fences fail
--       closed, and the row cannot be carried on.
--   Y63 a retry with a new version of the same file is admitted: the session is
--       rebound to the version the file carries now, and the worker has to name
--       the version it read.
--   Y64 the continuation budget is read before anything is written: a budget of
--       zero or less is refused and classifies nothing.
--   Y65 the recovery helpers are service role only, in the catalog itself.
--   Y66 a cancellation after the final durable intent keeps the uncertainty:
--       the session goes to reconcile, not to a definitive failure.
--   Y67 the outcome of a destination that goes with the account is kept on the
--       post: the video id of a published video and the marker of an uncertain
--       upload both outlive the result row they were written on.
--   Y68 the settlement fence fails closed, and a candidate the owner poisoned
--       is refused, never raised: each assertion reaches the field it names.
--   Y69 the terminal scan leaves out the sessions it cannot classify, even
--       when the parent carries no attempt either: the guard alone decides.
--   Y70 the disconnect settles the session under the shared lock: the scope
--       goes through the helper, and the session row and its receipt are both
--       read under it.
--   Y71 a scope with a JSON null or a malformed element is refused, never
--       emptied: the NULL does not poison the comparison of the valid ones.
--   Y72 a timestamp with an invalid calendar date is a non-match, not an
--       abort: the candidate, the rollup marker and a deferred row attempt
--       are all read through the validating conversion.
--   Y73 the cancellation scan leaves out the sessions without an attempt, so
--       their refusal does not starve the cancelled rows behind them.
--   Y74 the fanout scan leaves out a candidate it can only refuse, so a
--       poisoned scope does not starve the fanouts behind it.
--   Y75 the disconnect scan takes the parents in one shared order, so two
--       disconnects cannot wait on each other holding one parent lock apiece.
--   Y76 the recovery reads its session under the shared lock: the scope goes
--       through the helper and the row is read again before the authority
--       gate and the closure.
--   Y77 the identity of a media row an open upload reads is fenced in the
--       database: a change to its bucket, path or workspace bumps the content
--       version, and the session fence refuses the upload.
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
  -- suite opens several posts per scenario. The quota is a counter on the
  -- owner, so it is raised here rather than worked around.
  INSERT INTO public.user_quotas
    (user_id, max_posts_per_day, max_posts_per_month, max_media_uploads_per_day)
  VALUES
    (v_u_a, 1000, 5000, 10000),
    (v_u_b, 1000, 5000, 10000)
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
DECLARE
  v_signature text;
  v_privilege text;
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

  -- EVERY TABLE PRIVILEGE, FOR BOTH BROWSER ROLES
  --
  -- The table is RLS on and carries no policy, so a browser role that may
  -- not even read it may certainly not write it. A privilege granted by
  -- accident -- INSERT, TRUNCATE, REFERENCES -- is a hole that the row level
  -- security does not close, so the whole set is checked for every role
  -- instead of the two or three that were named by hand.
  FOR v_privilege IN
    SELECT unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'])
  LOOP
    ASSERT NOT has_table_privilege('anon', 'public.youtube_upload_sessions', v_privilege),
      'Y1 anon holds no ' || v_privilege || ' on the session table';
    ASSERT NOT has_table_privilege('authenticated', 'public.youtube_upload_sessions', v_privilege),
      'Y1 authenticated holds no ' || v_privilege || ' on the session table';
  END LOOP;

  ASSERT NOT has_function_privilege('anon',
      'public.admit_youtube_upload(uuid,uuid,uuid,uuid,bigint,bigint,jsonb,timestamptz,uuid[],timestamptz,jsonb,integer,jsonb)', 'EXECUTE'),
    'Y1 anon may not admit an upload';
  ASSERT NOT has_function_privilege('authenticated',
      'public.admit_youtube_upload(uuid,uuid,uuid,uuid,bigint,bigint,jsonb,timestamptz,uuid[],timestamptz,jsonb,integer,jsonb)', 'EXECUTE'),
    'Y1 authenticated may not admit an upload';
  ASSERT NOT has_function_privilege('authenticated',
      'public.checkpoint_youtube_upload_session(uuid,uuid,bigint,bigint,text,boolean,timestamptz,text,boolean)', 'EXECUTE'),
    'Y1 authenticated may not checkpoint a session';
  ASSERT NOT has_function_privilege('anon',
      'public.youtube_upload_lock_scope(uuid)', 'EXECUTE'),
    'Y1 anon may not lock the scope of a session';
  ASSERT NOT has_function_privilege('authenticated',
      'public.youtube_upload_lock_scope(uuid)', 'EXECUTE'),
    'Y1 authenticated may not lock the scope of a session';
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
      'public.admit_youtube_upload(uuid,uuid,uuid,uuid,bigint,bigint,jsonb,timestamptz,uuid[],timestamptz,jsonb,integer,jsonb)', 'EXECUTE'),
    'Y1 the service role may admit an upload';
  ASSERT has_function_privilege('service_role',
      'public.checkpoint_youtube_upload_session(uuid,uuid,bigint,bigint,text,boolean,timestamptz,text,boolean)', 'EXECUTE'),
    'Y1 the service role may checkpoint a session';
  ASSERT has_function_privilege('service_role',
      'public.youtube_upload_lock_scope(uuid)', 'EXECUTE'),
    'Y1 the service role may lock the scope of a session';
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

  -- THE WHOLE SURFACE IS SERVICE ROLE ONLY
  --
  -- The list above names the functions one by one, and a function that is
  -- added later would not be in it. So the matrix is read from the catalog
  -- instead: every function of this feature, and every function the feature
  -- borrowed from the publishing seam, is checked for both browser roles and
  -- for the service role.
  --
  -- The check cannot drift away from the surface: a function that is added
  -- without a grant is caught by the day it is added.
  FOR v_signature IN
    SELECT p.oid::regprocedure::text
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND (p.proname LIKE '%youtube_upload%'
            OR p.proname IN (
              'partner_close_ambiguous_destination',
              'request_post_retry',
              'claim_post_completion_work',
              'sweep_stale_processing_posts'
            ))
  LOOP
    ASSERT NOT has_function_privilege('anon', v_signature, 'EXECUTE'),
      'Y1 anon may not execute ' || v_signature;
    ASSERT NOT has_function_privilege('authenticated', v_signature, 'EXECUTE'),
      'Y1 authenticated may not execute ' || v_signature;
    ASSERT has_function_privilege('service_role', v_signature, 'EXECUTE'),
      'Y1 the service role may execute ' || v_signature;
  END LOOP;

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
  --
  -- The token is the OWNER's token, and the owner's lease has expired. That
  -- is the case that happens: the worker was slow, its lease ran out, and it
  -- comes back to write anyway. A token that never held the lease is a
  -- different case, and it is not what proves the fence.
  UPDATE public.youtube_upload_sessions
     SET lease_expires_at = now() - interval '1 second'
   WHERE id = v_session;

  BEGIN
    PERFORM public.checkpoint_youtube_upload_session(v_session, v_lease_a, 10, 10, NULL, NULL, NULL, NULL);
    RAISE EXCEPTION 'Y4 a stale worker checkpointed';
  EXCEPTION WHEN SQLSTATE 'YUS09' THEN
    RAISE NOTICE 'PASS Y4: a stale lease cannot checkpoint';
  END;

  BEGIN
    PERFORM public.complete_youtube_upload_session(v_session, v_lease_a, 'video-stale');
    RAISE EXCEPTION 'Y4 a stale worker completed';
  EXCEPTION WHEN SQLSTATE 'YUS09' THEN
    RAISE NOTICE 'PASS Y4: a stale lease cannot complete';
  END;

  BEGIN
    PERFORM public.release_youtube_upload_session(v_session, v_lease_a, 'failed', 'stale');
    RAISE EXCEPTION 'Y4 a stale worker released';
  EXCEPTION WHEN SQLSTATE 'YUS09' THEN
    RAISE NOTICE 'PASS Y4: a stale lease cannot release';
  END;

  BEGIN
    PERFORM public.settle_youtube_upload_session(v_session, v_lease_a, 'failed', NULL, 'stale', '{}'::jsonb);
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
  -- The test puts the pinned version back. The identity guard keeps the
  -- version of a row an open session reads from going back, so the reset
  -- runs with the triggers off (superuser only, this transaction only).
  SET LOCAL session_replication_role = replica;
  UPDATE public.media_files SET current_object_version = 1 WHERE id = v_media_a;
  SET LOCAL session_replication_role = origin;

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
  v_attempt_a timestamptz;
  v_attempt_b timestamptz;
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

  -- THE POST IS WORKED ON AGAIN
  --
  -- The post is picked up by a new attempt. The CONTENT of the post did not
  -- change, so the fence of the session is still the fence of the live post:
  -- the fence is the content, and the attempt is not part of it.
  SELECT p.processing_started_at INTO v_attempt_a
    FROM public.posts p WHERE p.id = v_post_a;
  v_attempt_b := v_attempt_a + interval '1 minute';
  UPDATE public.posts
     SET processing_started_at = v_attempt_b
   WHERE id = v_post_a;

  -- A WORKER THAT STILL OWNS THE SESSION IS NOT RESTARTED
  --
  -- The worker is about to settle the session, and a restart under it would
  -- settle the new attempt with the old outcome. The session keeps its
  -- provider session, and the claim refuses it until the lease is gone.
  v_admitted := public.admit_youtube_upload(v_post_a, v_acct_a, v_u_a, v_media_a, 4096, 4096, '{}'::jsonb);
  ASSERT (v_admitted -> 'session' ->> 'session_uri') IS NOT NULL,
    'Y8 a session a worker still owns is not started again';

  -- The attempt of the new worker did NOT take the session over. The session
  -- keeps the attempt of the worker that owns it, because that worker is
  -- about to settle it, and a takeover would settle the new attempt with the
  -- old outcome.
  ASSERT (v_admitted -> 'session' ->> 'attempt_started_at') = to_jsonb(v_attempt_a)#>>'{}',
    'Y8 a session a worker still owns keeps the attempt it has';
  ASSERT (v_admitted -> 'session' ->> 'attempt_started_at')
         IS DISTINCT FROM to_jsonb(v_attempt_b)#>>'{}',
    'Y8 the new attempt did not take over a session a worker still owns';

  -- The lease is gone: the session is admitted again.
  UPDATE public.youtube_upload_sessions
     SET lease_expires_at = now() - interval '1 second'
   WHERE id = v_session;

  v_admitted := public.admit_youtube_upload(v_post_a, v_acct_a, v_u_a, v_media_a, 4096, 4096, '{}'::jsonb);
  ASSERT (v_admitted -> 'session' ->> 'state') = 'open',
    'Y8 an expired session that never wrote a byte is admitted again';
  ASSERT (v_admitted -> 'session' ->> 'session_uri') IS NULL,
    'Y8 the admitted again session has no provider session';
  ASSERT (v_admitted -> 'session' ->> 'confirmed_bytes')::bigint = 0,
    'Y8 the admitted again session starts from the beginning';
  ASSERT (v_admitted -> 'session' ->> 'attempt_started_at') = to_jsonb(v_attempt_b)#>>'{}',
    'Y8 the admitted again session belongs to the new attempt';

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
  v_uri       integer;
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
  -- property is read out of the same answer -- including the keys the answer
  -- carries. A second claim would take the lease again and prove nothing.
  UPDATE public.youtube_upload_sessions
     SET lease_expires_at = now() - interval '1 second'
   WHERE id = v_session;
  SELECT
    count(*) FILTER (WHERE session_id = v_session),
    count(*) FILTER (WHERE session_id = v_session AND lease_token IS NOT NULL),
    count(*) FILTER (WHERE session_id = v_session AND attempt_started_at IS NOT NULL),
    count(*) FILTER (WHERE session_id = v_session AND to_jsonb(ys) ? 'session_uri')
    INTO v_named, v_token, v_attempt, v_uri
    FROM public.claim_youtube_upload_sessions(5, 180000, 24) ys;
  ASSERT v_named = 1,
    'Y9 a due session with no live lease is handed out';
  ASSERT v_token = 1,
    'Y9 the claim carries the lease token';
  ASSERT v_attempt = 1,
    'Y9 the claim carries the attempt';

  -- The session URI is NOT in the claim.
  ASSERT v_uri = 0,
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
  --
  -- The account is put BACK into the selection first. The scenario above took
  -- it out, and a claim would refuse that with the same code, so a refusal
  -- here would prove nothing about the platform: the account was refused
  -- either way. The selection is restored so that this refusal can only be
  -- about the platform the post dropped.
  UPDATE public.posts
     SET metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
           'selected_account_ids', jsonb_build_array(v_acct_a::text))
   WHERE id = v_post_a;
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
  --
  -- The lease of the previous claim is expired first, so the session is
  -- eligible in every other way and the ONLY reason it is not handed out is
  -- the settled row.
  UPDATE public.platform_posts
     SET status = 'success', platform_post_id = 'yt-video-fixture-3'
   WHERE post_id = v_post_a AND social_account_id = v_acct_a;
  UPDATE public.youtube_upload_sessions
     SET lease_expires_at = now() - interval '1 second'
   WHERE id = v_session;
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
  v_session_b uuid;
  v_acct_b    uuid;
  v_post_b    uuid;
  v_media_b   uuid;
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
  --
  -- The session is REAL: it was admitted, and it never received a receipt.
  -- A random id would only prove that the function refuses a session that is
  -- not there, which is a different thing.
  SELECT f.account_id, f.post_id, f.media_id
    INTO v_acct_b, v_post_b, v_media_b
    FROM pg_temp.new_youtube_fixture('y18b') f;
  v_session_b := (public.admit_youtube_upload(
    v_post_b, v_acct_b, v_u_a, v_media_b, 4096, 4096, '{}'::jsonb)
    -> 'session' ->> 'id')::uuid;

  BEGIN
    PERFORM public.project_youtube_upload_receipt(v_session_b);
    RAISE EXCEPTION 'Y18 a session without a receipt was projected';
  EXCEPTION WHEN SQLSTATE 'YUS05' THEN
    RAISE NOTICE 'PASS Y18: a session without a receipt has nothing to project';
  END;

  -- A session that is not there at all is refused as well.
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

  -- THE CLOSURE COMES BEFORE THE SETTLEMENT
  --
  -- The pending YouTube row is what keeps the generic sweeper from reading
  -- the absence of the sibling row as a destination that never started. So
  -- the scope has to be closed while that row is still PENDING: settling it
  -- first would open exactly the window the sweeper reads, and the test would
  -- pass even if the production order were reversed.
  --
  -- The sibling has no row. Its outcome is unknown, so it is terminalised
  -- with a reason that is not a retry offer.
  v_recovered := public.recover_youtube_upload_fanout(v_session, NULL);
  ASSERT (v_recovered ->> 'recovered') = 'true',
    'Y25 the fanout is closed once the scope is complete';
  ASSERT (v_recovered -> 'unknown_account_ids') @> to_jsonb(ARRAY[v_ig]),
    'Y25 the unknown destination is named';

  -- The YouTube row was still pending while the scope was closed.
  ASSERT (SELECT status FROM public.platform_posts
           WHERE id = (SELECT platform_post_id FROM public.youtube_upload_sessions WHERE id = v_session)) = 'pending',
    'Y25 the scope is closed while the YouTube row is still pending';

  PERFORM public.settle_youtube_upload_session(v_session, v_lease, 'success', 'yt-video-y25');

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

-- ---------------------------------------------------------------------------
-- Y34: ONE LOCK ORDER.
--
-- Every writer of a session takes the parent, then the session, then the
-- result. The order lives in ONE place -- the lock helper -- so it is proved
-- here once:
--
--   * the helper takes the parent before the session;
--   * it re-reads the binding between the two locks, so a session that was
--     moved to another parent cannot be written through the old one;
--   * no writer takes a session lock of its own, so no writer can invert the
--     order and no two of them can deadlock.
--
-- The order is a property of the code, so it is proved on the code.
-- ---------------------------------------------------------------------------
DO $y34_lock_order$
DECLARE
  v_def    text;
  v_part   text;
  v_writer text;
  v_writers text[] := ARRAY[
    'settle_youtube_upload_session',
    'project_youtube_upload_receipt',
    'youtube_upload_terminalize_cancelled',
    'youtube_upload_classify_terminal'];
  v_acct_a  uuid;
  v_post_a  uuid;
  v_media_a uuid;
  v_u_a     uuid := 'b1000000-0000-4000-8000-000000000001';
  v_session uuid;
  v_scope   jsonb;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'youtube_upload_lock_scope';
  ASSERT v_def IS NOT NULL,
    'Y34 the lock helper exists';

  -- The parent is locked before the session.
  --
  -- The positions are checked on their own first: a comparison of two
  -- positions says nothing when one of them is missing. A helper that lost
  -- the parent lock would answer 0 for the parent and a positive number for
  -- the session, and 0 < positive is TRUE -- the order would look right
  -- while the parent was not locked at all.
  ASSERT position('FROM public.posts p WHERE p.id = v_post_id FOR UPDATE' IN v_def) > 0,
    'Y34 the helper locks the parent';
  ASSERT position('FROM public.youtube_upload_sessions s WHERE s.id = p_session_id FOR UPDATE' IN v_def) > 0,
    'Y34 the helper locks the session';
  ASSERT position('FROM public.posts p WHERE p.id = v_post_id FOR UPDATE' IN v_def)
         < position('FROM public.youtube_upload_sessions s WHERE s.id = p_session_id FOR UPDATE' IN v_def),
    'Y34 the helper takes the parent before the session';

  -- The binding is read again under both locks.
  ASSERT position('session_rebound' IN v_def) > 0,
    'Y34 the helper re-reads the binding between the two locks';

  FOREACH v_writer IN ARRAY v_writers LOOP
    SELECT pg_get_functiondef(p.oid) INTO v_def
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = v_writer;
    ASSERT v_def IS NOT NULL,
      'Y34 the writer exists';
    ASSERT position('youtube_upload_lock_scope(p_session_id)' IN v_def) > 0,
      'Y34 the writer takes its scope through the helper';

    -- No part of the writer may take the session lock itself -- neither
    -- before the helper nor after it. The helper owns that lock, and a
    -- second one in the writer would be an inversion: the writer would hold
    -- the session while it waits for the parent.
    --
    -- The whole body is read, because the part BEFORE the helper is where a
    -- lock taken early would hide: the helper would then wait for the parent
    -- while the writer already holds the session.
    --
    -- The result row may be locked: that is the third step of the order, not
    -- an inversion.
    FOR v_part IN SELECT unnest(string_to_array(v_def, ';')) LOOP
      IF position('FOR UPDATE' IN v_part) > 0 THEN
        ASSERT position('youtube_upload_sessions' IN v_part) = 0,
          'Y34 the writer does not take the session lock itself';
      END IF;
    END LOOP;
  END LOOP;

  -- The helper answers for a live session.
  SELECT f.account_id, f.post_id, f.media_id
    INTO v_acct_a, v_post_a, v_media_a
    FROM pg_temp.new_youtube_fixture('y34') f;
  v_session := (public.admit_youtube_upload(
      v_post_a, v_acct_a, v_u_a, v_media_a, 4096, 4096, '{}'::jsonb)
    -> 'session' ->> 'id')::uuid;

  v_scope := public.youtube_upload_lock_scope(v_session);
  ASSERT (v_scope ->> 'locked')::boolean,
    'Y34 the helper locks the scope of a live session';
  ASSERT (v_scope ->> 'post_id')::uuid = v_post_a,
    'Y34 the helper names the parent it locked';

  -- A session that is not there has no scope.
  v_scope := public.youtube_upload_lock_scope(gen_random_uuid());
  ASSERT NOT (v_scope ->> 'locked')::boolean,
    'Y34 the helper refuses a session that is not there';
  ASSERT (v_scope ->> 'reason') = 'session_missing',
    'Y34 the refusal says the session is missing';

  RAISE NOTICE 'PASS Y34: one lock order, owned by one helper';
END
$y34_lock_order$;

-- ---------------------------------------------------------------------------
-- Y35: THE LIVE AUTHORITY IN THE LAST CHECKPOINT.
--
-- The advisory preflight that ran before the chunk was read is not enough: a
-- slow read can be long enough for the customer to cancel the post, to edit it
-- or to start another attempt. So the live authority is checked again in the
-- last statement before the bytes are written.
--
-- It is checked on the chunk that COMPLETES the upload, because that is the
-- write that can publish a video: the chunks before it only fill a provider
-- session that is discarded when it is not finished.
--
-- The refused chunk moves nothing: the offsets, the session URI and the
-- uncertainty are exactly what they were.
-- ---------------------------------------------------------------------------
DO $y35_authority$
DECLARE
  v_acct_a  uuid;
  v_post_a  uuid;
  v_media_a uuid;
  v_u_a     uuid := 'b1000000-0000-4000-8000-000000000001';
  v_session uuid;
  v_lease   uuid := 'f5000000-0000-4000-8000-000000000001';
BEGIN
  -- This scenario owns its post, its account and its media file.
  SELECT f.account_id, f.post_id, f.media_id
    INTO v_acct_a, v_post_a, v_media_a
    FROM pg_temp.new_youtube_fixture('y35') f;
  v_session := (public.admit_youtube_upload(
      v_post_a, v_acct_a, v_u_a, v_media_a, 4096, 4096, '{}'::jsonb)
    -> 'session' ->> 'id')::uuid;
  PERFORM public.claim_youtube_upload_session(v_session, v_lease, 180000);

  -- A chunk that does not complete the upload cannot publish a video: it only
  -- fills a provider session that is discarded when the upload is not finished.
  PERFORM public.checkpoint_youtube_upload_session(v_session, v_lease, 1024, 1024,
    'https://upload.example.invalid/session/y35', false, NULL, NULL);
  ASSERT (SELECT bytes_sent FROM public.youtube_upload_sessions WHERE id = v_session) = 1024,
    'Y35 the chunk that does not complete the upload is written';

  -- The customer cancels the post while the worker holds the session.
  UPDATE public.posts SET status = 'failed' WHERE id = v_post_a;

  BEGIN
    PERFORM public.checkpoint_youtube_upload_session(v_session, v_lease, 4096, 4096,
      'https://upload.example.invalid/session/y35', true, NULL, NULL);
    RAISE EXCEPTION 'Y35 the completing chunk was written after the post was cancelled';
  EXCEPTION WHEN SQLSTATE 'YUS12' THEN
    RAISE NOTICE 'PASS Y35: the completing chunk is refused after the post was cancelled';
  END;

  -- The refused chunk moved nothing.
  ASSERT (SELECT bytes_sent FROM public.youtube_upload_sessions WHERE id = v_session) = 1024,
    'Y35 the refused chunk did not move the offsets';
  ASSERT (SELECT video_may_exist FROM public.youtube_upload_sessions WHERE id = v_session) = false,
    'Y35 the refused chunk did not mark a video as possible';
  ASSERT (SELECT confirmed_bytes FROM public.youtube_upload_sessions WHERE id = v_session) = 1024,
    'Y35 the refused chunk did not move the confirmed offset';
END
$y35_authority$;

-- ---------------------------------------------------------------------------
-- Y35b: THE LIVE AUTHORITY AFTER AN EDIT AND AFTER A NEW ATTEMPT.
--
-- The same gate, seen from the two other ways the world can change while the
-- chunk is being read: the post is edited, and another attempt of the post
-- starts.
-- ---------------------------------------------------------------------------
DO $y35b_authority$
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
  v_lease   uuid := 'f5000000-0000-4000-8000-000000000002';
  v_lease_b uuid := 'f5000000-0000-4000-8000-000000000003';
BEGIN
  -- The edited post.
  SELECT f.account_id, f.post_id, f.media_id
    INTO v_acct_a, v_post_a, v_media_a
    FROM pg_temp.new_youtube_fixture('y35b') f;
  v_session := (public.admit_youtube_upload(
      v_post_a, v_acct_a, v_u_a, v_media_a, 4096, 4096, '{}'::jsonb)
    -> 'session' ->> 'id')::uuid;
  PERFORM public.claim_youtube_upload_session(v_session, v_lease, 180000);

  UPDATE public.posts SET caption = 'A video, edited' WHERE id = v_post_a;
  BEGIN
    PERFORM public.checkpoint_youtube_upload_session(v_session, v_lease, 4096, 4096,
      'https://upload.example.invalid/session/y35b', true, NULL, NULL);
    RAISE EXCEPTION 'Y35b the completing chunk was written after the post was edited';
  EXCEPTION WHEN SQLSTATE 'YUS04' THEN
    RAISE NOTICE 'PASS Y35b: the completing chunk is refused after the post was edited';
  END;
  ASSERT (SELECT bytes_sent FROM public.youtube_upload_sessions WHERE id = v_session) = 0,
    'Y35b the refused chunk did not move the offsets';

  -- The superseded attempt.
  SELECT f.account_id, f.post_id, f.media_id
    INTO v_acct_b, v_post_b, v_media_b
    FROM pg_temp.new_youtube_fixture('y35c') f;
  v_session_b := (public.admit_youtube_upload(
      v_post_b, v_acct_b, v_u_a, v_media_b, 4096, 4096, '{}'::jsonb)
    -> 'session' ->> 'id')::uuid;
  PERFORM public.claim_youtube_upload_session(v_session_b, v_lease_b, 180000);

  -- Another attempt of the post starts. The whole suite is one transaction, so
  -- now() is the same clock for every statement: the new attempt needs the
  -- wall clock to be a different moment.
  UPDATE public.posts SET processing_started_at = clock_timestamp() WHERE id = v_post_b;
  BEGIN
    PERFORM public.checkpoint_youtube_upload_session(v_session_b, v_lease_b, 4096, 4096,
      'https://upload.example.invalid/session/y35c', true, NULL, NULL);
    RAISE EXCEPTION 'Y35b the completing chunk was written by an older attempt';
  EXCEPTION WHEN SQLSTATE 'YUS11' THEN
    RAISE NOTICE 'PASS Y35b: the completing chunk is refused after a new attempt started';
  END;
  ASSERT (SELECT bytes_sent FROM public.youtube_upload_sessions WHERE id = v_session_b) = 0,
    'Y35b the refused chunk did not move the offsets of the older attempt';
END
$y35b_authority$;

-- ---------------------------------------------------------------------------
-- Y36: AN EXPLICIT RECONCILE IS NEVER TAKEN AWAY.
--
-- A session that was already marked for a human keeps that mark: a failure
-- must never turn a manual outcome into a safe one, because the mark is what
-- keeps a second video off the channel.
--
-- The public row carries the marker too, and it carries it even when the
-- final-byte flag says false: the marker is the row's own record of what
-- happened, and it is what the retry gate and the page read. A proven failure
-- carries no marker, so it stays retryable.
-- ---------------------------------------------------------------------------
DO $y36_uncertain$
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
  v_lease   uuid := 'f6000000-0000-4000-8000-000000000001';
  v_lease_b uuid := 'f6000000-0000-4000-8000-000000000002';
  v_state   text;
  v_outcome text;
  v_retry   jsonb;
BEGIN
  -- The session that was marked for a human.
  SELECT f.account_id, f.post_id, f.media_id
    INTO v_acct_a, v_post_a, v_media_a
    FROM pg_temp.new_youtube_fixture('y36') f;
  v_session := (public.admit_youtube_upload(
      v_post_a, v_acct_a, v_u_a, v_media_a, 4096, 4096, '{}'::jsonb)
    -> 'session' ->> 'id')::uuid;
  PERFORM public.claim_youtube_upload_session(v_session, v_lease, 180000);

  -- The worker cannot tell whether the last chunk landed, so it marks the
  -- session for a human. No byte ever reached the provider, and the
  -- final-byte flag says false.
  PERFORM public.release_youtube_upload_session(v_session, v_lease, 'reconcile',
    'the last chunk may have been written');
  ASSERT (SELECT state FROM public.youtube_upload_sessions WHERE id = v_session) = 'reconcile',
    'Y36 the session is marked for a human';
  ASSERT (SELECT video_may_exist FROM public.youtube_upload_sessions WHERE id = v_session) = false,
    'Y36 the final-byte flag says false';

  -- The settlement that follows is a failure, and it must not take the mark
  -- away.
  PERFORM public.settle_youtube_upload_session(v_session, v_lease, 'failed', NULL,
    'the provider refused the upload', '{}'::jsonb);

  SELECT state INTO v_state FROM public.youtube_upload_sessions WHERE id = v_session;
  ASSERT v_state = 'reconcile',
    'Y36 the explicit reconcile is not replaced with a safe failure';

  -- The public row carries the marker, even though the final-byte flag is false.
  SELECT response_data ->> 'publish_outcome' INTO v_outcome
    FROM public.platform_posts WHERE id =
      (SELECT platform_post_id FROM public.youtube_upload_sessions WHERE id = v_session);
  ASSERT v_outcome = 'uncertain',
    'Y36 the settled row carries the uncertain marker';
  ASSERT (SELECT status FROM public.platform_posts
           WHERE id = (SELECT platform_post_id FROM public.youtube_upload_sessions WHERE id = v_session))
           = 'failed',
    'Y36 the settled row is a failure';

  -- The marker is durable: the retry gate refuses the destination.
  v_retry := public.request_post_retry(v_post_a, v_u_a, ARRAY[v_acct_a]);
  ASSERT (v_retry ->> 'status') = 'refused',
    'Y36 the uncertain outcome is not retried';
  ASSERT (v_retry ->> 'reason') = 'no_targets',
    'Y36 the refusal says there is nothing safe to retry';

  -- The proven failure: nothing ever reached the provider.
  SELECT f.account_id, f.post_id, f.media_id
    INTO v_acct_b, v_post_b, v_media_b
    FROM pg_temp.new_youtube_fixture('y36b') f;
  v_session_b := (public.admit_youtube_upload(
      v_post_b, v_acct_b, v_u_a, v_media_b, 4096, 4096, '{}'::jsonb)
    -> 'session' ->> 'id')::uuid;
  PERFORM public.claim_youtube_upload_session(v_session_b, v_lease_b, 180000);
  PERFORM public.release_youtube_upload_session(v_session_b, v_lease_b, 'failed',
    'the provider refused the upload');
  PERFORM public.settle_youtube_upload_session(v_session_b, v_lease_b, 'failed', NULL,
    'the provider refused the upload', '{}'::jsonb);

  SELECT state INTO v_state FROM public.youtube_upload_sessions WHERE id = v_session_b;
  ASSERT v_state = 'failed',
    'Y36 the proven failure is a failed session';
  SELECT response_data ->> 'publish_outcome' INTO v_outcome
    FROM public.platform_posts WHERE id =
      (SELECT platform_post_id FROM public.youtube_upload_sessions WHERE id = v_session_b);
  ASSERT v_outcome IS NULL,
    'Y36 the proven failure carries no marker';
  v_retry := public.request_post_retry(v_post_b, v_u_a, ARRAY[v_acct_b]);
  ASSERT (v_retry ->> 'status') = 'accepted',
    'Y36 the proven failure stays retryable';

  RAISE NOTICE 'PASS Y36: an explicit reconcile is never taken away by a safe failure';
END
$y36_uncertain$;

-- ---------------------------------------------------------------------------
-- Y37: THE CANCELLED REPAIR IS NOT PREEMPTED.
--
-- A post that was cancelled keeps its own outcome, and its pending row is
-- closed by the cancellation repair. A classification that settled the row
-- first would take the repair's place: the row would carry the outcome of the
-- upload instead of the outcome of the cancellation.
--
-- So a post that is no longer being processed is left alone, state and all.
-- The repair finds the session by its state and closes the row itself.
-- ---------------------------------------------------------------------------
DO $y37_cancelled$
DECLARE
  v_acct_a  uuid;
  v_post_a  uuid;
  v_media_a uuid;
  v_u_a     uuid := 'b1000000-0000-4000-8000-000000000001';
  v_session uuid;
  v_lease   uuid := 'f7000000-0000-4000-8000-000000000001';
  v_row_id  uuid;
  v_class   jsonb;
  v_repair  jsonb;
BEGIN
  -- This scenario owns its post, its account and its media file.
  SELECT f.account_id, f.post_id, f.media_id
    INTO v_acct_a, v_post_a, v_media_a
    FROM pg_temp.new_youtube_fixture('y37') f;
  v_session := (public.admit_youtube_upload(
      v_post_a, v_acct_a, v_u_a, v_media_a, 4096, 4096, '{}'::jsonb)
    -> 'session' ->> 'id')::uuid;
  v_row_id := (SELECT platform_post_id FROM public.youtube_upload_sessions WHERE id = v_session);
  PERFORM public.claim_youtube_upload_session(v_session, v_lease, 180000);

  -- The worker gave up, and died before it settled the public row. Its lease
  -- runs out with the worker.
  PERFORM public.release_youtube_upload_session(v_session, v_lease, 'failed',
    'the provider refused the upload');
  UPDATE public.youtube_upload_sessions
     SET lease_expires_at = now() - interval '1 minute'
   WHERE id = v_session;

  -- The customer cancels the post.
  UPDATE public.posts SET status = 'failed' WHERE id = v_post_a;

  -- The classification does not touch it.
  v_class := public.youtube_upload_classify_terminal(v_session);
  ASSERT (v_class ->> 'classified')::boolean IS FALSE,
    'Y37 the classification does not claim a cancelled post';
  ASSERT (v_class ->> 'reason') = 'post_not_processing',
    'Y37 the classification says the post is not being processed';
  ASSERT (SELECT state FROM public.youtube_upload_sessions WHERE id = v_session) = 'failed',
    'Y37 the classification leaves the state of the session alone';
  ASSERT (SELECT status FROM public.platform_posts WHERE id = v_row_id) = 'pending',
    'Y37 the classification does not settle the row of a cancelled post';

  -- The batch claim does not touch it either.
  PERFORM public.claim_youtube_upload_sessions(20, 180000, 24);
  ASSERT (SELECT status FROM public.platform_posts WHERE id = v_row_id) = 'pending',
    'Y37 the batch claim does not settle the row of a cancelled post';

  -- The cancellation repair closes it, with the outcome of the cancellation.
  v_repair := public.reconcile_youtube_upload_fanouts(5);
  ASSERT (SELECT status FROM public.platform_posts WHERE id = v_row_id) = 'failed',
    'Y37 the cancellation repair closes the pending row';
  ASSERT (SELECT error_message FROM public.platform_posts WHERE id = v_row_id)
           = 'youtube_upload_cancelled',
    'Y37 the closed row carries the reason of the cancellation';
  ASSERT (SELECT response_data ->> 'publish_outcome' FROM public.platform_posts WHERE id = v_row_id)
           = 'cancelled',
    'Y37 the closed row carries the outcome of the cancellation';

  -- The post keeps the outcome the owner gave it.
  ASSERT (SELECT status FROM public.posts WHERE id = v_post_a) = 'failed',
    'Y37 the cancelled post keeps its own outcome';

  RAISE NOTICE 'PASS Y37: the cancellation repair is not preempted by a classification';
END
$y37_cancelled$;

-- ---------------------------------------------------------------------------
-- Y38: THE REPAIRS ARE BOUNDED, AND NO WORK IS STARVED.
--
-- The expiry reset and the exhausted classification are repairs that run over
-- a backlog. A backlog must not hold a lock on every session of the table, and
-- it must not take the whole batch either: the work that is due has to be
-- claimed as well.
--
-- So the reset is bounded and skips the locked rows, the classification is
-- bounded and locks the parent, and the shared claim limit keeps a slot for
-- the upload work that is due.
-- ---------------------------------------------------------------------------
DO $y38_bounded$
DECLARE
  v_acct    uuid;
  v_post    uuid;
  v_media   uuid;
  v_u_a     uuid := 'b1000000-0000-4000-8000-000000000001';
  v_session uuid;
  v_lease   uuid := 'f8000000-0000-4000-8000-000000000001';
  v_expired uuid[] := ARRAY[]::uuid[];
  v_tired   uuid[] := ARRAY[]::uuid[];
  v_before  integer;
  v_after   integer;
  v_total   integer;
  v_deferred integer;
  v_uploads integer;
  v_ig      uuid;
  v_i       integer;
BEGIN
  -- Three sessions whose provider session is gone, and no byte ever reached
  -- it: the expiry reset may reopen them.
  FOR i IN 1..3 LOOP
    SELECT f.account_id, f.post_id, f.media_id
      INTO v_acct, v_post, v_media
      FROM pg_temp.new_youtube_fixture('y38e' || i::text) f;
    v_session := (public.admit_youtube_upload(
        v_post, v_acct, v_u_a, v_media, 4096, 4096, '{}'::jsonb)
      -> 'session' ->> 'id')::uuid;
    PERFORM public.claim_youtube_upload_session(v_session, v_lease, 180000);
    PERFORM public.checkpoint_youtube_upload_session(v_session, v_lease, 0, 0,
      'https://upload.example.invalid/session/y38e' || i::text, false, NULL, NULL);
    -- The provider session is gone, and the lease with it.
    UPDATE public.youtube_upload_sessions
       SET session_expires_at = now() - interval '1 minute',
           lease_expires_at = now() - interval '1 second'
     WHERE id = v_session;
    v_expired := array_append(v_expired, v_session);
  END LOOP;

  -- Three sessions that ran out of continuations: the classification closes
  -- them, one by one.
  FOR i IN 1..3 LOOP
    SELECT f.account_id, f.post_id, f.media_id
      INTO v_acct, v_post, v_media
      FROM pg_temp.new_youtube_fixture('y38t' || i::text) f;
    v_session := (public.admit_youtube_upload(
        v_post, v_acct, v_u_a, v_media, 4096, 4096, '{}'::jsonb)
      -> 'session' ->> 'id')::uuid;
    UPDATE public.youtube_upload_sessions
       SET continuation_count = 24
     WHERE id = v_session;
    v_tired := array_append(v_tired, v_session);
  END LOOP;

  -- The backlog is the one this scenario made.
  SELECT count(*) INTO v_before
    FROM public.youtube_upload_sessions
   WHERE state = 'open' AND session_uri IS NOT NULL AND session_expires_at IS NOT NULL
     AND session_expires_at <= now() AND NOT video_may_exist AND bytes_sent = 0
     AND (lease_expires_at IS NULL OR lease_expires_at <= now());
  ASSERT v_before = 3,
    'Y38 the expired sessions of this scenario are the whole backlog';

  -- ONE pass, ONE slot: one session is reopened, and one session is
  -- classified. The rest waits for the next pass.
  PERFORM public.claim_youtube_upload_sessions(1, 180000, 24);

  SELECT count(*) INTO v_after
    FROM public.youtube_upload_sessions
   WHERE id = ANY(v_expired) AND session_uri IS NULL;
  ASSERT v_after = 1,
    'Y38 the expiry reset is bounded: one session is reopened per pass';

  SELECT count(*) INTO v_after
    FROM public.youtube_upload_sessions
   WHERE id = ANY(v_tired) AND state <> 'open';
  ASSERT v_after = 1,
    'Y38 the exhausted classification is bounded: one session is classified per pass';

  -- The other two are still waiting, and the next pass takes them.
  PERFORM public.claim_youtube_upload_sessions(1, 180000, 24);
  SELECT count(*) INTO v_after
    FROM public.youtube_upload_sessions
   WHERE id = ANY(v_tired) AND state <> 'open';
  ASSERT v_after = 2,
    'Y38 the next pass classifies the next session';

  -- The shared limit: a backlog of deferred publishes may not starve the
  -- upload work that is due.
  --
  -- Six deferred publishes are due, and one upload session is due for another
  -- look. The limit is five, so the deferred publishes may not take all of it.
  SELECT f.account_id, f.post_id, f.media_id
    INTO v_acct, v_post, v_media
    FROM pg_temp.new_youtube_fixture('y38d') f;
  FOR i IN 1..6 LOOP
    v_ig := gen_random_uuid();
    INSERT INTO public.social_accounts
      (id, user_id, platform, platform_user_id, platform_username, access_token, is_active)
    VALUES (v_ig, v_u_a, 'instagram', 'ig-y38d-' || i::text, 'y38d' || i::text, 'token', true);
    INSERT INTO public.platform_posts (post_id, social_account_id, platform, status, response_data)
    VALUES (v_post, v_ig, 'instagram', 'pending', jsonb_build_object(
      'deferred', jsonb_build_object('kind', 'threads',
        'next_check_at', now() - interval '1 minute')));
  END LOOP;

  v_session := (public.admit_youtube_upload(
      v_post, v_acct, v_u_a, v_media, 4096, 4096, '{}'::jsonb)
    -> 'session' ->> 'id')::uuid;

  SELECT
    count(*) FILTER (WHERE kind = 'deferred_publish'),
    count(*) FILTER (WHERE kind = 'youtube_upload_continuation'),
    count(*)
    INTO v_deferred, v_uploads, v_total
    FROM public.claim_post_completion_work(5);

  ASSERT v_total <= 5,
    'Y38 the shared limit is still the limit';
  ASSERT v_deferred = 3,
    'Y38 the deferred publishes keep to the share that is left';
  ASSERT v_uploads >= 1,
    'Y38 the due upload work is not starved by the deferred publishes';

  RAISE NOTICE 'PASS Y38: the repairs are bounded and no due work is starved';
END
$y38_bounded$;

-- ---------------------------------------------------------------------------
-- Y39: A DELETED TARGET LEAVES THE SCOPE, ITS SIDE EFFECT STAYS.
--
-- The scope is the list of destinations this attempt owns, and the closure is
-- refused when one of them has no result row. An account that was
-- disconnected cannot be published to any more, so it leaves the scope in the
-- same transaction -- otherwise the fanout could never close and the post
-- would wait for ever.
--
-- The record of the unknown outcome stays: the account may have been
-- published to before it was disconnected, and that is a possible side effect
-- nobody may forget.
-- ---------------------------------------------------------------------------
DO $y39_deleted_target$
DECLARE
  v_acct_a  uuid;
  v_post_a  uuid;
  v_media_a uuid;
  v_u_a     uuid := 'b1000000-0000-4000-8000-000000000001';
  v_ig      uuid := 'e9000000-0000-4000-8000-000000000001';
  v_session uuid;
  v_lease   uuid := 'f9000000-0000-4000-8000-000000000001';
  v_attempt timestamptz;
  v_content jsonb;
  v_recovered jsonb;
  v_scope   jsonb;
BEGIN
  -- This scenario owns its post, its account and its media file.
  SELECT f.account_id, f.post_id, f.media_id
    INTO v_acct_a, v_post_a, v_media_a
    FROM pg_temp.new_youtube_fixture('y39') f;

  -- The post has a second destination.
  INSERT INTO public.social_accounts
    (id, user_id, platform, platform_user_id, platform_username, access_token, is_active)
  VALUES (v_ig, v_u_a, 'instagram', 'ig-y39', 'y39', 'token-ig', true)
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

  -- The customer disconnects the second destination while the worker is gone.
  DELETE FROM public.social_accounts WHERE id = v_ig;

  v_session := (public.admit_youtube_upload(
      v_post_a, v_acct_a, v_u_a, v_media_a, 4096, 4096, '{}'::jsonb)
    -> 'session' ->> 'id')::uuid;
  PERFORM public.claim_youtube_upload_session(v_session, v_lease, 180000);
  PERFORM public.checkpoint_youtube_upload_session(v_session, v_lease, 4096, 4096,
    'https://upload.example.invalid/session/y39', true, NULL, NULL);
  PERFORM public.complete_youtube_upload_session(v_session, v_lease, 'yt-video-y39');
  PERFORM public.settle_youtube_upload_session(v_session, v_lease, 'success', 'yt-video-y39');

  v_recovered := public.recover_youtube_upload_fanout(v_session, NULL);
  ASSERT (v_recovered ->> 'recovered') = 'true',
    'Y39 the fanout closes although a destination was disconnected';

  -- The disconnected destination leaves the scope.
  SELECT metadata -> 'legacy_notification_candidate' INTO v_scope
    FROM public.posts WHERE id = v_post_a;
  ASSERT NOT (v_scope -> 'target_account_ids') @> to_jsonb(ARRAY[v_ig]),
    'Y39 the disconnected destination leaves the scope of the attempt';

  -- Its unknown outcome stays on record.
  ASSERT (v_scope -> 'fanout_unknown_account_ids') @> to_jsonb(ARRAY[v_ig]),
    'Y39 the possible side effect of the disconnected destination stays on record';

  -- The parent reaches a finite outcome.
  ASSERT (SELECT status FROM public.posts WHERE id = v_post_a) = 'completed',
    'Y39 the parent reaches the outcome the successful destination gives it';

  RAISE NOTICE 'PASS Y39: a deleted target leaves the scope and its side effect stays';
END
$y39_deleted_target$;

-- ---------------------------------------------------------------------------
-- Y40: THE ADMISSION TAKES THE EXPECTED LIVE MEDIA VERSION.
--
-- The worker resolves the file it is about to send and names the version it
-- read. If the file was replaced between that read and the admission, the
-- bytes the worker holds belong to a version the post does not name any
-- more, and the session would record the NEW version: a continuation could
-- then send the old bytes under the new version, and the video would be a
-- mixture of two files.
--
-- So the admission refuses that, before the session exists and before anything
-- is written to the provider. A refused admission creates nothing.
-- ---------------------------------------------------------------------------
DO $y40_media_version$
DECLARE
  v_acct_a  uuid;
  v_post_a  uuid;
  v_media_a uuid;
  v_acct_b  uuid;
  v_post_b  uuid;
  v_media_b uuid;
  v_u_a     uuid := 'b1000000-0000-4000-8000-000000000001';
  v_session uuid;
  v_admitted jsonb;
BEGIN
  -- The version that matches: the admission is accepted.
  SELECT f.account_id, f.post_id, f.media_id
    INTO v_acct_a, v_post_a, v_media_a
    FROM pg_temp.new_youtube_fixture('y40') f;
  v_admitted := public.admit_youtube_upload(
    v_post_a, v_acct_a, v_u_a, v_media_a, 4096, 4096, '{}'::jsonb,
    NULL, NULL, NULL, NULL, 1);
  ASSERT (v_admitted -> 'session' ->> 'id') IS NOT NULL,
    'Y40 the admission with the live media version is accepted';
  v_session := (v_admitted -> 'session' ->> 'id')::uuid;
  ASSERT (SELECT media_object_version FROM public.youtube_upload_sessions WHERE id = v_session) = 1,
    'Y40 the session records the live media version';

  -- The version that does not match: the file was replaced while the worker
  -- was reading it.
  SELECT f.account_id, f.post_id, f.media_id
    INTO v_acct_b, v_post_b, v_media_b
    FROM pg_temp.new_youtube_fixture('y40b') f;
  UPDATE public.media_files SET current_object_version = 2 WHERE id = v_media_b;

  BEGIN
    PERFORM public.admit_youtube_upload(
      v_post_b, v_acct_b, v_u_a, v_media_b, 4096, 4096, '{}'::jsonb,
      NULL, NULL, NULL, NULL, 1);
    RAISE EXCEPTION 'Y40 the admission accepted a media file that was replaced';
  EXCEPTION WHEN SQLSTATE 'YUS03' THEN
    RAISE NOTICE 'PASS Y40: the admission refuses a media file that was replaced';
  END;

  -- The refused admission created nothing.
  ASSERT (SELECT count(*) FROM public.youtube_upload_sessions WHERE post_id = v_post_b) = 0,
    'Y40 the refused admission created no session';
  ASSERT (SELECT count(*) FROM public.platform_posts WHERE post_id = v_post_b) = 0,
    'Y40 the refused admission created no public row';

  RAISE NOTICE 'PASS Y40: the admission takes the expected live media version';
END
$y40_media_version$;

-- ---------------------------------------------------------------------------
-- Y41: THE QUERY SETTINGS TRAVEL WITH THE SESSION.
--
-- The regression of PR441 comment 4610856939: a worker that opens the provider
-- session later has to make the SAME request as the one that was approved.
--
-- The settings are not part of the body: the parts name the fields the
-- provider is asked to write, and the subscriber notification says whether the
-- channel's subscribers are told about the video. A session that lost them
-- would either write a different video, or notify subscribers the customer had
-- turned off.
--
-- So they are stored with the session, they travel in the payload, and a
-- restart refreshes them with the ones the new attempt was approved with.
-- ---------------------------------------------------------------------------
DO $y41_upload_settings$
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
  v_lease     uuid := 'ec000000-0000-4000-8000-000000000003';
  v_lease_b   uuid := 'ec000000-0000-4000-8000-000000000004';
  v_admitted  jsonb;
  v_settings  jsonb;
  v_attempt   timestamptz;
BEGIN
  -- THE SETTINGS THE CALLER NAMED ARE STORED
  --
  -- The subscriber notification is kept as it was: a customer who turned the
  -- notification off must not have it turned back on by a later worker.
  SELECT f.account_id, f.post_id, f.media_id
    INTO v_acct_a, v_post_a, v_media_a
    FROM pg_temp.new_youtube_fixture('y41') f;
  v_admitted := public.admit_youtube_upload(
    v_post_a, v_acct_a, v_u_a, v_media_a, 4096, 4096, '{"snippet":{"title":"A video"}}'::jsonb,
    NULL, ARRAY[v_acct_a], NULL, NULL, NULL,
    '{"part":"snippet,status","notifySubscribers":false}'::jsonb);
  v_session := (v_admitted -> 'session' ->> 'id')::uuid;

  SELECT upload_settings INTO v_settings
    FROM public.youtube_upload_sessions WHERE id = v_session;
  ASSERT v_settings = '{"part":"snippet,status","notifySubscribers":false}'::jsonb,
    'Y41 the session keeps the settings the caller named';

  -- The settings travel in the payload, so the worker that opens the provider
  -- session later can read them.
  ASSERT (v_admitted -> 'session' -> 'upload_settings') = '{"part":"snippet,status","notifySubscribers":false}'::jsonb,
    'Y41 the payload carries the settings of the request';

  -- A SETTINGS OBJECT THAT IS NOT ONE IS REFUSED
  --
  -- A settings object that lost its parts or its subscriber notification is not
  -- a settings object, and a request made from it would write a different
  -- video than the one that was approved.
  BEGIN
    PERFORM public.admit_youtube_upload(
      v_post_a, v_acct_a, v_u_a, v_media_a, 4096, 4096, '{"snippet":{"title":"A video"}}'::jsonb,
      NULL, ARRAY[v_acct_a], NULL, NULL, NULL, '"not an object"'::jsonb);
    RAISE EXCEPTION 'Y41 the admission accepted settings that are not an object';
  EXCEPTION WHEN SQLSTATE 'YUS04' THEN
    RAISE NOTICE 'PASS Y41: settings that are not an object are refused';
  END;

  -- THE DERIVED SETTINGS
  --
  -- A caller that names no settings gets the request its body describes: the
  -- parts are the names of the fields the body carries, and the notification
  -- is the provider's default.
  SELECT f.account_id, f.post_id, f.media_id
    INTO v_acct_b, v_post_b, v_media_b
    FROM pg_temp.new_youtube_fixture('y41b') f;
  v_session_b := (public.admit_youtube_upload(
    v_post_b, v_acct_b, v_u_a, v_media_b, 4096, 4096,
    '{"status":{"privacyStatus":"private"},"snippet":{"title":"A video"}}'::jsonb)
    -> 'session' ->> 'id')::uuid;

  SELECT upload_settings INTO v_settings
    FROM public.youtube_upload_sessions WHERE id = v_session_b;
  ASSERT v_settings = '{"part":"snippet,status","notifySubscribers":true}'::jsonb,
    'Y41 a session without settings is read as the request its body describes';

  -- THE RESTART REFRESHES THEM
  --
  -- A retry is a new request, and it may be approved with other settings. The
  -- restarted session carries the ones of the new attempt, so the worker that
  -- opens the provider session makes the request that was approved NOW.
  SELECT f.account_id, f.post_id, f.media_id
    INTO v_acct_a, v_post_a, v_media_a
    FROM pg_temp.new_youtube_fixture('y41c') f;
  v_session := (public.admit_youtube_upload(
    v_post_a, v_acct_a, v_u_a, v_media_a, 4096, 4096, '{"snippet":{"title":"A video"}}'::jsonb,
    NULL, ARRAY[v_acct_a], NULL, NULL, NULL,
    '{"part":"snippet,status","notifySubscribers":false}'::jsonb)
    -> 'session' ->> 'id')::uuid;
  PERFORM public.claim_youtube_upload_session(v_session, v_lease, 180000);
  PERFORM public.release_youtube_upload_session(v_session, v_lease, 'failed',
    'the provider refused the upload');
  PERFORM public.settle_youtube_upload_session(v_session, v_lease, 'failed', NULL,
    'the provider refused the upload', '{}'::jsonb);

  ASSERT (SELECT state FROM public.youtube_upload_sessions WHERE id = v_session) = 'failed',
    'Y41 the refused upload is a failed session';

  PERFORM public.request_post_retry(v_post_a, v_u_a, ARRAY[v_acct_a]);
  UPDATE public.posts
     SET status = 'processing', processing_started_at = now()
   WHERE id = v_post_a;
  SELECT processing_started_at INTO v_attempt FROM public.posts WHERE id = v_post_a;

  v_admitted := public.admit_youtube_upload(
    v_post_a, v_acct_a, v_u_a, v_media_a, 4096, 4096, '{"snippet":{"title":"A video"}}'::jsonb,
    v_attempt, ARRAY[v_acct_a], NULL, NULL, NULL,
    '{"part":"snippet,status,recordingDetails","notifySubscribers":true}'::jsonb);
  ASSERT (v_admitted -> 'session' ->> 'state') = 'open',
    'Y41 the retried upload is started again';

  SELECT upload_settings INTO v_settings
    FROM public.youtube_upload_sessions WHERE id = v_session;
  ASSERT v_settings = '{"part":"snippet,status,recordingDetails","notifySubscribers":true}'::jsonb,
    'Y41 the restart refreshes the settings of the new attempt';

  RAISE NOTICE 'PASS Y41: the query settings travel with the session';
END
$y41_upload_settings$;

-- ---------------------------------------------------------------------------
-- Y42: THE EVIDENCE SURVIVES A DISCONNECT.
--
-- The disconnect is a hard delete of the account row, so everything that
-- references the account goes with it. That used to take the session with it,
-- and the session IS the evidence: the receipt, the byte checkpoints and the
-- uncertainty marker. Losing it made the disconnect a way to publish a second
-- video on one channel.
--
-- So the link to the account is SET NULL and the session stays, with its
-- evidence. The provider session URI is a credential of an account that is
-- gone, so it is redacted. The public row is settled BEFORE the account goes,
-- so the parent does not wait for a destination that is about to disappear;
-- the row itself goes with the account, because its result belongs to the
-- account.
--
-- The disconnect itself is never blocked, and the tenant keeps the post and
-- the media.
-- ---------------------------------------------------------------------------
DO $y42_disconnect$
DECLARE
  v_acct_a  uuid;
  v_post_a  uuid;
  v_media_a uuid;
  v_u_a     uuid := 'b1000000-0000-4000-8000-000000000001';
  v_session uuid;
  v_lease   uuid := 'ed000000-0000-4000-8000-000000000001';
BEGIN
  SELECT f.account_id, f.post_id, f.media_id
    INTO v_acct_a, v_post_a, v_media_a
    FROM pg_temp.new_youtube_fixture('y42') f;
  v_session := (public.admit_youtube_upload(
    v_post_a, v_acct_a, v_u_a, v_media_a, 4096, 4096, '{}'::jsonb)
    -> 'session' ->> 'id')::uuid;

  PERFORM public.claim_youtube_upload_session(v_session, v_lease, 180000);
  -- The provider may already hold a video: the bytes were sent.
  PERFORM public.checkpoint_youtube_upload_session(v_session, v_lease, 4096, 4096,
    'https://upload.example.invalid/session/y42', true, NULL, NULL);

  -- The customer disconnects the account.
  DELETE FROM public.social_accounts WHERE id = v_acct_a;

  -- The disconnect is never blocked.
  ASSERT NOT EXISTS (SELECT 1 FROM public.social_accounts WHERE id = v_acct_a),
    'Y42 the account is gone';

  -- The SESSION SURVIVES with its evidence.
  ASSERT EXISTS (SELECT 1 FROM public.youtube_upload_sessions WHERE id = v_session),
    'Y42 the session of a disconnected account survives';
  ASSERT (SELECT social_account_id FROM public.youtube_upload_sessions WHERE id = v_session) IS NULL,
    'Y42 the surviving session has no account';
  ASSERT (SELECT state FROM public.youtube_upload_sessions WHERE id = v_session) = 'reconcile',
    'Y42 the surviving session needs a human';
  ASSERT (SELECT session_uri FROM public.youtube_upload_sessions WHERE id = v_session) IS NULL,
    'Y42 the provider session uri of a dead account is redacted';
  ASSERT (SELECT video_may_exist FROM public.youtube_upload_sessions WHERE id = v_session) = true,
    'Y42 the surviving session keeps the uncertainty';
  ASSERT (SELECT bytes_sent FROM public.youtube_upload_sessions WHERE id = v_session) = 4096,
    'Y42 the surviving session keeps its byte checkpoints';
  ASSERT (SELECT disconnected_channel_id FROM public.youtube_upload_sessions WHERE id = v_session) = 'yt-y42',
    'Y42 the surviving session keeps the channel it belonged to';

  -- The post does not wait for a destination that is gone.
  ASSERT (SELECT status FROM public.posts WHERE id = v_post_a) = 'failed',
    'Y42 the post of a disconnected account is settled';

  -- The tenant keeps everything else.
  ASSERT EXISTS (SELECT 1 FROM public.posts WHERE id = v_post_a),
    'Y42 the post of a disconnected account is kept';
  ASSERT EXISTS (SELECT 1 FROM public.media_files WHERE id = v_media_a),
    'Y42 the media of a disconnected account is kept';

  RAISE NOTICE 'PASS Y42: the evidence of an in-flight upload survives a disconnect';
END
$y42_disconnect$;

-- ---------------------------------------------------------------------------
-- Y43: THE MEDIA FILE IS ONE OF THE POST'S FILES.
--
-- Owning a file is not the same as being allowed to publish it. The file has
-- to be one the post names: a file of the same customer that the post does
-- not carry is not the content of this post.
-- ---------------------------------------------------------------------------
DO $y43_media_membership$
DECLARE
  v_acct_a  uuid;
  v_post_a  uuid;
  v_media_a uuid;
  v_other   uuid;
  v_u_a     uuid := 'b1000000-0000-4000-8000-000000000001';
BEGIN
  SELECT f.account_id, f.post_id, f.media_id
    INTO v_acct_a, v_post_a, v_media_a
    FROM pg_temp.new_youtube_fixture('y43') f;

  -- A second file of the same customer that the post does not name.
  v_other := gen_random_uuid();
  INSERT INTO public.media_files
    (id, user_id, file_path, file_type, file_size, mime_type, storage_bucket)
  VALUES (v_other, v_u_a, 'uploads/other.mp4', 'video', 4096, 'video/mp4', 'media');

  BEGIN
    PERFORM public.admit_youtube_upload(v_post_a, v_acct_a, v_u_a, v_other, 4096, 4096, '{}'::jsonb);
    RAISE EXCEPTION 'Y43 a file the post does not name was admitted';
  EXCEPTION WHEN SQLSTATE 'YUS03' THEN
    RAISE NOTICE 'PASS Y43: a file the post does not name is refused';
  END;

  -- The file the post DOES name is admitted.
  PERFORM public.admit_youtube_upload(v_post_a, v_acct_a, v_u_a, v_media_a, 4096, 4096, '{}'::jsonb);
  RAISE NOTICE 'PASS Y43: the file the post names is admitted';
END
$y43_media_membership$;

-- ---------------------------------------------------------------------------
-- Y44: A RETRY WITH A REPLACEMENT FILE IS ADMITTED.
--
-- The retry with a replacement video is ATOMIC: the post names the new file in
-- the same transaction as the retry, so the post and the file it carries are
-- never a moment apart.
--
-- The session of the previous attempt still points at the old file, and the
-- old fence describes a write that never happened. So the admission REBINDS
-- the session to the file the post names, or the retry could never be
-- admitted at all.
--
-- The rebind is only safe when the previous attempt PROVES that nothing ever
-- reached the provider: the attempt is terminal, no byte was sent, and no
-- video may exist. A session that may already hold a video keeps its guard,
-- and so does a session a worker still owns.
-- ---------------------------------------------------------------------------
DO $y44_replacement_retry$
DECLARE
  v_acct_a     uuid;
  v_post_a     uuid;
  v_media_a    uuid;
  v_media_new  uuid;
  v_u_a        uuid := 'b1000000-0000-4000-8000-000000000001';
  v_session    uuid;
  v_lease      uuid := 'ed000000-0000-4000-8000-000000000004';
  v_new_attempt timestamptz := now() + interval '1 minute';
BEGIN
  SELECT f.account_id, f.post_id, f.media_id
    INTO v_acct_a, v_post_a, v_media_a
    FROM pg_temp.new_youtube_fixture('y44') f;

  -- The replacement file the customer uploaded.
  v_media_new := gen_random_uuid();
  INSERT INTO public.media_files
    (id, user_id, file_path, file_type, file_size, mime_type, storage_bucket)
  VALUES (v_media_new, v_u_a, 'uploads/y44-new.mp4', 'video', 4096, 'video/mp4', 'media');

  v_session := (public.admit_youtube_upload(
    v_post_a, v_acct_a, v_u_a, v_media_a, 4096, 4096, '{}'::jsonb)
    -> 'session' ->> 'id')::uuid;

  -- The attempt failed for good and NOTHING ever reached the provider: no byte
  -- was sent, so no video can exist.
  PERFORM public.claim_youtube_upload_session(v_session, v_lease, 180000);
  PERFORM public.release_youtube_upload_session(v_session, v_lease, 'failed',
    'the provider refused the upload');
  PERFORM public.settle_youtube_upload_session(v_session, v_lease, 'failed', NULL,
    'the provider refused the upload');
  ASSERT (SELECT lease_token FROM public.youtube_upload_sessions WHERE id = v_session) IS NULL,
    'Y44 the settlement releases the lease';

  -- THE RETRY WITH THE REPLACEMENT FILE: the post names the new file, and the
  -- attempt is a new one.
  UPDATE public.posts
     SET media_file_ids = ARRAY[v_media_new],
         processing_started_at = v_new_attempt,
         status = 'processing'
   WHERE id = v_post_a;

  -- The admission rebinds the session to the file the post names. The worker
  -- names the version it read: the rebind pins the session to a version it
  -- did not have, so the worker has to prove it read that one.
  PERFORM public.admit_youtube_upload(
    v_post_a, v_acct_a, v_u_a, v_media_new, 4096, 4096, '{}'::jsonb,
    v_new_attempt, ARRAY[v_acct_a], NULL, NULL, 1, NULL);

  ASSERT (SELECT media_file_id FROM public.youtube_upload_sessions WHERE id = v_session) = v_media_new,
    'Y44 the session is bound to the file the post names';
  ASSERT (SELECT state FROM public.youtube_upload_sessions WHERE id = v_session) = 'open',
    'Y44 the rebound session is open again';
  ASSERT (SELECT bytes_sent FROM public.youtube_upload_sessions WHERE id = v_session) = 0,
    'Y44 the rebound session has sent nothing';
  ASSERT (SELECT attempt_started_at FROM public.youtube_upload_sessions WHERE id = v_session) = v_new_attempt,
    'Y44 the rebound session belongs to the new attempt';

  -- The worker of the new attempt takes the rebound session.
  PERFORM public.claim_youtube_upload_session(v_session, v_lease, 180000);
  ASSERT (SELECT lease_token FROM public.youtube_upload_sessions WHERE id = v_session) = v_lease,
    'Y44 the rebound session is claimed by the worker of the new attempt';

  RAISE NOTICE 'PASS Y44: a retry with a replacement file is admitted and claimed';
END
$y44_replacement_retry$;

-- ---------------------------------------------------------------------------
-- Y45: A SESSION THAT MAY HOLD A VIDEO IS NOT REBOUND.
--
-- The rebind is for an attempt that PROVES that nothing ever reached the
-- provider. A session that may already hold a video is left for a human, and
-- a session a worker still owns is left alone: a rebind under that worker
-- would settle the new attempt with the old outcome.
-- ---------------------------------------------------------------------------
DO $y45_rebind_guards$
DECLARE
  v_acct_a     uuid;
  v_post_a     uuid;
  v_media_a    uuid;
  v_media_new  uuid;
  v_u_a        uuid := 'b1000000-0000-4000-8000-000000000001';
  v_session    uuid;
  v_lease      uuid := 'ed000000-0000-4000-8000-000000000005';
  v_new_attempt timestamptz := now() + interval '1 minute';
  v_result     jsonb;
  v_acct_b     uuid;
  v_post_b     uuid;
  v_media_b    uuid;
  v_media_new_b uuid;
  v_session_b  uuid;
  v_lease_b    uuid := 'ed000000-0000-4000-8000-000000000006';
BEGIN
  SELECT f.account_id, f.post_id, f.media_id
    INTO v_acct_a, v_post_a, v_media_a
    FROM pg_temp.new_youtube_fixture('y45') f;

  v_media_new := gen_random_uuid();
  INSERT INTO public.media_files
    (id, user_id, file_path, file_type, file_size, mime_type, storage_bucket)
  VALUES (v_media_new, v_u_a, 'uploads/y45-new.mp4', 'video', 4096, 'video/mp4', 'media');

  v_session := (public.admit_youtube_upload(
    v_post_a, v_acct_a, v_u_a, v_media_a, 4096, 4096, '{}'::jsonb)
    -> 'session' ->> 'id')::uuid;

  -- The last chunk may have been written: a video may exist.
  PERFORM public.claim_youtube_upload_session(v_session, v_lease, 180000);
  PERFORM public.checkpoint_youtube_upload_session(v_session, v_lease, 4096, 4096,
    'https://upload.example.invalid/session/y45', true, NULL, NULL);
  PERFORM public.release_youtube_upload_session(v_session, v_lease, 'reconcile',
    'the provider may hold a video');
  PERFORM public.settle_youtube_upload_session(v_session, v_lease, 'failed', NULL,
    'the provider may hold a video');

  UPDATE public.posts
     SET media_file_ids = ARRAY[v_media_new],
         processing_started_at = v_new_attempt,
         status = 'processing'
   WHERE id = v_post_a;

  -- The admission does NOT rebind a session that may hold a video. It says so
  -- instead of refusing for the fence: the caller has to learn that the
  -- channel may hold a video.
  v_result := public.admit_youtube_upload(
    v_post_a, v_acct_a, v_u_a, v_media_new, 4096, 4096, '{}'::jsonb,
    v_new_attempt, ARRAY[v_acct_a], NULL, NULL, NULL, NULL);
  ASSERT (SELECT media_file_id FROM public.youtube_upload_sessions WHERE id = v_session) = v_media_a,
    'Y45 a session that may hold a video keeps its file';
  ASSERT (SELECT state FROM public.youtube_upload_sessions WHERE id = v_session) = 'reconcile',
    'Y45 a session that may hold a video stays for a human';
  ASSERT (v_result -> 'session' ->> 'state') = 'reconcile',
    'Y45 the admission reports the session that needs a human';
  -- And it leaves no pending row behind: the post is not left waiting for a
  -- destination that will never publish.
  ASSERT NOT EXISTS (SELECT 1 FROM public.platform_posts
                       WHERE post_id = v_post_a AND status = 'pending'),
    'Y45 a session that needs a human leaves no pending row';

  -- A SESSION A WORKER STILL OWNS IS NOT REBOUND
  --
  -- The worker is about to settle the session, and a rebind under it would
  -- settle the new attempt with the old outcome. The session keeps its file
  -- and its state, and the admission refuses it for the fence: the post has
  -- moved on, and the session that is still owned belongs to the worker that
  -- owns it.
  SELECT f.account_id, f.post_id, f.media_id
    INTO v_acct_b, v_post_b, v_media_b
    FROM pg_temp.new_youtube_fixture('y45b') f;
  v_media_new_b := gen_random_uuid();
  INSERT INTO public.media_files
    (id, user_id, file_path, file_type, file_size, mime_type, storage_bucket)
  VALUES (v_media_new_b, v_u_a, 'uploads/y45b-new.mp4', 'video', 4096, 'video/mp4', 'media');

  v_session_b := (public.admit_youtube_upload(
    v_post_b, v_acct_b, v_u_a, v_media_b, 4096, 4096, '{}'::jsonb)
    -> 'session' ->> 'id')::uuid;
  PERFORM public.claim_youtube_upload_session(v_session_b, v_lease_b, 180000);
  -- The attempt failed for good and nothing ever reached the provider. The
  -- lease is KEPT: the owner still has to settle the public row.
  PERFORM public.release_youtube_upload_session(v_session_b, v_lease_b, 'failed',
    'the provider refused the upload');
  ASSERT (SELECT lease_token FROM public.youtube_upload_sessions WHERE id = v_session_b) = v_lease_b,
    'Y45 the worker that owns the session keeps its lease';

  UPDATE public.posts
     SET media_file_ids = ARRAY[v_media_new_b],
         processing_started_at = v_new_attempt,
         status = 'processing'
   WHERE id = v_post_b;

  BEGIN
    PERFORM public.admit_youtube_upload(
      v_post_b, v_acct_b, v_u_a, v_media_new_b, 4096, 4096, '{}'::jsonb,
      v_new_attempt, ARRAY[v_acct_b], NULL, NULL, 1, NULL);
    RAISE EXCEPTION 'Y45 the session was rebound under a worker that still owns it';
  EXCEPTION WHEN SQLSTATE 'YUS04' THEN
    NULL;
  END;

  ASSERT (SELECT media_file_id FROM public.youtube_upload_sessions WHERE id = v_session_b) = v_media_b,
    'Y45 a session a worker still owns keeps its file';
  ASSERT (SELECT state FROM public.youtube_upload_sessions WHERE id = v_session_b) = 'failed',
    'Y45 a session a worker still owns keeps its state';
  ASSERT (SELECT lease_token FROM public.youtube_upload_sessions WHERE id = v_session_b) = v_lease_b,
    'Y45 the owner keeps the lease of a session that was not rebound';

  RAISE NOTICE 'PASS Y45: a session that may hold a video is not rebound';
END
$y45_rebind_guards$;

-- ---------------------------------------------------------------------------
-- Y46: THE SAME CHANNEL IS NOT PUBLISHED AGAIN AFTER A RECONNECT.
--
-- The disconnect keeps the session, because a video may exist. A reconnect is
-- a NEW account row: the id of a deleted row cannot be reused, so the session
-- lookup (which is by post and account) does not find the old session, and a
-- retry would open a fresh upload.
--
-- The CHANNEL is what tells the two apart. The same channel is refused,
-- because a second video on one channel is worse than a post that needs a
-- human. Another channel of the same customer is a different publication and
-- stays allowed.
-- ---------------------------------------------------------------------------
DO $y46_reconnect$
DECLARE
  v_acct_a     uuid;
  v_acct_same  uuid;
  v_acct_other uuid;
  v_post_a     uuid;
  v_media_a    uuid;
  v_u_a        uuid := 'b1000000-0000-4000-8000-000000000001';
  v_session    uuid;
  v_lease      uuid := 'ed000000-0000-4000-8000-000000000006';
BEGIN
  SELECT f.account_id, f.post_id, f.media_id
    INTO v_acct_a, v_post_a, v_media_a
    FROM pg_temp.new_youtube_fixture('y46') f;

  v_session := (public.admit_youtube_upload(
    v_post_a, v_acct_a, v_u_a, v_media_a, 4096, 4096, '{}'::jsonb)
    -> 'session' ->> 'id')::uuid;
  PERFORM public.claim_youtube_upload_session(v_session, v_lease, 180000);
  PERFORM public.checkpoint_youtube_upload_session(v_session, v_lease, 4096, 4096,
    'https://upload.example.invalid/session/y46', true, NULL, NULL);

  -- The customer disconnects the account while the upload is in flight.
  DELETE FROM public.social_accounts WHERE id = v_acct_a;

  -- The customer reconnects the SAME channel. It is a new account row.
  v_acct_same := gen_random_uuid();
  INSERT INTO public.social_accounts
    (id, user_id, platform, platform_user_id, platform_username, access_token, is_active)
  VALUES (v_acct_same, v_u_a, 'youtube', 'yt-y46', 'y46', 'token-y46-new', true);

  -- The customer also connects another channel of their own.
  v_acct_other := gen_random_uuid();
  INSERT INTO public.social_accounts
    (id, user_id, platform, platform_user_id, platform_username, access_token, is_active)
  VALUES (v_acct_other, v_u_a, 'youtube', 'yt-y46-other', 'y46 other', 'token-y46-other', true);

  -- The post is retried.
  UPDATE public.posts
     SET status = 'processing', processing_started_at = now() + interval '1 minute'
   WHERE id = v_post_a;

  -- The same channel is refused: it may already hold a video of this post.
  BEGIN
    PERFORM public.admit_youtube_upload(v_post_a, v_acct_same, v_u_a, v_media_a, 4096, 4096, '{}'::jsonb);
    RAISE EXCEPTION 'Y46 the same channel was admitted again';
  EXCEPTION WHEN SQLSTATE 'YUS16' THEN
    RAISE NOTICE 'PASS Y46: the same channel is not published again';
  END;

  -- Another channel of the same customer is a different publication.
  PERFORM public.admit_youtube_upload(v_post_a, v_acct_other, v_u_a, v_media_a, 4096, 4096, '{}'::jsonb,
    NULL, ARRAY[v_acct_other], NULL, NULL, NULL, NULL);
  ASSERT EXISTS (SELECT 1 FROM public.youtube_upload_sessions
                  WHERE post_id = v_post_a AND social_account_id = v_acct_other),
    'Y46 another channel of the same customer is published';

  RAISE NOTICE 'PASS Y46: only the same channel is refused';
END
$y46_reconnect$;

-- ---------------------------------------------------------------------------
-- Y47: THE RECEIPT PROVES ONE ATTEMPT.
--
-- A receipt is the proof that the provider holds a video FOR THE ATTEMPT THAT
-- STORED IT. It says nothing about a later attempt: the customer may have
-- edited the post and published it again, and the old video is not the new
-- content.
--
-- So the admission answers the attempt that stored the receipt with that
-- receipt, and refuses every other attempt. The session is left EXACTLY as it
-- is: the receipt is never deleted, the evidence stays, and nothing is
-- replayed.
--
-- The decision is the ATTEMPT, never a guess about whether the content is
-- "really" a new video: a guess would drop a receipt that is still the proof
-- of a published video, and a replay would publish the old content twice. A
-- genuinely distinct repost -- a second video of the same content on the same
-- channel -- needs a NEW POST: the session is unique per post and channel, and
-- a new post has a new id and therefore a new session.
-- ---------------------------------------------------------------------------
DO $y47_receipt_proves_one_attempt$
DECLARE
  v_acct_a     uuid;
  v_post_a     uuid;
  v_media_a    uuid;
  v_u_a        uuid := 'b1000000-0000-4000-8000-000000000001';
  v_session    uuid;
  v_lease      uuid := 'ed000000-0000-4000-8000-000000000007';
  v_attempt    timestamptz;
  v_new_attempt timestamptz;
  v_public_row uuid;
  v_result     jsonb;
BEGIN
  SELECT f.account_id, f.post_id, f.media_id
    INTO v_acct_a, v_post_a, v_media_a
    FROM pg_temp.new_youtube_fixture('y47') f;

  SELECT processing_started_at INTO v_attempt
    FROM public.posts WHERE id = v_post_a;

  v_session := (public.admit_youtube_upload(
    v_post_a, v_acct_a, v_u_a, v_media_a, 4096, 4096, '{}'::jsonb)
    -> 'session' ->> 'id')::uuid;

  SELECT platform_post_id INTO v_public_row
    FROM public.youtube_upload_sessions WHERE id = v_session;

  -- The upload finishes: the provider holds the video and the receipt is
  -- stored on the session. The worker dies before it settles the public row,
  -- so the post is still being processed.
  PERFORM public.claim_youtube_upload_session(v_session, v_lease, 180000);
  PERFORM public.checkpoint_youtube_upload_session(v_session, v_lease, 4096, 4096,
    'https://upload.example.invalid/session/y47', true, NULL, NULL);
  PERFORM public.complete_youtube_upload_session(v_session, v_lease, 'yt-video-y47');

  ASSERT (SELECT state FROM public.youtube_upload_sessions WHERE id = v_session) = 'uploaded',
    'Y47 the receipt is stored on the session';

  -- THE ATTEMPT THAT STORED IT IS ANSWERED WITH THE RECEIPT.
  v_result := public.admit_youtube_upload(
    v_post_a, v_acct_a, v_u_a, v_media_a, 4096, 4096, '{}'::jsonb,
    v_attempt, ARRAY[v_acct_a], NULL, NULL, NULL, NULL);
  ASSERT (v_result -> 'session' ->> 'state') = 'uploaded',
    'Y47 the receipt answers the attempt that stored it';
  ASSERT (v_result ->> 'platform_post_id')::uuid = v_public_row,
    'Y47 the receipt names the public row it belongs to';

  -- ANOTHER ATTEMPT IS REFUSED.
  --
  -- The customer edited the post and published it again: that is a new
  -- attempt, and the old video is not the new content.
  v_new_attempt := v_attempt + interval '2 minutes';
  UPDATE public.posts
     SET status = 'processing',
         processing_started_at = v_new_attempt,
         caption = 'A different video'
   WHERE id = v_post_a;

  BEGIN
    PERFORM public.admit_youtube_upload(
      v_post_a, v_acct_a, v_u_a, v_media_a, 4096, 4096, '{}'::jsonb,
      v_new_attempt, ARRAY[v_acct_a], NULL, NULL, NULL, NULL);
    RAISE EXCEPTION 'Y47 the receipt of another attempt was returned';
  EXCEPTION WHEN SQLSTATE 'YUS17' THEN
    RAISE NOTICE 'PASS Y47: the receipt of another attempt is refused';
  END;

  -- THE EVIDENCE STAYS, AND NOTHING IS REPLAYED.
  ASSERT (SELECT state FROM public.youtube_upload_sessions WHERE id = v_session) = 'uploaded',
    'Y47 the refused admission leaves the session uploaded';
  ASSERT (SELECT video_id FROM public.youtube_upload_sessions WHERE id = v_session) = 'yt-video-y47',
    'Y47 the refused admission keeps the receipt';
  ASSERT (SELECT attempt_started_at FROM public.youtube_upload_sessions WHERE id = v_session) = v_attempt,
    'Y47 the refused admission keeps the attempt that stored the receipt';
  ASSERT (SELECT platform_post_id FROM public.youtube_upload_sessions WHERE id = v_session) = v_public_row,
    'Y47 the refused admission keeps the public row';
  ASSERT (SELECT count(*) FROM public.youtube_upload_sessions WHERE post_id = v_post_a) = 1,
    'Y47 the refused admission opens no second session';
  ASSERT (SELECT status FROM public.platform_posts WHERE id = v_public_row) = 'pending',
    'Y47 the refused admission settles nothing';

  RAISE NOTICE 'PASS Y47: the receipt proves one attempt';
END
$y47_receipt_proves_one_attempt$;

-- ---------------------------------------------------------------------------
-- Y48: THE LEASE IS STAMPED WITH THE TIME OF THE GRANT.
--
-- now() is the instant the TRANSACTION started, so a claim that waited on a
-- lock or worked through a backlog would hand out a lease that had already
-- spent most of its life: the worker would get a lease that expires in a
-- moment, and a reconciler could take the session over while the first worker
-- was still writing to the provider.
--
-- clock_timestamp() is the instant the lease is actually granted, and it is
-- what every lease comparison uses as well, so a lease is judged against the
-- time it is asked about.
--
-- The worker here waits before the claim, so the two clocks are measurably
-- apart: the transaction's clock is fixed at the start of this suite, while
-- the wall clock moves on. The lease must end 60 seconds after the GRANT, not
-- 60 seconds after the start of the transaction.
-- ---------------------------------------------------------------------------
DO $y48_lease_clock$
DECLARE
  v_acct_a     uuid;
  v_post_a     uuid;
  v_media_a    uuid;
  v_u_a        uuid := 'b1000000-0000-4000-8000-000000000001';
  v_session    uuid;
  v_lease      uuid := 'ed000000-0000-4000-8000-000000000008';
  v_granted_at timestamptz;
  v_read_at    timestamptz;
  v_expires    timestamptz;
BEGIN
  SELECT f.account_id, f.post_id, f.media_id
    INTO v_acct_a, v_post_a, v_media_a
    FROM pg_temp.new_youtube_fixture('y48') f;

  v_session := (public.admit_youtube_upload(
    v_post_a, v_acct_a, v_u_a, v_media_a, 4096, 4096, '{}'::jsonb)
    -> 'session' ->> 'id')::uuid;

  -- The worker waits for the session. The wall clock moves on; the
  -- transaction's own clock does not.
  PERFORM pg_sleep(2);
  v_granted_at := clock_timestamp();

  PERFORM public.claim_youtube_upload_session(v_session, v_lease, 60000);
  v_read_at := clock_timestamp();

  SELECT lease_expires_at INTO v_expires
    FROM public.youtube_upload_sessions WHERE id = v_session;

  -- The grant happened at or after v_granted_at, so the lease ends at least
  -- 59 seconds after that moment.
  ASSERT v_expires >= v_granted_at + interval '59 seconds',
    'Y48 the lease is stamped with the time of the grant, not with the start of the transaction';
  -- And it ends no later than a full lease after the claim was answered.
  ASSERT v_expires <= v_read_at + interval '61 seconds',
    'Y48 the lease is no longer than the grant asked for';

  RAISE NOTICE 'PASS Y48: the lease is stamped with the current time';
END
$y48_lease_clock$;

-- ---------------------------------------------------------------------------
-- Y49: A FILE THE POST DOES NOT NAME IS REFUSED, EVEN BESIDE A NULL.
--
-- The membership of the post's own files is a question with two answers: the
-- file is in the list, or it is not. A list that holds a NULL element must
-- not turn the second answer into "maybe": a membership test that answers
-- NULL cannot say "this file is not in the list", and a file that is not in
-- the list is a file the customer did not put on this post.
--
-- So the answer is asked with a test that can only say yes or no, and a NULL
-- element equals nothing.
-- ---------------------------------------------------------------------------
DO $y49_null_membership$
DECLARE
  v_acct_a  uuid;
  v_post_a  uuid;
  v_media_a uuid;
  v_other   uuid;
  v_u_a     uuid := 'b1000000-0000-4000-8000-000000000001';
BEGIN
  SELECT f.account_id, f.post_id, f.media_id
    INTO v_acct_a, v_post_a, v_media_a
    FROM pg_temp.new_youtube_fixture('y49') f;

  -- A second file of the same customer that the post does not name.
  v_other := gen_random_uuid();
  INSERT INTO public.media_files
    (id, user_id, file_path, file_type, file_size, mime_type, storage_bucket)
  VALUES (v_other, v_u_a, 'uploads/y49-other.mp4', 'video', 4096, 'video/mp4', 'media');

  -- The post names the other file, and its list holds a NULL.
  UPDATE public.posts
     SET media_file_ids = ARRAY[v_other, NULL]::uuid[]
   WHERE id = v_post_a;

  BEGIN
    PERFORM public.admit_youtube_upload(v_post_a, v_acct_a, v_u_a, v_media_a, 4096, 4096, '{}'::jsonb);
    RAISE EXCEPTION 'Y49 a file the post does not name was admitted';
  EXCEPTION WHEN SQLSTATE 'YUS03' THEN
    RAISE NOTICE 'PASS Y49: a file the post does not name is refused';
  END;

  -- The file the post DOES name is admitted, even beside a NULL element: the
  -- NULL is an element that equals nothing, not a reason to refuse.
  UPDATE public.posts
     SET media_file_ids = ARRAY[v_media_a, NULL]::uuid[]
   WHERE id = v_post_a;
  PERFORM public.admit_youtube_upload(v_post_a, v_acct_a, v_u_a, v_media_a, 4096, 4096, '{}'::jsonb);
  RAISE NOTICE 'PASS Y49: the file the post names is admitted beside a NULL';
END
$y49_null_membership$;

-- ---------------------------------------------------------------------------
-- Y50: A UPLOAD THAT SENT A BYTE IS NOT A DEFINITIVE FAILURE.
--
-- The terminal recovery and the settlement ask the same question about the
-- same session: may a video already exist? They answered it differently, and
-- the difference was a byte that reached the provider.
--
-- The worker that died left the session uncertain. The worker that settled
-- the failure itself called it a failure -- and a failure is retryable, so
-- the retry could put a second video on the channel. The uncertainty was the
-- safe answer, so the settlement asks the question the same way the
-- recovery does.
--
-- The public row carries the marker, so the retry gate in the database and
-- the retry button on the page both refuse it.
-- ---------------------------------------------------------------------------
DO $y50_partial_uncertainty$
DECLARE
  v_acct_a  uuid;
  v_post_a  uuid;
  v_media_a uuid;
  v_u_a     uuid := 'b1000000-0000-4000-8000-000000000001';
  v_session uuid;
  v_lease   uuid := 'ed000000-0000-4000-8000-000000000009';
  v_row     uuid;
BEGIN
  SELECT f.account_id, f.post_id, f.media_id
    INTO v_acct_a, v_post_a, v_media_a
    FROM pg_temp.new_youtube_fixture('y50') f;
  v_session := (public.admit_youtube_upload(
      v_post_a, v_acct_a, v_u_a, v_media_a, 4096, 4096, '{}'::jsonb)
    -> 'session' ->> 'id')::uuid;
  PERFORM public.claim_youtube_upload_session(v_session, v_lease, 180000);

  -- A chunk reached the provider, and the provider did not say that a video
  -- may exist yet.
  PERFORM public.checkpoint_youtube_upload_session(v_session, v_lease, 1024, 1024,
    'https://upload.example.invalid/session/y50', false, NULL, NULL);

  -- The upload fails. The session is NOT a definitive failure: a byte reached
  -- the provider, so this is the same session the recovery would have called
  -- uncertain.
  PERFORM public.settle_youtube_upload_session(v_session, v_lease, 'failed', NULL,
    'the upload did not finish', '{}'::jsonb);

  ASSERT (SELECT state FROM public.youtube_upload_sessions WHERE id = v_session) = 'reconcile',
    'Y50 a session that sent a byte is not a definitive failure';

  SELECT platform_post_id INTO v_row
    FROM public.youtube_upload_sessions WHERE id = v_session;
  ASSERT (SELECT response_data ->> 'publish_outcome' FROM public.platform_posts WHERE id = v_row) = 'uncertain',
    'Y50 the public row carries the uncertainty marker';

  RAISE NOTICE 'PASS Y50: a partial upload keeps its uncertainty';
END
$y50_partial_uncertainty$;

-- ---------------------------------------------------------------------------
-- Y51: THE STALE SESSIONS DO NOT TAKE THE SLOTS OF THE REPAIR SCAN.
--
-- The scan that classifies the sessions that ran out of continuations is
-- BOUNDED, so every slot it spends is a slot a current upload does not get.
--
-- A session whose post is not being worked on any more cannot be classified:
-- the classification refuses it, and the cancellation repair owns it -- that
-- repair finds it by its open state. So its state is left alone, and it is
-- left out of the scan as well.
--
-- These sessions are never removed: the cancellation repair skips the ones
-- whose attempt no longer matches the post, and the due claim skips the
-- capped ones. They sort by their id, so enough of them would sit in front
-- of every current exhausted upload and starve it for ever.
--
-- The ids are set here so that the order is the one this case needs: the
-- stale sessions come first, the current one last.
-- ---------------------------------------------------------------------------
DO $y51_scan_capacity$
DECLARE
  v_acct_a      uuid;
  v_post_a      uuid;
  v_media_a     uuid;
  v_acct_stale  uuid;
  v_post_stale  uuid;
  v_media_stale uuid;
  v_u_a         uuid := 'b1000000-0000-4000-8000-000000000001';
  v_current     uuid;
  v_stale       uuid;
BEGIN
  SELECT f.account_id, f.post_id, f.media_id
    INTO v_acct_a, v_post_a, v_media_a
    FROM pg_temp.new_youtube_fixture('y51a') f;
  SELECT f.account_id, f.post_id, f.media_id
    INTO v_acct_stale, v_post_stale, v_media_stale
    FROM pg_temp.new_youtube_fixture('y51b') f;

  -- The current upload: its post is being worked on, and the session ran out
  -- of continuations.
  v_current := (public.admit_youtube_upload(
      v_post_a, v_acct_a, v_u_a, v_media_a, 4096, 4096, '{}'::jsonb)
    -> 'session' ->> 'id')::uuid;
  UPDATE public.youtube_upload_sessions
     SET continuation_count = 24
   WHERE id = v_current;

  -- The stale session: its post is not being processed any more.
  v_stale := (public.admit_youtube_upload(
      v_post_stale, v_acct_stale, v_u_a, v_media_stale, 4096, 4096, '{}'::jsonb)
    -> 'session' ->> 'id')::uuid;
  UPDATE public.youtube_upload_sessions
     SET continuation_count = 24
   WHERE id = v_stale;
  UPDATE public.posts SET status = 'failed' WHERE id = v_post_stale;

  -- The order the scan reads.
  UPDATE public.youtube_upload_sessions SET id = '00000000-0000-4000-8000-000000000001' WHERE id = v_stale;
  UPDATE public.youtube_upload_sessions SET id = 'ffffffff-ffff-4fff-8fff-ffffffffffff' WHERE id = v_current;
  v_stale := '00000000-0000-4000-8000-000000000001';
  v_current := 'ffffffff-ffff-4fff-8fff-ffffffffffff';

  -- The scan has ONE slot.
  PERFORM public.claim_youtube_upload_sessions(1, 180000, 24);

  ASSERT (SELECT state FROM public.youtube_upload_sessions WHERE id = v_current) = 'failed',
    'Y51 the current exhausted upload is classified';
  ASSERT (SELECT state FROM public.youtube_upload_sessions WHERE id = v_stale) = 'open',
    'Y51 the stale session is left to the cancellation repair';

  RAISE NOTICE 'PASS Y51: the stale sessions do not take the slots of the scan';
END
$y51_scan_capacity$;

-- ---------------------------------------------------------------------------
-- Y52: A SLOT THAT NO UPLOAD WANTS IS LEFT TO THE NOTIFICATION.
--
-- The shared limit keeps one slot for the upload work, so that a backlog of
-- deferred publishes cannot starve an upload whose post is waiting. The slot
-- is only worth keeping when there IS an upload: a slot that no upload took
-- is left to the notification, instead of being kept for an upload that does
-- not exist.
--
-- The workload is the one that used to starve the notification: a deferred
-- publish takes the first slot, a notification is ready on another post, and
-- no upload is due.
-- ---------------------------------------------------------------------------
DO $y52_unused_reserve$
DECLARE
  v_notif_acct uuid := 'b3000000-0000-4000-8000-000000000052';
  v_notif      uuid := 'b4000000-0000-4000-8000-000000000052';
  v_notif_row  uuid := 'b5000000-0000-4000-8000-000000000052';
  v_deferred   uuid := 'b6000000-0000-4000-8000-000000000052';
  v_deferred_post uuid := 'b7000000-0000-4000-8000-000000000052';
  v_u_a        uuid := 'b1000000-0000-4000-8000-000000000001';
  v_attempt    timestamptz := now();
  v_content    jsonb;
  v_total      integer;
  v_deferred_count integer;
  v_notifications integer;
BEGIN
  -- A due deferred publish: a pending row that waits for its next check.
  --
  -- The row is the OLDEST one on purpose: the deferred publishes are claimed
  -- oldest first, and this case needs its own publish to take the first slot.
  INSERT INTO public.social_accounts
    (id, user_id, platform, platform_user_id, platform_username, access_token, is_active)
  VALUES (v_notif_acct, v_u_a, 'instagram', 'ig-notify-52', 'notify', 'token-n', true)
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.posts
    (id, user_id, caption, platforms, status, processing_started_at, source, metadata)
  VALUES (v_deferred_post, v_u_a, 'a deferred post', ARRAY['instagram'], 'processing', v_attempt, 'manual', '{}'::jsonb);
  INSERT INTO public.platform_posts
    (id, post_id, social_account_id, platform, status, created_at, response_data)
  VALUES (v_deferred, v_deferred_post, v_notif_acct, 'instagram', 'pending', '2000-01-01T00:00:00Z',
    jsonb_build_object('deferred', jsonb_build_object('next_check_at', v_attempt)));

  -- The other scenarios left their upload sessions behind. This case is about
  -- the CAPACITY, so those uploads are made not due: an upload that is due
  -- would take the reserved slot, which is the other half of the contract.
  UPDATE public.youtube_upload_sessions
     SET lease_expires_at = now() + interval '1 hour';

  -- A ready legacy notification candidate.
  --
  -- The post is the OLDEST one on purpose: the candidates are claimed oldest
  -- first, and this case needs its own candidate to take the slot that the
  -- upload reservation left behind.
  INSERT INTO public.posts
    (id, user_id, caption, platforms, status, processing_started_at, source, metadata, created_at)
  VALUES (v_notif, v_u_a, 'a notification post', ARRAY['instagram'], 'processing', v_attempt, 'manual', '{}'::jsonb, '2000-01-01T00:00:00Z')
  ON CONFLICT (id) DO NOTHING;

  SELECT jsonb_build_object(
           'user_id', x.user_id, 'caption', x.caption, 'media_file_ids', x.media_file_ids,
           'metadata', public.normalize_threads_internal_metadata(x.metadata), 'platforms', x.platforms,
           'scheduled_at', x.scheduled_at, 'publish_requested_at', x.publish_requested_at, 'source', x.source)
    INTO v_content FROM public.posts x WHERE x.id = v_notif;
  PERFORM public.enroll_post_notification_recovery(v_notif, v_attempt, v_content, ARRAY[v_notif_acct], ARRAY[]::uuid[]);

  INSERT INTO public.platform_posts
    (id, post_id, social_account_id, platform, status, created_at, response_data)
  VALUES (v_notif_row, v_notif, v_notif_acct, 'instagram', 'failed', v_attempt, '{}'::jsonb);
  PERFORM public.close_post_fanout(v_notif, v_attempt, v_content, ARRAY[v_notif_row], ARRAY[]::uuid[]);
  UPDATE public.posts
     SET metadata = jsonb_set(
           metadata, '{legacy_notification_candidate}',
           (metadata -> 'legacy_notification_candidate') || jsonb_build_object('ready', 'true'))
   WHERE id = v_notif;

  -- The limit of two: the deferred publish takes the first slot, and the
  -- notification gets the second one, because no upload wanted it.
  SELECT
    count(*),
    count(*) FILTER (WHERE kind = 'deferred_publish' AND post_id = v_deferred_post),
    count(*) FILTER (WHERE kind = 'notification_only' AND post_id = v_notif)
    INTO v_total, v_deferred_count, v_notifications
    FROM public.claim_post_completion_work(2, interval '3 minutes');

  ASSERT v_total <= 2, 'Y52 the shared limit is honoured';
  ASSERT v_deferred_count = 1,
    'Y52 the deferred publish took its slot';
  ASSERT v_notifications = 1,
    'Y52 the slot that no upload wanted was left to the notification';

  RAISE NOTICE 'PASS Y52: an unused reservation goes to the notification';
END
$y52_unused_reserve$;

-- ---------------------------------------------------------------------------
-- Y53: THE RECEIPT SURVIVES THE DISCONNECT.
--
-- The receipt is a PROOF: the provider accepted the video and gave its id,
-- so the video is on the channel. Settling that row as a failure would
-- report a publication that happened as one that did not, would lose the
-- video id, and would roll the parent up to 'failed' for a post whose video
-- is published.
--
-- So the receipt is settled with the row and the parent keeps the result it
-- earned. The row itself goes with the account -- its result belongs to the
-- account, for every platform -- and the receipt stays on the session, which
-- is the row that outlives it.
--
-- The channel is refused for a reconnect: the video is there, and a second
-- one on the same channel is worse than a post that needs a human.
-- ---------------------------------------------------------------------------
DO $y53_receipt_disconnect$
DECLARE
  v_acct_a   uuid;
  v_post_a   uuid;
  v_media_a  uuid;
  v_acct_new uuid := 'b8000000-0000-4000-8000-000000000053';
  v_u_a      uuid := 'b1000000-0000-4000-8000-000000000001';
  v_session  uuid;
  v_lease    uuid := 'ed000000-0000-4000-8000-000000000053';
BEGIN
  SELECT f.account_id, f.post_id, f.media_id
    INTO v_acct_a, v_post_a, v_media_a
    FROM pg_temp.new_youtube_fixture('y53') f;
  v_session := (public.admit_youtube_upload(
      v_post_a, v_acct_a, v_u_a, v_media_a, 4096, 4096, '{}'::jsonb)
    -> 'session' ->> 'id')::uuid;
  PERFORM public.claim_youtube_upload_session(v_session, v_lease, 180000);
  PERFORM public.checkpoint_youtube_upload_session(v_session, v_lease, 4096, 4096,
    'https://upload.example.invalid/session/y53', true, NULL, NULL);
  PERFORM public.complete_youtube_upload_session(v_session, v_lease, 'yt-video-y53');

  -- The receipt is stored and the public row is still pending.
  ASSERT (SELECT state FROM public.youtube_upload_sessions WHERE id = v_session) = 'uploaded',
    'Y53 the receipt is stored';
  ASSERT (SELECT status FROM public.platform_posts
           WHERE id = (SELECT platform_post_id FROM public.youtube_upload_sessions WHERE id = v_session)) = 'pending',
    'Y53 the public row is still pending';

  -- The customer disconnects the account.
  DELETE FROM public.social_accounts WHERE id = v_acct_a;

  -- The parent keeps the result it earned: the video is published.
  ASSERT (SELECT status FROM public.posts WHERE id = v_post_a) = 'completed',
    'Y53 the parent of a published video is not rolled up to failed';

  -- The receipt stays on the session, which is the row that outlives the
  -- account.
  ASSERT (SELECT video_id FROM public.youtube_upload_sessions WHERE id = v_session) = 'yt-video-y53',
    'Y53 the receipt survives the disconnect';
  ASSERT (SELECT state FROM public.youtube_upload_sessions WHERE id = v_session) = 'uploaded',
    'Y53 the session of a published video stays uploaded';
  ASSERT (SELECT disconnected_channel_id FROM public.youtube_upload_sessions WHERE id = v_session) = 'yt-y53',
    'Y53 the surviving session keeps the channel it belonged to';

  -- The customer reconnects the SAME channel and retries the post.
  INSERT INTO public.social_accounts
    (id, user_id, platform, platform_user_id, platform_username, access_token, is_active)
  VALUES (v_acct_new, v_u_a, 'youtube', 'yt-y53', 'y53', 'token-y53-again', true);
  PERFORM public.request_post_retry(v_post_a, v_u_a, ARRAY[v_acct_new]);
  UPDATE public.posts
     SET status = 'processing', processing_started_at = now()
   WHERE id = v_post_a;

  BEGIN
    PERFORM public.admit_youtube_upload(v_post_a, v_acct_new, v_u_a, v_media_a, 4096, 4096, '{}'::jsonb);
    RAISE EXCEPTION 'Y53 the same channel was published again';
  EXCEPTION WHEN SQLSTATE 'YUS16' THEN
    RAISE NOTICE 'PASS Y53: the same channel is refused';
  END;

  RAISE NOTICE 'PASS Y53: the receipt survives the disconnect';
END
$y53_receipt_disconnect$;

-- ---------------------------------------------------------------------------
-- Y54: THE MARK OF A HUMAN SURVIVES THE DISCONNECT.
--
-- A session that was marked for a human keeps that mark, even when it never
-- sent a byte: the mark is what keeps a second video off the channel, and a
-- disconnect must never take it away.
--
-- The marker is also kept on the session itself, because the public row goes
-- with the account and the session is the row that outlives it.
--
-- The channel is refused for a reconnect, and a session that proves that
-- nothing ever reached the provider stays eligible: there is nothing on the
-- channel to publish twice.
-- ---------------------------------------------------------------------------
DO $y54_reconcile_disconnect$
DECLARE
  v_acct_a   uuid;
  v_post_a   uuid;
  v_media_a  uuid;
  v_acct_new uuid := 'b8000000-0000-4000-8000-000000000054';
  v_u_a      uuid := 'b1000000-0000-4000-8000-000000000001';
  v_session  uuid;
  v_lease    uuid := 'ed000000-0000-4000-8000-000000000054';
BEGIN
  SELECT f.account_id, f.post_id, f.media_id
    INTO v_acct_a, v_post_a, v_media_a
    FROM pg_temp.new_youtube_fixture('y54') f;
  v_session := (public.admit_youtube_upload(
      v_post_a, v_acct_a, v_u_a, v_media_a, 4096, 4096, '{}'::jsonb)
    -> 'session' ->> 'id')::uuid;
  PERFORM public.claim_youtube_upload_session(v_session, v_lease, 180000);

  -- The worker marks the session for a human: it cannot tell whether the
  -- provider turned the upload into a video. No byte ever reached it.
  PERFORM public.release_youtube_upload_session(v_session, v_lease, 'reconcile',
    'the provider may already hold a video');

  -- The customer disconnects the account.
  DELETE FROM public.social_accounts WHERE id = v_acct_a;

  -- THE MARK STAYS.
  ASSERT (SELECT state FROM public.youtube_upload_sessions WHERE id = v_session) = 'reconcile',
    'Y54 the mark of a human survives the disconnect';
  ASSERT (SELECT last_outcome FROM public.youtube_upload_sessions WHERE id = v_session) = 'youtube_upload_reconcile_required',
    'Y54 the marker of the uncertainty stays on the session';
  ASSERT (SELECT disconnected_channel_id FROM public.youtube_upload_sessions WHERE id = v_session) = 'yt-y54',
    'Y54 the surviving session keeps the channel it belonged to';

  -- The customer reconnects the SAME channel and retries the post.
  INSERT INTO public.social_accounts
    (id, user_id, platform, platform_user_id, platform_username, access_token, is_active)
  VALUES (v_acct_new, v_u_a, 'youtube', 'yt-y54', 'y54', 'token-y54-again', true);
  PERFORM public.request_post_retry(v_post_a, v_u_a, ARRAY[v_acct_new]);
  UPDATE public.posts
     SET status = 'processing', processing_started_at = now()
   WHERE id = v_post_a;

  BEGIN
    PERFORM public.admit_youtube_upload(v_post_a, v_acct_new, v_u_a, v_media_a, 4096, 4096, '{}'::jsonb);
    RAISE EXCEPTION 'Y54 the same channel was published again';
  EXCEPTION WHEN SQLSTATE 'YUS16' THEN
    RAISE NOTICE 'PASS Y54: the same channel is refused';
  END;

  RAISE NOTICE 'PASS Y54: the mark of a human survives the disconnect';
END
$y54_reconcile_disconnect$;

-- ---------------------------------------------------------------------------
-- Y55: THE RECEIPT IS COMMITTED AND THE ANSWER IS LOST.
--
-- The settlement of a YouTube upload closes the public row and rolls the
-- parent up, in one transaction. The worker that made the settlement may
-- never learn that it landed: the answer can be lost between the database and
-- the client.
--
-- The worker then hands the row to the upload recovery as a PENDING
-- destination, and the outer loop asks the database to put the parent back
-- into processing.
--
-- The old restoration cannot tell that apart from a handoff that is genuinely
-- pending. It reads the attempt, the content and the rollup provenance, and
-- all three still match: the settlement did not change the attempt, and the
-- rollup it wrote IS the provenance. So it restores a parent that has already
-- rolled up, and the post stays in processing with no open destination under
-- it. Nothing will ever settle it again, because the row it was waiting for
-- is already closed.
--
-- The guarded restoration asks for the row the handoff names, and restores
-- the parent only while that row is STILL pending.
-- ---------------------------------------------------------------------------
DO $y55_lost_ack$
DECLARE
  v_acct_a  uuid;
  v_post_a  uuid;
  v_media_a uuid;
  v_u_a     uuid := 'b1000000-0000-4000-8000-000000000001';
  v_session uuid;
  v_lease   uuid := 'ed000000-0000-4000-8000-000000000055';
  v_row     uuid;
  v_attempt timestamptz;
  v_fence   jsonb;
  v_result  jsonb;
BEGIN
  SELECT f.account_id, f.post_id, f.media_id
    INTO v_acct_a, v_post_a, v_media_a
    FROM pg_temp.new_youtube_fixture('y55') f;

  -- THE GRANT SURFACE
  --
  -- A browser role may not restore a parent, and neither may it read the rows
  -- the restoration reads.
  ASSERT NOT has_function_privilege('anon',
           'public.restore_youtube_pending_post(uuid, timestamptz, jsonb, uuid)', 'EXECUTE'),
    'Y55 anon may not restore a YouTube parent';
  ASSERT NOT has_function_privilege('authenticated',
           'public.restore_youtube_pending_post(uuid, timestamptz, jsonb, uuid)', 'EXECUTE'),
    'Y55 authenticated may not restore a YouTube parent';
  ASSERT has_function_privilege('service_role',
           'public.restore_youtube_pending_post(uuid, timestamptz, jsonb, uuid)', 'EXECUTE'),
    'Y55 the service role may restore a YouTube parent';

  v_session := (public.admit_youtube_upload(
      v_post_a, v_acct_a, v_u_a, v_media_a, 4096, 4096, '{}'::jsonb)
    -> 'session' ->> 'id')::uuid;
  PERFORM public.claim_youtube_upload_session(v_session, v_lease, 180000);

  -- The fence and the attempt are read while the upload is running, the way
  -- the worker read them.
  SELECT processing_started_at INTO v_attempt FROM public.posts WHERE id = v_post_a;
  SELECT jsonb_build_object(
           'user_id', x.user_id, 'caption', x.caption, 'media_file_ids', x.media_file_ids,
           'metadata', public.normalize_threads_internal_metadata(x.metadata), 'platforms', x.platforms,
           'scheduled_at', x.scheduled_at, 'publish_requested_at', x.publish_requested_at, 'source', x.source)
    INTO v_fence FROM public.posts x WHERE x.id = v_post_a;

  -- THE RECEIPT IS COMMITTED
  --
  -- The video reached the channel and the settlement landed: the row is
  -- closed and the parent rolls up to 'completed'.
  PERFORM public.complete_youtube_upload_session(v_session, v_lease, 'yt-video-y55');
  PERFORM public.claim_youtube_upload_session(v_session, v_lease, 180000);
  PERFORM public.settle_youtube_upload_session(v_session, v_lease, 'success', 'yt-video-y55', NULL,
    jsonb_build_object('youtube_video_id', 'yt-video-y55'));

  v_row := (SELECT platform_post_id FROM public.youtube_upload_sessions WHERE id = v_session);
  ASSERT (SELECT status FROM public.platform_posts WHERE id = v_row) = 'success',
    'Y55 the settlement closed the public row';
  ASSERT (SELECT status FROM public.posts WHERE id = v_post_a) = 'completed',
    'Y55 the settlement rolled the parent up';

  -- THE ANSWER IS LOST
  --
  -- The worker never learned that the settlement landed, so the handoff names
  -- the row as pending and the outer loop asks for the restore.
  v_result := public.restore_youtube_pending_post(v_post_a, v_attempt, v_fence, v_row);

  ASSERT (v_result ->> 'restored')::boolean = false,
    'Y55 the duplicate handoff did not restore the parent';
  ASSERT (v_result ->> 'reason') = 'destination_not_pending',
    'Y55 the duplicate handoff is named as one';
  ASSERT (v_result ->> 'destination_status') = 'success',
    'Y55 the answer carries the status of the row that is no longer pending';
  ASSERT (v_result ->> 'current_status') = 'completed',
    'Y55 the answer carries the status of the parent';
  ASSERT (SELECT status FROM public.posts WHERE id = v_post_a) = 'completed',
    'Y55 the parent keeps the result it earned';
  ASSERT (SELECT status FROM public.platform_posts WHERE id = v_row) = 'success',
    'Y55 the closed row is not reopened';

  -- The row is required: a restoration that cannot see the destination it is
  -- restoring for is the old restoration.
  v_result := public.restore_youtube_pending_post(v_post_a, v_attempt, v_fence, NULL);
  ASSERT (v_result ->> 'restored')::boolean = false
     AND (v_result ->> 'reason') = 'invalid_arguments'
     AND (v_result ->> 'current_status') = 'completed',
    'Y55 the restoration needs the row it is restoring for';

  -- WHY THE GUARD IS NEEDED
  --
  -- The old restoration cannot answer that question: the attempt matches, the
  -- content matches and the rollup it reads IS the provenance of the
  -- settlement that landed. So it restores a parent that has already rolled
  -- up, and the post waits for a destination that is already closed.
  v_result := public.restore_legacy_pending_post(v_post_a, v_attempt, v_fence, true);
  ASSERT (v_result ->> 'restored')::boolean = true,
    'Y55 the old restoration brings the completed parent back to processing';
  ASSERT (SELECT status FROM public.posts WHERE id = v_post_a) = 'processing',
    'Y55 and the post then waits for a destination that is already closed';

  RAISE NOTICE 'PASS Y55: the lost answer does not bring a completed parent back to processing';
END
$y55_lost_ack$;

-- ---------------------------------------------------------------------------
-- Y56: A HANDOFF THAT IS GENUINELY PENDING IS RESTORED.
--
-- The settlement was refused, so the row is still open and the parent is
-- still processing. The handoff is genuine: the destination that owns the row
-- has not finished, and the parent waits for it.
--
-- The guarded restoration answers the same as the old one here: the parent
-- stays processing, and the row stays open.
-- ---------------------------------------------------------------------------
DO $y56_genuinely_pending$
DECLARE
  v_acct_a  uuid;
  v_post_a  uuid;
  v_media_a uuid;
  v_u_a     uuid := 'b1000000-0000-4000-8000-000000000001';
  v_session uuid;
  v_lease   uuid := 'ed000000-0000-4000-8000-000000000056';
  v_row     uuid;
  v_attempt timestamptz;
  v_fence   jsonb;
  v_result  jsonb;
BEGIN
  SELECT f.account_id, f.post_id, f.media_id
    INTO v_acct_a, v_post_a, v_media_a
    FROM pg_temp.new_youtube_fixture('y56') f;
  v_session := (public.admit_youtube_upload(
      v_post_a, v_acct_a, v_u_a, v_media_a, 4096, 4096, '{}'::jsonb)
    -> 'session' ->> 'id')::uuid;
  PERFORM public.claim_youtube_upload_session(v_session, v_lease, 180000);

  SELECT processing_started_at INTO v_attempt FROM public.posts WHERE id = v_post_a;
  SELECT jsonb_build_object(
           'user_id', x.user_id, 'caption', x.caption, 'media_file_ids', x.media_file_ids,
           'metadata', public.normalize_threads_internal_metadata(x.metadata), 'platforms', x.platforms,
           'scheduled_at', x.scheduled_at, 'publish_requested_at', x.publish_requested_at, 'source', x.source)
    INTO v_fence FROM public.posts x WHERE x.id = v_post_a;

  -- The settlement is refused: the worker lost the lease, so the outcome was
  -- not written and the row is still open.
  PERFORM public.release_youtube_upload_session(v_session, v_lease, 'failed', 'the lease was lost');
  v_row := (SELECT platform_post_id FROM public.youtube_upload_sessions WHERE id = v_session);
  ASSERT (SELECT status FROM public.platform_posts WHERE id = v_row) = 'pending',
    'Y56 the row is still open';
  ASSERT (SELECT status FROM public.posts WHERE id = v_post_a) = 'processing',
    'Y56 the parent is still processing';

  v_result := public.restore_youtube_pending_post(v_post_a, v_attempt, v_fence, v_row);

  ASSERT (v_result ->> 'restored')::boolean = true,
    'Y56 the genuine handoff is restored';
  ASSERT (v_result ->> 'already_processing')::boolean = true,
    'Y56 the answer says the parent was already processing';
  ASSERT (SELECT status FROM public.posts WHERE id = v_post_a) = 'processing',
    'Y56 the parent waits for the destination that owns the row';
  ASSERT (SELECT status FROM public.platform_posts WHERE id = v_row) = 'pending',
    'Y56 the row stays open';

  RAISE NOTICE 'PASS Y56: a handoff that is genuinely pending keeps the parent processing';
END
$y56_genuinely_pending$;

-- ---------------------------------------------------------------------------
-- Y57: THE PARENT ROLLED UP WHILE THE ROW WAS STILL OPEN.
--
-- This is the case the restore exists for: a sibling rolled the parent up
-- while the destination of this handoff was still open, so the parent has to
-- go back to processing or the open destination is waited for by nobody.
--
-- The guard does not stand in the way of it: the row IS still pending, so the
-- restore goes ahead.
-- ---------------------------------------------------------------------------
DO $y57_rolled_up_parent$
DECLARE
  v_acct_a  uuid;
  v_post_a  uuid;
  v_media_a uuid;
  v_u_a     uuid := 'b1000000-0000-4000-8000-000000000001';
  v_session uuid;
  v_lease   uuid := 'ed000000-0000-4000-8000-000000000057';
  v_row     uuid;
  v_attempt timestamptz;
  v_fence   jsonb;
  v_result  jsonb;
BEGIN
  SELECT f.account_id, f.post_id, f.media_id
    INTO v_acct_a, v_post_a, v_media_a
    FROM pg_temp.new_youtube_fixture('y57') f;
  v_session := (public.admit_youtube_upload(
      v_post_a, v_acct_a, v_u_a, v_media_a, 4096, 4096, '{}'::jsonb)
    -> 'session' ->> 'id')::uuid;
  PERFORM public.claim_youtube_upload_session(v_session, v_lease, 180000);

  SELECT processing_started_at INTO v_attempt FROM public.posts WHERE id = v_post_a;
  SELECT jsonb_build_object(
           'user_id', x.user_id, 'caption', x.caption, 'media_file_ids', x.media_file_ids,
           'metadata', public.normalize_threads_internal_metadata(x.metadata), 'platforms', x.platforms,
           'scheduled_at', x.scheduled_at, 'publish_requested_at', x.publish_requested_at, 'source', x.source)
    INTO v_fence FROM public.posts x WHERE x.id = v_post_a;

  v_row := (SELECT platform_post_id FROM public.youtube_upload_sessions WHERE id = v_session);
  ASSERT (SELECT status FROM public.platform_posts WHERE id = v_row) = 'pending',
    'Y57 the row is still open';

  -- A sibling rolled the parent up, and the rollup belongs to this attempt.
  UPDATE public.posts
     SET status = 'completed',
         posted_at = now(),
         metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
           'settlement_rollup_at', now(),
           'settlement_rollup_status', 'completed',
           'settlement_rollup_processing_started_at', v_attempt)
   WHERE id = v_post_a;

  v_result := public.restore_youtube_pending_post(v_post_a, v_attempt, v_fence, v_row);

  ASSERT (v_result ->> 'restored')::boolean = true,
    'Y57 the rolled up parent is restored while the row is open';
  ASSERT (v_result ->> 'prior_status') = 'completed',
    'Y57 the answer carries the status the parent had';
  ASSERT (SELECT status FROM public.posts WHERE id = v_post_a) = 'processing',
    'Y57 the parent waits again for the open destination';
  ASSERT (SELECT status FROM public.platform_posts WHERE id = v_row) = 'pending',
    'Y57 the open row is not touched';

  RAISE NOTICE 'PASS Y57: a rolled up parent is restored while its row is still open';
END
$y57_rolled_up_parent$;

-- ---------------------------------------------------------------------------
-- Y58: THE OLD GENERIC RESTORATION IS UNTOUCHED.
--
-- The Threads and the fan-out paths keep the old restoration, because their
-- handoff does not name a row: they restore a parent that a SIBLING rolled up
-- while their own destination was still open, and that question cannot be
-- asked with a row in hand.
--
-- So the old restoration still restores, and the guarded one is the one the
-- YouTube path uses.
-- ---------------------------------------------------------------------------
DO $y58_generic_untouched$
DECLARE
  v_acct_a  uuid;
  v_post_a  uuid;
  v_media_a uuid;
  v_u_a     uuid := 'b1000000-0000-4000-8000-000000000001';
  v_session uuid;
  v_lease   uuid := 'ed000000-0000-4000-8000-000000000058';
  v_row     uuid;
  v_attempt timestamptz;
  v_fence   jsonb;
  v_result  jsonb;
BEGIN
  SELECT f.account_id, f.post_id, f.media_id
    INTO v_acct_a, v_post_a, v_media_a
    FROM pg_temp.new_youtube_fixture('y58') f;
  v_session := (public.admit_youtube_upload(
      v_post_a, v_acct_a, v_u_a, v_media_a, 4096, 4096, '{}'::jsonb)
    -> 'session' ->> 'id')::uuid;
  PERFORM public.claim_youtube_upload_session(v_session, v_lease, 180000);

  SELECT processing_started_at INTO v_attempt FROM public.posts WHERE id = v_post_a;
  SELECT jsonb_build_object(
           'user_id', x.user_id, 'caption', x.caption, 'media_file_ids', x.media_file_ids,
           'metadata', public.normalize_threads_internal_metadata(x.metadata), 'platforms', x.platforms,
           'scheduled_at', x.scheduled_at, 'publish_requested_at', x.publish_requested_at, 'source', x.source)
    INTO v_fence FROM public.posts x WHERE x.id = v_post_a;

  v_row := (SELECT platform_post_id FROM public.youtube_upload_sessions WHERE id = v_session);

  -- The parent rolled up, and the rollup belongs to this attempt.
  UPDATE public.posts
     SET status = 'completed',
         posted_at = now(),
         metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
           'settlement_rollup_at', now(),
           'settlement_rollup_status', 'completed',
           'settlement_rollup_processing_started_at', v_attempt)
   WHERE id = v_post_a;

  -- The old restoration still restores: it is the one the generic path uses.
  v_result := public.restore_legacy_pending_post(v_post_a, v_attempt, v_fence, true);
  ASSERT (v_result ->> 'restored')::boolean = true,
    'Y58 the generic restoration still restores';
  ASSERT (SELECT status FROM public.posts WHERE id = v_post_a) = 'processing',
    'Y58 the generic path is unchanged';

  RAISE NOTICE 'PASS Y58: the generic restoration is untouched';
END
$y58_generic_untouched$;

-- ---------------------------------------------------------------------------
-- Y59: THE MIME TYPE THE CALLER GAVE IS KEPT.
--
-- The upload settings are the query settings of the provider request, and the
-- mime type is one of them: the request has to say what it is sending. The
-- settings travel with the session as one JSON document, so a worker that
-- opens the provider session later makes the SAME request.
--
-- The settings are stored as they were given. Nothing picks the known keys
-- out of them, so a setting the database does not know about is not lost on
-- the way in.
-- ---------------------------------------------------------------------------
DO $y59_mime_kept$
DECLARE
  v_acct_a  uuid;
  v_post_a  uuid;
  v_media_a uuid;
  v_u_a     uuid := 'b1000000-0000-4000-8000-000000000001';
  v_session uuid;
  v_settings jsonb := jsonb_build_object(
    'part', 'snippet,status', 'notifySubscribers', true, 'mimeType', 'video/mp4');
BEGIN
  SELECT f.account_id, f.post_id, f.media_id
    INTO v_acct_a, v_post_a, v_media_a
    FROM pg_temp.new_youtube_fixture('y59') f;
  v_session := (public.admit_youtube_upload(
      v_post_a, v_acct_a, v_u_a, v_media_a, 4096, 4096, '{}'::jsonb,
      NULL, NULL, NULL, NULL, NULL, v_settings)
    -> 'session' ->> 'id')::uuid;

  ASSERT (SELECT upload_settings FROM public.youtube_upload_sessions WHERE id = v_session) = v_settings,
    'Y59 the settings the caller gave are kept as they are';
  ASSERT (SELECT upload_settings ->> 'mimeType' FROM public.youtube_upload_sessions WHERE id = v_session) = 'video/mp4',
    'Y59 the mime type survives the admission';

  RAISE NOTICE 'PASS Y59: the mime type the caller gave is kept';
END
$y59_mime_kept$;

-- ---------------------------------------------------------------------------
-- Y60: THE MEDIA VERSION FENCE FAILS CLOSED.
--
-- A fence exists to refuse what it cannot prove. A session that carries no
-- version is a fence that cannot be compared, and a fence that cannot be
-- compared must not let a write through. The runtime reads the same rule
-- before it writes (loadMatchingMedia), so the two agree.
--
-- The reason is the one the runtime maps to "the media is not available", so
-- the customer sees the same sentence whichever side refused.
-- ---------------------------------------------------------------------------
DO $y60_media_version_fence$
DECLARE
  v_acct_a  uuid;
  v_post_a  uuid;
  v_media_a uuid;
  v_u_a     uuid := 'b1000000-0000-4000-8000-000000000001';
  v_session uuid;
  v_lease   uuid := 'ec000000-0000-4000-8000-000000000060';
  v_result  jsonb;
BEGIN
  SELECT f.account_id, f.post_id, f.media_id
    INTO v_acct_a, v_post_a, v_media_a
    FROM pg_temp.new_youtube_fixture('y60') f;
  v_session := (public.admit_youtube_upload(
      v_post_a, v_acct_a, v_u_a, v_media_a, 4096, 4096, '{}'::jsonb)
    -> 'session' ->> 'id')::uuid;
  PERFORM public.claim_youtube_upload_session(v_session, v_lease, 180000);

  -- The session carries no version at all.
  UPDATE public.youtube_upload_sessions SET media_object_version = NULL WHERE id = v_session;

  v_result := public.youtube_upload_effect_authority(v_session, v_lease);
  ASSERT (v_result ->> 'authorized')::boolean = false,
    'Y60 a session without a version is not authorized';
  ASSERT (v_result ->> 'reason') = 'media_missing',
    'Y60 the reason says the media cannot be proven';

  RAISE NOTICE 'PASS Y60: the media version fence fails closed';
END
$y60_media_version_fence$;

-- ---------------------------------------------------------------------------
-- Y61: A NEW SESSION NEEDS AN AUTHORIZED TARGET.
--
-- The restarts ask the question and the effect authority asks it again
-- before every write. A session that was opened without asking it would be a
-- session the other paths cannot vouch for.
-- ---------------------------------------------------------------------------
DO $y61_new_session_scope$
DECLARE
  v_acct_a  uuid;
  v_post_a  uuid;
  v_media_a uuid;
  v_u_a     uuid := 'b1000000-0000-4000-8000-000000000001';
BEGIN
  SELECT f.account_id, f.post_id, f.media_id
    INTO v_acct_a, v_post_a, v_media_a
    FROM pg_temp.new_youtube_fixture('y61') f;

  -- The post does not publish to YouTube any more.
  UPDATE public.posts SET platforms = ARRAY['instagram'] WHERE id = v_post_a;

  BEGIN
    PERFORM public.admit_youtube_upload(v_post_a, v_acct_a, v_u_a, v_media_a, 4096, 4096, '{}'::jsonb);
    RAISE EXCEPTION 'Y61 a session was opened for a post that does not publish to YouTube';
  EXCEPTION WHEN SQLSTATE 'YUS15' THEN
    NULL;
  END;

  ASSERT NOT EXISTS (SELECT 1 FROM public.youtube_upload_sessions WHERE post_id = v_post_a),
    'Y61 a refused admission opens no session';
  ASSERT NOT EXISTS (SELECT 1 FROM public.platform_posts WHERE post_id = v_post_a),
    'Y61 a refused admission opens no public row';

  RAISE NOTICE 'PASS Y61: a new session needs an authorized target';
END
$y61_new_session_scope$;

-- ---------------------------------------------------------------------------
-- Y62: A SESSION WITHOUT AN ATTEMPT IS REFUSED EVERYWHERE.
--
-- The attempt is the fence that says whose upload this is. A session that
-- carries none is a fence that cannot be compared, so the write, the claim
-- and the settlement all refuse it.
-- ---------------------------------------------------------------------------
DO $y62_no_attempt$
DECLARE
  v_acct_a  uuid;
  v_post_a  uuid;
  v_media_a uuid;
  v_u_a     uuid := 'b1000000-0000-4000-8000-000000000001';
  v_session uuid;
  v_lease   uuid := 'ec000000-0000-4000-8000-000000000062';
  v_result  jsonb;
BEGIN
  SELECT f.account_id, f.post_id, f.media_id
    INTO v_acct_a, v_post_a, v_media_a
    FROM pg_temp.new_youtube_fixture('y62') f;
  v_session := (public.admit_youtube_upload(
      v_post_a, v_acct_a, v_u_a, v_media_a, 4096, 4096, '{}'::jsonb)
    -> 'session' ->> 'id')::uuid;
  PERFORM public.claim_youtube_upload_session(v_session, v_lease, 180000);

  -- The session carries no attempt at all.
  UPDATE public.youtube_upload_sessions SET attempt_started_at = NULL WHERE id = v_session;

  v_result := public.youtube_upload_effect_authority(v_session, v_lease);
  ASSERT (v_result ->> 'authorized')::boolean = false
     AND (v_result ->> 'reason') = 'stale_attempt',
    'Y62 a session without an attempt may not be written to';

  BEGIN
    PERFORM public.claim_youtube_upload_session(v_session, v_lease, 180000);
    RAISE EXCEPTION 'Y62 a session without an attempt was claimed';
  EXCEPTION WHEN SQLSTATE 'YUS11' THEN
    NULL;
  END;

  BEGIN
    PERFORM public.settle_youtube_upload_session(v_session, v_lease, 'failed', NULL,
      'the provider refused the upload');
    RAISE EXCEPTION 'Y62 a session without an attempt was settled';
  EXCEPTION WHEN SQLSTATE 'YUS11' THEN
    NULL;
  END;

  RAISE NOTICE 'PASS Y62: a session without an attempt is refused everywhere';
END
$y62_no_attempt$;

-- ---------------------------------------------------------------------------
-- Y63: A RETRY WITH A NEW VERSION OF THE SAME FILE IS ADMITTED.
--
-- The customer replaced the file under the same name: the file the post
-- names did not change, the content version did. The session of the previous
-- attempt still points at the version that is gone, and the admission used to
-- refuse the retry for ever.
--
-- The session is rebound to the version the file carries NOW, and the worker
-- has to name that version: the rebind pins the session to a version it did
-- not have, so the worker has to prove it read that one.
-- ---------------------------------------------------------------------------
DO $y63_new_version$
DECLARE
  v_acct_a  uuid;
  v_post_a  uuid;
  v_media_a uuid;
  v_u_a     uuid := 'b1000000-0000-4000-8000-000000000001';
  v_session uuid;
  v_lease   uuid := 'ec000000-0000-4000-8000-000000000063';
BEGIN
  SELECT f.account_id, f.post_id, f.media_id
    INTO v_acct_a, v_post_a, v_media_a
    FROM pg_temp.new_youtube_fixture('y63') f;
  v_session := (public.admit_youtube_upload(
      v_post_a, v_acct_a, v_u_a, v_media_a, 4096, 4096, '{}'::jsonb)
    -> 'session' ->> 'id')::uuid;

  -- The attempt failed for good and nothing ever reached the provider.
  PERFORM public.claim_youtube_upload_session(v_session, v_lease, 180000);
  PERFORM public.release_youtube_upload_session(v_session, v_lease, 'failed',
    'the provider refused the upload');
  PERFORM public.settle_youtube_upload_session(v_session, v_lease, 'failed', NULL,
    'the provider refused the upload');
  ASSERT (SELECT state FROM public.youtube_upload_sessions WHERE id = v_session) = 'failed',
    'Y63 the session is terminal';

  -- The customer replaces the file UNDER THE SAME NAME: the version changes.
  UPDATE public.media_files SET current_object_version = 2 WHERE id = v_media_a;

  -- And the customer retries the post: a new attempt, the same file.
  UPDATE public.posts
     SET processing_started_at = now() + interval '1 minute',
         status = 'processing'
   WHERE id = v_post_a;

  -- The retry names the version the worker read.
  PERFORM public.admit_youtube_upload(
    v_post_a, v_acct_a, v_u_a, v_media_a, 4096, 4096, '{}'::jsonb,
    NULL, NULL, NULL, NULL, 2, NULL);

  ASSERT (SELECT media_file_id FROM public.youtube_upload_sessions WHERE id = v_session) = v_media_a,
    'Y63 the file itself did not change';
  ASSERT (SELECT media_object_version FROM public.youtube_upload_sessions WHERE id = v_session) = 2,
    'Y63 the session is bound to the new version of the same file';
  ASSERT (SELECT state FROM public.youtube_upload_sessions WHERE id = v_session) = 'open',
    'Y63 the rebound session is open again';
  ASSERT (SELECT bytes_sent FROM public.youtube_upload_sessions WHERE id = v_session) = 0,
    'Y63 the rebound session has sent nothing';

  -- The file is replaced AGAIN, so the session points at a version that is
  -- gone and the rebind has to pin the new one.
  UPDATE public.media_files SET current_object_version = 3 WHERE id = v_media_a;
  UPDATE public.youtube_upload_sessions SET state = 'failed' WHERE id = v_session;

  -- A worker that names no version is refused: the rebind may not pin a
  -- version that nobody proved it read.
  BEGIN
    PERFORM public.admit_youtube_upload(
      v_post_a, v_acct_a, v_u_a, v_media_a, 4096, 4096, '{}'::jsonb,
      NULL, NULL, NULL, NULL, NULL, NULL);
    RAISE EXCEPTION 'Y63 a rebind without a named version was accepted';
  EXCEPTION WHEN SQLSTATE 'YUS03' THEN
    NULL;
  END;

  -- The worker that names the version it read is admitted.
  PERFORM public.admit_youtube_upload(
    v_post_a, v_acct_a, v_u_a, v_media_a, 4096, 4096, '{}'::jsonb,
    NULL, NULL, NULL, NULL, 3, NULL);
  ASSERT (SELECT media_object_version FROM public.youtube_upload_sessions WHERE id = v_session) = 3,
    'Y63 the session follows the version the worker proved it read';

  RAISE NOTICE 'PASS Y63: a retry with a new version of the same file is admitted';
END
$y63_new_version$;

-- ---------------------------------------------------------------------------
-- Y64: THE CONTINUATION BUDGET IS READ BEFORE ANYTHING IS WRITTEN.
--
-- A budget of zero or less would classify every open session as exhausted
-- and would let no session be claimed, and a budget of NULL would compare
-- with nothing at all. Both would leave the uploads of the whole table in a
-- state nobody asked for.
-- ---------------------------------------------------------------------------
DO $y64_budget$
DECLARE
  v_acct_a  uuid;
  v_post_a  uuid;
  v_media_a uuid;
  v_u_a     uuid := 'b1000000-0000-4000-8000-000000000001';
  v_session uuid;
  v_lease   uuid := 'ec000000-0000-4000-8000-000000000064';
BEGIN
  SELECT f.account_id, f.post_id, f.media_id
    INTO v_acct_a, v_post_a, v_media_a
    FROM pg_temp.new_youtube_fixture('y64') f;
  v_session := (public.admit_youtube_upload(
      v_post_a, v_acct_a, v_u_a, v_media_a, 4096, 4096, '{}'::jsonb)
    -> 'session' ->> 'id')::uuid;
  PERFORM public.claim_youtube_upload_session(v_session, v_lease, 180000);

  -- The provider session is gone and a byte reached the provider: this
  -- session is the one a budget of zero would classify as exhausted.
  PERFORM public.checkpoint_youtube_upload_session(v_session, v_lease, 4096, 4096,
    'https://upload.example.invalid/session/y64', true, now() - interval '1 minute', NULL);

  BEGIN
    PERFORM public.claim_youtube_upload_sessions(5, 180000, NULL);
    RAISE EXCEPTION 'Y64 a budget of NULL was accepted';
  EXCEPTION WHEN SQLSTATE 'YUS13' THEN
    NULL;
  END;

  BEGIN
    PERFORM public.claim_youtube_upload_sessions(5, 180000, 0);
    RAISE EXCEPTION 'Y64 a budget of zero was accepted';
  EXCEPTION WHEN SQLSTATE 'YUS13' THEN
    NULL;
  END;

  BEGIN
    PERFORM public.claim_youtube_upload_sessions(5, 180000, -1);
    RAISE EXCEPTION 'Y64 a budget of less than zero was accepted';
  EXCEPTION WHEN SQLSTATE 'YUS13' THEN
    NULL;
  END;

  -- Nothing was written while the budget was refused: the session that a
  -- budget of zero would have classified is still open.
  ASSERT (SELECT state FROM public.youtube_upload_sessions WHERE id = v_session) = 'open',
    'Y64 a refused budget classifies nothing';

  RAISE NOTICE 'PASS Y64: the continuation budget is read before anything is written';
END
$y64_budget$;

-- ---------------------------------------------------------------------------
-- Y65: THE RECOVERY HELPERS ARE SERVICE ROLE ONLY.
--
-- Each helper revokes the browser roles where it is declared. The catalog is
-- what the database will actually answer, so the catalog is what is checked.
-- ---------------------------------------------------------------------------
DO $y65_grants$
BEGIN
  ASSERT NOT has_function_privilege('anon',
           'public.recover_youtube_upload_terminal_results(integer)', 'EXECUTE'),
    'Y65 anon may not run the terminal recovery';
  ASSERT NOT has_function_privilege('authenticated',
           'public.recover_youtube_upload_terminal_results(integer)', 'EXECUTE'),
    'Y65 authenticated may not run the terminal recovery';
  ASSERT NOT has_function_privilege('authenticated',
           'public.reconcile_youtube_upload_fanouts(integer)', 'EXECUTE'),
    'Y65 authenticated may not run the fanout recovery';
  ASSERT NOT has_function_privilege('anon',
           'public.reconcile_youtube_upload_fanouts(integer)', 'EXECUTE'),
    'Y65 anon may not run the fanout recovery';
  ASSERT has_function_privilege('service_role',
           'public.recover_youtube_upload_terminal_results(integer)', 'EXECUTE'),
    'Y65 the service role may run the terminal recovery';
  ASSERT has_function_privilege('service_role',
           'public.reconcile_youtube_upload_fanouts(integer)', 'EXECUTE'),
    'Y65 the service role may run the fanout recovery';

  RAISE NOTICE 'PASS Y65: the recovery helpers are service role only';
END
$y65_grants$;

-- ---------------------------------------------------------------------------
-- Y66: A CANCELLATION AFTER THE FINAL DURABLE INTENT KEEPS THE UNCERTAINTY.
--
-- The runtime writes the intent BEFORE the chunk that creates the video: the
-- record has to say that a video may exist before the write, because the
-- write may be the last thing that happens.
--
-- A cancellation after that keeps the uncertainty. The provider may hold a
-- video, and a cancellation cannot undo a fact; so the row is closed as
-- uncertain and the session is left for a human.
--
-- The window between the authority check and the write cannot be closed
-- here: the provider does not take part in this transaction, and no
-- atomicity with it is possible. What this proves is that once the intent
-- is durable, the cancellation preserves it.
-- ---------------------------------------------------------------------------
DO $y66_cancelled_uncertain$
DECLARE
  v_acct_a  uuid;
  v_post_a  uuid;
  v_media_a uuid;
  v_u_a     uuid := 'b1000000-0000-4000-8000-000000000001';
  v_session uuid;
  v_lease   uuid := 'ec000000-0000-4000-8000-000000000066';
  v_row_id  uuid;
  v_answer  jsonb;
BEGIN
  SELECT f.account_id, f.post_id, f.media_id
    INTO v_acct_a, v_post_a, v_media_a
    FROM pg_temp.new_youtube_fixture('y66') f;
  v_session := (public.admit_youtube_upload(
      v_post_a, v_acct_a, v_u_a, v_media_a, 4096, 4096, '{}'::jsonb)
    -> 'session' ->> 'id')::uuid;
  v_row_id := (SELECT platform_post_id FROM public.youtube_upload_sessions WHERE id = v_session);
  PERFORM public.claim_youtube_upload_session(v_session, v_lease, 180000);

  -- THE FINAL DURABLE INTENT
  PERFORM public.checkpoint_youtube_upload_session(v_session, v_lease, 4096, 4096,
    'https://upload.example.invalid/session/y66', true, NULL, NULL);
  ASSERT (SELECT video_may_exist FROM public.youtube_upload_sessions WHERE id = v_session) = true,
    'Y66 the intent is durable before the write';

  -- The owner cancels the post.
  UPDATE public.posts SET status = 'failed' WHERE id = v_post_a;
  v_answer := public.youtube_upload_terminalize_cancelled(v_session);

  ASSERT (v_answer ->> 'terminalized') = 'true',
    'Y66 the row of the cancelled post is closed';
  ASSERT (v_answer ->> 'reason') = 'youtube_upload_reconcile_required',
    'Y66 the cancellation keeps the uncertainty';
  ASSERT (SELECT state FROM public.youtube_upload_sessions WHERE id = v_session) = 'reconcile',
    'Y66 the session is left for a human';
  ASSERT (SELECT response_data ->> 'publish_outcome' FROM public.platform_posts WHERE id = v_row_id) = 'uncertain',
    'Y66 the row says the outcome is uncertain';
  ASSERT (SELECT response_data ->> 'youtube_upload_reason' FROM public.platform_posts WHERE id = v_row_id)
         = 'youtube_upload_reconcile_required',
    'Y66 the row carries the stable public reason';

  RAISE NOTICE 'PASS Y66: a cancellation after the final durable intent keeps the uncertainty';
END
$y66_cancelled_uncertain$;

-- ---------------------------------------------------------------------------
-- Y67: THE OUTCOME OF A DESTINATION THAT GOES WITH THE ACCOUNT.
--
-- The result row of a destination belongs to the account it published on, so
-- it is deleted with the account the customer disconnects. The video id of a
-- published video and the marker of an uncertain upload live on that row, and
-- the session keeps them where the owner does not read them.
--
-- So the evidence is copied onto the post before the row goes: the post is
-- the row the owner keeps, and it outlives every account the customer may
-- disconnect. Both outcomes are proved here: the receipt of a published
-- video, and the marker of an upload that may already have published one.
-- ---------------------------------------------------------------------------
DO $y67_disconnected_outcome$
DECLARE
  v_acct_a   uuid;
  v_post_a   uuid;
  v_media_a  uuid;
  v_u_a      uuid := 'b1000000-0000-4000-8000-000000000001';
  v_session  uuid;
  v_row_id   uuid;
  v_lease    uuid := 'ed000000-0000-4000-8000-000000000067';
  v_outcomes jsonb;
BEGIN
  -- THE RECEIPT OF A PUBLISHED VIDEO.
  SELECT f.account_id, f.post_id, f.media_id
    INTO v_acct_a, v_post_a, v_media_a
    FROM pg_temp.new_youtube_fixture('y67a') f;
  v_session := (public.admit_youtube_upload(
      v_post_a, v_acct_a, v_u_a, v_media_a, 4096, 4096, '{}'::jsonb)
    -> 'session' ->> 'id')::uuid;
  v_row_id := (SELECT platform_post_id FROM public.youtube_upload_sessions WHERE id = v_session);
  PERFORM public.claim_youtube_upload_session(v_session, v_lease, 180000);
  PERFORM public.checkpoint_youtube_upload_session(v_session, v_lease, 4096, 4096,
    'https://upload.example.invalid/session/y67a', true, NULL, NULL);
  PERFORM public.complete_youtube_upload_session(v_session, v_lease, 'yt-video-y67a');

  -- The customer disconnects the account: the result row goes with it.
  DELETE FROM public.social_accounts WHERE id = v_acct_a;

  ASSERT NOT EXISTS (SELECT 1 FROM public.platform_posts WHERE id = v_row_id),
    'Y67 the result row goes with the account';
  v_outcomes := (SELECT metadata -> 'youtube_upload_outcomes' FROM public.posts WHERE id = v_post_a);
  ASSERT v_outcomes -> (v_row_id::text) ->> 'outcome' = 'published',
    'Y67 the post keeps the outcome of the published video';
  ASSERT v_outcomes -> (v_row_id::text) ->> 'video_id' = 'yt-video-y67a',
    'Y67 the post keeps the video id of the published video';
  ASSERT v_outcomes -> (v_row_id::text) ->> 'channel_id' = 'yt-y67a',
    'Y67 the post keeps the channel the video was published on';

  -- THE MARKER OF AN UPLOAD THAT MAY ALREADY HAVE PUBLISHED ONE.
  SELECT f.account_id, f.post_id, f.media_id
    INTO v_acct_a, v_post_a, v_media_a
    FROM pg_temp.new_youtube_fixture('y67b') f;
  v_session := (public.admit_youtube_upload(
      v_post_a, v_acct_a, v_u_a, v_media_a, 4096, 4096, '{}'::jsonb)
    -> 'session' ->> 'id')::uuid;
  v_row_id := (SELECT platform_post_id FROM public.youtube_upload_sessions WHERE id = v_session);
  PERFORM public.claim_youtube_upload_session(v_session, v_lease, 180000);
  PERFORM public.release_youtube_upload_session(v_session, v_lease, 'reconcile',
    'the provider may already hold a video');

  DELETE FROM public.social_accounts WHERE id = v_acct_a;

  v_outcomes := (SELECT metadata -> 'youtube_upload_outcomes' FROM public.posts WHERE id = v_post_a);
  ASSERT v_outcomes -> (v_row_id::text) ->> 'outcome' = 'uncertain',
    'Y67 the post keeps the marker of the uncertain upload';
  ASSERT v_outcomes -> (v_row_id::text) ->> 'publish_outcome_reason' IS NOT NULL,
    'Y67 the post says why the outcome is uncertain';
  ASSERT v_outcomes -> (v_row_id::text) ->> 'channel_id' = 'yt-y67b',
    'Y67 the post keeps the channel the upload was for';

  -- A result that says nothing leaves no evidence behind.
  SELECT f.account_id, f.post_id, f.media_id
    INTO v_acct_a, v_post_a, v_media_a
    FROM pg_temp.new_youtube_fixture('y67c') f;
  v_session := (public.admit_youtube_upload(
      v_post_a, v_acct_a, v_u_a, v_media_a, 4096, 4096, '{}'::jsonb)
    -> 'session' ->> 'id')::uuid;
  v_row_id := (SELECT platform_post_id FROM public.youtube_upload_sessions WHERE id = v_session);
  DELETE FROM public.social_accounts WHERE id = v_acct_a;
  ASSERT (SELECT metadata -> 'youtube_upload_outcomes' FROM public.posts WHERE id = v_post_a) IS NULL,
    'Y67 a result that says nothing leaves no evidence behind';

  RAISE NOTICE 'PASS Y67: the outcome of a destination that goes with the account is kept';
END
$y67_disconnected_outcome$;

-- ---------------------------------------------------------------------------
-- Y68: THE FENCE FAILS CLOSED, AND A POISONED CANDIDATE IS REFUSED.
--
-- The candidate and the rollup markers live in `posts.metadata`, and the owner
-- can write that column. Two things follow, and both are proved here:
--
--   * the fence that asks "did this attempt already roll the parent up?" must
--     fail CLOSED. A marker that is missing leaves that question NULL, and a
--     NULL answer used to skip the refusal, so a post that was cancelled or
--     superseded could be closed by an attempt that had proved nothing;
--
--   * a value that cannot be read must be REFUSED, never raised. One poisoned
--     row used to raise inside the recovery and take the whole reconciler
--     down with it, so every session behind it starved.
-- ---------------------------------------------------------------------------
DO $y68_fence_and_poison$
DECLARE
  v_acct_a        uuid;
  v_post_a        uuid;
  v_media_a       uuid;
  v_u_a           uuid := 'b1000000-0000-4000-8000-000000000001';
  v_lease         uuid := 'e4000000-0000-4000-8000-000000000001';
  v_attempt       timestamptz;
  v_content       jsonb;
  v_session       uuid;
  v_result        jsonb;
BEGIN
  -- THE FENCE FAILS CLOSED.
  --
  -- This scenario owns its post, its account and its media file.
  SELECT f.account_id, f.post_id, f.media_id
    INTO v_acct_a, v_post_a, v_media_a
    FROM pg_temp.new_youtube_fixture('y68a') f;

  -- The worker that owned this attempt is gone, so the closure may be made.
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
    ARRAY[v_acct_a], ARRAY[]::uuid[]);

  v_session := (public.admit_youtube_upload(
      v_post_a, v_acct_a, v_u_a, v_media_a, 4096, 4096, '{}'::jsonb)
    -> 'session' ->> 'id')::uuid;

  -- The worker is gone and the session is left for a human, so the closure
  -- may be made.
  PERFORM public.claim_youtube_upload_session(v_session, v_lease, 180000);
  PERFORM public.release_youtube_upload_session(v_session, v_lease, 'reconcile',
    'the provider may already hold a video');

  -- The post was failed while the worker was gone. It carries no rollup
  -- marker, so nothing proves that this attempt rolled it up.
  UPDATE public.posts SET status = 'failed' WHERE id = v_post_a;

  v_result := public.recover_youtube_upload_fanout(v_session, NULL);
  ASSERT (v_result ->> 'recovered')::boolean IS NOT TRUE,
    'Y68 a post that is not processing is not closed';
  ASSERT (v_result ->> 'reason') = 'post_not_processing',
    'Y68 the refusal says the post was not closed';
  ASSERT (SELECT metadata #>> '{legacy_notification_candidate,fanout_closed}'
            FROM public.posts WHERE id = v_post_a) IS DISTINCT FROM 'true',
    'Y68 the fanout of a post that is not processing is not closed';

  -- A POISONED CANDIDATE IS REFUSED, NOT RAISED.
  --
  -- This scenario owns its post, its account and its media file.
  SELECT f.account_id, f.post_id, f.media_id
    INTO v_acct_a, v_post_a, v_media_a
    FROM pg_temp.new_youtube_fixture('y68b') f;

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
    ARRAY[v_acct_a], ARRAY[]::uuid[]);

  v_session := (public.admit_youtube_upload(
      v_post_a, v_acct_a, v_u_a, v_media_a, 4096, 4096, '{}'::jsonb)
    -> 'session' ->> 'id')::uuid;

  -- The worker is gone and the session is left for a human, so the closure
  -- may be made.
  PERFORM public.claim_youtube_upload_session(v_session, v_lease, 180000);
  PERFORM public.release_youtube_upload_session(v_session, v_lease, 'reconcile',
    'the provider may already hold a video');

  -- The owner writes a timestamp that is not one. The session's own attempt
  -- is kept to restore the candidate with the exact value it enrolled.
  v_attempt := (SELECT attempt_started_at FROM public.youtube_upload_sessions WHERE id = v_session);
  UPDATE public.posts
     SET metadata = jsonb_set(metadata, '{legacy_notification_candidate,attempt_started_at}',
           to_jsonb('not-a-timestamp'::text))
   WHERE id = v_post_a;

  v_result := public.recover_youtube_upload_fanout(v_session, NULL);
  ASSERT (v_result ->> 'recovered')::boolean IS NOT TRUE,
    'Y68 a candidate that cannot be read is not closed';
  ASSERT (v_result ->> 'reason') = 'no_candidate_for_attempt',
    'Y68 the refusal says the candidate was not usable';

  -- The attempt is readable again, so the next refusals are about the scope
  -- and not about the attempt.
  UPDATE public.posts
     SET metadata = jsonb_set(metadata, '{legacy_notification_candidate,attempt_started_at}',
           to_jsonb(v_attempt))
   WHERE id = v_post_a;

  -- The owner writes a scope that is not a list.
  UPDATE public.posts
     SET metadata = jsonb_set(metadata, '{legacy_notification_candidate,target_account_ids}',
           to_jsonb('not-a-list'::text))
   WHERE id = v_post_a;

  v_result := public.recover_youtube_upload_fanout(v_session, NULL);
  ASSERT (v_result ->> 'reason') = 'no_candidate_for_attempt',
    'Y68 a scope that is not a list is refused';

  -- The owner writes an account that is not one.
  UPDATE public.posts
     SET metadata = jsonb_set(metadata, '{legacy_notification_candidate,target_account_ids}',
           to_jsonb(jsonb_build_array('not-an-account')))
   WHERE id = v_post_a;

  v_result := public.recover_youtube_upload_fanout(v_session, NULL);
  ASSERT (v_result ->> 'reason') = 'no_candidate_for_attempt',
    'Y68 a destination that is not an account is refused';

  RAISE NOTICE 'PASS Y68: the fence fails closed and a poisoned candidate is refused';
END
$y68_fence_and_poison$;

-- ---------------------------------------------------------------------------
-- Y69: THE TERMINAL SCAN LEAVES OUT THE SESSIONS IT CANNOT CLASSIFY.
--
-- The classifier refuses a session that carries no attempt, and it changes
-- nothing when it refuses. A scan that selected such a session would select
-- it again on the next pass, and the sessions that CAN be settled would never
-- be reached. The sibling scan leaves them out for the same reason.
--
-- The parent carries no attempt either: then the "is this the running
-- attempt" predicate matches a NULL with a NULL, and ONLY the guard that
-- names the missing attempt keeps the session out. The test would not detect
-- a regression in that guard when the parent still carried an attempt.
-- ---------------------------------------------------------------------------
DO $y69_terminal_scan$
DECLARE
  v_acct_a   uuid;
  v_post_a   uuid;
  v_media_a  uuid;
  v_u_a      uuid := 'b1000000-0000-4000-8000-000000000001';
  v_lease    uuid := 'e4000000-0000-4000-8000-000000000001';
  v_session  uuid;
  v_row_id   uuid;
  v_examined integer;
BEGIN
  -- This scenario owns its post, its account and its media file.
  SELECT f.account_id, f.post_id, f.media_id
    INTO v_acct_a, v_post_a, v_media_a
    FROM pg_temp.new_youtube_fixture('y69') f;

  v_session := (public.admit_youtube_upload(
      v_post_a, v_acct_a, v_u_a, v_media_a, 4096, 4096, '{}'::jsonb)
    -> 'session' ->> 'id')::uuid;
  v_row_id := (SELECT platform_post_id FROM public.youtube_upload_sessions WHERE id = v_session);

  -- The provider may already hold a video, so the session is released for a
  -- human and its row stays pending.
  PERFORM public.claim_youtube_upload_session(v_session, v_lease, 180000);
  PERFORM public.release_youtube_upload_session(v_session, v_lease, 'reconcile',
    'the provider may already hold a video');

  -- The session carries no attempt, so the classifier refuses it, and no
  -- worker holds its lease any more, so the scan may look at it. The parent
  -- carries no attempt either: the "is this the running attempt" predicate
  -- matches NULL with NULL, so the guard that names the missing attempt is
  -- the one condition that keeps the session out of the scan.
  UPDATE public.youtube_upload_sessions
     SET attempt_started_at = NULL,
         lease_token = NULL,
         lease_expires_at = now() - interval '1 hour'
   WHERE id = v_session;
  UPDATE public.posts
     SET processing_started_at = NULL
   WHERE id = v_post_a;

  -- Every other session keeps a live lease, so the scan cannot select it and
  -- the count below is a proof about THIS session alone.
  UPDATE public.youtube_upload_sessions
     SET lease_expires_at = now() + interval '1 hour'
   WHERE id <> v_session;

  v_examined := (public.recover_youtube_upload_terminal_results(50) ->> 'examined')::int;
  ASSERT v_examined = 0,
    'Y69 the scan does not select a session it cannot classify';

  -- And the session is exactly as it was: not settled, not closed.
  ASSERT (SELECT status FROM public.platform_posts WHERE id = v_row_id) = 'pending',
    'Y69 the row of the unclassifiable session stays pending';
  ASSERT (SELECT state FROM public.youtube_upload_sessions WHERE id = v_session) = 'reconcile',
    'Y69 the unclassifiable session keeps its state';
  ASSERT (public.youtube_upload_classify_terminal(v_session) ->> 'reason') = 'stale_attempt',
    'Y69 the classifier still refuses the session that carries no attempt';

  RAISE NOTICE 'PASS Y69: the terminal scan leaves out the sessions it cannot classify';
END
$y69_terminal_scan$;

-- ---------------------------------------------------------------------------
-- Y70: THE DISCONNECT SETTLES THE SESSION UNDER THE SHARED LOCK.
--
-- The receipt of a session is read from the row. When the account is
-- disconnected, the receipt was read from a SNAPSHOT taken without a lock,
-- so a completion that landed in between was overwritten by a failure. The
-- session is now taken through the shared lock helper -- the same order every
-- other writer shares -- and the receipt is read under it.
--
-- The order is a property of the code, so it is proved on the code.
-- ---------------------------------------------------------------------------
DO $y70_disconnect_lock$
DECLARE
  v_def    text;
  v_part   text;
  v_lock   integer;
  v_receipt integer;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'terminalize_youtube_upload_sessions_of_account';
  ASSERT v_def IS NOT NULL,
    'Y70 the disconnect writer exists';

  v_lock := position('youtube_upload_lock_scope' IN v_def);
  ASSERT v_lock > 0,
    'Y70 the disconnect writer takes its scope through the shared helper';

  -- The session row is read AGAIN after the lock, not only before it: a read
  -- that stayed before the lock could use a snapshot that predates a
  -- concurrent completion, and the settlement would overwrite it.
  v_receipt := position('SELECT * INTO v_session' IN v_def);
  ASSERT v_receipt > v_lock,
    'Y70 the session row is read under the lock';

  -- The receipt is read AFTER the lock, not before it.
  v_receipt := position('v_receipt := v_session.video_id' IN v_def);
  ASSERT v_receipt > v_lock,
    'Y70 the receipt is read under the lock';

  -- The writer may not take the session lock itself.
  FOR v_part IN SELECT unnest(string_to_array(v_def, ';')) LOOP
    IF position('FOR UPDATE' IN v_part) > 0 THEN
      ASSERT position('youtube_upload_sessions' IN v_part) = 0,
        'Y70 the disconnect writer does not take the session lock itself';
    END IF;
  END LOOP;

  RAISE NOTICE 'PASS Y70: the disconnect settles the session under the shared lock';
END
$y70_disconnect_lock$;

-- ---------------------------------------------------------------------------
-- Y71: A SCOPE WITH A JSON NULL OR A MALFORMED ELEMENT IS REFUSED, NEVER
--      EMPTIED.
--
-- A JSON null inside a scope array becomes a SQL NULL. The regex guard did
-- not reject it, the aggregation carried it into the scope array, and the ANY
-- comparison with a NULL element answers NULL for every valid account -- so
-- one poisoned element emptied the whole scope and the closure read a scope
-- that named nothing. NULL elements are refused with the malformed ones.
-- ---------------------------------------------------------------------------
DO $y71_null_scope$
DECLARE
  v_acct_a  uuid;
  v_post_a  uuid;
  v_media_a uuid;
  v_u_a     uuid := 'b1000000-0000-4000-8000-000000000001';
  v_lease   uuid := 'e4000000-0000-4000-8000-000000000001';
  v_attempt timestamptz;
  v_content jsonb;
  v_session uuid;
  v_result  jsonb;
BEGIN
  -- This scenario owns its post, its account and its media file.
  SELECT f.account_id, f.post_id, f.media_id
    INTO v_acct_a, v_post_a, v_media_a
    FROM pg_temp.new_youtube_fixture('y71') f;

  -- The worker that owned this attempt is gone, so the closure may be made.
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
    ARRAY[v_acct_a], ARRAY[]::uuid[]);

  v_session := (public.admit_youtube_upload(
      v_post_a, v_acct_a, v_u_a, v_media_a, 4096, 4096, '{}'::jsonb)
    -> 'session' ->> 'id')::uuid;

  -- The worker is gone and the session is left for a human, so the closure
  -- may be made.
  PERFORM public.claim_youtube_upload_session(v_session, v_lease, 180000);
  PERFORM public.release_youtube_upload_session(v_session, v_lease, 'reconcile',
    'the provider may already hold a video');

  -- The owner writes a scope with a JSON null beside the valid account.
  UPDATE public.posts
     SET metadata = jsonb_set(metadata, '{legacy_notification_candidate,target_account_ids}',
           jsonb_build_array(v_acct_a::text, NULL))
   WHERE id = v_post_a;

  v_result := public.recover_youtube_upload_fanout(v_session, NULL);
  ASSERT (v_result ->> 'recovered')::boolean IS NOT TRUE,
    'Y71 a scope with a null element is not closed';
  ASSERT (v_result ->> 'reason') = 'no_candidate_for_attempt',
    'Y71 the refusal says the scope was not usable';

  -- And a scope with a malformed element beside the valid account.
  UPDATE public.posts
     SET metadata = jsonb_set(metadata, '{legacy_notification_candidate,target_account_ids}',
           jsonb_build_array(v_acct_a::text, 'not-an-account'))
   WHERE id = v_post_a;

  v_result := public.recover_youtube_upload_fanout(v_session, NULL);
  ASSERT (v_result ->> 'reason') = 'no_candidate_for_attempt',
    'Y71 a scope with a malformed element is refused';

  -- The valid account did not lose its scope to the poisoned element: the
  -- candidate is unchanged and the fanout is not closed.
  ASSERT (SELECT metadata #>> '{legacy_notification_candidate,fanout_closed}'
            FROM public.posts WHERE id = v_post_a) IS DISTINCT FROM 'true',
    'Y71 the fanout of a poisoned scope is not closed';

  RAISE NOTICE 'PASS Y71: a scope with a null or a malformed element is refused, never emptied';
END
$y71_null_scope$;

-- ---------------------------------------------------------------------------
-- Y72: A TIMESTAMP WITH AN INVALID CALENDAR DATE IS A NON-MATCH, NOT AN ABORT.
--
-- The prefix guard accepted any value that LOOKED like a date, and the cast
-- raised on an invalid calendar date -- one poisoned row aborted the recovery
-- statement and starved every session behind it. All three sites read the
-- value through the validating conversion now: a malformed value is a value
-- that does not match.
-- ---------------------------------------------------------------------------
DO $y72_invalid_dates$
DECLARE
  v_acct_a  uuid;
  v_post_a  uuid;
  v_media_a uuid;
  v_u_a     uuid := 'b1000000-0000-4000-8000-000000000001';
  v_lease   uuid := 'e4000000-0000-4000-8000-000000000001';
  v_attempt timestamptz;
  v_content jsonb;
  v_session uuid;
  v_row_id  uuid;
  v_result  jsonb;
BEGIN
  -- THE CANDIDATE ATTEMPT. A date that is not on the calendar is a candidate
  -- of no attempt, refused the way any other non-match is refused.
  SELECT f.account_id, f.post_id, f.media_id
    INTO v_acct_a, v_post_a, v_media_a
    FROM pg_temp.new_youtube_fixture('y72a') f;

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
    ARRAY[v_acct_a], ARRAY[]::uuid[]);

  v_session := (public.admit_youtube_upload(
      v_post_a, v_acct_a, v_u_a, v_media_a, 4096, 4096, '{}'::jsonb)
    -> 'session' ->> 'id')::uuid;

  PERFORM public.claim_youtube_upload_session(v_session, v_lease, 180000);
  PERFORM public.release_youtube_upload_session(v_session, v_lease, 'reconcile',
    'the provider may already hold a video');

  UPDATE public.posts
     SET metadata = jsonb_set(metadata, '{legacy_notification_candidate,attempt_started_at}',
           to_jsonb('2026-02-31T00:00:00Z'::text))
   WHERE id = v_post_a;

  -- Reaching the assertions at all proves the conversion did not raise.
  v_result := public.recover_youtube_upload_fanout(v_session, NULL);
  ASSERT (v_result ->> 'recovered')::boolean IS NOT TRUE,
    'Y72 a candidate with an impossible date is not closed';
  ASSERT (v_result ->> 'reason') = 'no_candidate_for_attempt',
    'Y72 an impossible date is a candidate of no attempt';

  -- THE ROLLUP MARKER. A rolled-up post proves its closure with the marker;
  -- a marker with an impossible date proves nothing, and it does not abort
  -- the fence either.
  SELECT f.account_id, f.post_id, f.media_id
    INTO v_acct_a, v_post_a, v_media_a
    FROM pg_temp.new_youtube_fixture('y72b') f;

  UPDATE public.posts
     SET processing_started_at = now() - public.youtube_upload_attempt_quiet_after() - interval '1 second'
   WHERE id = v_post_a;

  SELECT jsonb_build_object(
           'user_id', x.user_id, 'caption', x.caption, 'media_file_ids', x.media_file_ids,
           'metadata', public.normalize_threads_internal_metadata(x.metadata), 'platforms', x.platforms,
           'scheduled_at', x.scheduled_at, 'publish_requested_at', x.publish_requested_at, 'source', x.source)
    INTO v_content FROM public.posts x WHERE x.id = v_post_a;

  PERFORM public.enroll_post_notification_recovery(v_post_a,
    (SELECT processing_started_at FROM public.posts WHERE id = v_post_a),
    v_content, ARRAY[v_acct_a], ARRAY[]::uuid[]);

  v_session := (public.admit_youtube_upload(
      v_post_a, v_acct_a, v_u_a, v_media_a, 4096, 4096, '{}'::jsonb)
    -> 'session' ->> 'id')::uuid;

  PERFORM public.claim_youtube_upload_session(v_session, v_lease, 180000);
  PERFORM public.release_youtube_upload_session(v_session, v_lease, 'reconcile',
    'the provider may already hold a video');

  -- The post is failed and carries markers with an impossible date, so
  -- nothing proves this attempt rolled it up.
  UPDATE public.posts
     SET status = 'failed',
         metadata = metadata || jsonb_build_object(
           'settlement_rollup_status', 'failed',
           'settlement_rollup_processing_started_at', '2026-02-31T00:00:00Z')
   WHERE id = v_post_a;

  v_result := public.recover_youtube_upload_fanout(v_session, NULL);
  ASSERT (v_result ->> 'reason') = 'post_not_processing',
    'Y72 an impossible rollup date proves nothing and aborts nothing';

  -- The deferred attempt a result row carries is read by close_post_fanout
  -- (applied before this migration) with an unvalidated cast; that path is a
  -- recorded follow-up, not part of this migration.
  RAISE NOTICE 'PASS Y72: an impossible date is a non-match, never an abort';
END
$y72_invalid_dates$;

-- ---------------------------------------------------------------------------
-- Y73: THE CANCELLATION SCAN LEAVES OUT THE SESSIONS WITHOUT AN ATTEMPT.
--
-- The helper refuses a session whose attempt is NULL and changes nothing, so
-- with it in the scan the same slot is spent on the same refusal on every
-- pass. The scan leaves it out, and the cancelled row behind it is reached.
--
-- The session without an attempt is the OLDER one: with one slot, it is the
-- one a scan that did not leave it out would pick. The scan reads the whole
-- table, and the scenarios before this one leave their own cancelled rows
-- behind, so the order is pinned here instead of trusted to the clock.
-- ---------------------------------------------------------------------------
DO $y73_cancel_scan$
DECLARE
  v_acct_a uuid;
  v_post_a uuid;
  v_media_a uuid;
  v_acct_b uuid;
  v_post_b uuid;
  v_media_b uuid;
  v_u_a     uuid := 'b1000000-0000-4000-8000-000000000001';
  v_row_a   uuid;
  v_row_b   uuid;
  v_result  jsonb;
BEGIN
  -- The older session: it carries no attempt, and its post does not either,
  -- so the "is this the running attempt" predicate matches NULL with NULL
  -- and nothing else keeps it out of the scan.
  SELECT f.account_id, f.post_id, f.media_id
    INTO v_acct_a, v_post_a, v_media_a
    FROM pg_temp.new_youtube_fixture('y73a') f;
  PERFORM public.admit_youtube_upload(v_post_a, v_acct_a, v_u_a, v_media_a, 4096, 4096, '{}'::jsonb);
  v_row_a := (SELECT platform_post_id FROM public.youtube_upload_sessions
               WHERE post_id = v_post_a);
  UPDATE public.youtube_upload_sessions
     SET attempt_started_at = NULL,
         updated_at = '2000-01-01T00:00:00Z'
   WHERE post_id = v_post_a;
  UPDATE public.posts
     SET status = 'failed', processing_started_at = NULL
   WHERE id = v_post_a;

  -- The newer session: cancelled, with its attempt still the one the post
  -- carries, and its row still pending. It sorts right behind the session
  -- without an attempt, before everything the earlier scenarios left behind.
  SELECT f.account_id, f.post_id, f.media_id
    INTO v_acct_b, v_post_b, v_media_b
    FROM pg_temp.new_youtube_fixture('y73b') f;
  PERFORM public.admit_youtube_upload(v_post_b, v_acct_b, v_u_a, v_media_b, 4096, 4096, '{}'::jsonb);
  v_row_b := (SELECT platform_post_id FROM public.youtube_upload_sessions
               WHERE post_id = v_post_b);
  UPDATE public.posts SET status = 'failed' WHERE id = v_post_b;
  UPDATE public.youtube_upload_sessions
     SET updated_at = '2001-01-01T00:00:00Z'
   WHERE post_id = v_post_b;

  -- ONE slot. The scan has to spend it on the row it can close: the session
  -- without an attempt is left out, and the cancelled row behind it is
  -- reached. Without the guard, the slot would be spent on the refusal of
  -- the older session, and the count would stay 0.
  v_result := public.reconcile_youtube_upload_fanouts(1);

  ASSERT (v_result ->> 'cancelled_rows')::integer = 1,
    'Y73 the slot goes to the cancelled row that can be closed';
  ASSERT (SELECT status FROM public.platform_posts WHERE id = v_row_b) = 'failed',
    'Y73 the cancelled row behind the unclassifiable session is closed';
  ASSERT (SELECT error_message FROM public.platform_posts WHERE id = v_row_b)
           = 'youtube_upload_cancelled',
    'Y73 the closed row carries the reason of the cancellation';
  ASSERT (SELECT status FROM public.platform_posts WHERE id = v_row_a) = 'pending',
    'Y73 the row of the session without an attempt stays pending';
  ASSERT (SELECT state FROM public.youtube_upload_sessions WHERE post_id = v_post_a) = 'open',
    'Y73 the session without an attempt is left alone';

  RAISE NOTICE 'PASS Y73: the cancellation scan leaves out the sessions without an attempt';
END
$y73_cancel_scan$;

-- ---------------------------------------------------------------------------
-- Y74: THE FANOUT SCAN LEAVES OUT A CANDIDATE IT CAN ONLY REFUSE.
--
-- A candidate whose scope holds a malformed element is refused, and a refusal
-- changes nothing: with it in the scan, its slot is spent on the same refusal
-- on every pass, and the fanout behind it is never reached. The scan leaves
-- the unusable candidate out.
--
-- The whole suite is ONE transaction, so every scenario that quieted its
-- attempt shares the same processing_started_at and the scan order falls to
-- random session ids. The order is pinned here: the poisoned fanout is the
-- EARLIEST attempt, so a scan that did not leave it out would spend its one
-- slot on it. A valid fanout sits right behind it, and a third session
-- absorbs the terminal scan, so the fanout scan's one slot is the only work
-- left on the pass.
-- ---------------------------------------------------------------------------
DO $y74_fanout_scan$
DECLARE
  v_acct_p uuid;
  v_post_p uuid;
  v_media_p uuid;
  v_acct_w uuid;
  v_post_w uuid;
  v_media_w uuid;
  v_acct_v uuid;
  v_post_v uuid;
  v_media_v uuid;
  v_u_a      uuid := 'b1000000-0000-4000-8000-000000000001';
  v_lease    uuid := 'e4000000-0000-4000-8000-000000000001';
  v_content  jsonb;
  v_session_p uuid;
  v_session_w uuid;
  v_session_v uuid;
  v_row_w    uuid;
  v_result   jsonb;
BEGIN
  -- The poisoned fanout: the EARLIEST attempt. Its scope names an account
  -- that is not one, so the recovery can only refuse it.
  SELECT f.account_id, f.post_id, f.media_id
    INTO v_acct_p, v_post_p, v_media_p
    FROM pg_temp.new_youtube_fixture('y74p') f;

  UPDATE public.posts
     SET processing_started_at = '2000-01-01T00:00:00Z'
   WHERE id = v_post_p;

  SELECT jsonb_build_object(
           'user_id', x.user_id, 'caption', x.caption, 'media_file_ids', x.media_file_ids,
           'metadata', public.normalize_threads_internal_metadata(x.metadata), 'platforms', x.platforms,
           'scheduled_at', x.scheduled_at, 'publish_requested_at', x.publish_requested_at, 'source', x.source)
    INTO v_content FROM public.posts x WHERE x.id = v_post_p;

  PERFORM public.enroll_post_notification_recovery(v_post_p,
    (SELECT processing_started_at FROM public.posts WHERE id = v_post_p),
    v_content, ARRAY[v_acct_p], ARRAY[]::uuid[]);

  v_session_p := (public.admit_youtube_upload(
      v_post_p, v_acct_p, v_u_a, v_media_p, 4096, 4096, '{}'::jsonb)
    -> 'session' ->> 'id')::uuid;

  PERFORM public.claim_youtube_upload_session(v_session_p, v_lease, 180000);
  PERFORM public.release_youtube_upload_session(v_session_p, v_lease, 'reconcile',
    'the provider may already hold a video');

  -- The owner poisons the scope of the earliest fanout with an element that
  -- is not an account.
  UPDATE public.posts
     SET metadata = jsonb_set(metadata, '{legacy_notification_candidate,target_account_ids}',
           jsonb_build_array(v_acct_p::text, 'not-an-account'))
   WHERE id = v_post_p;

  -- The valid fanout: the SECOND attempt, right behind the poisoned one. Its
  -- row is settled here, the way the settlement of its own attempt would have
  -- settled it, so the terminal scan cannot spend its slot on this session:
  -- the fanout scan is the only scan that can reach this candidate.
  SELECT f.account_id, f.post_id, f.media_id
    INTO v_acct_w, v_post_w, v_media_w
    FROM pg_temp.new_youtube_fixture('y74w') f;

  UPDATE public.posts
     SET processing_started_at = '2000-01-02T00:00:00Z'
   WHERE id = v_post_w;

  SELECT jsonb_build_object(
           'user_id', x.user_id, 'caption', x.caption, 'media_file_ids', x.media_file_ids,
           'metadata', public.normalize_threads_internal_metadata(x.metadata), 'platforms', x.platforms,
           'scheduled_at', x.scheduled_at, 'publish_requested_at', x.publish_requested_at, 'source', x.source)
    INTO v_content FROM public.posts x WHERE x.id = v_post_w;

  PERFORM public.enroll_post_notification_recovery(v_post_w,
    (SELECT processing_started_at FROM public.posts WHERE id = v_post_w),
    v_content, ARRAY[v_acct_w], ARRAY[]::uuid[]);

  v_session_w := (public.admit_youtube_upload(
      v_post_w, v_acct_w, v_u_a, v_media_w, 4096, 4096, '{}'::jsonb)
    -> 'session' ->> 'id')::uuid;
  v_row_w := (SELECT platform_post_id FROM public.youtube_upload_sessions WHERE id = v_session_w);

  PERFORM public.claim_youtube_upload_session(v_session_w, v_lease, 180000);
  PERFORM public.release_youtube_upload_session(v_session_w, v_lease, 'reconcile',
    'the provider may already hold a video');

  -- The row of the valid fanout is settled. The post stays processing, so
  -- the fanout scan still owes this candidate its closure.
  UPDATE public.platform_posts
     SET status = 'failed', error_message = 'y74 the worker of this attempt is gone'
   WHERE id = v_row_w;

  -- The third session: the oldest one the terminal scan can see. The
  -- terminal scan settles its row and rolls its post up, so the pass is left
  -- with exactly one piece of work: the fanout behind the poisoned candidate.
  SELECT f.account_id, f.post_id, f.media_id
    INTO v_acct_v, v_post_v, v_media_v
    FROM pg_temp.new_youtube_fixture('y74v') f;

  UPDATE public.posts
     SET processing_started_at = '2000-01-03T00:00:00Z'
   WHERE id = v_post_v;

  SELECT jsonb_build_object(
           'user_id', x.user_id, 'caption', x.caption, 'media_file_ids', x.media_file_ids,
           'metadata', public.normalize_threads_internal_metadata(x.metadata), 'platforms', x.platforms,
           'scheduled_at', x.scheduled_at, 'publish_requested_at', x.publish_requested_at, 'source', x.source)
    INTO v_content FROM public.posts x WHERE x.id = v_post_v;

  PERFORM public.enroll_post_notification_recovery(v_post_v,
    (SELECT processing_started_at FROM public.posts WHERE id = v_post_v),
    v_content, ARRAY[v_acct_v], ARRAY[]::uuid[]);

  v_session_v := (public.admit_youtube_upload(
      v_post_v, v_acct_v, v_u_a, v_media_v, 4096, 4096, '{}'::jsonb)
    -> 'session' ->> 'id')::uuid;

  PERFORM public.claim_youtube_upload_session(v_session_v, v_lease, 180000);
  PERFORM public.release_youtube_upload_session(v_session_v, v_lease, 'reconcile',
    'the provider may already hold a video');

  UPDATE public.youtube_upload_sessions
     SET updated_at = '1999-01-01T00:00:00Z',
         -- The lease the claim granted outlives the release, and the terminal
         -- scan respects a live one: it is expired here, the way the death of
         -- the worker would have expired it.
         lease_expires_at = now() - interval '1 minute'
   WHERE id = v_session_v;

  -- ONE slot per scan. The terminal scan takes the third session. The
  -- fanout scan has to leave the poisoned candidate out and spend its slot
  -- on the valid fanout behind it. Without the exclusion, the fanout scan
  -- would pick the poisoned candidate, the recovery would refuse it, and the
  -- valid fanout behind it would stay open.
  v_result := public.reconcile_youtube_upload_fanouts(1);

  ASSERT (v_result -> 'terminal_rows' ->> 'examined')::integer = 1,
    'Y74 the pass settled the row the terminal scan owns';
  ASSERT (SELECT status FROM public.platform_posts WHERE id = v_row_w) = 'failed',
    'Y74 the row of the valid fanout is the one its own attempt settled';
  ASSERT (v_result ->> 'fanouts_recovered')::integer = 1,
    'Y74 the slot of the fanout scan reaches the work behind the poisoned candidate';
  ASSERT (SELECT metadata #>> '{legacy_notification_candidate,fanout_closed}'
            FROM public.posts WHERE id = v_post_w) = 'true',
    'Y74 the valid fanout behind the poisoned candidate is closed';
  ASSERT (SELECT metadata #>> '{legacy_notification_candidate,fanout_closed}'
            FROM public.posts WHERE id = v_post_p) IS DISTINCT FROM 'true',
    'Y74 the poisoned fanout is not closed';

  RAISE NOTICE 'PASS Y74: the fanout scan leaves out a candidate it can only refuse';
END
$y74_fanout_scan$;


-- ---------------------------------------------------------------------------
-- Y75: THE DISCONNECT SCAN TAKES THE PARENTS IN ONE SHARED ORDER.
--
-- Two disconnects whose sessions share two posts can otherwise scan them in
-- opposite orders: each transaction holds the first parent lock and waits
-- for the parent the other holds, and PostgreSQL aborts one of them. The
-- scan is ordered by parent, then session.
--
-- The order is a property of the code, so it is proved on the code.
-- ---------------------------------------------------------------------------
DO $y75_disconnect_order$
DECLARE
  v_def  text;
  v_lock integer;
  v_order integer;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'terminalize_youtube_upload_sessions_of_account';
  ASSERT v_def IS NOT NULL,
    'Y75 the disconnect writer exists';

  v_lock := position('youtube_upload_lock_scope' IN v_def);
  ASSERT v_lock > 0,
    'Y75 the disconnect writer takes its scope through the shared helper';

  -- The scan orders by parent before any lock is taken: the order is the one
  -- every writer across parents shares.
  v_order := position('ORDER BY s.post_id, s.id' IN v_def);
  ASSERT v_order > 0 AND v_order < v_lock,
    'Y75 the scan takes the parents in the shared order, before any of them is locked';

  RAISE NOTICE 'PASS Y75: the disconnect scan takes the parents in one shared order';
END
$y75_disconnect_order$;

-- ---------------------------------------------------------------------------
-- Y76: THE RECOVERY READS ITS SESSION UNDER THE SHARED LOCK.
--
-- The authority gate and the closure read the session row. A read that stayed
-- outside the lock could use a snapshot another writer changed in between,
-- so the scope is taken through the shared lock helper and the row is read
-- again under it, before the gate and the closure.
--
-- The order is a property of the code, so it is proved on the code.
-- ---------------------------------------------------------------------------
DO $y76_recovery_lock$
DECLARE
  v_def         text;
  v_stmt        text;
  v_seen_lock   boolean := false;
  v_seen_reread boolean := false;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'recover_youtube_upload_fanout';
  ASSERT v_def IS NOT NULL,
    'Y76 the recovery writer exists';

  -- Statement by statement: the lock helper comes first, and the session row
  -- is read again AFTER it. The read before the lock is the existence probe;
  -- the read that matters is the one under the lock.
  FOR v_stmt IN SELECT unnest(string_to_array(v_def, ';')) LOOP
    IF NOT v_seen_lock AND position('youtube_upload_lock_scope' IN v_stmt) > 0 THEN
      v_seen_lock := true;
    END IF;
    IF v_seen_lock AND position('SELECT * INTO v_session' IN v_stmt) > 0 THEN
      v_seen_reread := true;
      EXIT;
    END IF;
  END LOOP;

  ASSERT v_seen_lock,
    'Y76 the recovery takes its scope through the shared helper';
  ASSERT v_seen_reread,
    'Y76 the session row is read again under the lock';

  RAISE NOTICE 'PASS Y76: the recovery reads its session under the shared lock';
END
$y76_recovery_lock$;

-- ---------------------------------------------------------------------------
-- Y77: THE IDENTITY OF AN ADMITTED MEDIA ROW IS FENCED IN THE DATABASE.
--
-- The owner may rewrite a media row's storage_bucket, file_path and
-- workspace_id at any time, and a direct row update does not pass through
-- the worker. On a row an OPEN upload session reads, the change bumps the
-- content version: the session pinned the version it was admitted with, and
-- the version fence refuses the upload instead of reading the object the row
-- now names. A row no session reads keeps its old behaviour.
-- ---------------------------------------------------------------------------
DO $y77_media_identity_guard$
DECLARE
  v_acct_a uuid;
  v_post_a uuid;
  v_media_a uuid;
  v_acct_b uuid;
  v_post_b uuid;
  v_media_b uuid;
  v_u_a     uuid := 'b1000000-0000-4000-8000-000000000001';
  v_lease   uuid := 'e4000000-0000-4000-8000-000000000001';
  v_session_a uuid;
BEGIN
  -- A row an open session reads: an identity change is a replacement, and
  -- the version the session pinned no longer names the object.
  SELECT f.account_id, f.post_id, f.media_id
    INTO v_acct_a, v_post_a, v_media_a
    FROM pg_temp.new_youtube_fixture('y77a') f;
  v_session_a := (public.admit_youtube_upload(
      v_post_a, v_acct_a, v_u_a, v_media_a, 4096, 4096, '{}'::jsonb)
    -> 'session' ->> 'id')::uuid;

  UPDATE public.media_files
     SET file_path = 'uploads/y77a-renamed.mp4'
   WHERE id = v_media_a;

  ASSERT (SELECT current_object_version FROM public.media_files WHERE id = v_media_a) = 2,
    'Y77 the identity change bumped the content version the session pinned';

  BEGIN
    PERFORM public.claim_youtube_upload_session(v_session_a, v_lease, 180000);
    RAISE EXCEPTION 'Y77 the upload was not refused after its media changed identity';
  EXCEPTION
    WHEN SQLSTATE 'YUS03' OR SQLSTATE 'YUS04' THEN
      RAISE NOTICE 'PASS Y77: the identity change refuses the upload';
  END;

  -- The same change on a row no open session reads moves nothing.
  SELECT f.account_id, f.post_id, f.media_id
    INTO v_acct_b, v_post_b, v_media_b
    FROM pg_temp.new_youtube_fixture('y77b') f;

  UPDATE public.media_files
     SET file_path = 'uploads/y77b-renamed.mp4'
   WHERE id = v_media_b;

  ASSERT (SELECT current_object_version FROM public.media_files WHERE id = v_media_b) = 1,
    'Y77 a row no open session reads keeps its version';

  RAISE NOTICE 'PASS Y77: the identity of an admitted media row is fenced in the database';
END
$y77_media_identity_guard$;

-- ---------------------------------------------------------------------------
-- Y78: THE GUARD WORKS FOR THE OWNER, AND THE VERSION ONLY MOVES FORWARD.
--
-- The owner is the `authenticated` role, which cannot read the session table.
-- The guard looks that table up, so it runs as its owner: the owner's own
-- update neither fails nor depends on a session. While a session is open the
-- owner may write current_object_version, and writing the pinned value back
-- must not make the fence match again.
-- ---------------------------------------------------------------------------
DO $y78_media_guard_as_owner$
DECLARE
  v_acct_c uuid;
  v_post_c uuid;
  v_media_c uuid;
  v_acct_d uuid;
  v_post_d uuid;
  v_media_d uuid;
  v_u_a uuid := 'b1000000-0000-4000-8000-000000000001';
BEGIN
  SELECT f.account_id, f.post_id, f.media_id INTO v_acct_c, v_post_c, v_media_c
    FROM pg_temp.new_youtube_fixture('y78c') f;
  SELECT f.account_id, f.post_id, f.media_id INTO v_acct_d, v_post_d, v_media_d
    FROM pg_temp.new_youtube_fixture('y78d') f;
  PERFORM public.admit_youtube_upload(v_post_d, v_acct_d, v_u_a, v_media_d, 4096, 4096, '{}'::jsonb);

  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_u_a, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_u_a::text, true);
  SET LOCAL ROLE authenticated;

  -- No session reads this row: the owner's rename goes through untouched.
  UPDATE public.media_files SET file_path = 'uploads/y78c-renamed.mp4' WHERE id = v_media_c;
  ASSERT (SELECT current_object_version FROM public.media_files WHERE id = v_media_c) = 1,
    'Y78 the owner update of a row no session reads keeps its version';

  -- An open session reads this row: the rename bumps, and writing the pinned
  -- version back keeps the bumped one.
  UPDATE public.media_files SET file_path = 'uploads/y78d-renamed.mp4' WHERE id = v_media_d;
  ASSERT (SELECT current_object_version FROM public.media_files WHERE id = v_media_d) = 2,
    'Y78 the owner rename bumped the version of the row an open session reads';
  UPDATE public.media_files SET current_object_version = 1 WHERE id = v_media_d;
  ASSERT (SELECT current_object_version FROM public.media_files WHERE id = v_media_d) = 2,
    'Y78 the pinned version written back does not make the fence match again';

  RESET ROLE;
  RAISE NOTICE 'PASS Y78: the guard works for the owner and the version only moves forward';
END
$y78_media_guard_as_owner$;

ROLLBACK;

\echo '=== youtube_upload_sessions: ALL CHECKS PASSED ==='
