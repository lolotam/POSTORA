import {
  PLATFORM_REFRESH_CONFIG,
  platformUsesRefreshToken,
} from "../_shared/tokenExpiryConstants.ts";

/** Meta will not refresh an Instagram/Threads long-lived token younger than 24 hours. */
const MIN_META_TOKEN_AGE_MS = 24 * 60 * 60 * 1000;

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

/**
 * Meta refuses to refresh an Instagram Business Login or Threads long-lived token that
 * is less than 24 hours old, and answers with a plain error rather than a token.
 *
 * The admin "Refresh all" path deliberately bypasses both the per-platform refresh
 * window and the attempt cooldown, so without this guard three presses within a day of
 * a reconnect would record three failures and flag a perfectly healthy new token.
 *
 * Issue time is derived from the expiry: these tokens are minted with a known lifetime
 * (60 days for Meta), so `token_expires_at - accessTokenExpirySeconds` is when it was
 * issued. Returns false when the expiry is unknown — nothing to prove it is too young.
 */
export function metaTokenTooYoungToRefresh(
  account: { platform: string; ig_auth_type?: string | null; token_expires_at: string | null },
  now: Date = new Date(),
): boolean {
  const strategy = metaRefreshStrategy(account);
  if (strategy !== "ig_refresh" && strategy !== "threads_refresh") return false;
  if (!account.token_expires_at) return false;

  const lifetimeSeconds =
    PLATFORM_REFRESH_CONFIG[account.platform.toLowerCase()]?.accessTokenExpirySeconds;
  if (!lifetimeSeconds) return false;

  const issuedAt = new Date(account.token_expires_at).getTime() - lifetimeSeconds * 1000;
  return now.getTime() - issuedAt < MIN_META_TOKEN_AGE_MS;
}
