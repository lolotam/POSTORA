-- TikTok review: reopen after an upload only on TikTok's own FAILED report.
--
-- Follows 20261002160000 (applied in production). Its reopen rule accepted any
-- failed platform_posts row, but process-post writes one for local failures
-- too (a status poll or database write that throws after the upload), while
-- the recorded publish id may still go live. Reopening then let the user
-- publish the same video twice. Same signature, so CREATE OR REPLACE replaces
-- the function rather than adding an overload.

BEGIN;

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
    -- FAILED through its webhook. Anything else must be checked there first.
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
        -- Something reached TikTok. A failed platform row does not prove the
        -- video is dead: process-post also writes one when its own status poll
        -- or database write fails after the upload. Only TikTok's signed
        -- post.publish.failed event for this publish id, from this account,
        -- frees the draft.
        IF NOT EXISTS (
          SELECT 1
          FROM public.tiktok_webhook_events e
          JOIN public.social_accounts sa
            ON sa.id = v_submission.social_account_id AND sa.user_id = p_user_id
          WHERE e.publish_id = v_submission.provider_publish_id
            AND e.event = 'post.publish.failed'
            AND e.user_openid = sa.platform_user_id
        ) THEN
          RAISE EXCEPTION 'TIKTOK_REVIEW_INVALID_STATE' USING ERRCODE = 'P0001';
        END IF;
      -- Nothing reached TikTok. A failed row means process-post stopped before
      -- the upload, so a new revision cannot duplicate anything.
      ELSIF NOT EXISTS (
        SELECT 1 FROM public.platform_posts pp
        WHERE pp.post_id = v_submission.post_id
          AND pp.platform = 'tiktok'
          AND pp.status = 'failed'
      ) THEN
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
