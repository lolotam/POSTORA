/**
 * Unified OAuth callback URL config.
 *
 * All providers should resolve their redirect_uri from this map. The base host
 * is taken from VITE_SUPABASE_URL (self-hosted Supabase Kong gateway), so it
 * stays correct across preview / staging / production without hardcoding.
 *
 * Provider-specific context (profile_id, flow, return_to, nonce) MUST travel
 * inside the OAuth `state` parameter — never inside the registered redirect
 * URI.
 *
 * Registered URI shape:
 *   https://api.postora.cloud/functions/v1/<platform>-oauth
 *
 * Post-callback browser landing:
 *   <current-application-origin>/profiles?connected=<platform>
 * The backend must validate the requested origin before signing OAuth state.
 */

const RAW_API_BASE =
  (import.meta.env.VITE_SUPABASE_URL as string | undefined) ??
  "https://api.postora.cloud";

export const OAUTH_API_BASE = RAW_API_BASE.replace(/\/+$/, "");

export const OAUTH_RETURN_URL = "https://postora.cloud/profiles";

export type OAuthPlatformKey =
  | "facebook"
  | "instagram"
  | "instagramBusiness"
  | "threads"
  | "whatsapp"
  | "twitter"
  | "pinterest"
  | "tiktok"
  | "bluesky"
  | "reddit"
  | "linkedin"
  | "youtube";

const FUNCTION_NAMES: Record<OAuthPlatformKey, string> = {
  facebook: "facebook-oauth",
  instagram: "instagram-oauth",
  instagramBusiness: "instagram-business-oauth",
  threads: "threads-oauth",
  whatsapp: "whatsapp-oauth",
  twitter: "twitter-oauth",
  pinterest: "pinterest-oauth",
  tiktok: "tiktok-oauth",
  bluesky: "bluesky-oauth",
  reddit: "reddit-oauth",
  linkedin: "linkedin-oauth",
  youtube: "youtube-oauth",
};

export function buildCallbackUrl(platform: OAuthPlatformKey): string {
  return `${OAUTH_API_BASE}/functions/v1/${FUNCTION_NAMES[platform]}`;
}

export const OAUTH_CALLBACKS: Record<OAuthPlatformKey, string> =
  Object.fromEntries(
    (Object.keys(FUNCTION_NAMES) as OAuthPlatformKey[]).map((k) => [
      k,
      buildCallbackUrl(k),
    ]),
  ) as Record<OAuthPlatformKey, string>;

export function buildReturnUrl(platform: OAuthPlatformKey, extra?: Record<string, string>) {
  const params = new URLSearchParams({ connected: platform, ...(extra ?? {}) });
  // The server validates this origin before signing state; previews must not
  // silently hand a local OAuth selection to the production application.
  const landing = typeof window === "undefined" ? OAUTH_RETURN_URL
    : new URL("/profiles", window.location.origin).toString();
  return `${landing}?${params.toString()}`;
}
