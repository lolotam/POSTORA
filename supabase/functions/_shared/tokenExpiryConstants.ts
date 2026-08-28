/**
 * Token Expiry Constants for Social Media Platforms (Edge Function Version)
 * 
 * This file provides token expiry information for use in Supabase Edge Functions.
 * Keep in sync with src/lib/tokenExpiryConstants.ts
 */

// Time constants in seconds
export const TIME_CONSTANTS = {
  MINUTE: 60,
  HOUR: 3600,
  DAY: 86400,
  WEEK: 604800,
  MONTH_30: 2592000, // 30 days
  MONTH_60: 5184000, // 60 days
  YEAR: 31536000,    // 365 days
} as const;

export interface PlatformRefreshConfig {
  refreshWindowSeconds: number;
  accessTokenExpirySeconds: number;
  isShortLived: boolean;
  cronExcluded?: boolean; // If true, skip this platform in automatic cron cycles
  /**
   * Whether the platform issues an OAuth refresh token.
   *
   * Meta platforms (Facebook, Instagram, Threads) do not: they issue a long-lived access
   * token that is exchanged for a new one using the access token itself. A null
   * refresh_token on those platforms is normal, not a failure.
   *
   * Omitted means true, so a platform nobody has configured here keeps the conservative
   * behaviour of treating a missing refresh token as unrefreshable.
   */
  usesRefreshToken?: boolean;
}

/**
 * Platform-specific refresh configurations
 */
export const PLATFORM_REFRESH_CONFIG: Record<string, PlatformRefreshConfig> = {
  // Short-lived tokens (need hourly refresh)
  twitter: {
    refreshWindowSeconds: TIME_CONSTANTS.HOUR, // 1 hour before expiry
    accessTokenExpirySeconds: TIME_CONSTANTS.HOUR * 2,
    isShortLived: true,
  },
  youtube: {
    refreshWindowSeconds: TIME_CONSTANTS.MINUTE * 30, // 30 mins before expiry for JIT refresh
    accessTokenExpirySeconds: TIME_CONSTANTS.HOUR,
    isShortLived: false, // Changed: YouTube excluded from auto-cron to conserve Google's 100-refresh-token limit
    cronExcluded: true, // YouTube only refreshes on-demand (before publish or manual trigger)
  },
  reddit: {
    refreshWindowSeconds: TIME_CONSTANTS.MINUTE * 30, // 30 mins before expiry
    accessTokenExpirySeconds: TIME_CONSTANTS.HOUR,
    isShortLived: true,
  },
  bluesky: {
    refreshWindowSeconds: TIME_CONSTANTS.HOUR, // 1 hour before expiry
    accessTokenExpirySeconds: TIME_CONSTANTS.HOUR * 2,
    isShortLived: true,
  },

  // Medium-lived tokens (daily refresh OK)
  tiktok: {
    refreshWindowSeconds: TIME_CONSTANTS.HOUR * 6, // 6 hours before expiry
    accessTokenExpirySeconds: TIME_CONSTANTS.DAY,
    isShortLived: false,
  },
  pinterest: {
    refreshWindowSeconds: TIME_CONSTANTS.HOUR * 6, // 6 hours before expiry
    accessTokenExpirySeconds: TIME_CONSTANTS.DAY,
    isShortLived: false,
  },

  // Long-lived tokens (weekly check OK)
  facebook: {
    refreshWindowSeconds: TIME_CONSTANTS.WEEK, // 7 days before expiry
    accessTokenExpirySeconds: TIME_CONSTANTS.MONTH_60,
    isShortLived: false,
    usesRefreshToken: false, // exchanges the access token; never has a refresh token
  },
  instagram: {
    refreshWindowSeconds: TIME_CONSTANTS.WEEK, // 7 days before expiry
    accessTokenExpirySeconds: TIME_CONSTANTS.MONTH_60,
    isShortLived: false,
    usesRefreshToken: false, // exchanges the access token; never has a refresh token
  },
  threads: {
    refreshWindowSeconds: TIME_CONSTANTS.WEEK, // 7 days before expiry
    accessTokenExpirySeconds: TIME_CONSTANTS.MONTH_60,
    isShortLived: false,
    usesRefreshToken: false, // exchanges the access token; never has a refresh token
  },
  linkedin: {
    refreshWindowSeconds: TIME_CONSTANTS.WEEK, // 7 days before expiry
    accessTokenExpirySeconds: TIME_CONSTANTS.MONTH_60,
    isShortLived: false,
  },
} as const;

/**
 * Platforms that need frequent refresh (hourly cron required)
 */
export const SHORT_LIVED_TOKEN_PLATFORMS = ['twitter', 'reddit', 'bluesky'] as const; // YouTube removed: uses JIT refresh only

/**
 * Platforms excluded from automatic cron refresh cycles.
 * These platforms only refresh on-demand (before publish or manual trigger).
 */
export const CRON_EXCLUDED_PLATFORMS = ['youtube'] as const;

/**
 * Check if a platform is excluded from automatic cron refresh
 */
export function isCronExcludedPlatform(platform: string): boolean {
  const normalizedPlatform = platform.toLowerCase();
  return PLATFORM_REFRESH_CONFIG[normalizedPlatform]?.cronExcluded ?? false;
}

/**
 * Check whether a platform authenticates with an OAuth refresh token.
 *
 * Unknown platforms default to true, which is the conservative pre-existing behaviour:
 * a missing refresh token means the account cannot be refreshed.
 */
export function platformUsesRefreshToken(platform: string): boolean {
  const normalizedPlatform = platform.toLowerCase();
  return PLATFORM_REFRESH_CONFIG[normalizedPlatform]?.usesRefreshToken ?? true;
}

/**
 * Get refresh window for a platform
 */
export function getRefreshWindowSeconds(platform: string): number {
  const normalizedPlatform = platform.toLowerCase();
  return PLATFORM_REFRESH_CONFIG[normalizedPlatform]?.refreshWindowSeconds ?? TIME_CONSTANTS.WEEK;
}

/**
 * Check if token needs refresh based on platform-specific window
 */
export function tokenNeedsRefresh(platform: string, expiresAt: string | null): boolean {
  if (!expiresAt) return false;

  const expiryDate = new Date(expiresAt);
  const now = new Date();
  const refreshWindow = getRefreshWindowSeconds(platform);

  const refreshThreshold = new Date(expiryDate.getTime() - (refreshWindow * 1000));

  return now >= refreshThreshold;
}

/**
 * Check if a platform has short-lived tokens
 */
export function isShortLivedPlatform(platform: string): boolean {
  const normalizedPlatform = platform.toLowerCase();
  return PLATFORM_REFRESH_CONFIG[normalizedPlatform]?.isShortLived ?? false;
}
