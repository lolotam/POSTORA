-- Durable completion for newly created single-image Threads containers.
-- Additive and safe before dependent code: new RPCs are unused by deployed callers,
-- while existing RPC signatures and legacy video/carousel behavior remain unchanged.

CREATE UNIQUE INDEX IF NOT EXISTS platform_posts_threads_image_attempt_uq
  ON public.platform_posts (
    post_id,
    social_account_id,
    ((response_data #>> '{deferred,container_id}')),
    ((response_data #>> '{deferred,attempt_started_at}'))
  )
  WHERE platform = 'threads'
    AND response_data #>> '{deferred,kind}' = 'threads'
    AND response_data #>> '{deferred,media_type}' = 'IMAGE';

-- Admit one image container to the active processing attempt. The post lock is
-- shared with retry/cancel/edit writers. The content snapshot is captured before
-- provider creation, so a changed post cannot admit the old container afterward.
CREATE OR REPLACE FUNCTION public.record_threads_image_checkpoint(
  p_post_id uuid,
  p_social_account_id uuid,
  p_response_data jsonb,
  p_expected_processing_started_at timestamptz,
  p_expected_content jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_post public.posts%ROWTYPE;
  v_account public.social_accounts%ROWTYPE;
  v_existing uuid;
  v_content jsonb;
  v_same_attempt_rollup boolean;
  v_existing_status text;
BEGIN
  IF p_expected_processing_started_at IS NULL
     OR p_response_data #>> '{deferred,kind}' IS DISTINCT FROM 'threads'
     OR p_response_data #>> '{deferred,media_type}' IS DISTINCT FROM 'IMAGE'
     OR coalesce(p_response_data #>> '{deferred,container_id}', '') = ''
     OR (p_response_data #>> '{deferred,attempt_started_at}')::timestamptz IS DISTINCT FROM p_expected_processing_started_at THEN
    RAISE EXCEPTION 'record_threads_image_checkpoint: invalid durable image identity'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO v_post FROM public.posts WHERE id = p_post_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'record_threads_image_checkpoint: post % does not exist', p_post_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  SELECT * INTO v_account FROM public.social_accounts
   WHERE id = p_social_account_id AND user_id = v_post.user_id AND platform = 'threads' AND is_active = true;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'record_threads_image_checkpoint: account % is not an active Threads account of the post owner', p_social_account_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  v_content := jsonb_build_object(
    'user_id', v_post.user_id,
    'caption', v_post.caption,
    'media_file_ids', v_post.media_file_ids,
    'metadata', coalesce(v_post.metadata, '{}'::jsonb) - 'pinterest_post_type',
    'platforms', v_post.platforms,
    'scheduled_at', v_post.scheduled_at,
    'publish_requested_at', v_post.publish_requested_at,
    'source', v_post.source
  );
  v_same_attempt_rollup := v_post.status IN ('completed', 'failed')
    AND EXISTS (
      SELECT 1 FROM public.platform_posts pp
       WHERE pp.post_id = p_post_id AND pp.status IN ('success', 'failed')
         AND pp.created_at >= p_expected_processing_started_at
    );

  SELECT pp.id, pp.status INTO v_existing, v_existing_status
    FROM public.platform_posts pp
   WHERE pp.post_id = p_post_id
     AND pp.social_account_id = p_social_account_id
     AND pp.response_data #>> '{deferred,kind}' = 'threads'
     AND pp.response_data #>> '{deferred,media_type}' = 'IMAGE'
     AND pp.response_data #>> '{deferred,container_id}' = p_response_data #>> '{deferred,container_id}'
     AND (pp.response_data #>> '{deferred,attempt_started_at}')::timestamptz = p_expected_processing_started_at
   FOR UPDATE;

  IF v_post.processing_started_at IS DISTINCT FROM p_expected_processing_started_at
     OR v_content IS DISTINCT FROM p_expected_content THEN
    RAISE EXCEPTION 'record_threads_image_checkpoint: stale claim or changed content'
      USING ERRCODE = 'serialization_failure';
  END IF;

  -- A lost acknowledgement can be recovered even after terminal settlement, but
  -- replaying it must never reopen the parent or create another operation.
  IF v_existing_status IN ('success', 'failed') THEN
    RETURN v_existing;
  END IF;

  IF NOT (v_post.status = 'processing' OR v_same_attempt_rollup) THEN
    RAISE EXCEPTION 'record_threads_image_checkpoint: cancelled or retried attempt'
      USING ERRCODE = 'serialization_failure';
  END IF;

  IF v_existing IS NOT NULL THEN
    IF v_same_attempt_rollup THEN
      UPDATE public.posts SET status = 'processing' WHERE id = p_post_id AND status IN ('completed', 'failed');
    END IF;
    RETURN v_existing;
  END IF;

  INSERT INTO public.platform_posts (post_id, social_account_id, platform, status, response_data)
  VALUES (p_post_id, p_social_account_id, 'threads', 'pending', p_response_data)
  RETURNING id INTO v_existing;

  UPDATE public.posts SET status = 'processing'
   WHERE id = p_post_id AND status IN ('completed', 'failed');
  RETURN v_existing;
END;
$$;

REVOKE ALL ON FUNCTION public.record_threads_image_checkpoint(uuid, uuid, jsonb, timestamptz, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_threads_image_checkpoint(uuid, uuid, jsonb, timestamptz, jsonb)
  TO service_role;

-- One execution owner per actual reconciliation lease. A duplicate invocation
-- loses before provider traffic; a later lease may replace an expired owner.
CREATE OR REPLACE FUNCTION public.claim_threads_image_execution(
  p_platform_post_id uuid,
  p_expected_claimed_until timestamptz,
  p_execution_id text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_post public.posts%ROWTYPE;
  v_row public.platform_posts%ROWTYPE;
  v_claimed_until timestamptz;
BEGIN
  IF p_expected_claimed_until IS NULL OR coalesce(p_execution_id, '') = '' THEN
    RETURN false;
  END IF;

  -- All image operations lock post before platform row; no lock is held across provider I/O.
  SELECT p.* INTO v_post
    FROM public.posts p
    JOIN public.platform_posts pp ON pp.post_id = p.id
   WHERE pp.id = p_platform_post_id
   FOR UPDATE OF p;
  IF NOT FOUND THEN RETURN false; END IF;

  SELECT pp.* INTO v_row FROM public.platform_posts pp
   WHERE pp.id = p_platform_post_id
   FOR UPDATE;
  IF NOT FOUND OR v_row.status IS DISTINCT FROM 'pending'
     OR v_row.response_data #>> '{deferred,kind}' IS DISTINCT FROM 'threads'
     OR v_row.response_data #>> '{deferred,media_type}' IS DISTINCT FROM 'IMAGE'
     OR NOT EXISTS (
       SELECT 1 FROM public.social_accounts a
        WHERE a.id = v_row.social_account_id
          AND a.user_id = v_post.user_id
          AND a.platform = 'threads'
     ) THEN
    RETURN false;
  END IF;

  v_claimed_until := (v_row.response_data #>> '{deferred,claimed_until}')::timestamptz;
  IF v_claimed_until IS DISTINCT FROM p_expected_claimed_until
     OR v_claimed_until <= now()
     OR v_row.response_data #>> '{deferred,execution_id}' IS NOT NULL THEN
    RETURN false;
  END IF;

  -- Execution also owns bounded abandonment when a connection becomes inactive.
  -- The separate pre-send RPC still requires an active, unchanged credential.
  UPDATE public.platform_posts
     SET response_data = jsonb_set(
       jsonb_set(response_data, '{deferred,execution_id}', to_jsonb(p_execution_id), true),
       '{deferred,execution_claimed_until}', to_jsonb(p_expected_claimed_until), true
     )
   WHERE id = p_platform_post_id;
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_threads_image_execution(uuid, timestamptz, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_threads_image_execution(uuid, timestamptz, text)
  TO service_role;

-- Atomically revalidate the active post/content/account/claim fences and claim
-- the one image send. A false result publishes nothing. The transaction ends
-- before provider I/O; an edit after the marker remains an ambiguous outcome.
CREATE OR REPLACE FUNCTION public.mark_threads_image_publish_started(
  p_platform_post_id uuid,
  p_expected_claimed_until timestamptz,
  p_execution_id text,
  p_expected_content jsonb
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_post public.posts%ROWTYPE;
  v_row public.platform_posts%ROWTYPE;
  v_claimed_until timestamptz;
  v_content jsonb;
  v_account_updated text;
BEGIN
  IF p_expected_claimed_until IS NULL OR coalesce(p_execution_id, '') = '' THEN
    RETURN false;
  END IF;

  SELECT p.* INTO v_post
    FROM public.posts p
    JOIN public.platform_posts pp ON pp.post_id = p.id
   WHERE pp.id = p_platform_post_id
   FOR UPDATE OF p;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT pp.* INTO v_row FROM public.platform_posts pp
   WHERE pp.id = p_platform_post_id
   FOR UPDATE;
  IF NOT FOUND OR v_row.status IS DISTINCT FROM 'pending'
     OR v_row.response_data #>> '{deferred,kind}' IS DISTINCT FROM 'threads'
     OR v_row.response_data #>> '{deferred,media_type}' IS DISTINCT FROM 'IMAGE'
     OR v_row.response_data #>> '{deferred,execution_id}' IS DISTINCT FROM p_execution_id
     OR (v_row.response_data #>> '{deferred,execution_claimed_until}')::timestamptz IS DISTINCT FROM p_expected_claimed_until
     OR v_row.response_data #>> '{deferred,publish_attempt_id}' IS NOT NULL THEN
    RETURN false;
  END IF;

  v_claimed_until := (v_row.response_data #>> '{deferred,claimed_until}')::timestamptz;
  v_content := jsonb_build_object(
    'user_id', v_post.user_id,
    'caption', v_post.caption,
    'media_file_ids', v_post.media_file_ids,
    'metadata', coalesce(v_post.metadata, '{}'::jsonb) - 'pinterest_post_type',
    'platforms', v_post.platforms,
    'scheduled_at', v_post.scheduled_at,
    'publish_requested_at', v_post.publish_requested_at,
    'source', v_post.source
  );
  v_account_updated := v_row.response_data ->> 'account_updated_at';

  IF v_claimed_until IS DISTINCT FROM p_expected_claimed_until
     OR v_claimed_until <= now()
     OR v_post.status IS DISTINCT FROM 'processing'
     OR v_post.processing_started_at IS DISTINCT FROM
       (v_row.response_data #>> '{deferred,attempt_started_at}')::timestamptz
     OR v_content IS DISTINCT FROM p_expected_content
     OR v_row.response_data -> 'content_fence' IS DISTINCT FROM p_expected_content
     OR NOT EXISTS (
       SELECT 1 FROM public.social_accounts a
        WHERE a.id = v_row.social_account_id
          AND a.user_id = v_post.user_id
          AND a.platform = 'threads'
          AND a.is_active = true
          AND a.updated_at IS NOT DISTINCT FROM v_account_updated::timestamptz
     ) THEN
    RETURN false;
  END IF;

  UPDATE public.platform_posts
     SET response_data = jsonb_set(response_data, '{deferred,publish_attempt_id}', to_jsonb(p_execution_id), true)
   WHERE id = p_platform_post_id;
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.mark_threads_image_publish_started(uuid, timestamptz, text, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_threads_image_publish_started(uuid, timestamptz, text, jsonb)
  TO service_role;

-- A new lease clears only the old execution ownership. Container identity and
-- any pre-send attempt marker survive, so an unanswered publish is never retried.
CREATE OR REPLACE FUNCTION public.claim_deferred_publishes(
  p_limit integer DEFAULT 10,
  p_lease interval DEFAULT interval '3 minutes'
)
RETURNS TABLE (platform_post_id uuid, post_id uuid)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH due AS (
    SELECT pp.id
      FROM public.platform_posts pp
     WHERE pp.status = 'pending'
       AND pp.response_data ? 'deferred'
       AND coalesce((pp.response_data #>> '{deferred,next_check_at}')::timestamptz, '-infinity') <= now()
       AND coalesce((pp.response_data #>> '{deferred,claimed_until}')::timestamptz, '-infinity') <= now()
     ORDER BY pp.created_at
     LIMIT greatest(p_limit, 0)
     FOR UPDATE SKIP LOCKED
  )
  UPDATE public.platform_posts pp
     SET response_data = jsonb_set(
       pp.response_data,
       '{deferred}',
       coalesce(pp.response_data -> 'deferred', '{}'::jsonb) ||
         CASE WHEN pp.response_data #>> '{deferred,media_type}' = 'IMAGE'
           THEN jsonb_build_object(
             'claimed_until', now() + p_lease,
             'execution_id', NULL,
             'execution_claimed_until', NULL
           )
           ELSE jsonb_build_object('claimed_until', now() + p_lease)
         END,
       true
     )
    FROM due
   WHERE pp.id = due.id
  RETURNING pp.id, pp.post_id;
$$;

REVOKE ALL ON FUNCTION public.claim_deferred_publishes(integer, interval) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_deferred_publishes(integer, interval) TO service_role;

-- Keep the deployed settlement/outbox/rollup implementation in one place. This
-- same-signature wrapper adds only the managed-image execution fence.
DO $$
BEGIN
  -- A partially completed manual rollout may replay this file. Keep the original
  -- implementation rather than trying to rename the wrapper over it.
  IF to_regprocedure('public.partner_settle_platform_post_legacy(uuid,uuid,uuid,text,text,text,text,text,jsonb)') IS NULL THEN
    ALTER FUNCTION public.partner_settle_platform_post(UUID, UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB)
      RENAME TO partner_settle_platform_post_legacy;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.partner_settle_platform_post(
  p_platform_post_id   UUID,
  p_post_id            UUID,
  p_social_account_id  UUID,
  p_platform           TEXT,
  p_status             TEXT,
  p_provider_post_id   TEXT DEFAULT NULL,
  p_provider_post_url  TEXT DEFAULT NULL,
  p_error_message      TEXT DEFAULT NULL,
  p_response_data      JSONB DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.platform_posts%ROWTYPE;
  v_execution text;
  v_lease text;
BEGIN
  IF p_platform_post_id IS NOT NULL THEN
    -- Checkpoint admission and pre-send claims take the parent lock first. Match
    -- that order before the legacy settlement updates both row and parent.
    PERFORM p.id FROM public.posts p
      JOIN public.platform_posts pp ON pp.post_id = p.id
     WHERE pp.id = p_platform_post_id
     FOR UPDATE OF p;
    SELECT * INTO v_row FROM public.platform_posts WHERE id = p_platform_post_id FOR UPDATE;
    IF FOUND AND v_row.status = 'pending'
       AND v_row.response_data #>> '{deferred,kind}' = 'threads'
       AND v_row.response_data #>> '{deferred,media_type}' = 'IMAGE' THEN
      v_execution := v_row.response_data #>> '{deferred,execution_id}';
      v_lease := v_row.response_data #>> '{deferred,claimed_until}';
      IF v_execution IS NULL OR v_lease IS NULL
        OR p_response_data #>> '{deferred,execution_id}' IS DISTINCT FROM v_execution
        OR p_response_data #>> '{deferred,claimed_until}' IS DISTINCT FROM v_lease
        OR v_row.response_data #>> '{deferred,execution_claimed_until}' IS DISTINCT FROM v_lease
      THEN
        RAISE EXCEPTION 'partner_settle_platform_post: stale Threads image execution'
          USING ERRCODE = 'serialization_failure';
      END IF;
    END IF;
  END IF;

  RETURN public.partner_settle_platform_post_legacy(
    p_platform_post_id,
    p_post_id,
    p_social_account_id,
    p_platform,
    p_status,
    p_provider_post_id,
    p_provider_post_url,
    p_error_message,
    p_response_data
  );
END;
$$;

REVOKE ALL ON FUNCTION public.partner_settle_platform_post(UUID, UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.partner_settle_platform_post_legacy(UUID, UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.partner_settle_platform_post(UUID, UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.partner_settle_platform_post_legacy(UUID, UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB)
  TO service_role;

-- Latest request_post_retry definition, including managed Story protection.
-- The only behavioral addition is exclusion of uncertain single-image Threads
-- outcomes from both targeting and deletion; proven failures remain retryable.
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

REVOKE ALL ON FUNCTION public.request_post_retry(uuid, uuid, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.request_post_retry(uuid, uuid, uuid[]) TO service_role;

NOTIFY pgrst, 'reload schema';
