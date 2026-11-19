-- ===========================================================================
-- YouTube token refresh lease fixes (review round on 20261120110000).
--
-- 20261120110000 is ALREADY APPLIED on production and immutable. Every change
-- here is CREATE OR REPLACE of its functions plus one new trigger; nothing
-- from the earlier migration is edited.
--
-- Fixes three review findings on the lease migration:
--
--   F  acquire_youtube_refresh_lease stamped acquired_at/expires_at from a
--      clock captured BEFORE the conflicting-row lock wait, so a contender
--      that waited for an uncommitted acquirer took over with a lease window
--      that had already partly elapsed — a lease born partly expired. The
--      expiry decision is now made on the locked row and both stamps are
--      written from fresh clock_timestamp() calls captured after the wait.
--
--   G  store_youtube_refreshed_token_with_lease and
--      record_youtube_refresh_failure_with_lease locked the lease row before
--      the account row. Account deletion locks the account row first and then
--      cascades to the lease row, so the two orders could deadlock head-to-head.
--      Both write RPCs now lock the account row first, then the lease row,
--      then check token and deadline.
--
--   E  a reconnect updates the social_accounts row IN PLACE and keeps the id,
--      so a refresh started with the OLD credentials could hold a valid lease
--      and write a stale token onto the new connection, or escalate a stale
--      invalid_grant onto it. An AFTER UPDATE OF access_token, refresh_token
--      trigger now deletes the account's lease row whenever either credential
--      column actually changed, so the stale holder's next write answers
--      lease_not_held. The store RPC's own sequence stays safe: it updates the
--      token (the trigger deletes the lease mid-flight) and then deletes its
--      own lease again as a no-op.
--
-- APPLY AS supabase_admin, the migration role of this stack, exactly like
-- 20261120110000.
-- ===========================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. F: acquire takes its deadline decision on the locked row and writes
--      post-wait stamps.
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
  v_token            UUID;
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

  -- Serialize on the ACCOUNT row FIRST, before the lease row is inspected or
  -- any clock is sampled — the same account-before-lease order the write RPCs
  -- use (deletion order). Two concurrent first-time acquires queue here, so
  -- the loser of a first insert waits BEFORE it forms its row: its stamps are
  -- captured after the wait, and a rival that rolls back can never leave it a
  -- lease born already expired.
  SELECT sa.id, sa.platform, sa.auth_provider
    INTO v_account
    FROM public.social_accounts AS sa
   WHERE sa.id = p_account_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'account_not_found');
  END IF;

  IF v_account.platform <> 'youtube'
     OR COALESCE(v_account.auth_provider, 'native') = 'composio' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_account');
  END IF;

  -- Serialise on any existing lease row BEFORE the deadline decision. The
  -- lock is held until this transaction ends, so everything below decides on
  -- committed state, and a contender that waited is never billed for the
  -- wait: its stamps are captured after this point, not at entry.
  SELECT l.expires_at
    INTO v_held_expires
    FROM public.youtube_token_refresh_leases AS l
   WHERE l.social_account_id = p_account_id
   FOR UPDATE;

  IF v_held_expires IS NOT NULL AND v_held_expires > clock_timestamp() THEN
    -- Never return the live holder's lease_token.
    RETURN jsonb_build_object(
      'ok', false,
      'reason', 'lease_held',
      'expires_at', v_held_expires
    );
  END IF;

  v_token := gen_random_uuid();

  -- Atomic insert-or-takeover from fresh clocks. On the conflict path (a
  -- concurrent first-time acquirer won the row between our locked read and
  -- this insert, or an expired lease is taken over) EvalPlanQual re-evaluates
  -- the expiry guard against the committed row and both stamps below are
  -- captured HERE, after the wait.
  INSERT INTO public.youtube_token_refresh_leases (
    social_account_id, lease_token, acquired_at, expires_at
  )
  VALUES (
    p_account_id,
    v_token,
    clock_timestamp(),
    clock_timestamp() + make_interval(secs => p_ttl_seconds)
  )
  ON CONFLICT (social_account_id) DO UPDATE
     SET lease_token = EXCLUDED.lease_token,
         acquired_at = clock_timestamp(),
         expires_at  = clock_timestamp() + make_interval(secs => p_ttl_seconds)
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

  RETURN jsonb_build_object(
    'ok', false,
    'reason', 'lease_held',
    'expires_at', v_held_expires
  );
