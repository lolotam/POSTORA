export const HIGGSFIELD_CALLBACK_PATH = "/admin/oauth/higgsfield/callback";

const DEDICATED_OAUTH_CALLBACK_PATHS = new Set([
  HIGGSFIELD_CALLBACK_PATH,
  "/auth/oauth/callback",
  "/tiktok-callback",
  "/oauth/pinterest/callback",
  "/connect/authorize",
  "/mcp/authorize",
]);

export function isHiggsfieldOAuthCallback(search: URLSearchParams): boolean {
  const iss = search.get("iss");
  if (!iss) return false;
  try {
    const host = new URL(iss).hostname.toLowerCase();
    return host === "clerk.higgsfield.ai" || host === "mcp.higgsfield.ai" || host.endsWith(".higgsfield.ai");
  } catch {
    return /higgsfield\.ai/i.test(iss);
  }
}

export function shouldForwardSocialOAuthToProfiles(
  pathname: string,
  search: URLSearchParams,
): boolean {
  if (pathname === "/profiles") return false;
  if (!search.get("code") || !search.get("state")) return false;
  if (DEDICATED_OAUTH_CALLBACK_PATHS.has(pathname)) return false;
  if (isHiggsfieldOAuthCallback(search)) return false;
  return true;
}

export function higgsfieldCallbackRescuePath(
  pathname: string,
  search: URLSearchParams,
): string | null {
  if (!isHiggsfieldOAuthCallback(search)) return null;
  if (!search.get("code") || !search.get("state")) return null;
  if (pathname === HIGGSFIELD_CALLBACK_PATH) return null;
  return `${HIGGSFIELD_CALLBACK_PATH}?${search.toString()}`;
}
