import { describe, it, expect } from "vitest";
import {
  ENTITLED_SUBSCRIPTION_STATUSES,
  isEntitledSubscriptionStatus,
} from "../subscriptionStatus";

// F5 (CodeRabbit round 1, 2026-08-23): single shared predicate for "is this
// user_subscriptions row entitled". Must match the arbiter's
// status IN ('active', 'past_due') exactly.

describe("ENTITLED_SUBSCRIPTION_STATUSES", () => {
  it("is exactly active and past_due — matches effective_user_quotas()", () => {
    expect([...ENTITLED_SUBSCRIPTION_STATUSES].sort()).toEqual(["active", "past_due"]);
  });
});

describe("isEntitledSubscriptionStatus", () => {
  it("treats active as entitled", () => {
    expect(isEntitledSubscriptionStatus("active")).toBe(true);
  });

  it("treats past_due (dunning) as entitled", () => {
    expect(isEntitledSubscriptionStatus("past_due")).toBe(true);
  });

  it("treats cancelled and expired as NOT entitled", () => {
    expect(isEntitledSubscriptionStatus("cancelled")).toBe(false);
    expect(isEntitledSubscriptionStatus("expired")).toBe(false);
  });

  it("treats null/undefined (no subscription row) as NOT entitled", () => {
    expect(isEntitledSubscriptionStatus(null)).toBe(false);
    expect(isEntitledSubscriptionStatus(undefined)).toBe(false);
  });
});