END
$function$;

COMMENT ON FUNCTION public.acquire_youtube_refresh_lease(UUID, INTEGER) IS
  'Service-only. Atomically acquires a per-account YouTube token refresh '
  'lease, taking over an expired lease if present. The expiry decision runs '
  'on the locked lease row and the stamps are captured after the lock wait, '
  'so a contender that waited is never handed a pre-elapsed window. Returns '
  '{ok:true, lease_token, expires_at} or {ok:false, reason}.';

-- ---------------------------------------------------------------------------
-- 2. G: both write RPCs lock the ACCOUNT row before the lease row, matching
--      the deletion order (account row, then cascade to the lease row).
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
  v_account_id UUID;
  v_lease      public.youtube_token_refresh_leases%ROWTYPE;
BEGIN
  IF p_account_id IS NULL
     OR p_lease_token IS NULL
     OR p_new_access_token IS NULL
     OR btrim(p_new_access_token) = ''
     OR p_new_token_expires_at IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_request');
  END IF;

  -- Lock the ACCOUNT row first. A deletion locks the account row and then
  -- cascades to the lease; taking the same order here is what keeps this
  -- write and a concurrent delete from deadlocking head-to-head. With the
  -- account row locked, the reconnect fence (the credential-change trigger)
  -- cannot land between our checks and the write below.
  SELECT sa.id
    INTO v_account_id
    FROM public.social_accounts AS sa
   WHERE sa.id = p_account_id
     AND sa.platform = 'youtube'
     AND COALESCE(sa.auth_provider, 'native') <> 'composio'
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'account_not_found');
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
  -- The credential-change trigger fires on this UPDATE and deletes the lease
  -- row mid-flight; the delete below stays as the unconditional closer.
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
  'matching lease_token, locks the account row before the lease row '
  '(deletion order), keeps the stored refresh_token when Google omits one, '
  'preserves unrelated account_metadata keys, and atomically releases the '
  'lease.';

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

  -- Account row first, lease row second: the deletion order (finding G). The
  -- health columns are read under the same lock they are written under.
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
  '-> needs_reauth) fenced on a live, matching lease_token, locks the account '
  'row before the lease row (deletion order), emits partner reauth webhooks '
  'via partner_record_refresh_failure once, and atomically releases the '
  'lease.';

-- ---------------------------------------------------------------------------
-- 3. E: the reconnect fence. A reconnect keeps the social_accounts id, so a
--      refresh holding a lease under the OLD credentials must find its lease
--      gone the moment either credential column actually changes.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.delete_youtube_refresh_lease_on_credential_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  -- The WHEN clause already scoped this to credential-changing updates of
  -- youtube rows; the delete is unconditional within that scope. SECURITY
  -- DEFINER because the lease table grants no DELETE to any caller role:
  -- the fence is the one place a credential write may revoke a lease.
  DELETE FROM public.youtube_token_refresh_leases
   WHERE social_account_id = NEW.id;

  RETURN NEW;
END
$function$;

COMMENT ON FUNCTION public.delete_youtube_refresh_lease_on_credential_change() IS
  'Trigger function: revokes the YouTube token refresh lease of a '
  'social_accounts row the moment its access_token or refresh_token actually '
  'changes, so a refresh that started under the old credentials writes '
  'nothing onto the new connection (its next write answers lease_not_held). '
  'SECURITY DEFINER with a pinned search_path; browser roles hold no EXECUTE.';

DROP TRIGGER IF EXISTS trg_social_accounts_youtube_credential_revoke_refresh_lease
  ON public.social_accounts;

CREATE TRIGGER trg_social_accounts_youtube_credential_revoke_refresh_lease
AFTER UPDATE OF access_token, refresh_token ON public.social_accounts
FOR EACH ROW
WHEN (NEW.platform = 'youtube'
      AND (NEW.access_token IS DISTINCT FROM OLD.access_token
           OR NEW.refresh_token IS DISTINCT FROM OLD.refresh_token))
