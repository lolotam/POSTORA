/**
 * Whether a scheduled post is DEFERRED for one tick because a YouTube token
 * refresh is contended.
 *
 * The scheduler refreshes YouTube tokens before it kicks process-post. A
 * retryable refresh refusal (refresh_in_progress, lease_acquire_failed, any
 * retryable_refusal) is not a dead credential — another worker is refreshing —
 * but when the stored token is expired or inside the refresh window, a publish
 * started now would reach the provider with a credential it refuses, and the
 * per-post failure handler would mark the post PERMANENTLY failed. That is
 * exactly what a retryable refusal must never do.
 *
 * The decision: when the stored token cannot publish yet, defer the WHOLE post
 * this tick. Nothing is written and process-post is not called, so the next
 * tick selects the post again under its same expectation. When the stored
 * token is still usable, the post proceeds as today.
 */

import {
  YOUTUBE_TOKEN_REFRESH_WINDOW_MS,
  youtubeTokenNeedsRefresh,
} from "../_shared/youtubeTokenRefresh.ts";

/** One account the scheduler tried to refresh before kicking process-post. */
export interface ScheduledYouTubeRefreshProbe {
  /** The social_accounts row id the probe describes. */
  accountId: string;
  platform: string;
  /** auth_provider of the row; null counts as native. */
  authProvider?: string | null;
  /**
   * The refusal reason of a failed refresh, null when the refresh succeeded.
   */
  refreshRefusalReason: string | null;
  /** The retryable flag of the failed refresh; false when it succeeded. */
  refreshRefusalRetryable: boolean;
  /**
   * The expiry of the token the row still held when the refresh was attempted:
   * the credential a publish started now would carry.
   */
  storedTokenExpiresAt: string | null;
}

export interface YouTubePostDeferral {
  /** True when the whole post must skip this tick, untouched, for the next one. */
  defer: boolean;
  /** The YouTube account whose contended refresh caused the deferral. */
  accountId: string | null;
  /** The sanitized refusal reason, for the one log line the deferral writes. */
  reason: string | null;
}

/**
 * Whether any native YouTube account's retryable refresh refusal leaves the
 * post unpublishable this tick. Composio-managed accounts never defer: their
 * tokens are not refreshed here.
 */
export function youtubePostDeferral(
  probes: ScheduledYouTubeRefreshProbe[],
  options: { nowMs?: number; refreshWindowMs?: number } = {},
): YouTubePostDeferral {
  const nowMs = options.nowMs ?? Date.now();
  const refreshWindowMs = options.refreshWindowMs ??
    YOUTUBE_TOKEN_REFRESH_WINDOW_MS;

  for (const probe of probes) {
    if (probe.platform !== "youtube") continue;
    if (probe.authProvider === "composio") continue;
    if (!probe.refreshRefusalRetryable) continue;
    // A publish would fail: the token is expired or inside the refresh window.
    // The other worker is already refreshing, so the post waits one tick.
    if (
      youtubeTokenNeedsRefresh(probe.storedTokenExpiresAt, nowMs, refreshWindowMs)
    ) {
      return {
        defer: true,
        accountId: probe.accountId,
        reason: probe.refreshRefusalReason,
      };
    }
  }

  return { defer: false, accountId: null, reason: null };
}
