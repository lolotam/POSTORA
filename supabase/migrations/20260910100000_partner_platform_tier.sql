-- The platform credential tier (spec §5.2 to §5.4a).
--
-- Five tables and four RPCs. The shapes are driven by three constraints found
-- during review, each of which broke an earlier design:
--
--  1. partner_api_keys.social_account_id is NOT NULL with a composite FK, and
--     create_partner_key requires it. A workspace key cannot precede an
--     account, and an account cannot precede a key -- so PROVISIONING creates
--     both, atomically, in one function. See provision_partner_tenant below.
--  2. consume_partner_rate_v2 writes buckets whose key_id references
--     partner_api_keys. A platform key id violates that FK, so the platform
--     tier needs its own bucket table -- not a renamed call.
--  3. Ownership must bind to a stable PRINCIPAL, not to a credential. Binding
--     to a platform_key_id would strand a partner's whole estate the moment
--     they rotated that key.
--
-- All four functions below are SECURITY DEFINER, service_role only: each
-- revokes EXECUTE from PUBLIC, anon and authenticated BY NAME. The BY NAME
-- part is load-bearing, not stylistic -- this database carries
-- ALTER DEFAULT PRIVILEGES ... GRANT ALL ON FUNCTIONS TO anon/authenticated
-- (supabase/tests/baseline_schema.sql), which are DIRECT role grants that
-- REVOKE ... FROM PUBLIC does not remove.

-- ===========================================================================
-- 1. The stable owner. Credentials attach to this; workspaces belong to it.
-- ===========================================================================
CREATE TABLE public.partner_principals (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  is_active   BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.partner_principals ENABLE ROW LEVEL SECURITY;

-- ===========================================================================
-- 2. Rotatable credentials for a principal.
-- ===========================================================================
CREATE TABLE public.partner_platform_keys (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  principal_id        UUID NOT NULL REFERENCES public.partner_principals(id) ON DELETE CASCADE,
  name                TEXT NOT NULL,
  -- The vocabulary is the EXISTING one: partner_key_environment_for_prefix maps
  -- production -> pk_live_ and staging -> pk_test_, and
  -- 20260902180000_partner_key_environment.sql binds partner_api_keys to it.
  -- Introducing 'live'/'test' here would give the platform tier a second
  -- environment vocabulary for the same two environments.
  environment         TEXT NOT NULL CHECK (environment IN ('production', 'staging')),
  key_prefix          TEXT NOT NULL,
  -- The platform tier's own prefixes, so a platform key is distinguishable
  -- from a workspace key by inspection: pl_live_ / pl_test_.
  CONSTRAINT partner_platform_keys_prefix_matches_environment CHECK (
    (environment = 'production' AND key_prefix LIKE 'pl\_live\_%') OR
    (environment = 'staging'    AND key_prefix LIKE 'pl\_test\_%')
  ),
  -- Authentication queries by HASH, matching authenticatePartnerKey. The
  -- prefix is display only: it is not unique, so a maybeSingle() lookup on it
  -- would fail the moment two keys shared one.
  key_hash            TEXT NOT NULL UNIQUE,
  scopes              TEXT[] NOT NULL DEFAULT '{}',
  rate_limit_per_min  INTEGER NOT NULL DEFAULT 30,
  created_by          UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  revoked_by          UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  revoked_reason      TEXT,
  last_used_at        TIMESTAMPTZ,
  expires_at          TIMESTAMPTZ,
  revoked_at          TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- A platform key may hold ONLY platform scopes. In the database, because a
  -- handler check is one refactor from being skipped.
  CONSTRAINT partner_platform_keys_scopes_are_platform
    CHECK (scopes <@ ARRAY[
      'platform:workspaces.read',
      'platform:workspaces.manage',
      'platform:keys.manage'
    ]::TEXT[])
);

CREATE INDEX idx_partner_platform_keys_live
  ON public.partner_platform_keys (principal_id)
  WHERE revoked_at IS NULL;

ALTER TABLE public.partner_platform_keys ENABLE ROW LEVEL SECURITY;

-- ===========================================================================
-- 3. Rate buckets for the platform tier. Mirrors
--    20260830120200_partner_api_rate_limit_v2.sql exactly -- same column name
--    (request_count, not count), same window semantics -- so the two limiters
--    cannot drift. Only the referenced key table differs, because only that is
--    what the foreign key constrains.
-- ===========================================================================
CREATE TABLE public.partner_platform_rate_buckets (
  key_id        UUID NOT NULL REFERENCES public.partner_platform_keys(id) ON DELETE CASCADE,
  window_start  TIMESTAMPTZ NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key_id, window_start)
);

