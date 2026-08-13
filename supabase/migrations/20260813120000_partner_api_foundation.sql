
-- Partner API: machine-authenticated, workspace-scoped access to WhatsApp sending.
-- Keys are hashed at rest and pinned to exactly one social account.

-- A composite FK needs a matching unique constraint on the referenced side.
-- Redundant with the PK, but it is what makes (id, workspace_id) referenceable.
ALTER TABLE public.social_accounts
  ADD CONSTRAINT social_accounts_id_workspace_key UNIQUE (id, workspace_id);

-- WhatsApp accounts must be workspace-scoped. All 4 live rows already are;
-- other platforms are deliberately left alone.
ALTER TABLE public.social_accounts
  ADD CONSTRAINT social_accounts_whatsapp_needs_workspace
  CHECK (platform <> 'whatsapp' OR workspace_id IS NOT NULL) NOT VALID;

-- Validate in the migration itself. Leaving it NOT VALID would enforce new
-- writes but leave the constraint catalogued as unvalidated in production,
-- so nothing would ever prove the existing rows comply. All 4 whatsapp rows
-- were verified populated on 2026-08-13; if this fails, a non-compliant row
-- appeared since and must be backfilled before deploying.
ALTER TABLE public.social_accounts
  VALIDATE CONSTRAINT social_accounts_whatsapp_needs_workspace;

CREATE TABLE public.partner_api_keys (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  social_account_id   UUID NOT NULL,
  created_by          UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  revoked_by          UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  revoked_reason      TEXT,
  name                TEXT NOT NULL,
  key_prefix          TEXT NOT NULL,
  key_hash            TEXT NOT NULL UNIQUE,
  scopes              TEXT[] NOT NULL DEFAULT '{}',
  rate_limit_per_min  INTEGER NOT NULL DEFAULT 60,
  monthly_quota       INTEGER,
  current_usage_count INTEGER NOT NULL DEFAULT 0,
  last_reset_at       TIMESTAMPTZ NOT NULL DEFAULT date_trunc('month', now()),
  last_used_at        TIMESTAMPTZ,
  expires_at          TIMESTAMPTZ,
  revoked_at          TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- The control that makes cross-workspace key misuse impossible in the database.
  CONSTRAINT partner_api_keys_account_in_workspace
    FOREIGN KEY (social_account_id, workspace_id)
    REFERENCES public.social_accounts (id, workspace_id) ON DELETE CASCADE
);

-- Referenced by partner_api_usage's composite FK below.
ALTER TABLE public.partner_api_keys
  ADD CONSTRAINT partner_api_keys_id_workspace_key UNIQUE (id, workspace_id);

CREATE INDEX partner_api_keys_hash_active_idx
  ON public.partner_api_keys (key_hash) WHERE revoked_at IS NULL;
CREATE INDEX partner_api_keys_workspace_idx
  ON public.partner_api_keys (workspace_id);

