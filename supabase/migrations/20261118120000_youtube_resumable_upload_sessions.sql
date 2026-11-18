-- 20261118120000_youtube_resumable_upload_sessions.sql
--
-- The durable state of a native YouTube resumable upload.
--
-- WHY THIS EXISTS
-- ---------------
-- A YouTube upload is a long write to a provider that creates the video when
-- the LAST byte lands. Until the provider answers with the video id, nobody
-- knows whether the video exists. The old path sent the whole file in one
-- request, so a lost answer lost everything, and the next attempt created a
-- SECOND video on the customer's channel.
--
-- This table is what makes the difference. It holds:
--
--   * the resumable session URI, which is a CREDENTIAL: it authorises writes
--     to the upload. It is the reason this table exists and the reason the
--     browser roles hold no grant on it.
--   * how many bytes the provider has CONFIRMED, and the highest byte that
--     was ever written. The first is what a resume starts from; the second
--     tells a later worker that bytes reached the provider at all.
--   * the video id, which is the RECEIPT. It is kept once the provider
--     accepts the video, and it is what stops a second video.
--   * the RESOLVED TARGETS of the attempt, so a later worker knows which
--     accounts the run was allowed to publish to.
--
-- WHAT THE TABLE IS NOT
-- ---------------------
-- It is not a queue and it is not a status model. It is the private half of
-- one upload's state. The user-visible half stays where it always was, in
-- the platform_posts row and the post's own status.
--
-- THE CONTRACT
-- ------------
--   admit_youtube_upload(...)             open the session AND the public row,
--                                         atomically, before any provider work
--   claim_youtube_upload_session(...)     take the session for one worker
--   checkpoint_youtube_upload_session()   record the confirmed progress
--   complete_youtube_upload_session()     record the receipt
--   settle_youtube_upload_session()       record the terminal public outcome
--   project_youtube_upload_receipt()      project a stored receipt onto the
--                                         public row, without any provider work
--   release_youtube_upload_session()      record a terminal non-receipt state
--   claim_youtube_upload_sessions(...)    take the sessions a later worker may
--                                         continue
--
-- THE ADMISSION IS ATOMIC
-- -----------------------
-- The session and the public pending platform_posts row are created in ONE
-- transaction, before the provider is contacted at all.
--
-- The window this closes: a worker that wrote the public row and died before
-- the session existed left a post that the sweeper skips (a pending row
-- exists) and that no continuation can claim (no session exists). That post
-- was stuck for ever, and nothing had reached the provider, so a retry would
-- have been safe. Now the two rows are one fact: either both are there or
-- neither is.
--
-- The crash windows around the admission:
--
--   BEFORE the admission   Nothing durable exists. No byte reached the
--                           provider, so no video can exist. The sweeper's
--                           "safe to retry" is correct and the retry is safe.
--   AFTER the admission    The session and the pending public row exist. The
--                           sweeper leaves the post alone (a pending row
--                           exists) and the continuation claims the session.
--                           The session has no provider session URI yet, and
--                           that is a claimable state: no byte was written, so
--                           the worker opens a provider session and starts.
--
-- THE LEASE IS A NUMBER OF MILLISECONDS
-- -------------------------------------
-- The functions that take a lease take `p_lease_ms`, not an interval.
-- PostgREST sends named arguments as JSON, and a JSON interval has no agreed
-- shape, so a caller that sent an interval string would depend on how the
-- server parses it. A number of milliseconds is the same on both sides, and
-- the functions turn it into an interval themselves. The conversion lives in
-- the functions, and the test suite proves it.
--
-- THE CONTENT FENCE IS THE LIVE POST
-- ----------------------------------
-- The fence is computed from the LIVE post row, not from a copy the session
-- kept. It holds the caption, the platforms, the media file ids, the
-- scheduled and requested timestamps, the source and the post metadata, and
-- the media file's live content version.
--
-- The metadata is normalised first, which removes exactly the keys that are
-- runtime bookkeeping for an attempt (the attempt markers, the settlement
-- rollup markers, the notification candidate) and keeps everything that is
-- the customer's content. So an attempt marker written by a sibling publisher
-- does not refuse the upload, while a changed title, a changed visibility, a
-- changed description, a changed tag or a changed caption does.
--
-- The fence also holds the ACCOUNT, so an upload cannot be carried onto an
-- account the post no longer selects.
--
-- THE REFUSALS
-- ------------
-- Every refusal is a reason code, never a sentence a caller has to parse.
-- The caller maps the code; the message is for the log.
--
--     YUS01  the post is not the caller's, or is not there
--     YUS02  the account is not the caller's, or is not usable
--     YUS03  the media file is not the caller's
--     YUS04  the post was edited while the upload was in flight
--     YUS05  the provider session is gone and bytes had been written
--     YUS06  the provider session is gone and nothing had been written
--     YUS07  another worker owns the session
--     YUS08  the session is not there
--     YUS09  the lease is stale, so this worker does not own the session
--     YUS10  a byte count does not fit the video
--     YUS11  the upload belongs to an older attempt of the post
--     YUS12  the post is no longer being processed
--     YUS13  the upload has been continued too many times
--     YUS14  the session has no public row to settle
--     YUS15  the account is not a target of this post
--
-- The house convention: RLS is on and the browser roles hold no grant, the
-- search path is pinned, the browser roles are revoked explicitly, and the
-- service role is the only role that may execute these functions.
--
-- THE ORDER
-- --------
-- The schema comes BEFORE the code. The edge function that uploads a video
-- calls these functions by name, and a missing function is an error at the
-- first upload, not a fallback. So the migration is applied and the
-- functions exist before the process-post build that calls them is deployed.
--
-- Additive and idempotent. No BEGIN/COMMIT of its own: the disposable
-- harness applies migrations inside its transaction.

-- ---------------------------------------------------------------------------
-- The table.
-- ---------------------------------------------------------------------------
CREATE TABLE public.youtube_upload_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  post_id uuid NOT NULL REFERENCES public.posts(id) ON DELETE CASCADE,
  social_account_id uuid NOT NULL REFERENCES public.social_accounts(id) ON DELETE CASCADE,
  platform_post_id uuid REFERENCES public.platform_posts(id) ON DELETE SET NULL,
  media_file_id uuid REFERENCES public.media_files(id) ON DELETE SET NULL,
  -- The media's content version, so a replaced file cannot be uploaded as
  -- the old one.
  media_object_version integer,
  media_size bigint NOT NULL CHECK (media_size > 0),
  total_bytes bigint NOT NULL CHECK (total_bytes > 0),
  -- The video resource that was sent to the provider. It is kept for the
  -- record, but it is NOT the content fence: the fence is the live post.
  upload_body jsonb NOT NULL,
  -- The query settings of the provider request: the parts it writes and
  -- whether the channel's subscribers are told about the video.
  --
  -- They are not part of the body, and they decide what the request DOES: a
  -- worker that has to open the provider session later has to make the SAME
  -- request, with the same parts and the same subscriber notification. A
  -- session that is opened without them would write a different video, or
  -- notify subscribers the customer had turned off.
  upload_settings jsonb NOT NULL,
  -- What the content was when the session was opened.
  content_fence jsonb NOT NULL,
  -- The platforms and the accounts the run was allowed to publish to.
  --
  -- The resolved targets are kept because the account the upload writes to is
  -- one of them, and a later worker has to know that the account was really
  -- targeted and not merely owned by the customer.
  resolved_platform text,
  target_account_ids uuid[],
  -- How many bytes the provider has CONFIRMED. A resume starts here.
  confirmed_bytes bigint NOT NULL DEFAULT 0 CHECK (confirmed_bytes >= 0 AND confirmed_bytes <= total_bytes),
  -- The highest byte offset that was ever written. Zero means the provider
  -- never saw a byte, so no video can exist.
  bytes_sent bigint NOT NULL DEFAULT 0 CHECK (bytes_sent >= 0 AND bytes_sent <= total_bytes),
  -- Whether the provider may ALREADY have turned this upload into a video.
  --
  -- It becomes true the moment the last chunk is written, because that is
  -- the write that creates the video, and it is never cleared by a
  -- checkpoint: only the provider saying the upload is still incomplete may
  -- clear it. While it is true nothing is written again: a second video on
  -- the customer's channel is worse than a post that needs a human.
  video_may_exist boolean NOT NULL DEFAULT false,
  -- The provider session URI. A CREDENTIAL. Never returned to a browser role.
  session_uri text,
  session_expires_at timestamptz,
  -- The receipt. Present once the provider accepted the video.
  video_id text,
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open','uploaded','expired','reconcile','failed')),
  error text,
  lease_token uuid,
  lease_expires_at timestamptz,
  -- The post attempt this upload belongs to.
  --
  -- A post that is edited or retried is published again, and that is a new
  -- attempt with a new processing_started_at. A continuation may only run
  -- while the post is still on the attempt this session was opened for.
  attempt_started_at timestamptz,
  -- When the continuation may look at this session again.
  --
  -- NULL means "now". A value in the future means the session is not due yet.
  next_check_at timestamptz,
  -- The stable reason code of the last attempt.
  last_outcome text,
  -- How many continuations this session has had.
  --
  -- It bounds the work: a session that keeps failing is not asked for ever.
  continuation_count integer NOT NULL DEFAULT 0 CHECK (continuation_count >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  -- One upload per post and account. A second attempt continues the first.
  UNIQUE (post_id, social_account_id)
);

COMMENT ON TABLE public.youtube_upload_sessions IS
  'The private, attempt-fenced state of one native YouTube resumable upload. '
  'Holds the provider session URI (a credential), the confirmed byte offset '
  'and the video id receipt. The browser roles hold no grant on it.';

COMMENT ON COLUMN public.youtube_upload_sessions.session_uri IS
  'The provider resumable session URI. It authorises writes to the upload, '
  'so it never leaves this table through a browser role, a log line, a '
  'telemetry event or a client response.';

COMMENT ON COLUMN public.youtube_upload_sessions.bytes_sent IS
  'The highest byte offset that was ever written to the provider. Zero means '
  'no byte ever reached the provider, so no video can exist and a fresh '
  'session is safe.';

COMMENT ON COLUMN public.youtube_upload_sessions.video_may_exist IS
  'Whether the provider may already have turned this upload into a video. It '
  'is set before the last chunk is written and is NEVER cleared by a '
  'checkpoint: only the provider saying the upload is still incomplete may '
  'clear it. While it is true no session is reopened, because a second video '
  'on the customer''s channel is worse than a post that needs a human.';

COMMENT ON COLUMN public.youtube_upload_sessions.content_fence IS
  'The LIVE content of the upload: the post as it is now, with the '
  'attempt-only runtime metadata removed, plus the media file''s live '
  'content version and the account. Recomputed on every claim, so an edited '
  'post refuses the resume.';

COMMENT ON COLUMN public.youtube_upload_sessions.target_account_ids IS
  'The accounts the run was allowed to publish to, resolved under the post '
  'claim. The upload may only be carried on to one of them.';

CREATE INDEX youtube_upload_sessions_open_idx
  ON public.youtube_upload_sessions (updated_at)
  WHERE state = 'open';
CREATE INDEX youtube_upload_sessions_account_idx
  ON public.youtube_upload_sessions (social_account_id);
CREATE INDEX youtube_upload_sessions_user_idx
  ON public.youtube_upload_sessions (user_id);

ALTER TABLE public.youtube_upload_sessions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.youtube_upload_sessions FROM anon, authenticated;

-- ---------------------------------------------------------------------------
-- The content fence.
--
-- It is computed from the LIVE post. The metadata is normalised first, which
-- removes the keys that are runtime bookkeeping for an attempt and keeps the
-- keys that are the customer's content.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.youtube_upload_live_fence(
  p_post_id uuid,
  p_media_file_id uuid,
  p_total_bytes bigint,
  p_social_account_id uuid
)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT jsonb_build_object(
    'post', jsonb_build_object(
      'caption', p.caption,
      'platforms', p.platforms,
      'media_file_ids', p.media_file_ids,
      'metadata', public.normalize_threads_internal_metadata(p.metadata),
      'scheduled_at', p.scheduled_at,
      'publish_requested_at', p.publish_requested_at,
      'source', p.source
    ),
    'media_file_id', p_media_file_id,
    'media_object_version',
      (SELECT m.current_object_version FROM public.media_files m WHERE m.id = p_media_file_id),
    'total_bytes', p_total_bytes,
    'social_account_id', p_social_account_id
  )
  FROM public.posts p
  WHERE p.id = p_post_id
$$;

COMMENT ON FUNCTION public.youtube_upload_live_fence(uuid, uuid, bigint, uuid) IS
  'The content fence of one YouTube upload, computed from the LIVE post: the '
  'caption, the platforms, the media file ids, the post metadata with the '
  'attempt-only runtime keys removed, the media file''s live content version, '
  'the number of bytes read from it and the account it is written to.';

-- ---------------------------------------------------------------------------
-- The target authorization.
--
-- The account an upload is carried on to must still be a YouTube target of
-- the post. The post's own selection is the authority: the platform list, and
-- the selected accounts when the customer chose some.
--
-- The retry request is NOT the authority here. A retry narrows what a RUN
-- publishes, and the retry deliberately leaves an account that still has an
-- open upload out of its own target list. Reading the retry list here would
-- strand that upload, because the retry list does not name it.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.youtube_upload_target_authorized(
  p_post_id uuid,
  p_social_account_id uuid,
  p_target_account_ids uuid[] DEFAULT NULL
)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.posts p
      JOIN public.social_accounts sa
        ON sa.id = p_social_account_id
       AND sa.user_id = p.user_id
       AND sa.platform = 'youtube'
       AND sa.is_active
     WHERE p.id = p_post_id
       AND 'youtube' = ANY(p.platforms)
       AND (
         -- The run resolved this account as one of its targets, so the upload
         -- may be carried on to it even when the post's stored selection does
         -- not name it. That is the case of a run that was given an explicit
         -- account.
         p_social_account_id = ANY (coalesce(p_target_account_ids, ARRAY[]::uuid[]))
         OR jsonb_typeof(p.metadata -> 'selected_account_ids') IS DISTINCT FROM 'array'
         OR jsonb_array_length(p.metadata -> 'selected_account_ids') = 0
         OR p_social_account_id::text IN (
              SELECT jsonb_array_elements_text(p.metadata -> 'selected_account_ids')
            )
       )
  )
$$;

COMMENT ON FUNCTION public.youtube_upload_target_authorized(uuid, uuid, uuid[]) IS
  'Whether the account is still a YouTube target of the post: an active '
  'YouTube account of the post owner, on a post that still publishes to '
  'YouTube, and either selected by the post or resolved as a target of the '
  'run that opened the upload.';

-- ---------------------------------------------------------------------------
-- youtube_upload_attempt_quiet_after
--
-- How long the worker that owns a post attempt may still write.
--
-- THE DERIVATION
-- --------------
-- The publishing worker is an edge function with a hard lifetime. It is killed
-- WORKER_LIFETIME_MS after the worker process started, and the last thing it
-- may do is record the outcome of a publish, which the record reserve keeps
-- five seconds before the end. So the last result row the worker of an attempt
-- can write happens no later than
--
--   worker_started_at + WORKER_LIFETIME_MS - RECORD_RESERVE_MS
--
-- and the worker that claims the attempt starts BEFORE the claim, because the
-- claim happens inside the worker's request:
--
--   worker_started_at <= posts.processing_started_at
--
-- Which makes `posts.processing_started_at + 150 seconds` a bound after which
-- no worker of that attempt can write another result row. 150 seconds is
-- WORKER_LIFETIME_MS in supabase/functions/process-post/deferredPublish.ts, and
-- the two have to move together.
--
-- It is a bound, not a guess: the recovery uses it to decide whether the
-- worker that owns the attempt may still be publishing, and it waits for the
-- bound rather than closing a fanout that a live worker is about to extend.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.youtube_upload_attempt_quiet_after()
RETURNS interval
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT interval '150 seconds';
$$;

COMMENT ON FUNCTION public.youtube_upload_attempt_quiet_after() IS
  'How long after a post attempt started its own worker may still write a '
  'result row. Mirrors WORKER_LIFETIME_MS in the process-post edge function.';

REVOKE ALL ON FUNCTION public.youtube_upload_attempt_quiet_after() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.youtube_upload_attempt_quiet_after() TO service_role;

-- ---------------------------------------------------------------------------
-- partner_close_ambiguous_destination
--
-- Closes a destination whose outcome is not a proven failure.
--
-- WHY IT EXISTS
-- -------------
-- A destination of a post that has a YouTube upload may have been published
-- even though its result row is missing: the platforms that are not YouTube
-- write their row AFTER the provider call, so a missing receipt says nothing
-- about whether the publication happened.
--
-- Such a destination is closed with a stable, non-retryable reason, so it is
-- never published twice and a human can check it. The recovery and the
-- sweeper both need that rule and they must not drift apart, so it lives here
-- once.
--
-- The row is created through the settlement every other result row goes
-- through, so the tenant check and the webhook are the ones the platform
-- already uses. The parent is not rolled up here: a post that has a YouTube
-- upload carries an open notification candidate, and the closure is the
-- authority on that post.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.partner_close_ambiguous_destination(
  p_post_id uuid,
  p_social_account_id uuid,
  p_platform text
)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_owner uuid;
  v_settled jsonb;
BEGIN
  IF p_post_id IS NULL OR p_social_account_id IS NULL OR p_platform IS NULL THEN
    RETURN NULL;
  END IF;

  -- The account has to belong to the owner of the post. A destination that
  -- belongs to somebody else is not this post's business.
  SELECT p.user_id INTO v_owner FROM public.posts p WHERE p.id = p_post_id;
  IF v_owner IS NULL THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.social_accounts sa
     WHERE sa.id = p_social_account_id AND sa.user_id = v_owner
  ) THEN
    RETURN NULL;
  END IF;

  v_settled := public.partner_settle_platform_post(
    NULL,
    p_post_id,
    p_social_account_id,
    p_platform,
    'failed',
    NULL,
    NULL,
    'partner_publish_reconcile_required',
    jsonb_build_object(
      'publish_outcome', 'uncertain',
      'publish_outcome_reason', 'this destination may already have been published, so it has to be checked by hand before it is retried',
      'partner_publish_ambiguous', true
    )
  );

  RETURN (v_settled ->> 'platform_post_id')::uuid;
END;
$$;

COMMENT ON FUNCTION public.partner_close_ambiguous_destination(uuid, uuid, text) IS
  'Closes a destination whose outcome is not a proven failure, with a stable '
  'non-retryable reason, so it is never published twice. It returns the id of '
  'the result row it created.';

