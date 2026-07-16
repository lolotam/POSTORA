import { describe, expect, it } from "vitest";
import { messagingTabFromSearch } from "../messagingTab";

describe("messagingTabFromSearch", () => {
  it("uses a supported tab parameter", () => {
    expect(messagingTabFromSearch("?tab=comments", "inbox", ["inbox", "comments"])).toBe("comments");
  });

  it("falls back when the tab parameter is unsupported", () => {
    expect(messagingTabFromSearch("?tab=unknown", "inbox", ["inbox", "comments"])).toBe("inbox");
  });
});
