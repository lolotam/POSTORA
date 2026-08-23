-- The single arbiter for "what is this user allowed to do".
-- Spec: docs/specs/2026-08-23-unified-plan-quotas.md (R2).
--
-- Resolution, per column:  user override -> plan entitlement -> free literal.
--
-- NULL in user_quotas.max_* means INHERIT. A non-null value is a deliberate
-- admin override and wins outright, in both directions - it may lower a user
-- below their plan, which is how an abusive account gets capped.
--
-- The trailing free literals are a last-resort guard for a missing or unseeded
-- 'free' plan row. They are unreachable in normal operation and are the ONLY
-- hardcoded quota numbers left in the system.

CREATE OR REPLACE FUNCTION public.effective_user_quotas(p_user_id uuid)
RETURNS TABLE (
  max_profiles              integer,
  max_social_accounts       integer,
  max_posts_per_month       integer,
  max_posts_per_day         integer,
  max_media_uploads_per_day integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH plan AS (
    SELECT sp.profile_limit, sp.max_social_accounts, sp.max_posts_per_month,
           sp.max_posts_per_day, sp.max_media_uploads_per_day
    FROM public.subscription_plans sp
    WHERE sp.id = (
      SELECT us.plan_id FROM public.user_subscriptions us
      WHERE us.user_id = p_user_id AND us.status = 'active'
      -- Round-1 amendment A5: full three-part tie-breaker. There is no
      -- uniqueness constraint on active subscriptions, so two active rows
      -- with equal or NULL current_period_end must still resolve
      -- deterministically, or the arbiter and the backfill can disagree.
      ORDER BY us.current_period_end DESC NULLS LAST, us.created_at DESC, us.id DESC
      LIMIT 1
    )
    UNION ALL
    -- Fallback branch: no active subscription -> the free plan row.
    SELECT sp.profile_limit, sp.max_social_accounts, sp.max_posts_per_month,
           sp.max_posts_per_day, sp.max_media_uploads_per_day
    FROM public.subscription_plans sp
    WHERE sp.slug = 'free'
      AND NOT EXISTS (
        SELECT 1 FROM public.user_subscriptions us
        WHERE us.user_id = p_user_id AND us.status = 'active'
      )
    LIMIT 1
  ),
  override AS (
    SELECT uq.max_profiles, uq.max_social_accounts, uq.max_posts_per_month,
           uq.max_posts_per_day, uq.max_media_uploads_per_day
    FROM public.user_quotas uq
    WHERE uq.user_id = p_user_id
  )
  SELECT
    COALESCE((SELECT o.max_profiles FROM override o),
             (SELECT p.profile_limit FROM plan p), 2),
    COALESCE((SELECT o.max_social_accounts FROM override o),
             (SELECT p.max_social_accounts FROM plan p), 3),
    COALESCE((SELECT o.max_posts_per_month FROM override o),
             (SELECT p.max_posts_per_month FROM plan p), 30),
    COALESCE((SELECT o.max_posts_per_day FROM override o),
             (SELECT p.max_posts_per_day FROM plan p), 2),
    COALESCE((SELECT o.max_media_uploads_per_day FROM override o),
             (SELECT p.max_media_uploads_per_day FROM plan p), 20);
$$;

COMMENT ON FUNCTION public.effective_user_quotas(uuid) IS
  'Single source of truth for a user''s limits: override -> plan -> free literal. -1 = unlimited.';

-- Round-1 amendment A14: service_role only. No client path calls this RPC,
-- and the SQL readers that will call it are SECURITY DEFINER running as the
-- definer, so they need no grant. Granting authenticated would let any user
-- read any other user's limits by passing their uuid (ARCHITECTURE.md §23
-- requires caller/resource scope validation). Revoking is safer than an
-- auth.uid() guard, which would break the post trigger - that runs with
-- auth.uid() NULL.
--
-- anon and authenticated are named explicitly, not just PUBLIC: this schema's
-- default privileges (see pg_default_acl) grant EXECUTE on every new public
-- function to anon and authenticated individually at creation time, so
-- REVOKE ALL FROM PUBLIC alone does not remove them. Verified empirically in
-- the quota_rehearsal harness and matches the established pattern elsewhere
-- in this repo (e.g. 20260813120000_partner_api_foundation.sql,
-- 20260820130000_higgsfield_oauth_and_generation.sql).
REVOKE ALL ON FUNCTION public.effective_user_quotas(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.effective_user_quotas(uuid) TO service_role;
