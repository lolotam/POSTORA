-- The guarded restoration for the YouTube pending handoff.
--
-- WHY
-- ---
-- A YouTube upload settles its destination row through the fenced settlement,
-- and the parent rolls up as soon as that row is closed. The worker that made
-- the settlement may never learn that it landed: the answer can be lost
-- between the database and the client. The worker then hands the row to the
-- upload recovery as a PENDING destination, and the outer loop asks the
-- database to put the parent back into processing.
--
-- The old restoration cannot answer that question. It reads the attempt, the
-- content and the rollup provenance, and all three still match after the
-- settlement landed: the settlement did not change the attempt, and the rollup
-- it wrote IS the provenance. So it restores a parent that has already rolled
-- up, and the post stays in processing with no open destination under it.
-- Nothing will ever settle it again, because the row it was waiting for is
-- already closed.
--
-- WHAT
-- ---
-- This restoration therefore asks for the row the handoff believes to be
-- open, and restores the parent ONLY while that row is still pending. The
-- check and the restore happen in one transaction: the parent is locked
-- first and the row second, in the order the settlement locks them, so a
-- settlement cannot land between the check and the restore.
--
-- The old generic restoration is untouched. The Threads and the fan-out paths
-- keep it, because their handoff does not name a row: they restore a parent
-- that a SIBLING rolled up while their own destination was still open, and
-- that question cannot be asked with a row in hand.
--
-- The service role is the only caller. A browser role may not restore a
-- parent, and neither may it read the rows this function reads.

