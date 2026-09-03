// Pure matcher for Comment Workflow rules — a deterministic keyword funnel on a public comment
// ("comment GUIDE and we DM you the link"). No I/O, so the three things that actually decide
// which rule wins — text normalization, post targeting, precedence — are unit-testable on their
// own. Same reasoning as autoReplyRules.ts, which was extracted for exactly this.
//
// Precedence differs from autoReplyRules in one way: a rule aimed at a single post outranks an
// account-wide rule, so a launch funnel on one post is never shadowed by a standing "any
// comment" rule the user set up months earlier.

export type CommentWorkflowMatchType = "exact" | "contains" | "any";

export interface CommentWorkflowRule {
  id: string;
  social_account_id: string;
  platform: string;
  name: string;
  /** NULL means the rule watches every post on the account. */
  target_post_id: string | null;
  match_type: CommentWorkflowMatchType;
  keywords: string[] | null;
  public_replies: string[] | null;
  dm_message: string | null;
  media_file_id: string | null;
  send_once_per_user: boolean;
  is_active: boolean;
  created_at: string | null;
}

// "  Send   me the GUIDE! " -> "send me the guide". Trailing punctuation is stripped so an
// exact-match funnel on "GUIDE" still fires for the many people who type "GUIDE!" — without it,
// exact matching is a trap that looks broken to the account owner.
export function normalizeCommentText(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ").replace(/[.!?]+$/, "").trim();
}

// Blank keywords are dropped, never matched. "".includes() is true for every string, so one
// empty entry — trivial to save from a tag input — would make its rule claim every comment on
// the account. autoReplyRules.ts carries the same guard for the same reason.
function keywordsOf(rule: CommentWorkflowRule): string[] {
  return (rule.keywords || []).map((keyword) => normalizeCommentText(keyword)).filter((keyword) => keyword.length > 0);
}

function matches(rule: CommentWorkflowRule, normalized: string): boolean {
  if (rule.match_type === "any") return true;
  const needles = keywordsOf(rule);
  if (needles.length === 0) return false;
  if (rule.match_type === "exact") return needles.includes(normalized);
  return needles.some((needle) => normalized.includes(needle));
}

// Post-specific first, then oldest, then id. The age and id tiebreak are autoReplyRules.ts's:
// rules are stored without an ordering constraint, so "the first match" would otherwise be
// whatever order Postgres happened to return, and different rules could win on different days
// for the same comment. Rows with no created_at sort last so a backfilled row cannot jump the
// queue.
function byPrecedence(left: CommentWorkflowRule, right: CommentWorkflowRule): number {
  const leftSpecific = left.target_post_id ? 0 : 1;
  const rightSpecific = right.target_post_id ? 0 : 1;
  if (leftSpecific !== rightSpecific) return leftSpecific - rightSpecific;

  const leftAge = left.created_at || "";
  const rightAge = right.created_at || "";
  if (leftAge !== rightAge) {
    if (!leftAge) return 1;
    if (!rightAge) return -1;
    return leftAge < rightAge ? -1 : 1;
  }
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

/** Returns the one rule that claims this comment, or null when nothing does. */
export function matchCommentWorkflowRule(
  rules: CommentWorkflowRule[],
  commentText: string,
  postId: string | null,
): CommentWorkflowRule | null {
  const normalized = normalizeCommentText(commentText);
  const eligible = rules.filter((rule) =>
    rule.is_active && (rule.target_post_id === null || (postId !== null && rule.target_post_id === postId))
  );
  return [...eligible].sort(byPrecedence).find((rule) => matches(rule, normalized)) ?? null;
}
