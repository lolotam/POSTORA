import type { CommentPayloadInput } from "../_shared/n8nMessagingDispatch.ts";

export interface ThreadsChange {
  targetId: string | null;
  field: string;
  value: any;
}

// Threads delivers the same notification in two shapes depending on the subscription: the
// Meta-standard `entry[].changes[]` envelope the mentions handler was built against, and a
// flat `{ topic, target_id, values: { field, value } }` envelope documented for the moderate
// topic. Both are read here so a shape change on Meta's side cannot silently stop delivery.
export function extractThreadsChanges(payload: any): ThreadsChange[] {
  const out: ThreadsChange[] = [];
  for (const entry of payload?.entry || []) {
    for (const change of entry?.changes || []) {
      out.push({
        targetId: entry?.id ? String(entry.id) : null,
        field: String(change?.field || ""),
        value: change?.value,
      });
    }
  }
  if (payload?.values?.field) {
    out.push({
      targetId: payload.target_id ? String(payload.target_id) : null,
      field: String(payload.values.field),
      value: payload.values.value,
    });
  }
  return out;
}

export type ThreadsReplyInput = Omit<CommentPayloadInput, "platform" | "socialAccountId" | "account">;

// Threads reply payloads carry the author only as a username — there is no author id field —
// so own-reply suppression downstream has to match on the handle.
export function normalizeThreadsReply(value: any): ThreadsReplyInput | null {
  if (!value?.id) return null;
  const parsed = value.timestamp ? new Date(value.timestamp) : null;
  return {
    comment: {
      id: String(value.id),
      kind: "reply",
      text: String(value.text || ""),
      parentCommentId: value.replied_to?.id ? String(value.replied_to.id) : null,
      mediaUrl: value.permalink || null,
    },
    post: {
      id: value.root_post?.id ? String(value.root_post.id) : null,
      url: null,
      caption: null,
    },
    author: { id: null, name: null, username: value.username || null },
    timestamp: parsed && !Number.isNaN(parsed.getTime()) ? parsed.toISOString() : undefined,
  };
}

// Which id names the connected account differs by field. A mention's `target_id` is the
// mentioned user; a reply's `target_id` is the media that was replied to, and the post owner
// is carried inside the value instead. Reading `target_id` first for both meant a genuine
// reply delivery would look up an account by a media id, find nothing, and be dropped as
// "no account" -- so the value's owner fields win for replies and `target_id` is only a last
// resort there.
export function threadsUserIdFor(change: ThreadsChange): string | null {
  const value = change.value ?? {};
  const fromValue = value.root_post?.owner_id || value.recipient_id || null;
  const candidate = change.field === "replies"
    ? fromValue || change.targetId
    : change.targetId || fromValue;
  return candidate ? String(candidate) : null;
}
