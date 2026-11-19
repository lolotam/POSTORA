-- ===========================================================================
-- YouTube token refresh DB lease (Stage 1c of the YouTube OAuth lifecycle).
--
-- Spec: docs/specs/2026-11-19-youtube-oauth-lifecycle-stages-1b-1d.md (Stage 1c)
-- Plan: docs/plans/2026-11-19-youtube-oauth-lifecycle-stages-1b-1d.md (Stage 1c)
-- Mirrors: 20261119130000_youtube_oauth_attempts.sql (separate service-only
--          table, RLS on with zero policies, SECURITY DEFINER RPCs with pinned
--          search_path, explicit REVOKE from PUBLIC/anon/authenticated).
--
-- WHY A SEPARATE TABLE (NOT COLUMNS ON social_accounts):
--   Adding lease columns to public.social_accounts would place operational
--   lock state inside a table that browser roles can read/update under RLS.
--   A dedicated public.youtube_token_refresh_leases table keeps RLS enabled
--   with zero browser policies and zero browser grants, so the write surface
--   of public.social_accounts does not widen.
--
-- APPLY AS supabase_admin. It is the migration role on this stack and the
-- superuser of the self-hosted image. A REVOKE issued by a non-owner is a
-- WARNING that changes nothing, so the role this runs as is load-bearing.
-- ===========================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Lease table: at most one refresh lease per social account.
-- ---------------------------------------------------------------------------
CREATE TABLE public.youtube_token_refresh_leases (
  social_account_id UUID PRIMARY KEY
                      REFERENCES public.social_accounts (id) ON DELETE CASCADE,
  lease_token       UUID NOT NULL,
  acquired_at       TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  expires_at        TIMESTAMPTZ NOT NULL,
  CONSTRAINT youtube_token_refresh_leases_deadline_check
    CHECK (expires_at > acquired_at)
);

CREATE INDEX idx_youtube_token_refresh_leases_expires_at
  ON public.youtube_token_refresh_leases (expires_at);

COMMENT ON TABLE public.youtube_token_refresh_leases IS
  'Service-only per-account lease serialising YouTube OAuth token refreshes. '
  'Kept separate from public.social_accounts so the owner write surface of '
  'social_accounts does not widen. Mutated only through the lease RPCs.';

-- ---------------------------------------------------------------------------
-- 2. acquire_youtube_refresh_lease
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.acquire_youtube_refresh_lease(
  p_account_id  UUID,
  p_ttl_seconds INTEGER DEFAULT 60
)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_account          RECORD;
  v_now              TIMESTAMPTZ := clock_timestamp();
  v_token            UUID;
  v_expires_at       TIMESTAMPTZ;
  v_acquired_token   UUID;
  v_acquired_expires TIMESTAMPTZ;
  v_held_expires     TIMESTAMPTZ;
BEGIN
  IF p_account_id IS NULL
     OR p_ttl_seconds IS NULL
     OR p_ttl_seconds < 5
     OR p_ttl_seconds > 600 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_request');
  END IF;

  SELECT sa.id, sa.platform, sa.auth_provider
    INTO v_account
    FROM public.social_accounts AS sa
   WHERE sa.id = p_account_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'account_not_found');
  END IF;

  IF v_account.platform <> 'youtube'
     OR COALESCE(v_account.auth_provider, 'native') = 'composio' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_account');
  END IF;

  v_token := gen_random_uuid();
  v_expires_at := v_now + make_interval(secs => p_ttl_seconds);

  -- Atomic insert-or-takeover: speculative insertion serialises concurrent
  -- first-time acquires, and EvalPlanQual re-evaluates the expiry guard
  -- against the committed row for concurrent expired-lease takeovers.
  INSERT INTO public.youtube_token_refresh_leases (
    social_account_id, lease_token, acquired_at, expires_at
  )
  VALUES (p_account_id, v_token, v_now, v_expires_at)
  ON CONFLICT (social_account_id) DO UPDATE
     SET lease_token = EXCLUDED.lease_token,
         acquired_at = EXCLUDED.acquired_at,
         expires_at  = EXCLUDED.expires_at
   WHERE public.youtube_token_refresh_leases.expires_at <= clock_timestamp()
  RETURNING lease_token, expires_at
  INTO v_acquired_token, v_acquired_expires;

  IF v_acquired_token IS NOT NULL THEN
    RETURN jsonb_build_object(
      'ok', true,
      'lease_token', v_acquired_token,
      'expires_at', v_acquired_expires
    );
  END IF;

  SELECT l.expires_at
    INTO v_held_expires
    FROM public.youtube_token_refresh_leases AS l
   WHERE l.social_account_id = p_account_id;

  -- Never return the live holder's lease_token.
  RETURN jsonb_build_object(
    'ok', false,
    'reason', 'lease_held',
    'expires_at', v_held_expires
  );
