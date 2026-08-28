// How many social accounts a user may keep connected.
//
// The frontend has always resolved this as: per-user override, then the active
// subscription plan's allowance, then the free-tier floor (src/hooks/useQuotas.tsx).
// The Direct QR connect path read only the override and fell back to 3, so a Pro
// subscriber entitled to 30 and a Business subscriber entitled to unlimited were
// both refused at 3 with "Social account quota reached. Upgrade your plan" —
// while the UI showed them the allowance they had actually paid for.
//
// -1 means unlimited in both `user_quotas.max_social_accounts` and
// `subscription_plans.max_social_accounts`; callers check for it themselves.

export const FREE_TIER_MAX_SOCIAL_ACCOUNTS = 3;

/** Only the two reads this resolver makes, so tests need no Supabase client. */
export interface SocialAccountQuotaClient {
  from(table: string): {
    select(columns: string): {
      eq(column: string, value: unknown): {
        eq(column: string, value: unknown): {
          maybeSingle(): Promise<{ data: unknown; error: unknown }>;
        };
        maybeSingle(): Promise<{ data: unknown; error: unknown }>;
      };
    };
  };
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Resolves the connected-account allowance for one user. A per-user override
 * wins; otherwise the active plan's allowance; otherwise the free-tier floor.
 * A row that exists with a NULL allowance is not an override — that is the
 * shape most rows in production actually have.
 */
export async function resolveMaxSocialAccounts(
  admin: SocialAccountQuotaClient,
  userId: string,
): Promise<number> {
  const { data: quota, error: quotaError } = await admin
    .from("user_quotas")
    .select("max_social_accounts")
    .eq("user_id", userId)
    .maybeSingle();
  if (quotaError) throw quotaError;

  const override = numberOrNull((quota as { max_social_accounts?: unknown } | null)?.max_social_accounts);
  if (override !== null) return override;

  const { data: subscription, error: planError } = await admin
    .from("user_subscriptions")
    .select("subscription_plans(max_social_accounts)")
    .eq("user_id", userId)
    .eq("status", "active")
    .maybeSingle();
  // A plan lookup failure must not hand out a bigger allowance than the caller
  // is entitled to, so it falls through to the free floor rather than throwing
  // and blocking a connect the user may legitimately be allowed to make.
  if (planError) return FREE_TIER_MAX_SOCIAL_ACCOUNTS;

  const plan = (subscription as { subscription_plans?: unknown } | null)?.subscription_plans;
  // PostgREST returns an embedded one-to-one as an object, but returns an array
  // when it cannot prove the relationship is to-one. Accept both.
  const planRow = Array.isArray(plan) ? plan[0] : plan;
  const planMax = numberOrNull((planRow as { max_social_accounts?: unknown } | null)?.max_social_accounts);

  return planMax ?? FREE_TIER_MAX_SOCIAL_ACCOUNTS;
}
