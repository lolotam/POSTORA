/**
 * Shared credential usability policy for native YouTube access tokens.
 *
 * The publish path, the resumable upload continuation path, and the scheduler's
 * contended-refresh deferral check share this rule so they never disagree on
 * whether a stored token may be sent to Google.
 */

export const YOUTUBE_CREDENTIAL_UNUSABLE_REASON =
  "youtube_upload_account_unusable" as const;

/**
 * The reason a credential may not be sent to the provider, or null when it may.
 *
 * A token is good while it is still good. An expiry in the past means the
 * provider will refuse it, and that refusal says nothing about the video, so
 * the token is not sent. A token without an expiry is not known to be good,
 * and a token that is not known to be good is not used.
 */
export function youtubeCredentialRefusalReason(
  accessToken: string | null | undefined,
  tokenExpiresAt: string | null | undefined,
  nowMs: number = Date.now(),
): typeof YOUTUBE_CREDENTIAL_UNUSABLE_REASON | null {
  if (!accessToken || !tokenExpiresAt) return YOUTUBE_CREDENTIAL_UNUSABLE_REASON;
  const expiresAt = Date.parse(tokenExpiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= nowMs) {
    return YOUTUBE_CREDENTIAL_UNUSABLE_REASON;
  }
  return null;
}
