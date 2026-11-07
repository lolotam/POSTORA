-- ===========================================================================
-- 20261106010000_instagram_claim_audits_only_refusals.sql
--
-- The claim audits a refused claim, never an idle queue.
--
-- THE INCIDENT
--
--   The competitor drain calls claim_instagram_collection_jobs every two
--   minutes. The claim wrote one ig_collection_rollout_audit row every time
--   it claimed nothing, so an idle queue produced a warn row every two
--   minutes: 1,082 rows between 2026-11-04 10:38 UTC and 2026-11-05, every
--   one of them with metadata.details = {"mode":"competitor","action":"claim",
--   "due_candidates":0,"excluded_candidates":0}. Nothing was refused. A
--   warning that fires on "nothing to do" buries the refusals that matter.
--
-- WHAT THIS CHANGES
--
--   The empty-claim block keeps its bounded aggregate count and writes the
--   audit row ONLY when that count says there WAS due work: v_due_total > 0.
--   The work existed and none of it was claimable - excluded by the policy,
--   or lost to a concurrent claim. An idle queue is silence, not a warning.
--
--   The reason codes keep their union. collection_not_eligible still means
--   the due work was excluded by the policy. collection_queue_empty now
--   means "due work existed and none of it was claimable", which is a
--   refusal and not an idle queue.
--
--   This migration replaces ONE function body (CREATE OR REPLACE) and issues
--   no revoke and no grant: the grants of 20261026150000 survive the
--   replacement. The candidate passes, the limits, the locks, the returned
--   set, the signature, the security attributes, the search_path and the
--   comment are the ones of 20261031090000.
-- ===========================================================================
BEGIN;

CREATE OR REPLACE FUNCTION public.claim_instagram_collection_jobs(
  p_target_kind text,
  p_limit       integer
)
RETURNS SETOF jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_limit       integer;
  v_fresh_cap   integer;
  v_pass2_limit integer;
  v_recovery_waiting boolean := false;
  v_lease       interval := interval '120 seconds';
  v_fresh_cutoff date;
  v_ids         uuid[] := ARRAY[]::uuid[];
  v_candidate   uuid;
  v_state       jsonb;
  v_status      text;
  v_mode        text;
  v_restrict    boolean := false;
  v_allowed_ids uuid[] := ARRAY[]::uuid[];
  v_due_total   bigint := 0;
  v_excluded    bigint := 0;
