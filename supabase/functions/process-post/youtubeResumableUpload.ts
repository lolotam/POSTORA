/**
 * The native YouTube resumable-upload protocol, as a module with no I/O of
 * its own beyond the injected `fetch`.
 *
 * WHY A MODULE AND NOT A BLOCK IN process-post/index.ts
 * ------------------------------------------------------
 * The whole point of this phase is that the upload may end in one of several
 * states that are hard to tell apart, and every one of them has a different
 * consequence for the customer: a video that exists, a video that does not
 * exist and may still be uploaded, a video that may exist but whose receipt
 * was lost, and a video that must not be uploaded again. That decision is
 * pure logic over a provider response, so it lives here where a fake provider
 * can drive every branch.
 *
 * THE PROTOCOL
 * ------------
 * Google documents the resumable upload at
 * https://developers.google.com/youtube/data/guides/using_resumable_upload_protocol
 *
 *   1. POST the video resource with `uploadType=resumable`. A 200 answer
 *      carries the session URI in its `Location` header.
 *   2. PUT the bytes to the session URI with
 *      `Content-Range: bytes FIRST-LAST/TOTAL` and
 *      `Content-Length: <bytes in this request>`. Every request but the last
 *      must carry the same chunk size, and that size must be a multiple of
 *      256 KiB.
 *   3. A `308 Resume Incomplete` answer means "keep going". Its `Range`
 *      header says how many bytes the provider holds, INCLUSIVE on both ends:
 *      `Range: bytes=0-999999` is 1,000,000 bytes. When nothing has been
 *      stored the answer carries NO `Range` header at all, which means zero.
 *   4. A `201 Created` answer carries the created video resource. Its `id` is
 *      the receipt: the only proof that the video exists.
 *   5. The status of an interrupted upload is read with an EMPTY `PUT` whose
 *      `Content-Range` names the total with an asterisk where the first byte
 *      would be. The provider then answers with the `308` of step 3, or with
 *      the very same answer it gave when it finished. That is what makes a
 *      lost final acknowledgement recoverable instead of a duplicate video.
 *
 * THE THREE CASES THAT MUST NEVER BE CONFUSED
 * -------------------------------------------
 * Once a single byte has reached the provider, the provider may hold a video
 * that Postora has no receipt for. From that moment on there are exactly three
 * honest answers, and this module never produces a fourth:
 *
 *   - definitely unsent: nothing was ever written, so no video can exist and a
 *     fresh session is safe.
 *   - safely resumable: the provider told us, in this session, how many bytes
 *     it holds. The next write continues from exactly that offset.
 *   - manual reconciliation: the provider may hold a video and cannot be
 *     asked about it any more. Uploading again could create a second video,
 *     so nothing is uploaded; a human decides.
 *
 * WHAT NEVER HAPPENS HERE
 * -----------------------
 * The session URI is a credential: it authorises writes to the upload. It is
 * never logged, never put in an error message, never returned to a client and
 * never written to a user-readable row. `redactResumableSessionUri` is the one
 * way it may be printed, and it keeps only the origin and the path.
 *
 * The provider host is checked before every write, and redirects are never
 * followed: a `Location` that points anywhere else is refused rather than
 * followed with the OAuth token attached.
 */

import { uploadFailureMessage } from "./youtubePublisher.ts";
import {
  redactProviderText,
  YOUTUBE_UPLOAD_REASON,
  type YoutubeUploadReason,
} from "./youtubeUploadPolicy.ts";

export { redactResumableCredentials } from "./youtubeUploadPolicy.ts";

/** Google's rule: a chunk size must be a multiple of 256 KiB (the last chunk excepted). */
export const YOUTUBE_CHUNK_GRANULARITY_BYTES = 256 * 1024;

/** The chunk size Postora sends. A multiple of 256 KiB, and small enough to survive a worker. */
export const YOUTUBE_RESUMABLE_CHUNK_BYTES = 8 * 1024 * 1024;

/**
 * The hosts a resumable session may live on.
 *
 * The session URI comes from the provider, so it is an input, not a constant.
 * It is checked against this list before every byte is written, because the
 * URI carries the authority to write the upload.
 */
export const YOUTUBE_PROVIDER_UPLOAD_HOSTS = ["www.googleapis.com"] as const;

/** How long one provider request may take. */
export const YOUTUBE_PROVIDER_REQUEST_TIMEOUT_MS = 60_000;

/** How many status probes one ambiguous write may cost before the upload is left for a human. */
export const YOUTUBE_MAX_PROBE_ATTEMPTS = 3;

/** The backoff between two probes of the same ambiguous write. */
export const YOUTUBE_PROBE_BACKOFF_MS = 1_000;

/**
 * How long the reconciler waits before it looks at a session again.
 *
 * A transient probe failure must not turn into a manual reconciliation, and it
 * must not turn into a tight loop either. This is the floor of the wait.
 */
export const YOUTUBE_CONTINUATION_MIN_DELAY_MS = 60_000;

/**
 * The ceiling of the wait between two continuation attempts.
 *
 * The wait grows with the number of attempts so a provider that is down for a
 * while is not hammered, but it never grows past this, so a session cannot sit
 * in the database forever without anybody looking at it.
 */
export const YOUTUBE_CONTINUATION_MAX_DELAY_MS = 15 * 60_000;

/** A YouTube video id is 11 characters of the URL-safe alphabet. */
const YOUTUBE_VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

/** A byte range as the provider states it: both ends inclusive, zero based. */
export interface ProviderByteRange {
  start: number;
  end: number;
}

/** One planned write to the provider. */
export interface UploadChunk {
  /** The first byte of the chunk, zero based. */
  start: number;
  /** The last byte of the chunk, zero based and INCLUSIVE. */
  end: number;
  /** How many bytes the chunk carries. */
  size: number;
}

/** What a provider answer to a chunk write or a status probe means. */
export type ProviderUploadStatus =
  /** The provider created the video. The id is the receipt. */
  | { kind: "accepted"; videoId: string }
  /** The upload continues. The provider holds exactly `confirmedBytes` bytes. */
  | { kind: "resumable"; confirmedBytes: number }
  /** The session is gone. Whether a video exists is unknown. */
  | { kind: "expired" }
  /** The provider refused the request outright. Nothing was stored. */
  | { kind: "rejected"; status: number; message: string }
  /**
   * The answer does not say what happened. Either the provider is unhealthy,
   * or it answered something this protocol does not allow. The upload may or
   * may not exist, so nothing more may be written.
   *
   * `retryable` splits the two cases that matter:
   *
   *   - `true` means the provider did not answer usefully but nothing is
   *     broken: a timeout, a 5xx, a 429. The same session can be asked again
   *     later, so the upload stays alive.
   *   - `false` means the provider answered something the protocol does not
   *     allow, or contradicted what it said before. The session can no longer
   *     be trusted, so a human decides.
   */
  | { kind: "unknown"; reason: string; retryable: boolean; retryAfterMs?: number };

/** What the whole upload attempt ended as. */
export type ResumableUploadOutcome =
  /** The video exists and this is its id. */
  | { kind: "completed"; videoId: string }
  /**
   * The upload can continue later, in this session, from `confirmedBytes`.
   *
   * `nextCheckAtMs` says when the continuation may look again. It is bounded
   * and it is never in the past, so a provider that is down does not turn
   * into a loop.
   */
  | { kind: "resumable"; confirmedBytes: number; reason: YoutubeUploadReason; nextCheckAtMs?: number }
  /** Nothing was ever written, so no video exists and a fresh attempt is safe. */
  | { kind: "unsent"; reason: YoutubeUploadReason; detail?: string }
  /** The provider may hold a video nobody has a receipt for. A human decides. */
  | { kind: "reconcile"; reason: YoutubeUploadReason; detail?: string }
  /** The upload failed for good. `retryable` says whether a fresh attempt is safe. */
  | { kind: "failed"; reason: YoutubeUploadReason; detail?: string; retryable: boolean }
  /** Another worker owns the session. This worker must not write anything. */
  | { kind: "abandoned"; reason: YoutubeUploadReason; detail?: string };

