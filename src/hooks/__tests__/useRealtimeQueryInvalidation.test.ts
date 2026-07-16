import { describe, expect, it } from "vitest";
import { matchesRealtimeAccountEvent } from "../useRealtimeQueryInvalidation";

describe("matchesRealtimeAccountEvent", () => {
  it("accepts an event for the selected account and user", () => {
    expect(matchesRealtimeAccountEvent(
      { user_id: "user-1", social_account_id: "account-1" },
      "user-1",
      "account-1",
    )).toBe(true);
  });

  it("rejects another user's event", () => {
    expect(matchesRealtimeAccountEvent(
      { user_id: "user-2", social_account_id: "account-1" },
      "user-1",
      "account-1",
    )).toBe(false);
  });
});
