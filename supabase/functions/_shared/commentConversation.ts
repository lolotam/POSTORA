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

// Callers resolve their own fallbacks for postId and authorKey; both are platform-specific
// (Threads mentions have no root post, Threads replies have no author id) and the caller is
// the only place that knows which substitute is right.
export function buildCommentConversationId(accountId: string, postId: string, authorKey: string): string {
  return [accountId, COMMENT_SEGMENT, postId, authorKey].join(":");
}

// `\`, `%` and `_` are all pattern syntax to LIKE. Account ids are UUIDs and contain none of
// them, but post and comment ids are platform-issued: a Facebook post id is literally
// `pageId_postId`, so an unescaped `_` there is a single-character wildcard and one post's
// prefix would match a different post's conversations.
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

// Matches every comment conversation on one account, for the account-wide daily cap.
export function commentConversationLikePrefix(accountId: string): string {
  return `${escapeLike(accountId)}:${COMMENT_SEGMENT}:%`;
}

// Matches every commenter under one post, for the once-per-post away-reply guard.
export function postConversationLikePrefix(accountId: string, postId: string): string {
  return `${escapeLike(accountId)}:${COMMENT_SEGMENT}:${escapeLike(postId)}:%`;
}

export function isCommentConversationId(conversationId: string): boolean {
  return conversationId.includes(`:${COMMENT_SEGMENT}:`);
}
