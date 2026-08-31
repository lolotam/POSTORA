-- Partner API credential lifecycle (deliverable 1.3, decision D12).
--
-- ===========================================================================
-- WHAT THIS CLOSES
-- ===========================================================================
-- partner_audit_logs was built with append-only grants, a tenancy trigger and
-- 32 assertions proving nothing can be written across workspaces -- and
-- NOTHING WRITES TO IT AT ALL (threat review F11). create-partner-key.ts
-- writes no audit row and does not set created_by; revoke_partner_key()
-- appends no revocation event. The credential lifecycle is unauditable today.
--
-- Separately (F3 residual), key creation is TWO inserts -- the key row, then
-- the binding row -- and the script cannot clean up after a partial failure,
-- because least-privilege leaves service_role no UPDATE on partner_api_keys
-- and revoke_partner_key() is auth.uid()-scoped. A crash between the two
-- leaves a key with no binding.
--
-- Both become single atomic functions below.
--
-- ===========================================================================
-- WHY ROTATION ADDS ALMOST NO SCHEMA
-- ===========================================================================
-- expires_at already exists and authenticatePartnerKey already enforces it,
-- returning a typed key_expired (_shared/partnerApiKeys.ts). A rotation
-- therefore sets the OLD key's expires_at to the end of the overlap window.
--
-- The alternative -- a rotation_overlap_expires_at column plus a new branch in
-- the auth path -- would create a SECOND way for a key to be invalid, and the
-- two can disagree: a key past its overlap but not its expiry, or the reverse,
-- and someone has to decide which wins. Reusing expires_at makes rotation a
-- WRITE rather than a new RULE, and leaves "is this key still valid" decided
-- in exactly one place that already has tests.
--
-- All additive. Safe to apply to a live database.

-- ---------------------------------------------------------------------------
-- 1. The successor pointer
-- ---------------------------------------------------------------------------

ALTER TABLE public.partner_api_keys
  ADD COLUMN IF NOT EXISTS superseded_by_key_id UUID;

-- Composite, like every other tenancy FK on these tables: a key may only ever
-- be superseded by a key in the SAME workspace. A single-column FK would allow
-- workspace A's key to name workspace B's key as its successor, which is a
-- cross-tenant reference even though it grants no access by itself.
--
-- ON DELETE SET NULL, and specifically SET NULL on ONE COLUMN:
--
--   * CASCADE would be catastrophic and backwards. This FK is SELF-referential
--     -- unlike every other FK on these tables -- so "cascade" would mean
--     deleting the SUCCESSOR deletes the PREDECESSOR. Removing a new key would
--     silently erase the history of the key it replaced.
--   * RESTRICT would block a workspace deletion. workspace_id cascades, so
--     deleting a workspace removes these rows in an order Postgres chooses;
--     a predecessor still pointing at a not-yet-deleted successor would abort
--     the whole cascade.
--   * Plain SET NULL would fail outright: a composite FK's default SET NULL
--     nulls EVERY referencing column, and workspace_id is NOT NULL. The
--     column list (Postgres 15+) is what makes this legal, and it is the
--     reason this clause looks unusual.
--
-- Losing the pointer costs nothing that matters: partner_audit_logs holds the
-- durable rotation record, and it carries no FK to partner_api_keys precisely
-- so the trail outlives the rows.
ALTER TABLE public.partner_api_keys
  ADD CONSTRAINT partner_api_keys_successor_in_workspace
  FOREIGN KEY (superseded_by_key_id, workspace_id)
  REFERENCES public.partner_api_keys (id, workspace_id)
  ON DELETE SET NULL (superseded_by_key_id);

-- A key superseding itself would make rotation a no-op that still reports
-- success, and would make the chain a cycle for anyone walking it.
ALTER TABLE public.partner_api_keys
  ADD CONSTRAINT partner_api_keys_not_self_superseding
  CHECK (superseded_by_key_id IS NULL OR superseded_by_key_id <> id);

-- Finding a key's predecessor is how an operator answers "what replaced the
-- credential that leaked". Partial, because the column is NULL for every key
-- that has never been rotated, which is nearly all of them.
CREATE INDEX IF NOT EXISTS partner_api_keys_successor_idx
  ON public.partner_api_keys (superseded_by_key_id)
  WHERE superseded_by_key_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. Shared authorisation predicate
-- ---------------------------------------------------------------------------
-- Same membership rule revoke_partner_key() already uses. Factored out so the
-- three lifecycle functions cannot drift into three different definitions of
-- "may manage credentials".
CREATE OR REPLACE FUNCTION public.partner_caller_may_manage_keys(p_workspace_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.workspace_members m
     WHERE m.workspace_id = p_workspace_id
       AND m.user_id = auth.uid()
       AND m.role IN ('owner', 'admin')
  );
$$;