END
$function$;

COMMENT ON FUNCTION public.acquire_youtube_refresh_lease(UUID, INTEGER) IS
  'Service-only. Atomically acquires a per-account YouTube token refresh '
  'lease, taking over an expired lease if present. Returns {ok:true, '
  'lease_token, expires_at} or {ok:false, reason}.';

-- ---------------------------------------------------------------------------
-- 3. release_youtube_refresh_lease
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.release_youtube_refresh_lease(
  p_account_id  UUID,
  p_lease_token UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_deleted INTEGER;
BEGIN
  IF p_account_id IS NULL OR p_lease_token IS NULL THEN
    RETURN false;
  END IF;

  DELETE FROM public.youtube_token_refresh_leases
   WHERE social_account_id = p_account_id
     AND lease_token = p_lease_token;

  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted > 0;
END
$function$;

COMMENT ON FUNCTION public.release_youtube_refresh_lease(UUID, UUID) IS
  'Service-only. Releases a YouTube token refresh lease only when the '
  'caller presents the matching lease_token.';

-- ---------------------------------------------------------------------------
-- 4. store_youtube_refreshed_token_with_lease
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.store_youtube_refreshed_token_with_lease(
  p_account_id           UUID,
  p_lease_token          UUID,
  p_new_access_token     TEXT,
  p_new_token_expires_at TIMESTAMPTZ,
  p_new_refresh_token    TEXT DEFAULT NULL,
  p_granted_scopes       TEXT[] DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_lease public.youtube_token_refresh_leases%ROWTYPE;
BEGIN
  IF p_account_id IS NULL
     OR p_lease_token IS NULL
     OR p_new_access_token IS NULL
     OR btrim(p_new_access_token) = ''
     OR p_new_token_expires_at IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_request');
  END IF;

  SELECT l.*
    INTO v_lease
    FROM public.youtube_token_refresh_leases AS l
   WHERE l.social_account_id = p_account_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'lease_not_held');
  END IF;

  IF v_lease.lease_token <> p_lease_token THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'stale_lease');
  END IF;

  IF v_lease.expires_at <= clock_timestamp() THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'lease_expired');
  END IF;

  -- Credentials travel in the RPC body, never in PostgREST URL filters.
  -- Preserves stored refresh_token when Google omits a new one, and preserves
  -- unrelated account_metadata keys while updating granted_scopes if provided.
  UPDATE public.social_accounts
     SET access_token       = p_new_access_token,
         token_expires_at   = p_new_token_expires_at,
         refresh_token      = COALESCE(NULLIF(p_new_refresh_token, ''), refresh_token),
         needs_reauth       = false,
         failure_count      = 0,
         last_refresh_error = NULL,
         account_metadata   = CASE
           WHEN p_granted_scopes IS NOT NULL AND array_length(p_granted_scopes, 1) > 0
             THEN COALESCE(account_metadata, '{}'::jsonb)
                  || jsonb_build_object('granted_scopes', to_jsonb(p_granted_scopes))
           ELSE account_metadata
         END,
         updated_at         = clock_timestamp()
   WHERE id = p_account_id
     AND platform = 'youtube'
     AND COALESCE(auth_provider, 'native') <> 'composio';

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'account_not_found');
  END IF;

  DELETE FROM public.youtube_token_refresh_leases
   WHERE social_account_id = p_account_id
     AND lease_token = p_lease_token;

  RETURN jsonb_build_object('ok', true);
