export interface CommentAuthorRef {
  id: string | null;
  username: string | null;
}

export interface CommentAccountRef {
  platform: string;
  platform_user_id?: string | null;
  platform_username?: string | null;
  account_metadata?: unknown;
}

function metadataString(metadata: unknown, key: string): string | null {
  if (!metadata || typeof metadata !== "object") return null;
  const value = (metadata as Record<string, unknown>)[key];
  return typeof value === "string" && value ? value : null;
}

// Instagram accounts carry up to three ids (app-scoped, IGID, legacy ig_user_id) and
// comment webhooks may use any of them for `from.id`. Missing any one of them here
// reopens the self-reply loop this check exists to close.
function ownIds(account: CommentAccountRef): Set<string> {
  const ids = new Set<string>();
  // YouTube: snippet.authorChannelId.value is compared to platform_user_id here.
  if (account.platform_user_id) ids.add(account.platform_user_id);
  if (account.platform === "instagram") {
    for (const key of ["ig_igid", "ig_user_id"]) {
      const value = metadataString(account.account_metadata, key);
      if (value) ids.add(value);
    }
  }
  return ids;
}

export function isOwnComment(account: CommentAccountRef, author: CommentAuthorRef): boolean {
  if (author.id && ownIds(account).has(author.id)) return true;
  if (account.platform === "threads" && author.username && account.platform_username) {
    return author.username.replace(/^@/, "").toLowerCase() === account.platform_username.replace(/^@/, "").toLowerCase();
  }
  return false;
}
