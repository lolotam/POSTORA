import { describe, expect, it } from "vitest";
import { failedRetryTargets, hasNonRetryableOutcome } from "../retryTargets";

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

  it("leaves out a failed row that names no account, never widening to every account", () => {
    const rows = [
      { platform: "instagram", status: "failed", social_account_id: "ig-1" },
      { platform: "threads", status: "failed", social_account_id: null },
    ];
    expect(failedRetryTargets(rows)).toEqual({ platforms: ["instagram"], accountIds: ["ig-1"] });
    expect(failedRetryTargets([{ platform: "threads", status: "failed", social_account_id: null }]))
      .toEqual({ platforms: [], accountIds: [] });
  });

  it("has nothing to target when nothing failed", () => {
    expect(failedRetryTargets([{ platform: "facebook", status: "success", social_account_id: "fb-1" }]))
      .toEqual({ platforms: [], accountIds: [] });
    expect(failedRetryTargets(undefined)).toEqual({ platforms: [], accountIds: [] });
  });

  it.each([
    { name: "unknown", marker: "uncertain" },
    { name: "cancelled", marker: "cancelled" },
  ])("leaves out a result whose outcome is $name, because a retry could publish twice", ({ marker }) => {
    const rows = [
      { platform: "instagram", status: "failed", social_account_id: "ig-1", response_data: { publish_outcome: marker } },
      { platform: "tiktok", status: "failed", social_account_id: "tt-1" },
    ];
    expect(failedRetryTargets(rows)).toEqual({ platforms: ["tiktok"], accountIds: ["tt-1"] });
  });
});

it("blocks an account with an uncertain Threads image despite an older failed result", () => {
  expect(failedRetryTargets([
    { platform: "threads", status: "failed", social_account_id: "threads-1" },
    { platform: "threads", status: "failed", social_account_id: "threads-1",
      response_data: { deferred: { media_type: "IMAGE", publish_outcome: "uncertain" } } },
    { platform: "instagram", status: "failed", social_account_id: "instagram-1" },
  ])).toEqual({ platforms: ["instagram"], accountIds: ["instagram-1"] });
});

it.each(["pending", "success"])("blocks an older YouTube failure when the account also has a %s result", (status) => {
  expect(failedRetryTargets([
    { platform: "youtube", status: "failed", social_account_id: "youtube-1" },
    { platform: "youtube", status, social_account_id: "youtube-1" },
  ]).accountIds).toEqual([]);
});

describe("hasNonRetryableOutcome", () => {
  it.each([
    { name: "an unknown outcome", response_data: { publish_outcome: "uncertain" } },
    { name: "a cancelled outcome", response_data: { publish_outcome: "cancelled" } },
  ])("reads $name off the result row", ({ response_data }) => {
    expect(hasNonRetryableOutcome({ platform: "instagram", status: "failed", social_account_id: "ig-1", response_data })).toBe(true);
  });

  it.each([
    { name: "no marker", response_data: undefined },
    { name: "no response data", response_data: null },
    { name: "a proven failure", response_data: { publish_outcome: "failed" } },
  ])("leaves a row with $name alone", ({ response_data }) => {
    expect(hasNonRetryableOutcome({ platform: "instagram", status: "failed", social_account_id: "ig-1", response_data })).toBe(false);
  });
});
