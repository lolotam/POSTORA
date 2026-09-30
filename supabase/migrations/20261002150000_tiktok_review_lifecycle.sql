-- TikTok review workspace, slice S0: drafts, submissions, webhook dedupe.
--
-- WHY these tables exist instead of reusing posts from the start: a posts row
-- is already load-bearing infrastructure. Inserting one charges the post-quota
-- trigger, fires post.scheduled partner events, and makes the row visible to
-- the process-scheduled-posts scheduler. A review draft must be none of those:
-- it is private scratch state that becomes a post only when the user explicitly
-- consents. tiktok_review_submit() converts exactly the locked revision into an
-- ordinary posts row (source='tiktok_review') so the existing claim, dispatch,
-- settle, history and scheduler machinery is reused unchanged. The submission
-- row is the consent receipt (who, which account, which revision, which media,
-- which settings, which publish time); dispatch reads it, never handler input.
-- Webhook events are deduplicated structurally because TikTok retries delivery
-- for 72h. Tenancy is structural (composite FKs on (id, user_id)), never RLS,
-- because every writer here runs as service role, where RLS enforces nothing.

BEGIN;

-- ---------------------------------------------------------------------------
-- Tables (additive only; re-running this migration is a no-op)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.tiktok_review_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  social_account_id uuid NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  state text NOT NULL DEFAULT 'pending_review'
    CHECK (state IN ('pending_review', 'rejected', 'archived', 'submitted')),
  caption text NOT NULL DEFAULT '',
  media_file_id uuid NULL,
  media_duration_sec numeric NULL CHECK (media_duration_sec > 0),
  settings jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(settings) = 'object'),
  rejection_reason text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tiktok_review_drafts_id_user_key UNIQUE (id, user_id),
  CONSTRAINT tiktok_review_drafts_account_fkey
    FOREIGN KEY (social_account_id, user_id)
    REFERENCES public.social_accounts (id, user_id)
    ON DELETE CASCADE,
  CONSTRAINT tiktok_review_drafts_media_fkey
    FOREIGN KEY (media_file_id, user_id)
    REFERENCES public.media_files (id, user_id)
    ON DELETE SET NULL (media_file_id)
);

CREATE TABLE IF NOT EXISTS public.tiktok_review_submissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  draft_id uuid NOT NULL,
  user_id uuid NOT NULL,
  social_account_id uuid NOT NULL,
  revision integer NOT NULL,
  request_id uuid NOT NULL,
  post_id uuid NOT NULL REFERENCES public.posts (id) ON DELETE CASCADE,
  mode text NOT NULL CHECK (mode IN ('now', 'scheduled')),
  scheduled_at timestamptz NULL,
  time_zone text NOT NULL,
  snapshot jsonb NOT NULL,
  consented_at timestamptz NOT NULL,
  -- WHY 'publishing' exists: 'publishing' is set by process-post in ONE atomic
  -- UPDATE immediately before it calls TikTok's init, only from 'dispatching' or
  -- 'scheduled' and only while provider_publish_id IS NULL, so a second
  -- process-post invocation for the same review post (History retry, "Publish now",
  -- a concurrent scheduler run) cannot claim it and cannot publish the video twice.
  dispatch_state text NOT NULL CHECK (dispatch_state IN
    ('scheduled', 'pending_dispatch', 'dispatching', 'publishing', 'dispatched', 'unknown', 'needs_attention')),
  provider_publish_id text NULL,
  last_status_check_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tiktok_review_submissions_draft_revision_key UNIQUE (draft_id, revision),
  CONSTRAINT tiktok_review_submissions_user_request_key UNIQUE (user_id, request_id),
  CONSTRAINT tiktok_review_submissions_schedule_shape_check
    CHECK ((mode = 'scheduled') = (scheduled_at IS NOT NULL)),
  CONSTRAINT tiktok_review_submissions_draft_fkey
    FOREIGN KEY (draft_id, user_id)
    REFERENCES public.tiktok_review_drafts (id, user_id)
    ON DELETE CASCADE,
  CONSTRAINT tiktok_review_submissions_account_fkey
    FOREIGN KEY (social_account_id, user_id)
    REFERENCES public.social_accounts (id, user_id)
    ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS public.tiktok_webhook_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event text NOT NULL,
  user_openid text NOT NULL,
  publish_id text NOT NULL,
  provider_post_id text NULL,
  reason text NULL,
  create_time bigint NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  applied_at timestamptz NULL,
  CONSTRAINT tiktok_webhook_events_dedupe_key UNIQUE (event, publish_id, create_time)
);