CREATE TABLE public.partner_api_idempotency (
  key_id          UUID NOT NULL REFERENCES public.partner_api_keys(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  request_hash    TEXT NOT NULL,
  state           TEXT NOT NULL CHECK (state IN ('processing','completed','indeterminate')),
  -- Fencing token. A state predicate alone cannot protect this row: taking
  -- over an expired lease leaves state = 'processing', so a revived stale
  -- writer would still satisfy `state = 'processing'` and could settle the
  -- NEW owner's row with its own result. Every claim and every takeover mints
  -- a fresh token, and only the holder of the current token may settle.
  attempt_token   UUID NOT NULL DEFAULT gen_random_uuid(),
  http_status     INTEGER,
  response_body   JSONB,
  locked_until    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at    TIMESTAMPTZ,
  expires_at      TIMESTAMPTZ NOT NULL DEFAULT now() + INTERVAL '7 days',
  PRIMARY KEY (key_id, idempotency_key)
);

CREATE INDEX partner_api_idempotency_expiry_idx
  ON public.partner_api_idempotency (expires_at);

-- The two foreign keys below are each individually valid but, declared
-- separately, would allow a usage row whose workspace_id is not the key's
-- workspace -- silently corrupting per-workspace billing and reporting.
-- A composite FK against (id, workspace_id) makes the pairing impossible,
-- the same technique used for account tenancy on partner_api_keys.
CREATE TABLE public.partner_api_usage (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key_id       UUID NOT NULL,
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  action       TEXT NOT NULL,
  billable     BOOLEAN NOT NULL DEFAULT false,
  http_status  INTEGER NOT NULL,
  error_code   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- RESTRICT, not CASCADE: usage rows are billing history and must outlive
  -- day-to-day key churn. Keys are meant to be REVOKED, not deleted; if a key
  -- genuinely must be removed, its usage has to be archived deliberately
  -- rather than disappearing as a side effect.
  CONSTRAINT partner_api_usage_key_in_workspace
    FOREIGN KEY (key_id, workspace_id)
    REFERENCES public.partner_api_keys (id, workspace_id) ON DELETE RESTRICT
);

CREATE INDEX partner_api_usage_ws_time_idx
  ON public.partner_api_usage (workspace_id, created_at DESC);
CREATE INDEX partner_api_usage_key_time_idx
  ON public.partner_api_usage (key_id, created_at DESC);

-- Per-key, per-minute rate limit bucket. Counting rows in the usage ledger
-- would be the same non-atomic count-then-insert the spec rejects: concurrent
-- requests all read the same old count and all pass. INSERT .. ON CONFLICT
-- DO UPDATE .. RETURNING is a single atomic statement instead.
CREATE TABLE public.partner_api_rate_buckets (
  key_id       UUID NOT NULL REFERENCES public.partner_api_keys(id) ON DELETE CASCADE,
  window_start TIMESTAMPTZ NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key_id, window_start)
);

CREATE OR REPLACE FUNCTION public.consume_partner_rate(p_key_id UUID, p_limit INTEGER)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  INSERT INTO public.partner_api_rate_buckets (key_id, window_start, request_count)
  VALUES (p_key_id, date_trunc('minute', now()), 1)
  ON CONFLICT (key_id, window_start)
  DO UPDATE SET request_count = partner_api_rate_buckets.request_count + 1
  RETURNING request_count INTO v_count;

  RETURN v_count <= p_limit;
END;
$$;

-- Quota is RESERVED before the send and SETTLED after, because the plan
-- promises quota is consumed only by a Meta-accepted send. A single
-- increment-then-check would charge the partner for 4xx rejections too.
--
-- reserve: increments and reports whether the reservation is within quota.
-- release: decrements, called when Meta definitely rejected the send.
-- Nothing is released for an indeterminate send — it may have been delivered.
CREATE OR REPLACE FUNCTION public.reserve_partner_quota(p_key_id UUID)
RETURNS TABLE (allowed BOOLEAN, usage_count INTEGER)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_quota INTEGER;
  v_count INTEGER;
BEGIN
  UPDATE public.partner_api_keys k
     SET current_usage_count =
           CASE WHEN k.last_reset_at < date_trunc('month', now())
                THEN 1 ELSE k.current_usage_count + 1 END,
         last_reset_at = date_trunc('month', now()),
         last_used_at  = now()
   WHERE k.id = p_key_id
   RETURNING k.monthly_quota, k.current_usage_count
        INTO v_quota, v_count;

  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 0;
    RETURN;
  END IF;

  RETURN QUERY SELECT (v_quota IS NULL OR v_count <= v_quota), v_count;
END;
$$;

CREATE OR REPLACE FUNCTION public.release_partner_quota(p_key_id UUID)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.partner_api_keys
     SET current_usage_count = GREATEST(current_usage_count - 1, 0)
   WHERE id = p_key_id;
$$;

