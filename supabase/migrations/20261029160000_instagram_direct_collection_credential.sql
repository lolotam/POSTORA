-- ===========================================================================
-- 20261029160000_instagram_direct_collection_credential.sql
--
-- The service-only reader of a DIRECT Instagram login token, for the owner
-- collection worker.
--
-- WHY THIS EXISTS
--
--   An Instagram account that logs in DIRECTLY keeps its operational token in
--   social_accounts.access_token. The account row is readable by the browser
--   roles, so the worker may not read that column: the browser-readable
--   column is not an authority, and a worker that reads it would be reading
--   a column that any session can see.
--
--   The protected Facebook User credential readers do not help here: a
--   direct account has no protected Facebook User binding at all. The
--   collector for this login kind therefore had no fenced way to obtain the
--   token, and every direct owner job ended in a permanent "unsupported"
--   outcome.
--
--   This migration adds ONE narrowly fenced reader. It is additive: no
--   existing function, table, grant or policy is changed.
--
-- THE CONTRACT
--
--   read_instagram_direct_collection_credential(
--     p_job_id uuid,
--     p_claim_token uuid,
--     p_job_generation bigint,
--     p_expected_credential_generation bigint
--   )
--
--   - The OWNER and the TARGET are derived ONLY from the fenced owner job.
--     There is no independent account or owner selector, so the caller
--     cannot redirect the read at another account.
--   - The claim is validated by the accepted fence
--     (ig_collection_load_fenced_job): the live lease, the claim token, the
--     job generation, the bound viewer context, the live credential
--     generation, the live login kind and an active, owned, Instagram
--     target.
--   - The target must be an OWNER job. A competitor job has no owner
--     account to collect for.
--   - The trusted capability must classify the account as login_kind
--     'direct'. A page-linked account keeps using the protected Facebook
--     User credential readers.
--   - The capability's credential generation must EQUAL the expected one.
--     A mismatch REFUSES: the read never adopts the current authority, so a
--     caller that captured a stale generation cannot read the newer token.
--   - The operational token is read only AFTER every check above, and it
--     must be a non-empty string.
--
--   It performs NO writes of any kind. It does not update the account, the
--   capability, the job, a timestamp, a progress row or a refresh capture.
--   It does not interact with the refresh lifecycle at all: a read is not a
--   refresh, and it must never look like one.
--
--   The answer carries only what the collection worker needs: the job id,
--   the owner user id, the social account id, the canonical Instagram user
--   id, the trusted login kind, the credential generation, the operational
--   access token and a nullable expiry. There is no refresh token, no
--   account metadata and no unrelated credential.
--
-- THE AUTHORITY IT ESTABLISHES
--
--   This read establishes authority AT THE READ. It cannot hold it
--   unchanged during the HTTP call that follows: the existing snapshot,
--   progress and completion fences all refuse a result whose captured
--   credential generation is no longer the live one, so a reconnect, a
--   refresh, a disconnect or an expired lease rejects everything the
--   provider answered.
--
-- THE REFUSALS
--
--   The refusals reuse the accepted fence's SQLSTATEs for the claim
--   problems (40001 stale claim, P0002 no such job, 22023 unusable
--   target) and add four typed ones of their own:
--
--     IDC01  a required argument is missing
--     IDC02  the job is not an owner job
--     IDC03  the trusted capability is not a direct login
--     IDC04  the credential generation moved on before the read
--     IDC05  there is no usable operational token
--
--   No refusal ever echoes the token, and no refusal message is a reason
--   code: the caller maps the SQLSTATE, never the text.
--
-- The house convention: RLS is not involved (the function is SECURITY
-- DEFINER and reads service-only relations), the search path is pinned,
-- the browser roles are revoked explicitly, and the service role is the
-- only role that may execute it.
-- ===========================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- The reader.
--
-- SECURITY DEFINER because the operational token lives in a relation the
-- browser roles may not read, and the fence helpers are SECURITY DEFINER
-- themselves.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.read_instagram_direct_collection_credential(
  p_job_id                        uuid,
  p_claim_token                   uuid,
  p_job_generation                bigint,
  p_expected_credential_generation bigint
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_job         public.instagram_collection_jobs%ROWTYPE;
  v_login_kind  text := NULL;
  v_generation  bigint := NULL;
  v_ig_user_id  text := NULL;
  v_token       text := NULL;
  v_expires     timestamptz := NULL;
BEGIN
  PERFORM public.ig_collection_assert_service_caller();

  IF p_job_id IS NULL
     OR p_claim_token IS NULL
     OR p_job_generation IS NULL
     OR p_expected_credential_generation IS NULL THEN
    RAISE EXCEPTION
      'IDC01: the job id, the claim token, the job generation and the expected credential generation are required'
      USING ERRCODE = 'IDC01';
  END IF;

  -- The fenced owner job. This is the ONLY source of the owner and of the
  -- target: the reader accepts no independent selector, so the caller
  -- cannot redirect it at another account.
  --
  -- The fence refuses a stale claim token, a wrong job generation, an
  -- expired lease, an unusable target, a missing or stale connection
  -- context and a replaced credential, before this function decides
  -- anything at all.
  v_job := public.ig_collection_load_fenced_job(
    p_job_id, p_claim_token, p_job_generation, true, NULL);

  IF v_job.target_kind IS DISTINCT FROM 'owner' THEN
    RAISE EXCEPTION
      'IDC02: this reader only serves an owner collection job'
      USING ERRCODE = 'IDC02';
  END IF;

  -- The trusted capability. It is the only authority for the login kind.
  SELECT c.login_kind, c.credential_generation
    INTO v_login_kind, v_generation
    FROM public.instagram_account_capabilities AS c
   WHERE c.social_account_id = v_job.social_account_id
     AND c.user_id = v_job.user_id;

  IF v_login_kind IS NULL THEN
    RAISE EXCEPTION
      'IDC03: the account has no trusted capability'
      USING ERRCODE = 'IDC03';
  END IF;

  IF v_login_kind IS DISTINCT FROM 'direct' THEN
    RAISE EXCEPTION
      'IDC03: the account does not log in to Instagram directly'
      USING ERRCODE = 'IDC03';
  END IF;

  -- The expected generation must be the LIVE one. A mismatch refuses; the
  -- read never adopts the current authority, because a caller that
  -- captured an older generation is asking for a token it is no longer
  -- entitled to.
  IF v_generation IS DISTINCT FROM p_expected_credential_generation THEN
    RAISE EXCEPTION
      'IDC04: the credential generation moved on before the read'
      USING ERRCODE = 'IDC04';
  END IF;

  -- The operational token. It is read only after every check above.
  SELECT sa.platform_user_id, sa.access_token, sa.token_expires_at
    INTO v_ig_user_id, v_token, v_expires
    FROM public.social_accounts AS sa
   WHERE sa.id = v_job.social_account_id
     AND sa.user_id = v_job.user_id
     AND sa.platform = 'instagram'
     AND sa.is_active
     AND NOT COALESCE(sa.needs_reauth, false);

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'IDC05: the target account is no longer usable'
      USING ERRCODE = 'IDC05';
  END IF;

  IF v_ig_user_id IS NULL OR btrim(v_ig_user_id) = '' THEN
    RAISE EXCEPTION
      'IDC05: the target account has no Instagram user id'
      USING ERRCODE = 'IDC05';
  END IF;

  IF v_token IS NULL OR btrim(v_token) = '' THEN
    RAISE EXCEPTION
      'IDC05: the target account has no operational token'
      USING ERRCODE = 'IDC05';
  END IF;

  RETURN jsonb_build_object(
    'job_id', v_job.id,
    'user_id', v_job.user_id,
    'social_account_id', v_job.social_account_id,
    'ig_user_id', v_ig_user_id,
    'login_kind', v_login_kind,
    'credential_generation', v_generation,
    'access_token', v_token,
    'token_expires_at', v_expires
  );
END;
$function$;

COMMENT ON FUNCTION public.read_instagram_direct_collection_credential(UUID, UUID, BIGINT, BIGINT) IS
  'Service-only. Reads the operational token of a DIRECT Instagram login for '
  'the owner of a fenced collection job. The owner and the target come from '
  'the fenced job alone: there is no account or owner selector. Refuses a '
  'stale claim, a wrong job generation, an expired lease, an unusable '
  'target, a missing connection context, a replaced credential, a '
  'page-linked capability and a credential generation that moved on. Writes '
  'nothing and does not touch the refresh lifecycle. Returns the job, the '
  'owner, the account, the Instagram user id, the login kind, the '
  'credential generation, the operational access token and a nullable '
  'expiry. No refresh token and no metadata.';

-- ---------------------------------------------------------------------------
-- The grants.
--
-- This stack carries ALTER DEFAULT PRIVILEGES ... GRANT ALL ON FUNCTIONS TO
-- anon, authenticated, so "REVOKE ... FROM PUBLIC" alone would leave both
-- browser roles holding EXECUTE. The roles are named explicitly.
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.read_instagram_direct_collection_credential(UUID, UUID, BIGINT, BIGINT) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.read_instagram_direct_collection_credential(UUID, UUID, BIGINT, BIGINT) TO service_role;

COMMIT;
