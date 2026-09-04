import { describe, expect, it } from "vitest";
import { explainWorkflowError } from "../eventErrors";

describe("explainWorkflowError", () => {
  it.each([
    [
      // Meta's actual message, docs link included, from the 2026-09-04 production funnel test:
      // the owner had commented as their other Page. What they need is the "why", not the link.
      "Private replies to Facebook Pages are not allowed. Please refer to the developer docs: https://developers.facebook.com/docs/messenger-platform/discovery/private-replies",
      /commenter is a Facebook Page/,
    ],
    ["private_reply_window_elapsed", /older than 7 days/],
    ["usage_claim_failed", /nothing was sent/],
  ])("explains a known failure in plain words: %s", (raw, expected) => {
    expect(explainWorkflowError(raw)).toMatch(expected);
  });

  it("passes an unknown message through unchanged", () => {
    expect(explainWorkflowError("(#200) Permissions error")).toBe("(#200) Permissions error");
  });

  it("returns null for no error", () => {
    expect(explainWorkflowError(null)).toBeNull();
    expect(explainWorkflowError("   ")).toBeNull();
  });
});
