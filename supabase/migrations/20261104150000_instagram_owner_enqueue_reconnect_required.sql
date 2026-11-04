-- An owner Instagram sync request is refused with reconnect_required when the
-- account has no usable capability record.
--
-- The worker takes an owner job's connection context from
-- instagram_account_capabilities when it claims the job. An account without a
-- row (connected before capability probing existed) gets a job with no
-- context, which the worker abandons as context_missing: the request was
-- answered "queued" for work that can never run. The request now says so up
-- front, before the throttle window is spent and before any job is written.
--
-- Only the owner path changes. Competitor requests, the daily service enqueue
-- and the public wrapper enqueue_instagram_collection_job are unchanged.

CREATE OR REPLACE FUNCTION public.enqueue_instagram_collection_job_for_user(p_user_id uuid,
  p_target_kind text,
  p_target_id   uuid,
  p_mode        text DEFAULT 'normal'
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_owner       uuid;
  v_target      jsonb;
  v_mode        text := lower(COALESCE(p_mode, 'normal'));
  v_captured_on date;
  v_accepted    timestamptz;
  v_last        timestamptz;
  v_job_id      uuid;
  v_generation  bigint;
  v_status      text;
  v_inserted    boolean := false;
  v_existed     boolean := false;
  v_allowed     jsonb;
  v_reason      text;
BEGIN
  IF p_user_id IS NULL THEN RAISE EXCEPTION 'IG_COLLECTION_UNAUTHORIZED' USING ERRCODE='42501'; END IF;

  IF p_target_kind IS NULL OR p_target_kind NOT IN ('owner', 'competitor') THEN
    RAISE EXCEPTION
      'IG_COLLECTION_INVALID_TARGET_KIND: target kind must be owner or competitor'
      USING ERRCODE = '22023';
  END IF;

  IF p_target_id IS NULL THEN
    RAISE EXCEPTION
      'IG_COLLECTION_INVALID_TARGET: a target id is required'
      USING ERRCODE = '22023';
  END IF;

  IF v_mode NOT IN ('normal', 'force') THEN
    RAISE EXCEPTION
      'IG_COLLECTION_INVALID_MODE: mode must be normal or force'
      USING ERRCODE = '22023';
  END IF;

  v_owner := p_user_id;
  v_captured_on := (now() AT TIME ZONE 'Asia/Kuwait')::date;

  v_target := public.ig_collection_resolve_target(v_owner, p_target_kind, p_target_id);

  -- The owner is verified against the target row first. A foreign or
  -- missing target is indistinguishable from one that never existed.
  IF NOT COALESCE((v_target ->> 'found')::boolean, false) THEN
    RAISE EXCEPTION
      'IG_COLLECTION_TARGET_NOT_FOUND: no such Instagram target for this user'
      USING ERRCODE = 'P0002';
  END IF;

  IF NOT COALESCE((v_target ->> 'is_active')::boolean, false) THEN
    RAISE EXCEPTION
      'IG_COLLECTION_TARGET_INACTIVE: the target is not active'
      USING ERRCODE = 'P0002';
  END IF;

  -- The rollout decision. It comes before the throttle, so a refusal
  -- never spends the accepted-request window.
  v_allowed := public.ig_collection_rollout_target_allowed(
    v_owner, p_target_kind, p_target_id, NULL);

  IF NOT COALESCE((v_allowed ->> 'allowed')::boolean, false) THEN
    v_reason := v_allowed ->> 'reason_code';

    PERFORM public.ig_collection_rollout_audit(jsonb_build_object(
      'event', 'collection_enqueue_refused',
      'reason_code', v_reason,
      'user_id', v_owner,
      'target_kind', p_target_kind,
      'target_id', p_target_id,
      'details', jsonb_build_object('actor', 'owner', 'mode', v_mode)));

    RETURN jsonb_build_object(
      'accepted', false,
      'refused', true,
      'reason_code', v_reason,
      'captured_on', v_captured_on
    );
  END IF;

  -- An owner job takes its connection context from the account's capability
  -- record when it is claimed. Without a usable record the job could only be
  -- abandoned, so the request is refused before the throttle is spent.
  IF p_target_kind = 'owner' AND NOT EXISTS (
       SELECT 1 FROM public.instagram_account_capabilities AS c
        WHERE c.social_account_id = (v_target ->> 'social_account_id')::uuid
          AND c.credential_generation IS NOT NULL) THEN
    PERFORM public.ig_collection_rollout_audit(jsonb_build_object(
      'event', 'collection_enqueue_refused',
      'reason_code', 'reconnect_required',
      'user_id', v_owner,
      'target_kind', p_target_kind,
      'target_id', p_target_id,
      'details', jsonb_build_object('actor', 'owner', 'mode', v_mode)));

    RETURN jsonb_build_object(
      'accepted', false,
      'refused', true,
      'reason_code', 'reconnect_required',
      'captured_on', v_captured_on
    );
  END IF;

  -- The accepted-request window. It is consumed before anything is
  -- written, and the whole transaction rolls back if the enqueue fails,
  -- so a refused enqueue never burns the window.
  v_accepted := public.ig_collection_throttle_accept(
    'user_request', v_owner, p_target_kind, p_target_id, interval '15 minutes');

  IF v_accepted IS NULL THEN
    v_last := public.ig_collection_throttle_last_accepted(
      'user_request', p_target_kind, p_target_id);

    RETURN jsonb_build_object(
      'accepted', false,
      'reason', 'throttled',
      'retry_after_seconds', GREATEST(
        0,
        CEIL(EXTRACT(EPOCH FROM ((v_last + interval '15 minutes') - now())))::integer),
      'captured_on', v_captured_on
    );
  END IF;

  -- Whether the row already existed, so the answer can say 'created' or
  -- 'already_enqueued' honestly.
  SELECT EXISTS (
           SELECT 1 FROM public.instagram_collection_jobs AS j
            WHERE j.user_id = v_owner
              AND j.target_kind = p_target_kind
              AND j.target_id = p_target_id
              AND j.captured_on = v_captured_on)
    INTO v_existed;

  IF v_mode = 'force' THEN
    INSERT INTO public.instagram_collection_jobs AS j (
      user_id, target_kind, target_id, social_account_id, watchlist_id,
      captured_on, job_generation, status, due_at, attempts
    )
    VALUES (
      v_owner, p_target_kind, p_target_id,
      (v_target ->> 'social_account_id')::uuid,
      (v_target ->> 'watchlist_id')::uuid,
      v_captured_on, 1, 'queued', now(), 0
    )
    ON CONFLICT (user_id, target_kind, target_id, captured_on) DO UPDATE
       SET job_generation   = j.job_generation + 1,
           status           = 'queued',
           due_at           = now(),
           retry_at         = NULL,
           lease_token      = NULL,
           lease_expires_at = NULL,
           attempts         = 0,
           last_reason_code = NULL,
           -- The new revision starts with no connection context; the worker
           -- captures it again when it claims the work.
           context_viewer_social_account_id = NULL,
           context_credential_generation    = NULL,
           context_login_kind               = NULL,
           updated_at       = now()
    RETURNING j.id, j.job_generation, j.status INTO v_job_id, v_generation, v_status;
  ELSE
    INSERT INTO public.instagram_collection_jobs AS j (
      user_id, target_kind, target_id, social_account_id, watchlist_id,
      captured_on, job_generation, status, due_at, attempts
    )
    VALUES (
      v_owner, p_target_kind, p_target_id,
      (v_target ->> 'social_account_id')::uuid,
      (v_target ->> 'watchlist_id')::uuid,
      v_captured_on, 1, 'queued', now(), 0
    )
    ON CONFLICT (user_id, target_kind, target_id, captured_on) DO NOTHING
    RETURNING j.id, j.job_generation, j.status INTO v_job_id, v_generation, v_status;

    IF v_job_id IS NULL THEN
      SELECT j.id, j.job_generation, j.status
        INTO v_job_id, v_generation, v_status
        FROM public.instagram_collection_jobs AS j
       WHERE j.user_id = v_owner
         AND j.target_kind = p_target_kind
         AND j.target_id = p_target_id
         AND j.captured_on = v_captured_on;
    END IF;
  END IF;

  v_inserted := NOT v_existed;

  RETURN jsonb_build_object(
    'accepted', true,
    'reason', CASE WHEN v_mode = 'force' THEN 'forced'
                   WHEN v_inserted THEN 'enqueued'
                   ELSE 'already_enqueued' END,
    'job_id', v_job_id,
    'job_generation', v_generation,
    'status', v_status,
    'captured_on', v_captured_on,
    'created', v_inserted,
    'accepted_at', v_accepted
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.enqueue_instagram_collection_job_for_user(uuid, text, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_instagram_collection_job_for_user(uuid, text, uuid, text) TO service_role;
