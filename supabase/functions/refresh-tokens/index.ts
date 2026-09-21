import { verifyCronAuth } from "../_shared/cron-auth.ts";
import {
  accountCanAttemptRefresh,
  metaRefreshStrategy,
  metaTokenTooYoungToRefresh,
} from "../_shared/refreshEligibility.ts";
import { nextFailureCount, shouldEscalateToReauth } from "./escalation.ts";
import { mayStartAnotherAccount } from "./sweepBudget.ts";
import { type MetaProviderError } from "../_shared/metaErrors.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { handleCorsOptions, jsonResponse, errorResponse } from "../_shared/cors.ts";
import {
  PLATFORM_REFRESH_CONFIG,
  tokenNeedsRefresh,
  isShortLivedPlatform,
  isCronExcludedPlatform,
  TIME_CONSTANTS,
} from '../_shared/tokenExpiryConstants.ts';
import { createLogger, logTokenEvent } from '../_shared/logging.ts';
import { composioClientFromEnv } from '../_shared/composioClient.ts';
import {
  COMPOSIO_YOUTUBE_REAUTH_MESSAGE,
  probeYouTubeProvider,
} from './youtubeProviderRefresh.ts';

import {
  SocialAccount,
  refreshFacebookToken,
  refreshInstagramBusinessToken,
  refreshTikTokToken,
  refreshYouTubeToken,
  refreshPinterestToken,
  refreshLinkedInToken,
  refreshTwitterToken,
  refreshThreadsToken,
  refreshBlueskyToken,
  refreshRedditToken,
} from '../_shared/social-auth.ts';

import {
  cacheAvatarToCdn,
  fetchFacebookAvatarUrl,
  fetchInstagramAvatarUrl,
  fetchTikTokAvatarUrl,
  fetchTwitterAvatarUrl,
  fetchLinkedInAvatarUrl,
  fetchPinterestAvatarUrl,
  fetchYouTubeAvatarUrl,
  fetchThreadsAvatarUrl,
  fetchBlueskyAvatarUrl,
  fetchRedditAvatarUrl,
} from '../_shared/avatar-cache.ts';

interface SocialAccountWithDetails extends SocialAccount {
  platform_username?: string;
  ig_auth_type?: string | null;
  avatar_url?: string;
  account_metadata?: Record<string, unknown>;
  needs_reauth?: boolean;
  failure_count?: number;
  last_refresh_error?: string;
  last_alert_sent_at?: string;
  alerts_snoozed?: boolean;
  last_refresh_attempt_at?: string;
  auth_provider?: "native" | "composio";
  connection_id?: string | null;
  workspace_id?: string | null;
}

interface RefreshResult {
  id: string;
  platform: string;
  username?: string;
  userId?: string;
  status: 'refreshed' | 'error' | 'failed' | 'skipped' | 'needs_reauth' | 'already_refreshed' | 'cooldown';
  error?: string;
  avatarRefreshed?: boolean;
}

// Alert cooldown: 24 hours
const ALERT_COOLDOWN_MS = 24 * 60 * 60 * 1000;

// Refresh attempt cooldown: 5 minutes (prevents concurrent refresh races)
const REFRESH_ATTEMPT_COOLDOWN_MS = 5 * 60 * 1000;

// Health threshold for admin alerts (percentage)
const HEALTH_THRESHOLD_PERCENT = 70;

// Health alert cooldown: 24 hours (once daily max)
const HEALTH_ALERT_COOLDOWN_MS = 24 * 60 * 60 * 1000;

// Last health alert sent key (stored in memory, resets on function restart)
let lastHealthAlertSentAt: Date | null = null;

// Max failures before marking as needs_reauth
const MAX_FAILURES_BEFORE_REAUTH = 3;

// Errors that indicate permanent auth failure (user needs to reconnect)
// These trigger immediate needs_reauth without waiting for MAX_FAILURES
const PERMANENT_AUTH_ERRORS = [
  'invalid_grant',
  'Token has been expired or revoked',
  'The access token was revoked',
  'User has revoked access',
  'access_denied',
  'Authorization has been revoked',
  // TikTok-specific permanent errors
  'Refresh token is invalid or expired',
  'refresh_token_invalid',
  'invalid_refresh_token',
  // General refresh token errors
  'The refresh token is invalid',
  'Refresh token has expired',
  'refresh token expired',
  // Meta's revoked-grant phrase. Codes and subcodes are handled by isPermanentMetaError —
  // never put a bare number in this list, it is matched as a substring.
  'Error validating access token',
];

function isPermanentAuthError(error: string | undefined): boolean {
  if (!error) return false;
  const lowerError = error.toLowerCase();
  return PERMANENT_AUTH_ERRORS.some(e => lowerError.includes(e.toLowerCase()));
}

// Check if account was recently refreshed (within cooldown period)
function isWithinRefreshCooldown(lastRefreshAttemptAt: string | undefined): boolean {
  if (!lastRefreshAttemptAt) return false;
  const lastAttempt = new Date(lastRefreshAttemptAt);
  const now = new Date();
  return (now.getTime() - lastAttempt.getTime()) < REFRESH_ATTEMPT_COOLDOWN_MS;
}

// Log refresh history to database
async function logRefreshHistory(
  supabaseAdmin: AnySupabase,
  results: RefreshResult[],
  triggerType: 'cron' | 'manual' | 'force',
  cronCategory?: string
): Promise<void> {
  if (results.length === 0) return;

  try {
    const historyEntries = results.map(result => ({
      account_id: result.id,
      platform: result.platform,
      platform_username: result.username || null,
      status: result.status,
      error_message: result.error || null,
      trigger_type: triggerType,
      cron_category: cronCategory || null,
    }));

    const { error } = await supabaseAdmin
      .from('token_refresh_history')
      .insert(historyEntries);

    if (error) {
      console.error('[refresh-history] Failed to log history:', error);
    } else {
      console.log(`[refresh-history] Logged ${results.length} refresh attempts`);
    }
  } catch (err) {
    console.error('[refresh-history] Error logging history:', err);
  }
}

// deno-lint-ignore no-explicit-any
type AnySupabase = any;

// Helper to refresh and cache avatar during token refresh
async function refreshAndCacheAvatar(
  account: SocialAccountWithDetails,
  newAccessToken: string,
  supabaseAdmin: AnySupabase
): Promise<boolean> {
  try {
    let freshAvatarUrl: string | null = null;

    switch (account.platform) {
      case 'facebook':
        freshAvatarUrl = await fetchFacebookAvatarUrl(newAccessToken, account.platform_user_id);
        break;
      case 'instagram':
        freshAvatarUrl = await fetchInstagramAvatarUrl(newAccessToken, account.platform_user_id);
        break;
      case 'tiktok':
        freshAvatarUrl = await fetchTikTokAvatarUrl(newAccessToken);
        break;
      case 'twitter':
        freshAvatarUrl = await fetchTwitterAvatarUrl(newAccessToken);
        break;
      case 'linkedin':
        freshAvatarUrl = await fetchLinkedInAvatarUrl(newAccessToken);
        break;
      case 'pinterest':
        freshAvatarUrl = await fetchPinterestAvatarUrl(newAccessToken);
        break;
      case 'youtube':
        freshAvatarUrl = await fetchYouTubeAvatarUrl(newAccessToken);
        break;
      case 'threads':
        freshAvatarUrl = await fetchThreadsAvatarUrl(newAccessToken, account.platform_user_id);
        break;
      case 'bluesky':
        freshAvatarUrl = await fetchBlueskyAvatarUrl(newAccessToken, account.platform_username || '');
        break;
      case 'reddit':
        freshAvatarUrl = await fetchRedditAvatarUrl(newAccessToken);
        break;
    }

    if (freshAvatarUrl) {
      // Cache to Cloudinary for permanent storage
      const cachedUrl = await cacheAvatarToCdn(
        freshAvatarUrl,
        account.user_id,
        account.platform,
        account.platform_user_id
      );

      if (cachedUrl && cachedUrl !== account.avatar_url) {
        // Update avatar URL in database
        const { error } = await supabaseAdmin
          .from('social_accounts')
          .update({ avatar_url: cachedUrl } as Record<string, unknown>)
          .eq('id', account.id);

        if (error) {
          console.error(`[avatar-refresh] Failed to update avatar for ${account.platform}/${account.id}:`, error);
          return false;
        }

        console.log(`[avatar-refresh] Updated avatar for ${account.platform}/${account.id}`);
        return true;
      }
    }

    return false;
  } catch (error) {
    console.error(`[avatar-refresh] Error refreshing avatar for ${account.platform}/${account.id}:`, error);
    return false;
  }
}