CREATE OR REPLACE FUNCTION public.restore_youtube_pending_post(
  p_post_id uuid,
  p_expected_processing_started_at timestamptz,
  p_expected_content jsonb,
  p_expected_platform_post_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_post public.posts%ROWTYPE;
  v_row public.platform_posts%ROWTYPE;
  v_content jsonb;
  v_has_success boolean;
  v_posted_at timestamptz;
BEGIN
  -- THE PARENT LOCK
  --
  -- The parent is locked FIRST, in the order partner_settle_platform_post
  -- locks it. The settlement needs the same lock before it may close the
  -- row, so a settlement cannot slip between the check and the restore.
  SELECT * INTO v_post
    FROM public.posts
   WHERE id = p_post_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('restored', false, 'reason', 'not_found');
  END IF;

  -- THE ROW IS PART OF THE QUESTION
  --
  -- Without the row there is nothing to check: a restoration that cannot see
  -- the destination it is restoring for is the old restoration.
  IF p_expected_platform_post_id IS NULL THEN
    RETURN jsonb_build_object('restored', false, 'reason', 'invalid_arguments', 'current_status', v_post.status);
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

  -- THE ATTEMPT AND THE CONTENT
  --
  -- The restoration is about THIS attempt of THIS post. A post that moved on
  -- is not restored by a worker that is behind.
  IF p_expected_processing_started_at IS NULL THEN
    RETURN jsonb_build_object('restored', false, 'reason', 'invalid_arguments', 'current_status', v_post.status);
  END IF;
  IF v_post.processing_started_at IS DISTINCT FROM p_expected_processing_started_at THEN
    RETURN jsonb_build_object('restored', false, 'reason', 'attempt_mismatch', 'current_status', v_post.status);
  END IF;
  IF v_content IS DISTINCT FROM jsonb_set(p_expected_content, '{metadata}',
       public.normalize_threads_internal_metadata(p_expected_content -> 'metadata'), true) THEN
    RETURN jsonb_build_object('restored', false, 'reason', 'content_mismatch', 'current_status', v_post.status);
  END IF;

  -- THE ROW LOCK
  --
  -- The row is locked SECOND, in the same order, so the answer below is the
  -- state of the row at the moment of the restore.
  SELECT * INTO v_row
    FROM public.platform_posts
   WHERE id = p_expected_platform_post_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('restored', false, 'reason', 'destination_not_found', 'current_status', v_post.status);
  END IF;
  IF v_row.post_id IS DISTINCT FROM p_post_id OR v_row.platform IS DISTINCT FROM 'youtube' THEN
    RETURN jsonb_build_object('restored', false, 'reason', 'destination_mismatch', 'current_status', v_post.status);
  END IF;

  -- THE GUARD
  --
  -- The row is not pending any more, so the handoff is a DUPLICATE: the
  -- settlement landed and only its answer was lost. The parent keeps the
  -- result it earned, and nothing is restored.
  IF v_row.status IS DISTINCT FROM 'pending' THEN
    RETURN jsonb_build_object(
      'restored', false,
      'reason', 'destination_not_pending',
      'destination_status', v_row.status,
      'current_status', v_post.status);
  END IF;

  -- A destination that already succeeded keeps its posted_at, even while the
  -- parent waits for the row that is still open. The database is asked, not
  -- the caller: the caller may not know about a destination that settled
  -- while it was working.
  v_has_success := EXISTS (
    SELECT 1 FROM public.platform_posts
     WHERE post_id = p_post_id AND status = 'success');
  v_posted_at := CASE WHEN v_has_success
                      THEN coalesce(v_post.posted_at, now())
                      ELSE v_post.posted_at END;

  IF v_post.status = 'processing' AND v_post.processing_started_at IS NOT DISTINCT FROM p_expected_processing_started_at THEN
    IF v_posted_at IS DISTINCT FROM v_post.posted_at THEN
      UPDATE public.posts
         SET posted_at = v_posted_at
       WHERE id = p_post_id;
    END IF;
    RETURN jsonb_build_object('restored', true, 'status', 'processing', 'already_processing', true);
  END IF;

  IF v_post.status NOT IN ('completed', 'failed') THEN
    RETURN jsonb_build_object('restored', false, 'reason', 'status_ineligible', 'current_status', v_post.status);
  END IF;

  -- THE ROLLUP PROVENANCE
  --
  -- Only a settlement of THIS attempt may have rolled the parent up. An
  -- owner who cancelled the post, or a newer attempt, strips or mismatches
  -- the provenance.
  IF NOT (v_post.metadata ? 'settlement_rollup_at') THEN
    RETURN jsonb_build_object('restored', false, 'reason', 'missing_rollup_provenance', 'current_status', v_post.status);
  END IF;

  IF (v_post.metadata ->> 'settlement_rollup_processing_started_at')::timestamptz IS DISTINCT FROM p_expected_processing_started_at
     OR (v_post.metadata ->> 'settlement_rollup_at')::timestamptz < p_expected_processing_started_at
     OR (v_post.metadata ->> 'settlement_rollup_status') IS DISTINCT FROM v_post.status THEN
    RETURN jsonb_build_object('restored', false, 'reason', 'rollup_attempt_mismatch', 'current_status', v_post.status);
  END IF;

  -- THE RESTORE
  --
  -- The row is still open, so the parent goes back to processing and the
  -- destination that owns the row finishes the work.
  UPDATE public.posts
     SET status = 'processing',
         posted_at = v_posted_at
   WHERE id = p_post_id;

  RETURN jsonb_build_object('restored', true, 'status', 'processing', 'prior_status', v_post.status);
END;
$$;

COMMENT ON FUNCTION public.restore_youtube_pending_post(uuid, timestamptz, jsonb, uuid) IS
  'Restores a YouTube parent to processing while the destination row the '
  'handoff names is STILL pending. A row that is no longer pending means the '
  'settlement landed and only its answer was lost, so the parent keeps the '
  'result it earned (reason destination_not_pending). Service role only.';

REVOKE ALL ON FUNCTION public.restore_youtube_pending_post(uuid, timestamptz, jsonb, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.restore_youtube_pending_post(uuid, timestamptz, jsonb, uuid) TO service_role;
