import { describe, it, expect } from "vitest";
import { shouldSyncQuotasForPlanChange } from "../AdminUsers";

// F4 (CodeRabbit round 1, 2026-08-23): changeRoleMutation used to call the
// set_user_quotas_for_plan RPC unconditionally, even when reassigning a
// subscriber to the SAME plan they already have — silently clearing a
// deliberate per-user override for no entitlement change at all. This pure
// predicate decides whether the RPC should run; the mutation must consult
// it and skip the call when the plan did not actually change.

describe("shouldSyncQuotasForPlanChange", () => {
  it("returns false when reassigning the same plan (no entitlement change)", () => {
    expect(shouldSyncQuotasForPlanChange("pro", "pro")).toBe(false);
  });

  it("returns true when the plan actually changes", () => {
    expect(shouldSyncQuotasForPlanChange("free", "pro")).toBe(true);
    expect(shouldSyncQuotasForPlanChange("pro", "business")).toBe(true);
  });

  it("returns true when the current plan is unknown (null/undefined) — fail safe by syncing", () => {
    expect(shouldSyncQuotasForPlanChange(null, "pro")).toBe(true);
    expect(shouldSyncQuotasForPlanChange(undefined, "pro")).toBe(true);
  });
});