REVOKE ALL ON FUNCTION public.partner_caller_may_manage_keys(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.partner_caller_may_manage_keys(UUID) TO authenticated;

-- ---------------------------------------------------------------------------
-- 3. Creation -- closes F3
-- ---------------------------------------------------------------------------
-- THE PLAINTEXT SECRET NEVER ENTERS THE DATABASE. The caller generates the key
-- and its SHA-256 digest (generatePartnerKey in _shared/partnerApiKeys.ts) and
-- passes only the prefix and the hash. No parameter here, and no audit
-- metadata field written below, may ever carry the key itself.
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
  p_request_id         TEXT DEFAULT NULL
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

  -- Both inserts and the audit row share this function's single transaction:
  -- a failure at any point leaves no key, no binding and no trail, rather than
  -- the orphaned key F3 describes.
  INSERT INTO public.partner_api_keys (
    workspace_id, social_account_id, created_by, name, key_prefix, key_hash,
    scopes, rate_limit_per_min, monthly_quota, expires_at
  ) VALUES (
    p_workspace_id, p_social_account_id, auth.uid(), p_name, p_key_prefix,
    p_key_hash, COALESCE(p_scopes, '{}'), p_rate_limit_per_min, p_monthly_quota,
    p_expires_at
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
      'expires_at', p_expires_at
    )
  );

  RETURN v_key_id;
END;
$$;

REVOKE ALL ON FUNCTION public.create_partner_key(
  UUID, UUID, TEXT, TEXT, TEXT, TEXT[], INTEGER, INTEGER, TIMESTAMPTZ, TEXT
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_partner_key(
  UUID, UUID, TEXT, TEXT, TEXT, TEXT[], INTEGER, INTEGER, TIMESTAMPTZ, TEXT
) TO authenticated;

-- ---------------------------------------------------------------------------
-- 4. Rotation -- the D12 requirement
-- ---------------------------------------------------------------------------
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
    scopes, rate_limit_per_min, monthly_quota, expires_at
  ) VALUES (
    v_old.workspace_id, v_old.social_account_id, auth.uid(), v_old.name,
    p_new_key_prefix, p_new_key_hash, v_old.scopes, v_old.rate_limit_per_min,
    v_old.monthly_quota,
    -- The successor inherits the predecessor's own expiry, not the overlap
    -- deadline: the overlap bounds the OLD secret, not the new credential.
    v_old.expires_at
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
      'scopes', to_jsonb(v_old.scopes)
    )
  );

  RETURN v_new_id;
END;
$$;

REVOKE ALL ON FUNCTION public.rotate_partner_key(UUID, TEXT, TEXT, INTEGER, TEXT)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rotate_partner_key(UUID, TEXT, TEXT, INTEGER, TEXT)
  TO authenticated;

-- ---------------------------------------------------------------------------
-- 5. Revocation gains an audit row -- closes F11
-- ---------------------------------------------------------------------------
-- CREATE OR REPLACE of the EXISTING function, deliberately: a second function
-- under a new name would leave the old one granted and callable, so the
-- unaudited path would still exist. Every original property is preserved --
-- still one-way, still refuses an already-revoked key, still stamps the actor
-- server-side, still returns BOOLEAN.
CREATE OR REPLACE FUNCTION public.revoke_partner_key(p_key_id UUID, p_reason TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_updated      INTEGER;
  v_workspace_id UUID;
BEGIN
  UPDATE public.partner_api_keys k
     SET revoked_at = now(), revoked_by = auth.uid(), revoked_reason = p_reason
   WHERE k.id = p_key_id
     AND k.revoked_at IS NULL
     AND EXISTS (
       SELECT 1 FROM public.workspace_members m
        WHERE m.workspace_id = k.workspace_id
          AND m.user_id = auth.uid()
          AND m.role IN ('owner','admin'))
  RETURNING k.workspace_id INTO v_workspace_id;

  GET DIAGNOSTICS v_updated = ROW_COUNT;

  -- ONLY on a real revocation. A refused attempt -- wrong workspace, already
  -- revoked -- must leave no trail claiming it happened, or the audit log
  -- becomes a record of what people TRIED, which is a different and much less
  -- trustworthy artifact than a record of what occurred.
  IF v_updated > 0 THEN
    INSERT INTO public.partner_audit_logs (workspace_id, key_id, actor_id, action, metadata)
    VALUES (
      v_workspace_id, p_key_id, auth.uid(), 'revoke',
      jsonb_build_object('reason', p_reason)
    );
  END IF;

  RETURN v_updated > 0;
END;
$$;

REVOKE ALL ON FUNCTION public.revoke_partner_key(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.revoke_partner_key(UUID, TEXT) TO authenticated;

COMMENT ON COLUMN public.partner_api_keys.superseded_by_key_id IS
  'The key that replaced this one (D12 rotation). NULL for a key that has never '
  'been rotated. The durable rotation record is in partner_audit_logs; this '
  'pointer is a convenience and may be nulled if the successor row is deleted.';
