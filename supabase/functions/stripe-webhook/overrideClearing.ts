// Decision helper for clearing user_quotas overrides in the webhook.
//
// The clear is only safe when the user_subscriptions write that establishes
// the new plan_id SUCCEEDED. If that write failed, plan_id still points at
// the OLD plan (or nothing), and the existing override is the only thing
// still describing the customer's entitlements — clearing it would leave a
// paying customer mid-upgrade on stale entitlements with the safety net
// removed. A null resolvedPlanId (unknown price, missing plan row) means the
// plan is not moving either, so it must not clear either.
export interface QuotaOverrideClearInput {
  /** Plan id stored on user_subscriptions before this event, null on the checkout create path. */
  previousPlanId: string | null;
  /** Plan id this event resolved for the customer, null if it could not be resolved. */
  resolvedPlanId: string | null;
  /** Whether the user_subscriptions upsert/update carrying the plan returned an error. */
  subscriptionWriteFailed: boolean;
}

export function shouldClearQuotaOverrides(
  input: QuotaOverrideClearInput,
): boolean {
  if (input.subscriptionWriteFailed) return false;
  if (input.resolvedPlanId === null) return false;
  return input.resolvedPlanId !== input.previousPlanId;
}
