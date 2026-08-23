import Stripe from "https://esm.sh/stripe@18.5.0";

// Extracted from index.ts so it is importable by a unit test without
// triggering that file's Deno.serve() (see repo convention in
// supabase/functions/stripe-webhook/{overrideClearing,subscriptionStatus}.ts
// — index.ts itself is never imported directly by a unit test).

// Stripe Price ID to plan slug mapping
export const PRICE_TO_PLAN: Record<string, string> = {
  "price_1SpPKL0hJJ11XlNONGaoHAI0": "pro",     // Pro Monthly
  "price_1SpPL30hJJ11XlNO2wGUQHSn": "pro",     // Pro Yearly
  "price_1SpPLX0hJJ11XlNOuaId2Dfy": "business", // Business Monthly
  "price_1SpPLj0hJJ11XlNOqjV6RUAz": "business", // Business Yearly
};

// Limits live on subscription_plans and resolve through effective_user_quotas().
// Writing concrete numbers here would convert every subscriber into a permanent
// override at their plan's values as of that moment, and later edits on
// /admin/plan-quotas would never reach a paying user.
export const CLEARED_QUOTA_OVERRIDES = {
  max_profiles: null,
  max_social_accounts: null,
  max_posts_per_month: null,
  max_posts_per_day: null,
  max_media_uploads_per_day: null,
} as const;

// F3 (CodeRabbit round 1, 2026-08-23): Stripe API 2025-03-31 ("Basil")
// removed current_period_start/current_period_end from the top-level
// Subscription object; they now live per-item at
// subscription.items.data[n].current_period_start/end. This repo pins
// apiVersion "2025-08-27.basil" (see stripe-webhook/index.ts), which
// post-dates that change, so reading the top-level fields yields
// `undefined` and `new Date(undefined * 1000).toISOString()` throws
// RangeError: Invalid time value. Read from the first subscription item,
// with a safe fallback to the top-level field (older SDK typings / a
// mocked subscription in a test) and to null if neither is present -
// never let a webhook crash over an unresolved billing period.
// deno-lint-ignore no-explicit-any
export function resolveSubscriptionPeriod(subscription: any): {
  start: string | null;
  end: string | null;
} {
  const item = subscription?.items?.data?.[0];
  const rawStart = item?.current_period_start ?? subscription?.current_period_start ?? null;
  const rawEnd = item?.current_period_end ?? subscription?.current_period_end ?? null;
  return {
    start: typeof rawStart === "number" ? new Date(rawStart * 1000).toISOString() : null,
    end: typeof rawEnd === "number" ? new Date(rawEnd * 1000).toISOString() : null,
  };
}

export const logStep = (step: string, details?: unknown) => {
  const detailsStr = details ? ` - ${JSON.stringify(details)}` : "";
  console.log(`[SYNC-QUOTAS] ${step}${detailsStr}`);
};

/**
 * Repairs one user's plan from Stripe, then clears their per-user overrides
 * so the arbiter resolves the repaired plan on every subsequent read.
 *
 * Round-2 fix (final review I1): this used to compute `planSlug` from Stripe
 * and then discard it, upserting only NULL overrides. Since entitlements
 * come from user_subscriptions (via effective_user_quotas()), that left a
 * user with a missed webhook - the exact case this button exists for,
 * per its own description ("useful when webhooks are delayed or missed") -
 * resolving to the free plan even though Stripe still shows them paying.
 *
 * Fix: when Stripe shows an active subscription, upsert user_subscriptions
 * with the resolved plan_id and period fields BEFORE clearing the override,
 * so the arbiter has something correct to resolve to. Only then do the
 * overrides get cleared. A free/no-Stripe-subscription user has nothing to
 * repair here - there is no user_subscriptions row to write.
 */
