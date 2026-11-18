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
-- ---------------------------------------------------------------------------
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
  p_session_expires_at timestamptz DEFAULT NULL
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
  v_media_version integer;
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

  SELECT current_object_version INTO v_media_version
    FROM public.media_files WHERE id = p_media_file_id;

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
      media_size, total_bytes, upload_body, content_fence, session_expires_at,
      attempt_started_at, resolved_platform, target_account_ids)
    VALUES (
      p_user_id, p_post_id, p_social_account_id, p_media_file_id, v_media_version,
      p_media_size, p_total_bytes, p_upload_body, v_fence, p_session_expires_at,
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

COMMENT ON FUNCTION public.admit_youtube_upload(uuid, uuid, uuid, uuid, bigint, bigint, jsonb, timestamptz, uuid[], timestamptz) IS
  'Admits one YouTube upload: the private session and the public pending '
  'platform_posts row are created in ONE transaction, before the provider is '
  'contacted. Refuses a post, account or media file that is not the owner''s, '
  'and a post whose live content changed while the upload was in flight. '
  'Reopens an expired session ONLY when the record proves that no byte ever '
  'reached the provider; otherwise the session is marked for manual '
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
  IF v_session.state = 'uploaded' THEN
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

  -- A session that has been continued too many times is not asked again.
  IF v_session.continuation_count >= 24 THEN
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
CREATE OR REPLACE FUNCTION public.checkpoint_youtube_upload_session(
  p_session_id uuid,
  p_lease_token uuid,
  p_confirmed_bytes bigint,
  p_bytes_sent bigint,
  p_session_uri text DEFAULT NULL,
  p_video_may_exist boolean DEFAULT NULL,
  p_next_check_at timestamptz DEFAULT NULL,
  p_last_outcome text DEFAULT NULL
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

  UPDATE public.youtube_upload_sessions
     SET confirmed_bytes = greatest(v_session.confirmed_bytes, coalesce(p_confirmed_bytes, v_session.confirmed_bytes)),
         bytes_sent = greatest(v_session.bytes_sent, coalesce(p_bytes_sent, v_session.bytes_sent)),
         session_uri = coalesce(p_session_uri, v_session.session_uri),
         -- The uncertainty only ever grows here.
         video_may_exist = v_session.video_may_exist OR coalesce(p_video_may_exist, false),
         next_check_at = coalesce(p_next_check_at, v_session.next_check_at),
         last_outcome = coalesce(p_last_outcome, v_session.last_outcome),
         updated_at = clock_timestamp()
   WHERE id = v_session.id;
  RETURN true;
END;
$$;

COMMENT ON FUNCTION public.checkpoint_youtube_upload_session(uuid, uuid, bigint, bigint, text, boolean, timestamptz, text) IS
  'Records the confirmed byte offset, the highest byte ever written, whether '
  'the provider may already have turned the upload into a video and, when the '
  'provider just issued a session, the session URI. The offsets only grow, and '
  'the uncertainty that a video may exist is never cleared here. Refuses a '
  'worker whose lease is stale.';

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
         lease_token = NULL,
         lease_expires_at = NULL,
         updated_at = clock_timestamp()
   WHERE id = v_session.id;
  RETURN true;
END;
$$;

COMMENT ON FUNCTION public.complete_youtube_upload_session(uuid, uuid, text) IS
  'Records the video id the provider returned. It is kept, and the session '
  'URI is dropped with it. Idempotent for the same video id, and refuses a '
  'worker whose lease is stale.';

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

  SELECT * INTO v_session FROM public.youtube_upload_sessions WHERE id = p_session_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'YUS08: the session is not there' USING ERRCODE = 'YUS08';
  END IF;

  -- The worker must still own the session.
  IF v_session.lease_token IS DISTINCT FROM p_lease_token
     OR v_session.lease_expires_at IS NULL
     OR v_session.lease_expires_at <= now() THEN
    RAISE EXCEPTION 'YUS09: the lease is stale, so this worker does not own the session' USING ERRCODE = 'YUS09';
  END IF;

  -- The session must still belong to the attempt that is running.
  SELECT * INTO v_post FROM public.posts WHERE id = v_session.post_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'YUS01: the post is gone' USING ERRCODE = 'YUS01';
  END IF;
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
    coalesce(p_response_data, '{}'::jsonb)
  );

  v_video_may_exist := v_session.video_may_exist OR (p_status = 'success');

  UPDATE public.youtube_upload_sessions
     SET state = CASE WHEN p_status = 'success' THEN 'uploaded'
                      WHEN v_video_may_exist THEN 'reconcile'
                      ELSE 'failed' END,
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
BEGIN
  IF p_session_id IS NULL THEN
    RAISE EXCEPTION 'YUS01: the session is required' USING ERRCODE = 'YUS01';
  END IF;

  SELECT * INTO v_session FROM public.youtube_upload_sessions WHERE id = p_session_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'YUS08: the session is not there' USING ERRCODE = 'YUS08';
  END IF;

  IF v_session.state <> 'uploaded' OR v_session.video_id IS NULL THEN
    RAISE EXCEPTION 'YUS05: there is no receipt to project' USING ERRCODE = 'YUS05';
  END IF;

  IF v_session.platform_post_id IS NULL THEN
    RAISE EXCEPTION 'YUS14: the session has no public row to settle' USING ERRCODE = 'YUS14';
  END IF;

  SELECT * INTO v_row FROM public.platform_posts WHERE id = v_session.platform_post_id FOR UPDATE;

  -- The row is already settled with the same video: the same answer, kept.
  IF v_row.status = 'success' AND v_row.platform_post_id = v_session.video_id THEN
    RETURN jsonb_build_object('settled', true, 'already', true, 'platform_post_id', v_row.id);
  END IF;
  IF v_row.status IN ('success', 'failed') THEN
    -- The row says something else. A second settlement is never forced.
    RETURN jsonb_build_object('settled', false, 'already', true, 'platform_post_id', v_row.id);
  END IF;

  SELECT * INTO v_post FROM public.posts WHERE id = v_session.post_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'YUS01: the post is gone' USING ERRCODE = 'YUS01';
  END IF;
  IF v_session.attempt_started_at IS NOT NULL
     AND v_post.processing_started_at IS DISTINCT FROM v_session.attempt_started_at THEN
    RAISE EXCEPTION 'YUS11: the upload belongs to an older attempt of the post' USING ERRCODE = 'YUS11';
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
         lease_token = NULL,
         lease_expires_at = NULL,
         updated_at = clock_timestamp()
   WHERE id = v_session.id;
  RETURN true;
END;
$$;

COMMENT ON FUNCTION public.release_youtube_upload_session(uuid, uuid, text, text) IS
  'Records a terminal state that is not a receipt: the provider session is '
  'gone, the provider may hold a video nobody has a receipt for, or the '
  'provider refused for good. Never takes back a receipt. Refuses a worker '
  'whose lease is stale.';

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
BEGIN
  IF p_lease_ms IS NULL OR p_lease_ms <= 0 OR p_lease_ms > 3600000 THEN
    RAISE EXCEPTION 'YUS09: the lease length is not usable' USING ERRCODE = 'YUS09';
  END IF;
  v_lease := make_interval(secs => (p_lease_ms::double precision / 1000.0));

  -- The provider session is gone and a byte reached the provider: the
  -- provider may already hold a video, so only a human may decide.
  --
  -- A worker that still holds the lease is NOT touched: it may be writing
  -- right now, and taking the session away from it would let two workers
  -- write the same upload.
  UPDATE public.youtube_upload_sessions s
     SET state = 'reconcile',
         error = coalesce(s.error, 'the provider session expired after bytes were written'),
         lease_token = NULL, lease_expires_at = NULL,
         updated_at = clock_timestamp()
   WHERE s.state = 'open'
     AND s.session_uri IS NOT NULL
     AND s.session_expires_at IS NOT NULL
     AND s.session_expires_at <= now()
     AND (s.video_may_exist OR s.bytes_sent > 0)
     AND (s.lease_expires_at IS NULL OR s.lease_expires_at <= now());

  -- The provider session is gone and no byte ever reached it: no video can
  -- exist, so the upload is admitted again from the start.
  UPDATE public.youtube_upload_sessions s
     SET state = 'open', session_uri = NULL, confirmed_bytes = 0, bytes_sent = 0,
         session_expires_at = NULL, error = NULL,
         next_check_at = NULL, last_outcome = NULL,
         updated_at = clock_timestamp()
   WHERE s.state = 'open'
     AND s.session_uri IS NOT NULL
     AND s.session_expires_at IS NOT NULL
     AND s.session_expires_at <= now()
     AND NOT s.video_may_exist
     AND s.bytes_sent = 0
     AND (s.lease_expires_at IS NULL OR s.lease_expires_at <= now());

  -- A session that has been continued too many times is not asked again. It
  -- is marked for a human, because it may already hold a video.
  --
  -- A worker that still holds the lease keeps it: the mark waits until the
  -- lease is gone, so the public outcome is only projected once nobody is
  -- working on the session any more.
  UPDATE public.youtube_upload_sessions s
     SET state = 'reconcile',
         error = coalesce(s.error, 'the upload was continued too many times'),
         lease_token = NULL, lease_expires_at = NULL,
         updated_at = clock_timestamp()
   WHERE s.state = 'open'
     AND s.session_uri IS NOT NULL
     AND s.continuation_count >= p_max_continuations
     AND (s.next_check_at IS NULL OR s.next_check_at <= now())
     AND (s.lease_expires_at IS NULL OR s.lease_expires_at <= now());

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
  'nor deleted.';

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
      PERFORM public.partner_settle_platform_post(
        NULL, v_post.id, v_account.id, v_account.platform, 'failed',
        NULL, NULL, v_message, jsonb_build_object('swept_at', now())
      );
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
  'provider session may already hold a video.';

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
BEGIN
  p_limit := least(5, greatest(0, coalesce(p_limit, 5)));
  p_lease := interval '3 minutes';
  -- Step 1: Claim due deferred publishes / image rows using existing claim_deferred_publishes
  FOR v_rec IN
    SELECT cdp.platform_post_id, cdp.post_id
      FROM public.claim_deferred_publishes(p_limit, p_lease) cdp
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
         LIMIT v_remaining
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
  v_remaining := p_limit - v_claimed_count;
  IF v_remaining > 0 THEN
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
END;
$$;

COMMENT ON FUNCTION public.claim_post_completion_work(integer, interval) IS
  'The reconciler''s one bounded claim surface. It hands out the deferred '
  'Meta containers, the ready legacy notification candidates, and the YouTube '
  'upload sessions that are due for another look. Every kind draws from the '
  'same limit.';

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
  public.admit_youtube_upload(uuid, uuid, uuid, uuid, bigint, bigint, jsonb, timestamptz, uuid[], timestamptz),
  public.claim_youtube_upload_session(uuid, uuid, bigint),
  public.checkpoint_youtube_upload_session(uuid, uuid, bigint, bigint, text, boolean, timestamptz, text),
  public.complete_youtube_upload_session(uuid, uuid, text),
  public.settle_youtube_upload_session(uuid, uuid, text, text, text, jsonb),
  public.project_youtube_upload_receipt(uuid),
  public.release_youtube_upload_session(uuid, uuid, text, text),
  public.claim_youtube_upload_sessions(integer, bigint, integer)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.admit_youtube_upload(uuid, uuid, uuid, uuid, bigint, bigint, jsonb, timestamptz, uuid[], timestamptz),
  public.claim_youtube_upload_session(uuid, uuid, bigint),
  public.checkpoint_youtube_upload_session(uuid, uuid, bigint, bigint, text, boolean, timestamptz, text),
  public.complete_youtube_upload_session(uuid, uuid, text),
  public.settle_youtube_upload_session(uuid, uuid, text, text, text, jsonb),
  public.project_youtube_upload_receipt(uuid),
  public.release_youtube_upload_session(uuid, uuid, text, text),
  public.claim_youtube_upload_sessions(integer, bigint, integer)
  TO service_role;

REVOKE ALL ON FUNCTION public.request_post_retry(uuid, uuid, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.request_post_retry(uuid, uuid, uuid[]) TO service_role;

REVOKE ALL ON FUNCTION public.claim_post_completion_work(integer, interval) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_post_completion_work(integer, interval) TO service_role;

REVOKE ALL ON FUNCTION public.sweep_stale_processing_posts(interval) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sweep_stale_processing_posts(interval) TO service_role;