// Mark refresh attempt timestamp before starting
async function markRefreshAttempt(
  supabaseAdmin: AnySupabase,
  accountId: string
): Promise<void> {
  await supabaseAdmin
    .from('social_accounts')
    .update({ 
      last_refresh_attempt_at: new Date().toISOString() 
    } as Record<string, unknown>)
    .eq('id', accountId);
}

// Handle successful token refresh with optimistic concurrency
// Returns true if update was applied, false if token was already refreshed by another process
async function handleRefreshSuccess(
  supabaseAdmin: AnySupabase,
  accountId: string,
  oldRefreshToken: string | null,
  newToken: string,
  expiresAt: string,
  newRefreshToken?: string
): Promise<{ updated: boolean }> {
  const updateData: Record<string, unknown> = {
    access_token: newToken,
    token_expires_at: expiresAt,
    updated_at: new Date().toISOString(),
    // Reset failure tracking on success
    needs_reauth: false,
    failure_count: 0,
    last_refresh_error: null,
  };

  if (newRefreshToken) {
    updateData.refresh_token = newRefreshToken;
  }

  // Use optimistic concurrency: only update if refresh_token hasn't changed
  // This prevents race conditions where two workers refresh the same account
  let query = supabaseAdmin
    .from('social_accounts')
    .update(updateData)
    .eq('id', accountId);

  // If we have the old refresh token, use it as a guard
  // This ensures we don't overwrite a token that was already refreshed by another process
  if (oldRefreshToken) {
    query = query.eq('refresh_token', oldRefreshToken);
  }

  const { data, error, count } = await query.select('id');

  if (error) {
    console.error(`[refresh-success] Database error for account ${accountId}:`, error);
    return { updated: false };
  }

  // Check if any rows were updated
  const rowsUpdated = data?.length || 0;
  
  if (rowsUpdated === 0 && oldRefreshToken) {
    // No rows updated means the refresh token was already changed by another process
    console.log(`[refresh-success] Account ${accountId}: Token already refreshed by another process (optimistic concurrency)`);
    return { updated: false };
  }

  console.log(`[refresh-success] Account ${accountId}: Token updated successfully`);
  return { updated: true };
}

// Handle failed token refresh - increment failures and potentially mark as needs_reauth
async function handleRefreshFailure(
  supabaseAdmin: AnySupabase,
  account: SocialAccountWithDetails,
  errorMessage: string,
  providerError?: MetaProviderError,
): Promise<{ needsReauth: boolean; shouldAlert: boolean }> {
  const failureIsTransient = providerError?.transient === true;
  const currentFailureCount = nextFailureCount(account.failure_count || 0, providerError);
  const isPermanentError = isPermanentAuthError(errorMessage) || errorMessage.includes('Token limit exceeded');
  const needsReauth = shouldEscalateToReauth({
    failureCount: currentFailureCount,
    maxFailures: MAX_FAILURES_BEFORE_REAUTH,
    isPermanentMessage: isPermanentError,
    canAttemptRefresh: accountCanAttemptRefresh(account),
    providerError,
  });
  
  // Log detailed info for debugging
  console.log(`[refresh-failure] Account ${account.id} (${account.platform}):`, {
    error: errorMessage,
    isPermanentError,
    currentFailureCount,
    needsReauth,
    platform_username: account.platform_username,
    token_expires_at: account.token_expires_at,
  });

  // Check alert cooldown (24 hours)
  const now = new Date();
  const lastAlertSentAt = account.last_alert_sent_at ? new Date(account.last_alert_sent_at) : null;
  const shouldAlert = !account.alerts_snoozed && (
    !lastAlertSentAt || 
    (now.getTime() - lastAlertSentAt.getTime()) > ALERT_COOLDOWN_MS
  );

  if (failureIsTransient) {
    // Recorded so the error is visible, but the count is deliberately left where it was.
    console.log(`[refresh-failure] transient failure for ${account.id}; failure_count held at ${currentFailureCount}`);
  }

  // The failure record and the account.reauthorization_required fan-out are
  // ONE statement (D5 R1, Phase 6): partner_record_refresh_failure performs
  // this exact update and enqueues the event for the accounts whose
  // needs_reauth actually flipped false -> true, in the same transaction. A
  // second client call here would have a crash gap between the flag and the
  // event. The occurrence id carries the transition timestamp because an
  // account can be flipped, repaired, and flipped again -- the second flip
  // is a new occurrence, not a duplicate.
  const { data: reauthResult, error: reauthError } = await supabaseAdmin
    .rpc('partner_record_refresh_failure', {
      p_account_id: account.id,
      p_failure_count: currentFailureCount,
      p_last_error: errorMessage,
      p_escalate_reauth: needsReauth,
      p_last_alert_sent_at: shouldAlert ? now.toISOString() : null,
    });
  if (reauthError) {
    // Logged, never thrown: the refresh loop must survive one account's
    // bookkeeping failure, exactly as it survived an ignored update error
    // before this moved into the RPC.
    console.error(`[refresh-failure] Account ${account.id} failure record write failed:`, reauthError.message);
  } else if (reauthResult?.transitioned) {
    console.log(`[refresh-failure] Account ${account.id} escalated to needs_reauth; ${reauthResult.enqueued} webhook delivery row(s) enqueued`);
  }

  console.log(`[refresh-failure] Account ${account.id} (${account.platform}): failure #${currentFailureCount}, needsReauth=${needsReauth}, shouldAlert=${shouldAlert}`);

  return { needsReauth, shouldAlert };
}

async function probeComposioYouTubeAccount(
  supabaseAdmin: AnySupabase,
  account: SocialAccountWithDetails,
): Promise<{ result: RefreshResult; shouldAlert: boolean } | null> {
  if (account.platform !== 'youtube' || account.auth_provider !== 'composio') return null;
  let failure = { needsReauth: false, shouldAlert: false };
  try {
    const probe = await probeYouTubeProvider(account, {
      admin: supabaseAdmin,
      client: composioClientFromEnv(),
      refreshNative: async () => null,
      markInactive: async () => {
        failure = await handleRefreshFailure(
          supabaseAdmin,
          account,
          COMPOSIO_YOUTUBE_REAUTH_MESSAGE,
        );
      },
    });
    return probe.provider === 'composio' && probe.active
      ? { result: { id: account.id, platform: account.platform, status: 'skipped' }, shouldAlert: false }
      : {
        result: {
          id: account.id,
          platform: account.platform,
          status: failure.needsReauth ? 'needs_reauth' : 'failed',
          error: COMPOSIO_YOUTUBE_REAUTH_MESSAGE,
        },
        shouldAlert: failure.shouldAlert,
      };
  } catch (error) {
    const code = error instanceof Error ? error.message : 'connector_unavailable';
    return {
      result: { id: account.id, platform: account.platform, status: 'failed', error: code },
      shouldAlert: false,
    };
  }
}