CREATE INDEX IF NOT EXISTS idx_tiktok_review_drafts_queue
  ON public.tiktok_review_drafts (user_id, social_account_id, state, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_tiktok_review_submissions_publish_id
  ON public.tiktok_review_submissions (provider_publish_id)
  WHERE provider_publish_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tiktok_review_submissions_post_id
  ON public.tiktok_review_submissions (post_id);
CREATE INDEX IF NOT EXISTS idx_tiktok_webhook_events_unapplied
  ON public.tiktok_webhook_events (publish_id)
  WHERE applied_at IS NULL;

-- ---------------------------------------------------------------------------
-- RLS + grants. Browser roles can only SELECT their own drafts/submissions;
-- every write goes through the service-role RPCs below. Webhook events are
-- service-role only (no policies at all).
-- ---------------------------------------------------------------------------

ALTER TABLE public.tiktok_review_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tiktok_review_submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tiktok_webhook_events ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'tiktok_review_drafts'
      AND policyname = 'tiktok_review_drafts_select_own'
  ) THEN
    CREATE POLICY tiktok_review_drafts_select_own
      ON public.tiktok_review_drafts
      FOR SELECT TO authenticated
      USING (user_id = auth.uid());
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'tiktok_review_submissions'
      AND policyname = 'tiktok_review_submissions_select_own'
  ) THEN
    CREATE POLICY tiktok_review_submissions_select_own
      ON public.tiktok_review_submissions
      FOR SELECT TO authenticated
      USING (user_id = auth.uid());
  END IF;
END $$;

-- Supabase default privileges grant ALL on new tables to anon/authenticated;
-- revoke everything, then give back only the owner-scoped SELECT.
REVOKE ALL ON public.tiktok_review_drafts FROM anon, authenticated;
GRANT SELECT ON public.tiktok_review_drafts TO authenticated;
GRANT ALL ON public.tiktok_review_drafts TO service_role;

REVOKE ALL ON public.tiktok_review_submissions FROM anon, authenticated;
GRANT SELECT ON public.tiktok_review_submissions TO authenticated;
GRANT ALL ON public.tiktok_review_submissions TO service_role;

REVOKE ALL ON public.tiktok_webhook_events FROM anon, authenticated;
GRANT ALL ON public.tiktok_webhook_events TO service_role;

DROP TRIGGER IF EXISTS trg_tiktok_review_drafts_updated_at ON public.tiktok_review_drafts;
CREATE TRIGGER trg_tiktok_review_drafts_updated_at
  BEFORE UPDATE ON public.tiktok_review_drafts
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

-- The status reader writes only last_status_check_at to throttle provider
-- polls. updated_at is the clock for the orphan and dispatch staleness windows,
-- so that throttling write must not move it, or those windows never mature.
CREATE OR REPLACE FUNCTION public.tiktok_review_submissions_touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF (to_jsonb(NEW) - 'last_status_check_at' - 'updated_at')
     IS DISTINCT FROM (to_jsonb(OLD) - 'last_status_check_at' - 'updated_at') THEN
    NEW.updated_at := now();
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.tiktok_review_submissions_touch_updated_at()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_tiktok_review_submissions_updated_at ON public.tiktok_review_submissions;
CREATE TRIGGER trg_tiktok_review_submissions_updated_at
  BEFORE UPDATE ON public.tiktok_review_submissions
  FOR EACH ROW
  EXECUTE FUNCTION public.tiktok_review_submissions_touch_updated_at();