ALTER TABLE public.partner_platform_rate_buckets ENABLE ROW LEVEL SECURITY;

-- ===========================================================================
-- 4. Which principal provisioned which workspace, and the service identity
--    that owns its accounts. RESTRICT on the owner: it is a cascade root, and
--    a routine user-pruning job must fail loudly here rather than silently
--    deleting every connected account in the workspace.
-- ===========================================================================
CREATE TABLE public.partner_provisioned_workspaces (
  workspace_id      UUID PRIMARY KEY REFERENCES public.workspaces(id) ON DELETE CASCADE,
  principal_id      UUID NOT NULL REFERENCES public.partner_principals(id) ON DELETE RESTRICT,
  owner_user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  -- Which door provisioned this workspace. Estate checks join on it: a
  -- staging platform key must neither issue nor revoke production keys, so
  -- the environment travels with the estate link, not just the key.
  environment       TEXT NOT NULL CHECK (environment IN ('production', 'staging')),
  external_ref      TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (principal_id, external_ref)
);

ALTER TABLE public.partner_provisioned_workspaces ENABLE ROW LEVEL SECURITY;

COMMENT ON COLUMN public.partner_provisioned_workspaces.owner_user_id IS
  'Service identity owning this workspace''s social accounts. Interactive '
  'authentication is disabled for it. Never prune: deleting it cascades away '
  'every connected account.';

-- ===========================================================================
-- 5. Durable provisioning attempts. The auth user is created OUTSIDE the
--    provisioning transaction (auth.users is written through the Auth admin
--    API, not SQL), so a crash between the Auth create and the RPC leaves an
--    orphan no transaction can roll back. The handler writes a pending row
--    here BEFORE creating the Auth user and settles it after, so a
--    reconciliation job can find orphans and a retry of the same external_ref
--    recognises its own prior attempt instead of minting a second identity.
-- ===========================================================================
CREATE TABLE public.partner_provisioning_attempts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id      TEXT NOT NULL,
  principal_id    UUID NOT NULL REFERENCES public.partner_principals(id) ON DELETE CASCADE,
  external_ref    TEXT,
  owner_user_id   UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  workspace_id    UUID REFERENCES public.workspaces(id) ON DELETE SET NULL,
  state           TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'provisioned', 'failed')),
  error           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (principal_id, external_ref)
);

ALTER TABLE public.partner_provisioning_attempts ENABLE ROW LEVEL SECURITY;

-- ===========================================================================
-- Grants. Service-role lifecycle paths own these tables, the same convention
-- as partner_api_key_accounts: RLS on, no policies, explicit grants that do
-- not depend on environment-specific default privileges.
-- ===========================================================================
REVOKE ALL ON public.partner_principals FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.partner_platform_keys FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.partner_platform_rate_buckets FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.partner_provisioned_workspaces FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.partner_provisioning_attempts FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.partner_principals FROM service_role;
REVOKE ALL ON public.partner_platform_keys FROM service_role;
REVOKE ALL ON public.partner_platform_rate_buckets FROM service_role;
REVOKE ALL ON public.partner_provisioned_workspaces FROM service_role;
REVOKE ALL ON public.partner_provisioning_attempts FROM service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.partner_principals TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.partner_platform_keys TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.partner_platform_rate_buckets TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.partner_provisioned_workspaces TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.partner_provisioning_attempts TO service_role;

