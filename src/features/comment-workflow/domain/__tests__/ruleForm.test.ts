import { describe, expect, it } from "vitest";
import { describeScope, describeTrigger } from "../rule";
import { DM_MAX_CHARS, MAX_PUBLIC_REPLIES, type RuleFormValues, validateRuleForm } from "../ruleForm";

const base: RuleFormValues = {
  socialAccountId: "acct-ig",
  platform: "instagram",
  name: "Guide funnel",
  scope: "all",
  targetPostId: "",
  matchType: "exact",
  keywords: ["GUIDE", "  ", ""],
  publicReplies: ["Check your DM"],
  dmMessage: "Here is the guide",
  mediaFileId: null,
  sendOncePerUser: true,
  isActive: true,
};

function invalid(values: RuleFormValues) {
  const result = validateRuleForm(values);
  if (result.status === "valid") throw new Error("expected the form to be rejected");
  return result.errors;
}

function valid(values: RuleFormValues) {
  const result = validateRuleForm(values);
  if (result.status === "invalid") {
    throw new Error(`expected the form to be accepted, got ${JSON.stringify(result.errors)}`);
  }
  return result.input;
}

describe("validateRuleForm", () => {
  it("drops blank keywords rather than storing them", () => {
    // A blank keyword trims to "" at match time, and "".includes() is true for every string —
    // one of them would make the rule claim every comment on the account.
    expect(valid(base).keywords).toEqual(["GUIDE"]);
  });

  it("maps the form onto the row shape", () => {
    const input = valid({ ...base, scope: "post", targetPostId: " p1 " });
    expect(input).toMatchObject({
      social_account_id: "acct-ig",
      platform: "instagram",
      name: "Guide funnel",
      target_post_id: "p1",
      match_type: "exact",
      public_replies: ["Check your DM"],
      dm_message: "Here is the guide",
      send_once_per_user: true,
    });
  });

  it("requires keywords unless the trigger is any comment", () => {
    expect(invalid({ ...base, keywords: ["   "] }).keywords).toBeTruthy();
    const anyComment = valid({ ...base, keywords: [], matchType: "any" });
    expect(anyComment.keywords).toEqual([]);
  });

  it("rejects a workflow that would neither reply nor message", () => {
    expect(invalid({ ...base, publicReplies: ["  "], dmMessage: "" }).publicReplies).toBeTruthy();
  });

  it("keeps a message-only workflow, which needs no public reply", () => {
    expect(valid({ ...base, publicReplies: [""] }).public_replies).toEqual([]);
  });

  it("drops the private message and the file for Threads instead of erroring", () => {
    // Switching a workflow to Threads is a platform change, not a form to repair.
    const input = valid({ ...base, platform: "threads", mediaFileId: "media-1" });
    expect(input.dm_message).toBeNull();
    expect(input.media_file_id).toBeNull();
  });

  it("tells a Threads workflow it needs a public reply, since it has no other way to act", () => {
    const errors = invalid({ ...base, platform: "threads", publicReplies: [""] });
    expect(errors.publicReplies).toBe("Add a public reply.");
  });

  it("needs a post id when the scope is one post", () => {
    expect(invalid({ ...base, scope: "post", targetPostId: "  " }).targetPostId).toBeTruthy();
  });

  it("refuses a file with no message to carry it", () => {
    expect(invalid({ ...base, dmMessage: "", mediaFileId: "media-1" }).dmMessage).toBeTruthy();
  });

  it("enforces the platform's message limit and the name length", () => {
    expect(invalid({ ...base, dmMessage: "x".repeat(DM_MAX_CHARS + 1) }).dmMessage).toBeTruthy();
    expect(invalid({ ...base, name: "x".repeat(121) }).name).toBeTruthy();
    expect(invalid({ ...base, name: "   " }).name).toBeTruthy();
  });

  it("caps the public reply variations", () => {
    const tooMany = Array.from({ length: MAX_PUBLIC_REPLIES + 1 }, (_, index) => `reply ${index}`);
    expect(invalid({ ...base, publicReplies: tooMany }).publicReplies).toBeTruthy();
  });

  it("carries is_active through, so editing a paused workflow does not restart it", () => {
    expect(valid({ ...base, isActive: false }).is_active).toBe(false);
    expect(valid({ ...base, isActive: true }).is_active).toBe(true);
  });
});

describe("describeTrigger and describeScope", () => {
  it("names the trigger the way the pool shows it", () => {
    expect(describeTrigger({ match_type: "exact", keywords: ["GUIDE"], target_post_id: null })).toBe('Exact "GUIDE"');
    expect(describeTrigger({ match_type: "contains", keywords: ["price", "cost"], target_post_id: null }))
      .toBe("Contains: price, cost");
    expect(describeTrigger({ match_type: "any", keywords: [], target_post_id: null })).toBe("Any comment");
    expect(describeTrigger({ match_type: "exact", keywords: ["A", "B"], target_post_id: null })).toBe("Exact: A, B");
  });

  it("names the scope", () => {
    expect(describeScope({ match_type: "any", keywords: [], target_post_id: "p9" })).toBe("Post p9");
    expect(describeScope({ match_type: "any", keywords: [], target_post_id: null })).toBe("All posts");
  });
});
