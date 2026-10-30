import { describe, expect, it } from "vitest";
import { failedRetryTargets } from "../retryTargets";

describe("failedRetryTargets", () => {
  it("targets only the failed rows' platforms and accounts, never one that already succeeded", () => {
    const rows = [
      { platform: "facebook", status: "success", social_account_id: "fb-1" },
      { platform: "instagram", status: "failed", social_account_id: "ig-1" },
      { platform: "instagram", status: "failed", social_account_id: "ig-1" },
      { platform: "tiktok", status: "failed", social_account_id: "tt-1" },
    ];
    expect(failedRetryTargets(rows)).toEqual({ platforms: ["instagram", "tiktok"], accountIds: ["ig-1", "tt-1"] });
  });

  it("falls back to the platforms alone when a failed row names no account", () => {
    const rows = [
      { platform: "instagram", status: "failed", social_account_id: "ig-1" },
      { platform: "threads", status: "failed", social_account_id: null },
    ];
    expect(failedRetryTargets(rows)).toEqual({ platforms: ["instagram", "threads"], accountIds: [] });
  });

  it("has nothing to target when nothing failed", () => {
    expect(failedRetryTargets([{ platform: "facebook", status: "success", social_account_id: "fb-1" }]))
      .toEqual({ platforms: [], accountIds: [] });
    expect(failedRetryTargets(undefined)).toEqual({ platforms: [], accountIds: [] });
  });
});