-- updated_at maintenance, matching every other partner table.
CREATE TRIGGER update_partner_principals_updated_at
BEFORE UPDATE ON public.partner_principals
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_partner_platform_keys_updated_at
BEFORE UPDATE ON public.partner_platform_keys
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_partner_provisioning_attempts_updated_at
BEFORE UPDATE ON public.partner_provisioning_attempts
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ===========================================================================
-- The platform limiter. Same semantics as consume_partner_rate_v2, different
-- bucket table. Signature and semantics mirror it exactly: RETURNS TABLE, not
-- JSONB, so both doors read the same shape.
--
-- reset_seconds is seconds REMAINING in the consumed window, 1..60, computed
-- with CEIL. Never floor and never `60 - EXTRACT(SECOND)`: both can yield 0
-- during the final fraction of a second, which claims a live window has
-- already ended. Retry-After is delay-seconds by RFC 9110, so this same number
-- feeds the header with no local recomputation.
--
-- now() is captured ONCE so the bucket incremented and the window the reset is
-- measured against are provably the same instant.
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.consume_partner_platform_rate(
  p_key_id UUID,
  p_limit  INTEGER
) RETURNS TABLE (allowed BOOLEAN, remaining INTEGER, reset_seconds INTEGER)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count  INTEGER;
  v_now    TIMESTAMPTZ;
  v_window TIMESTAMPTZ;
BEGIN
  v_now := now();
  v_window := date_trunc('minute', v_now);

  INSERT INTO public.partner_platform_rate_buckets (key_id, window_start, request_count)
  VALUES (p_key_id, v_window, 1)
  ON CONFLICT (key_id, window_start)
  DO UPDATE SET request_count = partner_platform_rate_buckets.request_count + 1
  RETURNING request_count INTO v_count;

  RETURN QUERY SELECT
    v_count <= p_limit,
    GREATEST(p_limit - v_count, 0),
    CEIL(EXTRACT(EPOCH FROM (v_window + INTERVAL '1 minute' - v_now)))::INTEGER;
END;
$$;

