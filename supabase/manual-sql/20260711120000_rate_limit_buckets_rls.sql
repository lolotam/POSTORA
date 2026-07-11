-- ═══════════════════════════════════════════════════════════════════
-- Security hardening: lock down public.rate_limit_buckets
-- ═══════════════════════════════════════════════════════════════════
-- The rate_limit_buckets table is service-role only. It is written
-- exclusively by the check_rate_limit() RPC (invoked by edge functions
-- using the service-role key, which bypasses RLS). No end-user or
-- anon/authenticated PostgREST access is required or permitted.
--
-- Without RLS + explicit REVOKE, an authenticated attacker could:
--   1) DELETE their own IP-keyed row to reset OTP flood protection.
--   2) SELECT rows to enumerate IPs that recently triggered
--      security-sensitive flows.
--
-- Rollback:
--   ALTER TABLE public.rate_limit_buckets DISABLE ROW LEVEL SECURITY;
--   GRANT SELECT, INSERT, UPDATE, DELETE ON public.rate_limit_buckets TO authenticated;
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE public.rate_limit_buckets ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.rate_limit_buckets FROM PUBLIC;
REVOKE ALL ON public.rate_limit_buckets FROM anon;
REVOKE ALL ON public.rate_limit_buckets FROM authenticated;
GRANT  ALL ON public.rate_limit_buckets TO service_role;

-- No policies are created on purpose: with RLS enabled and no policy,
-- non-service roles get zero access. service_role bypasses RLS.
