// Conversation keys for the public-comment surface.
//
// A comment thread is keyed by (account, post, commenter), not by comment id and not by
// account alone:
//   - per comment, every reply would get its own ai_threads row, so reply_cooldown_seconds
//     and daily_message_cap -- both keyed on conversation_id -- could never fire, and a busy
//     post would mean one model call and one public reply per comment with no ceiling;
//   - per account, the agent replays the last turns of that thread, so something a person
//     said under one public post could surface in a public reply under a different post, in
//     front of a different audience.
//
// Segments are colon-separated rather than underscore-separated so the daily-cap prefix can
// be used as a LIKE pattern directly: UUIDs contain no underscores, so an account id
// followed by ":comment:" has no SQL wildcard in it and needs no ESCAPE clause. The DM
// surface keeps its historical `${accountId}_${senderId}` shape and cannot collide.

const COMMENT_SEGMENT = "comment";

export function buildCommentConversationId(
  accountId: string,
  postId: string | null | undefined,
  authorKey: string | null | undefined,
  commentId: string,
): string {
  return [accountId, COMMENT_SEGMENT, postId || commentId, authorKey || commentId].join(":");
}

// Matches every comment conversation on one account, for the account-wide daily cap.
export function commentConversationLikePrefix(accountId: string): string {
  return `${accountId}:${COMMENT_SEGMENT}:%`;
}

// Matches every commenter under one post, for the once-per-post away-reply guard.
export function postConversationLikePrefix(accountId: string, postId: string): string {
  return `${accountId}:${COMMENT_SEGMENT}:${postId}:%`;
}

export function isCommentConversationId(conversationId: string): boolean {
  return conversationId.includes(`:${COMMENT_SEGMENT}:`);
}
