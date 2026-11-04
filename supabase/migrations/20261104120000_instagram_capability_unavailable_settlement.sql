-- ===========================================================================
-- 20261104120000_instagram_capability_unavailable_settlement.sql
--
-- The terminal settlement of an owner collection job whose bound account
-- never recorded its permission read.
--
-- WHY THIS EXISTS
--
--   complete_instagram_collection_job already accepts 'unavailable' with a
--   reason, but it first calls ig_collection_load_fenced_job with
--   p_require_context = true, and that fence raises
--   IG_COLLECTION_CAPABILITY_MISSING (22023) before any write when the bound
--   capability is not 'ok'. Such a job can be neither read nor settled: the
--   worker abandons it to its lease, every drain reclaims it, and its
--   attempts grow without a terminal status.
--
--   This migration adds ONE narrowly fenced settlement for exactly that
--   case. It is additive: no table, constraint, existing function, grant or
--   policy is changed.
--
-- THE CONTRACT
--
--   complete_instagram_collection_job_capability_unavailable(
--     p_job_id uuid, p_claim_token uuid, p_job_generation bigint)
--
--   - The reason is fixed, 'capability_missing', and is not a parameter, so
--     no other refusal can be settled through this path.
--   - The locks, the claim, the lease, the target and the rollout admission
--     come from the accepted fence itself (ig_collection_load_fenced_job with
--     p_require_context = false): the same lock order, the same LOCK_RETRY
--     loop and the same refusals. A disabled or ineligible job is NOT settled.
--   - The bound context is then checked exactly as the fence's
--     p_require_context branch does: context present, viewer active, viewer
--     not waiting for a reconnect.
--   - The capability is checked generation FIRST: an absent row, a credential
--     generation or a login kind other than the claimed one refuses with
--     IG_COLLECTION_CREDENTIAL_CHANGED (40001), so a reconnect never settles
--     the previous generation's job as missing evidence.
--   - A permission read that is 'ok' by now refuses with
--     IG_COLLECTION_CAPABILITY_RESOLVED (40001): the evidence landed, nothing
--     is written, and the job is left for a normal read.
--   - The write is the 'unavailable' branch of complete_instagram_collection_
--     job, and the answer has the same five keys.
--
--   The account rows are locked FOR UPDATE by the fence before the
--   capability is read, and write_instagram_account_capability takes the same
--   row lock first, so no capability write can land between this check and
--   this settlement.
--
--   It never writes instagram_account_capabilities, social_accounts or any
--   credential row.
--
-- The HTTP wrapper follows complete_instagram_collection_job_http: PostgREST
-- retries SQLSTATE 40001, so the named collection refusals, including the new
-- IG_COLLECTION_CAPABILITY_RESOLVED, are returned as PT409.
-- ===========================================================================

BEGIN;

DO $dependencies$ BEGIN
  PERFORM 'public.ig_collection_assert_service_caller()'::regprocedure;
  PERFORM 'public.ig_collection_reason_code(text)'::regprocedure;
  PERFORM 'public.ig_collection_load_fenced_job(uuid,uuid,bigint,boolean,uuid)'::regprocedure;
  PERFORM 'public.ig_collection_assert_lease_live(timestamptz)'::regprocedure;
  PERFORM 'public.complete_instagram_collection_job(uuid,uuid,bigint,text,text)'::regprocedure;
END $dependencies$;

