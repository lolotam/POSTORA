-- Bounded first-request completion for durable single-image Threads containers.
-- Additive RPCs are safe before dependent code; existing timing and lease budgets are unchanged.

CREATE OR REPLACE FUNCTION public.claim_threads_image_inline_execution(
  p_platform_post_id uuid,
  p_post_id uuid,
  p_social_account_id uuid,
  p_expected_container_id text,
  p_expected_processing_started_at timestamptz,
  p_expected_content jsonb,
  p_execution_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_post public.posts%ROWTYPE;
  v_row public.platform_posts%ROWTYPE;
  v_content jsonb;
  v_account_updated text;
  v_lease timestamptz;
BEGIN
  IF coalesce(p_expected_container_id, '') = '' OR p_expected_processing_started_at IS NULL
     OR coalesce(p_execution_id, '') = '' THEN
    RETURN NULL;
  END IF;

  SELECT p.* INTO v_post
    FROM public.posts p
    JOIN public.platform_posts pp ON pp.post_id = p.id
   WHERE pp.id = p_platform_post_id AND p.id = p_post_id
   FOR UPDATE OF p;
  IF NOT FOUND THEN RETURN NULL; END IF;

  SELECT pp.* INTO v_row FROM public.platform_posts pp
   WHERE pp.id = p_platform_post_id
   FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;

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

  IF v_row.post_id IS DISTINCT FROM p_post_id
     OR v_row.social_account_id IS DISTINCT FROM p_social_account_id
     OR v_row.status IS DISTINCT FROM 'pending'
     OR v_row.response_data #>> '{deferred,kind}' IS DISTINCT FROM 'threads'
     OR v_row.response_data #>> '{deferred,media_type}' IS DISTINCT FROM 'IMAGE'
     OR v_row.response_data #>> '{deferred,container_id}' IS DISTINCT FROM p_expected_container_id
     OR (v_row.response_data #>> '{deferred,attempt_started_at}')::timestamptz
        IS DISTINCT FROM p_expected_processing_started_at
     OR v_row.response_data #>> '{deferred,publish_attempt_id}' IS NOT NULL
     OR v_row.response_data #>> '{deferred,execution_id}' IS NOT NULL
     OR coalesce((v_row.response_data #>> '{deferred,claimed_until}')::timestamptz, '-infinity') > now()
     OR v_post.status IS DISTINCT FROM 'processing'
     OR v_post.processing_started_at IS DISTINCT FROM p_expected_processing_started_at
     OR v_content IS DISTINCT FROM p_expected_content
     OR v_row.response_data -> 'content_fence' IS DISTINCT FROM p_expected_content
     OR NOT EXISTS (
       SELECT 1 FROM public.social_accounts a
        WHERE a.id = p_social_account_id
          AND a.user_id = v_post.user_id
          AND a.platform = 'threads'
          AND a.is_active = true
          AND a.updated_at IS NOT DISTINCT FROM v_account_updated::timestamptz
     ) THEN
    RETURN NULL;
  END IF;

  -- This original-request claim deliberately ignores next_check_at. Ordinary
  -- reconciliation competes through claimed_until on the same locked row.
  v_lease := now() + interval '3 minutes';
  UPDATE public.platform_posts
     SET response_data = jsonb_set(
       response_data,
       '{deferred}',
       (response_data -> 'deferred') || jsonb_build_object(
         'claimed_until', v_lease,
         'execution_id', p_execution_id,
         'execution_claimed_until', v_lease
       ),
       true
     )
   WHERE id = p_platform_post_id
  RETURNING * INTO v_row;

  RETURN jsonb_build_object(
    'platform_post_id', v_row.id,
    'response_data', v_row.response_data
  );
END;
$$;

REVOKE ALL ON FUNCTION public.claim_threads_image_inline_execution(uuid,uuid,uuid,text,timestamptz,jsonb,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_threads_image_inline_execution(uuid,uuid,uuid,text,timestamptz,jsonb,text)
  TO service_role;

CREATE OR REPLACE FUNCTION public.release_threads_image_publish_unsent(
  p_platform_post_id uuid,
  p_expected_container_id text,
  p_expected_processing_started_at timestamptz,
  p_expected_claimed_until timestamptz,
  p_execution_id text,
  p_publish_attempt_id text,
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
  v_content jsonb;
  v_account_updated text;
BEGIN
  IF coalesce(p_expected_container_id, '') = '' OR p_expected_processing_started_at IS NULL
     OR p_expected_claimed_until IS NULL OR coalesce(p_execution_id, '') = ''
     OR coalesce(p_publish_attempt_id, '') = '' THEN
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
  IF NOT FOUND THEN RETURN false; END IF;

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

  IF v_row.status IS DISTINCT FROM 'pending'
     OR v_row.response_data #>> '{deferred,kind}' IS DISTINCT FROM 'threads'
     OR v_row.response_data #>> '{deferred,media_type}' IS DISTINCT FROM 'IMAGE'
     OR v_row.response_data #>> '{deferred,container_id}' IS DISTINCT FROM p_expected_container_id
     OR (v_row.response_data #>> '{deferred,attempt_started_at}')::timestamptz
        IS DISTINCT FROM p_expected_processing_started_at
     OR (v_row.response_data #>> '{deferred,claimed_until}')::timestamptz
        IS DISTINCT FROM p_expected_claimed_until
     OR (v_row.response_data #>> '{deferred,execution_claimed_until}')::timestamptz
        IS DISTINCT FROM p_expected_claimed_until
     OR p_expected_claimed_until <= now()
     OR v_row.response_data #>> '{deferred,execution_id}' IS DISTINCT FROM p_execution_id
     OR v_row.response_data #>> '{deferred,publish_attempt_id}' IS DISTINCT FROM p_publish_attempt_id
     OR v_row.response_data #>> '{deferred,publish_outcome}' IS NOT NULL
     OR v_post.status IS DISTINCT FROM 'processing'
     OR v_post.processing_started_at IS DISTINCT FROM p_expected_processing_started_at
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
     SET response_data = jsonb_set(
       response_data,
       '{deferred}',
       (response_data -> 'deferred') - 'publish_attempt_id',
       true
     )
   WHERE id = p_platform_post_id;
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.release_threads_image_publish_unsent(uuid,text,timestamptz,timestamptz,text,text,jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_threads_image_publish_unsent(uuid,text,timestamptz,timestamptz,text,text,jsonb)
  TO service_role;

-- Authoritative admission checkpoint with provenance check for authorized
-- sibling rollup vs owner cancellation.
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
    'metadata', coalesce(v_post.metadata, '{}'::jsonb) - 'pinterest_post_type' - 'final_notified_at' - 'settlement_rollup_at',
    'platforms', v_post.platforms,
    'scheduled_at', v_post.scheduled_at,
    'publish_requested_at', v_post.publish_requested_at,
    'source', v_post.source
  );

  -- Authoritative provenance: only a legitimate sibling rollup that stamped
  -- settlement_rollup_at in this attempt permits admission in a completed/failed post.
  -- An owner's status-only cancellation (lacking settlement_rollup_at) is never revived.
  v_same_attempt_rollup := v_post.status IN ('completed', 'failed')
    AND (v_post.metadata ->> 'settlement_rollup_at') IS NOT NULL
    AND ((v_post.metadata ->> 'settlement_rollup_at')::timestamptz >= p_expected_processing_started_at)
    AND EXISTS (
      SELECT 1 FROM public.platform_posts pp
       WHERE pp.post_id = p_post_id AND pp.status IN ('success', 'failed')
         AND (
           pp.created_at >= p_expected_processing_started_at
           OR (pp.response_data #>> '{deferred,attempt_started_at}')::timestamptz = p_expected_processing_started_at
         )
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
     OR v_content IS DISTINCT FROM jsonb_set(
       p_expected_content,
       '{metadata}',
       coalesce(p_expected_content -> 'metadata', '{}'::jsonb) - 'final_notified_at' - 'settlement_rollup_at',
       true
     ) THEN
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

  IF v_same_attempt_rollup THEN
    UPDATE public.posts SET status = 'processing'
     WHERE id = p_post_id AND status IN ('completed', 'failed');
  END IF;
  RETURN v_existing;
END;
$$;

REVOKE ALL ON FUNCTION public.record_threads_image_checkpoint(uuid, uuid, jsonb, timestamptz, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_threads_image_checkpoint(uuid, uuid, jsonb, timestamptz, jsonb)
  TO service_role;

-- Allow reconciler cron to recover terminal managed-image rows whose parent is
-- still processing (e.g. after a lost settlement ACK), without waiting for manual intervention.
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
      JOIN public.posts p ON p.id = pp.post_id
     WHERE (
       (
         pp.status = 'pending'
         AND pp.response_data ? 'deferred'
         AND coalesce((pp.response_data #>> '{deferred,next_check_at}')::timestamptz, '-infinity') <= now()
         AND coalesce((pp.response_data #>> '{deferred,claimed_until}')::timestamptz, '-infinity') <= now()
       )
       OR
       (
         pp.status IN ('success', 'failed')
         AND pp.response_data #>> '{deferred,kind}' = 'threads'
         AND pp.response_data #>> '{deferred,media_type}' = 'IMAGE'
         AND p.status = 'processing'
         AND coalesce((pp.response_data #>> '{deferred,claimed_until}')::timestamptz, '-infinity') <= now()
       )
     )
     ORDER BY pp.created_at
     LIMIT greatest(p_limit, 0)
     FOR UPDATE OF pp SKIP LOCKED
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
  RETURNING pp.id AS platform_post_id, pp.post_id;
$$;

REVOKE ALL ON FUNCTION public.claim_deferred_publishes(integer, interval) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_deferred_publishes(integer, interval) TO service_role;

DROP FUNCTION IF EXISTS public.finalize_threads_image_attempt(uuid,timestamptz,jsonb);

CREATE OR REPLACE FUNCTION public.finalize_threads_image_attempt(
  p_post_id uuid,
  p_expected_processing_started_at timestamptz,
  p_expected_content jsonb,
  p_expected_account_ids uuid[] DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_post public.posts%ROWTYPE;
  v_content jsonb;
  v_total integer;
  v_pending integer;
  v_succeeded integer;
  v_missing integer;
  v_status text;
  v_marker text;
  v_notify boolean := true;
  v_target_account_ids uuid[];
BEGIN
  IF p_expected_processing_started_at IS NULL THEN RETURN NULL; END IF;

  SELECT * INTO v_post FROM public.posts WHERE id = p_post_id FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;

  v_content := jsonb_build_object(
    'user_id', v_post.user_id,
    'caption', v_post.caption,
    'media_file_ids', v_post.media_file_ids,
    'metadata', coalesce(v_post.metadata, '{}'::jsonb) - 'pinterest_post_type' - 'final_notified_at' - 'settlement_rollup_at',
    'platforms', v_post.platforms,
    'scheduled_at', v_post.scheduled_at,
    'publish_requested_at', v_post.publish_requested_at,
    'source', v_post.source
  );
  IF v_post.processing_started_at IS DISTINCT FROM p_expected_processing_started_at
     OR v_content IS DISTINCT FROM jsonb_set(
       p_expected_content,
       '{metadata}',
       coalesce(p_expected_content -> 'metadata', '{}'::jsonb) - 'final_notified_at' - 'settlement_rollup_at',
       true
     ) THEN
    RETURN jsonb_build_object('status', v_post.status, 'stale', true, 'notify', false);
  END IF;

  v_marker := v_post.metadata ->> 'final_notified_at';
  IF coalesce(v_marker, '') <> '' THEN
    BEGIN
      IF v_marker::timestamptz >= p_expected_processing_started_at THEN
        v_notify := false;
      END IF;
    EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
      v_notify := false;
    END;
  END IF;

  -- Only the active attempt may write a new parent state. A terminal state with
  -- its notification marker is an acknowledged replay; any other status-only
  -- transition (including pending/failed cancellation) is preserved untouched.
  IF v_post.status IS DISTINCT FROM 'processing' THEN
    RETURN jsonb_build_object(
      'status', v_post.status,
      'stale', NOT (v_post.status IN ('completed', 'failed') AND NOT v_notify),
      'notify', false
    );
  END IF;

  -- Determine authoritative target account IDs for this attempt
  IF p_expected_account_ids IS NOT NULL AND cardinality(p_expected_account_ids) > 0 THEN
    v_target_account_ids := p_expected_account_ids;
  ELSIF jsonb_typeof(v_post.metadata -> 'selected_account_ids') = 'array'
        AND jsonb_array_length(v_post.metadata -> 'selected_account_ids') > 0 THEN
    SELECT array_agg(a.id) INTO v_target_account_ids
      FROM jsonb_array_elements_text(v_post.metadata -> 'selected_account_ids') AS sel(account_id)
      JOIN public.social_accounts a
        ON a.id::text = sel.account_id
       AND a.user_id = v_post.user_id
       AND a.is_active = true;
  ELSE
    SELECT array_agg(a.id) INTO v_target_account_ids
      FROM public.social_accounts a
     WHERE a.user_id = v_post.user_id
       AND a.is_active = true
       AND a.platform = ANY(v_post.platforms);
  END IF;

  -- Verify each target account has a durable row for this attempt
  IF v_target_account_ids IS NOT NULL AND cardinality(v_target_account_ids) > 0 THEN
    SELECT count(*) INTO v_missing
      FROM unnest(v_target_account_ids) AS target_acct(id)
     WHERE NOT EXISTS (
       SELECT 1 FROM public.platform_posts pp
        WHERE pp.post_id = p_post_id
          AND pp.social_account_id = target_acct.id
          AND (
            pp.created_at >= p_expected_processing_started_at
            OR (pp.response_data #>> '{deferred,attempt_started_at}')::timestamptz = p_expected_processing_started_at
          )
     );
    IF v_missing > 0 THEN
      RETURN jsonb_build_object('status', 'processing', 'stale', false, 'notify', false);
    END IF;
  END IF;

  SELECT count(*),
         count(*) FILTER (WHERE status = 'pending'),
         count(*) FILTER (WHERE status = 'success')
    INTO v_total, v_pending, v_succeeded
    FROM public.platform_posts pp
   WHERE pp.post_id = p_post_id
     AND (
       pp.created_at >= p_expected_processing_started_at
       OR (pp.response_data #>> '{deferred,attempt_started_at}')::timestamptz = p_expected_processing_started_at
     );

  IF v_total = 0 THEN
    RETURN jsonb_build_object('status', v_post.status, 'stale', false, 'notify', false);
  END IF;

  IF v_pending > 0 THEN
    RETURN jsonb_build_object('status', 'processing', 'stale', false, 'notify', false);
  END IF;

  v_status := CASE WHEN v_succeeded > 0 THEN 'completed' ELSE 'failed' END;

  -- Do not stamp final_notified_at in the database here: if notification delivery
  -- fails or ACK is lost, final_notified_at would be permanently consumed.
  -- Delivery is claimed via atomic CAS in application layer (announceFinalPost).
  UPDATE public.posts
     SET status = v_status,
         posted_at = CASE WHEN v_status = 'completed' THEN coalesce(posted_at, now()) ELSE posted_at END
   WHERE id = p_post_id;

  RETURN jsonb_build_object('status', v_status, 'stale', false, 'notify', v_notify);
END;
$$;

REVOKE ALL ON FUNCTION public.finalize_threads_image_attempt(uuid,timestamptz,jsonb,uuid[])
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_threads_image_attempt(uuid,timestamptz,jsonb,uuid[])
  TO service_role;

-- Keep the publishing seam and outbox implementation authoritative. For an old
-- managed image, settle its own row but never roll a newer/edited parent back.
CREATE OR REPLACE FUNCTION public.partner_settle_platform_post_legacy(
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
  v_row        public.platform_posts;
  v_post       public.posts;
  v_owner      UUID;
  v_acct_owner UUID;
  v_workspace  UUID;
  v_event      TEXT;
  v_enqueued   INTEGER := 0;
  v_total      INTEGER;
  v_settled    INTEGER;
  v_succeeded  INTEGER;
  v_post_state TEXT;
  v_rollup_parent BOOLEAN := true;
  v_content    JSONB;
BEGIN
  IF p_status NOT IN ('success', 'failed') THEN
    RAISE EXCEPTION 'partner_settle_platform_post: % is not a terminal status', p_status;
  END IF;

  IF p_platform_post_id IS NOT NULL THEN
    PERFORM p.id FROM public.posts p
      JOIN public.platform_posts pp ON pp.post_id = p.id
     WHERE pp.id = p_platform_post_id
     FOR UPDATE OF p;
    SELECT p.user_id INTO v_owner FROM public.posts p
      JOIN public.platform_posts pp ON pp.post_id = p.id
     WHERE pp.id = p_platform_post_id;
  ELSE
    SELECT p.user_id INTO v_owner FROM public.posts p WHERE p.id = p_post_id;
  END IF;

  IF p_social_account_id IS NOT NULL OR p_platform_post_id IS NOT NULL THEN
    SELECT a.user_id INTO v_acct_owner
      FROM public.social_accounts a
     WHERE a.id = coalesce(
             p_social_account_id,
             (SELECT pp.social_account_id FROM public.platform_posts pp WHERE pp.id = p_platform_post_id)
           );
    IF v_acct_owner IS NOT NULL AND v_owner IS NOT NULL AND v_acct_owner <> v_owner THEN
      RAISE EXCEPTION
        'partner_settle_platform_post: post % belongs to % but account % belongs to % (cross-tenant pairing refused)',
        coalesce(p_post_id, p_platform_post_id), v_owner, p_social_account_id, v_acct_owner
        USING ERRCODE = 'foreign_key_violation';
    END IF;
  END IF;

  IF p_platform_post_id IS NOT NULL THEN
    SELECT * INTO v_row FROM public.platform_posts
     WHERE id = p_platform_post_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'partner_settle_platform_post: no platform_post %', p_platform_post_id;
    END IF;
    IF v_row.status IN ('success', 'failed') THEN
      RETURN jsonb_build_object(
        'platform_post_id', v_row.id, 'settled', false, 'enqueued', 0,
        'reason', 'already terminal'
      );
    END IF;

    UPDATE public.platform_posts
       SET status            = p_status,
           platform_post_id  = coalesce(p_provider_post_id, platform_post_id),
           platform_post_url = coalesce(p_provider_post_url, platform_post_url),
           error_message     = coalesce(p_error_message, error_message),
           response_data     = coalesce(p_response_data, response_data),
           posted_at         = CASE WHEN p_status = 'success'
                                    THEN coalesce(posted_at, now()) ELSE posted_at END
     WHERE id = p_platform_post_id
    RETURNING * INTO v_row;
  ELSE
    IF p_post_id IS NULL OR p_platform IS NULL THEN
      RAISE EXCEPTION
        'partner_settle_platform_post: p_post_id and p_platform are required when no row id is given';
    END IF;

    INSERT INTO public.platform_posts (
      post_id, social_account_id, platform, platform_post_id, platform_post_url,
      status, error_message, response_data, posted_at
    )
    VALUES (
      p_post_id, p_social_account_id, p_platform, p_provider_post_id, p_provider_post_url,
      p_status, p_error_message, p_response_data,
      CASE WHEN p_status = 'success' THEN now() ELSE NULL END
    )
    RETURNING * INTO v_row;
  END IF;

  IF v_row.platform = 'threads'
     AND v_row.response_data #>> '{deferred,kind}' = 'threads'
     AND v_row.response_data #>> '{deferred,media_type}' = 'IMAGE' THEN
    SELECT * INTO v_post FROM public.posts WHERE id = v_row.post_id;
    v_content := jsonb_build_object(
      'user_id', v_post.user_id,
      'caption', v_post.caption,
      'media_file_ids', v_post.media_file_ids,
      'metadata', coalesce(v_post.metadata, '{}'::jsonb) - 'pinterest_post_type' - 'final_notified_at' - 'settlement_rollup_at',
      'platforms', v_post.platforms,
      'scheduled_at', v_post.scheduled_at,
      'publish_requested_at', v_post.publish_requested_at,
      'source', v_post.source
    );
    v_rollup_parent := v_post.processing_started_at IS NOT DISTINCT FROM
      (v_row.response_data #>> '{deferred,attempt_started_at}')::timestamptz
      AND v_content IS NOT DISTINCT FROM jsonb_set(
        v_row.response_data -> 'content_fence',
        '{metadata}',
        coalesce((v_row.response_data -> 'content_fence') -> 'metadata', '{}'::jsonb) - 'final_notified_at' - 'settlement_rollup_at',
        true
      );
  END IF;

  SELECT * INTO v_post FROM public.posts WHERE id = v_row.post_id;
  IF 'threads' = ANY(v_post.platforms) THEN
    -- If Threads has not finished its current attempt, suppress parent rollup
    IF NOT EXISTS (
      SELECT 1 FROM public.platform_posts tp
       WHERE tp.post_id = v_row.post_id
         AND tp.platform = 'threads'
         AND tp.status IN ('success', 'failed')
         AND (
           tp.created_at >= v_post.processing_started_at
           OR (tp.response_data #>> '{deferred,attempt_started_at}')::timestamptz = v_post.processing_started_at
         )
    ) THEN
      v_rollup_parent := false;
    END IF;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.platform_posts managed
     WHERE managed.post_id = v_row.post_id
       AND managed.response_data #>> '{deferred,kind}' = 'threads'
       AND managed.response_data #>> '{deferred,media_type}' = 'IMAGE'
       AND (managed.response_data #>> '{deferred,attempt_started_at}')::timestamptz
           IS NOT DISTINCT FROM v_post.processing_started_at
  ) THEN
    -- A managed-image attempt has one fenced parent finalizer. Per-target
    -- settlement and outbox emission still happen here, but neither an early
    -- sibling nor a status-only cancellation can be overwritten by this rollup.
    v_rollup_parent := false;
  END IF;

  SELECT count(*),
         count(*) FILTER (WHERE status IN ('success', 'failed')),
         count(*) FILTER (WHERE status = 'success')
    INTO v_total, v_settled, v_succeeded
    FROM public.platform_posts WHERE post_id = v_row.post_id;

  IF v_settled = v_total AND v_rollup_parent THEN
    v_post_state := CASE WHEN v_succeeded > 0 THEN 'completed' ELSE 'failed' END;
    UPDATE public.posts
       SET status = v_post_state,
           posted_at = CASE WHEN v_post_state = 'completed'
                            THEN coalesce(posted_at, now()) ELSE posted_at END,
           metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('settlement_rollup_at', now())
     WHERE id = v_row.post_id;
  END IF;

  SELECT * INTO v_post FROM public.posts WHERE id = v_row.post_id;
  IF v_row.social_account_id IS NOT NULL THEN
    v_workspace := public.partner_workspace_of_account(v_row.social_account_id);
  END IF;

  IF v_workspace IS NOT NULL THEN
    v_event := CASE WHEN p_status = 'success' THEN 'post.published' ELSE 'post.failed' END;
    v_enqueued := public.partner_emit_webhook_event(
      v_workspace,
      v_event,
      v_event || ':' || v_row.id::text,
      jsonb_build_object(
        'post_id', v_row.post_id,
        'platform_post_id', v_row.id,
        'platform', v_row.platform,
        'account_id', v_row.social_account_id,
        'status', v_row.status,
        'provider_post_id', v_row.platform_post_id,
        'provider_post_url', v_row.platform_post_url,
        'error_message', v_row.error_message,
        'posted_at', v_row.posted_at,
        'post_status', coalesce(v_post_state, v_post.status)
      ),
      v_row.platform,
      v_row.social_account_id,
      coalesce(v_row.posted_at, now())
    );
  END IF;

  RETURN jsonb_build_object(
    'platform_post_id', v_row.id,
    'settled', true,
    'post_status', coalesce(v_post_state, v_post.status),
    'enqueued', v_enqueued
  );
END;
$$;

REVOKE ALL ON FUNCTION public.partner_settle_platform_post_legacy(UUID, UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.partner_settle_platform_post_legacy(UUID, UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB)
  TO service_role;

NOTIFY pgrst, 'reload schema';
