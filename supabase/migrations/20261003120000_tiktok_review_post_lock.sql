-- TikTok review: keep a review post and its draft consistent (#246 items 1, 3 and 4).
--
-- Follows 20261002170000 (applied in production).
--
-- 1. A deleted post no longer strands its draft. Deleting a review post from Scheduled
--    Posts or History cascades away its submission, and the draft stayed 'submitted'
--    with nothing behind it: it could not be polled, reopened, edited or archived. An
--    AFTER DELETE trigger on submissions now hands the draft back -- to pending_review
--    when nothing reached TikTok, to archived when something may have.
--
-- 2. Once publishing has started, the post's target and content are locked. Calendar and
--    Scheduled Posts edit posts rows directly, and consent covered one account, one time
--    and one revision. process-post already refuses a changed post before it claims it
--    (SNAPSHOT_MISMATCH); this refuses the edit itself once the claim exists, so the
--    screen no longer shows a time or account that is not what TikTok received. A direct
--    delete is refused while the post is mid-publish -- of the post, and of its TikTok
--    platform_posts row, which History deletes first -- while cascades (account or user
--    deletion) still pass. A review post's source can never change, since the lock keys on it.
--
-- 3. The reopen rule moves into tiktok_review_reopen_allowed() so the workspace can ask it
--    before offering "Edit and resubmit". tiktok_review_transition keeps its exact
--    signature (CREATE OR REPLACE with the same arguments replaces, never overloads) and
--    calls the predicate instead of carrying its own copy.

BEGIN;

-- ---------------------------------------------------------------------------
-- 3. The reopen predicate: the rules of 20261002170000, unchanged.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.tiktok_review_reopen_allowed(
  p_user_id uuid,
  p_draft_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_state text;
  v_submission public.tiktok_review_submissions%ROWTYPE;
BEGIN
  SELECT d.state INTO v_state
  FROM public.tiktok_review_drafts d
  WHERE d.id = p_draft_id AND d.user_id = p_user_id;
  IF v_state IS DISTINCT FROM 'submitted' THEN
    RETURN false;
  END IF;

  SELECT * INTO v_submission
  FROM public.tiktok_review_submissions s
  WHERE s.draft_id = p_draft_id AND s.user_id = p_user_id
  ORDER BY s.created_at DESC, s.revision DESC
  LIMIT 1;
  IF NOT FOUND THEN
    RETURN true;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.platform_posts pp
    WHERE pp.post_id = v_submission.post_id
      AND pp.platform = 'tiktok'
      AND pp.status IN ('pending', 'success')
  ) THEN
    RETURN false;
  END IF;

  IF v_submission.provider_publish_id IS NOT NULL THEN
    -- Something reached TikTok. Only TikTok's signed post.publish.failed event for this
    -- publish id, from this account, proves the video is dead; a failed platform row may
    -- come from process-post's own poll or database write failing after the upload.
    RETURN EXISTS (
      SELECT 1
      FROM public.tiktok_webhook_events e
      JOIN public.social_accounts sa
        ON sa.id = v_submission.social_account_id AND sa.user_id = p_user_id
      WHERE e.publish_id = v_submission.provider_publish_id
        AND e.event = 'post.publish.failed'
        AND e.user_openid = sa.platform_user_id
    );
  END IF;

  -- Nothing reached TikTok. A failed row means process-post stopped before the upload.
  IF EXISTS (
    SELECT 1 FROM public.platform_posts pp
    WHERE pp.post_id = v_submission.post_id
      AND pp.platform = 'tiktok'
      AND pp.status = 'failed'
  ) THEN
    RETURN true;
  END IF;

  -- No row and no publish id: only states in which process-post can no longer be
  -- running. pending_dispatch means the dispatch claim itself failed; stale after 5 min.
  RETURN v_submission.dispatch_state IN ('needs_attention', 'dispatched')
    OR (v_submission.dispatch_state = 'unknown'
        AND v_submission.updated_at < now() - interval '10 minutes')
    OR (v_submission.dispatch_state = 'pending_dispatch'
        AND v_submission.updated_at < now() - interval '5 minutes');
END;
$$;

REVOKE ALL ON FUNCTION public.tiktok_review_reopen_allowed(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tiktok_review_reopen_allowed(uuid, uuid)
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
    -- The draft row is locked above, so the predicate reads a draft nobody can move.
    IF NOT public.tiktok_review_reopen_allowed(p_user_id, p_draft_id) THEN
      RAISE EXCEPTION 'TIKTOK_REVIEW_INVALID_STATE' USING ERRCODE = 'P0001';
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

-- ---------------------------------------------------------------------------
-- 1. A deleted submission hands its draft back.
-- ---------------------------------------------------------------------------

-- SECURITY DEFINER: a History delete runs as the signed-in user, who holds no UPDATE on
-- drafts; the cascade reaches this trigger under that role.
CREATE OR REPLACE FUNCTION public.tiktok_review_release_draft_on_submission_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- Only the draft still waiting on this exact submission. A reopened draft has moved to a
  -- later revision, and a cascade from the draft's own deletion finds no row to update.
  UPDATE public.tiktok_review_drafts d
  SET state = CASE
        WHEN OLD.provider_publish_id IS NULL
          AND OLD.dispatch_state IN ('scheduled', 'pending_dispatch', 'needs_attention')
        THEN 'pending_review'
        ELSE 'archived'
      END,
      revision = d.revision + 1
  WHERE d.id = OLD.draft_id
    AND d.user_id = OLD.user_id
    AND d.state = 'submitted'
    AND d.revision = OLD.revision;
  RETURN OLD;
END;
$$;

REVOKE ALL ON FUNCTION public.tiktok_review_release_draft_on_submission_delete()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_tiktok_review_release_draft ON public.tiktok_review_submissions;
CREATE TRIGGER trg_tiktok_review_release_draft
  AFTER DELETE ON public.tiktok_review_submissions
  FOR EACH ROW
  EXECUTE FUNCTION public.tiktok_review_release_draft_on_submission_delete();

-- ---------------------------------------------------------------------------
-- 2. Lock a review post once publishing has started.
-- ---------------------------------------------------------------------------

-- Mid-publish: process-post has claimed the submission and TikTok may be receiving the video.
CREATE OR REPLACE FUNCTION public.tiktok_review_post_in_flight(p_post_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.tiktok_review_submissions s
    WHERE s.post_id = p_post_id
      AND s.dispatch_state IN ('dispatching', 'publishing')
  );
$$;

REVOKE ALL ON FUNCTION public.tiktok_review_post_in_flight(uuid)
  FROM PUBLIC, anon, authenticated;

-- SECURITY DEFINER for the same reason as above: Calendar edits run as the signed-in user.
CREATE OR REPLACE FUNCTION public.tiktok_review_guard_post()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- A cascade (account or user deletion) runs nested in a referential trigger; only a
    -- direct delete of a post that is mid-publish is refused.
    IF pg_trigger_depth() = 1 AND public.tiktok_review_post_in_flight(OLD.id) THEN
      RAISE EXCEPTION 'This TikTok post is being published right now and can''t be deleted. Try again in a few minutes.'
        USING ERRCODE = 'P0001', DETAIL = 'TIKTOK_REVIEW_POST_LOCKED';
    END IF;
    RETURN OLD;
  END IF;

  -- The lock keys on source; changing it would switch the lock off for every later write.
  IF NEW.source IS DISTINCT FROM OLD.source THEN
    RAISE EXCEPTION 'A TikTok review post can''t be turned into another kind of post.'
      USING ERRCODE = 'P0001', DETAIL = 'TIKTOK_REVIEW_POST_LOCKED';
  END IF;

  -- The columns Calendar, Scheduled Posts and History retry write; status, posted_at and
  -- the rest of metadata stay free for process-post and the settle seam.
  IF NEW.scheduled_at IS DISTINCT FROM OLD.scheduled_at
    OR NEW.caption IS DISTINCT FROM OLD.caption
    OR NEW.platforms IS DISTINCT FROM OLD.platforms
    OR NEW.media_file_ids IS DISTINCT FROM OLD.media_file_ids
    OR NEW.metadata->'selected_account_ids' IS DISTINCT FROM OLD.metadata->'selected_account_ids'
  THEN
    IF EXISTS (
      SELECT 1 FROM public.tiktok_review_submissions s
      WHERE s.post_id = OLD.id
        AND (s.dispatch_state IN ('dispatching', 'publishing', 'dispatched', 'unknown')
             OR s.provider_publish_id IS NOT NULL)
    ) THEN
      RAISE EXCEPTION 'This TikTok post has already gone to TikTok, so its time, account and content can''t change. To post again, start a new draft in TikTok review.'
        USING ERRCODE = 'P0001', DETAIL = 'TIKTOK_REVIEW_POST_LOCKED';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.tiktok_review_guard_post()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_tiktok_review_guard_post_update ON public.posts;
CREATE TRIGGER trg_tiktok_review_guard_post_update
  BEFORE UPDATE ON public.posts
  FOR EACH ROW
  WHEN (OLD.source = 'tiktok_review')
  EXECUTE FUNCTION public.tiktok_review_guard_post();

DROP TRIGGER IF EXISTS trg_tiktok_review_guard_post_delete ON public.posts;
CREATE TRIGGER trg_tiktok_review_guard_post_delete
  BEFORE DELETE ON public.posts
  FOR EACH ROW
  WHEN (OLD.source = 'tiktok_review')
  EXECUTE FUNCTION public.tiktok_review_guard_post();

-- History deletes a post's platform_posts rows before the post itself, so refusing only the
-- post would leave the publishing record already gone.
CREATE OR REPLACE FUNCTION public.tiktok_review_guard_platform_post()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF pg_trigger_depth() = 1 AND public.tiktok_review_post_in_flight(OLD.post_id) THEN
    RAISE EXCEPTION 'This TikTok post is being published right now and can''t be deleted. Try again in a few minutes.'
      USING ERRCODE = 'P0001', DETAIL = 'TIKTOK_REVIEW_POST_LOCKED';
  END IF;
  RETURN OLD;
END;
$$;

REVOKE ALL ON FUNCTION public.tiktok_review_guard_platform_post()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_tiktok_review_guard_platform_post_delete ON public.platform_posts;
CREATE TRIGGER trg_tiktok_review_guard_platform_post_delete
  BEFORE DELETE ON public.platform_posts
  FOR EACH ROW
  WHEN (OLD.platform = 'tiktok')
  EXECUTE FUNCTION public.tiktok_review_guard_platform_post();

COMMIT;
