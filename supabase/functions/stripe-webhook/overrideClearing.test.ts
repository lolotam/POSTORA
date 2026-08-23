import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { shouldClearQuotaOverrides } from "./overrideClearing.ts";

const PRO_PLAN_ID = "11111111-1111-4111-8111-111111111111";
const BUSINESS_PLAN_ID = "22222222-2222-4222-8222-222222222222";

Deno.test("shouldClearQuotaOverrides: real plan change with successful subscription write clears", () => {
  assertEquals(
    shouldClearQuotaOverrides({
      previousPlanId: PRO_PLAN_ID,
      resolvedPlanId: BUSINESS_PLAN_ID,
      subscriptionWriteFailed: false,
    }),
    true,
  );
});

Deno.test("shouldClearQuotaOverrides: real plan change with FAILED subscription write does not clear", () => {
  // The failure mode under fix: plan_id never moved, so the stale override
  // is the only thing still describing the customer's entitlements. It must
  // survive.
  assertEquals(
    shouldClearQuotaOverrides({
      previousPlanId: PRO_PLAN_ID,
      resolvedPlanId: BUSINESS_PLAN_ID,
      subscriptionWriteFailed: true,
    }),
    false,
  );
});

Deno.test("shouldClearQuotaOverrides: no real plan change clears nothing regardless of write outcome", () => {
  assertEquals(
    shouldClearQuotaOverrides({
      previousPlanId: PRO_PLAN_ID,
      resolvedPlanId: PRO_PLAN_ID,
      subscriptionWriteFailed: false,
    }),
    false,
  );
  assertEquals(
    shouldClearQuotaOverrides({
      previousPlanId: PRO_PLAN_ID,
      resolvedPlanId: PRO_PLAN_ID,
      subscriptionWriteFailed: true,
    }),
    false,
  );
});

Deno.test("shouldClearQuotaOverrides: checkout create path (no previous plan) clears on success", () => {
  assertEquals(
    shouldClearQuotaOverrides({
      previousPlanId: null,
      resolvedPlanId: PRO_PLAN_ID,
      subscriptionWriteFailed: false,
    }),
    true,
  );
});

Deno.test("shouldClearQuotaOverrides: checkout create path with FAILED subscription write does not clear", () => {
  assertEquals(
    shouldClearQuotaOverrides({
      previousPlanId: null,
      resolvedPlanId: PRO_PLAN_ID,
      subscriptionWriteFailed: true,
    }),
    false,
  );
});

Deno.test("shouldClearQuotaOverrides: unresolved plan id never clears, even on success", () => {
  // Unknown price ID or missing subscription_plans row: plan_id would not
  // move, so clearing overrides would strip the customer's protection while
  // the arbiter resolves the old plan.
  assertEquals(
    shouldClearQuotaOverrides({
      previousPlanId: PRO_PLAN_ID,
      resolvedPlanId: null,
      subscriptionWriteFailed: false,
    }),
    false,
  );
  assertEquals(
    shouldClearQuotaOverrides({
      previousPlanId: null,
      resolvedPlanId: null,
      subscriptionWriteFailed: false,
    }),
    false,
  );
});
