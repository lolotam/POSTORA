import { describe, expect, it } from "vitest";
import { resolveAgentSurface } from "@/lib/agentSurface";

describe("resolveAgentSurface", () => {
  it("shows both surfaces by default where comments exist", () => {
    expect(resolveAgentSurface(null, true)).toMatchObject({
      dmsActive: true,
      commentsActive: true,
      surface: "both",
    });
  });

  it("shows only DMs on a platform without comments", () => {
    expect(resolveAgentSurface(null, false)).toMatchObject({
      dmsActive: true,
      commentsActive: false,
      surface: "dms",
    });
  });

  it("honours an explicit comments-only choice", () => {
    expect(resolveAgentSurface("comments", true)).toMatchObject({
      dmsActive: false,
      commentsActive: true,
      surface: "comments",
    });
  });

  it("never leaves the page with nothing selected", () => {
    // Comments-only preference on WhatsApp: inapplicable, so DMs are shown.
    expect(resolveAgentSurface("comments", false)).toMatchObject({
      dmsActive: true,
      commentsActive: false,
      surface: "dms",
    });
  });

  /**
   * The reported bug, 2026-09-01: "select the comment button, go to WhatsApp,
   * come back to the other social media — it's not saved".
   *
   * WhatsApp cannot serve comments, but visiting it must not DESTROY the
   * preference. The preference is a string carried in the URL; only the
   * rendering is narrowed. This is the round trip.
   */
  it("survives a hop through a platform that has no comments", () => {
    const preference = "comments";
    expect(resolveAgentSurface(preference, false).commentsActive).toBe(false); // on WhatsApp
    expect(resolveAgentSurface(preference, true).commentsActive).toBe(true); // back on Facebook
  });

  it("survives the round trip for a both-surfaces choice too", () => {
    const preference = "both";
    expect(resolveAgentSurface(preference, false).surface).toBe("dms");
    expect(resolveAgentSurface(preference, true).surface).toBe("both");
  });
});
