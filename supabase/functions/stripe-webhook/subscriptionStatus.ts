// user_subscriptions_status_check permits exactly:
//   active | cancelled | expired | past_due
// Stripe sends its own status vocabulary — "canceled" with one L, plus
// "incomplete", "incomplete_expired", "trialing", "unpaid", "paused" — and
// forwarding any of those verbatim violates the constraint and aborts the
// whole UPDATE. Map explicitly and fail closed: an unrecognized status maps
// to a non-entitling value, because effective_user_quotas() grants plan
// entitlements only when user_subscriptions.status IS 'active' OR
// 'past_due' — dunning stays entitled (see the mapping below and
// supabase/migrations/20260823140100_effective_user_quotas.sql).
// 'cancelled' and 'expired' are the only two statuses that stop entitling.
export type PermittedSubscriptionStatus =
  | "active"
  | "cancelled"
  | "expired"
  | "past_due";

const STRIPE_STATUS_MAP: Record<string, PermittedSubscriptionStatus> = {
  active: "active",
  // A trialing subscription is live and receiving service; Postora has no
  // separate trial state, so keep it entitled.
  trialing: "active",
  past_due: "past_due",
  // Stripe keeps the subscription open while dunning continues. "past_due"
  // stays distinguishable from a lapsed subscription and matches what the
  // invoice.payment_failed handler already writes.
  unpaid: "past_due",
  // Stripe's one-L spelling; the constraint demands two.
  canceled: "cancelled",
  cancelled: "cancelled",
  // Never-activated states: no payment ever completed.
  incomplete: "expired",
  incomplete_expired: "expired",
};

export function mapStripeSubscriptionStatus(
  stripeStatus: string,
): PermittedSubscriptionStatus {
  return STRIPE_STATUS_MAP[stripeStatus] ?? "expired";
}