/** The durable state of one upload, as the store keeps it. */
export interface YoutubeUploadSessionRecord {
  id: string;
  /** The post this upload belongs to. */
  postId: string;
  /** The YouTube account this upload goes to. */
  socialAccountId: string;
  state: "open" | "uploaded" | "expired" | "reconcile" | "failed";
  /** The session URI. A credential: never log it, never show it to a client. */
  sessionUri: string | null;
  /** How many bytes the provider has CONFIRMED. */
  confirmedBytes: number;
  /** The highest byte offset that was ever written. Zero means nothing was written. */
  bytesSent: number;
  /**
   * Whether the provider may already have turned this upload into a video.
   *
   * It becomes true the moment the LAST chunk is written, because that is
   * the write that creates the video, and it is only cleared by the provider
   * saying the upload is still incomplete. While it is true, nothing is
   * written again: a second video on the customer's channel is worse than a
   * post that needs a human.
   */
  videoMayExist: boolean;
  totalBytes: number;
  /** The receipt. Present only once the provider accepted the video. */
  videoId: string | null;
  sessionExpiresAt: string | null;
  /**
   * The post attempt this session belongs to.
   *
   * A post can be published again after an edit or a retry, and that is a new
   * attempt with a new `processing_started_at`. An upload that belongs to an
   * older attempt must not be continued: its bytes describe a video the user
   * may have changed.
   */
  attemptStartedAt: string | null;
  /**
   * When the continuation may look at this session again.
   *
   * `null` means "now". A value in the past means the session is due.
   */
  nextCheckAt: string | null;
  /** The stable reason code of the last attempt. */
  lastOutcome: string | null;
  /** The `platform_posts` row this upload settles when it finishes. */
  platformPostId: string | null;
  /** The media file the bytes come from. */
  mediaFileId: string | null;
  /**
   * The media file's content version when the upload started.
   *
   * A replaced file is a different video, so a continuation refuses to send
   * the bytes of a file that is no longer the one the upload began with.
   */
  mediaObjectVersion: number | null;
  /**
   * How many continuations this session has had.
   *
   * It bounds the work: a session that keeps failing is not asked for ever.
   */
  continuationCount: number;
  /**
   * The video resource that was sent to the provider.
   *
   * It is kept so a worker that has to OPEN the provider session sends the
   * same resource the publish would have sent. A session that was admitted
   * but never opened one has no bytes and no receipt, so opening it is safe.
   */
  uploadBody: Record<string, unknown>;
  /**
   * The platform this session writes to.
   *
   * It is kept so a later worker knows the session belongs to a YouTube
   * upload and not to something else.
   */
  resolvedPlatform: string | null;
  /**
   * The accounts the run was allowed to publish to, resolved under the post
   * claim.
   *
   * The upload may only be carried on to one of them. It is kept because the
   * post's own stored selection does not always name the account: a run may
   * have been given an explicit account, and that account is still a target
   * of that run.
   */
  targetAccountIds: string[];
}

/**
 * Why the store refused.
 *
 * The codes are the contract between the store and the upload: the upload
 * branches on them, and the customer only ever sees the message they are
 * turned into. A refusal is never parsed out of an error message.
 */
export type YoutubeUploadRefusal =
  /** The post is not the caller's, or is not there. */
  | "post_not_found"
  /** The account is not the caller's, or is not usable. */
  | "account_not_usable"
  /** The media file is not the caller's. */
  | "media_not_owned"
  /** The post was edited while the upload was in flight. */
  | "content_changed"
  /** The provider may hold a video nobody has a receipt for. */
  | "reconcile_required"
  /** The provider session is gone. */
  | "session_expired"
  /** Another worker owns the session. */
  | "lease_held"
  /** The session is not there. */
  | "session_not_found"
  /** The lease is stale, so this worker does not own the session. */
  | "lease_stale"
  /** The video has no usable size. */
  | "invalid_size"
  /** The session belongs to an older attempt of the post. */
  | "stale_attempt"
  /** The post was cancelled or superseded. */
  | "post_superseded"
  /** The session has been continued too many times. */
  | "too_many_continuations"
  /** The session has no public row to settle. */
  | "no_public_row"
  /** The account is not a target of this post any more. */
  | "target_not_authorized";

/** The durable store the upload keeps its state in. */
export interface YoutubeUploadSessionStore {
  /**
   * Admits the upload: the private session and the public pending row are
   * created together, before any provider work.
   *
   * `refused` explains a refusal; the caller must not write anything when it
   * is set. `platformPostId` is the public row the upload settles when it
   * finishes.
   */
  admit(input: AdmitUploadSession): Promise<{
    record: YoutubeUploadSessionRecord | null;
    refused: YoutubeUploadRefusal | null;
    platformPostId: string | null;
  }>;
  /** Takes the session for one worker. `refused` is set when another worker owns it. */
  claim(input: ClaimUploadSession): Promise<{ record: YoutubeUploadSessionRecord | null; refused: YoutubeUploadRefusal | null }>;
  /** Records confirmed progress and, when the session was just opened, the session URI. */
  checkpoint(input: CheckpointUploadSession): Promise<boolean>;
  /** Records the receipt. The receipt is kept: it is what stops a duplicate video. */
  complete(input: CompleteUploadSession): Promise<boolean>;
  /**
   * Records the terminal outcome: the public row and the parent rollup are
   * settled together, fenced to the worker that still owns the session.
   *
   * A worker that lost its lease settles nothing, and the refusal says so.
   */
  settle(input: SettleUploadSession): Promise<{ settled: boolean; refused: YoutubeUploadRefusal | null }>;
  /**
   * Projects a stored receipt onto the public row.
   *
   * No provider is contacted and no media is read: the video already exists.
   * This is what recovers an acknowledgement that was lost after the
   * database had already stored the receipt.
   */
  projectReceipt(input: ProjectUploadReceipt): Promise<{
    settled: boolean;
    refused: YoutubeUploadRefusal | null;
    videoId: string | null;
  }>;
  /** Records a terminal state that is not a receipt. */
  release(input: ReleaseUploadSession): Promise<boolean>;
  /**
   * Whether the worker that holds the lease may write to the provider NOW.
   *
   * A lease says the worker owns the session. It does not say the world is
   * still the way the worker saw it, so the authority is checked against the
   * live state: the attempt, the post status, the content fence, the target
   * and the media.
   *
   * The reason is returned rather than thrown, because the caller has to
   * decide: a stale attempt is a refusal, and a media file that is still
   * being scanned is a wait.
   */
  effectAuthority(input: EffectAuthorityUploadSession): Promise<{
    authorized: boolean;
    reason: string | null;
  }>;
  /**
   * Closes the post fanout for an upload whose worker died between the
   * admission and the closure.
   *
   * It only closes when the attempt's scope is COMPLETE. When a destination
   * never started, it records an explicit terminal state instead and re-runs
   * nothing.
   */
  recoverFanout(input: RecoverFanoutUploadSession): Promise<{
    recovered: boolean;
    reason: string | null;
  }>;
  /**
   * The sessions that are due for another look, with their claim tokens.
   *
   * The claim is what makes two reconcilers pick different sessions, and the
   * token is what proves to the worker that this particular claim is the one
   * it may act on. The session URI is NOT returned: it stays in the database
   * and is read by the worker with the token.
   */
  claimContinuations(input: ClaimContinuations): Promise<YoutubeUploadContinuationClaim[]>;
}

/** The check that runs immediately before the provider is written to. */
export interface EffectAuthorityUploadSession {
  sessionId: string;
  leaseToken: string;
}

/**
 * The fanout closure for an upload whose worker died between the admission
 * and the closure.
 *
 * The lease is optional on purpose: the closure is derived from the DATABASE,
 * not from what the caller remembers, and it runs after the settlement that
 * released the lease. A caller that still holds a lease may pass it, and the
 * store uses it only to prove that the caller is the owner.
 */
export interface RecoverFanoutUploadSession {
  sessionId: string;
  leaseToken?: string | null;
}