-- Touch last_used_at for non-send actions, which never reserve quota.
CREATE OR REPLACE FUNCTION public.touch_partner_key(p_key_id UUID)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.partner_api_keys SET last_used_at = now() WHERE id = p_key_id;
$$;

-- The idempotency claim lives in SQL, not in the edge function.
--
-- Doing it in JS needs insert -> catch 23505 -> re-read, which cannot express
-- "take over a lease that expired" without another race. One statement here
-- is atomic, handles stale leases and row expiry in the same place, and is
-- directly testable with psql.
--
-- Returns one row: outcome in
--   claimed | replay | conflict | in_progress | indeterminate
CREATE OR REPLACE FUNCTION public.claim_partner_idempotency(
  p_key_id UUID,
  p_idempotency_key TEXT,
  p_request_hash TEXT,
  -- MUST exceed the maximum end-to-end send deadline, with margin.
  -- The auto-registration path allows send(30s) + register(15s) + retry(30s)
  -- = 75s. A 60s lease would let a SECOND caller take over a request that is
  -- still in flight, and both would send to the same customer. 300s leaves
  -- room for that worst case plus retries and clock skew; the cost of a lease
  -- that is too long is only a delayed recovery, while one that is too short
  -- is a duplicate message.
  p_lease_seconds INTEGER DEFAULT 300
)
RETURNS TABLE (outcome TEXT, http_status INTEGER, response_body JSONB, attempt_token UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row   public.partner_api_idempotency%ROWTYPE;
  v_token UUID;
BEGIN
  -- Opportunistic pruning: expired rows must not resurrect as false replays.
  DELETE FROM public.partner_api_idempotency
   WHERE key_id = p_key_id AND expires_at < now();

  v_token := gen_random_uuid();

  INSERT INTO public.partner_api_idempotency
    (key_id, idempotency_key, request_hash, state, locked_until, attempt_token)
  VALUES
    (p_key_id, p_idempotency_key, p_request_hash, 'processing',
     now() + make_interval(secs => p_lease_seconds), v_token)
  ON CONFLICT (key_id, idempotency_key) DO NOTHING;

  IF FOUND THEN
    RETURN QUERY SELECT 'claimed'::TEXT, NULL::INTEGER, NULL::JSONB, v_token;
    RETURN;
  END IF;

  -- Lock the existing row so two concurrent duplicates cannot both take over
  -- the same expired lease.
  SELECT * INTO v_row
    FROM public.partner_api_idempotency
   WHERE key_id = p_key_id AND idempotency_key = p_idempotency_key
     FOR UPDATE;

  IF NOT FOUND THEN
    -- Pruned between the insert and the read; retry is safe and cheap.
    RETURN QUERY SELECT 'in_progress'::TEXT, NULL::INTEGER, NULL::JSONB, NULL::UUID;
    RETURN;
  END IF;

  IF v_row.request_hash IS DISTINCT FROM p_request_hash THEN
    RETURN QUERY SELECT 'conflict'::TEXT, NULL::INTEGER, NULL::JSONB, NULL::UUID;
    RETURN;
  END IF;

  IF v_row.state = 'completed' THEN
    RETURN QUERY SELECT 'replay'::TEXT, v_row.http_status, v_row.response_body, NULL::UUID;
    RETURN;
  END IF;

  IF v_row.state = 'indeterminate' THEN
    -- The first attempt may have reached Meta. Never silently re-send.
    RETURN QUERY SELECT 'indeterminate'::TEXT, NULL::INTEGER, NULL::JSONB, NULL::UUID;
    RETURN;
  END IF;

  -- state = 'processing'. A live lease means a genuine concurrent duplicate;
  -- an expired one means the previous attempt died before settling, so this
  -- caller takes it over rather than wedging the key forever.
  IF v_row.locked_until IS NOT NULL AND v_row.locked_until > now() THEN
    RETURN QUERY SELECT 'in_progress'::TEXT, NULL::INTEGER, NULL::JSONB, NULL::UUID;
    RETURN;
  END IF;

  -- Takeover: mint a NEW token so the previous holder can no longer settle.
  UPDATE public.partner_api_idempotency
     SET locked_until  = now() + make_interval(secs => p_lease_seconds),
         attempt_token = v_token
   WHERE key_id = p_key_id AND idempotency_key = p_idempotency_key;

  RETURN QUERY SELECT 'claimed'::TEXT, NULL::INTEGER, NULL::JSONB, v_token;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_partner_idempotency(UUID, TEXT, TEXT, INTEGER)
  FROM PUBLIC, authenticated, anon;
GRANT EXECUTE ON FUNCTION public.claim_partner_idempotency(UUID, TEXT, TEXT, INTEGER)
  TO service_role;

REVOKE ALL ON FUNCTION public.consume_partner_rate(UUID, INTEGER) FROM PUBLIC, authenticated, anon;
REVOKE ALL ON FUNCTION public.reserve_partner_quota(UUID) FROM PUBLIC, authenticated, anon;
REVOKE ALL ON FUNCTION public.release_partner_quota(UUID) FROM PUBLIC, authenticated, anon;
REVOKE ALL ON FUNCTION public.touch_partner_key(UUID) FROM PUBLIC, authenticated, anon;
GRANT EXECUTE ON FUNCTION public.consume_partner_rate(UUID, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.reserve_partner_quota(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_partner_quota(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.touch_partner_key(UUID) TO service_role;

ALTER TABLE public.partner_api_keys         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.partner_api_idempotency  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.partner_api_usage        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.partner_api_rate_buckets ENABLE ROW LEVEL SECURITY;

-- Idempotency and usage are service-role only: RLS on, no policies, no grants.

-- Keys: workspace admins/owners may read metadata and revoke. Never the hash.
CREATE POLICY "Workspace admins read partner keys"
ON public.partner_api_keys FOR SELECT TO authenticated
USING (EXISTS (
  SELECT 1 FROM public.workspace_members m
   WHERE m.workspace_id = partner_api_keys.workspace_id
     AND m.user_id = auth.uid()
     AND m.role IN ('owner','admin')
));

-- No UPDATE policy: revocation goes through revoke_partner_key() below, so
-- there is no path by which a client can clear revoked_at.

-- Column-level grants, mirroring the mcp_oauth_tokens precedent: key_hash is
-- never selectable by a client, and only revocation fields are writable.
REVOKE ALL ON public.partner_api_keys FROM authenticated;
GRANT SELECT (id, workspace_id, social_account_id, created_by, revoked_by,
              revoked_reason, name, key_prefix, scopes, rate_limit_per_min,
              monthly_quota, current_usage_count, last_reset_at, last_used_at,
              expires_at, revoked_at, created_at, updated_at)
  ON public.partner_api_keys TO authenticated;

-- Revocation is a one-way door, so it is NOT a granted UPDATE.
-- Granting UPDATE(revoked_at) would let an admin set it back to NULL and
-- silently un-revoke a key that was revoked because it leaked. This function
-- refuses to act on an already-revoked key and stamps the actor server-side.
CREATE OR REPLACE FUNCTION public.revoke_partner_key(p_key_id UUID, p_reason TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_updated INTEGER;
BEGIN
  UPDATE public.partner_api_keys k
     SET revoked_at = now(), revoked_by = auth.uid(), revoked_reason = p_reason
   WHERE k.id = p_key_id
     AND k.revoked_at IS NULL
     AND EXISTS (
       SELECT 1 FROM public.workspace_members m
        WHERE m.workspace_id = k.workspace_id
          AND m.user_id = auth.uid()
          AND m.role IN ('owner','admin'));
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated > 0;
END;
$$;

GRANT EXECUTE ON FUNCTION public.revoke_partner_key(UUID, TEXT) TO authenticated;

CREATE TRIGGER update_partner_api_keys_updated_at
BEFORE UPDATE ON public.partner_api_keys
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
