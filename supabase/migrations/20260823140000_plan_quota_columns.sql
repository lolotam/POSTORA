-- Plan entitlements become database-backed so /admin/plan-quotas can edit them.
-- Spec: docs/specs/2026-08-23-unified-plan-quotas.md (R1).
--
-- profile_limit is deliberately NOT renamed to max_profiles: it is read by the
-- public pricing page (PlanCard.tsx, PlanComparison.tsx), useSubscription,
-- useSubscriptionPlans and AdminUsers. It stays the canonical profile column and
-- these four join it.

ALTER TABLE public.subscription_plans
  ADD COLUMN IF NOT EXISTS max_social_accounts       integer,
  ADD COLUMN IF NOT EXISTS max_posts_per_month       integer,
  ADD COLUMN IF NOT EXISTS max_posts_per_day         integer,
  ADD COLUMN IF NOT EXISTS max_media_uploads_per_day integer;

COMMENT ON COLUMN public.subscription_plans.max_posts_per_day IS
  '-1 = unlimited. Resolved through effective_user_quotas(); never read directly.';

-- Round-1 amendment A1: omitted INSERT columns on user_quotas take these
-- defaults, in column order profiles/accounts/month/day/uploads
-- (2/4/20/2/20), which would make every new row a pinned override
-- instead of inheriting its plan. NULL must mean inherit.
ALTER TABLE public.user_quotas
  ALTER COLUMN max_profiles              DROP DEFAULT,
  ALTER COLUMN max_social_accounts       DROP DEFAULT,
  ALTER COLUMN max_posts_per_month       DROP DEFAULT,
  ALTER COLUMN max_posts_per_day         DROP DEFAULT,
  ALTER COLUMN max_media_uploads_per_day DROP DEFAULT;

-- Round-1 amendment A15: seed each column independently via per-column
-- COALESCE, not a whole-row IS NULL guard. This repairs a partially-seeded
-- row while preserving any column an admin has already tuned.
UPDATE public.subscription_plans SET
  max_social_accounts       = COALESCE(max_social_accounts, 3),
  max_posts_per_month       = COALESCE(max_posts_per_month, 30),
  max_posts_per_day         = COALESCE(max_posts_per_day, 2),
  max_media_uploads_per_day = COALESCE(max_media_uploads_per_day, 20)
WHERE slug = 'free';

UPDATE public.subscription_plans SET
  max_social_accounts       = COALESCE(max_social_accounts, 30),
  max_posts_per_month       = COALESCE(max_posts_per_month, 500),
  max_posts_per_day         = COALESCE(max_posts_per_day, 30),
  max_media_uploads_per_day = COALESCE(max_media_uploads_per_day, -1)
WHERE slug = 'pro';

UPDATE public.subscription_plans SET
  max_social_accounts       = COALESCE(max_social_accounts, -1),
  max_posts_per_month       = COALESCE(max_posts_per_month, -1),
  max_posts_per_day         = COALESCE(max_posts_per_day, -1),
  max_media_uploads_per_day = COALESCE(max_media_uploads_per_day, -1)
WHERE slug = 'business';

-- Round-1 amendment A6: the public policy on subscription_plans is
-- (is_active = true) — verified on prod. A subscriber on a deactivated plan
-- cannot read their own entitlements under that policy alone. Add an
-- owner-scoped read policy so a user can always read the plan they are
-- actually subscribed to, active or not. The existing active-only public
-- policy is unchanged.
--
-- Round-2 fix (final review C1): 'past_due' counts as subscribed here too,
-- matching effective_user_quotas() (20260823140100) - a dunning customer
-- must still be able to read the plan they are entitled to.
--
-- CREATE POLICY has no IF NOT EXISTS clause, so this is guarded explicitly
-- to keep the migration replayable.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'subscription_plans'
      AND policyname = 'Users can view their own subscribed plan'
  ) THEN
    CREATE POLICY "Users can view their own subscribed plan"
      ON public.subscription_plans FOR SELECT TO authenticated
      USING (EXISTS (
        SELECT 1 FROM public.user_subscriptions us
        WHERE us.user_id = auth.uid() AND us.status IN ('active', 'past_due') AND us.plan_id = subscription_plans.id
      ));
  END IF;
END $$;