/**
 * The stable reason for a refused write.
 *
 * The codes are the ones the database answers with, so the customer sees the
 * same sentence whether the refusal came from the store or from the policy.
 */
export function effectAuthorityReason(reason: string | null | undefined): YoutubeUploadReason {
  switch (reason) {
    case "lease_stale":
      return YOUTUBE_UPLOAD_REASON.lease_conflict;
    case "stale_attempt":
      return YOUTUBE_UPLOAD_REASON.stale_attempt;
    case "post_not_processing":
    case "content_changed":
      return YOUTUBE_UPLOAD_REASON.superseded;
    case "target_not_authorized":
      return YOUTUBE_UPLOAD_REASON.account_unusable;
    case "media_missing":
    case "media_changed":
    case "media_rejected":
      return YOUTUBE_UPLOAD_REASON.media_unavailable;
    case "media_pending":
      // The scan will finish on its own, so the upload waits rather than
      // failing: the same sentence the resumable outcome already uses.
      return YOUTUBE_UPLOAD_REASON.resumable;
    default:
      return YOUTUBE_UPLOAD_REASON.unknown;
  }
}

export interface AdmitUploadSession {
  postId: string;
  socialAccountId: string;
  mediaFileId: string | null;
  mediaObjectVersion: number | null;
  mediaSize: number;
  totalBytes: number;
  /** The video resource that was sent to the provider. */
  uploadBody: Record<string, unknown>;
  /**
   * The post content the caller built the upload body from.
   *
   * It is compared with the LIVE post under the post's lock, so a body that
   * was built from a stale read is refused instead of being blessed. It is
   * null when the caller has no snapshot to offer.
   */
  expectedContent: Record<string, unknown> | null;
  userId: string;
  /**
   * The post attempt this upload belongs to.
   *
   * A continuation of an older attempt is refused: the post was edited or
   * retried, and the bytes of that attempt are not what the user asked for
   * now.
   */
  attemptStartedAt: string | null;
  /**
   * The accounts the run was allowed to publish to, resolved under the post
   * claim.
   *
   * The upload may only be carried on to one of them, so a later worker can
   * tell an account that was really targeted from one that merely belongs to
   * the customer.
   */
  targetAccountIds: string[];
}

/**
 * The terminal outcome of one upload.
 *
 * It is fenced to the worker that still owns the session: a worker that lost
 * its lease settles nothing, because the worker that took over may already
 * have written the video.
 */
export interface SettleUploadSession {
  sessionId: string;
  leaseToken: string;
  status: "success" | "failed";
  /** The receipt. Required for a success. */
  videoId?: string | null;
  errorMessage?: string | null;
  responseData?: Record<string, unknown>;
}

/** The projection of a receipt that is already stored. */
export interface ProjectUploadReceipt {
  sessionId: string;
}

export interface ClaimUploadSession {
  sessionId: string;
  leaseToken: string;
  leaseMs: number;
}

/** One session the reconciler may hand to a worker. */
export interface YoutubeUploadContinuationClaim {
  sessionId: string;
  postId: string;
  socialAccountId: string;
  userId: string;
  /** The claim token. The worker proves ownership with it. */
  leaseToken: string;
  /** The post attempt this session belongs to. */
  attemptStartedAt: string | null;
  platformPostId: string | null;
  mediaFileId: string | null;
  confirmedBytes: number;
  totalBytes: number;
  videoMayExist: boolean;
  state: string;
  continuationCount: number;
}

export interface ClaimContinuations {
  limit: number;
  leaseMs: number;
}

export interface CheckpointUploadSession {
  sessionId: string;
  leaseToken: string;
  confirmedBytes: number;
  bytesSent: number;
  /** Set only when the session URI was just issued. */
  sessionUri?: string | null;
  /**
   * Set only when the state of the video itself changed.
   *
   * It is set to true before the last chunk is written, and it is cleared
   * only when the provider says the upload is still incomplete.
   */
  videoMayExist?: boolean;
  /**
   * When the continuation may look at this session again.
   *
   * `null` clears it, which makes the session due right away.
   */
  nextCheckAt?: string | null;
  /** The stable reason code of this attempt. */
  lastOutcome?: string | null;
}

export interface CompleteUploadSession {
  sessionId: string;
  leaseToken: string;
  videoId: string;
}

export interface ReleaseUploadSession {
  sessionId: string;
  leaseToken: string;
  state: "expired" | "reconcile" | "failed";
  error?: string | null;
}

/** The bytes of the video, read a range at a time. */
export interface UploadByteSource {
  readonly size: number;
  /**
   * The bytes `start`..`end`, both inclusive.
   *
   * An `ArrayBuffer` rather than a view into one: the buffer is exactly the
   * range, so it can be handed to the provider as the request body without
   * a copy and without the risk of sending bytes that were not asked for.
   *
   * `timeoutMs` clips the read to what is left of the worker's budget, so a
   * slow media host cannot hold a worker past its deadline.
   */
  read(start: number, end: number, timeoutMs?: number): Promise<ArrayBuffer>;
}

/** Everything the upload needs from the outside world. */
export interface ResumableUploadDeps {
  fetchImpl: typeof fetch;
  store: YoutubeUploadSessionStore;
  session: YoutubeUploadSessionRecord;
  leaseToken: string;
  accessToken: string;
  /**
   * Where the video bytes come from.
   *
   * It is optional on purpose: a session that already carries a receipt is
   * settled without reading a single byte of media, so a receipt-only
   * recovery never refetches the video.
   */
  source?: UploadByteSource;
  totalBytes: number;
  mimeType: string;
  /** The last moment this worker may still write. */
  deadlineMs: number;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** The hosts a session may live on. Defaults to Google's upload host. */
  allowedHosts?: readonly string[];
  /** The chunk size. Defaults to {@link YOUTUBE_RESUMABLE_CHUNK_BYTES}. */
  chunkBytes?: number;
  /** The endpoint that opens a resumable session. */
  uploadUrl: string;
  /** The video resource the provider is asked to create. */
  uploadBody: Record<string, unknown>;
  /**
   * Whether this worker may write to the provider NOW.
   *
   * It is asked before the provider session is opened and before every chunk
   * that is written. A lease says the worker owns the session; it does not say
   * the post, the content, the target or the media are still what the worker
   * saw when it took the lease.
   *
   * It is NOT optional. A write that cannot prove it was allowed is not made,
   * so a caller that leaves this out has no way to publish at all.
   */
  effectAuthority: () => Promise<{ authorized: boolean; reason: string | null }>;
}

/** A provider answer, reduced to what the protocol needs. */
export interface ProviderStatusInput {
  status: number;
  /** The `Range` header of a 308. Absent means the provider holds no bytes. */
  rangeHeader: string | null;
  /** The body of a 2xx answer, which carries the created video resource. */
  bodyText: string;
  totalBytes: number;
  /** The offset already confirmed, so a provider that goes backwards is caught. */
  previousConfirmedBytes: number;
  /**
   * The `Retry-After` header of an answer that asked for patience.
   *
   * It is honoured so a provider that says "wait 120 seconds" is not asked
   * again in five, and it is bounded so a provider cannot park an upload for
   * a week.
   */
  retryAfterHeader?: string | null;
}

/**
 * Whether a string is a YouTube video id.
 *
 * A receipt is only a receipt if it identifies a video. An answer that claims
 * success without a usable id is NOT a success: the video may exist, so the
 * upload must not be repeated.
 */
export function isValidYoutubeVideoId(value: unknown): value is string {
  return typeof value === "string" && YOUTUBE_VIDEO_ID_PATTERN.test(value);
}

/**
 * The number of bytes the provider holds, from the `Range` header of a 308.
 *
 * The header is inclusive on both ends and zero based, so `bytes=0-999999` is
 * 1,000,000 bytes. A 308 with NO `Range` header means the provider holds
 * nothing: zero. Anything that is not that shape is refused, because a
 * half-read range is a wrong resume point and a wrong resume point uploads
 * the wrong bytes.
 */
