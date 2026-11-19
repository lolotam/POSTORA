-- ---------------------------------------------------------------------------
-- close_post_fanout: read every stored attempt timestamp through the
-- validating conversion
--
-- The deferred attempt a platform_posts row carries in
-- response_data.deferred.attempt_started_at, and the attempt the
-- legacy_notification_candidate carries in posts.metadata, were cast with a
-- bare ::timestamptz. A stored value that only LOOKS like a date -- an
-- impossible calendar date such as 2026-02-31T00:00:00Z -- raises
-- 'date/time field value out of range' and aborts the whole closure
-- statement, starving every session queued behind the poisoned row.
--
-- public.youtube_upload_safe_timestamptz (20261118240000) turns a malformed
-- value into NULL, and NULL makes the predicate a non-match instead of an
-- abort: the row belongs to no attempt, the candidate belongs to no
-- attempt, and every other refusal in the function is unchanged.
--
-- The body is otherwise identical to the latest definition
-- (20261117120000_threads_image_inline_completion.sql); signature, SECURITY
-- DEFINER, search_path, REVOKE and GRANT are repeated verbatim.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.close_post_fanout(
  p_post_id uuid,
  p_expected_processing_started_at timestamptz,
  p_expected_content jsonb,
  p_exact_platform_post_ids uuid[],
  p_retained_platform_post_ids uuid[]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_post public.posts%ROWTYPE;
  v_content jsonb;
  v_candidate jsonb;
  v_exact_count integer;
  v_pending_count integer;
  v_success_count integer;
  v_retained_count integer;
  v_status text;
  v_all_rows uuid[];
  v_expected_retained uuid[];
  v_target_ids uuid[];
  v_anchor_ids uuid[];
  v_frozen_ids uuid[];
  v_carried_ids uuid[];
  v_result_statuses jsonb;
  v_managed_image boolean;
BEGIN
  IF p_post_id IS NULL OR p_expected_processing_started_at IS NULL THEN
    RETURN jsonb_build_object('closed', false, 'error', 'invalid_arguments');
  END IF;

  SELECT * INTO v_post FROM public.posts WHERE id = p_post_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('closed', false, 'error', 'post_not_found');
  END IF;

  IF v_post.processing_started_at IS DISTINCT FROM p_expected_processing_started_at THEN
    RETURN jsonb_build_object('closed', false, 'error', 'attempt_mismatch');
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
    RETURN jsonb_build_object('closed', false, 'error', 'content_mismatch');
  END IF;

  v_candidate := v_post.metadata -> 'legacy_notification_candidate';
  IF v_candidate IS NULL
     OR public.youtube_upload_safe_timestamptz(v_candidate ->> 'attempt_started_at') IS DISTINCT FROM p_expected_processing_started_at THEN
    RETURN jsonb_build_object('closed', false, 'error', 'no_candidate_for_attempt');
  END IF;

  IF v_candidate ->> 'content_hash' IS DISTINCT FROM md5(v_content::text)
     OR coalesce((v_candidate ->> 'consumed')::boolean, false)
     OR NOT coalesce(v_post.status = 'processing' OR (
       v_post.status IN ('completed', 'failed')
       AND v_post.metadata ->> 'settlement_rollup_status' = v_post.status
       AND (v_post.metadata ->> 'settlement_rollup_processing_started_at')::timestamptz = p_expected_processing_started_at
     ), false) THEN
    RETURN jsonb_build_object('closed', false, 'error', 'candidate_authority_changed');
  END IF;
  IF v_post.metadata ? 'final_notification_intent' THEN
    RETURN jsonb_build_object('closed', false, 'error', 'managed_image_owner');
  END IF;
  SELECT EXISTS (
    SELECT 1 FROM public.platform_posts pp WHERE pp.post_id = p_post_id
      AND pp.response_data #>> '{deferred,kind}' = 'threads'
      AND pp.response_data #>> '{deferred,media_type}' = 'IMAGE'
      AND public.youtube_upload_safe_timestamptz(pp.response_data #>> '{deferred,attempt_started_at}') = p_expected_processing_started_at
  ) INTO v_managed_image;
  SELECT coalesce(array_agg(x::uuid ORDER BY x), ARRAY[]::uuid[]) INTO v_expected_retained
    FROM jsonb_array_elements_text(v_candidate -> 'retained_platform_post_ids') x;
  SELECT coalesce(array_agg(x::uuid), ARRAY[]::uuid[]) INTO v_target_ids
    FROM jsonb_array_elements_text(v_candidate -> 'target_account_ids') x;
  IF cardinality(v_target_ids) = 0 OR cardinality(p_exact_platform_post_ids) IS NULL
     OR cardinality(p_exact_platform_post_ids) = 0
     OR EXISTS (SELECT 1 FROM unnest(p_exact_platform_post_ids) x WHERE x IS NULL)
     OR cardinality(p_exact_platform_post_ids) <> (SELECT count(DISTINCT x) FROM unnest(p_exact_platform_post_ids) x)
     OR v_expected_retained IS DISTINCT FROM (
       SELECT coalesce(array_agg(x ORDER BY x::text), ARRAY[]::uuid[]) FROM unnest(coalesce(p_retained_platform_post_ids, ARRAY[]::uuid[])) x
     ) THEN
    RETURN jsonb_build_object('closed', false, 'error', 'result_scope_mismatch');
  END IF;
  -- Resolve the original worker's explicit carried-Story receipts on closure and
  -- every refresh, including a recorder's committed-but-unacknowledged insert.
  -- Existing-row recorder replays need not settle again to authorize this result.
  SELECT coalesce(array_agg(x::uuid), ARRAY[]::uuid[]) INTO v_frozen_ids
    FROM jsonb_array_elements_text(v_candidate -> 'exact_platform_post_ids') x;
  IF v_candidate ->> 'fanout_closed' = 'true' THEN
    SELECT coalesce(array_agg(x::uuid), ARRAY[]::uuid[]) INTO v_anchor_ids
      FROM jsonb_array_elements_text(v_candidate -> 'original_platform_post_ids') x;
    IF cardinality(v_anchor_ids) = 0 THEN
      RETURN jsonb_build_object('closed', false, 'error', 'original_scope_unavailable');
    END IF;
  ELSE
    v_anchor_ids := p_exact_platform_post_ids;
    v_frozen_ids := p_exact_platform_post_ids;
  END IF;
  -- Derived successes are results only; they never become original carrier authority.
  v_candidate := v_candidate || jsonb_build_object('original_platform_post_ids', to_jsonb(v_anchor_ids));
  PERFORM anchor.id FROM public.platform_posts anchor WHERE anchor.id = ANY(v_anchor_ids)
    ORDER BY anchor.id FOR UPDATE;
  SELECT coalesce(array_agg(DISTINCT story.id), ARRAY[]::uuid[]) INTO v_carried_ids
    FROM public.platform_posts anchor
    JOIN public.platform_posts story ON story.post_id = anchor.post_id
      AND story.social_account_id = anchor.social_account_id
      AND story.platform_post_id = anchor.response_data #>> '{unrecorded_story,id}'
    JOIN public.social_accounts account ON account.id = story.social_account_id
   WHERE anchor.id = ANY(v_anchor_ids) AND anchor.post_id = p_post_id
     AND anchor.platform = 'instagram' AND story.platform = 'instagram'
     AND coalesce(anchor.response_data ->> 'ig_post_subtype', '') <> 'story'
     AND story.status = 'success' AND story.response_data ->> 'ig_post_subtype' = 'story'
     AND account.user_id = v_post.user_id AND account.id = ANY(v_target_ids)
     AND NOT (story.id = ANY(v_expected_retained));
  SELECT array_agg(DISTINCT id ORDER BY id) INTO p_exact_platform_post_ids
    FROM unnest(p_exact_platform_post_ids || v_carried_ids) id;
  IF v_candidate ->> 'fanout_closed' = 'true' AND NOT (
    p_exact_platform_post_ids @> (v_frozen_ids || v_carried_ids)
    AND (v_frozen_ids || v_carried_ids) @> p_exact_platform_post_ids
  ) THEN
    RETURN jsonb_build_object('closed', false, 'error', 'fanout_scope_frozen');
  END IF;
  -- Parent lock precedes result locks in both settlement and closure.
  PERFORM pp.id FROM public.platform_posts pp
    WHERE pp.id = ANY(p_exact_platform_post_ids || v_expected_retained)
    ORDER BY pp.id FOR UPDATE;
  IF EXISTS (
    SELECT 1 FROM unnest(p_exact_platform_post_ids) rid
    WHERE NOT EXISTS (
      SELECT 1 FROM public.platform_posts pp JOIN public.social_accounts sa ON sa.id = pp.social_account_id
       WHERE pp.id = rid AND pp.post_id = p_post_id AND sa.user_id = v_post.user_id
         AND pp.social_account_id = ANY(v_target_ids) AND pp.platform = sa.platform
         AND pp.status IN ('pending', 'success', 'failed')
         AND (pp.created_at >= p_expected_processing_started_at
           OR public.youtube_upload_safe_timestamptz(pp.response_data #>> '{deferred,attempt_started_at}') = p_expected_processing_started_at)
    )
  ) OR EXISTS (
    SELECT 1 FROM unnest(v_target_ids) tid WHERE NOT EXISTS (
      SELECT 1 FROM public.platform_posts pp WHERE pp.id = ANY(p_exact_platform_post_ids) AND pp.social_account_id = tid
    )
  ) OR EXISTS (
    SELECT 1 FROM unnest(v_expected_retained) rid WHERE NOT EXISTS (
      SELECT 1 FROM public.platform_posts pp JOIN public.social_accounts sa ON sa.id = pp.social_account_id
       WHERE pp.id = rid AND pp.post_id = p_post_id AND pp.status = 'success' AND sa.user_id = v_post.user_id
    )
  ) THEN
    RETURN jsonb_build_object('closed', false, 'error', 'invalid_result_scope');
  END IF;

  -- Check all exact rows exist for post
  IF p_exact_platform_post_ids IS NOT NULL AND cardinality(p_exact_platform_post_ids) > 0 THEN
    SELECT count(*) INTO v_exact_count
      FROM public.platform_posts pp
     WHERE pp.id = ANY(p_exact_platform_post_ids)
       AND pp.post_id = p_post_id;
    IF v_exact_count <> cardinality(p_exact_platform_post_ids) THEN
      RETURN jsonb_build_object('closed', false, 'error', 'exact_rows_mismatch');
    END IF;
  ELSE
    p_exact_platform_post_ids := ARRAY[]::uuid[];
  END IF;

  IF p_retained_platform_post_ids IS NULL THEN
    p_retained_platform_post_ids := ARRAY[]::uuid[];
  END IF;

  -- Check pending status on exact rows
  SELECT count(*) FILTER (WHERE pp.status = 'pending'),
         count(*) FILTER (WHERE pp.status = 'success')
    INTO v_pending_count, v_success_count
    FROM public.platform_posts pp
   WHERE pp.id = ANY(p_exact_platform_post_ids);

  -- Count retained successes
  SELECT count(*) INTO v_retained_count
    FROM public.platform_posts pp
   WHERE pp.id = ANY(p_retained_platform_post_ids) AND pp.status = 'success';

  v_all_rows := array_cat(p_exact_platform_post_ids, p_retained_platform_post_ids);

  IF v_managed_image OR v_pending_count > 0 THEN
    -- Not ready yet (native pending or deferred)
    v_candidate := v_candidate || jsonb_build_object(
      'fanout_closed', true,
      'ready', false,
      'exact_platform_post_ids', to_jsonb(p_exact_platform_post_ids),
      'retained_platform_post_ids', to_jsonb(p_retained_platform_post_ids)
    );
    UPDATE public.posts
       SET metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{legacy_notification_candidate}', v_candidate, true)
     WHERE id = p_post_id;

    RETURN jsonb_build_object(
      'closed', true,
      'ready', false,
      'status', v_post.status,
      'pending_rows', v_pending_count
    );
  ELSE
    -- All exact rows are terminal!
    v_status := CASE WHEN (v_success_count + v_retained_count) > 0 THEN 'completed' ELSE 'failed' END;
    SELECT coalesce(jsonb_object_agg(pp.id::text, pp.status), '{}'::jsonb) INTO v_result_statuses
      FROM public.platform_posts pp WHERE pp.id = ANY(v_all_rows);
    -- Bind a claim to the prepared result snapshot, not merely the parent attempt.
    IF v_candidate -> 'authorized_platform_post_statuses' IS DISTINCT FROM v_result_statuses
       OR v_candidate ->> 'status' IS DISTINCT FROM v_status THEN
      v_candidate := v_candidate || jsonb_build_object('candidate_id', gen_random_uuid());
    END IF;

    -- Atomically update status and ready candidate
    IF v_post.status = 'processing' OR v_post.status IS DISTINCT FROM v_status THEN
      UPDATE public.posts
         SET status = v_status,
             metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
               'settlement_rollup_at', now(), 'settlement_rollup_status', v_status,
               'settlement_rollup_processing_started_at', p_expected_processing_started_at),
             posted_at = CASE WHEN v_status = 'completed' THEN coalesce(posted_at, now()) ELSE posted_at END
       WHERE id = p_post_id;
    END IF;

    v_candidate := v_candidate || jsonb_build_object(
      'fanout_closed', true,
      'ready', true,
      'status', v_status,
      'exact_platform_post_ids', to_jsonb(p_exact_platform_post_ids),
      'retained_platform_post_ids', to_jsonb(p_retained_platform_post_ids),
      'authorized_platform_post_ids', to_jsonb(v_all_rows),
      'authorized_platform_post_statuses', v_result_statuses
    );

    UPDATE public.posts
       SET metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{legacy_notification_candidate}', v_candidate, true)
     WHERE id = p_post_id;

    RETURN jsonb_build_object(
      'closed', true,
      'ready', true,
      'status', v_status,
      'authorized_platform_post_ids', to_jsonb(v_all_rows)
    );
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.close_post_fanout(uuid, timestamptz, jsonb, uuid[], uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.close_post_fanout(uuid, timestamptz, jsonb, uuid[], uuid[]) TO service_role;