// Single account refresh helper (used for force refresh)
async function refreshSingleAccount(
  supabaseAdmin: AnySupabase,
  account: SocialAccountWithDetails,
  _force: boolean = false
): Promise<RefreshResult> {
  const oldRefreshToken = account.refresh_token;

  const composioProbe = await probeComposioYouTubeAccount(supabaseAdmin, account);
  if (composioProbe) return composioProbe.result;

  // Meta platforms exchange their access token in place and never hold a refresh
  // token; only platforms that genuinely need one are failed here.
  if (metaTokenTooYoungToRefresh(account)) {
    console.log(`[force-refresh] Account ${account.id} (${account.platform}): token too young for provider refresh`);
    return { id: account.id, platform: account.platform, status: 'skipped', error: 'Token too new to refresh' };
  }

  if (!accountCanAttemptRefresh(account)) {
    console.log(`[force-refresh] Account ${account.id} has no refresh token`);
    await handleRefreshFailure(supabaseAdmin, account, 'No refresh token available');
    return { id: account.id, platform: account.platform, status: 'needs_reauth', error: 'No refresh token' };
  }

  let refreshResult = null;

  try {
    switch (account.platform) {
      case 'facebook': {
        const outcome = await refreshFacebookToken(account);
        if (outcome.ok) {
          const expiresAt = new Date();
          expiresAt.setSeconds(expiresAt.getSeconds() + outcome.expires_in);
          const { updated } = await handleRefreshSuccess(supabaseAdmin, account.id, oldRefreshToken, outcome.access_token, expiresAt.toISOString());
          if (updated) {
            const avatarRefreshed = await refreshAndCacheAvatar(account, outcome.access_token, supabaseAdmin);
            return { id: account.id, platform: account.platform, status: 'refreshed', avatarRefreshed };
          } else {
            return { id: account.id, platform: account.platform, status: 'already_refreshed' };
          }
        } else {
          const message = outcome.error.message || 'Could not refresh token';
          await handleRefreshFailure(supabaseAdmin, account, message, outcome.error);
          return { id: account.id, platform: account.platform, status: 'failed', error: message };
        }
      }

      case 'instagram': {
        // Business Login accounts hold Instagram-scoped tokens; Page-backed ones hold
        // Facebook Page tokens. The flavour lives in the ig_auth_type column.
        const outcome = metaRefreshStrategy(account) === 'ig_refresh'
          ? await refreshInstagramBusinessToken(account)
          : await refreshFacebookToken(account);

        if (outcome.ok) {
          const expiresAt = new Date();
          expiresAt.setSeconds(expiresAt.getSeconds() + outcome.expires_in);
          const { updated } = await handleRefreshSuccess(supabaseAdmin, account.id, oldRefreshToken, outcome.access_token, expiresAt.toISOString());
          if (updated) {
            const avatarRefreshed = await refreshAndCacheAvatar(account, outcome.access_token, supabaseAdmin);
            return { id: account.id, platform: account.platform, status: 'refreshed', avatarRefreshed };
          } else {
            return { id: account.id, platform: account.platform, status: 'already_refreshed' };
          }
        } else {
          const message = outcome.error.message || 'Could not refresh Instagram token';
          await handleRefreshFailure(supabaseAdmin, account, message, outcome.error);
          return { id: account.id, platform: account.platform, status: 'failed', error: message };
        }
      }

      case 'tiktok':
        try {
          refreshResult = await refreshTikTokToken(account);
          if (refreshResult) {
            const expiresAt = new Date();
            expiresAt.setSeconds(expiresAt.getSeconds() + refreshResult.expires_in);
            const { updated } = await handleRefreshSuccess(supabaseAdmin, account.id, oldRefreshToken, refreshResult.access_token, expiresAt.toISOString(), refreshResult.refresh_token);
            if (updated) {
              const avatarRefreshed = await refreshAndCacheAvatar(account, refreshResult.access_token, supabaseAdmin);
              return { id: account.id, platform: account.platform, status: 'refreshed', avatarRefreshed };
            } else {
              return { id: account.id, platform: account.platform, status: 'already_refreshed' };
            }
          } else {
            await handleRefreshFailure(supabaseAdmin, account, 'Could not refresh token');
            return { id: account.id, platform: account.platform, status: 'failed', error: 'Could not refresh token' };
          }
        } catch (tiktokError) {
          const errorMessage = tiktokError instanceof Error ? tiktokError.message : 'Could not refresh token';
          console.error(`[tiktok-force-refresh] Error for ${account.id}:`, errorMessage);
          await handleRefreshFailure(supabaseAdmin, account, errorMessage);
          return { id: account.id, platform: account.platform, status: 'failed', error: errorMessage };
        }

      case 'youtube':
        try {
          refreshResult = await refreshYouTubeToken(account);
          if (refreshResult) {
            const expiresAt = new Date();
            expiresAt.setSeconds(expiresAt.getSeconds() + refreshResult.expires_in);
            const { updated } = await handleRefreshSuccess(supabaseAdmin, account.id, oldRefreshToken, refreshResult.access_token, expiresAt.toISOString());
            if (updated) {
              const avatarRefreshed = await refreshAndCacheAvatar(account, refreshResult.access_token, supabaseAdmin);
              return { id: account.id, platform: account.platform, status: 'refreshed', avatarRefreshed };
            } else {
              return { id: account.id, platform: account.platform, status: 'already_refreshed' };
            }
          } else {
            await handleRefreshFailure(supabaseAdmin, account, 'Could not refresh token');
            return { id: account.id, platform: account.platform, status: 'failed', error: 'Could not refresh token' };
          }
        } catch (youtubeError) {
          let errorMessage = youtubeError instanceof Error ? youtubeError.message : 'Could not refresh token';
          
          // CUSTOM FIX: Handle invalid_grant specifically for YouTube (100 token limit)
          if (errorMessage.includes('invalid_grant')) {
            errorMessage = "Token limit exceeded. Please reconnect your account.";
            console.log(`[youtube-force-refresh] Detected invalid_grant for ${account.id}, marking as limit exceeded`);
          }

          console.error(`[youtube-force-refresh] Error for ${account.id}:`, errorMessage);
          await handleRefreshFailure(supabaseAdmin, account, errorMessage);
          return { id: account.id, platform: account.platform, status: 'failed', error: errorMessage };
        }

      case 'pinterest':
        refreshResult = await refreshPinterestToken(account);
        if (refreshResult) {
          const expiresAt = new Date();
          expiresAt.setSeconds(expiresAt.getSeconds() + refreshResult.expires_in);
          const { updated } = await handleRefreshSuccess(supabaseAdmin, account.id, oldRefreshToken, refreshResult.access_token, expiresAt.toISOString(), refreshResult.refresh_token);
          if (updated) {
            const avatarRefreshed = await refreshAndCacheAvatar(account, refreshResult.access_token, supabaseAdmin);
            return { id: account.id, platform: account.platform, status: 'refreshed', avatarRefreshed };
          } else {
            return { id: account.id, platform: account.platform, status: 'already_refreshed' };
          }
        } else {
          await handleRefreshFailure(supabaseAdmin, account, 'Could not refresh token');
          return { id: account.id, platform: account.platform, status: 'failed', error: 'Could not refresh token' };
        }

      case 'linkedin':
        refreshResult = await refreshLinkedInToken(account);
        if (refreshResult) {
          const expiresAt = new Date();
          expiresAt.setSeconds(expiresAt.getSeconds() + refreshResult.expires_in);
          const { updated } = await handleRefreshSuccess(supabaseAdmin, account.id, oldRefreshToken, refreshResult.access_token, expiresAt.toISOString(), refreshResult.refresh_token);
          if (updated) {
            const avatarRefreshed = await refreshAndCacheAvatar(account, refreshResult.access_token, supabaseAdmin);
            return { id: account.id, platform: account.platform, status: 'refreshed', avatarRefreshed };
          } else {
            return { id: account.id, platform: account.platform, status: 'already_refreshed' };
          }
        } else {
          await handleRefreshFailure(supabaseAdmin, account, 'Could not refresh token');
          return { id: account.id, platform: account.platform, status: 'failed', error: 'Could not refresh token' };
        }

      case 'twitter':
        refreshResult = await refreshTwitterToken(account);
        if (refreshResult) {
          const expiresAt = new Date();
          expiresAt.setSeconds(expiresAt.getSeconds() + refreshResult.expires_in);
          const { updated } = await handleRefreshSuccess(supabaseAdmin, account.id, oldRefreshToken, refreshResult.access_token, expiresAt.toISOString(), refreshResult.refresh_token);
          if (updated) {
            const avatarRefreshed = await refreshAndCacheAvatar(account, refreshResult.access_token, supabaseAdmin);
            return { id: account.id, platform: account.platform, status: 'refreshed', avatarRefreshed };
          } else {
            return { id: account.id, platform: account.platform, status: 'already_refreshed' };
          }
        } else {
          await handleRefreshFailure(supabaseAdmin, account, 'Could not refresh token');
          return { id: account.id, platform: account.platform, status: 'failed', error: 'Could not refresh token' };
        }

      case 'threads': {
        const outcome = await refreshThreadsToken(account);
        if (outcome.ok) {
          const expiresAt = new Date();
          expiresAt.setSeconds(expiresAt.getSeconds() + outcome.expires_in);
          const { updated } = await handleRefreshSuccess(supabaseAdmin, account.id, oldRefreshToken, outcome.access_token, expiresAt.toISOString());
          if (updated) {
            const avatarRefreshed = await refreshAndCacheAvatar(account, outcome.access_token, supabaseAdmin);
            return { id: account.id, platform: account.platform, status: 'refreshed', avatarRefreshed };
          } else {
            return { id: account.id, platform: account.platform, status: 'already_refreshed' };
          }
        } else {
          const message = outcome.error.message || 'Could not refresh token';
          await handleRefreshFailure(supabaseAdmin, account, message, outcome.error);
          return { id: account.id, platform: account.platform, status: 'failed', error: message };
        }
      }

      case 'bluesky':
        refreshResult = await refreshBlueskyToken(account);
        if (refreshResult) {
          const expiresAt = new Date();
          expiresAt.setSeconds(expiresAt.getSeconds() + refreshResult.expires_in);
          const { updated } = await handleRefreshSuccess(supabaseAdmin, account.id, oldRefreshToken, refreshResult.access_token, expiresAt.toISOString(), refreshResult.refresh_token);
          if (updated) {
            const avatarRefreshed = await refreshAndCacheAvatar(account, refreshResult.access_token, supabaseAdmin);
            return { id: account.id, platform: account.platform, status: 'refreshed', avatarRefreshed };
          } else {
            return { id: account.id, platform: account.platform, status: 'already_refreshed' };
          }
        } else {
          await handleRefreshFailure(supabaseAdmin, account, 'Could not refresh token');
          return { id: account.id, platform: account.platform, status: 'failed', error: 'Could not refresh token' };
        }

      case 'reddit':
        refreshResult = await refreshRedditToken(account);
        if (refreshResult) {
          const expiresAt = new Date();
          expiresAt.setSeconds(expiresAt.getSeconds() + refreshResult.expires_in);
          const { updated } = await handleRefreshSuccess(supabaseAdmin, account.id, oldRefreshToken, refreshResult.access_token, expiresAt.toISOString(), refreshResult.refresh_token);
          if (updated) {
            const avatarRefreshed = await refreshAndCacheAvatar(account, refreshResult.access_token, supabaseAdmin);
            return { id: account.id, platform: account.platform, status: 'refreshed', avatarRefreshed };
          } else {
            return { id: account.id, platform: account.platform, status: 'already_refreshed' };
          }
        } else {
          await handleRefreshFailure(supabaseAdmin, account, 'Could not refresh token');
          return { id: account.id, platform: account.platform, status: 'failed', error: 'Could not refresh token' };
        }

      default:
        console.log(`[force-refresh] Platform not supported: ${account.platform}`);
        return { id: account.id, platform: account.platform, status: 'skipped', error: 'Platform not supported for auto-refresh' };
    }
  } catch (platformError) {
    console.error(`[force-refresh] Error for ${account.platform} account ${account.id}:`, platformError);
    const errorMessage = platformError instanceof Error ? platformError.message : 'Unknown error';
    await handleRefreshFailure(supabaseAdmin, account, errorMessage);
    return { id: account.id, platform: account.platform, status: 'error', error: errorMessage };
  }
}