export function parseProviderRange(rangeHeader: string | null | undefined): number | null {
  if (rangeHeader === null || rangeHeader === undefined) return 0;
  const trimmed = rangeHeader.trim();
  if (trimmed === "") return null;
  const match = /^bytes=(\d+)-(\d+)$/.exec(trimmed);
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return null;
  if (start !== 0 || end < start || !Number.isSafeInteger(end + 1)) return null;
  return end + 1;
}

/**
 * The `Content-Range` of a request: `bytes FIRST-LAST/TOTAL`.
 *
 * The provider refuses a block that is not continuous, so the two ends must
 * describe one continuous run and the last byte must be inside the file.
 */
export function parseContentRange(value: string | null | undefined): (ProviderByteRange & { total: number }) | null {
  if (typeof value !== "string") return null;
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+)$/.exec(value.trim());
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = Number(match[3]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || !Number.isSafeInteger(total)) return null;
  if (start < 0 || end < start || total <= 0 || end >= total) return null;
  return { start, end, total };
}

/**
 * Whether a session URI may be written to.
 *
 * The URI is an input from the provider, and it carries the authority to write
 * the upload. It must be HTTPS, and it must live on a host that was reviewed
 * for this purpose. Anything else is refused: a `Location` that points at
 * another host would carry the OAuth token to it.
 */
export function isAllowedProviderUploadUri(
  sessionUri: string | null | undefined,
  allowedHosts: readonly string[] = YOUTUBE_PROVIDER_UPLOAD_HOSTS,
): boolean {
  if (!sessionUri) return false;
  let url: URL;
  try {
    url = new URL(sessionUri);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  if (url.username !== "" || url.password !== "") return false;
  const host = url.hostname.toLowerCase();
  return allowedHosts.some((allowed) => host === allowed.toLowerCase());
}

/**
 * The block to write next, starting at the offset the provider confirmed.
 *
 * Google's rule is that every request but the last carries the same chunk
 * size, and that this size is a multiple of 256 KiB. The last block may be
 * smaller. The START of a block is whatever offset the provider confirmed,
 * which after a partial acknowledgement is not a multiple of the chunk size:
 * the block then continues from inside the chunk that was written before.
 *
 * `null` means the offset cannot be used: it is outside the file, or the
 * chunk size is not one the provider accepts.
 */
export function planChunkFrom(
  offset: number,
  totalBytes: number,
  chunkBytes: number = YOUTUBE_RESUMABLE_CHUNK_BYTES,
): UploadChunk | null {
  if (!Number.isSafeInteger(totalBytes) || totalBytes <= 0) return null;
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes <= 0) return null;
  if (chunkBytes % YOUTUBE_CHUNK_GRANULARITY_BYTES !== 0) return null;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset >= totalBytes) return null;
  const size = Math.min(chunkBytes, totalBytes - offset);
  return { start: offset, end: offset + size - 1, size };
}

/**
 * Reads the video id out of a 2xx answer body.
 *
 * The body is the created video resource. Only the `id` is used, and only
 * when it is a usable video id.
 */
export function readVideoIdFromBody(bodyText: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const id = (parsed as { id?: unknown }).id;
  return isValidYoutubeVideoId(id) ? id : null;
}

/**
 * Reads a `Retry-After` header into milliseconds.
 *
 * Both shapes are accepted: a number of seconds and an HTTP date. A value
 * that cannot be read is ignored, and every value is bounded, so a provider
 * cannot park an upload for an unbounded time.
 */
export function parseRetryAfterMs(header: string | null | undefined, nowMs: number): number | undefined {
  if (typeof header !== "string") return undefined;
  const trimmed = header.trim();
  if (trimmed.length === 0) return undefined;

  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
    return Math.min(seconds * 1000, YOUTUBE_CONTINUATION_MAX_DELAY_MS);
  }

  const asDate = Date.parse(trimmed);
  if (Number.isNaN(asDate)) return undefined;
  const delta = asDate - nowMs;
  if (delta <= 0) return undefined;
  return Math.min(delta, YOUTUBE_CONTINUATION_MAX_DELAY_MS);
}

/**
 * What one provider answer means.
 *
 * The classification is deliberately strict. An answer that does not fit the
 * protocol is `unknown`, never `accepted` and never `resumable`: the video
 * may exist, and a video that may exist is never uploaded again.
 */
export function classifyProviderStatus(input: ProviderStatusInput): ProviderUploadStatus {
  const { status, totalBytes } = input;
  const retryAfterMs = parseRetryAfterMs(input.retryAfterHeader, Date.now());

  if (status >= 200 && status < 300) {
    const videoId = readVideoIdFromBody(input.bodyText);
    if (videoId) return { kind: "accepted", videoId };
    // The provider says it is done but names no video. The video may exist,
    // and the session cannot be trusted again, so this is not retryable.
    return {
      kind: "unknown",
      reason: "The provider accepted the upload without a usable video id.",
      retryable: false,
    };
  }

  if (status === 308) {
    const confirmed = parseProviderRange(input.rangeHeader);
    if (confirmed === null) {
      return {
        kind: "unknown",
        reason: "The provider sent a range this upload cannot parse.",
        retryable: false,
      };
    }
    if (confirmed > totalBytes) {
      return {
        kind: "unknown",
        reason: "The provider reported more bytes than the video has.",
        retryable: false,
      };
    }
    if (confirmed < input.previousConfirmedBytes) {
      // The provider now holds fewer bytes than it confirmed earlier. One of
      // the two records is wrong, and a resume from either could write a
      // block the provider will refuse. Nothing more is written.
      return {
        kind: "unknown",
        reason: "The provider reported fewer bytes than were already confirmed.",
        retryable: false,
      };
    }
    return { kind: "resumable", confirmedBytes: confirmed };
  }

  if (status === 404) {
    // The session URI is gone. Whether the upload became a video is unknown.
    return { kind: "expired" };
  }

  if (status === 408 || status === 429) {
    // The provider asked for patience or gave up on the request. Whether it
    // stored anything is not stated, so the status is asked for instead.
    return { kind: "unknown", reason: `The provider answered ${status}.`, retryable: true, retryAfterMs };
  }

  if (status >= 500) {
    return { kind: "unknown", reason: `The provider answered ${status}.`, retryable: true, retryAfterMs };
  }

  if (status >= 400) {
    return { kind: "rejected", status, message: "The provider refused the upload." };
  }

  return { kind: "unknown", reason: `The provider answered ${status}.`, retryable: false };
}

/**
 * Reads the provider's answer body without letting a broken body hide the
 * status code.
 */
async function readBodyText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

/**
 * The provider's answer to one write or one status probe, reduced to the
 * protocol's vocabulary.
 */
async function readProviderStatus(
  response: Response,
  totalBytes: number,
  previousConfirmedBytes: number,
  submittedBytes: number,
): Promise<ProviderUploadStatus> {
  const bodyText = response.status >= 200 && response.status < 300 ? await readBodyText(response) : "";
  const answer = classifyProviderStatus({
    status: response.status,
    rangeHeader: response.headers.get("range"),
    bodyText,
    totalBytes,
    previousConfirmedBytes,
    retryAfterHeader: response.headers.get("retry-after"),
  });
  if (answer.kind === "resumable" && answer.confirmedBytes > submittedBytes) {
    return ambiguousWrite("The provider confirmed more bytes than were submitted.", false);
  }
  return answer;
}

/**
 * A provider request that never answered.
 *
 * The request may or may not have been stored, so this is an ambiguous write
 * and the status has to be asked for. It is retryable: nothing about the
 * session is broken, the provider simply did not answer.
 */
function ambiguousWrite(reason: string, retryable = true): ProviderUploadStatus {
  return { kind: "unknown", reason, retryable };
}

/**
 * Runs one native YouTube upload to a conclusion.
 *
 * The function never opens a session by itself: the store owns that decision,
 * because only the durable record can say whether bytes were ever written and
 * whether a receipt already exists. What this owns is the writing: the chunk
 * plan, the status probe after an ambiguous write, and the refusal to write
 * again once the provider may hold a video.
 */
