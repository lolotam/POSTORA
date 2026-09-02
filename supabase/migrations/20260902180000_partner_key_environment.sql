-- Partner API Phase 10.5: environment-bound keys (staging vs production).
--
-- PRD §45: "Partner credentials are environment-specific. A staging key must
-- never authenticate against production." A future staging environment will be
-- created by RESTORING A PRODUCTION DATABASE DUMP, so the control must hold
-- even when the presented key's hash is present in the table. Two layers, both
-- answering the same non-enumerable invalid_key: the door's prefix check
-- before any lookup, and this column's value after it. Either alone is
-- insufficient — a hand-inserted row can lie about its prefix, and a restored
-- dump proves a prefix match is not enough.
--
-- Expand-only and idempotent. Existing rows default to production, which is
-- their truth: the only deployment today IS production.

-- ---------------------------------------------------------------------------
-- 1. The column and its CHECK.
-- ---------------------------------------------------------------------------
ALTER TABLE public.partner_api_keys
  ADD COLUMN IF NOT EXISTS environment TEXT NOT NULL DEFAULT 'production';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'partner_api_keys_environment_chk'
  ) THEN
    ALTER TABLE public.partner_api_keys
      ADD CONSTRAINT partner_api_keys_environment_chk
      CHECK (environment IN ('staging', 'production'));
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. The prefix ↔ environment rule, in exactly one place.
-- ---------------------------------------------------------------------------
-- pk_live_ is production and pk_test_ is staging; anything else is not a
-- credential shape this system mints. Both minting functions below consult
-- this rather than carrying their own copy, so the two cannot drift.
CREATE OR REPLACE FUNCTION public.partner_key_environment_for_prefix(p_key_prefix TEXT)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
AS $$
BEGIN
  IF p_key_prefix LIKE 'pk\_live\_%' THEN RETURN 'production'; END IF;
  IF p_key_prefix LIKE 'pk\_test\_%' THEN RETURN 'staging'; END IF;
  RAISE EXCEPTION 'key prefix must start with pk_live_ or pk_test_'
    USING ERRCODE = 'check_violation';
END;
$$;

REVOKE ALL ON FUNCTION public.partner_key_environment_for_prefix(TEXT)
  FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. create_partner_key gains p_environment, appended LAST with a default.
-- ---------------------------------------------------------------------------
-- CREATE OR REPLACE with a different parameter list does NOT replace a
-- function: it creates a second overload. Two overloads that both accept the
-- deployed 10-argument call make that call "not unique" and every existing
-- caller fails. So the old overload is dropped and the new one created in one
-- transaction; the deployed code's call resolves to the new function through
-- its default, and the audit and binding writes are unchanged.
--
-- THE PLAINTEXT SECRET NEVER ENTERS THE DATABASE (lifecycle migration §3): the
-- caller passes only the prefix and the hash, and nothing below may ever carry
-- the key itself.
BEGIN;

DROP FUNCTION IF EXISTS public.create_partner_key(
  UUID, UUID, TEXT, TEXT, TEXT, TEXT[], INTEGER, INTEGER, TIMESTAMPTZ, TEXT
);

