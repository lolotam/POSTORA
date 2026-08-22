import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  buildCommentConversationId,
  commentConversationLikePrefix,
  isCommentConversationId,
  postConversationLikePrefix,
} from "./commentConversation.ts";

const ACCOUNT = "11111111-2222-3333-4444-555555555555";

Deno.test("a comment conversation id names the account, the post and the commenter", () => {
  assertEquals(buildCommentConversationId(ACCOUNT, "post-1", "author-1"), `${ACCOUNT}:comment:post-1:author-1`);
});

Deno.test("comment ids are distinguishable from the DM id shape", () => {
  assertEquals(isCommentConversationId(buildCommentConversationId(ACCOUNT, "p", "a")), true);
  // The DM path keys conversations as `${accountId}_${senderId}`.
  assertEquals(isCommentConversationId(`${ACCOUNT}_178901234`), false);
});

// A Facebook post id is literally `pageId_postId`, and `_` is a single-character wildcard in
// LIKE. Without escaping, one post's guard prefix silently covers other posts, so an away
// reply meant for post A would be suppressed on post B.
Deno.test("post prefixes escape the LIKE wildcards that platform ids really contain", () => {
  assertEquals(
    postConversationLikePrefix(ACCOUNT, "1234_5678"),
    `${ACCOUNT}:comment:1234\\_5678:%`,
  );
  assertEquals(
    postConversationLikePrefix(ACCOUNT, "100%_odd\\id"),
    `${ACCOUNT}:comment:100\\%\\_odd\\\\id:%`,
  );
});

Deno.test("the account-wide cap prefix covers every comment conversation on that account", () => {
  const prefix = commentConversationLikePrefix(ACCOUNT);
  assertEquals(prefix, `${ACCOUNT}:comment:%`);
  assertEquals(buildCommentConversationId(ACCOUNT, "p1", "a1").startsWith(prefix.slice(0, -1)), true);
});
