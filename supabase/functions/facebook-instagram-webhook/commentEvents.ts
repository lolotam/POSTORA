import type { CommentPayloadInput } from "../_shared/n8nMessagingDispatch.ts";

export type MetaCommentInput = Omit<CommentPayloadInput, "platform" | "socialAccountId" | "account">;

function toIso(value: unknown): string | undefined {
  if (typeof value === "number") return new Date(value * (value > 1e12 ? 1 : 1000)).toISOString();
  if (typeof value === "string") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
  }
  return undefined;
}

// Returns null for anything that is not a newly added comment; deletes, edits, likes
// and reaction changes share the same webhook field and must not trigger replies.
export function normalizeMetaCommentChange(platform: "facebook" | "instagram", change: any): MetaCommentInput | null {
  const value = change?.value;
  if (!value) return null;

  if (platform === "facebook") {
    if (change.field !== "feed" || value.item !== "comment" || value.verb !== "add" || !value.comment_id) return null;
    const parentId = value.parent_id && value.parent_id !== value.post_id ? String(value.parent_id) : null;
    return {
      comment: {
        id: String(value.comment_id),
        kind: parentId ? "reply" : "comment",
        text: String(value.message || ""),
        parentCommentId: parentId,
        mediaUrl: null,
      },
      post: { id: value.post_id ? String(value.post_id) : null, url: value.post?.permalink_url || null, caption: null },
      author: { id: value.from?.id ? String(value.from.id) : null, name: value.from?.name || null, username: null },
      timestamp: toIso(value.created_time),
    };
  }

  if (change.field !== "comments" || !value.id) return null;
  const parentId = value.parent_id ? String(value.parent_id) : null;
  return {
    comment: {
      id: String(value.id),
      kind: parentId ? "reply" : "comment",
      text: String(value.text || ""),
      parentCommentId: parentId,
      mediaUrl: null,
    },
    post: { id: value.media?.id ? String(value.media.id) : null, url: null, caption: null },
    author: { id: value.from?.id ? String(value.from.id) : null, name: null, username: value.from?.username || null },
    timestamp: toIso(value.timestamp),
  };
}