BEGIN
  PERFORM public.ig_collection_assert_service_caller();

  IF p_target_kind IS NULL OR p_target_kind NOT IN ('owner', 'competitor') THEN
    RAISE EXCEPTION
      'IG_COLLECTION_INVALID_TARGET_KIND: target kind must be owner or competitor'
      USING ERRCODE = '22023';
  END IF;

  -- The rollout state, read ONCE. A configuration that cannot be read is a
  -- typed failure, never an empty set: an empty set would look like an
  -- empty queue.
  v_state := public.ig_collection_rollout_state();
  v_status := v_state ->> 'status';

  IF v_status = 'settings_unavailable' THEN
    RAISE EXCEPTION
      'IG_COLLECTION_SETTINGS_UNAVAILABLE: the rollout configuration cannot be read'
      USING ERRCODE = '55000';
  END IF;

  IF v_status = 'collection_disabled' THEN
    PERFORM public.ig_collection_rollout_audit(jsonb_build_object(
      'event', 'collection_claim_refused',
      'reason_code', 'collection_disabled',
      'target_kind', p_target_kind,
      'details', jsonb_build_object('action', 'claim', 'mode', p_target_kind)));
    RETURN;
  END IF;

  IF p_target_kind = 'owner' THEN
    v_mode := v_state ->> 'owner_mode';
    v_allowed_ids := ARRAY(
      SELECT (jsonb_array_elements_text(v_state -> 'owner_ids'))::uuid);
  ELSE
    v_mode := v_state ->> 'competitor_mode';
    v_allowed_ids := ARRAY(
      SELECT (jsonb_array_elements_text(v_state -> 'competitor_ids'))::uuid);
  END IF;

  -- `all` admits every otherwise eligible target of that kind, so it
  -- carries no id filter. `off` and `allowlist` carry one, and `off`'s
  -- list is empty, so `off` admits nobody.
  v_restrict := (v_mode <> 'all');

  v_limit := LEAST(
    GREATEST(COALESCE(p_limit, 0), 1),
    CASE WHEN p_target_kind = 'owner' THEN 25 ELSE 50 END
  );
  v_fresh_cap := GREATEST(1, CEIL(v_limit * 0.6)::integer);
  v_fresh_cutoff := (now() AT TIME ZONE 'Asia/Kuwait')::date - 2;

  -- Bounded look for a finalize-only generation. A failed row, even one
  -- whose retry_at is still ahead, is open work and is not this case.
  SELECT EXISTS (
    SELECT 1
      FROM (
        SELECT j.id
          FROM public.instagram_collection_jobs AS j
         WHERE j.target_kind = p_target_kind
           AND j.status IN ('queued', 'retry', 'partial', 'leased')
           AND j.due_at <= now()
           AND (j.lease_token IS NULL OR j.lease_expires_at IS NULL
                OR j.lease_expires_at <= clock_timestamp())
           AND (NOT v_restrict OR j.target_id = ANY(v_allowed_ids))
           AND EXISTS (
             SELECT 1
               FROM public.instagram_collection_job_operations AS o
              WHERE o.job_id = j.id
                AND o.job_generation = j.job_generation)
           AND NOT EXISTS (
             SELECT 1
               FROM public.instagram_collection_job_operations AS o
              WHERE o.job_id = j.id
                AND o.job_generation = j.job_generation
                AND o.state IN ('pending', 'failed'))
         ORDER BY j.due_at ASC, j.id ASC
         LIMIT 500
      ) AS recovery_candidate
  ) INTO v_recovery_waiting;

  v_pass2_limit := v_limit - CASE
    WHEN v_recovery_waiting AND v_limit > 1 THEN 1
    ELSE 0
  END;

  -- Each pass scans a bounded candidate list and skips a busy parent.
  -- The bound is deliberate: NOWAIT cannot keep walking forever the way
  -- SKIP LOCKED did inside one statement. 500 is well above either cap.
  -- Pass 1: the reserved fresh share.
  FOR v_candidate IN
    SELECT j.id
      FROM public.instagram_collection_jobs AS j
     WHERE j.target_kind = p_target_kind
       AND j.status IN ('queued', 'retry', 'partial', 'leased')
       AND j.due_at <= now()
       AND (j.lease_token IS NULL OR j.lease_expires_at IS NULL
            OR j.lease_expires_at <= clock_timestamp())
       AND NOT (j.id = ANY(v_ids))
       AND (NOT v_restrict OR j.target_id = ANY(v_allowed_ids))
       AND (
         NOT EXISTS (
           SELECT 1 FROM public.instagram_collection_job_operations AS o
            WHERE o.job_id = j.id AND o.job_generation = j.job_generation)
         OR EXISTS (
           SELECT 1 FROM public.instagram_collection_job_operations AS o
            WHERE o.job_id = j.id
              AND o.job_generation = j.job_generation
              AND o.state IN ('pending', 'failed')
              AND (o.retry_at IS NULL OR o.retry_at <= now())
              AND (o.provider_date IS NULL OR o.provider_date >= v_fresh_cutoff))
       )
     ORDER BY j.due_at ASC, j.id ASC
     LIMIT 500
  LOOP
    EXIT WHEN COALESCE(array_length(v_ids, 1), 0) >= v_fresh_cap;
    IF public.ig_collection_try_claim_job(v_candidate, v_lease) THEN
      v_ids := v_ids || v_candidate;
    END IF;
  END LOOP;

  -- Pass 2: the oldest remaining eligible work, so old failures still run
  -- but never take every slot.
  FOR v_candidate IN
    SELECT j.id
      FROM public.instagram_collection_jobs AS j
     WHERE j.target_kind = p_target_kind
       AND j.status IN ('queued', 'retry', 'partial', 'leased')
       AND j.due_at <= now()
       AND (j.lease_token IS NULL OR j.lease_expires_at IS NULL
            OR j.lease_expires_at <= clock_timestamp())
       AND NOT (j.id = ANY(v_ids))
       AND (NOT v_restrict OR j.target_id = ANY(v_allowed_ids))
       AND (
         NOT EXISTS (
           SELECT 1 FROM public.instagram_collection_job_operations AS o
            WHERE o.job_id = j.id AND o.job_generation = j.job_generation)
         OR EXISTS (
           SELECT 1 FROM public.instagram_collection_job_operations AS o
            WHERE o.job_id = j.id
             AND o.job_generation = j.job_generation
             AND o.state IN ('pending', 'failed')
             AND (o.retry_at IS NULL OR o.retry_at <= now()))
       )
     ORDER BY j.due_at ASC, j.id ASC
     LIMIT 500
  LOOP
    EXIT WHEN COALESCE(array_length(v_ids, 1), 0) >= v_pass2_limit;
    IF public.ig_collection_try_claim_job(v_candidate, v_lease) THEN
      v_ids := v_ids || v_candidate;
    END IF;
  END LOOP;

  -- Pass 3: finalize a generation that has only terminal operations.
  -- The claim helper still applies the connection check, so a changed
  -- credential bumps the generation and leaves the old rows as history.
  FOR v_candidate IN
    SELECT j.id
      FROM public.instagram_collection_jobs AS j
     WHERE j.target_kind = p_target_kind
       AND j.status IN ('queued', 'retry', 'partial', 'leased')
       AND j.due_at <= now()
       AND (j.lease_token IS NULL OR j.lease_expires_at IS NULL
            OR j.lease_expires_at <= clock_timestamp())
       AND NOT (j.id = ANY(v_ids))
       AND (NOT v_restrict OR j.target_id = ANY(v_allowed_ids))
       AND EXISTS (
         SELECT 1
           FROM public.instagram_collection_job_operations AS o
          WHERE o.job_id = j.id
            AND o.job_generation = j.job_generation)
       AND NOT EXISTS (
         SELECT 1
           FROM public.instagram_collection_job_operations AS o
          WHERE o.job_id = j.id
            AND o.job_generation = j.job_generation
            AND o.state IN ('pending', 'failed'))
     ORDER BY j.due_at ASC, j.id ASC
     LIMIT 500
  LOOP
    EXIT WHEN COALESCE(array_length(v_ids, 1), 0) >= v_limit;
    IF public.ig_collection_try_claim_job(v_candidate, v_lease) THEN
      v_ids := v_ids || v_candidate;
    END IF;
  END LOOP;

  -- An empty claim is not silently empty. One bounded aggregate row says
  -- whether the queue held no due work at all, or whether the due work was
  -- excluded by the policy. The counts are the distinction; there is never
  -- one row per excluded job.
  --
  -- The row is written only when there WAS due work. An idle queue is
  -- silence, not a warning: the competitor drain ticks every two minutes,
  -- and one row per idle tick buried the refusals that matter (1,082 rows
  -- between 2026-11-04 and 2026-11-05). collection_queue_empty therefore
  -- means "due work existed and none of it was claimable": excluded by the
  -- policy, or lost to a concurrent claim.
  IF COALESCE(array_length(v_ids, 1), 0) = 0 THEN
    SELECT count(*),
           count(*) FILTER (
             WHERE v_restrict AND NOT (j.target_id = ANY(v_allowed_ids)))
      INTO v_due_total, v_excluded
      FROM public.instagram_collection_jobs AS j
     WHERE j.target_kind = p_target_kind
       AND j.status IN ('queued', 'retry', 'partial', 'leased')
       AND j.due_at <= now()
       AND (j.lease_token IS NULL OR j.lease_expires_at IS NULL
            OR j.lease_expires_at <= clock_timestamp());

    IF v_due_total > 0 THEN
      PERFORM public.ig_collection_rollout_audit(jsonb_build_object(
        'event', 'collection_claim_refused',
        'reason_code', CASE WHEN v_excluded > 0 THEN 'collection_not_eligible' ELSE 'collection_queue_empty' END,
        'target_kind', p_target_kind,
        'details', jsonb_build_object(
          'action', 'claim',
          'mode', p_target_kind,
          'due_candidates', v_due_total,
          'excluded_candidates', v_excluded)));
    END IF;
  END IF;

  RETURN QUERY
  SELECT jsonb_build_object(
    'job_id', j.id,
    'user_id', j.user_id,
    'target_kind', j.target_kind,
    'target_id', j.target_id,
    'social_account_id', j.social_account_id,
    'watchlist_id', j.watchlist_id,
    'captured_on', j.captured_on,
    'job_generation', j.job_generation,
    'claim_token', j.lease_token,
    'lease_expires_at', j.lease_expires_at,
    'attempts', j.attempts,
    'context', jsonb_build_object(
      'viewer_social_account_id', j.context_viewer_social_account_id,
      'credential_generation', j.context_credential_generation,
      'login_kind', j.context_login_kind,
      'capability_present', COALESCE(cap.info ->> 'capability_present', 'false')::boolean,
      'permission_read_state', cap.info ->> 'permission_read_state',
      'granted_scopes', COALESCE(cap.info -> 'granted_scopes', '[]'::jsonb)
    ),
    'checkpoint', COALESCE(ck.info, '{}'::jsonb),
    'pending_operations', COALESCE(ops.info, '[]'::jsonb),
    'claimed_at', now()
  )
  FROM public.instagram_collection_jobs AS j
  LEFT JOIN LATERAL (
    SELECT jsonb_build_object(
      'capability_present', (c.social_account_id IS NOT NULL),
      'permission_read_state', c.permission_read_state,
      'granted_scopes', COALESCE(to_jsonb(c.granted_scopes), '[]'::jsonb)
    ) AS info
      FROM (SELECT 1) AS one
      LEFT JOIN public.instagram_account_capabilities AS c
             ON c.social_account_id = j.context_viewer_social_account_id
  ) AS cap ON true
  LEFT JOIN LATERAL (
    SELECT to_jsonb(cp) - 'id' - 'job_id' - 'user_id' - 'job_generation' AS info
      FROM public.instagram_collection_job_checkpoints AS cp
     WHERE cp.job_id = j.id AND cp.job_generation = j.job_generation
  ) AS ck ON true
  LEFT JOIN LATERAL (
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'operation_key', o.operation_key,
             'operation_kind', o.operation_kind,
             'provider_date', o.provider_date,
             'query_kind', o.query_kind,
             'state', o.state,
             'attempts', o.attempts,
             'retry_at', o.retry_at,
             'reason_code', o.reason_code
           ) ORDER BY o.provider_date NULLS FIRST, o.operation_key), '[]'::jsonb) AS info
      FROM (
        SELECT o2.operation_key, o2.operation_kind, o2.provider_date, o2.query_kind,
               o2.state, o2.attempts, o2.retry_at, o2.reason_code
          FROM public.instagram_collection_job_operations AS o2
         WHERE o2.job_id = j.id
           AND o2.job_generation = j.job_generation
           AND o2.state IN ('pending', 'failed')
         ORDER BY o2.provider_date NULLS FIRST, o2.operation_key
         LIMIT 200
      ) AS o
  ) AS ops ON true
  WHERE j.id = ANY(v_ids)
  ORDER BY j.due_at ASC, j.id ASC;
END;
$function$;

COMMENT ON FUNCTION public.claim_instagram_collection_jobs(text, integer) IS
  'Atomically claims due work with SKIP LOCKED, at most 25 owner jobs and '
  '50 competitor jobs per call. A reserved share of the slots goes to fresh '
  'work so an old persistent failure cannot occupy every tick. Every '
  'candidate pass applies the rollout admission BEFORE its candidate '
  'limit, so excluded work cannot starve an eligible job, and the '
  'admission is rechecked under the parent -> job locks before the claim.';

NOTIFY pgrst, 'reload schema';
COMMIT;
