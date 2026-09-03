import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  type CommentWorkflowRule,
  matchCommentWorkflowRule,
  normalizeCommentText,
} from "./commentWorkflowRules.ts";

function rule(over: Partial<CommentWorkflowRule>): CommentWorkflowRule {
  return {
    id: "r",
    social_account_id: "acct",
    platform: "instagram",
    name: "rule",
    target_post_id: null,
    match_type: "any",
    keywords: [],
    public_replies: ["ok"],
    dm_message: null,
    media_file_id: null,
    send_once_per_user: true,
    is_active: true,
    created_at: "2026-01-01T00:00:00Z",
    ...over,
  };
}

Deno.test("normalize trims, lower-cases, collapses whitespace and drops trailing punctuation", () => {
  assertEquals(normalizeCommentText("  Guide!  "), "guide");
  assertEquals(normalizeCommentText("Send   ME the\nGUIDE?"), "send me the guide");
  assertEquals(normalizeCommentText("wait..."), "wait");
});

Deno.test("exact matches the whole normalized comment, not a substring of it", () => {
  const exact = rule({ id: "exact", match_type: "exact", keywords: ["GUIDE"] });
  assertEquals(matchCommentWorkflowRule([exact], "guide!", "p1")?.id, "exact");
  assertEquals(matchCommentWorkflowRule([exact], "send me the guide", "p1"), null);
});

Deno.test("contains is a case-insensitive substring match", () => {
  const contains = rule({ id: "c", match_type: "contains", keywords: ["PRICE"] });
  assertEquals(matchCommentWorkflowRule([contains], "what is the Price?", "p1")?.id, "c");
  assertEquals(matchCommentWorkflowRule([contains], "looks great", "p1"), null);
});

Deno.test("blank keywords never claim a comment", () => {
  const blank = rule({ id: "blank", match_type: "contains", keywords: ["", "   "] });
  assertEquals(matchCommentWorkflowRule([blank], "anything at all", "p1"), null);
  const mixed = rule({ id: "mixed", match_type: "contains", keywords: ["  ", "price"] });
  assertEquals(matchCommentWorkflowRule([mixed], "the price?", "p1")?.id, "mixed");
});

Deno.test("a rule targeting another post does not match, even with no post id", () => {
  const targeted = rule({ id: "post", target_post_id: "p1" });
  assertEquals(matchCommentWorkflowRule([targeted], "hi", "p2"), null);
  assertEquals(matchCommentWorkflowRule([targeted], "hi", null), null);
  assertEquals(matchCommentWorkflowRule([targeted], "hi", "p1")?.id, "post");
});

Deno.test("a post-specific rule outranks an older all-posts rule on that post only", () => {
  const all = rule({ id: "all", created_at: "2026-01-01T00:00:00Z" });
  const post = rule({ id: "post", target_post_id: "p1", created_at: "2026-06-01T00:00:00Z" });
  assertEquals(matchCommentWorkflowRule([all, post], "hi", "p1")?.id, "post");
  assertEquals(matchCommentWorkflowRule([all, post], "hi", "p2")?.id, "all");
});

Deno.test("among equally specific rules the oldest wins, ties broken by id", () => {
  const newer = rule({ id: "0", created_at: "2026-02-01T00:00:00Z" });
  const olderB = rule({ id: "b", created_at: "2026-01-01T00:00:00Z" });
  const olderA = rule({ id: "a", created_at: "2026-01-01T00:00:00Z" });
  assertEquals(matchCommentWorkflowRule([newer, olderB, olderA], "hi", "p1")?.id, "a");
});

Deno.test("a rule with no created_at sorts last rather than jumping the queue", () => {
  const backfilled = rule({ id: "backfilled", created_at: null });
  const dated = rule({ id: "dated", created_at: "2026-05-01T00:00:00Z" });
  assertEquals(matchCommentWorkflowRule([backfilled, dated], "hi", "p1")?.id, "dated");
});

Deno.test("inactive rules never match", () => {
  assertEquals(matchCommentWorkflowRule([rule({ is_active: false })], "hi", "p1"), null);
});

Deno.test("a non-matching specific rule falls through to a matching all-posts rule", () => {
  const specific = rule({ id: "specific", target_post_id: "p1", match_type: "exact", keywords: ["GUIDE"] });
  const catchAll = rule({ id: "all", match_type: "contains", keywords: ["price"] });
  assertEquals(matchCommentWorkflowRule([specific, catchAll], "what price?", "p1")?.id, "all");
});
