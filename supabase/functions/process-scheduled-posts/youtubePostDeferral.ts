/**
 * Whether a scheduled post is DEFERRED for one tick because a YouTube token
 * refresh is contended.
 *
 * The scheduler refreshes YouTube tokens before it kicks process-post. A
 * retryable refresh refusal (refresh_in_progress, lease_acquire_failed, any
 * retryable_refusal) is not a dead credential — another worker is refreshing —
 * but when the stored credential would be refused by the publication policy,
 * a publish started now would fail for a reason that says nothing about the
 * video, and the per-post failure handler would mark the post PERMANENTLY
 * failed. That is exactly what a retryable refusal must never do.
 *
 * The decision uses the SAME policy the publish path applies to the credential
 * (youtubeCredentialRefusalReason): expired credentials and credentials
 * without an expiry or a token defer; a token that is still publishable —
 * even one inside the refresh window — proceeds.
 *
 * When the stored credential cannot publish yet, defer the WHOLE post this
 * tick. Nothing is written and process-post is not called, so the next tick
 * selects the post again under its same expectation. When the stored token is
 * still usable, the post proceeds as today.
 */

import { youtubeCredentialRefusalReason } from "../process-post/youtubeUploadPolicy.ts";

/** One account the scheduler tried to refresh before kicking process-post. */
export interface ScheduledYouTubeRefreshProbe {
  /** The social_accounts row id the probe describes. */
  accountId: string;
  platform: string;
  /** auth_provider of the row; null counts as native. */
  authProvider?: string | null;
  /** is_active of the row; an inactive row never defers a post. */
  isActive: boolean;
  /**
   * The refusal reason of a failed refresh, null when the refresh succeeded.
   */
  refreshRefusalReason: string | null;
  /** The retryable flag of the failed refresh; false when it succeeded. */
  refreshRefusalRetryable: boolean;
  /** The access token the row still held when the refresh was attempted. */
  storedAccessToken: string | null;
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
  options: { nowMs?: number } = {},
): YouTubePostDeferral {
  const nowMs = options.nowMs ?? Date.now();

  for (const probe of probes) {
    if (probe.platform !== "youtube") continue;
    if (probe.authProvider === "composio") continue;
    // The scheduler only refreshes active accounts; a probe that still
    // carries an inactive row never defers a post (the publish path refuses
    // inactive accounts on its own).
    if (probe.isActive === false) continue;
    if (!probe.refreshRefusalRetryable) continue;
    // A publish would fail: the credential the row still holds fails the
    // shared publication policy. The other worker is already refreshing, so
    // the post waits one tick.
    if (
      youtubeCredentialRefusalReason(
        probe.storedAccessToken,
        probe.storedTokenExpiresAt,
        nowMs,
      ) !== null
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