REVOKE ALL ON FUNCTION public.partner_close_ambiguous_destination(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.partner_close_ambiguous_destination(uuid, uuid, text) TO service_role;

-- ---------------------------------------------------------------------------
-- recover_youtube_upload_fanout
--
-- The fanout closure a worker that died between the admission and the
-- closure leaves open.
--
-- WHY IT EXISTS
-- -------------
-- The admission creates the public pending row. The publishing worker closes
-- the fanout at the END, with the exact list of rows this attempt wrote. A
-- worker that died in between leaves the notification candidate open, and the
-- parent waits for a closure that never comes.
--
-- THE SCOPE IS NOT GUESSED
-- ------------------------
-- The attempt's destinations are persisted by the notification enrolment
-- (`attempt_target_account_ids`, and the candidate's `target_account_ids`).
-- The rows the attempt owns are in the database: they are the rows of this
-- post, for the attempt's accounts, created by this attempt. That is the
-- same authority `close_post_fanout` itself applies to the ids it is given,
-- so the scope handed to it is the scope it would have derived.
--
-- A MISSING ROW IS AMBIGUOUS, NOT 'NEVER STARTED'
-- ----------------------------------------------
-- Only the native YouTube path writes its result row BEFORE the provider
-- call, so only a missing YouTube row proves that nothing was sent. Every
-- other platform writes its row AFTER the provider call: the worker publishes
-- first and records the outcome afterwards. A missing sibling row therefore
-- does NOT prove that the sibling never started -- the provider call may have
-- succeeded and the receipt may have been lost with the worker.
--
-- So the recovery never claims that a sibling never started, and it never
-- gives a sibling a retryable result. It closes the gap the only honest way:
-- the sibling gets a TERMINAL, non-retryable row with a stable public reason
-- that says the outcome has to be checked by hand. A retry of an unknown
-- destination could publish a second time; a human decides instead.
--
-- THE QUIESCENCE BOUNDARY
-- -----------------------
-- The closure may only be made once the worker that owns the attempt cannot
-- write any more, because a live worker is about to write the very row the
-- scope is missing. So the recovery waits until
-- `posts.processing_started_at + youtube_upload_attempt_quiet_after()` has
-- passed, and until then it says so instead of closing. The reconciler calls
-- it again, so the wait is bounded and the post is never held open for ever.
--
-- TWO OUTCOMES
-- ------------
--   * EVERY destination has a row: the scope is complete, and the fanout is
--     closed with it. A single-destination post closes here -- the row the
--     admission created is the whole scope -- and the notification fires
--     through the real enrolled fanout. A mixed post closes too, with the
--     siblings' rows included, so their successes are preserved and nothing
--     is replayed.
--   * A destination has NO row: the outcome of that destination is unknown.
--     It is terminalised with a non-retryable reason, so the scope becomes
--     complete, the fanout closes, and the parent reaches a finite outcome
--     that says what a human has to do. Nothing is re-run here: the
--     destination is not published again by the recovery.
--
-- A sibling that started and is not finished is not unknown: it has a row, so
-- it is part of the scope, and the closure marks the fanout as not ready
-- until that row settles.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.recover_youtube_upload_fanout(
  p_session_id uuid,
  p_lease_token uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_session public.youtube_upload_sessions%ROWTYPE;
  v_post public.posts%ROWTYPE;
  v_candidate jsonb;
  v_targets uuid[];
  v_retained uuid[];
  v_rows uuid[];
  v_unknown uuid[];
  v_removed uuid[] := ARRAY[]::uuid[];
  v_attempt timestamptz;
  v_closed jsonb;
  v_new_row uuid;
  v_platform text;
  r_target record;
BEGIN
  IF p_session_id IS NULL THEN
    RETURN jsonb_build_object('recovered', false, 'reason', 'invalid_arguments');
  END IF;

  SELECT * INTO v_session FROM public.youtube_upload_sessions WHERE id = p_session_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('recovered', false, 'reason', 'session_not_found');
  END IF;

  -- THE AUTHORITY
  -- -------------
  -- The lease is not the authority here: the SESSION is.
  --
  -- A session that reached a terminal state was settled by the worker that
  -- owned it, and the settlement is what made the public row terminal. The
  -- scope below is read from the database, not from the caller, so a caller
  -- that arrives late, or twice, can only cause the closure that the database
  -- already implies.
  --
  -- A caller that owns a live lease is allowed in as well, so the closure may
  -- run BEFORE the settlement. The continuation does exactly that: the pending
  -- YouTube row is what keeps the generic sweeper from reading the absence of a
  -- sibling row as a proof, so the scope has to be settled while that row is
  -- still pending.
  IF NOT (
    v_session.state IN ('uploaded', 'failed', 'reconcile')
    OR (
      v_session.lease_token IS NOT DISTINCT FROM p_lease_token
      AND v_session.lease_expires_at IS NOT NULL
      AND v_session.lease_expires_at > now()
    )
  ) THEN
    RETURN jsonb_build_object('recovered', false, 'reason', 'lease_stale');
  END IF;

  -- The parent is locked first, and the attempt must still be the running
  -- one. A cancelled or superseded post keeps its own outcome.
  SELECT * INTO v_post FROM public.posts WHERE id = v_session.post_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('recovered', false, 'reason', 'post_not_found');
  END IF;
  v_attempt := v_session.attempt_started_at;
  IF v_attempt IS NOT NULL AND v_post.processing_started_at IS DISTINCT FROM v_attempt THEN
    RETURN jsonb_build_object('recovered', false, 'reason', 'stale_attempt');
  END IF;
  IF v_post.status <> 'processing' THEN
    -- The parent may already have been rolled up by THIS attempt's own
    -- closure. That is the same authority every other settlement path reads,
    -- and it is what makes the closure repeatable: a second call finds the
    -- scope it froze and changes nothing.
    --
    -- A post that was cancelled or superseded does not carry those markers,
    -- so it is still refused.
    IF NOT (
      v_post.status IN ('completed', 'failed')
      AND v_post.metadata ->> 'settlement_rollup_status' = v_post.status
      AND (v_post.metadata ->> 'settlement_rollup_processing_started_at')::timestamptz = v_attempt
    ) THEN
      RETURN jsonb_build_object('recovered', false, 'reason', 'post_not_processing');
    END IF;
  END IF;

  v_candidate := v_post.metadata -> 'legacy_notification_candidate';
  IF v_candidate IS NULL
     OR (v_candidate ->> 'attempt_started_at')::timestamptz IS DISTINCT FROM v_attempt THEN
    RETURN jsonb_build_object('recovered', false, 'reason', 'no_candidate_for_attempt');
  END IF;

  SELECT coalesce(array_agg(x::uuid), ARRAY[]::uuid[]) INTO v_targets
    FROM jsonb_array_elements_text(v_candidate -> 'target_account_ids') x;
  SELECT coalesce(array_agg(x::uuid), ARRAY[]::uuid[]) INTO v_retained
    FROM jsonb_array_elements_text(v_candidate -> 'retained_platform_post_ids') x;
  IF cardinality(v_targets) = 0 THEN
    RETURN jsonb_build_object('recovered', false, 'reason', 'no_target_scope');
  END IF;

  -- THE QUIESCENCE BOUNDARY
  -- -----------------------
  -- The worker that owns this attempt may still be publishing to the
  -- destinations that have no row yet. Closing the fanout now would freeze a
  -- scope that is about to change, so the recovery waits until that worker
  -- cannot write any more. The reconciler calls this again, so the wait is
  -- bounded and the post is not held open for ever.
  IF v_post.processing_started_at IS NOT NULL
     AND now() < v_post.processing_started_at + public.youtube_upload_attempt_quiet_after() THEN
    IF (v_candidate ->> 'fanout_state') IS DISTINCT FROM 'youtube_upload_attempt_running' THEN
      v_candidate := v_candidate || jsonb_build_object(
        'fanout_state', 'youtube_upload_attempt_running',
        'fanout_recovered_at', now(),
        'fanout_recovery_reason', 'the worker of this attempt may still be publishing, so the fanout scope is not closed yet'
      );
      UPDATE public.posts
         SET metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{legacy_notification_candidate}', v_candidate, true)
       WHERE id = v_post.id;
    END IF;
    RETURN jsonb_build_object(
      'recovered', false,
      'reason', 'attempt_may_still_be_running',
      'quiet_after', v_post.processing_started_at + public.youtube_upload_attempt_quiet_after()
    );
  END IF;

  -- The rows this attempt owns, for its own destinations.
  SELECT coalesce(array_agg(pp.id ORDER BY pp.id), ARRAY[]::uuid[]) INTO v_rows
    FROM public.platform_posts pp
   WHERE pp.post_id = v_post.id
     AND pp.social_account_id = ANY(v_targets)
     AND (
       pp.created_at >= v_attempt
       OR (
         (pp.response_data #>> '{deferred,attempt_started_at}') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}[ T]'
         AND (pp.response_data #>> '{deferred,attempt_started_at}')::timestamptz = v_attempt
       )
     );

  -- A destination with no row has an UNKNOWN outcome. It did not necessarily
  -- never start: the other platforms write their row after the provider call,
  -- so the worker may have published and died before it recorded the receipt.
  v_unknown := ARRAY[]::uuid[];
  FOR r_target IN SELECT unnest(v_targets) AS account_id LOOP
    IF NOT EXISTS (
      SELECT 1 FROM public.platform_posts pp
       WHERE pp.id = ANY(v_rows) AND pp.social_account_id = r_target.account_id
    ) THEN
      v_unknown := array_append(v_unknown, r_target.account_id);
    END IF;
  END LOOP;

  IF cardinality(v_unknown) > 0 THEN
    -- Each unknown destination is terminalised with a NON-RETRYABLE reason, so
    -- the scope becomes complete and the fanout can close, and so a retry can
    -- never publish a second time to a destination whose outcome is unknown.
    FOR r_target IN SELECT unnest(v_unknown) AS account_id LOOP
      SELECT sa.platform INTO v_platform
        FROM public.social_accounts sa
       WHERE sa.id = r_target.account_id
         AND sa.user_id = v_post.user_id;

      IF v_platform IS NULL THEN
        -- The account is gone or belongs to somebody else. It cannot be
        -- published to, so there is nothing to close -- but it IS still a
        -- destination of this attempt, and the closure reads the scope it
        -- froze. A scope that names a destination without a result row is
        -- refused, so the account leaves the scope IN THIS TRANSACTION.
        --
        -- The record of the unknown outcome stays: the account may have been
        -- published to before it was disconnected, and that is a possible side
        -- effect nobody may forget.
        v_removed := array_append(v_removed, r_target.account_id);
        CONTINUE;
      END IF;

      v_new_row := public.partner_close_ambiguous_destination(v_post.id, r_target.account_id, v_platform);
      IF v_new_row IS NOT NULL THEN
        v_rows := array_append(v_rows, v_new_row);
      END IF;
    END LOOP;

    -- THE SCOPE AND THE CLOSURE HAVE TO AGREE
    --
    -- The scope is the list of destinations this attempt owns, and the
    -- closure is refused when one of them has no result row. A destination
    -- that cannot be published to any more leaves the scope here, so the
    -- closure can run, and the unknown outcome of that destination stays
    -- recorded in the candidate.
    IF cardinality(v_removed) > 0 THEN
      v_candidate := v_candidate || jsonb_build_object(
        'target_account_ids', (
          SELECT coalesce(jsonb_agg(x), '[]'::jsonb)
            FROM jsonb_array_elements_text(v_candidate -> 'target_account_ids') x
           WHERE NOT (x::uuid = ANY(v_removed))
        )
      );
    END IF;

    v_candidate := v_candidate || jsonb_build_object(
      'fanout_state', 'youtube_upload_unknown_scope',
      'fanout_unknown_account_ids', to_jsonb(v_unknown),
      'fanout_recovered_at', now(),
      'fanout_recovery_reason', 'these destinations have no result row, so their outcome is unknown and they are not retried automatically'
    );
    UPDATE public.posts
       SET metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{legacy_notification_candidate}', v_candidate, true)
     WHERE id = v_post.id;
  END IF;

  v_closed := public.close_post_fanout(
    v_post.id,
    v_attempt,
    v_candidate -> 'content_fence',
    v_rows,
    v_retained
  );

  RETURN jsonb_build_object(
    'recovered', coalesce((v_closed ->> 'closed')::boolean, false),
    'reason', v_closed ->> 'error',
    'closed', v_closed,
    'unknown_account_ids', to_jsonb(v_unknown)
  );
END;
$$;

COMMENT ON FUNCTION public.recover_youtube_upload_fanout(uuid, uuid) IS
  'Closes the post fanout for a YouTube upload whose worker died between the '
  'admission and the closure. A destination without a result row has an '
  'UNKNOWN outcome -- the other platforms record their result after the '
  'provider call -- so it is terminalised with a non-retryable reason that '
  'asks for a manual check, and nothing is replayed. The closure waits until '
  'the worker of the attempt cannot write any more.';

REVOKE ALL ON FUNCTION public.recover_youtube_upload_fanout(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.recover_youtube_upload_fanout(uuid, uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- youtube_upload_terminalize_cancelled
--
-- The pending row of an upload whose post was cancelled.
--
-- WHY IT EXISTS
-- -------------
-- The admission creates the public pending row and the session together. When
-- the post is cancelled the attempt ends, and that row would stay pending for
-- ever: the continuation refuses a post that is no longer being processed
-- (YUS12), and the sweeper leaves a post with a pending row alone. The
-- customer then sees a publication that never finishes.
--
-- A session that is ALREADY terminal is closed here as well. A worker that
-- gives up releases the session into a terminal state and settles the public
-- row in a separate call, so a worker that dies in between leaves a terminal
-- session with a pending row -- and the terminal recovery refuses a post that
-- is no longer being processed, because the cancellation keeps its own
-- outcome.
--
-- WHAT IT DOES, AND ONLY THAT
-- ---------------------------
--   * the row becomes a terminal failure with a stable public reason,
--   * the session becomes terminal and releases its lease,
--   * the parent is NOT rolled up and nothing is published again.
--
-- The parent keeps the outcome the owner gave it. The row is closed under the
-- attempt authority: the session's attempt must still be the post's current
-- one, so an attempt that has been superseded is never disturbed. A later
-- attempt owns the post, and this row is not its business.
--
-- The row is closed directly instead of through the settlement, because the
-- settlement rolls the parent up when the post carries no notification
-- candidate -- and a cancelled post must keep the outcome the owner gave it.
--
-- Neither reason is retryable. A video that may exist has to be checked by
-- hand on the channel; an upload that never reached the provider is simply
-- cancelled, and the owner publishes again if they want to.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.youtube_upload_terminalize_cancelled(p_session_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_session public.youtube_upload_sessions%ROWTYPE;
  v_post public.posts%ROWTYPE;
  v_row public.platform_posts%ROWTYPE;
  v_may_exist boolean;
  v_reason text;
  v_message text;
  v_outcome text;
  v_state text;
  v_workspace uuid;
  v_enqueued integer := 0;
  v_lock jsonb;
BEGIN
  IF p_session_id IS NULL THEN
    RETURN jsonb_build_object('terminalized', false, 'reason', 'invalid_arguments');
  END IF;

  -- THE PARENT IS LOCKED FIRST
  --
  -- The admission takes the parent before the session, and every writer of a
  -- session takes them in that order, so two of them can never hold the lock
  -- the other one needs. The result row is locked after the session, so a
  -- cancellation is either seen or waits.
  v_lock := public.youtube_upload_lock_scope(p_session_id);
  IF NOT (v_lock ->> 'locked')::boolean THEN
    IF v_lock ->> 'reason' = 'post_missing' THEN
      RETURN jsonb_build_object('terminalized', false, 'reason', 'post_missing');
    END IF;
    RETURN jsonb_build_object('terminalized', false, 'reason', 'session_missing');
  END IF;

  -- Both rows are locked already; they are read again under the locks.
  SELECT * INTO v_session FROM public.youtube_upload_sessions WHERE id = p_session_id;
  SELECT * INTO v_post FROM public.posts WHERE id = (v_lock ->> 'post_id')::uuid;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('terminalized', false, 'reason', 'post_missing');
  END IF;

  IF v_session.state NOT IN ('open', 'uploaded', 'failed', 'expired', 'reconcile') THEN
    RETURN jsonb_build_object('terminalized', false, 'reason', 'not_open');
  END IF;

  -- A later attempt owns the post: it has its own fanout and its own rows.
  IF v_session.attempt_started_at IS NOT NULL
     AND v_post.processing_started_at IS DISTINCT FROM v_session.attempt_started_at THEN
    RETURN jsonb_build_object('terminalized', false, 'reason', 'stale_attempt');
  END IF;

  -- The post is cancelled: it is not being processed any more.
  IF v_post.status NOT IN ('pending', 'failed', 'scheduled') THEN
    RETURN jsonb_build_object('terminalized', false, 'reason', 'post_not_cancelled');
  END IF;

  IF v_session.platform_post_id IS NULL THEN
    RETURN jsonb_build_object('terminalized', false, 'reason', 'no_public_row');
  END IF;

  SELECT * INTO v_row FROM public.platform_posts WHERE id = v_session.platform_post_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('terminalized', false, 'reason', 'public_row_missing');
  END IF;
  IF v_row.status <> 'pending' THEN
    RETURN jsonb_build_object('terminalized', false, 'reason', 'row_not_pending');
  END IF;

  -- A video may exist when a byte ever reached the provider, or when the last
  -- write may have landed.
  v_may_exist := v_session.video_may_exist OR v_session.bytes_sent > 0;
  IF v_may_exist THEN
    v_reason := 'youtube_upload_reconcile_required';
    v_message := 'the post was cancelled, and the provider may already hold a video from this upload, so it has to be checked by hand';
    v_outcome := 'uncertain';
    v_state := 'reconcile';
  ELSE
    v_reason := 'youtube_upload_cancelled';
    v_message := 'the post was cancelled before the upload reached the provider';
    v_outcome := 'cancelled';
    v_state := 'failed';
  END IF;

  -- The row is closed here, and the closed row is read back, so the event
  -- below carries the outcome of the cancellation and not the state the row
  -- was in before it.
  UPDATE public.platform_posts
     SET status        = 'failed',
         error_message = v_reason,
         response_data = coalesce(response_data, '{}'::jsonb) || jsonb_build_object(
           'publish_outcome', v_outcome,
           'publish_outcome_reason', v_message,
           'youtube_upload_reason', v_reason,
           'youtube_upload_state', v_state
         )
   WHERE id = v_row.id
  RETURNING * INTO v_row;

  UPDATE public.youtube_upload_sessions
     SET state = v_state,
         error = left(v_message, 300),
         lease_token = NULL,
         lease_expires_at = NULL,
         updated_at = clock_timestamp()
   WHERE id = v_session.id;

  -- The row is terminal, so it reports itself like every other terminal row.
  v_workspace := public.partner_workspace_of_account(v_row.social_account_id);
  IF v_workspace IS NOT NULL THEN
    v_enqueued := public.partner_emit_webhook_event(
      v_workspace,
      'post.failed',
      'post.failed:' || v_row.id::text,
      jsonb_build_object(
        'post_id', v_row.post_id,
        'platform_post_id', v_row.id,
        'platform', v_row.platform,
        'account_id', v_row.social_account_id,
        'status', v_row.status,
        'error_message', v_row.error_message,
        'post_status', v_post.status
      ),
      v_row.platform,
      v_row.social_account_id,
      coalesce(v_row.posted_at, now())
    );
  END IF;

  RETURN jsonb_build_object(
    'terminalized', true,
    'reason', v_reason,
    'outcome', v_outcome,
    'state', v_state,
    'platform_post_id', v_row.id,
    'post_status', v_post.status,
    'enqueued', v_enqueued
  );
END;
$$;

COMMENT ON FUNCTION public.youtube_upload_terminalize_cancelled(uuid) IS
  'Closes the pending row of an upload whose post was cancelled, with a '
  'non-retryable reason. The parent keeps the outcome the owner gave it and '
  'nothing is published again.';

REVOKE ALL ON FUNCTION public.youtube_upload_terminalize_cancelled(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.youtube_upload_terminalize_cancelled(uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- reconcile_youtube_upload_fanouts
--
-- The bounded driver of the two repairs above.
--
-- WHY IT IS A DRIVER AND NOT A WORKER
-- -----------------------------------
-- Neither repair needs a provider and neither needs a worker: the outcome is
-- derived from the database. The reconciler calls this every minute, so a
-- post that is waiting for its attempt to go quiet is picked up as soon as it
-- is quiet, and a pending row of a cancelled post is closed promptly.
--
-- IT IS NOT PART OF THE SHARED CLAIM LIMIT
-- ----------------------------------------
-- The shared limit of `claim_post_completion_work` counts the pieces of work a
-- worker may hold, because each of them costs a worker. This costs database
-- time only, and a post that waits for a free slot would stay 'processing'
-- for ever. It has its own bound instead.
--
-- THE ORDER
-- ---------
-- The cancelled rows come first: a pending row of a cancelled post can never
-- be settled by the continuation, because the continuation refuses a post that
-- is not being processed.
--
-- The terminal sessions come next: their public row is pending although the
-- session is already terminal, which is the window a worker that died
-- between the release and the settlement leaves. A post in that state waits
-- for an outcome that never comes, and the sweeper leaves a post with a
-- pending row alone.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reconcile_youtube_upload_fanouts(p_limit integer DEFAULT 5)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_limit integer;
  v_cancelled integer := 0;
  v_attempted integer := 0;
  v_recovered integer := 0;
  v_result jsonb;
  v_terminal jsonb;
  r_session record;
BEGIN
  v_limit := least(50, greatest(0, coalesce(p_limit, 5)));

  -- The pending rows of cancelled posts.
  --
  -- A session that is already terminal is closed as well: a worker that died
  -- between the release and the settlement leaves a terminal session with a
  -- pending row, and the continuation cannot settle it because it refuses a
  -- post that is no longer being processed.
  FOR r_session IN
    SELECT ys.id
      FROM public.youtube_upload_sessions ys
      JOIN public.posts p ON p.id = ys.post_id
     WHERE ys.state IN ('open', 'uploaded', 'failed', 'expired', 'reconcile')
       AND ys.platform_post_id IS NOT NULL
       AND p.status IN ('pending', 'failed', 'scheduled')
       AND p.processing_started_at IS NOT DISTINCT FROM ys.attempt_started_at
       AND EXISTS (
         SELECT 1 FROM public.platform_posts pp
          WHERE pp.id = ys.platform_post_id
            AND pp.status = 'pending'
       )
     ORDER BY ys.updated_at, ys.id
     LIMIT v_limit
  LOOP
    v_result := public.youtube_upload_terminalize_cancelled(r_session.id);
    IF coalesce((v_result ->> 'terminalized')::boolean, false) THEN
      v_cancelled := v_cancelled + 1;
    END IF;
  END LOOP;

  -- The terminal sessions whose public row is still pending.
  --
  -- This is the window a worker that died between the release and the
  -- settlement leaves: the session is terminal and the row is pending, so the
  -- post waits for an outcome that never comes.
  v_terminal := public.recover_youtube_upload_terminal_results(v_limit);

  -- The fanouts a dead worker left open. The session has to be terminal,
  -- because that is the authority the closure itself accepts, and the attempt
  -- has to be quiet, because a live worker is about to write the row the
  -- scope is missing.
  FOR r_session IN
    SELECT ys.id
      FROM public.youtube_upload_sessions ys
      JOIN public.posts p ON p.id = ys.post_id
     WHERE ys.state IN ('uploaded', 'failed', 'reconcile')
       AND p.status = 'processing'
       AND p.processing_started_at IS NOT DISTINCT FROM ys.attempt_started_at
       AND p.metadata ? 'legacy_notification_candidate'
       AND (p.metadata #>> '{legacy_notification_candidate,attempt_started_at}')::timestamptz
           IS NOT DISTINCT FROM ys.attempt_started_at
       AND (p.metadata #>> '{legacy_notification_candidate,fanout_closed}') IS DISTINCT FROM 'true'
       AND p.processing_started_at + public.youtube_upload_attempt_quiet_after() <= now()
     ORDER BY p.processing_started_at, ys.id
     LIMIT v_limit
  LOOP
    v_attempted := v_attempted + 1;
    v_result := public.recover_youtube_upload_fanout(r_session.id, NULL);
    IF coalesce((v_result ->> 'recovered')::boolean, false) THEN
      v_recovered := v_recovered + 1;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'cancelled_rows', v_cancelled,
    'terminal_rows', v_terminal,
    'fanouts_attempted', v_attempted,
    'fanouts_recovered', v_recovered
  );
END;
$$;

COMMENT ON FUNCTION public.reconcile_youtube_upload_fanouts(integer) IS
  'The bounded driver of the YouTube fanout repairs: it closes the pending row '
  'of a cancelled post, it settles the pending row of a terminal session whose '
  'worker died, and it closes a fanout whose attempt has gone quiet. '
  'It needs no worker and no provider.';

REVOKE ALL ON FUNCTION public.reconcile_youtube_upload_fanouts(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_youtube_upload_fanouts(integer) TO service_role;

-- ---------------------------------------------------------------------------
-- youtube_upload_effect_authority
--
-- The check that runs immediately before the provider is written to.
--
-- WHY IT EXISTS
-- -------------
-- A lease says "this worker owns the session". It does NOT say "the world is
-- still the way the worker saw it". Between the admission and the write, the
-- customer may have changed the title or the privacy, the post may have been
-- cancelled, the account may have been disconnected, the media may have been
-- replaced, and the security scan may have rejected the file. Any of those
-- turns the write into the wrong write.
--
-- So the authority is checked against the LIVE state at the moment of the
-- effect, and not against the lease alone:
--
--   * the worker still holds a live lease on the session;
--   * the session's attempt is the post's current attempt, and the post is
--     still being processed;
--   * the content fence still matches the live post;
--   * the account is still an authorised target of the post;
--   * the media file is still the version the upload started with, and it is
--     still SENDABLE -- the same rule every other send path uses, so a file
--     that is pending a scan or was rejected by one is not sent from here
--     either.
--
-- It returns the reason rather than raising, because the caller has to
-- decide: a stale attempt is a refusal, and a media file that is still
-- being scanned is a wait.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.youtube_upload_effect_authority(
  p_session_id uuid,
  p_lease_token uuid
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_session public.youtube_upload_sessions%ROWTYPE;
  v_post public.posts%ROWTYPE;
  v_fence jsonb;
  v_media_version integer;
  v_scan_state text;
BEGIN
  IF p_session_id IS NULL OR p_lease_token IS NULL THEN
    RETURN jsonb_build_object('authorized', false, 'reason', 'invalid_arguments');
  END IF;

  SELECT * INTO v_session FROM public.youtube_upload_sessions WHERE id = p_session_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('authorized', false, 'reason', 'session_not_found');
  END IF;

  IF v_session.lease_token IS DISTINCT FROM p_lease_token
     OR v_session.lease_expires_at IS NULL
     OR v_session.lease_expires_at <= now() THEN
    RETURN jsonb_build_object('authorized', false, 'reason', 'lease_stale');
  END IF;

  SELECT * INTO v_post FROM public.posts WHERE id = v_session.post_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('authorized', false, 'reason', 'post_not_found');
  END IF;
  IF v_session.attempt_started_at IS NOT NULL
     AND v_post.processing_started_at IS DISTINCT FROM v_session.attempt_started_at THEN
    RETURN jsonb_build_object('authorized', false, 'reason', 'stale_attempt');
  END IF;
  IF v_post.status <> 'processing' THEN
    RETURN jsonb_build_object('authorized', false, 'reason', 'post_not_processing');
  END IF;

  -- The content fence is the LIVE post. A title, a privacy or a caption that
  -- changed since the admission is caught here.
  v_fence := public.youtube_upload_live_fence(
    v_session.post_id, v_session.media_file_id, v_session.total_bytes, v_session.social_account_id);
  IF v_fence IS NULL THEN
    RETURN jsonb_build_object('authorized', false, 'reason', 'post_not_found');
  END IF;
  IF v_session.content_fence IS NOT NULL AND v_session.content_fence IS DISTINCT FROM v_fence THEN
    RETURN jsonb_build_object('authorized', false, 'reason', 'content_changed');
  END IF;

  IF NOT public.youtube_upload_target_authorized(
       v_session.post_id, v_session.social_account_id, v_session.target_account_ids) THEN
    RETURN jsonb_build_object('authorized', false, 'reason', 'target_not_authorized');
  END IF;

  -- The media file: still the version the upload started with, and still
  -- sendable. The sendability rule is the shared one, so a file that is
  -- pending a security scan or was rejected by it is refused here exactly as
  -- every other send path refuses it.
  IF v_session.media_file_id IS NOT NULL THEN
    SELECT current_object_version, scan_state
      INTO v_media_version, v_scan_state
      FROM public.media_files WHERE id = v_session.media_file_id;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('authorized', false, 'reason', 'media_missing');
    END IF;
    IF v_session.media_object_version IS NOT NULL
       AND coalesce(v_media_version, 1) IS DISTINCT FROM v_session.media_object_version THEN
      RETURN jsonb_build_object('authorized', false, 'reason', 'media_changed');
    END IF;
    IF v_scan_state = 'pending' THEN
      RETURN jsonb_build_object('authorized', false, 'reason', 'media_pending');
    END IF;
    IF v_scan_state = 'rejected' THEN
      RETURN jsonb_build_object('authorized', false, 'reason', 'media_rejected');
    END IF;
  END IF;

  RETURN jsonb_build_object('authorized', true, 'reason', null);
END;
$$;

COMMENT ON FUNCTION public.youtube_upload_effect_authority(uuid, uuid) IS
  'Whether the worker that holds the lease may write to the provider now. '
  'Checks the attempt, the post status, the live content fence, the target '
  'and the media -- including the shared media sendability rule -- against '
  'the live state, not against the lease alone.';

REVOKE ALL ON FUNCTION public.youtube_upload_effect_authority(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.youtube_upload_effect_authority(uuid, uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- The payload one function reads.
--
-- It carries the session URI, so it is only ever built for the service role.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.youtube_upload_session_payload(
  s public.youtube_upload_sessions
)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT jsonb_build_object(
    'id', s.id,
    'post_id', s.post_id,
    'social_account_id', s.social_account_id,
    'state', s.state,
    'session_uri', s.session_uri,
    'confirmed_bytes', s.confirmed_bytes,
    'bytes_sent', s.bytes_sent,
    'video_may_exist', s.video_may_exist,
    'total_bytes', s.total_bytes,
    'video_id', s.video_id,
    'session_expires_at', s.session_expires_at,
    'media_file_id', s.media_file_id,
    'media_object_version', s.media_object_version,
    'media_size', s.media_size,
    'platform_post_id', s.platform_post_id,
    'attempt_started_at', s.attempt_started_at,
    'next_check_at', s.next_check_at,
    'last_outcome', s.last_outcome,
    'continuation_count', s.continuation_count,
    'resolved_platform', s.resolved_platform,
    'target_account_ids', s.target_account_ids,
    -- The video resource that was sent to the provider. It is carried so a
    -- worker that has to OPEN the provider session (a session that was
    -- admitted but never opened one) sends the same resource the publish
    -- would have sent, instead of an empty one.
    'upload_body', s.upload_body,
    -- The query settings of the provider request. They are carried so a worker
    -- that has to OPEN the provider session (a session that was admitted but
    -- never opened one) makes the SAME request: the same parts, and the same
    -- subscriber notification the customer chose.
    'upload_settings', s.upload_settings,
    'error', s.error,
    'lease_expires_at', s.lease_expires_at
  )
$$;

-- ---------------------------------------------------------------------------
-- admit_youtube_upload
--
-- The session AND the public pending row, in one transaction, before the
-- provider is contacted.
--
-- The rules:
--   * the post must be the caller's, and the account must be the caller's
--     and must be a usable YouTube account;
--   * the media file must be the caller's;
--   * an existing session whose live fence no longer matches is refused;
--   * an existing session that already holds a receipt is returned as it is,
--     so the caller never uploads again;
--   * an existing session whose provider session is gone is reopened ONLY
--     when the record proves that no byte ever reached the provider. When
--     bytes were written the session is left for a human: a new session
--     could create a second video.
--
-- THE SAFE RESTART
-- ----------------
-- A retry changes the post's publish_requested_at, so the fence of the
-- session the previous attempt opened no longer matches the live post. That
-- fence describes a write that never happened, so a session that is terminal
-- AND that proves that nothing ever reached the provider is started again
-- BEFORE the fence is compared: the same media file at the same content
-- version, the same account, still a target of the post, the attempt that is
-- running. The fence and the upload body are refreshed with the live ones,
-- because this attempt publishes the live post.
--
-- A session that may already hold a video is not restarted, an open session
-- keeps the fence comparison, and a session that holds a receipt is returned
-- as it is. The rule is checked before the fence on purpose: a retry of an
-- upload that never sent a byte has to be possible.
-- ---------------------------------------------------------------------------
-- The admission grew a parameter, so the old signature is a different
-- function now. It is dropped rather than left behind: an overload that
-- nobody revokes would still be callable by the browser roles.
DROP FUNCTION IF EXISTS public.admit_youtube_upload(uuid, uuid, uuid, uuid, bigint, bigint, jsonb, timestamptz, uuid[], timestamptz);
DROP FUNCTION IF EXISTS public.admit_youtube_upload(uuid, uuid, uuid, uuid, bigint, bigint, jsonb, timestamptz, uuid[], timestamptz, jsonb);
DROP FUNCTION IF EXISTS public.admit_youtube_upload(uuid, uuid, uuid, uuid, bigint, bigint, jsonb, timestamptz, uuid[], timestamptz, jsonb, integer, jsonb);

CREATE OR REPLACE FUNCTION public.admit_youtube_upload(
  p_post_id uuid,
  p_social_account_id uuid,
  p_user_id uuid,
  p_media_file_id uuid,
  p_media_size bigint,
  p_total_bytes bigint,
  p_upload_body jsonb,
  p_attempt_started_at timestamptz DEFAULT NULL,
  p_target_account_ids uuid[] DEFAULT NULL,
  p_session_expires_at timestamptz DEFAULT NULL,
  p_expected_content jsonb DEFAULT NULL,
  p_expected_media_version integer DEFAULT NULL,
  p_upload_settings jsonb DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_post public.posts%ROWTYPE;
  v_account public.social_accounts%ROWTYPE;
  v_session public.youtube_upload_sessions%ROWTYPE;
  v_fence jsonb;
  v_content jsonb;
  v_media_version integer;
  v_settings jsonb;
  v_attempt timestamptz;
  v_public_row public.platform_posts%ROWTYPE;
  v_public_row_id uuid;
BEGIN
  IF p_post_id IS NULL OR p_social_account_id IS NULL OR p_user_id IS NULL THEN
    RAISE EXCEPTION 'YUS01: the post, the account and the owner are required' USING ERRCODE = 'YUS01';
  END IF;

  SELECT * INTO v_post FROM public.posts WHERE id = p_post_id AND user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'YUS01: the post is not the owner''s, or is not there' USING ERRCODE = 'YUS01';
  END IF;

  -- The post must still be the one being worked on, and the attempt the
  -- caller names must still be the running one. A post that was cancelled,
  -- superseded or retried is not admitted into a new upload.
  IF v_post.status <> 'processing' THEN
    RAISE EXCEPTION 'YUS12: the post is no longer being processed' USING ERRCODE = 'YUS12';
  END IF;
  IF p_attempt_started_at IS NOT NULL
     AND v_post.processing_started_at IS DISTINCT FROM p_attempt_started_at THEN
    RAISE EXCEPTION 'YUS11: the upload belongs to an older attempt of the post' USING ERRCODE = 'YUS11';
  END IF;

  -- The caller's snapshot must be the LIVE post.
  --
  -- The caller built the upload body from the post it read. Between that read
  -- and this admission the customer may have changed the title, the privacy
  -- or the caption, and the body would then publish the old one. The
  -- snapshot the caller used is compared with the live post HERE, under the
  -- post's lock, so a body that was built from a stale read is refused rather
  -- than blessed.
  IF p_expected_content IS NOT NULL THEN
    IF jsonb_typeof(p_expected_content) <> 'object' THEN
      RAISE EXCEPTION 'YUS04: the expected content is not usable' USING ERRCODE = 'YUS04';
    END IF;
    v_content := jsonb_build_object(
      'user_id', v_post.user_id,
      'caption', v_post.caption,
      'media_file_ids', v_post.media_file_ids,
      'metadata', public.normalize_threads_internal_metadata(v_post.metadata),
      'platforms', v_post.platforms,
      'scheduled_at', v_post.scheduled_at,
      'publish_requested_at', v_post.publish_requested_at,
      'source', v_post.source
    );
    IF v_content IS DISTINCT FROM jsonb_set(
      p_expected_content,
      '{metadata}',
      public.normalize_threads_internal_metadata(p_expected_content -> 'metadata'),
      true
    ) THEN
      RAISE EXCEPTION 'YUS04: the post was edited while the upload was being prepared' USING ERRCODE = 'YUS04';
    END IF;
  END IF;

  SELECT * INTO v_account FROM public.social_accounts
   WHERE id = p_social_account_id AND user_id = p_user_id AND platform = 'youtube' FOR SHARE;
  IF NOT FOUND OR NOT v_account.is_active THEN
    RAISE EXCEPTION 'YUS02: the account is not the owner''s, or is not usable' USING ERRCODE = 'YUS02';
  END IF;

  IF p_media_file_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.media_files WHERE id = p_media_file_id AND user_id = p_user_id
  ) THEN
    RAISE EXCEPTION 'YUS03: the media file is not the owner''s' USING ERRCODE = 'YUS03';
  END IF;

  IF p_media_size IS NULL OR p_media_size <= 0
     OR p_total_bytes IS NULL OR p_total_bytes <= 0 THEN
    RAISE EXCEPTION 'YUS10: the video has no usable size' USING ERRCODE = 'YUS10';
  END IF;

  IF p_upload_body IS NULL OR jsonb_typeof(p_upload_body) <> 'object' THEN
    RAISE EXCEPTION 'YUS04: the upload body is not usable' USING ERRCODE = 'YUS04';
  END IF;

  -- The query settings of the provider request.
  --
  -- They decide what the request DOES: the parts it writes and whether the
  -- channel's subscribers are told about the video. A worker that opens the
  -- provider session later has to make the SAME request, so they travel with
  -- the session.
  --
  -- They are kept when the caller gives them, and they are derived when it
  -- does not: the parts are the names of the fields the body carries, and the
  -- subscriber notification is the provider's default. A derived request
  -- writes the fields the body carries and notifies the way YouTube does by
  -- default, which is what the caller asked for when it named no settings.
  IF p_upload_settings IS NOT NULL AND jsonb_typeof(p_upload_settings) <> 'object' THEN
    RAISE EXCEPTION 'YUS04: the upload settings are not usable' USING ERRCODE = 'YUS04';
  END IF;

  v_settings := coalesce(
    p_upload_settings,
    jsonb_build_object(
      'part', coalesce(
        (SELECT string_agg(key, ',' ORDER BY key) FROM jsonb_object_keys(p_upload_body) AS key),
        'snippet,status'),
      'notifySubscribers', true));

  SELECT current_object_version INTO v_media_version
    FROM public.media_files WHERE id = p_media_file_id;

  -- THE FILE MUST BE THE ONE THE CALLER READ
  --
  -- The worker resolved the file it is about to send and named the version it
  -- read. If the file was replaced between that read and this admission, the
  -- bytes the worker holds belong to a version the post does not name any
  -- more, and the session would record the NEW version: a continuation could
  -- then send the old bytes under the new version, and the video would be a
  -- mixture of two files.
  --
  -- The admission refuses that, here, before the session exists and before
  -- anything is written to the provider.
  IF p_expected_media_version IS NOT NULL
     AND coalesce(v_media_version, 1) IS DISTINCT FROM p_expected_media_version THEN
    RAISE EXCEPTION 'YUS03: the media file was replaced while the worker was reading it' USING ERRCODE = 'YUS03';
  END IF;

  -- The attempt the session belongs to.
  --
  -- The caller names it when it knows it. When it does not, the post's own
  -- current attempt is used, which is the attempt the upload is really on:
  -- a post that was edited or retried is published again, and that is a new
  -- processing_started_at.
  v_attempt := coalesce(p_attempt_started_at, v_post.processing_started_at);

  -- The fence is the LIVE post, not a copy the session kept.
  v_fence := public.youtube_upload_live_fence(p_post_id, p_media_file_id, p_total_bytes, p_social_account_id);
  IF v_fence IS NULL THEN
    RAISE EXCEPTION 'YUS01: the post is not there' USING ERRCODE = 'YUS01';
  END IF;

  SELECT * INTO v_session FROM public.youtube_upload_sessions
   WHERE post_id = p_post_id AND social_account_id = p_social_account_id FOR UPDATE;

  IF NOT FOUND THEN
    INSERT INTO public.youtube_upload_sessions(
      user_id, post_id, social_account_id, media_file_id, media_object_version,
      media_size, total_bytes, upload_body, upload_settings, content_fence, session_expires_at,
      attempt_started_at, resolved_platform, target_account_ids)
    VALUES (
      p_user_id, p_post_id, p_social_account_id, p_media_file_id, v_media_version,
      p_media_size, p_total_bytes, p_upload_body, v_settings, v_fence, p_session_expires_at,
      v_attempt, 'youtube', p_target_account_ids)
    RETURNING * INTO v_session;
  ELSE
    -- A receipt that exists is the answer. The video is not uploaded again.
    IF v_session.state = 'uploaded' THEN
      RETURN jsonb_build_object(
        'session', public.youtube_upload_session_payload(v_session),
        'platform_post_id', v_session.platform_post_id
      );
    END IF;

    -- THE SAFE RESTART
    --
    -- A retry legitimately changes the post's publish_requested_at, so the
    -- fence the previous attempt left behind no longer matches the live
    -- post. That fence describes a write that never happened, so refusing
    -- the retry here would leave an upload that never sent a single byte
    -- unretryable for ever: the customer could not publish the video again
    -- at all, although nothing had ever reached the provider.
    --
    -- The restart is allowed ONLY when the record proves that nothing ever
    -- reached the provider, the media file is the SAME file at the SAME
    -- content version, the account is still a target of the post, and the
    -- attempt that is asking is the one that is running. The caller's upload
    -- body was built from the live post, and that was compared with the live
    -- post above, so the restarted upload publishes what the post says NOW.
    --
    -- A session that may already hold a video is NOT restarted: a second
    -- video on the customer's channel is worse than a post that needs a
    -- human. A session that is still OPEN is not restarted either: it holds
    -- a provider session that carries the OLD attempt's content, so it keeps
    -- the fence comparison below.
    IF v_session.state IN ('failed', 'expired')
       AND NOT v_session.video_may_exist
       AND v_session.bytes_sent = 0
       AND v_session.total_bytes IS NOT DISTINCT FROM p_total_bytes
       AND v_session.media_file_id IS NOT DISTINCT FROM p_media_file_id
       AND (v_session.media_object_version IS NULL
            OR coalesce(v_media_version, 1) IS NOT DISTINCT FROM v_session.media_object_version)
       AND public.youtube_upload_target_authorized(
             p_post_id, p_social_account_id,
             coalesce(p_target_account_ids, v_session.target_account_ids)) THEN
      UPDATE public.youtube_upload_sessions
         SET state = 'open', session_uri = NULL, confirmed_bytes = 0, bytes_sent = 0,
             session_expires_at = p_session_expires_at, error = NULL,
             lease_token = NULL, lease_expires_at = NULL,
             next_check_at = NULL, last_outcome = NULL, continuation_count = 0,
             attempt_started_at = v_attempt,
             -- The fence and the body are REFRESHED: this attempt publishes
             -- the live post, so the session must carry the live fence and
             -- the body that goes with it. The media file and its version
             -- are the ones that were checked above, and they are kept.
             content_fence = v_fence,
             upload_body = p_upload_body,
             upload_settings = v_settings,
             media_size = p_media_size,
             total_bytes = p_total_bytes,
             media_object_version = coalesce(v_media_version, v_session.media_object_version),
             resolved_platform = 'youtube',
             target_account_ids = coalesce(p_target_account_ids, v_session.target_account_ids),
             updated_at = clock_timestamp()
       WHERE id = v_session.id
      RETURNING * INTO v_session;
    END IF;

    IF v_session.content_fence IS DISTINCT FROM v_fence THEN
      RAISE EXCEPTION 'YUS04: the post was edited while the upload was in flight' USING ERRCODE = 'YUS04';
    END IF;

    -- The provider session is gone. A fresh session is only safe when the
    -- record proves that no byte ever reached the provider.
    IF v_session.state = 'expired'
       OR (v_session.session_expires_at IS NOT NULL AND v_session.session_expires_at <= now()) THEN
      IF v_session.video_may_exist OR v_session.bytes_sent > 0 THEN
        -- The last chunk may have been written, so a video may exist and a new
        -- session could create a second one.
        --
        -- The session is RETURNED in the 'reconcile' state rather than refused
        -- with an exception: a caller that catches the exception would undo
        -- this update with its own rollback, and the mark is the whole point.
        UPDATE public.youtube_upload_sessions
           SET state = 'reconcile',
               error = left(coalesce(v_session.error, 'The provider session expired after the last chunk may have been written.'), 300),
               lease_token = NULL, lease_expires_at = NULL,
               updated_at = clock_timestamp()
         WHERE id = v_session.id
        RETURNING * INTO v_session;
        RETURN jsonb_build_object(
          'session', public.youtube_upload_session_payload(v_session),
          'platform_post_id', v_session.platform_post_id
        );
      END IF;
      UPDATE public.youtube_upload_sessions
         SET state = 'open', session_uri = NULL, confirmed_bytes = 0, bytes_sent = 0,
             session_expires_at = p_session_expires_at, error = NULL,
             lease_token = NULL, lease_expires_at = NULL,
             next_check_at = NULL, last_outcome = NULL, continuation_count = 0,
             attempt_started_at = v_attempt,
             resolved_platform = 'youtube',
             target_account_ids = coalesce(p_target_account_ids, v_session.target_account_ids),
             updated_at = clock_timestamp()
       WHERE id = v_session.id
      RETURNING * INTO v_session;
    ELSIF v_session.state = 'reconcile' THEN
      -- A session that needs a human stays that way.
      RETURN jsonb_build_object(
        'session', public.youtube_upload_session_payload(v_session),
        'platform_post_id', v_session.platform_post_id
      );
    ELSIF v_session.state = 'failed' THEN
      -- A permanent failure may be tried again, but ONLY when the record
      -- proves that no video can exist. A failure that may already hold a
      -- video is left for a human, exactly like the expired session above:
      -- a new session could create a second video.
      --
      -- The mark is made HERE rather than raised as an exception, because a
      -- caller that caught the exception would undo it with its own
      -- rollback, and the mark is the whole point.
      IF v_session.video_may_exist OR v_session.bytes_sent > 0 THEN
        UPDATE public.youtube_upload_sessions
           SET state = 'reconcile',
               error = left(coalesce(v_session.error, 'The upload may already have left a video on the channel.'), 300),
               lease_token = NULL, lease_expires_at = NULL,
               updated_at = clock_timestamp()
         WHERE id = v_session.id
        RETURNING * INTO v_session;
        RETURN jsonb_build_object(
          'session', public.youtube_upload_session_payload(v_session),
          'platform_post_id', v_session.platform_post_id
        );
      END IF;
      -- A permanent failure may be tried again.
      UPDATE public.youtube_upload_sessions
         SET state = 'open', session_uri = NULL, confirmed_bytes = 0, bytes_sent = 0,
             session_expires_at = p_session_expires_at, error = NULL,
             lease_token = NULL, lease_expires_at = NULL,
             next_check_at = NULL, last_outcome = NULL, continuation_count = 0,
             attempt_started_at = v_attempt,
             resolved_platform = 'youtube',
             target_account_ids = coalesce(p_target_account_ids, v_session.target_account_ids),
             updated_at = clock_timestamp()
       WHERE id = v_session.id
      RETURNING * INTO v_session;
    ELSE
      -- The live session now belongs to the attempt that is running, and to the
      -- platform_posts row this attempt settles. The provider session URI is
      -- kept: it is what a continuation writes to.
      UPDATE public.youtube_upload_sessions
         SET attempt_started_at = v_attempt,
             resolved_platform = 'youtube',
             target_account_ids = coalesce(p_target_account_ids, v_session.target_account_ids),
             updated_at = clock_timestamp()
       WHERE id = v_session.id
      RETURNING * INTO v_session;
    END IF;
  END IF;

  -- The public pending row.
  --
  -- It is created here, in the same transaction as the session, so the post
  -- is never left with a pending row that no continuation can claim.
  SELECT * INTO v_public_row
    FROM public.platform_posts
   WHERE id = v_session.platform_post_id
   FOR UPDATE;

  IF v_public_row.id IS NULL OR v_public_row.status <> 'pending' THEN
    INSERT INTO public.platform_posts(
      post_id, social_account_id, platform, platform_post_id, platform_post_url,
      status, posted_at, response_data)
    VALUES (
      p_post_id, p_social_account_id, 'youtube', NULL, NULL,
      'pending', NULL,
      jsonb_build_object(
        'youtube_upload', jsonb_build_object(
          'state', 'admitted',
          'session_id', v_session.id,
          'attempt_started_at', v_attempt
        )
      ))
    RETURNING * INTO v_public_row;
  END IF;

  v_public_row_id := v_public_row.id;

  UPDATE public.youtube_upload_sessions
     SET platform_post_id = v_public_row_id,
         updated_at = clock_timestamp()
   WHERE id = v_session.id
  RETURNING * INTO v_session;

  RETURN jsonb_build_object(
    'session', public.youtube_upload_session_payload(v_session),
    'platform_post_id', v_public_row_id
  );
END;
$$;

COMMENT ON FUNCTION public.admit_youtube_upload(uuid, uuid, uuid, uuid, bigint, bigint, jsonb, timestamptz, uuid[], timestamptz, jsonb, integer, jsonb) IS
  'Admits one YouTube upload: the private session and the public pending '
  'platform_posts row are created in ONE transaction, before the provider is '
  'contacted. The caller''s snapshot of the post is compared with the live post '
  'under the post''s lock, so an upload body that was built from a stale read is '
  'refused rather than blessed. Refuses a post, account or media file that is '
  'not the owner''s, and a post whose live content changed while the upload was '
  'in flight. Reopens an expired session ONLY when the record proves that no '
  'byte ever reached the provider; otherwise the session is marked for manual '
  'reconciliation and returned in that state, because a refusal raised here '
  'would undo the mark with the caller''s rollback.';

-- ---------------------------------------------------------------------------
-- claim_youtube_upload_session
--
-- One session, one worker.
--
-- The lease is what makes the session single-owner. A worker whose lease has
-- expired cannot write: the compare-and-set in the write functions checks
-- both the token and the expiry, so a worker that was paused past its lease
-- finds that it lost the session instead of writing over the new owner.
-- ---------------------------------------------------------------------------
-- THE LEASE IS A NUMBER OF MILLISECONDS
-- -------------------------------------
-- PostgREST sends the named arguments of a function as JSON, and a JSON
-- interval has no agreed shape: a caller that sent an interval string would
-- depend on how the server parses it. A number of milliseconds is the same on
-- both sides, and this function turns it into an interval itself.
--
-- The conversion is the one place the two shapes meet, so it is the one place
-- that is written out and proved by the test suite.
CREATE OR REPLACE FUNCTION public.claim_youtube_upload_session(
  p_session_id uuid,
  p_lease_token uuid,
  p_lease_ms bigint DEFAULT 180000
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_session public.youtube_upload_sessions%ROWTYPE;
  v_post public.posts%ROWTYPE;
  v_fence jsonb;
  v_lease interval;
BEGIN
  IF p_session_id IS NULL OR p_lease_token IS NULL THEN
    RAISE EXCEPTION 'YUS01: the session and the lease token are required' USING ERRCODE = 'YUS01';
  END IF;
  IF p_lease_ms IS NULL OR p_lease_ms <= 0 OR p_lease_ms > 3600000 THEN
    RAISE EXCEPTION 'YUS09: the lease length is not usable' USING ERRCODE = 'YUS09';
  END IF;
  v_lease := make_interval(secs => (p_lease_ms::double precision / 1000.0));

  SELECT * INTO v_session FROM public.youtube_upload_sessions WHERE id = p_session_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'YUS08: the session is not there' USING ERRCODE = 'YUS08';
  END IF;

  -- A receipt is returned as it is: the caller uses it instead of uploading.
  -- The lease is still taken, so the receipt is projected once.
  --
  -- A live lease held by ANOTHER worker is not taken over here. The owner of
  -- an uploaded session is the worker that stored the receipt, and it is
  -- about to settle the public row with that lease. Taking it away would
  -- make the owner's own settlement fail.
  IF v_session.state = 'uploaded' THEN
    IF v_session.lease_expires_at IS NOT NULL
       AND v_session.lease_expires_at > now()
       AND v_session.lease_token IS DISTINCT FROM p_lease_token THEN
      RAISE EXCEPTION 'YUS07: another worker owns the session' USING ERRCODE = 'YUS07';
    END IF;
    UPDATE public.youtube_upload_sessions
       SET lease_token = p_lease_token,
           lease_expires_at = now() + v_lease,
           updated_at = clock_timestamp()
     WHERE id = v_session.id
    RETURNING * INTO v_session;
    RETURN public.youtube_upload_session_payload(v_session);
  END IF;

  IF v_session.state = 'reconcile' THEN
    RAISE EXCEPTION 'YUS05: the provider session is gone and bytes had been written' USING ERRCODE = 'YUS05';
  END IF;

  IF v_session.session_expires_at IS NOT NULL AND v_session.session_expires_at <= now() THEN
    RAISE EXCEPTION 'YUS06: the provider session is gone' USING ERRCODE = 'YUS06';
  END IF;

  -- Another worker holds the session and its lease is still live.
  IF v_session.lease_expires_at IS NOT NULL
     AND v_session.lease_expires_at > now()
     AND v_session.lease_token IS DISTINCT FROM p_lease_token THEN
    RAISE EXCEPTION 'YUS07: another worker owns the session' USING ERRCODE = 'YUS07';
  END IF;

  -- The continuation cap.
  --
  -- The cap is enforced by the BATCH claim, which will not hand out a session
  -- that is already at the cap. This single-session claim is what the holder
  -- of a lease uses to take the session it was just given, so it must not
  -- refuse the very dispatch that reached the cap: the worker that was handed
  -- the session at the cap has to be able to consume it.
  --
  -- So the cap refuses everyone EXCEPT the worker that still holds the live
  -- lease it was given. A takeover, and the same worker after its lease
  -- expired, are refused here -- and the batch reconciliation classifies the
  -- session once the lease is gone.
  IF v_session.continuation_count >= 24
     AND NOT (
       v_session.lease_token IS NOT DISTINCT FROM p_lease_token
       AND v_session.lease_expires_at IS NOT NULL
       AND v_session.lease_expires_at > now()
     ) THEN
    RAISE EXCEPTION 'YUS13: the upload has been continued too many times' USING ERRCODE = 'YUS13';
  END IF;

  -- The account must still be a target of the post.
  IF NOT public.youtube_upload_target_authorized(
       v_session.post_id, v_session.social_account_id, v_session.target_account_ids) THEN
    RAISE EXCEPTION 'YUS15: the account is not a target of this post' USING ERRCODE = 'YUS15';
  END IF;

  -- The content fence is the LIVE post.
  v_fence := public.youtube_upload_live_fence(
    v_session.post_id, v_session.media_file_id, v_session.total_bytes, v_session.social_account_id);
  IF v_fence IS NULL OR v_fence IS DISTINCT FROM v_session.content_fence THEN
    RAISE EXCEPTION 'YUS04: the post was edited while the upload was in flight' USING ERRCODE = 'YUS04';
  END IF;

  -- The post must still be on the attempt this session was opened for.
  --
  -- A post that was edited or retried is published again, and that is a new
  -- attempt with a new processing_started_at. The bytes of the older attempt
  -- are not what the customer asked for now, and the post may already have
  -- been settled by the attempt that replaced it.
  IF v_session.attempt_started_at IS NOT NULL THEN
    SELECT * INTO v_post FROM public.posts WHERE id = v_session.post_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'YUS01: the post is gone' USING ERRCODE = 'YUS01';
    END IF;
    IF v_post.status <> 'processing' THEN
      RAISE EXCEPTION 'YUS12: the post is no longer being processed' USING ERRCODE = 'YUS12';
    END IF;
    IF v_post.processing_started_at IS DISTINCT FROM v_session.attempt_started_at THEN
      RAISE EXCEPTION 'YUS11: the upload belongs to an older attempt of the post' USING ERRCODE = 'YUS11';
    END IF;
  END IF;

  UPDATE public.youtube_upload_sessions
     SET lease_token = p_lease_token,
         lease_expires_at = now() + v_lease,
         updated_at = clock_timestamp()
   WHERE id = v_session.id
  RETURNING * INTO v_session;

  RETURN public.youtube_upload_session_payload(v_session);
END;
$$;

COMMENT ON FUNCTION public.claim_youtube_upload_session(uuid, uuid, bigint) IS
  'Takes the session for one worker under a lease. The lease is a number of '
  'milliseconds, which this function turns into an interval. Refuses a '
  'session another worker holds, a session whose provider session is gone, an '
  'account the post no longer targets, a post whose live content changed '
  'while the upload was in flight, and a post that has moved on to a newer '
  'attempt.';

-- ---------------------------------------------------------------------------
-- checkpoint_youtube_upload_session
--
-- The confirmed progress, and the session URI when it was just issued.
--
-- The byte counts only ever grow: a worker that reports a smaller offset
-- than the record already holds does not move it, so two workers cannot walk
-- the offset backwards.
--
-- THE UNCERTAINTY IS STICKY
-- -------------------------
-- `video_may_exist` is never cleared here. It is set the moment the last
-- chunk may have been written, and clearing it would let a later worker write
-- the same bytes into a second session, which is a second video. Only the
-- provider saying the upload is still incomplete may clear it, and that
-- happens through the upload path, not through a checkpoint.
-- ---------------------------------------------------------------------------
-- The signature changed: it takes the flag that says the schedule is cleared,
-- which the old signature could not express. It is dropped rather than left
-- behind: an overload that nobody revokes would still be callable by the
-- browser roles.
DROP FUNCTION IF EXISTS public.checkpoint_youtube_upload_session(uuid, uuid, bigint, bigint, text, boolean, timestamptz, text);

CREATE OR REPLACE FUNCTION public.checkpoint_youtube_upload_session(
  p_session_id uuid,
  p_lease_token uuid,
  p_confirmed_bytes bigint,
  p_bytes_sent bigint,
  p_session_uri text DEFAULT NULL,
  p_video_may_exist boolean DEFAULT NULL,
  p_next_check_at timestamptz DEFAULT NULL,
  p_last_outcome text DEFAULT NULL,
  p_clear_next_check boolean DEFAULT false
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_session public.youtube_upload_sessions%ROWTYPE;
  v_authority jsonb;
BEGIN
  SELECT * INTO v_session FROM public.youtube_upload_sessions WHERE id = p_session_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'YUS08: the session is not there' USING ERRCODE = 'YUS08';
  END IF;

  IF v_session.lease_token IS DISTINCT FROM p_lease_token
     OR v_session.lease_expires_at IS NULL
     OR v_session.lease_expires_at <= now() THEN
    RAISE EXCEPTION 'YUS09: the lease is stale, so this worker does not own the session' USING ERRCODE = 'YUS09';
  END IF;

  IF p_confirmed_bytes IS NOT NULL
     AND (p_confirmed_bytes < 0 OR p_confirmed_bytes > v_session.total_bytes) THEN
    RAISE EXCEPTION 'YUS10: the confirmed byte count does not fit the video' USING ERRCODE = 'YUS10';
  END IF;
  IF p_bytes_sent IS NOT NULL
     AND (p_bytes_sent < 0 OR p_bytes_sent > v_session.total_bytes) THEN
    RAISE EXCEPTION 'YUS10: the written byte count does not fit the video' USING ERRCODE = 'YUS10';
  END IF;

  -- THE LAST GATE BEFORE THE PROVIDER IS WRITTEN TO
  --
  -- The lease says "this worker owns the session". It does NOT say that the
  -- world is still the way the worker saw it: the customer may have cancelled
  -- the post, or edited it, or replaced the file, while the chunk was being
  -- read. The preflight that ran before the read is advisory -- a slow read
  -- can be long enough for the world to change -- so the live authority is
  -- checked again HERE, in the last statement before the bytes are written.
  --
  -- It is checked on the chunk that completes the upload, because that is the
  -- write that can publish a video: the chunks before it only fill a provider
  -- session that is discarded when it is not finished.
  IF p_bytes_sent IS NOT NULL AND p_bytes_sent >= v_session.total_bytes THEN
    v_authority := public.youtube_upload_effect_authority(p_session_id, p_lease_token);
    IF NOT (v_authority ->> 'authorized')::boolean THEN
      CASE v_authority ->> 'reason'
        WHEN 'stale_attempt' THEN
          RAISE EXCEPTION 'YUS11: the upload belongs to an older attempt of the post' USING ERRCODE = 'YUS11';
        WHEN 'post_not_processing' THEN
          RAISE EXCEPTION 'YUS12: the post is no longer being processed' USING ERRCODE = 'YUS12';
        WHEN 'content_changed' THEN
          RAISE EXCEPTION 'YUS04: the post was edited while the upload was in flight' USING ERRCODE = 'YUS04';
        WHEN 'target_not_authorized' THEN
          RAISE EXCEPTION 'YUS15: the account is not a target of the post any more' USING ERRCODE = 'YUS15';
        WHEN 'media_missing' THEN
          RAISE EXCEPTION 'YUS03: the media file is gone' USING ERRCODE = 'YUS03';
        WHEN 'media_changed' THEN
          RAISE EXCEPTION 'YUS03: the media file was replaced while the upload was in flight' USING ERRCODE = 'YUS03';
        WHEN 'media_rejected' THEN
          RAISE EXCEPTION 'YUS03: the media file was rejected while the upload was in flight' USING ERRCODE = 'YUS03';
        WHEN 'media_pending' THEN
          RAISE EXCEPTION 'YUS03: the media file is still being scanned' USING ERRCODE = 'YUS03';
        ELSE
          RAISE EXCEPTION 'YUS01: the upload may not be written any more' USING ERRCODE = 'YUS01';
      END CASE;
    END IF;
  END IF;

  UPDATE public.youtube_upload_sessions
     SET confirmed_bytes = greatest(v_session.confirmed_bytes, coalesce(p_confirmed_bytes, v_session.confirmed_bytes)),
         bytes_sent = greatest(v_session.bytes_sent, coalesce(p_bytes_sent, v_session.bytes_sent)),
         session_uri = coalesce(p_session_uri, v_session.session_uri),
         -- The uncertainty only ever grows here.
         video_may_exist = v_session.video_may_exist OR coalesce(p_video_may_exist, false),
         -- The schedule has three states, and the flag keeps them apart: a
         -- time moves it, a cleared flag empties it, and neither leaves it
         -- where it was.
         next_check_at = CASE WHEN p_clear_next_check THEN NULL
                              WHEN p_next_check_at IS NOT NULL THEN p_next_check_at
                              ELSE v_session.next_check_at END,
         last_outcome = coalesce(p_last_outcome, v_session.last_outcome),
         updated_at = clock_timestamp()
   WHERE id = v_session.id;
  RETURN true;
END;
$$;

COMMENT ON FUNCTION public.checkpoint_youtube_upload_session(uuid, uuid, bigint, bigint, text, boolean, timestamptz, text, boolean) IS
  'Records the confirmed byte offset, the highest byte ever written, whether '
  'the provider may already have turned the upload into a video and, when the '
  'provider just issued a session, the session URI. The offsets only grow, and '
  'the uncertainty that a video may exist is never cleared here. Refuses a '
  'worker whose lease is stale, and refuses the chunk that completes the '
  'upload when the live authority no longer allows the write.';

-- ---------------------------------------------------------------------------
-- complete_youtube_upload_session
--
-- The receipt.
--
-- It is kept, and the session URI is dropped: once the video exists the URI
-- has no further use, and keeping it would keep a credential alive for
-- nothing.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.complete_youtube_upload_session(
  p_session_id uuid,
  p_lease_token uuid,
  p_video_id text
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_session public.youtube_upload_sessions%ROWTYPE;
BEGIN
  IF p_session_id IS NULL OR p_lease_token IS NULL
     OR p_video_id IS NULL OR btrim(p_video_id) = '' THEN
    RAISE EXCEPTION 'YUS10: the receipt is not usable' USING ERRCODE = 'YUS10';
  END IF;

  SELECT * INTO v_session FROM public.youtube_upload_sessions WHERE id = p_session_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'YUS08: the session is not there' USING ERRCODE = 'YUS08';
  END IF;

  -- The receipt is already there: the same answer, kept.
  IF v_session.state = 'uploaded' AND v_session.video_id = p_video_id THEN
    RETURN true;
  END IF;

  IF v_session.lease_token IS DISTINCT FROM p_lease_token
     OR v_session.lease_expires_at IS NULL
     OR v_session.lease_expires_at <= now() THEN
    RAISE EXCEPTION 'YUS09: the lease is stale, so this worker does not own the session' USING ERRCODE = 'YUS09';
  END IF;

  UPDATE public.youtube_upload_sessions
     SET state = 'uploaded',
         video_id = p_video_id,
         -- The receipt is what the customer needs from now on. The session URI
         -- has no further use and is dropped with it.
         session_uri = NULL,
         confirmed_bytes = total_bytes,
         bytes_sent = total_bytes,
         error = NULL,
         -- The lease is KEPT, deliberately.
         --
         -- The owner still has to settle the public row, and the settlement is
         -- fenced on the lease it was given. Clearing the lease here would
         -- leave the owner unable to settle the video it just finished: the
         -- receipt would sit on the session with nobody able to publish it.
         --
         -- The lease is released by the settlement, and a worker that dies
         -- before it leaves a lease that expires on its own.
         updated_at = clock_timestamp()
   WHERE id = v_session.id;
  RETURN true;
END;
$$;

COMMENT ON FUNCTION public.complete_youtube_upload_session(uuid, uuid, text) IS
  'Records the video id the provider returned. It is kept, the session URI is '
  'dropped with it, and the lease is KEPT so the owner can still settle the '
  'public row. Idempotent for the same video id, and refuses a worker whose '
  'lease is stale.';

-- ---------------------------------------------------------------------------
-- youtube_upload_lock_scope
--
-- The lock order every writer of a session shares.
--
-- WHY ONE ORDER
-- -------------
-- The admission locks the PARENT first and the SESSION after it. A writer that
-- takes the two locks the other way round can hold the lock the other one
-- needs, and PostgreSQL aborts one of the two transactions. So every writer of
-- a session takes the parent first, then the session, then the result row.
--
-- The parent's id is read without a lock first, because the session is locked
-- after the parent. The binding is read again once both locks are held, so a
-- session that was moved to another parent between the two reads cannot be
-- written against the wrong one.
--
-- It returns the parent's id, or the reason the scope could not be locked.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.youtube_upload_lock_scope(p_session_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_post_id uuid;
BEGIN
  IF p_session_id IS NULL THEN
    RETURN jsonb_build_object('locked', false, 'reason', 'session_missing');
  END IF;

  SELECT s.post_id INTO v_post_id
    FROM public.youtube_upload_sessions s
   WHERE s.id = p_session_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('locked', false, 'reason', 'session_missing');
  END IF;

  PERFORM 1 FROM public.posts p WHERE p.id = v_post_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('locked', false, 'reason', 'post_missing');
  END IF;

  PERFORM 1 FROM public.youtube_upload_sessions s WHERE s.id = p_session_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('locked', false, 'reason', 'session_missing');
  END IF;

  -- The binding is read again under both locks.
  IF (SELECT s.post_id FROM public.youtube_upload_sessions s WHERE s.id = p_session_id)
       IS DISTINCT FROM v_post_id THEN
    RETURN jsonb_build_object('locked', false, 'reason', 'session_rebound');
  END IF;

  RETURN jsonb_build_object('locked', true, 'post_id', v_post_id);
END;
$$;

COMMENT ON FUNCTION public.youtube_upload_lock_scope(uuid) IS
  'Locks the parent and the session of one upload in the order every writer '
  'shares, and re-reads the binding between them. Returns the parent''s id, or '
  'the reason the scope could not be locked.';

REVOKE ALL ON FUNCTION public.youtube_upload_lock_scope(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.youtube_upload_lock_scope(uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- settle_youtube_upload_session
--
-- The terminal public outcome, fenced.
--
-- The public row and the parent rollup are settled together, in one
-- transaction, and only by the worker that still owns the upload.
--
-- THE FENCE
-- ---------
--   * the worker must still hold the lease. A worker that lost it is NOT
--     allowed to write anything: the worker that took over may already have
--     written the video, and a stale worker settling the row would publish a
--     result the upload does not have.
--   * the session's attempt must still be the post's current attempt, and the
--     post must still be processing. A post that was cancelled or retried is
--     not settled by an older upload.
--
-- The lease is released with the settlement, so the next worker is not
-- blocked by a session nobody is working on.
--
-- THE OUTCOME
-- -----------
-- A video may exist when a byte ever reached the provider, or when the last
-- write may have landed: the session is 'reconcile' and the public row
-- carries the marker that says the outcome is unknown, so neither the
-- database nor the browser offers a blind retry.
--
-- A session that was ALREADY marked for a human keeps that mark, even when
-- the last write did not land and the final-byte flag says false. The mark is
-- what keeps a second video off the channel, and a failure must never take it
-- away.
--
-- A proven failure -- nothing ever reached the provider -- is 'failed' and
-- carries no marker, so it stays retryable.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.settle_youtube_upload_session(
  p_session_id uuid,
  p_lease_token uuid,
  p_status text,
  p_video_id text DEFAULT NULL,
  p_error_message text DEFAULT NULL,
  p_response_data jsonb DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_session public.youtube_upload_sessions%ROWTYPE;
  v_post public.posts%ROWTYPE;
  v_settled jsonb;
  v_video_may_exist boolean;
  v_uncertain boolean;
  v_state text;
  v_data jsonb;
  v_lock jsonb;
BEGIN
  IF p_session_id IS NULL OR p_lease_token IS NULL THEN
    RAISE EXCEPTION 'YUS01: the session and the lease token are required' USING ERRCODE = 'YUS01';
  END IF;
  IF p_status NOT IN ('success', 'failed') THEN
    RAISE EXCEPTION 'YUS01: the status is not one this session can be settled into' USING ERRCODE = 'YUS01';
  END IF;
  IF p_status = 'success' AND (p_video_id IS NULL OR btrim(p_video_id) = '') THEN
    RAISE EXCEPTION 'YUS10: the receipt is not usable' USING ERRCODE = 'YUS10';
  END IF;

  -- THE PARENT IS LOCKED FIRST
  --
  -- The admission takes the parent before the session, and every writer of a
  -- session takes them in that order, so two of them can never hold the lock
  -- the other one needs.
  v_lock := public.youtube_upload_lock_scope(p_session_id);
  IF NOT (v_lock ->> 'locked')::boolean THEN
    IF v_lock ->> 'reason' = 'post_missing' THEN
      RAISE EXCEPTION 'YUS01: the post is gone' USING ERRCODE = 'YUS01';
    END IF;
    RAISE EXCEPTION 'YUS08: the session is not there' USING ERRCODE = 'YUS08';
  END IF;

  -- Both rows are locked already; they are read again under the locks.
  SELECT * INTO v_session FROM public.youtube_upload_sessions WHERE id = p_session_id;
  SELECT * INTO v_post FROM public.posts WHERE id = (v_lock ->> 'post_id')::uuid;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'YUS01: the post is gone' USING ERRCODE = 'YUS01';
  END IF;

  -- The worker must still own the session.
  IF v_session.lease_token IS DISTINCT FROM p_lease_token
     OR v_session.lease_expires_at IS NULL
     OR v_session.lease_expires_at <= now() THEN
    RAISE EXCEPTION 'YUS09: the lease is stale, so this worker does not own the session' USING ERRCODE = 'YUS09';
  END IF;

  -- The session must still belong to the attempt that is running.
  IF v_session.attempt_started_at IS NOT NULL
     AND v_post.processing_started_at IS DISTINCT FROM v_session.attempt_started_at THEN
    RAISE EXCEPTION 'YUS11: the upload belongs to an older attempt of the post' USING ERRCODE = 'YUS11';
  END IF;
  IF v_post.status <> 'processing' THEN
    RAISE EXCEPTION 'YUS12: the post is no longer being processed' USING ERRCODE = 'YUS12';
  END IF;

  IF v_session.platform_post_id IS NULL THEN
    RAISE EXCEPTION 'YUS14: the session has no public row to settle' USING ERRCODE = 'YUS14';
  END IF;

  -- THE OUTCOME
  --
  -- A video may exist when a byte ever reached the provider, or when the last
  -- write may have landed. A session that was ALREADY marked for a human keeps
  -- that mark, even when the last write did not land: the mark is what keeps a
  -- second video off the channel, and a failure must never take it away.
  --
  -- The caller says so as well: a result that carries the uncertain marker is
  -- uncertain, whatever the flags say. The marker is what the retry gate and
  -- the page read, so a settlement that dropped it would offer a blind retry.
  v_video_may_exist := v_session.video_may_exist OR (p_status = 'success');
  v_uncertain := v_video_may_exist
    OR v_session.state = 'reconcile'
    OR coalesce(p_response_data ->> 'publish_outcome', '') = 'uncertain';
  v_state := CASE WHEN p_status = 'success' THEN 'uploaded'
                  WHEN v_uncertain THEN 'reconcile'
                  ELSE 'failed' END;

  -- The row's own record of what happened.
  --
  -- An outcome that is not a proof carries the marker that says so, so the
  -- retry gate in the database and the retry button on the page both refuse
  -- it. A proven failure carries no marker, so it stays retryable.
  v_data := coalesce(p_response_data, '{}'::jsonb);
  IF v_state = 'reconcile' THEN
    v_data := v_data || jsonb_build_object(
      'publish_outcome', 'uncertain',
      'publish_outcome_reason', 'the provider may already hold a video from this upload, so it has to be checked by hand'
    );
  END IF;

  v_settled := public.partner_settle_platform_post(
    v_session.platform_post_id,
    v_session.post_id,
    v_session.social_account_id,
    'youtube',
    p_status,
    p_video_id,
    CASE WHEN p_video_id IS NULL THEN NULL
         ELSE 'https://www.youtube.com/watch?v=' || p_video_id END,
    left(coalesce(p_error_message, ''), 300),
    v_data
  );

  UPDATE public.youtube_upload_sessions
     SET state = v_state,
         video_id = coalesce(p_video_id, v_session.video_id),
         session_uri = CASE WHEN p_status = 'success' THEN NULL ELSE v_session.session_uri END,
         confirmed_bytes = CASE WHEN p_status = 'success' THEN total_bytes ELSE confirmed_bytes END,
         bytes_sent = CASE WHEN p_status = 'success' THEN total_bytes ELSE bytes_sent END,
         error = CASE WHEN p_status = 'success' THEN NULL
                      ELSE left(coalesce(p_error_message, ''), 300) END,
         lease_token = NULL,
         lease_expires_at = NULL,
         updated_at = clock_timestamp()
   WHERE id = v_session.id;

  RETURN jsonb_build_object(
    'settled', true,
    'platform_post_id', v_session.platform_post_id,
    'post_status', v_post.status,
    'settlement', v_settled
  );
END;
$$;

COMMENT ON FUNCTION public.settle_youtube_upload_session(uuid, uuid, text, text, text, jsonb) IS
  'Settles the public row and the parent rollup of one YouTube upload, in '
  'one transaction, fenced to the worker that still holds the lease and to '
  'the attempt that is still running. A worker that lost its lease settles '
  'nothing.';

-- ---------------------------------------------------------------------------
-- project_youtube_upload_receipt
--
-- The receipt-only recovery.
--
-- The video exists, so it is projected onto the public row. NOTHING is sent
-- to the provider and no media is read: this is the path that makes a final
-- acknowledgement that was lost after the database had already stored the
-- receipt safe.
--
-- It does not need a lease, because it is not a provider write: the receipt
-- is already the truth. It does need the attempt to be the current one, so a
-- stale upload cannot settle a post that has moved on.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.project_youtube_upload_receipt(
  p_session_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_session public.youtube_upload_sessions%ROWTYPE;
  v_post public.posts%ROWTYPE;
  v_row public.platform_posts%ROWTYPE;
  v_settled jsonb;
  v_lock jsonb;
BEGIN
  IF p_session_id IS NULL THEN
    RAISE EXCEPTION 'YUS01: the session is required' USING ERRCODE = 'YUS01';
  END IF;

  -- THE PARENT IS LOCKED FIRST
  --
  -- The order matters twice over. A deadlock is possible when two writers
  -- take the two locks in opposite orders, and every writer of a session --
  -- the admission included -- takes the parent first. And a cancellation that
  -- commits while this recovery is reading has to be VISIBLE here: the post is
  -- locked first, so a cancellation either happened before this lock and is
  -- seen, or it waits for this transaction and happens after the settlement
  -- that was authorised while the post was still being processed.
  v_lock := public.youtube_upload_lock_scope(p_session_id);
  IF NOT (v_lock ->> 'locked')::boolean THEN
    IF v_lock ->> 'reason' = 'post_missing' THEN
      RAISE EXCEPTION 'YUS01: the post is gone' USING ERRCODE = 'YUS01';
    END IF;
    RAISE EXCEPTION 'YUS08: the session is not there' USING ERRCODE = 'YUS08';
  END IF;

  -- Both rows are locked already; they are read again under the locks.
  SELECT * INTO v_session FROM public.youtube_upload_sessions WHERE id = p_session_id;
  SELECT * INTO v_post FROM public.posts WHERE id = (v_lock ->> 'post_id')::uuid;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'YUS01: the post is gone' USING ERRCODE = 'YUS01';
  END IF;

  IF v_session.state <> 'uploaded' OR v_session.video_id IS NULL THEN
    RAISE EXCEPTION 'YUS05: there is no receipt to project' USING ERRCODE = 'YUS05';
  END IF;

  IF v_session.platform_post_id IS NULL THEN
    RAISE EXCEPTION 'YUS14: the session has no public row to settle' USING ERRCODE = 'YUS14';
  END IF;

  IF v_session.attempt_started_at IS NOT NULL
     AND v_post.processing_started_at IS DISTINCT FROM v_session.attempt_started_at THEN
    RAISE EXCEPTION 'YUS11: the upload belongs to an older attempt of the post' USING ERRCODE = 'YUS11';
  END IF;

  -- The result row is locked last, after the parent and the session.
  SELECT * INTO v_row FROM public.platform_posts WHERE id = v_session.platform_post_id FOR UPDATE;

  -- The row is already settled with the same video: the same answer, kept.
  --
  -- This is checked BEFORE the authority below, because there is nothing left
  -- to settle: no parent transition is made and nothing is overwritten. A
  -- projection that already ran rolled the parent up itself, so the parent is
  -- no longer 'processing' by the time the projection is asked to run again.
  IF v_row.status = 'success' AND v_row.platform_post_id = v_session.video_id THEN
    RETURN jsonb_build_object('settled', true, 'already', true, 'platform_post_id', v_row.id);
  END IF;
  IF v_row.status IN ('success', 'failed') THEN
    -- The row says something else. A second settlement is never forced.
    RETURN jsonb_build_object('settled', false, 'already', true, 'platform_post_id', v_row.id);
  END IF;

  IF v_post.status <> 'processing' THEN
    -- The owner cancelled or superseded the post. The receipt is KEPT on the
    -- session -- it is the truth about what the provider holds -- but the
    -- public row and the parent are NOT touched: a cancelled post must not
    -- be turned into a published one by a late receipt.
    RAISE EXCEPTION 'YUS12: the post is no longer being processed' USING ERRCODE = 'YUS12';
  END IF;

  v_settled := public.partner_settle_platform_post(
    v_row.id,
    v_session.post_id,
    v_session.social_account_id,
    'youtube',
    'success',
    v_session.video_id,
    'https://www.youtube.com/watch?v=' || v_session.video_id,
    NULL,
    jsonb_build_object(
      'youtube_video_id', v_session.video_id,
      'youtube_upload_source', 'receipt_recovery'
    )
  );

  RETURN jsonb_build_object(
    'settled', true,
    'already', false,
    'platform_post_id', v_row.id,
    'video_id', v_session.video_id,
    'settlement', v_settled
  );
END;
$$;

COMMENT ON FUNCTION public.project_youtube_upload_receipt(uuid) IS
  'Projects a stored receipt onto the public row and settles the parent. No '
  'provider is contacted and no media is read: the video already exists. '
  'Fenced to the attempt that is still running.';

-- ---------------------------------------------------------------------------
-- release_youtube_upload_session
--
-- A terminal state that is not a receipt.
--
--   'expired'   the provider session is gone
--   'reconcile' the provider may hold a video nobody has a receipt for
--   'failed'    the provider refused for good, so no video exists
--
-- The lease is released with it, so the next worker is not blocked by a
-- session nobody is working on.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.release_youtube_upload_session(
  p_session_id uuid,
  p_lease_token uuid,
  p_state text,
  p_error text DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_session public.youtube_upload_sessions%ROWTYPE;
BEGIN
  IF p_session_id IS NULL OR p_lease_token IS NULL THEN
    RAISE EXCEPTION 'YUS01: the session and the lease token are required' USING ERRCODE = 'YUS01';
  END IF;
  IF p_state NOT IN ('expired','reconcile','failed') THEN
    RAISE EXCEPTION 'YUS01: the state is not one this session can be released into' USING ERRCODE = 'YUS01';
  END IF;

  SELECT * INTO v_session FROM public.youtube_upload_sessions WHERE id = p_session_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'YUS08: the session is not there' USING ERRCODE = 'YUS08';
  END IF;

  -- A receipt is never taken back by a release.
  IF v_session.state = 'uploaded' THEN
    RETURN false;
  END IF;

  IF v_session.lease_token IS DISTINCT FROM p_lease_token
     OR v_session.lease_expires_at IS NULL
     OR v_session.lease_expires_at <= now() THEN
    RAISE EXCEPTION 'YUS09: the lease is stale, so this worker does not own the session' USING ERRCODE = 'YUS09';
  END IF;

  UPDATE public.youtube_upload_sessions
     SET state = p_state,
         error = left(coalesce(p_error, ''), 300),
         -- The lease is KEPT, deliberately.
         --
         -- A release is not the end of the story: the owner still has to
         -- settle the public row, and the settlement is fenced on the lease
         -- it was given. Clearing the lease here would leave the owner
         -- unable to publish the failure it just decided on, and the public
         -- row would stay pending for ever.
         --
         -- The lease is released by the settlement, and a worker that dies
         -- before it leaves a lease that expires on its own.
         updated_at = clock_timestamp()
   WHERE id = v_session.id;
  RETURN true;
END;
$$;

COMMENT ON FUNCTION public.release_youtube_upload_session(uuid, uuid, text, text) IS
  'Records a terminal state that is not a receipt: the provider session is '
  'gone, the provider may hold a video nobody has a receipt for, or the '
  'provider refused for good. Never takes back a receipt. The lease is KEPT '
  'so the owner can still settle the public row. Refuses a worker whose '
  'lease is stale.';

-- ---------------------------------------------------------------------------
-- youtube_upload_terminal_outcome
--
-- The outcome of a session that cannot be carried on.
--
-- ONE RULE
-- --------
--   * a video MAY exist -- a byte reached the provider, or the last write may
--     have landed -- is a manual outcome: the session is 'reconcile' and the
--     public reason asks for a human. A session that was already marked that
--     way stays that way, whatever the facts say: the mark is what keeps a
--     second video off the channel.
--   * NO video can exist is a definitive outcome. The provider refused for
--     good ('failed'), so nothing was published. The provider session was
--     gone ('expired', or an open session that cannot be carried on), so
--     nothing was ever sent.
--
-- The state the session was found in says what the worker decided when it
-- left, and the facts say whether a video can exist. Both are needed.
--
-- It is a pure rule, so it can be read and proved on its own.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.youtube_upload_terminal_outcome(
  p_pre_state text,
  p_may_exist boolean
)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT CASE
    WHEN p_pre_state = 'reconcile' OR p_may_exist THEN
      jsonb_build_object(
        'state', 'reconcile',
        'reason', 'youtube_upload_reconcile_required',
        'message', 'the provider may already hold a video from this upload, so it has to be checked by hand'
      )
    WHEN p_pre_state = 'failed' THEN
      jsonb_build_object(
        'state', 'failed',
        'reason', 'youtube_upload_rejected',
        'message', 'the provider refused the upload'
      )
    ELSE
      jsonb_build_object(
        'state', 'failed',
        'reason', 'youtube_upload_unsent',
        'message', 'the upload was never sent to the provider'
      )
  END
$$;

COMMENT ON FUNCTION public.youtube_upload_terminal_outcome(text, boolean) IS
  'The outcome of a YouTube upload session that cannot be carried on: a manual '
  'one when a video may exist, a definitive one when it cannot.';

REVOKE ALL ON FUNCTION public.youtube_upload_terminal_outcome(text, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.youtube_upload_terminal_outcome(text, boolean) TO service_role;

-- ---------------------------------------------------------------------------
-- youtube_upload_classify_terminal
--
-- The terminal classification of a session that cannot be carried on.
--
-- WHY IT EXISTS
-- -------------
-- A session that is classified privately -- marked 'reconcile' or 'failed' and
-- nothing else -- leaves its PUBLIC row pending for ever. The post stays
-- processing, the customer is told nothing, and the row nobody settles is the
-- row the parent roll-up waits for. So the classification and the public
-- outcome are one thing here, not two.
--
-- THE TWO OUTCOMES
-- ----------------
--   * a video MAY exist: a byte reached the provider, or the last write may
--     have landed. The public outcome is a failure with a manual reason, and
--     the session is 'reconcile', which the retry path refuses -- so a blind
--     retry can never publish a second video.
--   * NO video can exist: nothing ever reached the provider. The public
--     outcome is a definitive failure and the session is 'failed', which the
--     retry path accepts, because a retry cannot create a second video.
--
-- THE LOST-WORKER WINDOW
-- ----------------------
-- A worker that gives up releases the session into a terminal state and then
-- settles the public row in a SEPARATE call. A worker that dies in between
-- leaves the session terminal and the row pending, and nothing else in the
-- system will ever settle it: the claim only recovers open sessions and
-- stored receipts, and the sweeper leaves a post with a pending row alone.
-- The post would wait for ever.
--
-- So a session that is ALREADY terminal is classified here as well. The
-- reason follows the state it was found in: a session the worker marked for
-- a human stays that way, a session the provider refused for good is a
-- proven failure, and a session whose provider session was gone is a proven
-- failure unless a byte had reached the provider.
--
-- Nothing is sent to the provider and nothing is replayed: the outcome is
-- derived from the record, so an uncertain upload is closed with a manual
-- reason rather than published a second time.
--
-- THE AUTHORITY
-- -------------
-- The public row is only settled when the attempt is still the running one
-- and the post is still processing. A post that was cancelled, superseded or
-- retried keeps its own outcome: this classification must not turn a
-- cancelled post into a failed one.
--
-- A post that is no longer being processed is left alone, state and all: the
-- cancellation repair owns it, and that repair finds the session by its state
-- and closes its pending row. A classification that skipped the settlement
-- and still changed the state would take the repair's place, and the row
-- would stay pending for ever.
--
-- A worker that still holds the lease is never classified. It may be writing
-- right now, and taking the session away from it would let two workers write
-- the same upload.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.youtube_upload_classify_terminal(p_session_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_session public.youtube_upload_sessions%ROWTYPE;
  v_post public.posts%ROWTYPE;
  v_row public.platform_posts%ROWTYPE;
  v_may_exist boolean;
  v_state text;
  v_reason text;
  v_message text;
  v_settled jsonb;
  v_fanout jsonb;
  v_pre_state text;
  v_data jsonb;
  v_outcome jsonb;
  v_lock jsonb;
BEGIN
  IF p_session_id IS NULL THEN
    RETURN jsonb_build_object('classified', false, 'reason', 'invalid_arguments');
  END IF;

  -- THE PARENT IS LOCKED FIRST
  --
  -- The admission takes the parent before the session, and every writer of a
  -- session takes them in that order, so two of them can never hold the lock
  -- the other one needs.
  v_lock := public.youtube_upload_lock_scope(p_session_id);
  IF NOT (v_lock ->> 'locked')::boolean THEN
    IF v_lock ->> 'reason' = 'post_missing' THEN
      RETURN jsonb_build_object('classified', false, 'reason', 'post_missing');
    END IF;
    RETURN jsonb_build_object('classified', false, 'reason', 'session_missing');
  END IF;

  -- Both rows are locked already; they are read again under the locks.
  SELECT * INTO v_session FROM public.youtube_upload_sessions WHERE id = p_session_id;
  SELECT * INTO v_post FROM public.posts WHERE id = (v_lock ->> 'post_id')::uuid;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('classified', false, 'reason', 'post_missing');
  END IF;

  -- The state the session was found in.
  --
  -- A session that is ALREADY terminal is classified as well. That is the
  -- lost-worker window: the worker released the session into a terminal
  -- state and died before it could settle the public row, so the row is
  -- still pending, the post keeps waiting for an outcome that never comes,
  -- and the sweeper leaves the post alone because a pending row exists.
  v_pre_state := v_session.state;

  IF v_pre_state NOT IN ('open', 'failed', 'expired', 'reconcile') THEN
    RETURN jsonb_build_object('classified', false, 'reason', 'not_open');
  END IF;
  IF v_session.lease_expires_at IS NOT NULL AND v_session.lease_expires_at > now() THEN
    RETURN jsonb_build_object('classified', false, 'reason', 'lease_live');
  END IF;

  -- A post that is no longer being processed keeps its own outcome.
  --
  -- Its pending row is closed by the cancellation repair, and that repair
  -- finds the session by its state. A classification that skipped the
  -- settlement must not take the repair's place: it would change the state
  -- the repair looks for, and the row would stay pending for ever.
  IF v_post.status <> 'processing' THEN
    RETURN jsonb_build_object('classified', false, 'reason', 'post_not_processing');
  END IF;

  -- A video may exist when a byte ever reached the provider, or when the last
  -- write may have landed.
  v_may_exist := v_session.video_may_exist OR v_session.bytes_sent > 0;

  -- THE OUTCOME
  --
  -- The reason follows the facts and the state the session was found in.
  v_outcome := public.youtube_upload_terminal_outcome(v_pre_state, v_may_exist);
  v_state := v_outcome ->> 'state';
  v_reason := v_outcome ->> 'reason';
  v_message := v_outcome ->> 'message';

  -- The row's own record of what happened.
  --
  -- An outcome that is not a proven failure carries the marker that says so,
  -- so the retry gate in the database and the retry button on the page both
  -- refuse it: the provider may already hold the video.
  v_data := jsonb_build_object(
    'youtube_upload_reason', v_reason,
    'youtube_upload_state', v_state
  );
  IF v_reason = 'youtube_upload_reconcile_required' THEN
    v_data := v_data || jsonb_build_object(
      'publish_outcome', 'uncertain',
      'publish_outcome_reason', v_message
    );
  END IF;

  -- The public row is settled under the same authority as every other
  -- settlement. The parent is locked already and the result row is locked
  -- after the session, so the three never deadlock and a cancellation is
  -- either seen or waits.
  --
  -- A session of an attempt that is no longer the running one keeps its own
  -- outcome: its row is not settled here.
  IF v_session.platform_post_id IS NOT NULL
     AND (v_session.attempt_started_at IS NULL
          OR v_post.processing_started_at IS NOT DISTINCT FROM v_session.attempt_started_at) THEN
    SELECT * INTO v_row FROM public.platform_posts WHERE id = v_session.platform_post_id FOR UPDATE;
    IF FOUND AND v_row.status = 'pending' THEN
      v_settled := public.partner_settle_platform_post(
        v_row.id,
        v_session.post_id,
        v_session.social_account_id,
        'youtube',
        'failed',
        NULL,
        NULL,
        v_reason,
        v_data
      );
    END IF;
  END IF;

  UPDATE public.youtube_upload_sessions
     SET state = v_state,
         error = left(v_message, 300),
         lease_token = NULL,
         lease_expires_at = NULL,
         updated_at = clock_timestamp()
   WHERE id = v_session.id;

  -- The public row is settled now, so the post may be finished with the
  -- notification candidate that the worker that admitted the upload left
  -- open.
  --
  -- The closure comes after the settlement HERE, and that is safe because the
  -- whole classification is one transaction: the sweeper cannot see the
  -- settled row before the closure has run. The continuation, which settles in
  -- a transaction of its own, drives the closure BEFORE its settlement
  -- instead. A destination without a row has an unknown outcome, so it is
  -- closed with a non-retryable reason rather than left open.
  v_fanout := public.recover_youtube_upload_fanout(v_session.id, NULL);

  RETURN jsonb_build_object(
    'classified', true,
    'reason', v_reason,
    'state', v_state,
    'previous_state', v_pre_state,
    'settled', v_settled IS NOT NULL,
    'fanout', v_fanout
  );
END;
$$;

COMMENT ON FUNCTION public.youtube_upload_classify_terminal(uuid) IS
  'Classifies a session that cannot be carried on and settles its public row '
  'under the attempt authority. A video that may exist becomes a manual '
  'failure; a video that cannot exist becomes a definitive one. A session that '
  'is already terminal is classified too -- that is the window a worker that '
  'died between the release and the settlement leaves -- and its reason '
  'follows the state it was found in. Never classifies a session a worker '
  'still holds.';

REVOKE ALL ON FUNCTION public.youtube_upload_classify_terminal(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.youtube_upload_classify_terminal(uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- recover_youtube_upload_terminal_results
--
-- The bounded driver of the terminal-result recovery.
--
-- WHY IT EXISTS
-- -------------
-- A worker that gives up releases the session into a terminal state and then
-- settles the public row in a SEPARATE call. A worker that dies in between
-- leaves the session terminal -- 'failed', 'expired' or 'reconcile' -- and
-- the public row PENDING, and nothing else in the system settles it: the
-- claim only recovers open sessions and stored receipts, and the sweeper
-- leaves a post with a pending row alone. The post would stay 'processing'
-- for ever and the customer would see a publication that never finishes.
--
-- WHAT IT DOES, AND ONLY THAT
-- ---------------------------
-- It classifies the sessions whose public row is still pending although the
-- session itself is already terminal. The classification is the one the
-- database already applies to an open session that cannot be carried on, so
-- the outcome is derived from the record: no provider is contacted, no
-- upload is written a second time and nothing uncertain is replayed.
--
--   * a session that may already hold a video becomes 'reconcile' and its
--     row is closed with a manual, non-retryable reason,
--   * a session the provider refused for good becomes a proven failure,
--   * a session whose provider session was gone becomes a proven failure
--     unless a byte had reached the provider.
--
-- THE FENCES
-- ----------
--   * a worker that still holds the lease is left alone: it is about to
--     settle the row itself, and the release keeps the lease on purpose,
--   * the attempt must still be the running one and the post must still be
--     processing, so a cancelled or superseded post keeps its own outcome
--     and the row of a cancelled post is closed by the cancellation path,
--   * the work is bounded, so one call never walks the whole table.
--
-- THE TWO CALLERS
-- ---------------
-- The claim surface calls it with the shared batch limit, so the recovery
-- draws from the same budget as the rest of the batch. The repair driver
-- calls it as well, with a bound of its own: the repair needs no worker and
-- no provider, and a post that waits for a free slot would stay 'processing'
-- for ever, which is the very thing this recovery exists to prevent.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.recover_youtube_upload_terminal_results(p_limit integer DEFAULT 5)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_limit integer;
  v_candidate record;
  v_result jsonb;
  v_examined integer := 0;
  v_settled integer := 0;
  v_manual integer := 0;
BEGIN
  v_limit := least(50, greatest(0, coalesce(p_limit, 5)));

  FOR v_candidate IN
    SELECT ys.id
      FROM public.youtube_upload_sessions ys
      JOIN public.posts p ON p.id = ys.post_id
     WHERE ys.state IN ('failed', 'expired', 'reconcile')
       AND ys.platform_post_id IS NOT NULL
       -- A worker that still holds the lease is about to settle the row
       -- itself: the release keeps the lease on purpose.
       AND (ys.lease_expires_at IS NULL OR ys.lease_expires_at <= now())
       -- The authority of the classification, in the query as well: the post
       -- must still be processing and the attempt must still be the running
       -- one, so a cancelled or superseded post keeps its own outcome.
       AND p.status = 'processing'
       AND (ys.attempt_started_at IS NULL
            OR p.processing_started_at IS NOT DISTINCT FROM ys.attempt_started_at)
       AND EXISTS (
         SELECT 1 FROM public.platform_posts pp
          WHERE pp.id = ys.platform_post_id
            AND pp.status = 'pending'
       )
     ORDER BY ys.updated_at, ys.id
     LIMIT v_limit
  LOOP
    v_examined := v_examined + 1;
    v_result := public.youtube_upload_classify_terminal(v_candidate.id);
    IF coalesce((v_result ->> 'settled')::boolean, false) THEN
      v_settled := v_settled + 1;
    END IF;
    IF (v_result ->> 'reason') = 'youtube_upload_reconcile_required' THEN
      v_manual := v_manual + 1;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'examined', v_examined,
    'settled', v_settled,
    'manual', v_manual
  );
END;
$$;

COMMENT ON FUNCTION public.recover_youtube_upload_terminal_results(integer) IS
  'Classifies the YouTube upload sessions whose public row is still pending '
  'although the session itself is already terminal: that is the window a '
  'worker that died between the release and the settlement leaves. Nothing '
  'is sent to the provider and nothing is replayed.';

REVOKE ALL ON FUNCTION public.recover_youtube_upload_terminal_results(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.recover_youtube_upload_terminal_results(integer) TO service_role;

-- ---------------------------------------------------------------------------
-- claim_youtube_upload_sessions
--
-- THE CLAIM THAT DRIVES THE CONTINUATION
--
-- This is the cross-worker entry point. It hands out the sessions that are
-- due for another look, with a fresh lease token each. The reconciler calls
-- it every minute, so an upload that a worker left half written is carried on
-- without anybody pressing a button.
--
-- EVERY WINDOW AFTER THE ADMISSION IS ELIGIBLE
-- ---------------------------------------------
-- The admission creates the session and the public pending row together, so
-- every window that follows it has a finite recovery path:
--
--   * a session with NO provider session and NO bytes: the provider session
--     was never opened, so no video can exist. The worker opens one and
--     starts.
--   * a session with a provider session: the upload continues from the
--     confirmed offset.
--   * a session that holds a RECEIPT while the public row is still pending:
--     the receipt is projected onto the public row. No provider is contacted.
--   * a session whose provider session expired: it is reconciled when a byte
--     ever reached the provider, and admitted again when none did.
--   * a session that ran out of continuations: it is reconciled, and only
--     once the lease of the worker that holds it is gone.
--
-- THE SESSION URI IS NOT RETURNED
--
-- The session URI is the credential. It stays in this table and is read by the
-- worker with the token, so it never travels in a dispatch body, never appears
-- in a worker response and never reaches a client. What comes back is the
-- identity of the work: which post, which account, which attempt, and the
-- token that proves the claim is real.
--
-- THE DUE TIME
--
-- A session carries the time it may be looked at again. A session that is
-- not due is not claimed, so a provider that is down does not turn into a
-- loop, and a session that is waiting is not taken away from the worker that
-- is working on it.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.claim_youtube_upload_sessions(
  p_limit integer DEFAULT 5,
  p_lease_ms bigint DEFAULT 180000,
  p_max_continuations integer DEFAULT 24
)
RETURNS TABLE (
  session_id uuid,
  post_id uuid,
  social_account_id uuid,
  user_id uuid,
  media_file_id uuid,
  platform_post_id uuid,
  lease_token uuid,
  attempt_started_at timestamptz,
  confirmed_bytes bigint,
  bytes_sent bigint,
  video_may_exist boolean,
  total_bytes bigint,
  state text,
  continuation_count integer
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_limit integer := least(50, greatest(0, coalesce(p_limit, 5)));
  v_lease interval;
  v_candidate record;
BEGIN
  IF p_lease_ms IS NULL OR p_lease_ms <= 0 OR p_lease_ms > 3600000 THEN
    RAISE EXCEPTION 'YUS09: the lease length is not usable' USING ERRCODE = 'YUS09';
  END IF;
  v_lease := make_interval(secs => (p_lease_ms::double precision / 1000.0));

  -- The provider session is gone and a byte reached the provider: the
  -- provider may already hold a video, so only a human may decide.
  --
  -- The provider session is gone and no byte ever reached it: no video can
  -- exist, so the upload is admitted again from the start.
  --
  -- The reset is BOUNDED and it SKIPS LOCKED rows. A recovery backlog must
  -- not hold a lock on every session of the table and delay the claims that
  -- come after it.
  WITH expired AS (
    SELECT s.id
      FROM public.youtube_upload_sessions s
     WHERE s.state = 'open'
       AND s.session_uri IS NOT NULL
       AND s.session_expires_at IS NOT NULL
       AND s.session_expires_at <= now()
       AND NOT s.video_may_exist
       AND s.bytes_sent = 0
       AND (s.lease_expires_at IS NULL OR s.lease_expires_at <= now())
     ORDER BY s.session_expires_at, s.id
     LIMIT v_limit
     FOR UPDATE SKIP LOCKED
  )
  UPDATE public.youtube_upload_sessions s
     SET state = 'open', session_uri = NULL, confirmed_bytes = 0, bytes_sent = 0,
         session_expires_at = NULL, error = NULL,
         next_check_at = NULL, last_outcome = NULL,
         updated_at = clock_timestamp()
    FROM expired e
   WHERE s.id = e.id;

  -- The sessions that cannot be carried on any further are classified, and
  -- their public rows are settled with them.
  --
  -- They are classified ONE BY ONE, because the public outcome of a session
  -- depends on facts only that session knows: whether a video may exist, and
  -- whether the attempt that owns it is still the one running.
  --
  -- A worker that still holds the lease keeps its session: the mark waits
  -- until the lease is gone, so the public outcome is only projected once
  -- nobody is working on the session any more.
  --
  -- The set is BOUNDED, and the parents are the rows that are locked: the
  -- classification locks the parent before the session, so the parent is
  -- locked here as well and the two orders never meet. A parent another
  -- transaction holds is SKIPPED rather than waited for.
  FOR v_candidate IN
    SELECT s.id
      FROM public.youtube_upload_sessions s
      JOIN public.posts p ON p.id = s.post_id
     WHERE s.state = 'open'
       AND (s.lease_expires_at IS NULL OR s.lease_expires_at <= now())
       AND (
         -- The provider session is gone and a byte reached the provider.
         (s.session_expires_at IS NOT NULL
          AND s.session_expires_at <= now()
          AND (s.video_may_exist OR s.bytes_sent > 0))
         -- The upload ran out of continuations. A session that never opened a
         -- provider session counts too: it is just as exhausted, and leaving
         -- it invisible would leave its public row pending for ever.
         OR (s.continuation_count >= p_max_continuations
             AND (s.next_check_at IS NULL OR s.next_check_at <= now()))
       )
     ORDER BY s.id
     LIMIT v_limit
     FOR UPDATE OF p SKIP LOCKED
  LOOP
    PERFORM public.youtube_upload_classify_terminal(v_candidate.id);
  END LOOP;

  RETURN QUERY
  WITH due AS (
    SELECT s.id
      FROM public.youtube_upload_sessions s
     WHERE (
              -- The upload continues.
              (s.state = 'open' AND s.session_uri IS NOT NULL)
              -- The provider session was never opened and no byte was written,
              -- so no video can exist. The worker opens one and starts.
           OR (s.state = 'open' AND s.session_uri IS NULL
               AND s.bytes_sent = 0 AND NOT s.video_may_exist)
              -- A receipt the public row does not know about yet.
           OR (s.state = 'uploaded' AND s.video_id IS NOT NULL
               AND EXISTS (SELECT 1 FROM public.platform_posts pp
                            WHERE pp.id = s.platform_post_id AND pp.status = 'pending'))
           )
       AND s.attempt_started_at IS NOT NULL
       -- A receipt is projected even after the cap: the video exists, and
       -- projecting it is not another try.
       AND (s.state = 'uploaded' OR s.continuation_count < p_max_continuations)
       AND (s.lease_expires_at IS NULL OR s.lease_expires_at <= now())
       AND (s.next_check_at IS NULL OR s.next_check_at <= now())
     ORDER BY s.next_check_at NULLS FIRST, s.updated_at
     LIMIT v_limit
     FOR UPDATE SKIP LOCKED
  )
  UPDATE public.youtube_upload_sessions s
     SET lease_token = gen_random_uuid(),
         lease_expires_at = now() + v_lease,
         -- Only an upload that still has to be written counts a continuation.
         continuation_count = s.continuation_count
           + CASE WHEN s.state = 'open' THEN 1 ELSE 0 END,
         updated_at = clock_timestamp()
    FROM due
   WHERE s.id = due.id
  RETURNING s.id, s.post_id, s.social_account_id, s.user_id, s.media_file_id,
            s.platform_post_id, s.lease_token, s.attempt_started_at,
            s.confirmed_bytes, s.bytes_sent, s.video_may_exist, s.total_bytes,
            s.state, s.continuation_count;
END;
$$;

COMMENT ON FUNCTION public.claim_youtube_upload_sessions(integer, bigint, integer) IS
  'Claims the YouTube upload sessions that are due for another look, with a '
  'fresh lease token each. Every window after the admission is eligible: an '
  'upload that continues, an upload whose provider session was never opened, '
  'and a stored receipt whose public row is still pending. The session URI is '
  'not returned: the worker reads it with the token, so the credential stays '
  'in this table. The lease is a number of milliseconds, which this function '
  'turns into an interval.';

-- ---------------------------------------------------------------------------
-- The retry guard.
--
-- The only behavioral addition is the exclusion of a YouTube upload that
-- needs manual reconciliation from both targeting and deletion. Such an
-- upload may have created a video on the channel, so a retry could create a
-- second one. It is refused the same way an uncertain Threads image is.
--
-- A session that HOLDS A RECEIPT is excluded too: the video exists, so a
-- retry of that account would publish a second one.
--
-- Everything else is the accepted contract, unchanged.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.request_post_retry(
  p_post_id uuid,
  p_user_id uuid,
  p_account_ids uuid[] DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_post public.posts%ROWTYPE;
  v_targets uuid[];
  v_platforms text[];
  v_requested_at timestamptz := now();
BEGIN
  SELECT * INTO v_post
    FROM public.posts
   WHERE id = p_post_id AND user_id = p_user_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'refused', 'reason', 'not_found');
  END IF;

  IF v_post.status NOT IN ('failed', 'completed')
     OR v_post.source IS NOT DISTINCT FROM 'tiktok_review'
     OR (v_post.action_claim_id IS NOT NULL AND v_post.action_claimed_at > now() - interval '15 minutes') THEN
    RETURN jsonb_build_object('status', 'refused', 'reason', 'not_retryable');
  END IF;

  IF p_account_ids IS NOT NULL AND cardinality(p_account_ids) > 0 THEN
    SELECT array_agg(DISTINCT sa.id) INTO v_targets
      FROM public.social_accounts sa
     WHERE sa.id = ANY (p_account_ids)
       AND sa.user_id = p_user_id;
  ELSE
    SELECT array_agg(DISTINCT pp.social_account_id) INTO v_targets
      FROM public.platform_posts pp
      JOIN public.social_accounts sa ON sa.id = pp.social_account_id
     WHERE pp.post_id = p_post_id
       AND pp.status = 'failed'
       AND sa.user_id = p_user_id
       AND NOT (
         pp.platform = 'threads'
         AND pp.response_data #>> '{deferred,media_type}' = 'IMAGE'
         AND pp.response_data #>> '{deferred,publish_outcome}' IS NOT DISTINCT FROM 'uncertain'
       );
  END IF;

  SELECT array_agg(t) INTO v_targets
    FROM unnest(coalesce(v_targets, ARRAY[]::uuid[])) AS t
   WHERE NOT EXISTS (SELECT 1 FROM public.instagram_story_jobs sj
                      WHERE sj.post_id=p_post_id AND sj.social_account_id=t AND sj.result_id IS NOT NULL)
     AND NOT EXISTS (
       SELECT 1 FROM public.platform_posts pp
        WHERE pp.post_id = p_post_id
          AND pp.social_account_id = t
          AND pp.platform = 'threads'
          AND pp.response_data #>> '{deferred,media_type}' = 'IMAGE'
          AND pp.response_data #>> '{deferred,publish_outcome}' IS NOT DISTINCT FROM 'uncertain'
     )
     -- A YouTube upload that needs manual reconciliation may have created a
     -- video on the channel. It is not retried: the retry could create a
     -- second one. An upload that is still open is not retried either: the
     -- continuation carries it on, and a retry would write the same bytes
     -- into a second session. A session that already holds a RECEIPT is not
     -- retried either: the video exists, and publishing it again would put a
     -- second video on the channel.
     AND NOT EXISTS (
       SELECT 1 FROM public.youtube_upload_sessions ys
        WHERE ys.post_id = p_post_id
          AND ys.social_account_id = t
          AND ys.state IN ('reconcile', 'open', 'uploaded')
     )
     -- A result whose publish outcome is UNKNOWN or CANCELLED is not retried.
     -- The provider may already hold the publication, so a retry could publish
     -- a second one, and a cancelled attempt is not republished either. The
     -- marker is the row's own record of what happened, so it holds for every
     -- destination and not only for YouTube. It is refused here, in the one
     -- place every retry path goes through, so the queue, the API and the
     -- browser all get the same answer.
     AND NOT EXISTS (
       SELECT 1 FROM public.platform_posts pp
        WHERE pp.post_id = p_post_id
          AND pp.social_account_id = t
          AND coalesce(pp.response_data ->> 'publish_outcome', '') IN ('uncertain', 'cancelled')
     )
     AND NOT EXISTS (
       SELECT 1 FROM public.platform_posts pp
        WHERE pp.post_id = p_post_id
          AND pp.social_account_id = t
          AND (pp.status = 'pending'
               OR (pp.status = 'success'
                   AND NOT (pp.platform = 'instagram'
                            AND EXISTS (SELECT 1 FROM public.platform_posts failed
                                         WHERE failed.post_id = p_post_id
                                           AND failed.social_account_id = t
                                           AND failed.status = 'failed'))))
     );

  IF v_targets IS NULL OR cardinality(v_targets) = 0 THEN
    RETURN jsonb_build_object('status', 'refused', 'reason', 'no_targets');
  END IF;

  SELECT array_agg(DISTINCT sa.platform) INTO v_platforms
    FROM public.social_accounts sa
   WHERE sa.id = ANY (v_targets);

  DELETE FROM public.platform_posts
   WHERE post_id = p_post_id
     AND status = 'failed'
     AND social_account_id = ANY (v_targets)
     AND NOT EXISTS (SELECT 1 FROM public.instagram_story_jobs sj WHERE sj.result_id=platform_posts.id)
     AND NOT (
       platform = 'threads'
       AND response_data #>> '{deferred,media_type}' = 'IMAGE'
       AND response_data #>> '{deferred,publish_outcome}' IS NOT DISTINCT FROM 'uncertain'
     )
     -- An unknown or cancelled outcome keeps its row: it is the record of what
     -- happened, and it is the evidence that the destination is not retryable.
     -- The coalesce matters: a row without the marker must still be deleted,
     -- because `NOT (NULL IN (...))` is NULL and would keep it for ever.
     AND coalesce(response_data ->> 'publish_outcome', '') NOT IN ('uncertain', 'cancelled')
     AND NOT EXISTS (
       SELECT 1 FROM public.youtube_upload_sessions ys
        WHERE ys.post_id = platform_posts.post_id
          AND ys.social_account_id = platform_posts.social_account_id
          AND ys.state IN ('reconcile', 'open', 'uploaded')
     );

  UPDATE public.posts
     SET status = 'pending',
         publish_requested_at = v_requested_at,
         metadata = (CASE WHEN jsonb_typeof(metadata) = 'object' THEN metadata ELSE '{}'::jsonb END)
                    || jsonb_build_object(
           'retry_request', jsonb_build_object(
             'requested_at', v_requested_at,
             'account_ids', to_jsonb(v_targets),
             'platforms', to_jsonb(v_platforms),
             'prior_status', v_post.status
           )
         )
   WHERE id = p_post_id;

  RETURN jsonb_build_object(
    'status', 'accepted',
    'requested_at', v_requested_at,
    'account_ids', to_jsonb(v_targets),
    'platforms', to_jsonb(v_platforms)
  );
END;
$$;

COMMENT ON FUNCTION public.request_post_retry(uuid, uuid, uuid[]) IS
  'The accepted retry contract, plus the exclusion of a YouTube upload that '
  'needs manual reconciliation or that already holds a receipt: such an '
  'upload may have created a video on the channel, so it is neither targeted '
  'nor deleted. A result whose publish outcome is unknown or cancelled is '
  'neither targeted nor deleted either, for the same reason: the provider '
  'may already hold the publication.';

-- ---------------------------------------------------------------------------
-- The sweeper is taught about the YouTube upload.
--
-- sweep_stale_processing_posts marks a post that has been processing for too
-- long as failed, with the message "Safe to retry". For a YouTube upload that
-- is wrong: the upload may already have written its last chunk, so the
-- provider may hold a video, and the retry would create a second one.
--
-- The post is left alone while a YouTube upload session is open. The
-- continuation carries the upload on, and the session itself ends in a state
-- that says what a human has to decide.
--
-- The function is re-declared here rather than patched in place, because a
-- migration cannot change the body of a function that already exists. The
-- body is the one from 20261029180000_deferred_publishes.sql with the one
-- exclusion added.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sweep_stale_processing_posts(
  p_older_than interval DEFAULT interval '20 minutes'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_post      record;
  v_account   record;
  v_posts     integer := 0;
  v_rows      integer := 0;
  v_succeeded integer;
  v_message   constant text := 'Publishing was interrupted before it finished. Safe to retry.';
BEGIN
  FOR v_post IN
    SELECT p.id, p.user_id, p.metadata
      FROM public.posts p
     WHERE p.status = 'processing'
       AND p.processing_started_at < now() - p_older_than
       AND NOT EXISTS (
         SELECT 1 FROM public.platform_posts pp
          WHERE pp.post_id = p.id AND pp.status = 'pending'
       )
       -- A YouTube upload that is still open is being carried on by the
       -- continuation. Sweeping it here would offer a retry for an upload
       -- whose provider session may already hold a video.
       AND NOT EXISTS (
         SELECT 1 FROM public.youtube_upload_sessions ys
          WHERE ys.post_id = p.id AND ys.state = 'open'
       )
     ORDER BY p.processing_started_at
     LIMIT 50
     FOR UPDATE SKIP LOCKED
  LOOP
    v_posts := v_posts + 1;

    FOR v_account IN
      SELECT a.id, a.platform
        FROM public.social_accounts a
       WHERE jsonb_typeof(v_post.metadata -> 'selected_account_ids') = 'array'
         AND a.id::text IN (SELECT jsonb_array_elements_text(v_post.metadata -> 'selected_account_ids'))
         AND a.user_id = v_post.user_id
         AND NOT EXISTS (
           SELECT 1 FROM public.platform_posts pp
            WHERE pp.post_id = v_post.id AND pp.social_account_id = a.id
         )
    LOOP
      -- A destination of a post with a YouTube upload has an AMBIGUOUS outcome.
      --
      -- The platforms that are not YouTube write their result row AFTER the
      -- provider call, so an absent row does not prove that the destination
      -- never started: the provider call may have succeeded and the receipt
      -- may have been lost with the worker. A row that says "Safe to retry"
      -- would therefore offer a retry that can publish a second time.
      --
      -- Such a destination is closed with the same non-retryable reason the
      -- durable recovery uses, so the two paths agree and neither of them can
      -- publish twice. The parent is still rolled up below, so the post
      -- reaches a finite outcome either way.
      IF EXISTS (
        SELECT 1 FROM public.youtube_upload_sessions ys
         WHERE ys.post_id = v_post.id
      ) THEN
        PERFORM public.partner_close_ambiguous_destination(v_post.id, v_account.id, v_account.platform);
      ELSE
        PERFORM public.partner_settle_platform_post(
          NULL, v_post.id, v_account.id, v_account.platform, 'failed',
          NULL, NULL, v_message, jsonb_build_object('swept_at', now())
        );
      END IF;
      v_rows := v_rows + 1;
    END LOOP;

    SELECT count(*) FILTER (WHERE status = 'success')
      INTO v_succeeded
      FROM public.platform_posts WHERE post_id = v_post.id;

    UPDATE public.posts
       SET status    = CASE WHEN v_succeeded > 0 THEN 'completed' ELSE 'failed' END,
           posted_at = CASE WHEN v_succeeded > 0 THEN coalesce(posted_at, now()) ELSE posted_at END
     WHERE id = v_post.id AND status = 'processing';
  END LOOP;

  RETURN jsonb_build_object('posts', v_posts, 'rows_failed', v_rows);
END;
$$;

COMMENT ON FUNCTION public.sweep_stale_processing_posts(interval) IS
  'Marks the posts that have been processing for too long as failed. A post '
  'with an open YouTube upload session is left alone: the continuation carries '
  'the upload on, and a sweep would offer a retry for an upload whose '
  'provider session may already hold a video. A destination of a post with a '
  'YouTube upload is closed with a non-retryable reason instead of a retry '
  'offer, because its outcome is ambiguous.';

-- ---------------------------------------------------------------------------
-- The completion claim learns about the YouTube upload.
--
-- claim_post_completion_work is the reconciler's one bounded claim surface.
-- It now also hands out the YouTube upload sessions that are due for another
-- look, so a worker that did not finish an upload does not need a second
-- cron and a second claim path.
--
-- THE RETURNED SHAPE
-- ------------------
--   kind                   'youtube_upload_continuation'
--   candidate_id           the upload session
--   claim_id               the claim token
--   attempt_started_at     the post attempt the session belongs to
--   platform_post_id       NULL
--
-- The session URI is not in it. The worker reads the session with the token,
-- so the credential stays in this table.
--
-- THE LIMIT IS SHARED
-- -------------------
-- Every step draws from the SAME limit. A notification candidate that took a
-- slot does not leave a slot for an upload, and the other way round: the
-- limit is the number of pieces of work one reconciler pass may hold.
--
-- And no kind may starve: the steps run in order, so the first one would take
-- every slot on every pass and the later ones would never run. Each of the
-- later steps therefore keeps ONE slot and the first step shares what is
-- left, so a backlog of one kind cannot starve the others. The total is still
-- p_limit.
--
-- The function is dropped and recreated because a migration cannot change the
-- columns a function returns. The body is the one from
-- 20261117120000_threads_image_inline_completion.sql with the YouTube step
-- added and the shared limit honoured.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.claim_post_completion_work(integer, interval);
CREATE OR REPLACE FUNCTION public.claim_post_completion_work(
  p_limit integer DEFAULT 5,
  p_lease interval DEFAULT interval '3 minutes'
)
RETURNS TABLE (
  kind text,
  platform_post_id uuid,
  post_id uuid,
  attempt_started_at timestamptz,
  candidate_id uuid,
  claim_id uuid
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_claimed_count integer := 0;
  v_rec record;
  v_candidate_rec record;
  v_remaining integer;
  v_step1_post_ids uuid[] := ARRAY[]::uuid[];
  v_reserved integer;
BEGIN
  p_limit := least(5, greatest(0, coalesce(p_limit, 5)));
  p_lease := interval '3 minutes';

  -- Every kind keeps a slot.
  --
  -- The steps run in order, so the first one would take every slot on every
  -- pass and the later ones would never run: a backlog of deferred publishes
  -- would starve the upload continuations for ever, and an upload that is due
  -- for another look would never be claimed.
  --
  -- Each of the later steps therefore keeps ONE slot, and the first step
  -- shares what is left. The total is still p_limit, and a limit of one keeps
  -- the plain order: there is only one slot, and it goes to the step that
  -- comes first.
  v_reserved := least(2, greatest(0, p_limit - 1));

  -- Step 1: Claim due deferred publishes / image rows using existing claim_deferred_publishes
  FOR v_rec IN
    SELECT cdp.platform_post_id, cdp.post_id
      FROM public.claim_deferred_publishes(p_limit - v_reserved, p_lease) cdp
  LOOP
    kind := 'deferred_publish';
    platform_post_id := v_rec.platform_post_id;
    post_id := v_rec.post_id;
    attempt_started_at := NULL;
    candidate_id := NULL;
    claim_id := NULL;
    v_claimed_count := v_claimed_count + 1;
    v_step1_post_ids := array_append(v_step1_post_ids, v_rec.post_id);
    RETURN NEXT;
  END LOOP;

  -- Step 2: If capacity remains within p_limit, claim ready legacy notification candidates
  v_remaining := p_limit - v_claimed_count;
  IF v_remaining > 0 THEN
    FOR v_candidate_rec IN
      WITH candidates AS (
        SELECT p.id,
               p.processing_started_at,
               (p.metadata #>> '{legacy_notification_candidate,candidate_id}')::uuid AS c_id
          FROM public.posts p
         WHERE p.status IN ('completed', 'failed')
           AND p.metadata ? 'legacy_notification_candidate'
           AND (p.metadata #>> '{legacy_notification_candidate,ready}') = 'true'
           AND (p.metadata #>> '{legacy_notification_candidate,fanout_closed}') = 'true'
           AND (p.metadata #>> '{legacy_notification_candidate,attempt_started_at}')::timestamptz = p.processing_started_at
           AND p.metadata #>> '{legacy_notification_candidate,status}' = p.status
           AND p.metadata #>> '{legacy_notification_candidate,content_hash}' = md5(jsonb_build_object(
             'user_id', p.user_id, 'caption', p.caption, 'media_file_ids', p.media_file_ids,
             'metadata', public.normalize_threads_internal_metadata(p.metadata), 'platforms', p.platforms,
             'scheduled_at', p.scheduled_at, 'publish_requested_at', p.publish_requested_at, 'source', p.source
           )::text)
           AND NOT (p.metadata ? 'final_notification_intent')
           AND coalesce((p.metadata #>> '{legacy_notification_candidate,consumed}')::boolean, false) = false
           AND coalesce((p.metadata #>> '{legacy_notification_candidate,claimed_until}')::timestamptz, '-infinity') <= now()
           AND (
             (p.metadata ->> 'final_notified_at') IS NULL
             OR (p.metadata ->> 'final_notified_at')::timestamptz < p.processing_started_at
           )
           -- Exclude posts already claimed in Step 1
           AND (cardinality(v_step1_post_ids) = 0 OR p.id <> ALL(v_step1_post_ids))
           -- Do not compete with a managed IMAGE post
           AND NOT EXISTS (
             SELECT 1 FROM public.platform_posts pp
              WHERE pp.post_id = p.id
                AND pp.response_data #>> '{deferred,kind}' = 'threads'
                AND pp.response_data #>> '{deferred,media_type}' = 'IMAGE'
                AND (pp.response_data #>> '{deferred,attempt_started_at}')::timestamptz IS NOT DISTINCT FROM p.processing_started_at
           )
         ORDER BY coalesce((p.metadata #>> '{legacy_notification_candidate,claimed_until}')::timestamptz, p.created_at), p.created_at
         LIMIT greatest(0, v_remaining - CASE WHEN v_reserved > 0 THEN 1 ELSE 0 END)
         FOR UPDATE OF p SKIP LOCKED
      )
      UPDATE public.posts p
         SET metadata = jsonb_set(
               p.metadata,
               '{legacy_notification_candidate}',
               (p.metadata -> 'legacy_notification_candidate') || jsonb_build_object(
                 'claimed_until', now() + p_lease,
                 'claim_id', gen_random_uuid()
               )
             )
        FROM candidates
       WHERE p.id = candidates.id
      RETURNING p.id AS post_id, p.processing_started_at, (p.metadata #>> '{legacy_notification_candidate,candidate_id}')::uuid AS candidate_id,
        (p.metadata #>> '{legacy_notification_candidate,claim_id}')::uuid AS claim_id
    LOOP
      kind := 'notification_only';
      platform_post_id := NULL;
      post_id := v_candidate_rec.post_id;
      attempt_started_at := v_candidate_rec.processing_started_at;
      candidate_id := v_candidate_rec.candidate_id;
      claim_id := v_candidate_rec.claim_id;
      -- The notification candidate took a slot of the shared limit.
      v_claimed_count := v_claimed_count + 1;
      RETURN NEXT;
    END LOOP;
  END IF;

  -- Step 3: If capacity remains, claim the YouTube upload sessions that are
  -- due for another look.
  --
  -- A session without an attempt is never claimed: the worker could not tell
  -- whether the post it belongs to is still the one that is being worked on.
  --
  -- THE TERMINAL RECOVERY DRAWS FROM THE SAME LIMIT
  -- -----------------------------------------------
  -- A session that is already terminal although its public row is still
  -- pending is settled here, before the claim: that is the window a worker
  -- that died between the release and the settlement leaves, and the post
  -- waits in 'processing' for an outcome that never comes.
  --
  -- The recovery is bounded by the same remaining limit as the rest of the
  -- batch, so one pass never walks more than the batch allows. It does not
  -- CONSUME the budget: it hands out no work and costs no worker, and
  -- taking a slot away from a continuation would starve an upload that is
  -- still running.
  v_remaining := p_limit - v_claimed_count;
  IF v_remaining > 0 THEN
    PERFORM public.recover_youtube_upload_terminal_results(v_remaining);

    FOR v_rec IN
      SELECT ys.session_id, ys.post_id, ys.attempt_started_at, ys.lease_token
        FROM public.claim_youtube_upload_sessions(v_remaining, 180000, 24) ys
    LOOP
      kind := 'youtube_upload_continuation';
      platform_post_id := NULL;
      post_id := v_rec.post_id;
      attempt_started_at := v_rec.attempt_started_at;
      candidate_id := v_rec.session_id;
      claim_id := v_rec.lease_token;
      v_claimed_count := v_claimed_count + 1;
      RETURN NEXT;
    END LOOP;
  END IF;

  -- Step 4: Drive the YouTube fanout repairs.
  --
  -- This hands out no work: the outcome is derived from the database, so it
  -- needs no worker and no provider. It is not part of the shared limit for
  -- that reason, and a post that waits for a free slot would stay
  -- 'processing' for ever.
  PERFORM public.reconcile_youtube_upload_fanouts(5);
END;
$$;

COMMENT ON FUNCTION public.claim_post_completion_work(integer, interval) IS
  'The reconciler''s one bounded claim surface. It hands out the deferred '
  'Meta containers, the ready legacy notification candidates, and the YouTube '
  'upload sessions that are due for another look. Every kind draws from the '
  'same limit. It also drives the YouTube fanout repairs, which need no '
  'worker.';

-- ---------------------------------------------------------------------------
-- The grants.
--
-- This stack carries ALTER DEFAULT PRIVILEGES ... GRANT ALL ON FUNCTIONS TO
-- anon, authenticated, so "REVOKE ... FROM PUBLIC" alone would leave both
-- browser roles holding EXECUTE. The roles are named explicitly.
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.youtube_upload_live_fence(uuid, uuid, bigint, uuid),
  public.youtube_upload_target_authorized(uuid, uuid, uuid[]),
  public.youtube_upload_session_payload(public.youtube_upload_sessions),
  public.admit_youtube_upload(uuid, uuid, uuid, uuid, bigint, bigint, jsonb, timestamptz, uuid[], timestamptz, jsonb, integer, jsonb),
  public.claim_youtube_upload_session(uuid, uuid, bigint),
  public.checkpoint_youtube_upload_session(uuid, uuid, bigint, bigint, text, boolean, timestamptz, text, boolean),
  public.complete_youtube_upload_session(uuid, uuid, text),
  public.settle_youtube_upload_session(uuid, uuid, text, text, text, jsonb),
  public.project_youtube_upload_receipt(uuid),
  public.release_youtube_upload_session(uuid, uuid, text, text),
  public.claim_youtube_upload_sessions(integer, bigint, integer)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.admit_youtube_upload(uuid, uuid, uuid, uuid, bigint, bigint, jsonb, timestamptz, uuid[], timestamptz, jsonb, integer, jsonb),
  public.claim_youtube_upload_session(uuid, uuid, bigint),
  public.checkpoint_youtube_upload_session(uuid, uuid, bigint, bigint, text, boolean, timestamptz, text, boolean),
  public.complete_youtube_upload_session(uuid, uuid, text),
  public.settle_youtube_upload_session(uuid, uuid, text, text, text, jsonb),
  public.project_youtube_upload_receipt(uuid),
  public.release_youtube_upload_session(uuid, uuid, text, text),
  public.claim_youtube_upload_sessions(integer, bigint, integer)
  TO service_role;

REVOKE ALL ON FUNCTION public.youtube_upload_lock_scope(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.youtube_upload_lock_scope(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.request_post_retry(uuid, uuid, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.request_post_retry(uuid, uuid, uuid[]) TO service_role;

REVOKE ALL ON FUNCTION public.claim_post_completion_work(integer, interval) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_post_completion_work(integer, interval) TO service_role;

REVOKE ALL ON FUNCTION public.sweep_stale_processing_posts(interval) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sweep_stale_processing_posts(interval) TO service_role;
