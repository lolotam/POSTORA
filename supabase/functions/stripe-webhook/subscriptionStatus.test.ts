import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { mapStripeSubscriptionStatus } from "./subscriptionStatus.ts";

// user_subscriptions_status_check permits exactly these values. Every mapped
// result must be a member or the whole UPDATE violates the constraint.
const PERMITTED = ["active", "cancelled", "expired", "past_due"] as const;

Deno.test("mapStripeSubscriptionStatus: every Stripe status maps to a permitted value", () => {
  const stripeStatuses = [
    "active",
    "trialing",
    "past_due",
    "unpaid",
    "canceled",
    "cancelled",
    "incomplete",
    "incomplete_expired",
    "paused",
  ];

  for (const stripeStatus of stripeStatuses) {
    const mapped = mapStripeSubscriptionStatus(stripeStatus);
    assertEquals(
      (PERMITTED as readonly string[]).includes(mapped),
      true,
      `Stripe status "${stripeStatus}" mapped to "${mapped}", which user_subscriptions_status_check rejects`,
    );
  }
});

Deno.test("mapStripeSubscriptionStatus: active and past_due map identity", () => {
  assertEquals(mapStripeSubscriptionStatus("active"), "active");
  assertEquals(mapStripeSubscriptionStatus("past_due"), "past_due");
});

Deno.test("mapStripeSubscriptionStatus: Stripe's one-L 'canceled' becomes two-L 'cancelled'", () => {
  assertEquals(mapStripeSubscriptionStatus("canceled"), "cancelled");
});

Deno.test("mapStripeSubscriptionStatus: trialing keeps service (active)", () => {
  assertEquals(mapStripeSubscriptionStatus("trialing"), "active");
});

Deno.test("mapStripeSubscriptionStatus: unpaid dunning maps to past_due, not expired", () => {
  assertEquals(mapStripeSubscriptionStatus("unpaid"), "past_due");
});

Deno.test("mapStripeSubscriptionStatus: never-activated states map to expired", () => {
  assertEquals(mapStripeSubscriptionStatus("incomplete"), "expired");
  assertEquals(mapStripeSubscriptionStatus("incomplete_expired"), "expired");
});

Deno.test("mapStripeSubscriptionStatus: unknown statuses fail closed to expired", () => {
  // The arbiter grants plan entitlements only on status 'active', so the
  // fallback for unrecognized statuses must be non-entitling.
  assertEquals(mapStripeSubscriptionStatus("paused"), "expired");
  assertEquals(mapStripeSubscriptionStatus("some_future_stripe_status"), "expired");
  assertEquals(mapStripeSubscriptionStatus(""), "expired");
});
