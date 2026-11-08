import { describe, expect, it } from "vitest";
import { instagramPublicationType, publicationSummary } from "../publicationSummary";

const reel = { platform: "instagram", social_account_id: "account", status: "success", response_data: { ig_post_subtype: "reel" } };
const story = { ...reel, response_data: { ig_post_subtype: "story" } };

describe("publication summaries", () => {
  it("reports the successful Reel and failed Story as partial failure", () => {
    expect(publicationSummary([reel, { ...story, status: "failed" }])).toBe("partialFailure");
    expect(instagramPublicationType(reel)).toBe("reel");
    expect(instagramPublicationType(story)).toBe("story");
  });
  it("keeps a pending Story visible after Reel success", () => {
    expect(publicationSummary([reel, { ...story, status: "pending" }])).toBe("partialPending");
  });
  it("does not count a historical failure once the same subtype succeeded", () => {
    expect(publicationSummary([reel, { ...story, status: "failed" }, story])).toBeNull();
  });
  it("does not use another account's success to erase a failure", () => {
    expect(publicationSummary([reel, { ...reel, social_account_id: "other", status: "failed" }])).toBe("partialFailure");
  });
  it("preserves ordinary all-success and all-failure labels", () => {
    expect(publicationSummary([reel, story])).toBeNull();
    expect(publicationSummary([{ ...story, status: "failed" }])).toBeNull();
    expect(publicationSummary([])).toBeNull();
  });
  it("does not invent a subtype for legacy or unrelated platform results", () => {
    expect(instagramPublicationType({ ...reel, response_data: null })).toBeNull();
    expect(instagramPublicationType({ ...reel, response_data: { ig_post_subtype: "unknown" } })).toBeNull();
    expect(instagramPublicationType({ ...reel, platform: "facebook" })).toBeNull();
  });
});