REVOKE ALL ON FUNCTION public.consume_partner_platform_rate(UUID, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_partner_platform_rate(UUID, INTEGER) TO service_role;

-- ===========================================================================
-- Provision a tenant: workspace, membership, estate link, WhatsApp
-- placeholder account, and the workspace key bound to it -- atomically.
--
-- WHY ONE FUNCTION. partner_api_keys.social_account_id is NOT NULL, so the key
-- needs the account; the account is created by pairing, which needs the key.
-- Creating both here is the only order that satisfies both constraints. Doing
-- it in four client round-trips leaves an orphaned auth user and workspace
-- whenever a later step fails, and a retry of the same external_ref creates
-- another pair before hitting the uniqueness violation.
--
-- The auth user is NOT created here -- auth.users is written through the Auth
-- admin API, not SQL. The caller creates it first and passes its id, then
-- deletes it if this function raises. That compensation is the one step that
-- cannot be transactional, and the handler must implement it. The
-- partner_provisioning_attempts row the handler writes first is what makes an
-- orphan of that compensation findable afterwards.
--
-- THE PLAINTEXT SECRET NEVER ENTERS THE DATABASE (lifecycle migration §3): the
-- caller generates the key and its SHA-256 digest and passes only the prefix
-- and the hash. No parameter here may ever carry the key itself.
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.provision_partner_tenant(
  p_principal_id     UUID,
  p_owner_user_id    UUID,
  p_workspace_name   TEXT,
  p_external_ref     TEXT,
  p_connection_name  TEXT,
  p_key_name         TEXT,
  p_key_prefix       TEXT,
  p_key_hash         TEXT,
  p_scopes           TEXT[],
  p_environment      TEXT DEFAULT 'production',
  p_risk_consent_accepted_by TEXT DEFAULT NULL,
  p_risk_consent_accepted_at TIMESTAMPTZ DEFAULT NULL,
  p_risk_consent_accepted_ip TEXT DEFAULT NULL,
  p_consent_version  TEXT DEFAULT NULL,
  p_platform_key_id  UUID DEFAULT NULL,
  p_request_id       TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_workspace_id UUID;
  v_account_id   UUID := gen_random_uuid();
  v_key_id       UUID;
BEGIN
  -- A workspace key may never hold a platform scope (spec §5.3 rule 1), and
  -- the database is where that holds: a handler check is one refactor from
  -- being skipped.
  IF p_scopes && ARRAY[
    'platform:workspaces.read',
    'platform:workspaces.manage',
    'platform:keys.manage'
  ]::TEXT[] THEN
    RAISE EXCEPTION 'a workspace key may not hold a platform scope'
      USING ERRCODE = 'check_violation';
  END IF;

  IF p_key_hash IS NULL OR length(p_key_hash) <> 64 THEN
    -- A 64-char hex SHA-256 digest. Anything else is either a plaintext key
    -- reaching the database or a caller that forgot to hash -- both are
    -- credential-handling failures, not validation nits. Same rule as
    -- create_partner_key.
    RAISE EXCEPTION 'key_hash must be a 64-character SHA-256 hex digest'
      USING ERRCODE = 'check_violation';
  END IF;

  IF p_environment IS NULL OR p_environment NOT IN ('staging', 'production') THEN
    RAISE EXCEPTION 'environment must be staging or production'
      USING ERRCODE = 'check_violation';
  END IF;
  -- The prefix is what the door checks before any lookup, so a row whose
  -- prefix disagrees with its environment would be a key one door mints and
  -- the other accepts. Refused at the mint, where it is a caller bug. Same
  -- rule as create_partner_key (20260902180000).
  IF public.partner_key_environment_for_prefix(p_key_prefix) <> p_environment THEN
    RAISE EXCEPTION 'key prefix % does not belong to environment %', p_key_prefix, p_environment
      USING ERRCODE = 'check_violation';
  END IF;

  -- The acting platform key is rechecked HERE, not only at the door: a key
  -- revoked between authenticatePlatformKey() and this statement, or one
  -- belonging to another principal or environment, must not provision a
  -- tenant. Answered as not-found so nothing is enumerable. The parameter
  -- keeps its DEFAULT NULL only so the signature (and its REVOKE/GRANT
  -- lines) stays put; a NULL is refused all the same.
  IF p_platform_key_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.partner_platform_keys pk
     WHERE pk.id = p_platform_key_id
       AND pk.principal_id = p_principal_id
       AND pk.environment = p_environment
       AND pk.revoked_at IS NULL
  ) THEN
    RAISE EXCEPTION 'no such platform key for this principal and environment'
      USING ERRCODE = 'no_data_found';
  END IF;

  INSERT INTO public.workspaces (name, owner_id, is_personal)
  VALUES (p_workspace_name, p_owner_user_id, false)
  RETURNING id INTO v_workspace_id;

  INSERT INTO public.workspace_members (workspace_id, user_id, role)
  VALUES (v_workspace_id, p_owner_user_id, 'owner');

  INSERT INTO public.partner_provisioned_workspaces
    (workspace_id, principal_id, owner_user_id, environment, external_ref)
  VALUES (v_workspace_id, p_principal_id, p_owner_user_id, p_environment, p_external_ref);

  -- The placeholder the key binds to. pending_ id and empty token are filled
  -- in by pairing; is_active stays false until reconciliation activates it.
  --
  -- CONSENT AND QUOTA. This row is a Direct QR account, so both gates apply,
  -- and this path does NOT go through registerNumber where they live. The
  -- caller must therefore validate the risk-consent attestation and enforce
  -- the account quota BEFORE calling this function, and pass the consent
  -- fields in so they are recorded on the row it creates: a provisioned
  -- number that paired without a recorded attestation is exactly the audit
  -- gap §5.5 exists to prevent.
  INSERT INTO public.social_accounts
    (id, user_id, workspace_id, platform, platform_user_id, platform_username,
     access_token, connection_mode, account_metadata, is_active)
  VALUES
    (v_account_id, p_owner_user_id, v_workspace_id, 'whatsapp',
     'pending_' || v_account_id::TEXT, p_connection_name,
     '', 'evolution_qr',
     jsonb_build_object('connection_mode', 'evolution_qr',
                        'display_name', p_connection_name,
                        'risk_consent', jsonb_build_object(
                          -- What the partner REPORTED.
                          'accepted_by', p_risk_consent_accepted_by,
                          'accepted_at', p_risk_consent_accepted_at,
                          'accepted_ip', p_risk_consent_accepted_ip,
                          -- The grade of that evidence. This path is always a
                          -- partner's claim, never an acceptance Postora
                          -- witnessed; the browser door records 'observed'.
                          -- Collapsing the two would let a reported IP be read
                          -- later as one Postora saw.
                          'evidence', 'partner_attestation',
                          -- What Postora itself OBSERVED: which credential was
                          -- authenticated, and when the claim arrived. These
                          -- are the facts an audit can rely on.
                          'attested_by_platform_key_id', p_platform_key_id,
                          'recorded_at', now(),
                          -- Which text was accepted. Without it, a later
                          -- wording change leaves every prior acceptance
                          -- unattributable to anything specific.
                          'consent_version', p_consent_version
                        )),
     false);

  INSERT INTO public.partner_api_keys
    (workspace_id, social_account_id, name, key_prefix, key_hash, scopes, environment)
  VALUES
    (v_workspace_id, v_account_id, p_key_name, p_key_prefix, p_key_hash, p_scopes, p_environment)
  RETURNING id INTO v_key_id;

  -- Finding 2: without this row the key cannot see the account it was issued
  -- against. binding.ts has no fallback, so listing would omit it and pairing
  -- would refuse it as unbound.
  INSERT INTO public.partner_api_key_accounts (key_id, workspace_id, social_account_id)
  VALUES (v_key_id, v_workspace_id, v_account_id);

  -- Every credential mutation writes an audit row. create_partner_key commits
  -- mutation, binding and audit together (20260831170000); provisioning is a
  -- new entry point that creates a credential, so it does the same, recording
  -- the principal, the platform key that acted, and the request id.
  INSERT INTO public.partner_audit_logs (workspace_id, key_id, actor_id, action, request_id, metadata)
  VALUES (
    v_workspace_id, v_key_id, auth.uid(), 'create', p_request_id,
    jsonb_build_object(
      'key_prefix', p_key_prefix,
      'scopes', to_jsonb(COALESCE(p_scopes, '{}')),
      'social_account_id', v_account_id,
      'environment', p_environment,
      'principal_id', p_principal_id,
      'platform_key_id', p_platform_key_id,
      'provisioned_owner_user_id', p_owner_user_id,
      'external_ref', p_external_ref
    )
  );

  RETURN jsonb_build_object(
    'workspace_id', v_workspace_id,
    'account_id', v_account_id,
    'key_id', v_key_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.provision_partner_tenant(
  UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT[], TEXT, TEXT, TIMESTAMPTZ, TEXT, TEXT, UUID, TEXT
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.provision_partner_tenant(
  UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT[], TEXT, TEXT, TIMESTAMPTZ, TEXT, TEXT, UUID, TEXT
) TO service_role;

-- ===========================================================================
-- Issue a workspace key inside the calling principal's estate, atomically.
--
-- WHY AN RPC, NOT HANDLER INSERTS. service_role holds only SELECT and INSERT
-- on partner_api_keys (20260830120300_partner_api_least_privilege_grants.sql),
-- so a handler cannot delete the key it just created when the binding insert
-- fails. A two-insert handler path leaves a usable key bound to nothing on a
-- partial failure, and no compensation is possible. One transaction here is
-- the only order that cannot orphan.
--
-- The estate check, the account-in-workspace check, the key insert, the
-- binding insert and the audit row share this function's single transaction:
-- a failure at any point leaves no key, no binding and no trail.
--
-- Argument naming follows create_partner_key (p_workspace_id,
-- p_social_account_id, p_key_prefix, p_key_hash, p_scopes,
-- p_rate_limit_per_min, p_monthly_quota, p_expires_at, p_environment,
-- p_request_id).
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.issue_partner_key_in_estate(
  p_principal_id      UUID,
  p_workspace_id      UUID,
  p_social_account_id UUID,
  p_key_name          TEXT,
  p_key_prefix        TEXT,
  p_key_hash          TEXT,
  p_scopes            TEXT[],
  p_platform_key_id   UUID,
  p_rate_limit_per_min INTEGER DEFAULT 60,
  p_monthly_quota     INTEGER DEFAULT NULL,
  p_expires_at        TIMESTAMPTZ DEFAULT NULL,
  p_environment       TEXT DEFAULT 'production',
  p_request_id        TEXT DEFAULT NULL
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_key_id UUID;
BEGIN
  -- Estate check first: the workspace must belong to the calling principal
  -- AND the acting platform key must be a live key of that principal in the
  -- SAME environment as the workspace and the key being issued. A staging
  -- platform key therefore cannot mint a production key, even in its own
  -- principal's estate. Answered as not-found in every mismatch branch, so
  -- workspace ids, key ids and environments are not enumerable across
  -- principals. p_platform_key_id is REQUIRED (no default): audit-only
  -- metadata that callers may omit is exactly how the cross-environment mint
  -- survived review.
  IF NOT EXISTS (
    SELECT 1
      FROM public.partner_provisioned_workspaces w
      JOIN public.partner_platform_keys pk ON pk.id = p_platform_key_id
     WHERE w.workspace_id = p_workspace_id
       AND w.principal_id = p_principal_id
       AND w.environment = p_environment
       AND pk.principal_id = p_principal_id
       AND pk.environment = p_environment
       AND pk.revoked_at IS NULL
  ) THEN
    RAISE EXCEPTION 'no such workspace in this principal''s estate'
      USING ERRCODE = 'no_data_found';
  END IF;

  -- The account must be in THAT workspace before pinning to it. The composite
  -- FK would reject a mismatch, but a clear not-found beats a constraint
  -- error surfacing as internal_error.
  IF NOT EXISTS (
    SELECT 1 FROM public.social_accounts a
     WHERE a.id = p_social_account_id
       AND a.workspace_id = p_workspace_id
  ) THEN
    RAISE EXCEPTION 'no such account in workspace %', p_workspace_id
      USING ERRCODE = 'no_data_found';
  END IF;

  -- A workspace key may never hold a platform scope. In the database, because
  -- a handler check is one refactor from being skipped.
  IF p_scopes && ARRAY[
    'platform:workspaces.read',
    'platform:workspaces.manage',
    'platform:keys.manage'
  ]::TEXT[] THEN
    RAISE EXCEPTION 'a workspace key may not hold a platform scope'
      USING ERRCODE = 'check_violation';
  END IF;

  IF p_key_hash IS NULL OR length(p_key_hash) <> 64 THEN
    RAISE EXCEPTION 'key_hash must be a 64-character SHA-256 hex digest'
      USING ERRCODE = 'check_violation';
  END IF;

  IF p_environment IS NULL OR p_environment NOT IN ('staging', 'production') THEN
    RAISE EXCEPTION 'environment must be staging or production'
      USING ERRCODE = 'check_violation';
  END IF;
  IF public.partner_key_environment_for_prefix(p_key_prefix) <> p_environment THEN
    RAISE EXCEPTION 'key prefix % does not belong to environment %', p_key_prefix, p_environment
      USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO public.partner_api_keys (
    workspace_id, social_account_id, created_by, name, key_prefix, key_hash,
    scopes, rate_limit_per_min, monthly_quota, expires_at, environment
  ) VALUES (
    p_workspace_id, p_social_account_id, auth.uid(), p_key_name, p_key_prefix,
    p_key_hash, COALESCE(p_scopes, '{}'), p_rate_limit_per_min, p_monthly_quota,
    p_expires_at, p_environment
  )
  RETURNING id INTO v_key_id;

  -- Without the binding the key cannot see its own account (binding.ts has no
  -- fallback: listing would omit it and pairing would refuse it as unbound).
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
      'environment', p_environment,
      'principal_id', p_principal_id,
      'platform_key_id', p_platform_key_id
    )
  );

  RETURN v_key_id;
END;
$$;

REVOKE ALL ON FUNCTION public.issue_partner_key_in_estate(
  UUID, UUID, UUID, TEXT, TEXT, TEXT, TEXT[], UUID, INTEGER, INTEGER, TIMESTAMPTZ, TEXT, TEXT
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.issue_partner_key_in_estate(
  UUID, UUID, UUID, TEXT, TEXT, TEXT, TEXT[], UUID, INTEGER, INTEGER, TIMESTAMPTZ, TEXT, TEXT
) TO service_role;

-- ===========================================================================
-- Revoke a workspace key, but only inside the calling principal's estate.
-- The join is why this is a function: partner_api_keys and
-- partner_provisioned_workspaces are related only THROUGH workspaces, so no
-- PostgREST embed can express it. The conditional update, the audit row and
-- the estate predicate share one statement and one transaction.
--
-- An already-revoked key, or a key outside the estate, returns false, so a
-- repeated revoke answers resource_not_found rather than reporting a second
-- successful revocation -- and key ids are not enumerable across principals.
-- Only a real revocation writes an audit row: a refused attempt must leave no
-- trail claiming it happened (lifecycle migration §5).
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.revoke_partner_key_in_estate(
  p_principal_id UUID,
  p_key_id       UUID,
  p_reason       TEXT,
  p_platform_key_id UUID,
  p_request_id   TEXT DEFAULT NULL
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_updated      INTEGER;
  v_workspace_id UUID;
BEGIN
  -- The acting platform key must be a live key of the calling principal in
  -- the SAME environment as the key being revoked: a staging platform key
  -- cannot revoke production keys, even in its own principal's estate.
  -- p_platform_key_id is REQUIRED (no default) for the same reason as in
  -- issue_partner_key_in_estate. A mismatch revokes nothing and returns
  -- false, so key ids and environments are not enumerable across principals.
  UPDATE public.partner_api_keys AS k
  SET revoked_at = now(), revoked_reason = p_reason
  FROM public.partner_provisioned_workspaces AS p
  JOIN public.partner_platform_keys AS pk ON pk.id = p_platform_key_id
  WHERE k.id = p_key_id
    AND k.workspace_id = p.workspace_id
    AND p.principal_id = p_principal_id
    AND k.environment = pk.environment
    AND pk.principal_id = p_principal_id
    AND pk.revoked_at IS NULL
    AND k.revoked_at IS NULL
  RETURNING k.workspace_id INTO v_workspace_id;

  GET DIAGNOSTICS v_updated = ROW_COUNT;

  IF v_updated > 0 THEN
    INSERT INTO public.partner_audit_logs (workspace_id, key_id, actor_id, action, request_id, metadata)
    VALUES (
      v_workspace_id, p_key_id, auth.uid(), 'revoke', p_request_id,
      jsonb_build_object(
        'reason', p_reason,
        'principal_id', p_principal_id,
        'platform_key_id', p_platform_key_id
      )
    );
  END IF;

  RETURN v_updated > 0;
END;
$$;

REVOKE ALL ON FUNCTION public.revoke_partner_key_in_estate(UUID, UUID, TEXT, UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.revoke_partner_key_in_estate(UUID, UUID, TEXT, UUID, TEXT) TO service_role;