CREATE OR REPLACE FUNCTION public.create_partner_key(
  p_workspace_id       UUID,
  p_social_account_id  UUID,
  p_name               TEXT,
  p_key_prefix         TEXT,
  p_key_hash           TEXT,
  p_scopes             TEXT[],
  p_rate_limit_per_min INTEGER DEFAULT 60,
  p_monthly_quota      INTEGER DEFAULT NULL,
  p_expires_at         TIMESTAMPTZ DEFAULT NULL,
  p_request_id         TEXT DEFAULT NULL,
  p_environment        TEXT DEFAULT 'production'
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_key_id UUID;
BEGIN
  IF NOT public.partner_caller_may_manage_keys(p_workspace_id) THEN
    RAISE EXCEPTION 'not authorized to create partner keys in this workspace'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_key_hash IS NULL OR length(p_key_hash) <> 64 THEN
    -- A 64-char hex SHA-256 digest. Anything else is either a plaintext key
    -- reaching the database or a caller that forgot to hash -- both are
    -- credential-handling failures, not validation nits.
    RAISE EXCEPTION 'key_hash must be a 64-character SHA-256 hex digest'
      USING ERRCODE = 'check_violation';
  END IF;

  IF p_environment IS NULL OR p_environment NOT IN ('staging', 'production') THEN
    RAISE EXCEPTION 'environment must be staging or production'
      USING ERRCODE = 'check_violation';
  END IF;
  -- The prefix is what the door checks before any lookup, so a row whose
  -- prefix disagrees with its environment would be a key one door mints and
  -- the other accepts. Refused at the mint, where it is a caller bug.
  IF public.partner_key_environment_for_prefix(p_key_prefix) <> p_environment THEN
    RAISE EXCEPTION 'key prefix % does not belong to environment %', p_key_prefix, p_environment
      USING ERRCODE = 'check_violation';
  END IF;

  -- Both inserts and the audit row share this function's single transaction:
  -- a failure at any point leaves no key, no binding and no trail, rather than
  -- the orphaned key F3 describes.
  INSERT INTO public.partner_api_keys (
    workspace_id, social_account_id, created_by, name, key_prefix, key_hash,
    scopes, rate_limit_per_min, monthly_quota, expires_at, environment
  ) VALUES (
    p_workspace_id, p_social_account_id, auth.uid(), p_name, p_key_prefix,
    p_key_hash, COALESCE(p_scopes, '{}'), p_rate_limit_per_min, p_monthly_quota,
    p_expires_at, p_environment
  )
  RETURNING id INTO v_key_id;

  -- created_by is stamped from auth.uid() above and is deliberately NOT a
  -- parameter: an actor a caller can choose is an actor a caller can forge,
  -- and the audit trail's only value is that it cannot be.

  INSERT INTO public.partner_api_key_accounts (key_id, social_account_id, workspace_id)
  VALUES (v_key_id, p_social_account_id, p_workspace_id);

  INSERT INTO public.partner_audit_logs (workspace_id, key_id, actor_id, action, request_id, metadata)
  VALUES (
    p_workspace_id, v_key_id, auth.uid(), 'create', p_request_id,
    jsonb_build_object(
      'key_prefix', p_key_prefix,
      'scopes', to_jsonb(COALESCE(p_scopes, '{}')),
      'social_account_id', p_social_account_id,
      'expires_at', p_expires_at,
      'environment', p_environment
    )
  );

  RETURN v_key_id;
END;
$$;

REVOKE ALL ON FUNCTION public.create_partner_key(
  UUID, UUID, TEXT, TEXT, TEXT, TEXT[], INTEGER, INTEGER, TIMESTAMPTZ, TEXT, TEXT
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_partner_key(
  UUID, UUID, TEXT, TEXT, TEXT, TEXT[], INTEGER, INTEGER, TIMESTAMPTZ, TEXT, TEXT
) TO authenticated;

COMMIT;

-- ---------------------------------------------------------------------------
-- 4. rotate_partner_key: the successor inherits its predecessor's environment.
-- ---------------------------------------------------------------------------
-- Same signature, so this IS a replacement. The body is the lifecycle
-- migration's, with two additions marked "10.5": the prefix agreement check
-- and the inherited column. A rotation can never move a key between
-- environments — there is no parameter that could ask for it.
CREATE OR REPLACE FUNCTION public.rotate_partner_key(
  p_key_id          UUID,
  p_new_key_prefix  TEXT,
  p_new_key_hash    TEXT,
  p_overlap_minutes INTEGER DEFAULT 60,
  p_request_id      TEXT DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_old       public.partner_api_keys%ROWTYPE;
  v_new_id    UUID;
  v_deadline  TIMESTAMPTZ;
BEGIN
  -- FOR UPDATE: two concurrent rotations of the same key would otherwise both
  -- pass the "already superseded" check and mint two successors, leaving one
  -- of them unreachable from the chain and its predecessor's pointer
  -- arbitrary.
  SELECT * INTO v_old FROM public.partner_api_keys WHERE id = p_key_id FOR UPDATE;

  IF NOT FOUND THEN
    -- Same answer as "exists but you may not touch it", so key ids are not
    -- enumerable by a member of another workspace.
    RAISE EXCEPTION 'no such partner key' USING ERRCODE = 'no_data_found';
  END IF;
  IF NOT public.partner_caller_may_manage_keys(v_old.workspace_id) THEN
    RAISE EXCEPTION 'no such partner key' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_old.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'cannot rotate a revoked key' USING ERRCODE = 'check_violation';
  END IF;
  IF v_old.superseded_by_key_id IS NOT NULL THEN
    RAISE EXCEPTION 'key has already been rotated' USING ERRCODE = 'check_violation';
  END IF;
  IF v_old.expires_at IS NOT NULL AND v_old.expires_at <= now() THEN
    RAISE EXCEPTION 'cannot rotate an expired key' USING ERRCODE = 'check_violation';
  END IF;

  -- Bounds, both ends load-bearing:
  --   0 is allowed and means an immediate cutover -- a legitimate choice when
  --     a key is known to have leaked and no downtime is worse than the leak.
  --   43200 minutes (30 days) is the ceiling. An overlap is a window in which
  --     a possibly-compromised credential still works; an unbounded one is
  --     indistinguishable from never rotating, while a negative one would
  --     expire the predecessor in the past and silently make rotation a
  --     revocation.
  IF p_overlap_minutes IS NULL OR p_overlap_minutes < 0 OR p_overlap_minutes > 43200 THEN
    RAISE EXCEPTION 'overlap_minutes must be between 0 and 43200 (30 days)'
      USING ERRCODE = 'check_violation';
  END IF;
  IF p_new_key_hash IS NULL OR length(p_new_key_hash) <> 64 THEN
    RAISE EXCEPTION 'new_key_hash must be a 64-character SHA-256 hex digest'
      USING ERRCODE = 'check_violation';
  END IF;
  -- 10.5: the successor's prefix must belong to the predecessor's environment.
  IF public.partner_key_environment_for_prefix(p_new_key_prefix) <> v_old.environment THEN
    RAISE EXCEPTION 'key prefix % does not belong to environment %', p_new_key_prefix, v_old.environment
      USING ERRCODE = 'check_violation';
  END IF;

  -- ROTATION NEVER EXTENDS AN EXPIRY. If the predecessor was deliberately
  -- time-boxed to sooner than the overlap would reach, the earlier deadline
  -- wins. Extending it would be a capability grant -- silently lengthening the
  -- life of a credential someone chose to limit -- performed as a side effect
  -- of an operation nobody thinks of as granting anything.
  v_deadline := LEAST(
    now() + make_interval(mins => p_overlap_minutes),
    COALESCE(v_old.expires_at, 'infinity'::TIMESTAMPTZ)
  );

  INSERT INTO public.partner_api_keys (
    workspace_id, social_account_id, created_by, name, key_prefix, key_hash,
    scopes, rate_limit_per_min, monthly_quota, expires_at, environment
  ) VALUES (
    v_old.workspace_id, v_old.social_account_id, auth.uid(), v_old.name,
    p_new_key_prefix, p_new_key_hash, v_old.scopes, v_old.rate_limit_per_min,
    v_old.monthly_quota,
    -- The successor inherits the predecessor's own expiry, not the overlap
    -- deadline: the overlap bounds the OLD secret, not the new credential.
    v_old.expires_at,
    -- 10.5: and its environment, always.
    v_old.environment
  )
  RETURNING id INTO v_new_id;

  -- Every binding moves, or the new key would authenticate and then reach
  -- nothing (D4: the binding is what a key may act on).
  INSERT INTO public.partner_api_key_accounts (key_id, social_account_id, workspace_id)
  SELECT v_new_id, a.social_account_id, a.workspace_id
    FROM public.partner_api_key_accounts a
   WHERE a.key_id = p_key_id;

  UPDATE public.partner_api_keys
     SET expires_at = v_deadline,
         superseded_by_key_id = v_new_id,
         updated_at = now()
   WHERE id = p_key_id;

  INSERT INTO public.partner_audit_logs (workspace_id, key_id, actor_id, action, request_id, metadata)
  VALUES (
    v_old.workspace_id, p_key_id, auth.uid(), 'rotate', p_request_id,
    jsonb_build_object(
      'successor_key_id', v_new_id,
      'requested_overlap_minutes', p_overlap_minutes,
      -- The RESOLVED deadline, not just the request: when LEAST() clamped the
      -- overlap to a pre-existing expiry, the audit must show what actually
      -- happened rather than what was asked for.
      'overlap_expires_at', v_deadline,
      'predecessor_expires_at_before', v_old.expires_at
    )
  );

  INSERT INTO public.partner_audit_logs (workspace_id, key_id, actor_id, action, request_id, metadata)
  VALUES (
    v_old.workspace_id, v_new_id, auth.uid(), 'create', p_request_id,
    jsonb_build_object(
      'key_prefix', p_new_key_prefix,
      'rotated_from_key_id', p_key_id,
      'scopes', to_jsonb(v_old.scopes),
      'environment', v_old.environment
    )
  );

  RETURN v_new_id;
END;
$$;

REVOKE ALL ON FUNCTION public.rotate_partner_key(UUID, TEXT, TEXT, INTEGER, TEXT)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rotate_partner_key(UUID, TEXT, TEXT, INTEGER, TEXT)
  TO authenticated;
