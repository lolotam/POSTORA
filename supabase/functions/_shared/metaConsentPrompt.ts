/**
 * The query parameter that makes a Meta login show its permission screen
 * again on a reconnect, instead of silently reusing the earlier grant.
 *
 * facebook_login:  auth_type=rerequest  (Facebook Login dialog; re-asks the
 *                  permissions, no password re-entry).
 * instagram_login: force_reauth=true    (Instagram API with Instagram Login;
 *                  forces a fresh login, the only lever that window offers).
 * Threads has no such parameter; see the 2026-11-05 design.
 */
export type MetaLoginKind = "facebook_login" | "instagram_login";

const CONSENT_PARAMETER: Record<MetaLoginKind, readonly [name: string, value: string]> = {
  facebook_login: ["auth_type", "rerequest"],
  instagram_login: ["force_reauth", "true"],
};

export function withMetaConsentPrompt(url: URL, login: MetaLoginKind): URL {
  const [name, value] = CONSENT_PARAMETER[login];
  url.searchParams.set(name, value);
  return url;
}
