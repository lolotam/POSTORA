import { platformUsesRefreshToken } from "../_shared/tokenExpiryConstants.ts";

/**
 * Can we even attempt a token refresh for this account?
 *
 * For OAuth2 platforms the answer is "only with a refresh token". For Meta's
 * exchange-only platforms the access token IS the exchange credential, so a null
 * refresh_token is normal and must not be treated as a refresh failure.
 */
export function accountCanAttemptRefresh(
  account: { platform: string; refresh_token: string | null },
): boolean {
  if (!platformUsesRefreshToken(account.platform)) return true;
  return Boolean(account.refresh_token);
}

export type MetaRefreshStrategy = "fb_exchange" | "ig_refresh" | "threads_refresh" | "none";

/**
 * Pick the token-exchange endpoint for a Meta account.
 *
 * Instagram's auth flavour lives in the `ig_auth_type` COLUMN, not in
 * `account_metadata.account_type` — that JSONB key holds Instagram's own account
 * category (BUSINESS, MEDIA_CREATOR). Reading the wrong one routed every
 * business-login account to fb_exchange_token, which rejects Instagram-scoped tokens.
 */
export function metaRefreshStrategy(
  account: { platform: string; ig_auth_type?: string | null },
): MetaRefreshStrategy {
  switch (account.platform.toLowerCase()) {
    case "facebook":
      return "fb_exchange";
    case "threads":
      return "threads_refresh";
    case "instagram":
      return account.ig_auth_type === "business_login" ? "ig_refresh" : "fb_exchange";
    default:
      return "none";
  }
}