CREATE FUNCTION public.complete_instagram_collection_job_capability_unavailable(
  p_job_id         uuid,
  p_claim_token    uuid,
  p_job_generation bigint
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_job        public.instagram_collection_jobs%ROWTYPE;
  v_reason     text := public.ig_collection_reason_code('capability_missing');
  v_active     boolean;
  v_reauth     boolean;
  v_live_gen   bigint;
  v_live_login text;
  v_read_state text;
BEGIN
  PERFORM public.ig_collection_assert_service_caller();

  -- The accepted fence: the parents and the job locked in the established
  -- order, the claim, the lease, the target and the rollout admission. The
  -- context is checked below, generation before state.
  v_job := public.ig_collection_load_fenced_job(
    p_job_id, p_claim_token, p_job_generation, false, NULL);

  -- The bound context, as the fence's p_require_context branch checks it.
  IF v_job.context_viewer_social_account_id IS NULL
     OR v_job.context_credential_generation IS NULL
     OR v_job.context_login_kind IS NULL THEN
    RAISE EXCEPTION
      'IG_COLLECTION_CONTEXT_MISSING: the job has no bound connection context'
      USING ERRCODE = '22023';
  END IF;

  SELECT sa.is_active, COALESCE(sa.needs_reauth, false)
    INTO v_active, v_reauth
    FROM public.social_accounts AS sa
   WHERE sa.id = v_job.context_viewer_social_account_id
     AND sa.user_id = v_job.user_id
     AND sa.platform = 'instagram';

  IF NOT FOUND OR NOT COALESCE(v_active, false) THEN
    RAISE EXCEPTION
      'IG_COLLECTION_VIEWER_INACTIVE: the viewer account is not active'
      USING ERRCODE = '22023';
  END IF;

  IF v_reauth THEN
    RAISE EXCEPTION
      'IG_COLLECTION_VIEWER_NEEDS_REAUTH: the viewer account needs to be reconnected'
      USING ERRCODE = '22023';
  END IF;

  -- The capability of the claimed generation. An absent row cannot be bound
  -- to the claimed generation, so it is refused like a replaced one.
  SELECT c.credential_generation, c.login_kind, c.permission_read_state
    INTO v_live_gen, v_live_login, v_read_state
    FROM public.instagram_account_capabilities AS c
   WHERE c.social_account_id = v_job.context_viewer_social_account_id;

  IF NOT FOUND
     OR v_live_gen IS DISTINCT FROM v_job.context_credential_generation
     OR v_live_login IS DISTINCT FROM v_job.context_login_kind THEN
    RAISE EXCEPTION
      'IG_COLLECTION_CREDENTIAL_CHANGED: the connection was replaced after this work was claimed'
      USING ERRCODE = '40001';
  END IF;

  IF v_read_state = 'ok' THEN
    RAISE EXCEPTION
      'IG_COLLECTION_CAPABILITY_RESOLVED: the bound account recorded its permission read after this work was claimed'
      USING ERRCODE = '40001';
  END IF;

  PERFORM public.ig_collection_assert_lease_live(v_job.lease_expires_at);

  -- The 'unavailable' branch of complete_instagram_collection_job. due_at,
  -- last_partial_at and last_success_at keep their values there too.
  UPDATE public.instagram_collection_jobs AS j
     SET status           = 'unavailable',
         retry_at         = NULL,
         lease_token      = NULL,
         lease_expires_at = NULL,
         last_reason_code = v_reason,
         updated_at       = now()
   WHERE j.id = p_job_id;

  RETURN jsonb_build_object(
    'job_id', p_job_id,
    'job_generation', v_job.job_generation,
    'status', 'unavailable',
    'outcome', 'unavailable',
    'reason_code', v_reason
  );
END;
$function$;

CREATE FUNCTION public.complete_instagram_collection_job_capability_unavailable_http(
  p_job_id uuid, p_claim_token uuid, p_job_generation bigint
)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path = public, pg_temp
AS $function$
BEGIN
  RETURN public.complete_instagram_collection_job_capability_unavailable(p_job_id,p_claim_token,p_job_generation);
EXCEPTION WHEN serialization_failure THEN
  IF split_part(SQLERRM, ':', 1) IN ('IG_COLLECTION_CLAIM_STALE','IG_COLLECTION_CREDENTIAL_CHANGED','IG_COLLECTION_LOCK_RETRY','IG_COLLECTION_CAPABILITY_RESOLVED') THEN
    RAISE EXCEPTION USING ERRCODE='PT409', MESSAGE='IG_COLLECTION_CLAIM_STALE: captured collection context is no longer current';
  END IF;
  RAISE;
END;
$function$;

REVOKE ALL ON FUNCTION public.complete_instagram_collection_job_capability_unavailable(uuid,uuid,bigint) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_instagram_collection_job_capability_unavailable_http(uuid,uuid,bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_instagram_collection_job_capability_unavailable(uuid,uuid,bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_instagram_collection_job_capability_unavailable_http(uuid,uuid,bigint) TO service_role;

COMMENT ON FUNCTION public.complete_instagram_collection_job_capability_unavailable(uuid,uuid,bigint) IS
  'Settles a claimed owner job as unavailable with the fixed reason '
  'capability_missing when its bound account never recorded a permission '
  'read. The accepted fence (without its context branch) locks and checks '
  'the claim, the lease, the target and the rollout admission; the bound '
  'context is then checked, the capability generation before its state. An '
  'absent or replaced capability refuses with IG_COLLECTION_CREDENTIAL_'
  'CHANGED, an ok read with IG_COLLECTION_CAPABILITY_RESOLVED. It never '
  'writes a capability, an account or a credential.';

COMMENT ON FUNCTION public.complete_instagram_collection_job_capability_unavailable_http(uuid,uuid,bigint) IS
  'The non-retrying PostgREST boundary of complete_instagram_collection_job_'
  'capability_unavailable. The named collection refusals, including '
  'IG_COLLECTION_CAPABILITY_RESOLVED, are returned as PT409; every other '
  'error is raised unchanged.';

NOTIFY pgrst, 'reload schema';
COMMIT;