END
$function$;

COMMENT ON FUNCTION public.store_youtube_refreshed_token_with_lease(UUID, UUID, TEXT, TIMESTAMPTZ, TEXT, TEXT[]) IS
  'Service-only. Persists a refreshed YouTube token fenced on a live, '
  'matching lease_token, keeps the stored refresh_token when Google omits '
  'one, preserves unrelated account_metadata keys, and atomically releases '
  'the lease.';

-- ---------------------------------------------------------------------------
-- 5. record_youtube_refresh_failure_with_lease
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.record_youtube_refresh_failure_with_lease(
  p_account_id         UUID,
  p_lease_token        UUID,
  p_error_message      TEXT,
  p_is_invalid_grant   BOOLEAN DEFAULT FALSE,
  p_max_failures       INTEGER DEFAULT 3,
  p_last_alert_sent_at TIMESTAMPTZ DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_lease         public.youtube_token_refresh_leases%ROWTYPE;
  v_account       RECORD;
  v_next_failures INTEGER;
  v_escalate      BOOLEAN;
  v_reauth_res    JSONB;
BEGIN
  IF p_account_id IS NULL
     OR p_lease_token IS NULL
     OR p_error_message IS NULL
     OR btrim(p_error_message) = '' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_request');
  END IF;

  SELECT l.*
    INTO v_lease
    FROM public.youtube_token_refresh_leases AS l
   WHERE l.social_account_id = p_account_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'lease_not_held');
  END IF;

  IF v_lease.lease_token <> p_lease_token THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'stale_lease');
  END IF;

  IF v_lease.expires_at <= clock_timestamp() THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'lease_expired');
  END IF;

  SELECT sa.needs_reauth, sa.failure_count
    INTO v_account
    FROM public.social_accounts AS sa
   WHERE sa.id = p_account_id
     AND sa.platform = 'youtube'
     AND COALESCE(sa.auth_provider, 'native') <> 'composio'
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'account_not_found');
  END IF;

  v_next_failures := COALESCE(v_account.failure_count, 0) + 1;
  v_escalate := COALESCE(p_is_invalid_grant, false)
             OR v_next_failures >= GREATEST(1, COALESCE(p_max_failures, 3));

  v_reauth_res := public.partner_record_refresh_failure(
    p_account_id,
    v_next_failures,
    left(p_error_message, 500),
    v_escalate,
    p_last_alert_sent_at
  );

  DELETE FROM public.youtube_token_refresh_leases
   WHERE social_account_id = p_account_id
     AND lease_token = p_lease_token;

  RETURN jsonb_build_object(
    'ok', true,
    'needs_reauth', (v_escalate OR COALESCE(v_account.needs_reauth, false)),
    'failure_count', v_next_failures,
    'transitioned', COALESCE((v_reauth_res ->> 'transitioned')::boolean, false),
    'enqueued', COALESCE((v_reauth_res ->> 'enqueued')::integer, 0)
  );
END
$function$;

COMMENT ON FUNCTION public.record_youtube_refresh_failure_with_lease(UUID, UUID, TEXT, BOOLEAN, INTEGER, TIMESTAMPTZ) IS
  'Service-only. Records a YouTube refresh failure (including invalid_grant '
  '-> needs_reauth) fenced on a live, matching lease_token, emits partner '
  'reauth webhooks via partner_record_refresh_failure once, and atomically '
  'releases the lease.';

