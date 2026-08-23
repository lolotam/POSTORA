/**
 * F5 (CodeRabbit round 1, 2026-08-23): the single client-side definition of
 * "which user_subscriptions.status values count as entitled to the plan".
 *
 * This mirrors the arbiter's own predicate, which is the source of truth:
 * effective_user_quotas() entitles 'active' OR 'past_due'
 * (supabase/migrations/20260823140100_effective_user_quotas.sql). Dunning is
 * a payment-collection state, not an entitlement state — Stripe keeps a
 * subscription open for its whole retry window and
 * supabase/functions/stripe-webhook writes status: "past_due" on
 * invoice.payment_failed rather than cancelling anything
 * (supabase/functions/stripe-webhook/subscriptionStatus.ts).
 *
 * Before this fix, individual reads and writes across the client each
 * hardcoded their own status filter — some `.eq("status", "active")`, one
 * `.in("status", ["active", "trialing"])` (dead: subscriptionStatus.ts maps
 * trialing -> active before it's ever written to this column) — so a
 * dunning user could show as paid in one place (AdminUsers.tsx, already
 * fixed to `.in("status", ["active", "past_due"])`) and Free in another
 * (AdminUserDetail.tsx), or be redirected to /pricing on login (Auth.tsx),
 * or silently rate-limited to Free-tier AI usage (useAIRateLimit.tsx) while
 * their card is still just being retried. Every reader AND writer of
 * "is this user entitled" must resolve the identical set of statuses, or
 * the client and the arbiter can disagree about who is a paying customer.
 */
export const ENTITLED_SUBSCRIPTION_STATUSES = ["active", "past_due"] as const;

export type EntitledSubscriptionStatus = (typeof ENTITLED_SUBSCRIPTION_STATUSES)[number];

/** True when `status` is one of the entitling values above. */
export function isEntitledSubscriptionStatus(
  status: string | null | undefined,
): status is EntitledSubscriptionStatus {
  return (
    status != null &&
    (ENTITLED_SUBSCRIPTION_STATUSES as readonly string[]).includes(status)
  );
}
