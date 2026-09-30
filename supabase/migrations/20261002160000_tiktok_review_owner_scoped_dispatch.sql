-- TikTok review: owner-scoped dispatch state and recoverable stranded dispatches.
--
-- Follows 20261002150000 (already applied in production). Every other review
-- RPC scopes its writes by user_id; tiktok_review_set_dispatch_state trusted a
-- caller-supplied submission id alone, so it now takes the owner as well.
-- The reopen rule additionally covers a submission whose first dispatch claim
-- failed (pending_dispatch, stale after 5 minutes) and any submission whose
-- TikTok row is 'failed' with nothing pending or live.

BEGIN;

-- DROP first: CREATE OR REPLACE with a new argument list would ADD an overload.
DROP FUNCTION IF EXISTS public.tiktok_review_set_dispatch_state(uuid, text[], text);

CREATE FUNCTION public.tiktok_review_set_dispatch_state(
  p_user_id uuid,
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
    AND user_id = p_user_id
    AND dispatch_state = ANY (p_from);
  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION public.tiktok_review_set_dispatch_state(uuid, uuid, text[], text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tiktok_review_set_dispatch_state(uuid, uuid, text[], text)
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
      -- A failed TikTok row means process-post finished this attempt without a
      -- live video (it fails before upload, or TikTok reported FAILED), so a new
      -- revision cannot duplicate anything, whatever dispatch_state says.
      IF NOT EXISTS (
        SELECT 1 FROM public.platform_posts pp
        WHERE pp.post_id = v_submission.post_id
          AND pp.platform = 'tiktok'
          AND pp.status = 'failed'
      ) THEN
        IF v_submission.provider_publish_id IS NOT NULL THEN
          RAISE EXCEPTION 'TIKTOK_REVIEW_INVALID_STATE' USING ERRCODE = 'P0001';
        END IF;
        -- No row and no publish id: only states in which process-post can no
        -- longer be running. pending_dispatch means the dispatch claim itself
        -- failed; it is stale after 5 minutes.
        IF NOT (
          v_submission.dispatch_state IN ('needs_attention', 'dispatched')
          OR (v_submission.dispatch_state = 'unknown'
              AND v_submission.updated_at < now() - interval '10 minutes')
          OR (v_submission.dispatch_state = 'pending_dispatch'
              AND v_submission.updated_at < now() - interval '5 minutes')
        ) THEN
          RAISE EXCEPTION 'TIKTOK_REVIEW_INVALID_STATE' USING ERRCODE = 'P0001';
        END IF;
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

COMMIT;
