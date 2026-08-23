-- Capability-preserving backfill of user_quotas overrides.
-- Spec: docs/specs/2026-08-23-unified-plan-quotas.md (R3).
--
-- THE INVARIANT: no user's effective limit may decrease.
--
-- Stated as an invariant, not a list of default values, deliberately. Eight
-- different code paths wrote these columns with four different "free" tuples
-- (see spec section 1.2), so a value-list rule would miss buckets - notably the
-- 46 rows holding max_profiles=1, which a naive rule would preserve as an
-- override BELOW the free plan's 2, silently capping every free user.
--
-- Rule: NULL a column unless the stored value is strictly MORE permissive than
-- what the plan resolves to. -1 is the most permissive value of all.

-- Round-1 amendment A5: guard against duplicate active subscriptions before
-- touching any row. There is no uniqueness constraint on
-- user_subscriptions(user_id) WHERE status = 'active', so an unresolved
-- duplicate would leave the tie-break below (and effective_user_quotas())
-- silently picking a winner with no record of the decision. Fail loudly
-- instead - these must be resolved by hand before this migration runs.
DO $$
BEGIN
  ASSERT NOT EXISTS (
    SELECT 1 FROM public.user_subscriptions
    WHERE status = 'active'
    GROUP BY user_id
    HAVING count(*) > 1
  ), 'duplicate active subscriptions must be resolved before backfilling';
END $$;

WITH resolved AS (
  SELECT
    uq.user_id,
    uq.max_profiles              AS u_profiles,
    uq.max_social_accounts       AS u_accounts,
    uq.max_posts_per_month       AS u_month,
    uq.max_posts_per_day         AS u_day,
    uq.max_media_uploads_per_day AS u_uploads,
    -- Round-1 amendment A4: COALESCE every resolved plan column to its free
    -- literal BEFORE the CASE ladder, mirroring effective_user_quotas()
    -- exactly. Comparing against a raw nullable sp.* column is the blocker
    -- this fixes: with a missing free plan row every comparison below would
    -- be NULL, the ladder would fall to ELSE NULL, and an admin's -1
    -- override would get erased down to a finite value.
    COALESCE(sp.profile_limit, 2)              AS p_profiles,
    COALESCE(sp.max_social_accounts, 3)        AS p_accounts,
    COALESCE(sp.max_posts_per_month, 30)       AS p_month,
    COALESCE(sp.max_posts_per_day, 2)          AS p_day,
    COALESCE(sp.max_media_uploads_per_day, 20) AS p_uploads
  FROM public.user_quotas uq
  LEFT JOIN LATERAL (
    SELECT s.plan_id FROM public.user_subscriptions s
    WHERE s.user_id = uq.user_id AND s.status = 'active'
    -- Round-1 amendment A5: the same three-clause deterministic tie-break
    -- used by effective_user_quotas(). Divergence here is exactly how the
    -- backfill and the arbiter would come to disagree on an ambiguous row.
    ORDER BY s.current_period_end DESC NULLS LAST, s.created_at DESC, s.id DESC
    LIMIT 1
  ) sub ON true
  LEFT JOIN public.subscription_plans sp
    ON sp.id = COALESCE(sub.plan_id,
                        (SELECT id FROM public.subscription_plans WHERE slug = 'free'))
)
UPDATE public.user_quotas uq
SET
  max_profiles = CASE
    WHEN r.u_profiles IS NULL THEN NULL
    WHEN r.u_profiles = -1 AND r.p_profiles <> -1 THEN r.u_profiles
    WHEN r.p_profiles = -1 THEN NULL
    WHEN r.u_profiles > r.p_profiles THEN r.u_profiles
    ELSE NULL END,
  max_social_accounts = CASE
    WHEN r.u_accounts IS NULL THEN NULL
    WHEN r.u_accounts = -1 AND r.p_accounts <> -1 THEN r.u_accounts
    WHEN r.p_accounts = -1 THEN NULL
    WHEN r.u_accounts > r.p_accounts THEN r.u_accounts
    ELSE NULL END,
  max_posts_per_month = CASE
    WHEN r.u_month IS NULL THEN NULL
    WHEN r.u_month = -1 AND r.p_month <> -1 THEN r.u_month
    WHEN r.p_month = -1 THEN NULL
    WHEN r.u_month > r.p_month THEN r.u_month
    ELSE NULL END,
  max_posts_per_day = CASE
    WHEN r.u_day IS NULL THEN NULL
    WHEN r.u_day = -1 AND r.p_day <> -1 THEN r.u_day
    WHEN r.p_day = -1 THEN NULL
    WHEN r.u_day > r.p_day THEN r.u_day
    ELSE NULL END,
  max_media_uploads_per_day = CASE
    WHEN r.u_uploads IS NULL THEN NULL
    WHEN r.u_uploads = -1 AND r.p_uploads <> -1 THEN r.u_uploads
    WHEN r.p_uploads = -1 THEN NULL
    WHEN r.u_uploads > r.p_uploads THEN r.u_uploads
    ELSE NULL END,
  updated_at = now()
FROM resolved r
WHERE r.user_id = uq.user_id;