/**
 * Everything one upload needs to talk to the provider and to its session.
 *
 * One context is passed around instead of a long list of arguments, because
 * the same dozen values are needed by the writer, by the status probe and by
 * the decision table, and a list that long is a sign the work is not split
 * well enough.
 */
interface UploadContext {
  fetchImpl: typeof fetch;
  store: YoutubeUploadSessionStore;
  sessionId: string;
  leaseToken: string;
  sessionUri: string;
  accessToken: string;
  mimeType: string;
  totalBytes: number;
  deadlineMs: number;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

/**
 * What one provider answer means for the upload.
 *
 * Either the upload continues from a confirmed offset, or it ends. There is
 * no third thing: an answer that says nothing usable ends the upload.
 */
type AnswerResolution =
  | { kind: "offset"; confirmedBytes: number; videoMayExist: boolean }
  | { kind: "outcome"; outcome: ResumableUploadOutcome };

/**
 * The outcomes that end an upload for good.
 *
 * They are the ones that carry a reason code and a detail, and they are the
 * ones a session can be released into.
 */
export type TerminalUploadOutcome =
  | { kind: "unsent"; reason: YoutubeUploadReason; detail?: string }
  | { kind: "reconcile"; reason: YoutubeUploadReason; detail?: string }
  | { kind: "failed"; reason: YoutubeUploadReason; detail?: string; retryable: boolean };

/**
 * Ends the upload and keeps the session in the state the reason implies.
 *
 * `expired` means the provider session is gone and no video can exist, so a
 * fresh attempt is safe. `failed` means the provider will not take the bytes
 * and no video exists either. `reconcile` means the provider may already have
 * made a video and only a human may decide.
 */
async function giveUp(
  context: UploadContext,
  release: { state: "expired" | "reconcile" | "failed" },
  outcome: TerminalUploadOutcome,
): Promise<ResumableUploadOutcome> {
  const released = await context.store.release({
    sessionId: context.sessionId,
    leaseToken: context.leaseToken,
    state: release.state,
    // The stored error is the stable reason code plus a redacted detail. The
    // provider text is kept because it is what a human needs, and it is
    // redacted because a provider body can echo the session URI.
    error: outcome.detail ? `${outcome.reason}: ${redactProviderText(outcome.detail)}` : outcome.reason,
  });
  if (!released) return { kind: "abandoned", reason: YOUTUBE_UPLOAD_REASON.lease_conflict };
  return outcome;
}

/**
 * Keeps the session open and says when it may be looked at again.
 *
 * Every place that stops an upload early does the same thing: the session
 * stays open, the durable record says when the next look happens, and the
 * caller is told the upload continues. Only the confirmed offset and the
 * wait differ, so only those two are passed in.
 */
async function scheduleAnotherLook(
  context: UploadContext,
  confirmedBytes: number,
  bytesSent: number,
  videoMayExist: boolean,
  nextCheckAtMs: number,
): Promise<ResumableUploadOutcome> {
  const scheduled = await context.store.checkpoint({
    sessionId: context.sessionId,
    leaseToken: context.leaseToken,
    confirmedBytes,
    bytesSent,
    videoMayExist,
    nextCheckAt: new Date(nextCheckAtMs).toISOString(),
    lastOutcome: YOUTUBE_UPLOAD_REASON.resumable,
  });
  if (!scheduled) return { kind: "abandoned", reason: YOUTUBE_UPLOAD_REASON.lease_conflict };
  return {
    kind: "resumable",
    confirmedBytes,
    reason: YOUTUBE_UPLOAD_REASON.resumable,
    nextCheckAtMs,
  };
}

/**
 * Keeps the receipt. It is the only proof that the video exists, and it is
 * what stops a second video.
 */
async function keepReceipt(
  context: UploadContext,
  videoId: string,
): Promise<ResumableUploadOutcome> {
  const completed = await context.store.complete({
    sessionId: context.sessionId,
    leaseToken: context.leaseToken,
    videoId,
  });
  if (!completed) {
    // The receipt could not be stored, so the next worker asks the provider
    // again and finds the same receipt. Nothing is uploaded twice.
    return {
      kind: "abandoned",
      reason: YOUTUBE_UPLOAD_REASON.lease_conflict,
      detail: "The receipt could not be stored.",
    };
  }
  return { kind: "completed", videoId };
}

/**
 * Reads one provider answer, and the status that follows it when the answer
 * does not say what happened.
 *
 * The answer decides one of three things: the video exists (there is a
 * receipt), the upload continues from an offset the provider confirmed, or
 * the upload ends. An answer that moved the offset forward is trusted; any
 * other answer is put to the provider with a status request, because a write
 * that went unanswered may or may not have been stored.
 */
async function resolveProviderAnswer(
  context: UploadContext,
  status: ProviderUploadStatus,
  offset: number,
  videoMayExist: boolean,
  submittedBytes: number,
): Promise<AnswerResolution> {
  if (status.kind === "accepted") {
    return { kind: "outcome", outcome: await keepReceipt(context, status.videoId) };
  }

  if (status.kind === "rejected") {
    // A permanent refusal stores nothing, so no video exists -- unless the
    // last chunk may already have been written, which the durable flag says.
    const outcome = await giveUp(
      context,
      { state: videoMayExist ? "reconcile" : "failed" },
      videoMayExist
        ? { kind: "reconcile", reason: YOUTUBE_UPLOAD_REASON.reconcile, detail: status.message }
        : { kind: "failed", reason: YOUTUBE_UPLOAD_REASON.rejected, detail: status.message, retryable: false },
    );
    return { kind: "outcome", outcome };
  }

  if (status.kind === "expired") {
    // The provider session is gone. Whether it turned the bytes into a video
    // depends on whether the last chunk was ever written: the flag says so,
    // and it is durable, so a worker that died mid-write is covered too.
    const detail = videoMayExist
      ? "The session expired after the last chunk may have been written."
      : "The session expired before the last chunk was written.";
    const outcome = await giveUp(
      context,
      { state: videoMayExist ? "reconcile" : "expired" },
      videoMayExist
        ? { kind: "reconcile", reason: YOUTUBE_UPLOAD_REASON.expired, detail }
        : { kind: "unsent", reason: YOUTUBE_UPLOAD_REASON.unsent, detail },
    );
    return { kind: "outcome", outcome };
  }

  if (status.kind === "resumable" && status.confirmedBytes > offset) {
    return { kind: "offset", confirmedBytes: status.confirmedBytes, videoMayExist };
  }

  // The answer either left the offset where it was or did not answer at all.
  // The status is asked for, because a write that went unanswered may or may
  // not have been stored.
  const probed = status.kind === "unknown" && (!status.retryable || status.retryAfterMs !== undefined)
    ? status
    : await probeStatus(context, offset, submittedBytes);

  if (probed.kind === "accepted") {
    // The provider had already finished the upload. This is the lost final
    // acknowledgement, and the receipt is still there to be read.
    return { kind: "outcome", outcome: await keepReceipt(context, probed.videoId) };
  }

  if (probed.kind === "rejected") {
    const outcome = await giveUp(
      context,
      { state: videoMayExist ? "reconcile" : "failed" },
      videoMayExist
        ? { kind: "reconcile", reason: YOUTUBE_UPLOAD_REASON.reconcile, detail: probed.message }
        : { kind: "failed", reason: YOUTUBE_UPLOAD_REASON.rejected, detail: probed.message, retryable: false },
    );
    return { kind: "outcome", outcome };
  }

  if (probed.kind === "expired") {
    const detail = videoMayExist
      ? "The session expired while the write was unconfirmed."
      : "The session expired before the last chunk was written.";
    const outcome = await giveUp(
      context,
      { state: videoMayExist ? "reconcile" : "expired" },
      videoMayExist
        ? { kind: "reconcile", reason: YOUTUBE_UPLOAD_REASON.expired, detail }
        : { kind: "unsent", reason: YOUTUBE_UPLOAD_REASON.unsent, detail },
    );
    return { kind: "outcome", outcome };
  }

  if (probed.kind === "resumable") {
    return { kind: "offset", confirmedBytes: probed.confirmedBytes, videoMayExist };
  }

  if (probed.retryable) {
    // The provider is not talking, but nothing is broken: a timeout, a 5xx, a
    // 429. The session is still good, so the SAME URI is asked again later.
    // Nothing is written now, and no new session is opened: an upload that
    // may have been accepted must never be started again from zero.
    return {
      kind: "outcome",
      outcome: {
        kind: "resumable",
        confirmedBytes: offset,
        reason: YOUTUBE_UPLOAD_REASON.resumable,
        nextCheckAtMs: probed.retryAfterMs,
      },
    };
  }

  // The provider answered something the protocol does not allow, or
  // contradicted what it said before. When the last chunk may already have
  // been written, a blind retry could write the same bytes into a video that
  // already exists, so a human decides. When it may not have been, no video
  // exists and the upload can be started again.
  const outcome = await giveUp(
    context,
    { state: videoMayExist ? "reconcile" : "failed" },
    videoMayExist
      ? { kind: "reconcile", reason: YOUTUBE_UPLOAD_REASON.reconcile, detail: probed.reason }
      : { kind: "failed", reason: YOUTUBE_UPLOAD_REASON.unknown, detail: probed.reason, retryable: false },
  );
  return { kind: "outcome", outcome };
}

/**
 * The wait before the continuation looks at a session again.
 *
 * The wait grows with the number of attempts and is bounded at both ends: a
 * provider that is down is not hammered, and a session does not sit in the
 * database forever without anybody looking at it. A `Retry-After` the provider
 * asked for is honoured, but never shorter than the floor and never longer
 * than the ceiling.
 */
export function continuationDelayMs(attempt: number, retryAfterMs?: number): number {
  const growth = Math.max(1, Math.min(attempt, 16));
  const backoff = Math.min(YOUTUBE_CONTINUATION_MIN_DELAY_MS * growth, YOUTUBE_CONTINUATION_MAX_DELAY_MS);
  if (typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
    return Math.min(Math.max(retryAfterMs, YOUTUBE_CONTINUATION_MIN_DELAY_MS), YOUTUBE_CONTINUATION_MAX_DELAY_MS);
  }
  return backoff;
}

/**
 * Runs one native YouTube upload to a conclusion.
 *
 * The function never opens a session by itself: the store owns that decision,
 * because only the durable record can say whether a video may already exist
 * and whether a receipt is already there. What this owns is the writing: the
 * chunk plan, the status probe after an answer that did not move the offset
 * forward, and the refusal to write again once the provider may hold a
 * video.
 */
export async function runResumableVideoUpload(deps: ResumableUploadDeps): Promise<ResumableUploadOutcome> {
  const { store, session, leaseToken, source, totalBytes, mimeType, deadlineMs, now, sleep } = deps;
  const allowedHosts = deps.allowedHosts ?? YOUTUBE_PROVIDER_UPLOAD_HOSTS;
  const chunkBytes = deps.chunkBytes ?? YOUTUBE_RESUMABLE_CHUNK_BYTES;

  // A receipt that already exists is the answer. Nothing is uploaded again,
  // and no media is read: this is the receipt-only recovery.
  if (session.videoId) {
    return { kind: "completed", videoId: session.videoId };
  }
  if (session.state === "uploaded") {
    return {
      kind: "reconcile",
      reason: YOUTUBE_UPLOAD_REASON.reconcile,
      detail: "The upload is recorded as accepted but carries no receipt.",
    };
  }
  if (session.state === "reconcile") {
    return {
      kind: "reconcile",
      reason: YOUTUBE_UPLOAD_REASON.reconcile,
      detail: "The upload needs manual reconciliation.",
    };
  }
  if (session.state === "failed") {
    return {
      kind: "failed",
      reason: YOUTUBE_UPLOAD_REASON.rejected,
      detail: "The upload was already given up.",
      retryable: true,
    };
  }

  let sessionUri = session.sessionUri;
  let confirmedBytes = Math.min(session.confirmedBytes, totalBytes);
  let bytesSent = Math.min(session.bytesSent, totalBytes);
  let videoMayExist = session.videoMayExist;

  if (sessionUri && !isAllowedProviderUploadUri(sessionUri, allowedHosts)) {
    // The session URI is not one this worker may write to. Writing anyway
    // would send the OAuth token somewhere it does not belong, so the check
    // runs BEFORE any request that carries the token.
    const context = buildContext(deps, session.id, sessionUri, totalBytes, mimeType, deadlineMs, now, sleep);
    return await giveUp(
      context,
      { state: "reconcile" },
      {
        kind: "reconcile",
        reason: YOUTUBE_UPLOAD_REASON.reconcile,
        detail: "The session uri was refused by the provider host policy.",
      },
    );
  }

  if (!sessionUri) {
    // Nothing was ever written (the store only reopens a session it proved
    // is empty), so a fresh session cannot duplicate a video.
    if (bytesSent > 0) {
      return {
        kind: "reconcile",
        reason: YOUTUBE_UPLOAD_REASON.reconcile,
        detail: "The upload has no session but bytes were written before.",
      };
    }
    // The initialization write is the first thing that leaves this process
    // towards the provider, so the live state is asked about first. The lease
    // says this worker owns the session; only the live state says the post,
    // the content, the target and the media are still what this worker saw.
    const refused = await checkEffectAuthority(deps);
    if (refused) return refused;
    const opened = await openProviderSession(deps, totalBytes, mimeType, allowedHosts);
    if (opened.kind === "outcome") return opened.outcome;
    sessionUri = opened.sessionUri;
  } else {
    // An inherited session is probed BEFORE any data write.
    //
    // The provider is the only party that knows how many bytes it holds. The
    // durable record knows how many were confirmed, but a worker may have
    // died between writing and recording, and the provider may have accepted
    // part of a chunk. Writing first and asking later would push bytes the
    // provider has already accepted, which it refuses, and would risk a
    // second write over a video that already exists.
    const inherited = buildContext(deps, session.id, sessionUri, totalBytes, mimeType, deadlineMs, now, sleep);
    const probed = await probeStatus(inherited, confirmedBytes, bytesSent);

    if (probed.kind === "accepted") {
      // The provider finished this upload while nobody was watching. This is
      // the lost final acknowledgement, and the receipt is still there.
      return await keepReceipt(inherited, probed.videoId);
    }

    if (probed.kind === "rejected") {
      const outcome = await giveUp(
        inherited,
        { state: videoMayExist ? "reconcile" : "failed" },
        videoMayExist
          ? { kind: "reconcile", reason: YOUTUBE_UPLOAD_REASON.reconcile, detail: probed.message }
          : { kind: "failed", reason: YOUTUBE_UPLOAD_REASON.rejected, detail: probed.message, retryable: false },
      );
      return outcome;
    }

    if (probed.kind === "expired") {
      const detail = videoMayExist
        ? "The session expired after the last chunk may have been written."
        : "The session expired before the last chunk was written.";
      const outcome = await giveUp(
        inherited,
        { state: videoMayExist ? "reconcile" : "expired" },
        videoMayExist
          ? { kind: "reconcile", reason: YOUTUBE_UPLOAD_REASON.expired, detail }
          : { kind: "unsent", reason: YOUTUBE_UPLOAD_REASON.unsent, detail },
      );
      return outcome;
    }

    if (probed.kind === "resumable") {
      // The provider confirmed an offset that may sit inside a chunk that was
      // written before. The next block starts exactly there.
      confirmedBytes = probed.confirmedBytes;
    } else if (probed.retryable) {
      // The provider is not talking. The session is still good, so it is
      // asked again later instead of being thrown away.
      const delay = continuationDelayMs(session.continuationCount + 1, probed.retryAfterMs);
      return await scheduleAnotherLook(
        inherited,
        confirmedBytes,
        bytesSent,
        videoMayExist,
        now() + delay,
      );
    } else {
      const outcome = await giveUp(
        inherited,
        { state: videoMayExist ? "reconcile" : "failed" },
        videoMayExist
          ? { kind: "reconcile", reason: YOUTUBE_UPLOAD_REASON.reconcile, detail: probed.reason }
          : { kind: "failed", reason: YOUTUBE_UPLOAD_REASON.unknown, detail: probed.reason, retryable: false },
      );
      return outcome;
    }
  }

  const context = buildContext(deps, session.id, sessionUri, totalBytes, mimeType, deadlineMs, now, sleep);

  /** The offset the next write starts at, taken from the provider's own answer. */
  let offset = confirmedBytes;
  /** How many answers in a row left the offset where it was. */
  let stalls = 0;

  while (offset < totalBytes) {
    if (now() >= deadlineMs) {
      const delay = continuationDelayMs(session.continuationCount + 1);
      return await scheduleAnotherLook(context, offset, bytesSent, videoMayExist, now() + delay);
    }

    // The block is built from the offset the provider confirmed, so a
    // continuation that resumes inside an old chunk sends the rest of that
    // chunk and not a block the provider will refuse.
    const chunk = planChunkFrom(offset, totalBytes, chunkBytes);
    if (!chunk) {
      return await giveUp(
        context,
        { state: "reconcile" },
        {
          kind: "reconcile",
          reason: YOUTUBE_UPLOAD_REASON.reconcile,
          detail: "The confirmed offset is not usable.",
        },
      );
    }

    if (!source) {
      return await giveUp(
        context,
        { state: "failed" },
        {
          kind: "failed",
          reason: YOUTUBE_UPLOAD_REASON.unknown,
          detail: "The upload needs media bytes but no source was given.",
          retryable: false,
        },
      );
    }

    // The live state is asked about BEFORE every write to the provider.
    //
    // The lease says the worker owns the session; it does not say the post,
    // the content, the target or the media are still what the worker saw. A
    // refusal is acted on BEFORE the state is advanced, so the record never
    // claims that a video may exist when no byte was ever written.
    //
    // The last chunk is the write that creates the video, and it is the one
    // that cannot be taken back, but the check is not limited to it: bytes
    // that reach the provider for a post the customer cancelled are bytes
    // that have to be accounted for.
    const bytes = await readChunkBytes(source, chunk, deadlineMs - now());
    if (bytes === null) {
      const delay = continuationDelayMs(session.continuationCount + 1);
      return await scheduleAnotherLook(context, offset, bytesSent, videoMayExist, now() + delay);
    }

    const refused = await checkEffectAuthority(deps);
    if (refused) return refused;
    if (now() >= deadlineMs) {
      const delay = continuationDelayMs(session.continuationCount + 1);
      return await scheduleAnotherLook(context, offset, bytesSent, videoMayExist, now() + delay);
    }

    // The write is recorded BEFORE it is made. If the worker dies between
    // here and the provider's answer, the next worker knows that bytes may
    // have reached the provider, and asks the provider instead of writing.
    //
    // The last chunk is the one that creates the video, so the record also
    // says the provider may already have one. That flag is what keeps a
    // later worker from writing the file a second time.
    if (chunk.end + 1 >= totalBytes) videoMayExist = true;
    const checkpointed = await store.checkpoint({
      sessionId: session.id,
      leaseToken,
      confirmedBytes: offset,
      bytesSent: chunk.end + 1,
      videoMayExist,
    });
    if (!checkpointed) {
      return { kind: "abandoned", reason: YOUTUBE_UPLOAD_REASON.lease_conflict };
    }
    bytesSent = Math.max(bytesSent, chunk.end + 1);

    const status = await writeChunk(context, chunk, bytes, offset, bytesSent);
    const resolution = await resolveProviderAnswer(context, status, offset, videoMayExist, bytesSent);
    if (resolution.kind === "outcome") {
      if (resolution.outcome.kind === "resumable") {
        const delay = continuationDelayMs(session.continuationCount + 1, resolution.outcome.nextCheckAtMs);
        return await scheduleAnotherLook(context, offset, bytesSent, videoMayExist, now() + delay);
      }
      return resolution.outcome;
    }

    // The persisted uncertainty remains sticky once a final write has started.
    videoMayExist = resolution.videoMayExist;
    if (resolution.confirmedBytes > offset) {
      stalls = 0;
    } else {
      stalls += 1;
      if (stalls >= 2) {
        return await giveUp(
          context,
          { state: "reconcile" },
          {
            kind: "reconcile",
            reason: YOUTUBE_UPLOAD_REASON.reconcile,
            detail: "The provider did not accept the bytes.",
          },
        );
      }
    }

    const advanced = await store.checkpoint({
      sessionId: session.id,
      leaseToken,
      confirmedBytes: resolution.confirmedBytes,
      bytesSent,
      videoMayExist,
    });
    if (!advanced) {
      return { kind: "abandoned", reason: YOUTUBE_UPLOAD_REASON.lease_conflict };
    }
    offset = resolution.confirmedBytes;
  }

  // Every byte is confirmed, but no receipt was read: the provider finished
  // the upload and the answer was lost. The status is asked for once more,
  // because that is where the receipt is.
  const final = await probeStatus(context, totalBytes, bytesSent);
  if (final.kind === "accepted") {
    return await keepReceipt(context, final.videoId);
  }
  if (final.kind === "resumable" || (final.kind === "unknown" && final.retryable)) {
    const delay = continuationDelayMs(
      session.continuationCount + 1,
      final.kind === "unknown" ? final.retryAfterMs : undefined,
    );
    return await scheduleAnotherLook(context, totalBytes, bytesSent, videoMayExist, now() + delay);
  }
  return await giveUp(
    context,
    { state: videoMayExist ? "reconcile" : "failed" },
    videoMayExist
      ? {
        kind: "reconcile",
        reason: YOUTUBE_UPLOAD_REASON.reconcile,
        detail: "The upload finished but the provider did not return a receipt.",
      }
      : {
        kind: "failed",
        reason: YOUTUBE_UPLOAD_REASON.unknown,
        detail: "The upload finished but the provider did not return a receipt.",
        retryable: false,
      },
  );
}

/**
 * Asks whether the live state still authorises the write.
 *
 * It returns an outcome when the write is refused, and null when it may go
 * ahead. A refusal is never turned into a write: a write that cannot prove it
 * was allowed is not made, and the record is left exactly as it was, so the
 * worker that owns the session decides what happens next.
 */
async function checkEffectAuthority(
  deps: ResumableUploadDeps,
): Promise<ResumableUploadOutcome | null> {
  let verdict: { authorized: boolean; reason: string | null };
  try {
    verdict = await deps.effectAuthority();
  } catch {
    // The authority could not be read. A write that cannot prove it is
    // allowed is not made.
    return {
      kind: "abandoned",
      reason: YOUTUBE_UPLOAD_REASON.unknown,
      detail: "The write authority could not be confirmed.",
    };
  }
  if (verdict.authorized) return null;

  return {
    kind: "abandoned",
    reason: effectAuthorityReason(verdict.reason),
    detail: "The live state no longer authorises this write.",
  };
}

/**
 * Asks the provider for a session and keeps it in the session row.
 *
 * The provider names the session URI, so it is an input: it is checked
 * against the host policy before it is used, and a host that was not
 * reviewed is refused rather than written to with the OAuth token.
 */
async function openProviderSession(
  deps: ResumableUploadDeps,
  totalBytes: number,
  mimeType: string,
  allowedHosts: readonly string[],
): Promise<{ kind: "sessionUri"; sessionUri: string } | { kind: "outcome"; outcome: ResumableUploadOutcome }> {
  let sessionUri: string;
  try {
    sessionUri = await createYoutubeResumableSession({
      fetchImpl: deps.fetchImpl,
      accessToken: deps.accessToken,
      url: deps.uploadUrl,
      body: deps.uploadBody,
      totalBytes,
      mimeType,
      allowedHosts,
    });
  } catch (error) {
    const reason = redactProviderText(error);
    return {
      kind: "outcome",
      outcome: {
        kind: "failed",
        reason: YOUTUBE_UPLOAD_REASON.unknown,
        detail: `The provider did not answer the session request: ${reason}`,
        retryable: true,
      },
    };
  }

  const stored = await deps.store.checkpoint({
    sessionId: deps.session.id,
    leaseToken: deps.leaseToken,
    confirmedBytes: 0,
    bytesSent: 0,
    sessionUri,
  });
  if (!stored) {
    // Another worker owns the session, so this worker must not write to it.
    return {
      kind: "outcome",
      outcome: { kind: "abandoned", reason: YOUTUBE_UPLOAD_REASON.lease_conflict },
    };
  }
  return { kind: "sessionUri", sessionUri };
}

/**
 * Reads the bytes of one chunk.
 *
 * A source that cannot deliver the chunk ends the attempt without a write,
 * so the upload stays resumable rather than being half sent.
 */
async function readChunkBytes(
  source: UploadByteSource,
  chunk: UploadChunk,
  timeoutMs: number,
): Promise<ArrayBuffer | null> {
  let bytes: ArrayBuffer;
  try {
    bytes = await source.read(chunk.start, chunk.end, Math.max(1, timeoutMs));
  } catch {
    return null;
  }
  if (bytes.byteLength !== chunk.size) {
    return null;
  }
  return bytes;
}

/** The context every provider call of one upload shares. */
function buildContext(
  deps: ResumableUploadDeps,
  sessionId: string,
  sessionUri: string,
  totalBytes: number,
  mimeType: string,
  deadlineMs: number,
  now: () => number,
  sleep: (ms: number) => Promise<void>,
): UploadContext {
  return {
    fetchImpl: deps.fetchImpl,
    store: deps.store,
    sessionId,
    leaseToken: deps.leaseToken,
    sessionUri,
    accessToken: deps.accessToken,
    mimeType,
    totalBytes,
    deadlineMs,
    now,
    sleep,
  };
}

/**
 * One chunk write to the provider.
 *
 * Redirects are never followed: a `Location` that points somewhere else would
 * carry the OAuth token with it.
 */
async function writeChunk(
  context: UploadContext,
  chunk: UploadChunk,
  bytes: ArrayBuffer,
  previousConfirmedBytes: number,
  submittedBytes: number,
): Promise<ProviderUploadStatus> {
  const contentRange = `bytes ${chunk.start}-${chunk.end}/${context.totalBytes}`;
  const declared = parseContentRange(contentRange);
  if (!declared || declared.start !== chunk.start || declared.end !== chunk.end) {
    // A block the provider will refuse is not worth sending: it would look
    // like a lost upload rather than a broken plan.
    return ambiguousWrite("The upload chunk does not fit the video.");
  }

  const timeoutMs = Math.max(1, Math.min(YOUTUBE_PROVIDER_REQUEST_TIMEOUT_MS, context.deadlineMs - context.now()));
  let response: Response;
  try {
    response = await context.fetchImpl(context.sessionUri, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${context.accessToken}`,
        "Content-Type": context.mimeType,
        "Content-Length": String(chunk.size),
        "Content-Range": contentRange,
      },
      body: bytes,
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    // A failed request can carry the session URL in its message. It is
    // redacted before it becomes a reason.
    const reason = redactProviderText(error);
    return ambiguousWrite(`The provider did not answer the write: ${reason}`);
  }

  if (response.status >= 300 && response.status < 400 && response.status !== 308) {
    // A redirect is not followed. The session URI stays where it was.
    return ambiguousWrite("The provider answered with a redirect, which is not followed.");
  }

  return readProviderStatus(response, context.totalBytes, previousConfirmedBytes, submittedBytes);
}

/**
 * Asks the provider how much of the upload it holds.
 *
 * The probe is an empty `PUT` whose `Content-Range` names the total with an
 * asterisk where the first byte would be. The provider answers with the `308`
 * of an unfinished upload, or with the very answer it gave when the upload
 * finished -- which is where a lost receipt is found.
 */
async function probeStatus(
  context: UploadContext,
  previousConfirmedBytes: number,
  submittedBytes: number,
): Promise<ProviderUploadStatus> {
  let lastReason = "The provider did not answer the status request.";

  for (let attempt = 0; attempt < YOUTUBE_MAX_PROBE_ATTEMPTS; attempt += 1) {
    if (context.now() >= context.deadlineMs) {
      return {
        kind: "unknown",
        reason: "The worker ran out of time while the status was being asked for.",
        retryable: true,
      };
    }

    const timeoutMs = Math.max(1, Math.min(YOUTUBE_PROVIDER_REQUEST_TIMEOUT_MS, context.deadlineMs - context.now()));
    let response: Response;
    try {
      response = await context.fetchImpl(context.sessionUri, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${context.accessToken}`,
          "Content-Type": mimeTypeForProbe(),
          "Content-Length": "0",
          "Content-Range": `bytes */${context.totalBytes}`,
        },
        body: new ArrayBuffer(0),
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const reason = redactProviderText(error);
      lastReason = `The provider did not answer the status request: ${reason}`;
      if (attempt + 1 < YOUTUBE_MAX_PROBE_ATTEMPTS && context.now() + YOUTUBE_PROBE_BACKOFF_MS < context.deadlineMs) {
        await context.sleep(YOUTUBE_PROBE_BACKOFF_MS);
      }
      continue;
    }

    if (response.status >= 300 && response.status < 400 && response.status !== 308) {
      lastReason = "The provider answered the status request with a redirect, which is not followed.";
      if (attempt + 1 < YOUTUBE_MAX_PROBE_ATTEMPTS && context.now() + YOUTUBE_PROBE_BACKOFF_MS < context.deadlineMs) {
        await context.sleep(YOUTUBE_PROBE_BACKOFF_MS);
      }
      continue;
    }

    const status = await readProviderStatus(response, context.totalBytes, previousConfirmedBytes, submittedBytes);
    if (status.kind !== "unknown" || !status.retryable || status.retryAfterMs !== undefined) return status;
    lastReason = status.reason;
    if (attempt + 1 < YOUTUBE_MAX_PROBE_ATTEMPTS && context.now() + YOUTUBE_PROBE_BACKOFF_MS < context.deadlineMs) {
      await context.sleep(YOUTUBE_PROBE_BACKOFF_MS);
    }
  }