/**
 * Authorize a refresh-tokens request.
 *
 * Two accepted callers:
 *  - the cron job, via CRON_SECRET (or, when CRON_SECRET is unset, the service-role key as a
 *    bearer token — this stack has shipped without CRON_SECRET before);
 *  - a signed-in admin, via their Supabase JWT, for the admin "Refresh tokens" button.
 */
async function authorizeRefreshRequest(
  req: Request,
): Promise<{ ok: true; mode: 'cron' | 'admin' } | { ok: false; response: Response }> {
  if (Deno.env.get('CRON_SECRET')) {
    const cron = verifyCronAuth(req);
    if (cron.ok) return { ok: true, mode: 'cron' };
  } else {
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
    const header = req.headers.get('authorization') || req.headers.get('Authorization') || '';
    const bearer = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
    if (serviceKey && bearer && bearer === serviceKey) return { ok: true, mode: 'cron' };
  }

  const authHeader = req.headers.get('Authorization') || req.headers.get('authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return { ok: false, response: errorResponse('Unauthorized', 401) };
  }

  try {
    const admin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    );
    const token = authHeader.replace(/^Bearer\s+/i, '').trim();
    const { data: { user }, error } = await admin.auth.getUser(token);
    if (error || !user) return { ok: false, response: errorResponse('Unauthorized', 401) };

    const { data: roleData } = await admin
      .from('user_roles')
      .select('role')
      .eq('user_id', user.id)
      .eq('role', 'admin')
      .maybeSingle();
    if (!roleData) return { ok: false, response: errorResponse('Admin access required', 403) };

    console.log(`refresh-tokens authorized via admin JWT: ${user.id}`);
    return { ok: true, mode: 'admin' };
  } catch (e) {
    console.error(e);
    return { ok: false, response: errorResponse('Unauthorized', 401) };
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return handleCorsOptions();
  }

  const auth = await authorizeRefreshRequest(req);
  if (!auth.ok) return auth.response;

  try {
    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    const logger = createLogger(supabaseAdmin, 'refresh-tokens', 'token');

    // Parse request body for optional parameters
    let accountId: string | null = null;
    let accountIds: string[] = [];
    let force = false;
    let manual = false;
    let platforms: string[] = [];

    try {
      const body = await req.json();
      accountId = body.accountId || null;
      accountIds = body.accountIds || [];
      force = body.force === true;
      manual = body.manual === true;
      platforms = body.platforms || [];
    } catch {
      // No body or invalid JSON - proceed with default behavior
    }

    // An admin pressing "refresh" is not a scheduled sweep: it should reach every account,
    // ignoring both the per-platform refresh window and the concurrency cooldown.
    const adminTriggered = force || manual;

    // Single account force refresh mode
    if (accountId && force) {
      await logger.info(`Force refreshing single account: ${accountId}`);
      
      // Fetch the specific account (bypass needs_reauth filter for force refresh)
      const { data: account, error: fetchError } = await supabaseAdmin
        .from('social_accounts')
        .select('*')
        .eq('id', accountId)
        .eq('is_active', true)
        .single();

      if (fetchError || !account) {
        console.error('Error fetching account for force refresh:', fetchError);
        return errorResponse(fetchError?.message || 'Account not found');
      }

      // Only mark the attempt. Clearing needs_reauth/failure_count here would declare
      // the account healthy BEFORE proving the refresh works: refreshSingleAccount is
      // handed the pre-reset object, so a subsequent handleRefreshFailure computes
      // failure_count from the stale value, stays under MAX_FAILURES_BEFORE_REAUTH and
      // never restores the flag — leaving a genuinely dead account green.
      // handleRefreshSuccess is the only place that may clear these.
      await markRefreshAttempt(supabaseAdmin, accountId);

      // Attempt the refresh
      const result = await refreshSingleAccount(supabaseAdmin, account as SocialAccountWithDetails, true);
      result.username = account.platform_username;
      
      // Log to history
      await logRefreshHistory(supabaseAdmin, [result], 'force');
      
      await logger.info(`Force refresh complete for ${accountId}:`, { result });
      
      return jsonResponse({
        message: 'Force refresh complete',
        accountId,
        ...result,
      });
    }

    // Bulk force refresh mode - refresh multiple accounts at once
    if (accountIds.length > 0 && force) {
      await logger.info(`Bulk force refreshing ${accountIds.length} accounts`);
      
      // Fetch all specified accounts (bypass needs_reauth filter for force refresh)
      const { data: accountsToRefresh, error: fetchError } = await supabaseAdmin
        .from('social_accounts')
        .select('*')
        .in('id', accountIds)
        .eq('is_active', true);

      if (fetchError) {
        console.error('Error fetching accounts for bulk force refresh:', fetchError);
        return errorResponse(fetchError.message);
      }

      if (!accountsToRefresh || accountsToRefresh.length === 0) {
        return jsonResponse({ message: 'No accounts found', refreshed: 0, total: 0 });
      }

      const bulkResults: RefreshResult[] = [];
      
      for (const account of accountsToRefresh as SocialAccountWithDetails[]) {
        // See the single-account path: only mark the attempt, never pre-clear health.
        await markRefreshAttempt(supabaseAdmin, account.id);

        // Attempt the refresh
        const result = await refreshSingleAccount(supabaseAdmin, account, true);
        result.username = account.platform_username;
        bulkResults.push(result);
      }

      // Log all results to history
      await logRefreshHistory(supabaseAdmin, bulkResults, 'force');

      const refreshed = bulkResults.filter(r => r.status === 'refreshed').length;
      const alreadyRefreshed = bulkResults.filter(r => r.status === 'already_refreshed').length;
      const failed = bulkResults.filter(r => r.status === 'failed' || r.status === 'error' || r.status === 'needs_reauth').length;
      
      await logger.info(`Bulk force refresh complete: ${refreshed} refreshed, ${alreadyRefreshed} already_refreshed, ${failed} failed`);
      
      return jsonResponse({
        message: 'Bulk force refresh complete',
        refreshed,
        alreadyRefreshed,
        failed,
        total: accountsToRefresh.length,
        results: bulkResults,
      });
    }

    // Log platform filter if provided
    if (platforms.length > 0) {
      await logger.info(`Starting token refresh check for platforms: ${platforms.join(', ')}`);
    } else {
      await logger.info('Starting token refresh check for all platforms...');
    }

    // Get the current time for comparisons
    const now = new Date();
    
    // Build query - Fetch all active accounts with token expiry that DON'T need reauth
    let query = supabaseAdmin
      .from('social_accounts')
      .select('*')
      .eq('is_active', true)
      .or('needs_reauth.is.null,needs_reauth.eq.false') // Skip accounts marked as needs_reauth
      .or('token_expires_at.not.is.null,auth_provider.eq.composio')
      // Oldest attempt first, never-attempted before everything. The sweep always stops
      // at the same budget, so without this rotation the same head-of-list accounts
      // would be refreshed every run and the tail would starve forever.
      .order('last_refresh_attempt_at', { ascending: true, nullsFirst: true });

    // Filter by platforms if specified
    if (platforms.length > 0) {
      query = query.in('platform', platforms);
    }

    const { data: allAccounts, error: fetchError } = await query;

    if (fetchError) {
      console.error('Error fetching accounts:', fetchError);
      throw fetchError;
    }

    const platformsFilter = platforms.length > 0 ? ` for platforms [${platforms.join(', ')}]` : '';
    console.log(`Found ${allAccounts?.length || 0} active accounts with token expiry set${platformsFilter} (excluding needs_reauth)`);

    if (!allAccounts || allAccounts.length === 0) {
      return jsonResponse({ message: 'No accounts to check', refreshed: 0, checked: 0, platforms });
    }

    // Filter accounts that need refresh based on platform-specific windows
    // Skip cron-excluded platforms (like YouTube) in automatic cron cycles
    const accountsNeedingRefresh = allAccounts.filter((account: SocialAccountWithDetails) => {
      // Skip YouTube (and other cron-excluded platforms) in automatic cron cycles.
      // They only refresh via force/manual trigger or when explicitly requested by platform filter.
      if (!adminTriggered && platforms.length === 0 && isCronExcludedPlatform(account.platform)) {
        console.log(`[cron-skip] Skipping ${account.platform} account ${account.id} — cron-excluded (JIT refresh only)`);
        return false;
      }
      if (adminTriggered) return true;
      return tokenNeedsRefresh(account.platform, account.token_expires_at);
    });

    console.log(`${accountsNeedingRefresh.length} accounts need token refresh based on platform-specific windows`);

    if (accountsNeedingRefresh.length === 0) {
      return jsonResponse({ 
        message: 'No tokens need refreshing', 
        refreshed: 0,
        checked: allAccounts.length,
        platforms_checked: [...new Set(allAccounts.map((a: SocialAccountWithDetails) => a.platform))],
        platforms_filter: platforms.length > 0 ? platforms : 'all'
      });
    }

    // Log which platforms need refresh
    const platformsNeedingRefresh = [...new Set(accountsNeedingRefresh.map((a: SocialAccountWithDetails) => a.platform))];
    console.log('Platforms needing refresh:', platformsNeedingRefresh);

    const results: RefreshResult[] = [];
    const accountsToAlert: SocialAccountWithDetails[] = [];

    // 57 accounts × 8s worst case is 456s against a 60s worker ceiling — a per-request
    // timeout cannot bound the sweep, only a sweep-wide deadline can.
    const sweepStartedAt = Date.now();
    let processed = 0;

    for (const account of accountsNeedingRefresh as SocialAccountWithDetails[]) {
      // The test is whether the WORST CASE for one more account still fits, not whether
      // the budget is already spent. Checking elapsed alone let the sweep start an
      // account at 44.9s that could then spend 8s on the exchange plus 8s fetching and
      // 8s uploading the avatar — 68.9s against a 60s ceiling, killed mid-write. A bound
      // that can be exceeded by 24s is not a bound.
      if (!mayStartAnotherAccount(Date.now() - sweepStartedAt)) {
        console.log(`[refresh-budget] budget spent; deferring ${accountsNeedingRefresh.length - processed} accounts to the next run`);
        for (const deferred of accountsNeedingRefresh.slice(processed)) {
          // Deferred accounts are skipped, NEVER failed: they were never attempted, so
          // handleRefreshFailure must not run for them — otherwise the budget itself
          // would increment failure_count and, three sweeps later, latch healthy accounts.
          results.push({ id: deferred.id, platform: deferred.platform, status: 'skipped', error: 'Deferred: sweep budget spent' });
        }
        break;
      }
      processed++;
      const platformConfig = PLATFORM_REFRESH_CONFIG[account.platform.toLowerCase()];
      
      // Enhanced logging with more context
      console.log(`[refresh-check] Account ${account.id}:`, {
        platform: account.platform,
        username: account.platform_username,
        token_expires_at: account.token_expires_at,
        last_refresh_attempt_at: account.last_refresh_attempt_at,
        failure_count: account.failure_count || 0,
        refresh_window: platformConfig?.refreshWindowSeconds || 'default',
      });

      // Check cooldown to prevent concurrent refresh attempts
      if (!adminTriggered && isWithinRefreshCooldown(account.last_refresh_attempt_at)) {
        console.log(`[refresh-cooldown] Account ${account.id} (${account.platform}): Recently attempted, skipping (cooldown: ${REFRESH_ATTEMPT_COOLDOWN_MS / 1000}s)`);
        results.push({ 
          id: account.id, 
          platform: account.platform, 
          status: 'cooldown', 
          error: 'Recently attempted refresh' 
        });
        continue;
      }

      // Meta refuses to refresh an Instagram/Threads token under 24h old. Attempting it
      // anyway records a failure against a perfectly healthy, freshly reconnected account.
      if (metaTokenTooYoungToRefresh(account)) {
        console.log(`[refresh-skip] Account ${account.id} (${account.platform}): token too young for provider refresh`);
        results.push({ id: account.id, platform: account.platform, status: 'skipped', error: 'Token too new to refresh' });
        continue;
      }

      const composioProbe = await probeComposioYouTubeAccount(supabaseAdmin, account);
      if (composioProbe) {
        results.push(composioProbe.result);
        if (composioProbe.shouldAlert) accountsToAlert.push(account);
        continue;
      }

      // Meta platforms exchange their access token in place and never hold a refresh
      // token; only platforms that genuinely need one are failed here.
      if (!accountCanAttemptRefresh(account)) {
        console.log(`Account ${account.id} has no refresh token - marking as needs_reauth`);
        const { shouldAlert } = await handleRefreshFailure(supabaseAdmin, account, 'No refresh token available');
        results.push({ id: account.id, platform: account.platform, status: 'needs_reauth', error: 'No refresh token' });
        if (shouldAlert) accountsToAlert.push(account);
        continue;
      }

      // Mark refresh attempt before starting (prevents concurrent attempts)
      await markRefreshAttempt(supabaseAdmin, account.id);

      // Store the old refresh token for optimistic concurrency
      const oldRefreshToken = account.refresh_token;

      let refreshResult = null;

      try {
        switch (account.platform) {
          case 'facebook':
          case 'instagram': {
            // Instagram Business Login accounts hold Instagram-scoped tokens and must
            // exchange at graph.instagram.com; Facebook Pages and Page-backed Instagram
            // accounts use fb_exchange_token.
            const outcome = metaRefreshStrategy(account) === 'ig_refresh'
              ? await refreshInstagramBusinessToken(account)
              : await refreshFacebookToken(account);

            if (outcome.ok) {
              const expiresAt = new Date();
              expiresAt.setSeconds(expiresAt.getSeconds() + outcome.expires_in);
              const { updated } = await handleRefreshSuccess(supabaseAdmin, account.id, oldRefreshToken, outcome.access_token, expiresAt.toISOString());
              if (updated) {
                const avatarRefreshed = await refreshAndCacheAvatar(account, outcome.access_token, supabaseAdmin);
                results.push({ id: account.id, platform: account.platform, status: 'refreshed', avatarRefreshed });
              } else {
                results.push({ id: account.id, platform: account.platform, status: 'already_refreshed' });
              }
            } else {
              const message = outcome.error.message || 'Could not refresh token';
              const { needsReauth, shouldAlert } = await handleRefreshFailure(supabaseAdmin, account, message, outcome.error);
              results.push({ id: account.id, platform: account.platform, status: needsReauth ? 'needs_reauth' : 'failed', error: message });
              if (shouldAlert) accountsToAlert.push(account);
            }
            break;
          }

          case 'tiktok':
            try {
              refreshResult = await refreshTikTokToken(account);
              if (refreshResult) {
                const expiresAt = new Date();
                expiresAt.setSeconds(expiresAt.getSeconds() + refreshResult.expires_in);
                const { updated } = await handleRefreshSuccess(supabaseAdmin, account.id, oldRefreshToken, refreshResult.access_token, expiresAt.toISOString(), refreshResult.refresh_token);
                if (updated) {
                  const avatarRefreshed = await refreshAndCacheAvatar(account, refreshResult.access_token, supabaseAdmin);
                  results.push({ id: account.id, platform: account.platform, status: 'refreshed', avatarRefreshed });
                } else {
                  results.push({ id: account.id, platform: account.platform, status: 'already_refreshed' });
                }
              } else {
                const { needsReauth, shouldAlert } = await handleRefreshFailure(supabaseAdmin, account, 'Could not refresh token');
                results.push({ id: account.id, platform: account.platform, status: needsReauth ? 'needs_reauth' : 'failed', error: 'Could not refresh token' });
                if (shouldAlert) accountsToAlert.push(account);
              }
            } catch (tiktokError) {
              // TikTok now throws with actual error message
              const errorMessage = tiktokError instanceof Error ? tiktokError.message : 'Could not refresh token';
              console.error(`[tiktok-refresh] Error for ${account.id}:`, errorMessage);
              const { needsReauth, shouldAlert } = await handleRefreshFailure(supabaseAdmin, account, errorMessage);
              results.push({ id: account.id, platform: account.platform, status: needsReauth ? 'needs_reauth' : 'failed', error: errorMessage });
              if (shouldAlert) accountsToAlert.push(account);
            }
            break;

          case 'youtube':
            try {
              refreshResult = await refreshYouTubeToken(account);
              if (refreshResult) {
                const expiresAt = new Date();
                expiresAt.setSeconds(expiresAt.getSeconds() + refreshResult.expires_in);
                const { updated } = await handleRefreshSuccess(supabaseAdmin, account.id, oldRefreshToken, refreshResult.access_token, expiresAt.toISOString());
                if (updated) {
                  const avatarRefreshed = await refreshAndCacheAvatar(account, refreshResult.access_token, supabaseAdmin);
                  results.push({ id: account.id, platform: account.platform, status: 'refreshed', avatarRefreshed });
                } else {
                  results.push({ id: account.id, platform: account.platform, status: 'already_refreshed' });
                }
              }
            } catch (youtubeError) {
              // YouTube now throws with actual error message (e.g., 'invalid_grant')
              let errorMessage = youtubeError instanceof Error ? youtubeError.message : 'Could not refresh token';
              
              // CUSTOM FIX: Handle invalid_grant specifically for YouTube (100 token limit)
              if (errorMessage.includes('invalid_grant')) {
                errorMessage = "Token limit exceeded. Please reconnect your account.";
                console.log(`[youtube-refresh] Detected invalid_grant for ${account.id}, marking as limit exceeded`);
              }

              console.error(`[youtube-refresh] Error for ${account.id}:`, errorMessage);
              const { needsReauth, shouldAlert } = await handleRefreshFailure(supabaseAdmin, account, errorMessage);
              results.push({ id: account.id, platform: account.platform, status: needsReauth ? 'needs_reauth' : 'failed', error: errorMessage });
              if (shouldAlert) accountsToAlert.push(account);
            }
            break;

          case 'pinterest':
            refreshResult = await refreshPinterestToken(account);
            if (refreshResult) {
              const expiresAt = new Date();
              expiresAt.setSeconds(expiresAt.getSeconds() + refreshResult.expires_in);
              const { updated } = await handleRefreshSuccess(supabaseAdmin, account.id, oldRefreshToken, refreshResult.access_token, expiresAt.toISOString(), refreshResult.refresh_token);
              if (updated) {
                const avatarRefreshed = await refreshAndCacheAvatar(account, refreshResult.access_token, supabaseAdmin);
                results.push({ id: account.id, platform: account.platform, status: 'refreshed', avatarRefreshed });
              } else {
                results.push({ id: account.id, platform: account.platform, status: 'already_refreshed' });
              }
            } else {
              const { needsReauth, shouldAlert } = await handleRefreshFailure(supabaseAdmin, account, 'Could not refresh token');
              results.push({ id: account.id, platform: account.platform, status: needsReauth ? 'needs_reauth' : 'failed', error: 'Could not refresh token' });
              if (shouldAlert) accountsToAlert.push(account);
            }
            break;

          case 'linkedin':
            refreshResult = await refreshLinkedInToken(account);
            if (refreshResult) {
              const expiresAt = new Date();
              expiresAt.setSeconds(expiresAt.getSeconds() + refreshResult.expires_in);
              const { updated } = await handleRefreshSuccess(supabaseAdmin, account.id, oldRefreshToken, refreshResult.access_token, expiresAt.toISOString(), refreshResult.refresh_token);
              if (updated) {
                const avatarRefreshed = await refreshAndCacheAvatar(account, refreshResult.access_token, supabaseAdmin);
                results.push({ id: account.id, platform: account.platform, status: 'refreshed', avatarRefreshed });
              } else {
                results.push({ id: account.id, platform: account.platform, status: 'already_refreshed' });
              }
            } else {
              const { needsReauth, shouldAlert } = await handleRefreshFailure(supabaseAdmin, account, 'Could not refresh token');
              results.push({ id: account.id, platform: account.platform, status: needsReauth ? 'needs_reauth' : 'failed', error: 'Could not refresh token' });
              if (shouldAlert) accountsToAlert.push(account);
            }
            break;

          case 'twitter':
            refreshResult = await refreshTwitterToken(account);
            if (refreshResult) {
              const expiresAt = new Date();
              expiresAt.setSeconds(expiresAt.getSeconds() + refreshResult.expires_in);
              const { updated } = await handleRefreshSuccess(supabaseAdmin, account.id, oldRefreshToken, refreshResult.access_token, expiresAt.toISOString(), refreshResult.refresh_token);
              if (updated) {
                const avatarRefreshed = await refreshAndCacheAvatar(account, refreshResult.access_token, supabaseAdmin);
                results.push({ id: account.id, platform: account.platform, status: 'refreshed', avatarRefreshed });
              } else {
                results.push({ id: account.id, platform: account.platform, status: 'already_refreshed' });
              }
            } else {
              const { needsReauth, shouldAlert } = await handleRefreshFailure(supabaseAdmin, account, 'Could not refresh token');
              results.push({ id: account.id, platform: account.platform, status: needsReauth ? 'needs_reauth' : 'failed', error: 'Could not refresh token' });
              if (shouldAlert) accountsToAlert.push(account);
            }
            break;

          case 'threads': {
            const outcome = await refreshThreadsToken(account);
            if (outcome.ok) {
              const expiresAt = new Date();
              expiresAt.setSeconds(expiresAt.getSeconds() + outcome.expires_in);
              const { updated } = await handleRefreshSuccess(supabaseAdmin, account.id, oldRefreshToken, outcome.access_token, expiresAt.toISOString());
              if (updated) {
                const avatarRefreshed = await refreshAndCacheAvatar(account, outcome.access_token, supabaseAdmin);
                results.push({ id: account.id, platform: account.platform, status: 'refreshed', avatarRefreshed });
              } else {
                results.push({ id: account.id, platform: account.platform, status: 'already_refreshed' });
              }
            } else {
              const message = outcome.error.message || 'Could not refresh token';
              const { needsReauth, shouldAlert } = await handleRefreshFailure(supabaseAdmin, account, message, outcome.error);
              results.push({ id: account.id, platform: account.platform, status: needsReauth ? 'needs_reauth' : 'failed', error: message });
              if (shouldAlert) accountsToAlert.push(account);
            }
            break;
          }

          case 'bluesky':
            refreshResult = await refreshBlueskyToken(account);
            if (refreshResult) {
              const expiresAt = new Date();
              expiresAt.setSeconds(expiresAt.getSeconds() + refreshResult.expires_in);
              const { updated } = await handleRefreshSuccess(supabaseAdmin, account.id, oldRefreshToken, refreshResult.access_token, expiresAt.toISOString(), refreshResult.refresh_token);
              if (updated) {
                const avatarRefreshed = await refreshAndCacheAvatar(account, refreshResult.access_token, supabaseAdmin);
                results.push({ id: account.id, platform: account.platform, status: 'refreshed', avatarRefreshed });
              } else {
                results.push({ id: account.id, platform: account.platform, status: 'already_refreshed' });
              }
            } else {
              const { needsReauth, shouldAlert } = await handleRefreshFailure(supabaseAdmin, account, 'Could not refresh token');
              results.push({ id: account.id, platform: account.platform, status: needsReauth ? 'needs_reauth' : 'failed', error: 'Could not refresh token' });
              if (shouldAlert) accountsToAlert.push(account);
            }
            break;

          case 'reddit':
            refreshResult = await refreshRedditToken(account);
            if (refreshResult) {
              const expiresAt = new Date();
              expiresAt.setSeconds(expiresAt.getSeconds() + refreshResult.expires_in);
              const { updated } = await handleRefreshSuccess(supabaseAdmin, account.id, oldRefreshToken, refreshResult.access_token, expiresAt.toISOString(), refreshResult.refresh_token);
              if (updated) {
                const avatarRefreshed = await refreshAndCacheAvatar(account, refreshResult.access_token, supabaseAdmin);
                results.push({ id: account.id, platform: account.platform, status: 'refreshed', avatarRefreshed });
              } else {
                results.push({ id: account.id, platform: account.platform, status: 'already_refreshed' });
              }
            } else {
              const { needsReauth, shouldAlert } = await handleRefreshFailure(supabaseAdmin, account, 'Could not refresh token');
              results.push({ id: account.id, platform: account.platform, status: needsReauth ? 'needs_reauth' : 'failed', error: 'Could not refresh token' });
              if (shouldAlert) accountsToAlert.push(account);
            }
            break;

          default:
            console.log(`Token refresh not implemented for platform: ${account.platform}`);
            results.push({ id: account.id, platform: account.platform, status: 'skipped', error: 'Platform not supported for auto-refresh' });
        }
      } catch (platformError) {
        console.error(`[refresh-error] ${account.platform} account ${account.id}:`, platformError);
        const errorMessage = platformError instanceof Error ? platformError.message : 'Unknown error';
        const { needsReauth, shouldAlert } = await handleRefreshFailure(supabaseAdmin, account, errorMessage);
        results.push({ 
          id: account.id, 
          platform: account.platform, 
          status: needsReauth ? 'needs_reauth' : 'error', 
          error: errorMessage 
        });
        if (shouldAlert) accountsToAlert.push(account);
      }
    }

    // Summary stats
    const refreshed = results.filter(r => r.status === 'refreshed').length;
    const alreadyRefreshed = results.filter(r => r.status === 'already_refreshed').length;
    const cooldown = results.filter(r => r.status === 'cooldown').length;
    const failed = results.filter(r => r.status === 'failed' || r.status === 'error').length;
    const skipped = results.filter(r => r.status === 'skipped').length;
    const markedNeedsReauth = results.filter(r => r.status === 'needs_reauth').length;

    // Log summary with enhanced stats
    await logger.info(`Token refresh complete: ${refreshed} refreshed, ${alreadyRefreshed} already_refreshed, ${cooldown} cooldown, ${failed} failed, ${skipped} skipped, ${markedNeedsReauth} needs_reauth`, {
      refreshed,
      alreadyRefreshed,
      cooldown,
      failed,
      skipped,
      markedNeedsReauth,
      total_checked: allAccounts.length,
    });

    // Send email alerts ONLY for accounts that should be alerted (respecting cooldown)
    if (accountsToAlert.length > 0) {
      await logger.warn(`${accountsToAlert.length} accounts need alerts (within cooldown window)`, { 
        accountIds: accountsToAlert.map(a => a.id) 
      });
      
      try {
        // Get user emails for accounts to alert
        const userIds = [...new Set(accountsToAlert.map(a => a.user_id))];
        const { data: profiles } = await supabaseAdmin
          .from('profiles')
          .select('id, email')
          .in('id', userIds);

        const userEmailMap = new Map(profiles?.map((p: { id: string; email: string }) => [p.id, p.email]) || []);

        const failureAlerts = accountsToAlert.map(account => {
          const resultForAccount = results.find(r => r.id === account.id);
          return {
            platform: account.platform,
            accountId: account.id,
            username: account.platform_username,
            userId: account.user_id,
            userEmail: userEmailMap.get(account.user_id) || '',
            errorMessage: resultForAccount?.error || account.last_refresh_error || 'Unknown error',
            failedAt: new Date().toISOString(),
            failureCount: (account.failure_count || 0) + 1,
            needsReauth: resultForAccount?.status === 'needs_reauth',
          };
        });

        // Call the alert edge function
        const alertResponse = await fetch(
          `${Deno.env.get('SUPABASE_URL')}/functions/v1/send-token-failure-alert`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`,
            },
            body: JSON.stringify({ failures: failureAlerts }),
          }
        );

        if (!alertResponse.ok) {
          console.error('Failed to send failure alerts:', await alertResponse.text());
        } else {
          console.log(`Failure alerts sent for ${accountsToAlert.length} accounts`);
        }
      } catch (alertError) {
        console.error('Error sending failure alerts:', alertError);
      }
    } else {
      console.log('No alerts to send (all failures within cooldown or snoozed)');
    }

    // Determine trigger type and cron category for logging
    const triggerType: 'cron' | 'manual' | 'force' =
      force ? 'force' : (manual || auth.mode === 'admin') ? 'manual' : 'cron';
    let cronCategory: string | undefined;
    if (platforms.length > 0) {
      // Determine category based on platforms
      const shortPlatforms = ['twitter', 'youtube', 'reddit', 'bluesky'];
      const mediumPlatforms = ['tiktok', 'pinterest'];
      const longPlatforms = ['facebook', 'instagram', 'threads', 'linkedin'];
      
      if (platforms.every(p => shortPlatforms.includes(p))) cronCategory = 'short';
      else if (platforms.every(p => mediumPlatforms.includes(p))) cronCategory = 'medium';
      else if (platforms.every(p => longPlatforms.includes(p))) cronCategory = 'long';
    }

    // Log all results to history
    const resultsWithUsernames = results.map(r => {
      const account = accountsNeedingRefresh.find((a: SocialAccountWithDetails) => a.id === r.id);
      return { ...r, username: account?.platform_username };
    });
    await logRefreshHistory(supabaseAdmin, resultsWithUsernames, triggerType, cronCategory);

    // Check overall health and send admin alert if below threshold
    try {
      // Fetch current health status of all active accounts
      const { data: allActiveAccounts, error: healthError } = await supabaseAdmin
        .from('social_accounts')
        .select('id, platform, platform_username, token_expires_at, needs_reauth, is_active')
        .eq('is_active', true);

      if (!healthError && allActiveAccounts && allActiveAccounts.length > 0) {
        const now = new Date();
        
        // Calculate health: healthy = not expired and not needs_reauth
        const healthyAccounts = allActiveAccounts.filter((account: { token_expires_at: string | null; needs_reauth: boolean }) => {
          if (account.needs_reauth) return false;
          if (!account.token_expires_at) return false;
          const expiryDate = new Date(account.token_expires_at);
          return expiryDate > now;
        });

        const totalAccounts = allActiveAccounts.length;
        const healthyCount = healthyAccounts.length;
        const healthPercentage = Math.round((healthyCount / totalAccounts) * 100);

        console.log(`[health-check] Overall health: ${healthPercentage}% (${healthyCount}/${totalAccounts})`);

        // Check if we should send a health alert
        const shouldSendHealthAlert = healthPercentage < HEALTH_THRESHOLD_PERCENT && 
          (!lastHealthAlertSentAt || (now.getTime() - lastHealthAlertSentAt.getTime()) > HEALTH_ALERT_COOLDOWN_MS);

        if (shouldSendHealthAlert) {
          console.log(`[health-alert] Health ${healthPercentage}% is below threshold ${HEALTH_THRESHOLD_PERCENT}%, sending admin alert`);
          
          // Group unhealthy accounts by status
          const expiredAccounts = allActiveAccounts.filter((account: { token_expires_at: string | null; needs_reauth: boolean }) => {
            if (account.needs_reauth) return false;
            if (!account.token_expires_at) return true;
            const expiryDate = new Date(account.token_expires_at);
            return expiryDate <= now;
          });
          
          const needsReauthAccounts = allActiveAccounts.filter((account: { needs_reauth: boolean }) => account.needs_reauth);

          // Send health alert
          const healthAlertResponse = await fetch(
            `${Deno.env.get('SUPABASE_URL')}/functions/v1/send-token-failure-alert`,
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`,
              },
              body: JSON.stringify({ 
                healthAlert: {
                  healthPercentage,
                  threshold: HEALTH_THRESHOLD_PERCENT,
                  totalAccounts,
                  healthyCount,
                  expiredCount: expiredAccounts.length,
                  needsReauthCount: needsReauthAccounts.length,
                  timestamp: now.toISOString(),
                }
              }),
            }
          );

          if (healthAlertResponse.ok) {
            lastHealthAlertSentAt = now;
            console.log(`[health-alert] Admin health alert sent successfully`);
          } else {
            console.error('[health-alert] Failed to send health alert:', await healthAlertResponse.text());
          }
        }
      }
    } catch (healthCheckError) {
      console.error('[health-check] Error checking overall health:', healthCheckError);
    }

    return jsonResponse({
      message: 'Token refresh complete',
      refreshed,
      alreadyRefreshed,
      cooldown,
      failed,
      skipped,
      markedNeedsReauth,
      alertsSent: accountsToAlert.length,
      checked: allAccounts.length,
      processed: accountsNeedingRefresh.length,
      results
    });

  } catch (error: unknown) {
    console.error('Error in refresh-tokens:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    return errorResponse(message);
  }
});
