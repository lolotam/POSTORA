/**
 * Detecting a revoked Meta publishing grant in the native publishers' own replies.
 *
 * Meta answers a revoked Page or Instagram grant with an `OAuthException` whose
 * code is 190 and whose subcode is 458. The native publishers reduce that reply
 * to a message, so the grant's death is never recorded against the account and
 * the dashboard never asks the customer to reconnect.
 *
 * The observer watches the decoded reply of the native publish requests only.
 * When Meta's structured answer proves the grant is dead, it records the
 * reconnect flag once, against the account row the publish attempt read. The
 * write is conditional on that row's identity, owner, platform, active state and
 * row version, so a row that was refreshed, reconnected or written by anybody
 * else in the meantime is left alone.
 *
 * The observer is a side effect: it never changes the publish outcome, never
 * throws into its caller and never carries the credential into the write or a
 * diagnostic.
 */

import { isPermanentMetaError, META_RETRYABLE_STATUSES, parseMetaError } from "../_shared/metaErrors.ts";

/** The message stored on the account when its publishing grant was revoked. */
export const META_PUBLISH_REAUTH_REASON = "Meta authorization was revoked. Reconnect this account.";

/** The event name of the warning a failed reconnect write emits. */
export const META_PUBLISH_REAUTH_WRITE_FAILED = "meta_publish_reauth_write_failed";

/** How long the conditional write may take before it is abandoned. */
const WRITE_TIMEOUT_MS = 5_000;

/** The platforms whose native publisher owns the grant this observer watches. */
const NATIVE_PUBLISH_PLATFORMS = new Set(["facebook", "instagram"]);

/** The account row as the publish attempt read it, with the credential it used. */
export interface MetaPublishReauthSnapshot {
  accountId: string;
  /** The owner of the post, not of the account: the write trusts the post's tenant. */
  postOwnerId: string;
  platform: string;
  /** The row version as Postgres returned it, unchanged: it fences the write. */
  updatedAt: string;
  /** The credential the request path uses. It never reaches the write. */
  accessToken: string;
}

/** Watches one decoded provider reply. It never throws and never changes an outcome. */
export type ObserveMetaReply = (status: number, reply: unknown, deadlineMs?: number) => Promise<void>;

/** The one conditional write the observer may ask for. */
export interface MetaPublishReauthWriteRequest {
  accountId: string;
  postOwnerId: string;
  platform: string;
  updatedAt: string;
  /** Bounds the write, so an unanswered storage call cannot hold the publish. */
  signal: AbortSignal;
}

export interface MetaPublishReauthWriteResult {
  /** The rows the write matched. Zero is a successful no-op, not a failure. */
  matched: number;
  /** The failure, when the write could not be completed. */
  error: string | null;
}

export type MetaPublishReauthWriter = (request: MetaPublishReauthWriteRequest) => Promise<MetaPublishReauthWriteResult>;

export interface MetaPublishReauthObserverOptions {
  /** The account row the publish attempt read, or null when there is none. */
  snapshot: MetaPublishReauthSnapshot | null | undefined;
  /** The credential the request path uses. Another one is a substitution. */
  requestToken?: string | null;
  /** The one conditional write, performed by the persistence layer. */
  write: MetaPublishReauthWriter;
  /** How long the write may take. */
  timeoutMs?: number;
  /** The worker deadline for provider work. */
  deadlineMs?: number;
}

/**
 * Whether Meta's reply is the structured proof that the grant is dead.
 *
 * The evidence is the exact tuple Meta documents: the OAuthException type, the
 * code 190 and the subcode 458 together. A rate limit, a timeout, a content
 * rejection, a generic permission error, a message that merely mentions these
 * numbers, and a reply whose numbers arrived as text are none of that proof.
 */
export function isRevokedGrantEvidence(status: number, reply: unknown): boolean {
  if (META_RETRYABLE_STATUSES.has(status)) return false;
  const parsed = parseMetaError(status, reply);
  if (parsed.transient || !isPermanentMetaError(parsed)) return false;
  if (parsed.type !== "OAuthException" || parsed.code !== 190 || parsed.error_subcode !== 458) return false;
  return !replyAsksForRetry(reply);
}

/**
 * Builds the observer for one account and one publish attempt.
 *
 * A missing row, a platform without a native publisher, a row without a version
 * or a credential, and a request that used another credential all yield an
 * observer that does nothing: there is no row to fence a write with, or the
 * failure says nothing about the row this attempt read.
 */
export function createMetaPublishReauthObserver(options: MetaPublishReauthObserverOptions): ObserveMetaReply {
  const { snapshot, requestToken, write, timeoutMs = WRITE_TIMEOUT_MS } = options;
  if (!isObservable(snapshot, requestToken)) return async () => {};
  const observed = snapshot;

  // The children of one attempt observe the same account: they share the write.
  let pending: Promise<void> | null = null;

  return async (status, reply, deadlineMs): Promise<void> => {
    try {
      if (!isRevokedGrantEvidence(status, reply)) return;
      const remainingMs = Math.min(deadlineMs ?? Infinity, options.deadlineMs ?? Infinity) - Date.now();
      if (remainingMs <= 0) return;
      pending ??= flagRevokedGrant(observed, write, Math.min(timeoutMs, remainingMs));
      await pending;
    } catch {
      // The observation is a side effect of the publish: it never changes the outcome.
      warnWriteFailed(observed);
    }
  };
}

/** Whether the snapshot can fence a write, and whether the request used its credential. */
function isObservable(
  snapshot: MetaPublishReauthSnapshot | null | undefined,
  requestToken: string | null | undefined,
): snapshot is MetaPublishReauthSnapshot {
  if (!snapshot) return false;
  if (!snapshot.accountId || !snapshot.postOwnerId) return false;
  if (!NATIVE_PUBLISH_PLATFORMS.has(snapshot.platform)) return false;
  if (!snapshot.updatedAt || !snapshot.accessToken) return false;
  return requestToken === snapshot.accessToken;
}

/** Meta's own transient flag contradicts the permanent evidence and is ignored. */
function replyAsksForRetry(reply: unknown): boolean {
  const error = (reply as { error?: { is_transient?: unknown } } | null)?.error;
  return error?.is_transient === true;
}

/** Records the reconnect flag once, within the request budget. */
async function flagRevokedGrant(
  snapshot: MetaPublishReauthSnapshot,
  write: MetaPublishReauthWriter,
  timeoutMs: number,
): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const result = await write({
      accountId: snapshot.accountId,
      postOwnerId: snapshot.postOwnerId,
      platform: snapshot.platform,
      updatedAt: snapshot.updatedAt,
      signal: controller.signal,
    });
    if (result.error) warnWriteFailed(snapshot);
  } catch {
    warnWriteFailed(snapshot);
  } finally {
    clearTimeout(timer);
  }
}

/** The warning names the account and the platform, never the credential. */
function warnWriteFailed(snapshot: MetaPublishReauthSnapshot): void {
  console.warn(META_PUBLISH_REAUTH_WRITE_FAILED, { account_id: snapshot.accountId, platform: snapshot.platform });
}
