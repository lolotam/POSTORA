// Whether a YouTube row can read and write comments. Every comment endpoint needs
// youtube.force-ssl (probed 2026-09-04: a readonly+upload token gets 403
// insufficientPermissions even on commentThreads.list). Composio's managed Google app
// already holds that scope, so a Composio row is capable by construction; a native row is
// capable only if the scope was recorded when it connected or refreshed. Older rows carry
// `{}` and must reconnect.
export const YOUTUBE_COMMENT_SCOPE =
  "https://www.googleapis.com/auth/youtube.force-ssl";

export type YouTubeCommentCapability = "capable" | "reconnect_required";

export interface YouTubeCapabilityAccount {
  auth_provider?: string | null;
  account_metadata?: unknown;
}

export function grantedScopes(metadata: unknown): string[] {
  if (!metadata || typeof metadata !== "object") return [];
  const raw = (metadata as Record<string, unknown>).granted_scopes;
  return Array.isArray(raw)
    ? raw.filter((scope): scope is string => typeof scope === "string")
    : [];
}

export function splitScopeString(scope: unknown): string[] {
  return typeof scope === "string" ? scope.split(/\s+/).filter(Boolean) : [];
}

export function youtubeCommentCapability(
  account: YouTubeCapabilityAccount,
): YouTubeCommentCapability {
  if (account.auth_provider === "composio") return "capable";
  return grantedScopes(account.account_metadata).includes(YOUTUBE_COMMENT_SCOPE)
    ? "capable"
    : "reconnect_required";
}
