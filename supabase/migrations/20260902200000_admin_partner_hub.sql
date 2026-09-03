-- Admin Partner Hub (spec: docs/superpowers/specs/2026-09-02-admin-partner-hub-design.md).
--
-- Expand-only and idempotent. Three things, in dependency order:
--   1. Two nullable ledger columns (request_id, latency_ms) so an operator can
--      correlate a partner's "the 09:14 call failed" with one row.
--   2. Platform admins may manage keys in ANY workspace (spec D1). The shared
--      predicate is widened, and revoke_partner_key is rewritten to USE the
--      shared predicate instead of its inline copy -- otherwise the widening
--      never reaches revocation.
--   3. Five admin-only SECURITY DEFINER readers (spec D2). No table policy is
--      widened; each function refuses a non-admin with insufficient_privilege
--      (a refused read must never look like an empty one) and never selects
--      key_hash, secret or previous_secret.

-- ---------------------------------------------------------------------------
-- 1. Ledger columns
-- ---------------------------------------------------------------------------
ALTER TABLE public.partner_api_usage
  ADD COLUMN IF NOT EXISTS request_id TEXT;
ALTER TABLE public.partner_api_usage
  ADD COLUMN IF NOT EXISTS latency_ms INTEGER;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'partner_api_usage_latency_ms_nonneg'
  ) THEN
    ALTER TABLE public.partner_api_usage
      ADD CONSTRAINT partner_api_usage_latency_ms_nonneg
      CHECK (latency_ms IS NULL OR latency_ms >= 0);
  END IF;
END $$;

COMMENT ON COLUMN public.partner_api_usage.request_id IS
  'The X-Postora-Request-Id the response carried. NULL for rows written before 2026-09-02.';
COMMENT ON COLUMN public.partner_api_usage.latency_ms IS
  'Wall-clock milliseconds from request entry to response, measured by the edge worker. NULL for older rows.';

-- ---------------------------------------------------------------------------
-- 2. The admin gate, private
-- ---------------------------------------------------------------------------
-- RAISE, not RETURN FALSE: every caller below is a reader, and a reader that
-- silently returns nothing for the wrong caller is indistinguishable from
-- "there is no data" (AGENTS.md reviewer rule 3).
CREATE OR REPLACE FUNCTION public.partner_hub_assert_admin()
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin'::public.app_role) THEN
    RAISE EXCEPTION 'platform admin only' USING ERRCODE = 'insufficient_privilege';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.partner_hub_assert_admin() FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Platform admins may manage keys in any workspace (D1)