-- ---------------------------------------------------------------------------
-- RPCs. All SECURITY INVOKER with a controlled search_path; EXECUTE is
-- revoked from every browser role and granted only to service_role, so the
-- tiktok-review / tiktok-webhook / process-post handlers are the sole callers
-- and every ownership check below runs server-side. Errors are bare codes
-- (ERRCODE P0001); callers match on the message text.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.tiktok_review_create_draft(
  p_user_id uuid,
  p_social_account_id uuid
)
RETURNS public.tiktok_review_drafts
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_draft public.tiktok_review_drafts%ROWTYPE;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.social_accounts sa
    WHERE sa.id = p_social_account_id
      AND sa.user_id = p_user_id
      AND sa.platform = 'tiktok'
      AND sa.is_active
  ) THEN
    RAISE EXCEPTION 'TIKTOK_REVIEW_ACCOUNT_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.tiktok_review_drafts (user_id, social_account_id)
  VALUES (p_user_id, p_social_account_id)
  RETURNING * INTO v_draft;

  RETURN v_draft;
END;
$$;

REVOKE ALL ON FUNCTION public.tiktok_review_create_draft(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tiktok_review_create_draft(uuid, uuid)
  TO service_role;

CREATE OR REPLACE FUNCTION public.tiktok_review_save_draft(
  p_user_id uuid,
  p_draft_id uuid,
  p_expected_revision integer,
  p_caption text,
  p_media_file_id uuid,
  p_media_duration_sec numeric,
  p_settings jsonb
)
RETURNS public.tiktok_review_drafts
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_draft public.tiktok_review_drafts%ROWTYPE;
BEGIN
  SELECT * INTO v_draft
  FROM public.tiktok_review_drafts d
  WHERE d.id = p_draft_id AND d.user_id = p_user_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'TIKTOK_REVIEW_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  IF v_draft.revision <> p_expected_revision THEN
    RAISE EXCEPTION 'TIKTOK_REVIEW_REVISION_CONFLICT' USING ERRCODE = 'P0001';
  END IF;
  IF v_draft.state NOT IN ('pending_review', 'rejected') THEN
    RAISE EXCEPTION 'TIKTOK_REVIEW_INVALID_STATE' USING ERRCODE = 'P0001';
  END IF;

  -- The composite FK is the structural backstop that refuses another user's
  -- media even under the service role; the tiktok-review handler additionally
  -- pre-checks ownership and file_type='video' so the user gets a precise error.
  UPDATE public.tiktok_review_drafts
  SET caption = p_caption,
      media_file_id = p_media_file_id,
      media_duration_sec = p_media_duration_sec,
      settings = p_settings,
      state = 'pending_review',
      rejection_reason = NULL,
      revision = v_draft.revision + 1
  WHERE id = p_draft_id AND user_id = p_user_id
  RETURNING * INTO v_draft;

  RETURN v_draft;
END;
$$;

REVOKE ALL ON FUNCTION public.tiktok_review_save_draft(uuid, uuid, integer, text, uuid, numeric, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tiktok_review_save_draft(uuid, uuid, integer, text, uuid, numeric, jsonb)
  TO service_role;

CREATE OR REPLACE FUNCTION public.tiktok_review_transition(
  p_user_id uuid,
  p_draft_id uuid,
  p_expected_revision integer,
  p_action text,
  p_reason text
)
RETURNS public.tiktok_review_drafts
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_draft public.tiktok_review_drafts%ROWTYPE;
  v_submission public.tiktok_review_submissions%ROWTYPE;
  v_reason text;
BEGIN
  SELECT * INTO v_draft
  FROM public.tiktok_review_drafts d
  WHERE d.id = p_draft_id AND d.user_id = p_user_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'TIKTOK_REVIEW_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  IF v_draft.revision <> p_expected_revision THEN
    RAISE EXCEPTION 'TIKTOK_REVIEW_REVISION_CONFLICT' USING ERRCODE = 'P0001';
  END IF;

  IF p_action = 'reject' THEN
    IF v_draft.state <> 'pending_review' THEN
      RAISE EXCEPTION 'TIKTOK_REVIEW_INVALID_STATE' USING ERRCODE = 'P0001';
    END IF;
    v_reason := btrim(p_reason);
    IF v_reason IS NULL OR v_reason = '' THEN
      RAISE EXCEPTION 'TIKTOK_REVIEW_REASON_REQUIRED' USING ERRCODE = 'P0001';
    END IF;
    UPDATE public.tiktok_review_drafts
    SET state = 'rejected',
        rejection_reason = v_reason,
        revision = v_draft.revision + 1
    WHERE id = p_draft_id AND user_id = p_user_id
    RETURNING * INTO v_draft;
  ELSIF p_action = 'archive' THEN
    IF v_draft.state NOT IN ('pending_review', 'rejected') THEN
      RAISE EXCEPTION 'TIKTOK_REVIEW_INVALID_STATE' USING ERRCODE = 'P0001';
    END IF;
    UPDATE public.tiktok_review_drafts
    SET state = 'archived',
        revision = v_draft.revision + 1
    WHERE id = p_draft_id AND user_id = p_user_id
    RETURNING * INTO v_draft;
  ELSIF p_action = 'restore' THEN
    IF v_draft.state <> 'archived' THEN
      RAISE EXCEPTION 'TIKTOK_REVIEW_INVALID_STATE' USING ERRCODE = 'P0001';
    END IF;
    UPDATE public.tiktok_review_drafts
    SET state = 'pending_review',
        revision = v_draft.revision + 1
    WHERE id = p_draft_id AND user_id = p_user_id
    RETURNING * INTO v_draft;
  ELSIF p_action = 'reopen' THEN
    -- Reopening is safe only when nothing reached TikTok (process-post records
    -- the publish id before uploading), or TikTok itself reported the attempt
    -- FAILED. Anything pending or live on TikTok must be checked there first.
    IF v_draft.state <> 'submitted' THEN
      RAISE EXCEPTION 'TIKTOK_REVIEW_INVALID_STATE' USING ERRCODE = 'P0001';
    END IF;
    SELECT * INTO v_submission
    FROM public.tiktok_review_submissions s
    WHERE s.draft_id = v_draft.id AND s.user_id = p_user_id
    ORDER BY s.created_at DESC, s.revision DESC
    LIMIT 1;
    IF FOUND THEN
      IF EXISTS (
        SELECT 1 FROM public.platform_posts pp
        WHERE pp.post_id = v_submission.post_id
          AND pp.platform = 'tiktok'
          AND pp.status IN ('pending', 'success')
      ) THEN
        RAISE EXCEPTION 'TIKTOK_REVIEW_INVALID_STATE' USING ERRCODE = 'P0001';
      END IF;
      IF v_submission.provider_publish_id IS NOT NULL THEN
        IF NOT EXISTS (
          SELECT 1 FROM public.platform_posts pp
          WHERE pp.post_id = v_submission.post_id
            AND pp.platform = 'tiktok'
            AND pp.status = 'failed'
        ) THEN
          RAISE EXCEPTION 'TIKTOK_REVIEW_INVALID_STATE' USING ERRCODE = 'P0001';
        END IF;
      ELSIF v_submission.dispatch_state NOT IN ('needs_attention', 'dispatched', 'unknown')
         OR (v_submission.dispatch_state = 'unknown'
             AND v_submission.updated_at >= now() - interval '10 minutes') THEN
        RAISE EXCEPTION 'TIKTOK_REVIEW_INVALID_STATE' USING ERRCODE = 'P0001';
      END IF;
    END IF;
    UPDATE public.tiktok_review_drafts
    SET state = 'pending_review',
        revision = v_draft.revision + 1
    WHERE id = p_draft_id AND user_id = p_user_id
    RETURNING * INTO v_draft;
  ELSE
    RAISE EXCEPTION 'TIKTOK_REVIEW_INVALID_STATE' USING ERRCODE = 'P0001';
  END IF;

  RETURN v_draft;
END;
$$;

REVOKE ALL ON FUNCTION public.tiktok_review_transition(uuid, uuid, integer, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tiktok_review_transition(uuid, uuid, integer, text, text)
  TO service_role;

CREATE OR REPLACE FUNCTION public.tiktok_review_submit(
  p_user_id uuid,
  p_draft_id uuid,
  p_expected_revision integer,
  p_request_id uuid,
  p_mode text,
  p_scheduled_at timestamptz,
  p_time_zone text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_existing public.tiktok_review_submissions%ROWTYPE;
  v_draft public.tiktok_review_drafts%ROWTYPE;
  v_settings jsonb;
  v_disclose boolean;
  v_your_brand boolean;
  v_branded_content boolean;
  v_submission_id uuid;
  v_post_id uuid;
  v_dispatch_state text;
  v_post_status text;
  v_metadata jsonb;
BEGIN
  -- 1. Idempotent replay: the same user + request_id returns the original
  -- submission, never a second post.
  SELECT * INTO v_existing
  FROM public.tiktok_review_submissions s
  WHERE s.user_id = p_user_id AND s.request_id = p_request_id;
  IF FOUND THEN
    IF v_existing.draft_id <> p_draft_id THEN
      RAISE EXCEPTION 'TIKTOK_REVIEW_REQUEST_REUSED' USING ERRCODE = 'P0001';
    END IF;
    RETURN jsonb_build_object(
      'submission_id', v_existing.id,
      'post_id', v_existing.post_id,
      'mode', v_existing.mode,
      'scheduled_at', v_existing.scheduled_at,
      'dispatch_state', v_existing.dispatch_state,
      'created', false
    );
  END IF;

  -- 2. Lock the draft and validate the transition.
  SELECT * INTO v_draft
  FROM public.tiktok_review_drafts d
  WHERE d.id = p_draft_id AND d.user_id = p_user_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'TIKTOK_REVIEW_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  IF v_draft.revision <> p_expected_revision THEN
    RAISE EXCEPTION 'TIKTOK_REVIEW_REVISION_CONFLICT' USING ERRCODE = 'P0001';
  END IF;
  -- A concurrent call with the same request_id may have committed while this
  -- one waited on the row lock; replay its result instead of refusing.
  SELECT * INTO v_existing
  FROM public.tiktok_review_submissions s
  WHERE s.user_id = p_user_id AND s.request_id = p_request_id;
  IF FOUND THEN
    IF v_existing.draft_id <> p_draft_id THEN
      RAISE EXCEPTION 'TIKTOK_REVIEW_REQUEST_REUSED' USING ERRCODE = 'P0001';
    END IF;
    RETURN jsonb_build_object(
      'submission_id', v_existing.id,
      'post_id', v_existing.post_id,
      'mode', v_existing.mode,
      'scheduled_at', v_existing.scheduled_at,
      'dispatch_state', v_existing.dispatch_state,
      'created', false
    );
  END IF;
  IF v_draft.state <> 'pending_review' THEN
    RAISE EXCEPTION 'TIKTOK_REVIEW_INVALID_STATE' USING ERRCODE = 'P0001';
  END IF;
  IF v_draft.media_file_id IS NULL THEN
    RAISE EXCEPTION 'TIKTOK_REVIEW_MEDIA_REQUIRED' USING ERRCODE = 'P0001';
  END IF;
  IF p_mode = 'scheduled' THEN
    IF p_scheduled_at IS NULL OR p_scheduled_at <= now() THEN
      RAISE EXCEPTION 'TIKTOK_REVIEW_SCHEDULE_INVALID' USING ERRCODE = 'P0001';
    END IF;
  ELSIF p_mode = 'now' THEN
    IF p_scheduled_at IS NOT NULL THEN
      RAISE EXCEPTION 'TIKTOK_REVIEW_SCHEDULE_INVALID' USING ERRCODE = 'P0001';
    END IF;
  ELSE
    RAISE EXCEPTION 'TIKTOK_REVIEW_SCHEDULE_INVALID' USING ERRCODE = 'P0001';
  END IF;

  -- 3. Build the published snapshot from the locked draft row, not from
  -- handler input, so the published post is exactly the reviewed revision.
  v_settings := COALESCE(v_draft.settings, '{}'::jsonb);
  v_disclose := COALESCE(v_settings->'disclose' = 'true'::jsonb, false);
  v_your_brand := COALESCE(v_settings->'yourBrand' = 'true'::jsonb, false);
  v_branded_content := COALESCE(v_settings->'brandedContent' = 'true'::jsonb, false);

  -- gen_random_uuid() is built into pg_catalog (PG13+), which is always on
  -- the search path, so the pinned search_path needs no extensions schema.
  v_submission_id := gen_random_uuid();
  v_dispatch_state :=
    CASE WHEN p_mode = 'scheduled' THEN 'scheduled' ELSE 'pending_dispatch' END;
  v_post_status :=
    CASE WHEN p_mode = 'scheduled' THEN 'scheduled' ELSE 'pending' END;

  v_metadata := jsonb_build_object(
    'selected_account_ids', jsonb_build_array(v_draft.social_account_id),
    'schedule_timezone', p_time_zone,
    'tiktok_review_submission_id', v_submission_id,
    'tiktok_privacy_level', v_settings->>'privacy',
    'tiktok_title', v_draft.caption,
    'tiktok_allow_comment', COALESCE(v_settings->'allowComment' = 'true'::jsonb, false),
    'tiktok_allow_duet', COALESCE(v_settings->'allowDuet' = 'true'::jsonb, false),
    'tiktok_allow_stitch', COALESCE(v_settings->'allowStitch' = 'true'::jsonb, false),
    'tiktok_ai_generated', COALESCE(v_settings->'aiGenerated' = 'true'::jsonb, false),
    'tiktok_disclose_content', v_disclose,
    'tiktok_your_brand', (v_disclose AND v_your_brand),
    'tiktok_branded_content', (v_disclose AND v_branded_content)
  );

  INSERT INTO public.posts (
    user_id, caption, platforms, media_file_ids, status, scheduled_at,
    source, metadata
  ) VALUES (
    p_user_id,
    v_draft.caption,
    ARRAY['tiktok'],
    ARRAY[v_draft.media_file_id],
    v_post_status,
    p_scheduled_at,
    'tiktok_review',
    v_metadata
  )
  RETURNING id INTO v_post_id;

  -- 4. Consent receipt: bound to user, account, revision, media, settings and
  -- the requested publish time.
  INSERT INTO public.tiktok_review_submissions (
    id, draft_id, user_id, social_account_id, revision, request_id,
    post_id, mode, scheduled_at, time_zone, snapshot, consented_at, dispatch_state
  ) VALUES (
    v_submission_id,
    v_draft.id,
    p_user_id,
    v_draft.social_account_id,
    v_draft.revision,
    p_request_id,
    v_post_id,
    p_mode,
    p_scheduled_at,
    p_time_zone,
    jsonb_build_object(
      'caption', v_draft.caption,
      'media_file_id', v_draft.media_file_id,
      'media_duration_sec', v_draft.media_duration_sec,
      'settings', v_settings,
      'social_account_id', v_draft.social_account_id,
      'revision', v_draft.revision
    ),
    now(),
    v_dispatch_state
  );

  -- 5. The draft is consumed.
  UPDATE public.tiktok_review_drafts
  SET state = 'submitted'
  WHERE id = p_draft_id AND user_id = p_user_id;

  RETURN jsonb_build_object(
    'submission_id', v_submission_id,
    'post_id', v_post_id,
    'mode', p_mode,
    'scheduled_at', p_scheduled_at,
    'dispatch_state', v_dispatch_state,
    'created', true
  );
END;
$$;

REVOKE ALL ON FUNCTION public.tiktok_review_submit(uuid, uuid, integer, uuid, text, timestamptz, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tiktok_review_submit(uuid, uuid, integer, uuid, text, timestamptz, text)
  TO service_role;

CREATE OR REPLACE FUNCTION public.tiktok_review_set_dispatch_state(
  p_submission_id uuid,
  p_from text[],
  p_to text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE public.tiktok_review_submissions
  SET dispatch_state = p_to
  WHERE id = p_submission_id
    AND dispatch_state = ANY (p_from);
  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION public.tiktok_review_set_dispatch_state(uuid, text[], text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tiktok_review_set_dispatch_state(uuid, text[], text)
  TO service_role;

COMMIT;
