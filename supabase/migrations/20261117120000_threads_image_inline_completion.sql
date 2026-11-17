-- Bounded first-request completion for durable single-image Threads containers.
-- Additive RPCs are safe before dependent code; existing timing and lease budgets are unchanged.

CREATE OR REPLACE FUNCTION public.normalize_threads_internal_metadata(p_metadata jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT coalesce(p_metadata, '{}'::jsonb)
    - 'pinterest_post_type'
    - 'final_notified_at'
    - 'settlement_rollup_at'
    - 'settlement_rollup_status'
    - 'settlement_rollup_processing_started_at'
    - 'attempt_target_account_ids'
    - 'attempt_retained_account_ids'
    - 'attempt_retained_platform_post_ids'
    - 'attempt_started_at'
    - 'attempt_scope'
    - 'final_notification_intent';
$$;

REVOKE ALL ON FUNCTION public.normalize_threads_internal_metadata(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.normalize_threads_internal_metadata(jsonb) TO service_role;

-- Invalidate prior sibling rollup provenance on owner status cancellation (pending/failed)
-- or status transition away from established intent
CREATE OR REPLACE FUNCTION public.trg_posts_invalidate_rollup_on_cancellation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status IN ('pending', 'failed') THEN
    IF NEW.metadata ? 'settlement_rollup_at' AND (NEW.metadata ->> 'settlement_rollup_at') IS NOT DISTINCT FROM (OLD.metadata ->> 'settlement_rollup_at') THEN
      NEW.metadata := NEW.metadata - 'settlement_rollup_at' - 'settlement_rollup_status' - 'settlement_rollup_processing_started_at';
    END IF;
    IF NEW.metadata ? 'final_notification_intent' THEN
      NEW.metadata := NEW.metadata - 'final_notification_intent';
    END IF;
  ELSIF NEW.status IS DISTINCT FROM OLD.status AND NEW.metadata ? 'final_notification_intent' THEN
    IF (NEW.metadata #>> '{final_notification_intent,status}') IS DISTINCT FROM NEW.status THEN
      NEW.metadata := NEW.metadata - 'final_notification_intent';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_posts_invalidate_rollup ON public.posts;
CREATE TRIGGER trg_posts_invalidate_rollup
  BEFORE UPDATE OF status ON public.posts
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_posts_invalidate_rollup_on_cancellation();

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
    'metadata', public.normalize_threads_internal_metadata(v_post.metadata),
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
     OR v_content IS DISTINCT FROM jsonb_set(
       p_expected_content,
       '{metadata}',
       public.normalize_threads_internal_metadata(p_expected_content -> 'metadata'),
       true
     )
     OR jsonb_set(
       v_row.response_data -> 'content_fence',
       '{metadata}',
       public.normalize_threads_internal_metadata(v_row.response_data #> '{content_fence,metadata}'),
       true
     ) IS DISTINCT FROM jsonb_set(
       p_expected_content,
       '{metadata}',
       public.normalize_threads_internal_metadata(p_expected_content -> 'metadata'),
       true
     )
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
    'metadata', public.normalize_threads_internal_metadata(v_post.metadata),
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
     OR v_content IS DISTINCT FROM jsonb_set(
       p_expected_content,
       '{metadata}',
       public.normalize_threads_internal_metadata(p_expected_content -> 'metadata'),
       true
     )
     OR jsonb_set(
       v_row.response_data -> 'content_fence',
       '{metadata}',
       public.normalize_threads_internal_metadata(v_row.response_data #> '{content_fence,metadata}'),
       true
     ) IS DISTINCT FROM jsonb_set(
       p_expected_content,
       '{metadata}',
       public.normalize_threads_internal_metadata(p_expected_content -> 'metadata'),
       true
     )
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
       (response_data -> 'deferred') - 'publish_attempt_id'
     )
   WHERE id = p_platform_post_id;

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.release_threads_image_publish_unsent(uuid,text,timestamptz,timestamptz,text,text,jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_threads_image_publish_unsent(uuid,text,timestamptz,timestamptz,text,text,jsonb)
  TO service_role;

-- Override M1 mark_threads_image_publish_started to use unified metadata normalization
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
    'metadata', public.normalize_threads_internal_metadata(v_post.metadata),
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
     OR v_content IS DISTINCT FROM jsonb_set(
       p_expected_content,
       '{metadata}',
       public.normalize_threads_internal_metadata(p_expected_content -> 'metadata'),
       true
     )
     OR jsonb_set(
       v_row.response_data -> 'content_fence',
       '{metadata}',
       public.normalize_threads_internal_metadata(v_row.response_data #> '{content_fence,metadata}'),
       true
     ) IS DISTINCT FROM jsonb_set(
       p_expected_content,
       '{metadata}',
       public.normalize_threads_internal_metadata(p_expected_content -> 'metadata'),
       true
     )
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

DROP FUNCTION IF EXISTS public.record_threads_image_checkpoint(uuid, uuid, jsonb, timestamptz, jsonb);
DROP FUNCTION IF EXISTS public.record_threads_image_checkpoint(uuid, uuid, jsonb, timestamptz, jsonb, uuid[], uuid[]);

CREATE OR REPLACE FUNCTION public.record_threads_image_checkpoint(
  p_post_id uuid,
  p_social_account_id uuid,
  p_response_data jsonb,
  p_expected_processing_started_at timestamptz,
  p_expected_content jsonb,
  p_target_account_ids uuid[],
  p_retained_platform_post_ids uuid[]
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
  v_targets uuid[];
  v_persisted_targets uuid[];
  v_retained uuid[];
  v_persisted_retained uuid[];
  v_resolved_retained uuid[] := ARRAY[]::uuid[];
  v_row_match uuid;
  r_elem record;
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
    'metadata', public.normalize_threads_internal_metadata(v_post.metadata),
    'platforms', v_post.platforms,
    'scheduled_at', v_post.scheduled_at,
    'publish_requested_at', v_post.publish_requested_at,
    'source', v_post.source
  );

  -- Authoritative provenance: only a legitimate sibling rollup that stamped
  -- settlement_rollup_at in this attempt permits admission in a completed/failed post.
  -- An owner's status-only cancellation (or newer transition) strips or mismatches rollup provenance.
  v_same_attempt_rollup := v_post.status IN ('completed', 'failed')
    AND (v_post.metadata ->> 'settlement_rollup_at') IS NOT NULL
    AND ((v_post.metadata ->> 'settlement_rollup_at')::timestamptz >= p_expected_processing_started_at)
    AND (
      (v_post.metadata ->> 'settlement_rollup_status') IS NULL
      OR (v_post.metadata ->> 'settlement_rollup_status') = v_post.status
    )
    AND (
      (v_post.metadata ->> 'settlement_rollup_processing_started_at') IS NULL
      OR (v_post.metadata ->> 'settlement_rollup_processing_started_at')::timestamptz = p_expected_processing_started_at
    )
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
       public.normalize_threads_internal_metadata(p_expected_content -> 'metadata'),
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

  -- 1. Target scope resolution & validation
  IF (v_post.metadata ->> 'attempt_started_at')::timestamptz IS NOT DISTINCT FROM p_expected_processing_started_at
     AND jsonb_typeof(v_post.metadata -> 'attempt_target_account_ids') = 'array'
     AND jsonb_array_length(v_post.metadata -> 'attempt_target_account_ids') > 0 THEN
    SELECT array_agg(elem::uuid) INTO v_persisted_targets
      FROM jsonb_array_elements_text(v_post.metadata -> 'attempt_target_account_ids') AS elem;
    IF p_target_account_ids IS NOT NULL AND cardinality(p_target_account_ids) > 0 THEN
      IF (SELECT count(*) FROM unnest(p_target_account_ids) x WHERE x NOT IN (SELECT unnest(v_persisted_targets))) > 0
         OR (SELECT count(*) FROM unnest(v_persisted_targets) x WHERE x NOT IN (SELECT unnest(p_target_account_ids))) > 0
         OR cardinality(p_target_account_ids) <> cardinality(v_persisted_targets) THEN
        RAISE EXCEPTION 'record_threads_image_checkpoint: target account scope mismatch with persisted attempt scope'
          USING ERRCODE = 'data_exception';
      END IF;
    END IF;
    v_targets := v_persisted_targets;
  ELSIF p_target_account_ids IS NOT NULL AND cardinality(p_target_account_ids) > 0 THEN
    IF EXISTS (SELECT 1 FROM unnest(p_target_account_ids) x WHERE x IS NULL) THEN
      RAISE EXCEPTION 'record_threads_image_checkpoint: null element in target scope'
        USING ERRCODE = 'data_exception';
    END IF;
    IF (SELECT count(DISTINCT x) FROM unnest(p_target_account_ids) x) <> cardinality(p_target_account_ids) THEN
      RAISE EXCEPTION 'record_threads_image_checkpoint: duplicate target account in scope'
        USING ERRCODE = 'data_exception';
    END IF;
    v_targets := p_target_account_ids;
  ELSIF jsonb_typeof(v_post.metadata -> 'selected_account_ids') = 'array'
        AND jsonb_array_length(v_post.metadata -> 'selected_account_ids') > 0 THEN
    SELECT array_agg(a.id) INTO v_targets
      FROM jsonb_array_elements_text(v_post.metadata -> 'selected_account_ids') AS sel(account_id)
      JOIN public.social_accounts a
        ON a.id::text = sel.account_id
       AND a.user_id = v_post.user_id
       AND a.is_active = true;
  ELSE
    SELECT array_agg(a.id) INTO v_targets
      FROM public.social_accounts a
     WHERE a.user_id = v_post.user_id
       AND a.is_active = true
       AND a.platform = ANY(v_post.platforms);
  END IF;

  IF v_targets IS NULL OR cardinality(v_targets) = 0 THEN
    v_targets := ARRAY[p_social_account_id];
  END IF;

  -- Validate all target accounts structurally belong to user and match post platforms
  IF EXISTS (
    SELECT 1 FROM unnest(v_targets) AS tid
     WHERE NOT EXISTS (
       SELECT 1 FROM public.social_accounts sa
        WHERE sa.id = tid AND sa.user_id = v_post.user_id AND sa.platform = ANY(v_post.platforms)
     )
  ) THEN
    RAISE EXCEPTION 'record_threads_image_checkpoint: invalid or foreign target account in scope'
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  -- 2. Retained successful results resolution & validation
  IF p_retained_platform_post_ids IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM unnest(p_retained_platform_post_ids) x WHERE x IS NULL) THEN
      RAISE EXCEPTION 'record_threads_image_checkpoint: null element in retained scope'
        USING ERRCODE = 'data_exception';
    END IF;

    FOR r_elem IN SELECT unnest(p_retained_platform_post_ids) AS rid LOOP
      -- 1) Exact platform_posts row id
      SELECT rpp.id INTO v_row_match
        FROM public.platform_posts rpp
        JOIN public.social_accounts rsa ON rsa.id = rpp.social_account_id
       WHERE rpp.id = r_elem.rid
         AND rpp.post_id = p_post_id
         AND rpp.status = 'success'
         AND rsa.user_id = v_post.user_id;

      IF v_row_match IS NOT NULL THEN
        v_resolved_retained := array_append(v_resolved_retained, v_row_match);
      ELSE
        RAISE EXCEPTION 'record_threads_image_checkpoint: retained result is not an authoritative success for this post'
          USING ERRCODE = 'foreign_key_violation';
      END IF;
    END LOOP;

    SELECT coalesce(array_agg(DISTINCT x), ARRAY[]::uuid[]) INTO v_resolved_retained
      FROM unnest(v_resolved_retained) x;
  END IF;

  IF (v_post.metadata ->> 'attempt_started_at')::timestamptz IS NOT DISTINCT FROM p_expected_processing_started_at
     AND jsonb_typeof(v_post.metadata -> 'attempt_retained_platform_post_ids') = 'array' THEN
    SELECT array_agg(elem::uuid) INTO v_persisted_retained
      FROM jsonb_array_elements_text(v_post.metadata -> 'attempt_retained_platform_post_ids') AS elem;
    IF v_persisted_retained IS NULL THEN v_persisted_retained := ARRAY[]::uuid[]; END IF;

    IF p_retained_platform_post_ids IS NOT NULL THEN
      IF (SELECT count(*) FROM unnest(v_resolved_retained) x WHERE x NOT IN (SELECT unnest(v_persisted_retained))) > 0
         OR (SELECT count(*) FROM unnest(v_persisted_retained) x WHERE x NOT IN (SELECT unnest(v_resolved_retained))) > 0
         OR cardinality(v_resolved_retained) <> cardinality(v_persisted_retained) THEN
        RAISE EXCEPTION 'record_threads_image_checkpoint: retained row scope mismatch with persisted attempt scope'
          USING ERRCODE = 'data_exception';
      END IF;
    END IF;
    v_retained := v_persisted_retained;
  ELSIF p_retained_platform_post_ids IS NOT NULL THEN
    v_retained := v_resolved_retained;
  ELSE
    v_retained := ARRAY[]::uuid[];
  END IF;

  IF v_retained IS NULL THEN
    v_retained := ARRAY[]::uuid[];
  END IF;

  UPDATE public.posts
     SET metadata = (coalesce(metadata, '{}'::jsonb) - 'attempt_retained_account_ids') || jsonb_build_object(
           'attempt_target_account_ids', to_jsonb(v_targets),
           'attempt_retained_platform_post_ids', to_jsonb(v_retained),
           'attempt_started_at', p_expected_processing_started_at
         )
   WHERE id = p_post_id;

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

REVOKE ALL ON FUNCTION public.record_threads_image_checkpoint(uuid, uuid, jsonb, timestamptz, jsonb, uuid[], uuid[])
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_threads_image_checkpoint(uuid, uuid, jsonb, timestamptz, jsonb, uuid[], uuid[])
  TO service_role;

CREATE OR REPLACE FUNCTION public.record_threads_image_checkpoint(
  p_post_id uuid,
  p_social_account_id uuid,
  p_response_data jsonb,
  p_expected_processing_started_at timestamptz,
  p_expected_content jsonb
)
RETURNS uuid
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.record_threads_image_checkpoint(
    p_post_id,
    p_social_account_id,
    p_response_data,
    p_expected_processing_started_at,
    p_expected_content,
    NULL::uuid[],
    NULL::uuid[]
  );
$$;

REVOKE ALL ON FUNCTION public.record_threads_image_checkpoint(uuid, uuid, jsonb, timestamptz, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_threads_image_checkpoint(uuid, uuid, jsonb, timestamptz, jsonb)
  TO service_role;

-- Allow reconciler cron to recover terminal managed-image rows whose parent is
-- still processing, or whose final notification was lost before acknowledgement.
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
         AND coalesce((pp.response_data #>> '{deferred,claimed_until}')::timestamptz, '-infinity') <= now()
         AND (
           (
             p.status = 'processing'
             AND (pp.response_data #>> '{deferred,attempt_started_at}')::timestamptz IS NOT DISTINCT FROM p.processing_started_at
           )
           OR (
             p.status IN ('completed', 'failed')
             AND (pp.response_data #>> '{deferred,attempt_started_at}')::timestamptz IS NOT DISTINCT FROM p.processing_started_at
             AND (p.metadata #>> '{final_notification_intent,attempt_started_at}')::timestamptz IS NOT DISTINCT FROM p.processing_started_at
             AND (p.metadata #>> '{final_notification_intent,status}') = p.status
             AND p.metadata #>> '{final_notification_intent,notified}' = 'false'
             AND coalesce((p.metadata #>> '{final_notification_intent,claimed_until}')::timestamptz, '-infinity') <= now()
             AND (
               (p.metadata ->> 'final_notified_at') IS NULL
               OR (p.metadata ->> 'final_notified_at')::timestamptz < p.processing_started_at
             )
           )
         )
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
       jsonb_build_object(
         'claimed_until', now() + p_lease,
         'execution_id', NULL,
         'execution_claimed_until', NULL
       )
     )
    FROM due
   WHERE pp.id = due.id
  RETURNING pp.id AS platform_post_id, pp.post_id;
$$;

REVOKE ALL ON FUNCTION public.claim_deferred_publishes(integer, interval) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_deferred_publishes(integer, interval) TO service_role;

-- Atomically lease unconfirmed final notification intent for a managed image post
CREATE OR REPLACE FUNCTION public.claim_threads_image_notification(
  p_post_id uuid,
  p_expected_processing_started_at timestamptz,
  p_expected_status text,
  p_expected_content jsonb,
  p_lease interval DEFAULT interval '3 minutes'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_post public.posts%ROWTYPE;
  v_content jsonb;
  v_intent jsonb;
  v_claim_id uuid := gen_random_uuid();
  v_authorized_ids uuid[];
  v_result_statuses jsonb;
BEGIN
  IF p_post_id IS NULL OR p_expected_processing_started_at IS NULL OR p_expected_status IS NULL THEN
    RETURN jsonb_build_object('claimed', false, 'error', 'invalid_arguments');
  END IF;

  IF p_lease IS NULL OR p_lease <= interval '0' OR p_lease > interval '3 minutes' THEN
    RETURN jsonb_build_object('claimed', false, 'error', 'invalid_lease');
  END IF;

  SELECT * INTO v_post FROM public.posts WHERE id = p_post_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('claimed', false, 'error', 'post_not_found');
  END IF;

  IF v_post.processing_started_at IS DISTINCT FROM p_expected_processing_started_at
     OR v_post.status IS DISTINCT FROM p_expected_status THEN
    RETURN jsonb_build_object('claimed', false, 'status', v_post.status, 'error', 'cycle_or_status_mismatch');
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
    RETURN jsonb_build_object('claimed', false, 'status', v_post.status, 'error', 'content_mismatch');
  END IF;

  IF (v_post.metadata ->> 'final_notified_at') IS NOT NULL
     AND (v_post.metadata ->> 'final_notified_at')::timestamptz >= p_expected_processing_started_at THEN
    RETURN jsonb_build_object('claimed', false, 'status', v_post.status, 'error', 'already_notified');
  END IF;

  v_intent := v_post.metadata -> 'final_notification_intent';
  IF v_intent IS NULL THEN
    RETURN jsonb_build_object('claimed', false, 'status', v_post.status, 'error', 'no_intent');
  END IF;

  IF (v_intent ->> 'status') IS DISTINCT FROM p_expected_status
     OR (v_intent ->> 'attempt_started_at')::timestamptz IS DISTINCT FROM p_expected_processing_started_at
     OR coalesce((v_intent ->> 'notified')::boolean, false) = true THEN
    RETURN jsonb_build_object('claimed', false, 'status', v_post.status, 'error', 'intent_unusable');
  END IF;

  IF jsonb_typeof(v_intent -> 'authorized_platform_post_ids') IS DISTINCT FROM 'array'
     OR jsonb_array_length(v_intent -> 'authorized_platform_post_ids') = 0 THEN
    RETURN jsonb_build_object('claimed', false, 'status', v_post.status, 'error', 'invalid_result_scope');
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements_text(v_intent -> 'authorized_platform_post_ids') x
     WHERE x IS NULL OR x !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ) THEN
    RETURN jsonb_build_object('claimed', false, 'status', v_post.status, 'error', 'invalid_result_scope');
  END IF;
  SELECT array_agg(x::uuid) INTO v_authorized_ids
    FROM jsonb_array_elements_text(v_intent -> 'authorized_platform_post_ids') x;
  IF cardinality(v_authorized_ids) <> (SELECT count(DISTINCT x) FROM unnest(v_authorized_ids) x)
     OR (v_post.metadata ->> 'attempt_started_at')::timestamptz IS DISTINCT FROM p_expected_processing_started_at THEN
    RETURN jsonb_build_object('claimed', false, 'status', v_post.status, 'error', 'invalid_result_scope');
  END IF;
  -- Validate membership and capture result statuses in one database snapshot.
  SELECT jsonb_object_agg(pp.id::text, pp.status) INTO v_result_statuses
    FROM public.platform_posts pp
    JOIN public.social_accounts a ON a.id=pp.social_account_id AND a.user_id=v_post.user_id
   WHERE pp.id=ANY(v_authorized_ids) AND pp.post_id=p_post_id AND pp.status IN ('success','failed')
     AND (
       (pp.status='success' AND coalesce(v_post.metadata->'attempt_retained_platform_post_ids','[]'::jsonb) @> to_jsonb(ARRAY[pp.id]))
       OR (coalesce(v_post.metadata->'attempt_target_account_ids','[]'::jsonb) @> to_jsonb(ARRAY[pp.social_account_id])
           AND (pp.created_at>=p_expected_processing_started_at
                OR (pp.response_data #>> '{deferred,attempt_started_at}')::timestamptz=p_expected_processing_started_at))
     );
  IF (SELECT count(*) FROM jsonb_object_keys(coalesce(v_result_statuses,'{}'::jsonb))) <> cardinality(v_authorized_ids) THEN
    RETURN jsonb_build_object('claimed', false, 'status', v_post.status, 'error', 'invalid_result_scope');
  END IF;

  IF coalesce((v_intent ->> 'claimed_until')::timestamptz, '-infinity') > now() THEN
    RETURN jsonb_build_object('claimed', false, 'status', v_post.status, 'error', 'lease_held');
  END IF;

  UPDATE public.posts
     SET metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
           'final_notification_intent', v_intent || jsonb_build_object(
             'claimed_until', now() + p_lease,
              'claim_id', v_claim_id
           )
         )
   WHERE id = p_post_id;

  RETURN jsonb_build_object(
    'claimed', true,
    'status', v_post.status,
    'claim_id', v_claim_id,
    'authorized_platform_post_ids', v_intent -> 'authorized_platform_post_ids',
    'authorized_platform_post_statuses', v_result_statuses
  );
END;
$$;

REVOKE ALL ON FUNCTION public.claim_threads_image_notification(uuid, timestamptz, text, jsonb, interval)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_threads_image_notification(uuid, timestamptz, text, jsonb, interval)
  TO service_role;

-- Confirm final notification delivery after awaited external dispatch ACK or outbox emission
DROP FUNCTION IF EXISTS public.confirm_threads_image_notification(uuid, timestamptz, text, jsonb);
CREATE OR REPLACE FUNCTION public.confirm_threads_image_notification(
  p_post_id uuid,
  p_expected_processing_started_at timestamptz,
  p_expected_status text,
  p_expected_content jsonb,
  p_claim_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_post public.posts%ROWTYPE;
  v_content jsonb;
  v_intent jsonb;
BEGIN
  IF p_post_id IS NULL OR p_expected_processing_started_at IS NULL OR p_expected_status IS NULL OR p_claim_id IS NULL THEN
    RETURN jsonb_build_object('confirmed', false, 'error', 'invalid_arguments');
  END IF;

  SELECT * INTO v_post FROM public.posts WHERE id = p_post_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('confirmed', false, 'error', 'post_not_found');
  END IF;

  IF v_post.processing_started_at IS DISTINCT FROM p_expected_processing_started_at
     OR v_post.status IS DISTINCT FROM p_expected_status THEN
    RETURN jsonb_build_object('confirmed', false, 'status', v_post.status, 'error', 'cycle_or_status_mismatch');
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
    RETURN jsonb_build_object('confirmed', false, 'status', v_post.status, 'error', 'content_mismatch');
  END IF;

  v_intent := v_post.metadata -> 'final_notification_intent';
  IF v_intent IS NULL THEN
    RETURN jsonb_build_object('confirmed', false, 'status', v_post.status, 'error', 'no_intent');
  END IF;

  IF (v_intent ->> 'status') IS DISTINCT FROM p_expected_status
     OR (v_intent ->> 'attempt_started_at')::timestamptz IS DISTINCT FROM p_expected_processing_started_at
     OR (v_intent ->> 'claim_id')::uuid IS DISTINCT FROM p_claim_id THEN
    RETURN jsonb_build_object('confirmed', false, 'status', v_post.status, 'error', 'intent_owner_mismatch');
  END IF;
  IF v_intent ->> 'notified' = 'true' THEN
    RETURN jsonb_build_object('confirmed', true, 'status', v_post.status);
  END IF;
  IF coalesce((v_intent ->> 'claimed_until')::timestamptz, '-infinity') <= now() THEN
    RETURN jsonb_build_object('confirmed', false, 'status', v_post.status, 'error', 'lease_expired');
  END IF;

  UPDATE public.posts
     SET metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
           'final_notified_at', now(),
           'final_notification_intent', v_intent || jsonb_build_object(
             'notified', true,
             'notified_at', now(),
             'claimed_until', NULL
           )
         )
   WHERE id = p_post_id;

  RETURN jsonb_build_object('confirmed', true, 'status', v_post.status);
END;
$$;

REVOKE ALL ON FUNCTION public.confirm_threads_image_notification(uuid, timestamptz, text, jsonb, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.confirm_threads_image_notification(uuid, timestamptz, text, jsonb, uuid)
  TO service_role;

DROP FUNCTION IF EXISTS public.finalize_threads_image_attempt(uuid,timestamptz,jsonb);
DROP FUNCTION IF EXISTS public.finalize_threads_image_attempt(uuid,timestamptz,jsonb,uuid[]);

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
  v_retained_row_ids uuid[];
  v_authorized_row_ids uuid[];
BEGIN
  IF p_expected_processing_started_at IS NULL THEN RETURN NULL; END IF;

  SELECT * INTO v_post FROM public.posts WHERE id = p_post_id FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;

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
  IF v_post.processing_started_at IS DISTINCT FROM p_expected_processing_started_at
     OR v_content IS DISTINCT FROM jsonb_set(
       p_expected_content,
       '{metadata}',
       public.normalize_threads_internal_metadata(p_expected_content -> 'metadata'),
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
      'stale', NOT (v_post.status IN ('completed', 'failed')),
      'notify', false,
      'authorized_platform_post_ids', v_post.metadata #> '{final_notification_intent,authorized_platform_post_ids}'
    );
  END IF;

  -- Authoritative target scope resolution:
  -- 1) Persisted attempt scope stored under parent lock (if from current attempt)
  -- 2) Explicit caller argument
  -- 3) Metadata selected_account_ids
  -- 4) Fallback to active platform accounts
  IF (v_post.metadata ->> 'attempt_started_at')::timestamptz IS NOT DISTINCT FROM p_expected_processing_started_at
     AND jsonb_typeof(v_post.metadata -> 'attempt_target_account_ids') = 'array'
     AND jsonb_array_length(v_post.metadata -> 'attempt_target_account_ids') > 0 THEN
    SELECT array_agg(elem::uuid) INTO v_target_account_ids
      FROM jsonb_array_elements_text(v_post.metadata -> 'attempt_target_account_ids') AS elem;
    -- Explicit scope arguments must match frozen persisted scope; reject mismatch instead of override
    IF p_expected_account_ids IS NOT NULL AND cardinality(p_expected_account_ids) > 0 THEN
      IF (SELECT count(*) FROM unnest(p_expected_account_ids) x WHERE x NOT IN (SELECT unnest(v_target_account_ids))) > 0
         OR (SELECT count(*) FROM unnest(v_target_account_ids) x WHERE x NOT IN (SELECT unnest(p_expected_account_ids))) > 0
         OR cardinality(p_expected_account_ids) <> cardinality(v_target_account_ids) THEN
        RETURN jsonb_build_object('status', v_post.status, 'stale', true, 'notify', false, 'error', 'scope_mismatch');
      END IF;
    END IF;
  ELSIF p_expected_account_ids IS NOT NULL AND cardinality(p_expected_account_ids) > 0 THEN
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

  -- Retained successful platform post row IDs from prior attempt(s)
  IF (v_post.metadata ->> 'attempt_started_at')::timestamptz IS NOT DISTINCT FROM p_expected_processing_started_at
     AND jsonb_typeof(v_post.metadata -> 'attempt_retained_platform_post_ids') = 'array'
     AND jsonb_array_length(v_post.metadata -> 'attempt_retained_platform_post_ids') > 0 THEN
    SELECT array_agg(elem::uuid) INTO v_retained_row_ids
      FROM jsonb_array_elements_text(v_post.metadata -> 'attempt_retained_platform_post_ids') AS elem;
  ELSE
    v_retained_row_ids := ARRAY[]::uuid[];
  END IF;

  -- Verify each target account has a durable row created/deferred in the CURRENT attempt
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

  -- Count total, pending, and succeeded across this attempt + exact retained successes ONLY
  SELECT count(*),
         count(*) FILTER (WHERE status = 'pending'),
         count(*) FILTER (WHERE status = 'success')
    INTO v_total, v_pending, v_succeeded
    FROM public.platform_posts pp
   WHERE pp.post_id = p_post_id
     AND (
       (
         pp.social_account_id = ANY(v_target_account_ids)
         AND (
           pp.created_at >= p_expected_processing_started_at
           OR (pp.response_data #>> '{deferred,attempt_started_at}')::timestamptz = p_expected_processing_started_at
         )
       )
       OR (
         pp.id = ANY(v_retained_row_ids)
         AND pp.status = 'success'
       )
     );

  IF v_total = 0 THEN
    RETURN jsonb_build_object('status', v_post.status, 'stale', false, 'notify', false);
  END IF;

  IF v_pending > 0 THEN
    RETURN jsonb_build_object('status', 'processing', 'stale', false, 'notify', false);
  END IF;

  v_status := CASE WHEN v_succeeded > 0 THEN 'completed' ELSE 'failed' END;

  SELECT array_agg(pp.id) INTO v_authorized_row_ids
    FROM public.platform_posts pp
   WHERE pp.post_id = p_post_id
     AND (
       (
         pp.social_account_id = ANY(v_target_account_ids)
         AND (
           pp.created_at >= p_expected_processing_started_at
           OR (pp.response_data #>> '{deferred,attempt_started_at}')::timestamptz = p_expected_processing_started_at
         )
       )
       OR (
         pp.id = ANY(v_retained_row_ids)
         AND pp.status = 'success'
       )
     );

  -- Step 1: Update status. If transitioning to failed, trg_posts_invalidate_rollup fires and clears any old intent.
  UPDATE public.posts
     SET status = v_status,
         posted_at = CASE WHEN v_status = 'completed' THEN coalesce(posted_at, now()) ELSE posted_at END
   WHERE id = p_post_id;

  -- Step 2: Stage fresh final_notification_intent in a separate metadata-only update (does not fire BEFORE UPDATE OF status trigger).
  UPDATE public.posts
     SET metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
           'final_notification_intent', jsonb_build_object(
             'status', v_status,
             'attempt_started_at', p_expected_processing_started_at,
             'notified', false,
             'created_at', now(),
             'authorized_platform_post_ids', to_jsonb(v_authorized_row_ids)
           )
         )
   WHERE id = p_post_id;

  RETURN jsonb_build_object(
    'status', v_status,
    'stale', false,
    'notify', v_notify,
    'authorized_platform_post_ids', to_jsonb(v_authorized_row_ids)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.finalize_threads_image_attempt(uuid,timestamptz,jsonb,uuid[])
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_threads_image_attempt(uuid,timestamptz,jsonb,uuid[])
  TO service_role;

-- Atomically verify sibling rollup provenance and restore parent post to processing under lock
CREATE OR REPLACE FUNCTION public.restore_legacy_pending_post(
  p_post_id uuid,
  p_expected_processing_started_at timestamptz,
  p_expected_content jsonb,
  p_has_success boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_post public.posts%ROWTYPE;
  v_content jsonb;
BEGIN
  SELECT * INTO v_post
    FROM public.posts
   WHERE id = p_post_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('restored', false, 'reason', 'not_found');
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

  IF v_post.status = 'processing' AND v_post.processing_started_at IS NOT DISTINCT FROM p_expected_processing_started_at THEN
    IF p_has_success AND v_post.posted_at IS NULL THEN
      UPDATE public.posts
         SET posted_at = now()
       WHERE id = p_post_id;
    END IF;
    RETURN jsonb_build_object('restored', true, 'status', 'processing', 'already_processing', true);
  END IF;


  IF v_post.status NOT IN ('completed', 'failed') THEN
    RETURN jsonb_build_object('restored', false, 'reason', 'status_ineligible', 'current_status', v_post.status);
  END IF;

  IF NOT (v_post.metadata ? 'settlement_rollup_at') THEN
    RETURN jsonb_build_object('restored', false, 'reason', 'missing_rollup_provenance', 'current_status', v_post.status);
  END IF;

  IF (v_post.metadata ->> 'settlement_rollup_processing_started_at')::timestamptz IS DISTINCT FROM p_expected_processing_started_at
     OR (v_post.metadata ->> 'settlement_rollup_at')::timestamptz < p_expected_processing_started_at
     OR (v_post.metadata ->> 'settlement_rollup_status') IS DISTINCT FROM v_post.status THEN
    RETURN jsonb_build_object('restored', false, 'reason', 'rollup_attempt_mismatch', 'current_status', v_post.status);
  END IF;

  UPDATE public.posts
     SET status = 'processing',
         posted_at = CASE WHEN p_has_success THEN coalesce(v_post.posted_at, now()) ELSE v_post.posted_at END
   WHERE id = p_post_id;

  RETURN jsonb_build_object('restored', true, 'status', 'processing', 'prior_status', v_post.status);
END;
$$;

REVOKE ALL ON FUNCTION public.restore_legacy_pending_post(uuid, timestamptz, jsonb, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.restore_legacy_pending_post(uuid, timestamptz, jsonb, boolean) TO service_role;

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
      'metadata', public.normalize_threads_internal_metadata(v_post.metadata),
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
        public.normalize_threads_internal_metadata((v_row.response_data -> 'content_fence') -> 'metadata'),
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

  -- Suppress premature rollup if known target accounts have not yet settled
  IF jsonb_typeof(v_post.metadata -> 'attempt_target_account_ids') = 'array'
     AND jsonb_array_length(v_post.metadata -> 'attempt_target_account_ids') > 0 THEN
    IF (SELECT count(*) FROM unnest(ARRAY(
         SELECT jsonb_array_elements_text(v_post.metadata -> 'attempt_target_account_ids')::uuid
       )) AS target(id)
       WHERE NOT EXISTS (
         SELECT 1 FROM public.platform_posts pp2
          WHERE pp2.post_id = v_row.post_id AND pp2.social_account_id = target.id
            AND pp2.status IN ('success', 'failed')
       )) > 0 THEN
      v_rollup_parent := false;
    END IF;
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
           metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
             'settlement_rollup_at', now(),
             'settlement_rollup_status', v_post_state,
             'settlement_rollup_processing_started_at', v_post.processing_started_at
           )
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