EXECUTE FUNCTION public.delete_youtube_refresh_lease_on_credential_change();

COMMENT ON TRIGGER trg_social_accounts_youtube_credential_revoke_refresh_lease
  ON public.social_accounts IS
  'Fires only for youtube rows whose access_token or refresh_token actually '
  'changed (IS DISTINCT FROM), e.g. an in-place reconnect that keeps the row '
  'id. Deletes the row''s youtube_token_refresh_leases entry so the stale '
  'lease holder cannot persist credentials it read before the reconnect. '
  'Health-only updates (needs_reauth, failure_count) keep the lease.';

REVOKE ALL ON FUNCTION public.delete_youtube_refresh_lease_on_credential_change()
  FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. Privileges of the replaced functions are restated so this file stays
--    self-contained and load-bearing the same way 20261120110000 is.
-- ---------------------------------------------------------------------------
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
-- 5. Boundary self-check: fail the migration rather than ship an open door or
--    a silently dropped fix.
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
  ASSERT (SELECT bool_and(COALESCE(p.prosecdef AND 'search_path=public, pg_temp' = ANY (p.proconfig), false))
            FROM pg_proc p
           WHERE p.oid IN (
             'public.acquire_youtube_refresh_lease(uuid, integer)'::regprocedure,
             'public.release_youtube_refresh_lease(uuid, uuid)'::regprocedure,
             'public.store_youtube_refreshed_token_with_lease(uuid, uuid, text, timestamptz, text, text[])'::regprocedure,
             'public.record_youtube_refresh_failure_with_lease(uuid, uuid, text, boolean, integer, timestamptz)'::regprocedure)),
    'every YouTube refresh lease RPC must be SECURITY DEFINER with pinned search_path';

  -- The reconnect fence must exist and stay sealed.
  ASSERT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'public.social_accounts'::regclass
       AND tgname = 'trg_social_accounts_youtube_credential_revoke_refresh_lease'
       AND NOT tgisinternal
  ), 'the YouTube credential-change lease fence trigger must exist on social_accounts';
  ASSERT (
    SELECT position('UPDATE OF access_token, refresh_token' in pg_get_triggerdef(t.oid)) > 0
      FROM pg_trigger t
     WHERE t.tgrelid = 'public.social_accounts'::regclass
       AND t.tgname = 'trg_social_accounts_youtube_credential_revoke_refresh_lease'
  ), 'the fence trigger must fire on UPDATE OF access_token, refresh_token';
  ASSERT (
    SELECT position('IS DISTINCT FROM' in pg_get_triggerdef(t.oid)) > 0
       AND position('youtube' in pg_get_triggerdef(t.oid)) > 0
      FROM pg_trigger t
     WHERE t.tgrelid = 'public.social_accounts'::regclass
       AND t.tgname = 'trg_social_accounts_youtube_credential_revoke_refresh_lease'
  ), 'the fence trigger must guard on actual credential change (IS DISTINCT FROM) of youtube rows';
  ASSERT (
    SELECT p.prosecdef AND 'search_path=public, pg_temp' = ANY (p.proconfig)
      FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
     WHERE t.tgrelid = 'public.social_accounts'::regclass
       AND t.tgname = 'trg_social_accounts_youtube_credential_revoke_refresh_lease'
  ), 'the fence trigger function must be SECURITY DEFINER with pinned search_path';
  ASSERT NOT EXISTS (
    SELECT 1 FROM pg_proc p, aclexplode(p.proacl) x
     WHERE p.oid = 'public.delete_youtube_refresh_lease_on_credential_change()'::regprocedure
       AND x.grantee IN (0,
         (SELECT oid FROM pg_roles WHERE rolname = 'anon'),
         (SELECT oid FROM pg_roles WHERE rolname = 'authenticated'))
  ), 'browser roles and PUBLIC must hold no EXECUTE on the fence trigger function';
END
$assert_boundary$;

COMMIT;