-- ---------------------------------------------------------------------------
-- Same signature as 20260831170000, so this is a replacement. Widening for
-- the admin role only; nothing is narrowed. The actor is still auth.uid(), so
-- created_by / actor_id record the administrator, never a service role.
CREATE OR REPLACE FUNCTION public.partner_caller_may_manage_keys(p_workspace_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.has_role(auth.uid(), 'admin'::public.app_role)
      OR EXISTS (
        SELECT 1 FROM public.workspace_members m
         WHERE m.workspace_id = p_workspace_id
           AND m.user_id = auth.uid()
           AND m.role IN ('owner', 'admin')
      );
$$;

-- revoke_partner_key carried its own inline copy of the membership rule.
-- Rewritten to consult the shared predicate; every other property is kept:
-- one-way, refuses an already-revoked key, actor stamped server-side, audit
-- row ONLY on a real revocation, returns BOOLEAN.
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
     AND public.partner_caller_may_manage_keys(k.workspace_id)
  RETURNING k.workspace_id INTO v_workspace_id;

  GET DIAGNOSTICS v_updated = ROW_COUNT;

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

-- ---------------------------------------------------------------------------
-- 4. Readers (D2)
-- ---------------------------------------------------------------------------

-- 4a. The four KPI cards in one row. Definitions are spec D7; the month
-- boundary is the same date_trunc('month', now()) reserve_partner_quota uses,
-- so the cards and the quota counters agree on what "this month" means.
CREATE OR REPLACE FUNCTION public.admin_partner_hub_overview()
RETURNS TABLE (
  active_keys        BIGINT,
  revoked_keys       BIGINT,
  month_billable     BIGINT,
  month_posts        BIGINT,
  requests_30d       BIGINT,
  success_30d        BIGINT,
  deliveries_30d     BIGINT,
  delivered_30d      BIGINT,
  exhausted_30d      BIGINT,
  pending_deliveries BIGINT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.partner_hub_assert_admin();
  RETURN QUERY
  SELECT
    (SELECT count(*) FROM public.partner_api_keys k
      WHERE k.revoked_at IS NULL
        AND k.superseded_by_key_id IS NULL
        AND (k.expires_at IS NULL OR k.expires_at > now())),
    (SELECT count(*) FROM public.partner_api_keys k WHERE k.revoked_at IS NOT NULL),
    (SELECT count(*) FROM public.partner_api_usage u
      WHERE u.billable AND u.created_at >= date_trunc('month', now())),
    (SELECT count(*) FROM public.partner_api_usage u
      WHERE u.action = 'create_post' AND u.http_status < 300
        AND u.created_at >= date_trunc('month', now())),
    (SELECT count(*) FROM public.partner_api_usage u
      WHERE u.created_at >= now() - interval '30 days'),
    (SELECT count(*) FROM public.partner_api_usage u
      WHERE u.created_at >= now() - interval '30 days' AND u.http_status < 400),
    (SELECT count(*) FROM public.partner_webhook_deliveries d
      WHERE d.created_at >= now() - interval '30 days'),
    (SELECT count(*) FROM public.partner_webhook_deliveries d
      WHERE d.created_at >= now() - interval '30 days' AND d.status = 'delivered'),
    (SELECT count(*) FROM public.partner_webhook_deliveries d
      WHERE d.created_at >= now() - interval '30 days' AND d.status = 'exhausted'),
    (SELECT count(*) FROM public.partner_webhook_deliveries d
      WHERE d.status IN ('pending', 'delivering'));
END;
$$;

-- 4b. Every key, every workspace. The charged total follows the SAME stale-
-- period rule as GET /v1/usage (usagePeriodFor): a row whose last_reset_at is
-- before this month has not been reset yet because nothing reserved, so it is
-- rendered as the next reservation will reset it -- zero.
CREATE OR REPLACE FUNCTION public.admin_partner_keys()
RETURNS TABLE (
  id                   UUID,
  name                 TEXT,
  environment          TEXT,
  key_prefix           TEXT,
  workspace_id         UUID,
  workspace_name       TEXT,
  social_account_id    UUID,
  account_platform     TEXT,
  account_username     TEXT,
  scopes               TEXT[],
  rate_limit_per_min   INTEGER,
  monthly_quota        INTEGER,
  usage_charged        INTEGER,
  usage_reserved       INTEGER,
  usage_confirmed      INTEGER,
  usage_indeterminate  INTEGER,
  period_start         TIMESTAMPTZ,
  status               TEXT,
  created_at           TIMESTAMPTZ,
  last_used_at         TIMESTAMPTZ,
  expires_at           TIMESTAMPTZ,
  revoked_at           TIMESTAMPTZ,
  revoked_reason       TEXT,
  superseded_by_key_id UUID
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.partner_hub_assert_admin();
  RETURN QUERY
  SELECT
    k.id, k.name, k.environment, k.key_prefix,
    k.workspace_id, w.name,
    k.social_account_id, a.platform, a.platform_username,
    k.scopes, k.rate_limit_per_min, k.monthly_quota,
    CASE WHEN k.last_reset_at < date_trunc('month', now()) THEN 0 ELSE k.current_usage_count END,
    CASE WHEN k.last_reset_at < date_trunc('month', now()) THEN 0 ELSE k.usage_reserved END,
    CASE WHEN k.last_reset_at < date_trunc('month', now()) THEN 0 ELSE k.usage_confirmed END,
    CASE WHEN k.last_reset_at < date_trunc('month', now()) THEN 0 ELSE k.usage_indeterminate END,
    GREATEST(k.last_reset_at, date_trunc('month', now())),
    CASE
      WHEN k.revoked_at IS NOT NULL THEN 'revoked'
      WHEN k.superseded_by_key_id IS NOT NULL THEN 'rotated'
      WHEN k.expires_at IS NOT NULL AND k.expires_at <= now() THEN 'expired'
      ELSE 'active'
    END,
    k.created_at, k.last_used_at, k.expires_at, k.revoked_at, k.revoked_reason,
    k.superseded_by_key_id
  FROM public.partner_api_keys k
  LEFT JOIN public.workspaces w ON w.id = k.workspace_id
  LEFT JOIN public.social_accounts a ON a.id = k.social_account_id
  ORDER BY k.created_at DESC;
END;
$$;

-- 4c. What a new key may be pinned to. WhatsApp accounts only (spec D8): the
-- composite FK proves an account is in the workspace, not that it can send,
-- and every /v1 messaging op assumes the bound account is WhatsApp. Health
-- flags come along so the form can refuse an unhealthy account the way
-- scripts/create-partner-key.ts does.
CREATE OR REPLACE FUNCTION public.admin_partner_key_targets()
RETURNS TABLE (
  workspace_id      UUID,
  workspace_name    TEXT,
  social_account_id UUID,
  platform          TEXT,
  platform_username TEXT,
  is_active         BOOLEAN,
  needs_reauth      BOOLEAN
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.partner_hub_assert_admin();
  RETURN QUERY
  SELECT w.id, w.name, a.id, a.platform, a.platform_username,
         COALESCE(a.is_active, false), COALESCE(a.needs_reauth, false)
    FROM public.social_accounts a
    JOIN public.workspaces w ON w.id = a.workspace_id
   WHERE a.platform = 'whatsapp'
   ORDER BY w.name, a.platform_username;
END;
$$;

-- 4d. Recent ledger rows for one key. Raises for an unknown key rather than
-- returning nothing -- for an admin, "no such key" is information.
CREATE OR REPLACE FUNCTION public.admin_partner_key_activity(
  p_key_id UUID,
  p_limit  INTEGER DEFAULT 50
)
RETURNS TABLE (
  id          UUID,
  created_at  TIMESTAMPTZ,
  action      TEXT,
  http_status INTEGER,
  error_code  TEXT,
  billable    BOOLEAN,
  request_id  TEXT,
  latency_ms  INTEGER
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.partner_hub_assert_admin();
  IF NOT EXISTS (SELECT 1 FROM public.partner_api_keys k WHERE k.id = p_key_id) THEN
    RAISE EXCEPTION 'no such partner key' USING ERRCODE = 'no_data_found';
  END IF;
  RETURN QUERY
  SELECT u.id, u.created_at, u.action, u.http_status, u.error_code, u.billable,
         u.request_id, u.latency_ms
    FROM public.partner_api_usage u
   WHERE u.key_id = p_key_id
   ORDER BY u.created_at DESC
   LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200);
END;
$$;

-- 4e. Webhook deliveries for the KEY'S WORKSPACE (spec D6): deliveries belong
-- to a subscription, and subscriptions belong to a workspace, not a key. The
-- secret columns are never projected.
CREATE OR REPLACE FUNCTION public.admin_partner_key_webhook_deliveries(
  p_key_id UUID,
  p_limit  INTEGER DEFAULT 50
)
RETURNS TABLE (
  id                UUID,
  occurred_at       TIMESTAMPTZ,
  event_type        TEXT,
  status            TEXT,
  attempts          INTEGER,
  next_attempt_at   TIMESTAMPTZ,
  last_status_code  INTEGER,
  last_error        TEXT,
  delivered_at      TIMESTAMPTZ,
  webhook_id        UUID,
  webhook_url       TEXT,
  webhook_is_active BOOLEAN
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_workspace_id UUID;
BEGIN
  PERFORM public.partner_hub_assert_admin();
  SELECT k.workspace_id INTO v_workspace_id FROM public.partner_api_keys k WHERE k.id = p_key_id;
  IF v_workspace_id IS NULL THEN
    RAISE EXCEPTION 'no such partner key' USING ERRCODE = 'no_data_found';
  END IF;
  RETURN QUERY
  SELECT d.id, d.occurred_at, d.event_type, d.status, d.attempts, d.next_attempt_at,
         d.last_status_code, d.last_error, d.delivered_at,
         w.id, w.url, w.is_active
    FROM public.partner_webhook_deliveries d
    JOIN public.partner_webhooks w ON w.id = d.webhook_id
   WHERE d.workspace_id = v_workspace_id
   ORDER BY d.created_at DESC
   LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200);
END;
$$;

-- ---------------------------------------------------------------------------
-- 5. Grants. The gate is inside each function, so `authenticated` may EXECUTE.
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.admin_partner_hub_overview() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_partner_keys() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_partner_key_targets() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_partner_key_activity(UUID, INTEGER) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_partner_key_webhook_deliveries(UUID, INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_partner_hub_overview() TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_partner_keys() TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_partner_key_targets() TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_partner_key_activity(UUID, INTEGER) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_partner_key_webhook_deliveries(UUID, INTEGER) TO authenticated;

-- PostgREST answers from a cached schema; without this a freshly created
-- function 404s until the next reload (memory: postora-migration-deploy-ordering).
NOTIFY pgrst, 'reload schema';
