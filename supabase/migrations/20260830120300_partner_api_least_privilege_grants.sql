
-- Partner API v1, Phase 0 closeout: least-privilege grants on the four
-- foundation tables (20260813120000_partner_api_foundation.sql).
--
-- The foundation migration created these tables and relied on Supabase's
-- default privileges, which hand anon, authenticated and service_role FULL
-- table privileges — including DELETE, UPDATE and TRUNCATE — on billing
-- history (partner_api_usage), credential records (partner_api_keys),
-- idempotency state (partner_api_idempotency) and rate buckets
-- (partner_api_rate_buckets).
--
-- This is not a live exploit: RLS is enabled on all four with few or no
-- policies, so anon and authenticated are in practice denied today. The
-- problem is that defence in depth has already collapsed to one layer —
-- service_role holds BYPASSRLS, so these grants are the ONLY thing standing
-- between any service-role code path and a TRUNCATE of the billing ledger —
-- and a future CREATE POLICY on any of these tables would silently hand anon
-- everything the grants allow. This migration makes the grant surface say
-- what the code actually does.
--
-- Verified callers (every JS/table touch, edge functions + scripts):
--   partner_api_keys          SELECT  _shared/partnerApiKeys.ts (auth lookup)
--                             INSERT  scripts/create-partner-key.ts
--                             authenticated SELECT via the "Workspace admins
--                             read partner keys" RLS policy (foundation)
--   partner_api_usage         INSERT  _shared/partnerApiMetering.ts recordUsage
--   partner_api_idempotency   UPDATE  _shared/partnerApiIdempotency.ts
--                                     (settle + markIndeterminate); the claim
--                                     itself goes through the SECURITY DEFINER
--                                     RPC claim_partner_idempotency
--   partner_api_rate_buckets  nothing — only consume_partner_rate and
--                             consume_partner_rate_v2 touch it, both SECURITY
--                             DEFINER, running as the function owner, which
--                             does not consult the caller's table grants
--
-- The UPDATEs on partner_api_keys (quota counters, last_used_at, revocation)
-- all go through SECURITY DEFINER RPCs (reserve_partner_quota,
-- release_partner_quota, touch_partner_key, revoke_partner_key), so no role
-- needs a table-level UPDATE for any of them to keep working.
--
-- Idiom follows 20260830120100_partner_audit_logs.sql: revoke everything
-- explicitly, then re-grant only what is used. Default privileges are not
-- relied upon.

-- partner_api_keys -----------------------------------------------------------
REVOKE ALL ON public.partner_api_keys FROM PUBLIC;
REVOKE ALL ON public.partner_api_keys FROM anon;
REVOKE ALL ON public.partner_api_keys FROM authenticated;
REVOKE ALL ON public.partner_api_keys FROM service_role;
GRANT SELECT, INSERT ON public.partner_api_keys TO service_role;
-- Column-level SELECT, mirroring the foundation migration exactly: key_hash is
-- never selectable by a client. Re-granting table-level SELECT here would
-- widen authenticated beyond what the foundation migration deliberately gave it.
GRANT SELECT (id, workspace_id, social_account_id, created_by, revoked_by,
              revoked_reason, name, key_prefix, scopes, rate_limit_per_min,
              monthly_quota, current_usage_count, last_reset_at, last_used_at,
              expires_at, revoked_at, created_at, updated_at)
  ON public.partner_api_keys TO authenticated;

-- partner_api_usage: append-only billing ledger. service_role may INSERT a
-- row; nothing else — history is read back by the owner through deliberate
-- operational queries, not by application code.
REVOKE ALL ON public.partner_api_usage FROM PUBLIC;
REVOKE ALL ON public.partner_api_usage FROM anon;
REVOKE ALL ON public.partner_api_usage FROM authenticated;
REVOKE ALL ON public.partner_api_usage FROM service_role;
GRANT INSERT ON public.partner_api_usage TO service_role;

-- partner_api_idempotency: SELECT to inspect claim state operationally,
-- UPDATE for the edge function's settle/markIndeterminate writes. The INSERT
-- and the expiry pruning inside claim_partner_idempotency run as that
-- function's SECURITY DEFINER owner and need no grant here.
REVOKE ALL ON public.partner_api_idempotency FROM PUBLIC;
REVOKE ALL ON public.partner_api_idempotency FROM anon;
REVOKE ALL ON public.partner_api_idempotency FROM authenticated;
REVOKE ALL ON public.partner_api_idempotency FROM service_role;
GRANT SELECT, UPDATE ON public.partner_api_idempotency TO service_role;

-- partner_api_rate_buckets: no grants at all. The only touchers are
-- consume_partner_rate and consume_partner_rate_v2, both SECURITY DEFINER —
-- they run as the function owner and never consult the caller's table
-- privileges. service_role still reaches the bucket through EXECUTE on those
-- functions (granted in their own migrations), which is unaffected here.
REVOKE ALL ON public.partner_api_rate_buckets FROM PUBLIC;
REVOKE ALL ON public.partner_api_rate_buckets FROM anon;
REVOKE ALL ON public.partner_api_rate_buckets FROM authenticated;
REVOKE ALL ON public.partner_api_rate_buckets FROM service_role;