  return { kind: "unknown", reason: lastReason, retryable: true };
}

/** The probe carries no bytes, so it declares the type it would have carried. */
function mimeTypeForProbe(): string {
  return "application/octet-stream";
}

/**
 * Asks the provider for a resumable session.
 *
 * The answer carries the session URI in its `Location` header, and that URI
 * is an input: it is checked against the host policy before it is used, so a
 * provider that named another host cannot have the OAuth token sent there.
 *
 * The URI is returned to the caller, which stores it in the private session
 * row. It is never logged here.
 */
export async function createYoutubeResumableSession(args: {
  fetchImpl: typeof fetch;
  accessToken: string;
  url: string;
  body: Record<string, unknown>;
  totalBytes: number;
  mimeType: string;
  timeoutMs?: number;
  allowedHosts?: readonly string[];
}): Promise<string> {
  const allowedHosts = args.allowedHosts ?? YOUTUBE_PROVIDER_UPLOAD_HOSTS;
  const timeoutMs = args.timeoutMs ?? YOUTUBE_PROVIDER_REQUEST_TIMEOUT_MS;

  let response: Response;
  try {
    response = await args.fetchImpl(args.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${args.accessToken}`,
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Length": String(args.totalBytes),
        "X-Upload-Content-Type": args.mimeType,
      },
      body: JSON.stringify(args.body),
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const reason = redactProviderText(error);
    throw new Error(`The provider did not answer the session request: ${reason}`);
  }

  if (response.status >= 300 && response.status < 400) {
    // A redirect is not followed: the OAuth token would travel with it.
    throw new Error("The provider answered the session request with a redirect, which is not followed.");
  }

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(
      redactProviderText(uploadFailureMessage(response.status, errorData, response.statusText)),
    );
  }

  const sessionUri = response.headers.get("location");
  if (!sessionUri) {
    throw new Error("YouTube did not return an upload URL");
  }
  if (!isAllowedProviderUploadUri(sessionUri, allowedHosts)) {
    throw new Error("The provider named a session host this upload may not write to.");
  }
  return sessionUri;
}
