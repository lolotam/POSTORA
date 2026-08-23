import { describe, expect, it } from "vitest";
import {
  FREE_TIER_FALLBACK,
  mediaUploadLimitMessage,
  resolvePlanLimits,
} from "../useQuotas";

describe("resolvePlanLimits", () => {
  const proPlan = {
    profile_limit: 15,
    max_social_accounts: 30,
    max_posts_per_month: 500,
    max_posts_per_day: 30,
    max_media_uploads_per_day: -1,
  };

  it("inherits the plan when the override is null", () => {
    expect(resolvePlanLimits(proPlan, null).max_posts_per_day).toBe(30);
  });

  it("inherits the plan when an override column is null", () => {
    expect(
      resolvePlanLimits(proPlan, { max_posts_per_day: null as unknown as number }).max_posts_per_day,
    ).toBe(30);
  });

  it("lets an override raise the plan", () => {
    expect(resolvePlanLimits(proPlan, { max_posts_per_day: 999 }).max_posts_per_day).toBe(999);
  });

  it("lets an override lower the plan", () => {
    expect(resolvePlanLimits(proPlan, { max_posts_per_day: 1 }).max_posts_per_day).toBe(1);
  });

  it("maps profile_limit onto max_profiles", () => {
    expect(resolvePlanLimits(proPlan, null).max_profiles).toBe(15);
  });

  it("falls back to the free tier when the plan query returned nothing", () => {
    expect(resolvePlanLimits(null, null)).toEqual(FREE_TIER_FALLBACK);
  });

  it("keeps -1 as unlimited rather than treating it as a small number", () => {
    expect(resolvePlanLimits(proPlan, null).max_media_uploads_per_day).toBe(-1);
  });
});

describe("media upload denial message (A11)", () => {
  it("quotes the resolved plan limit, not the hardcoded free default of 20", () => {
    // A Free plan whose uploads/day was edited from 20 down to 10 in the admin
    // plan editor. The user_quotas override column is NULL (inherit), which is
    // the normal state after the backfill.
    const freePlanEditedTo10 = {
      profile_limit: 2,
      max_social_accounts: 3,
      max_posts_per_month: 30,
      max_posts_per_day: 2,
      max_media_uploads_per_day: 10,
    };

    const resolved = resolvePlanLimits(freePlanEditedTo10, null);

    expect(resolved.max_media_uploads_per_day).toBe(10);
    expect(mediaUploadLimitMessage(resolved.max_media_uploads_per_day)).toContain(
      "daily limit of 10 media uploads",
    );
    expect(mediaUploadLimitMessage(resolved.max_media_uploads_per_day)).not.toContain("20");
  });
});