-- ---------------------------------------------------------------------------
-- 6. Privileges (load-bearing: stack has ALTER DEFAULT PRIVILEGES to browser
--    roles, so every REVOKE below is mandatory).
-- ---------------------------------------------------------------------------
ALTER TABLE public.youtube_token_refresh_leases ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.youtube_token_refresh_leases
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.youtube_token_refresh_leases TO service_role;

REVOKE ALL ON FUNCTION public.acquire_youtube_refresh_lease(UUID, INTEGER)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.release_youtube_refresh_lease(UUID, UUID)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.store_youtube_refreshed_token_with_lease(UUID, UUID, TEXT, TIMESTAMPTZ, TEXT, TEXT[])
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_youtube_refresh_failure_with_lease(UUID, UUID, TEXT, BOOLEAN, INTEGER, TIMESTAMPTZ)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.acquire_youtube_refresh_lease(UUID, INTEGER)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.release_youtube_refresh_lease(UUID, UUID)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.store_youtube_refreshed_token_with_lease(UUID, UUID, TEXT, TIMESTAMPTZ, TEXT, TEXT[])
  TO service_role;
GRANT EXECUTE ON FUNCTION public.record_youtube_refresh_failure_with_lease(UUID, UUID, TEXT, BOOLEAN, INTEGER, TIMESTAMPTZ)
  TO service_role;

-- ---------------------------------------------------------------------------
-- 7. Boundary self-check: fail the migration rather than ship an open door.
-- ---------------------------------------------------------------------------
DO $assert_boundary$
BEGIN
  ASSERT (SELECT c.relrowsecurity FROM pg_class AS c
           WHERE c.oid = 'public.youtube_token_refresh_leases'::regclass),
    'youtube_token_refresh_leases must have RLS enabled';
  ASSERT NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'youtube_token_refresh_leases'
  ), 'youtube_token_refresh_leases must carry no policy';
  ASSERT NOT EXISTS (
    SELECT 1 FROM pg_class c, aclexplode(c.relacl) x
     WHERE c.oid = 'public.youtube_token_refresh_leases'::regclass
       AND x.grantee = 0
  ), 'PUBLIC must hold no privilege on youtube_token_refresh_leases';
  ASSERT NOT has_table_privilege('authenticated', 'public.youtube_token_refresh_leases', 'SELECT')
     AND NOT has_table_privilege('anon', 'public.youtube_token_refresh_leases', 'SELECT'),
    'browser roles must not read youtube_token_refresh_leases';
  ASSERT NOT EXISTS (
    SELECT 1 FROM pg_proc p, aclexplode(p.proacl) x
     WHERE p.oid IN (
       'public.acquire_youtube_refresh_lease(uuid, integer)'::regprocedure,
       'public.release_youtube_refresh_lease(uuid, uuid)'::regprocedure,
       'public.store_youtube_refreshed_token_with_lease(uuid, uuid, text, timestamptz, text, text[])'::regprocedure,
       'public.record_youtube_refresh_failure_with_lease(uuid, uuid, text, boolean, integer, timestamptz)'::regprocedure)
       AND x.grantee = 0
  ), 'PUBLIC must hold no EXECUTE on the YouTube refresh lease RPCs';
  ASSERT (SELECT bool_and(p.prosecdef AND 'search_path=public, pg_temp' = ANY (p.proconfig))
            FROM pg_proc p
           WHERE p.oid IN (
             'public.acquire_youtube_refresh_lease(uuid, integer)'::regprocedure,
             'public.release_youtube_refresh_lease(uuid, uuid)'::regprocedure,
             'public.store_youtube_refreshed_token_with_lease(uuid, uuid, text, timestamptz, text, text[])'::regprocedure,
             'public.record_youtube_refresh_failure_with_lease(uuid, uuid, text, boolean, integer, timestamptz)'::regprocedure)),
    'every YouTube refresh lease RPC must be SECURITY DEFINER with pinned search_path';
END
$assert_boundary$;

COMMIT;