// deno-lint-ignore no-explicit-any
export async function syncUserQuotas(
  supabase: any,
  stripe: Stripe,
  userId: string,
  email: string,
): Promise<string> {
  logStep("Checking Stripe for user", { userId, email });

  // Check Stripe for customer
  const customers = await stripe.customers.list({ email, limit: 1 });

  let planSlug = "free";
  let activeSubscription: Stripe.Subscription | null = null;
  let customerId: string | null = null;

  // Round-1 review fix (F2): a "status: 'active'" filter returns nothing for
  // a past_due (dunning) customer, which used to fall through to planSlug
  // "free" and write no user_subscriptions row - stranding exactly the
  // paying-but-retrying customer this branch's own arbiter decision protects
  // (effective_user_quotas() entitles 'active' OR 'past_due'; see
  // supabase/migrations/20260823140100_effective_user_quotas.sql). Fetch
  // "all" and filter to the entitled statuses ourselves instead.
  let subscriptionStatus: "active" | "past_due" = "active";

  if (customers.data.length > 0) {
    customerId = customers.data[0].id;

    const subscriptions = await stripe.subscriptions.list({
      customer: customerId,
      status: "all",
      limit: 10,
    });

    activeSubscription = subscriptions.data.find(
      (sub: Stripe.Subscription) => sub.status === "active" || sub.status === "past_due",
    ) ?? null;

    if (activeSubscription) {
      subscriptionStatus = activeSubscription.status === "past_due" ? "past_due" : "active";
      const priceId = activeSubscription.items.data[0]?.price?.id;

      if (priceId && PRICE_TO_PLAN[priceId]) {
        planSlug = PRICE_TO_PLAN[priceId];
      }
    }
  }

  logStep("Determined plan", { userId, planSlug });

  if (planSlug !== "free" && activeSubscription && customerId) {
    const { data: planRow, error: planLookupError } = await supabase
      .from("subscription_plans")
      .select("id")
      .eq("slug", planSlug)
      .maybeSingle();

    if (planLookupError) {
      throw new Error(`Plan lookup failed for slug ${planSlug}: ${planLookupError.message}`);
    }
    if (!planRow?.id) {
      throw new Error(`No subscription_plans row for slug ${planSlug}`);
    }

    const { start: periodStart, end: periodEnd } = resolveSubscriptionPeriod(activeSubscription);

    const { error: subUpsertError } = await supabase
      .from("user_subscriptions")
      .upsert({
        user_id: userId,
        plan_id: planRow.id,
        // F2: a repaired dunning subscription must be written as past_due,
        // not silently upgraded to active - PermittedSubscriptionStatus
        // (stripe-webhook/subscriptionStatus.ts) only permits
        // active|cancelled|expired|past_due, and effective_user_quotas()
        // already entitles both.
        status: subscriptionStatus,
        stripe_customer_id: customerId,
        stripe_subscription_id: activeSubscription.id,
        current_period_start: periodStart,
        current_period_end: periodEnd,
        cancel_at_period_end: activeSubscription.cancel_at_period_end,
      }, {
        onConflict: "user_id",
      });

    if (subUpsertError) {
      throw new Error(`Failed to repair user_subscriptions: ${subUpsertError.message}`);
    }

    logStep("Repaired user_subscriptions from Stripe", { userId, planSlug });
  }

  // Stamp NULL (inherit) so the arbiter resolves the plan's current values -
  // now that user_subscriptions (when paid) reflects the resolved plan above.
  const { error: upsertError } = await supabase
    .from("user_quotas")
    .upsert({
      user_id: userId,
      ...CLEARED_QUOTA_OVERRIDES,
      updated_at: new Date().toISOString(),
    }, {
      onConflict: "user_id",
    });

  if (upsertError) {
    throw new Error(`Failed to update quotas: ${upsertError.message}`);
  }

  // Update user role if subscribed
  if (planSlug !== "free") {
    await supabase
      .from("user_roles")
      .upsert({
        user_id: userId,
        role: "subscriber",
        updated_at: new Date().toISOString(),
      }, {
        onConflict: "user_id",
      });
  }

  logStep("Quotas synced", { userId, planSlug });
  return planSlug;
}
