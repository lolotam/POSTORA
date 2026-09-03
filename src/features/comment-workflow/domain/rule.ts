import type { Tables } from "@/integrations/supabase/types";

/**
 * The vocabulary of a comment funnel, shared by the form, the pool and the API adapter.
 *
 * `platform` is denormalized onto the rule so the pool can filter without joining every
 * account. The database binds it to the account's own platform through a composite foreign
 * key, so the two cannot disagree — the form never asks for it, it derives it.
 */
export type CommentWorkflowPlatform = "facebook" | "instagram" | "threads";
export type CommentWorkflowMatchType = "exact" | "contains" | "any";

export const COMMENT_WORKFLOW_PLATFORMS: readonly CommentWorkflowPlatform[] = [
  "facebook",
  "instagram",
  "threads",
] as const;

/** Threads has no private messages, so a Threads funnel is public-reply-only. */
export function supportsPrivateReply(platform: CommentWorkflowPlatform | ""): boolean {
  return platform === "facebook" || platform === "instagram";
}

type RuleRow = Tables<"comment_workflow_rules">;

/** The row as the UI uses it, with the two open TEXT columns narrowed to what the CHECKs allow. */
export type CommentWorkflowRule = Omit<RuleRow, "platform" | "match_type"> & {
  platform: CommentWorkflowPlatform;
  match_type: CommentWorkflowMatchType;
};

export type CommentWorkflowRuleInput = Omit<
  CommentWorkflowRule,
  "id" | "user_id" | "created_at" | "updated_at"
>;

export type CommentWorkflowStats = Tables<"comment_workflow_rule_stats">;

type Described = Pick<CommentWorkflowRule, "match_type" | "keywords" | "target_post_id">;

/** "Exact \"GUIDE\"", "Contains: price, cost", "Any comment". */
export function describeTrigger(rule: Described): string {
  if (rule.match_type === "any") return "Any comment";
  const words = (rule.keywords ?? []).filter((keyword) => keyword.trim().length > 0);
  if (words.length === 0) return "No keywords";
  if (rule.match_type === "exact") {
    return words.length === 1 ? `Exact "${words[0]}"` : `Exact: ${words.join(", ")}`;
  }
  return `Contains: ${words.join(", ")}`;
}

export function describeScope(rule: Described): string {
  return rule.target_post_id ? `Post ${rule.target_post_id}` : "All posts";
}
