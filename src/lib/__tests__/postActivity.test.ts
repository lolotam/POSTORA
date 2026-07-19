import { describe, expect, it } from "vitest";
import { getPostActivityTimestamp } from "../postActivity";

describe("getPostActivityTimestamp", () => {
  it("shows the July publishing time instead of the original creation time", () => {
    const activityTimestamp = getPostActivityTimestamp({
      created_at: "2026-07-05T14:29:35.732Z",
      scheduled_at: "2026-07-19T01:48:22.974Z",
      posted_at: "2026-07-19T02:22:24.919Z",
    });

    expect(activityTimestamp).toBe(new Date("2026-07-19T02:22:24.919Z").getTime());
  });
});
