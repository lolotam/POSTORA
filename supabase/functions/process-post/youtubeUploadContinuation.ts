/**
 * Continuing a YouTube upload that a worker left half written.
 *
 * WHY THIS IS ITS OWN MODULE
 * --------------------------
 * The continuation is a different job from publishing. Publishing asks "may
 * this post go out now"; the continuation asks "may the upload that was
 * already started go on". The two have different rules, and the rules of the
 * second one are the ones that keep a second video off the customer's channel:
 *
 *   * the upload belongs to a POST ATTEMPT. A post that was edited or retried
 *     is published again, and that is a new attempt. Carrying the old
 *     attempt's bytes on would put the wrong video on the channel.
 *   * the upload belongs to an ACCOUNT the post selected, and that account
 *     must still be usable.
 *   * the upload belongs to a MEDIA FILE the post still names, and that file
 *     must still be the version the upload started with.
 *
 * A RECEIPT-ONLY RECOVERY
 * ------------------------
 * When the session already carries a receipt, the video exists. Nothing is
 * uploaded, no media is read and no other platform is touched: the receipt is
 * projected onto the public row and the post is settled. That is what makes a
 * final acknowledgement that was lost after the database had already stored
 * the receipt safe: the same video is found again instead of a second one
 * being made.
 *
 * The distinction matters: settling a receipt is safe even when the account
 * can no longer publish, because nothing is sent to the provider. SENDING is
 * what needs the account.
 */

import {
  effectAuthorityReason,
  YOUTUBE_CONTINUATION_MIN_DELAY_MS,
  type ResumableUploadOutcome,
  type UploadByteSource,
  type YoutubeUploadRefusal,
  type YoutubeUploadSessionRecord,
} from "./youtubeResumableUpload.ts";
import { mediaSendability } from "../_shared/partnerMediaStore.ts";
import { YOUTUBE_UPLOAD_REASON, type YoutubeUploadReason } from "./youtubeUploadPolicy.ts";

/** What the continuation is asked to do. */
export interface YoutubeContinuationRequest {
  postId: string;
  /** The upload session to carry on. */
  sessionId: string;
  /**
   * The claim token.
   *
   * It proves this worker holds the claim, and it is the only thing the
   * dispatch carried: the session URI stays in the database.
   */
  leaseToken: string;
  /** The post attempt the session belongs to. */
  attemptStartedAt: string | null;
}

/** The post, as far as the continuation needs it. */
export interface ContinuationPost {
  id: string;
  userId: string;
  status: string;
  /** The attempt this post is on. */
  processingStartedAt: string | null;
  /** The accounts the post selected. */
  selectedAccountIds: string[];
  /** The media files the post names. */
  mediaFileIds: string[];
  /** The thumbnail the customer asked for, if any. */
  thumbnailUrl: string | null;
  /** The first comment the customer asked for, if any. */
  firstComment: string | null;
}

/** The account, as far as the continuation needs it. */
export interface ContinuationAccount {
  id: string;
  userId: string;
  platform: string;
  isActive: boolean;
  accessToken: string | null;
  needsReauth: boolean;
}

/** The media file, as far as the continuation needs it. */
export interface ContinuationMedia {
  id: string;
  userId: string;
  currentObjectVersion: number | null;
  filePath: string;
  /**
   * The storage bucket the file lives in.
   *
   * It is part of the file's identity: the same path in a different bucket is
   * a different object, and a signed URL is only made for the bucket the file
   * is actually in.
   */
  storageBucket: string;
  mimeType: string | null;
  /**
   * The security scan state of the file.
   *
   * It is the shared sendability rule: a file that is still being scanned is
   * a wait, and a file that was rejected is permanent. A resumed upload
   * applies the SAME rule every other send path applies, so a file that may
   * not be sent is not sent from here either.
   */
  scanState: string | null;
}

/** Everything the continuation needs from the outside world. */
export interface YoutubeContinuationPorts {
  loadPost(postId: string): Promise<ContinuationPost | null>;
  loadAccount(accountId: string): Promise<ContinuationAccount | null>;
  loadMedia(mediaFileId: string): Promise<ContinuationMedia | null>;
  /**
   * Takes the session for this worker.
   *
   * The record it returns carries the session URI. The URI never leaves this
   * function: it goes to the upload and nowhere else.
   */
  claimSession(
    sessionId: string,
    leaseToken: string,
    leaseMs: number,
  ): Promise<{ record: YoutubeUploadSessionRecord | null; refused: YoutubeUploadRefusal | null }>;
  /**
   * The video bytes.
   *
   * It is only called when the upload has to WRITE. A receipt-only recovery
   * never reaches it, so no media is fetched for an upload that is already
   * finished.
   *
   * The port is handed the file, not a URL: the port resolves the URL the way
   * publishing does, from the file's own bucket and its provider rows, so a
   * continuation cannot read a different object than the one the upload
   * started with.
   */
  createSource(args: { media: ContinuationMedia }): Promise<UploadByteSource>;
  /** Runs the upload against the provider. */
  runUpload(args: {
    record: YoutubeUploadSessionRecord;
    leaseToken: string;
    accessToken: string;
    source: UploadByteSource;
    totalBytes: number;
    deadlineMs: number;
  }): Promise<ResumableUploadOutcome>;
  /**
   * Records the terminal outcome.
   *
   * The public row and the parent rollup are settled together, in one
   * transaction, fenced to the worker that still owns the session. A worker
   * that lost its lease settles nothing, because the worker that took over
   * may already have written the video.
   */
  settleUpload(args: {
    sessionId: string;
    leaseToken: string;
    status: "success" | "failed";
    videoId: string | null;
    errorMessage: string | null;
    responseData: Record<string, unknown>;
  }): Promise<{ settled: boolean; refused: YoutubeUploadRefusal | null }>;
  /**
   * Projects a stored receipt onto the public row.
   *
   * No provider is contacted and no media is read: the video already exists.
   */
  projectReceipt(args: { sessionId: string }): Promise<{
    settled: boolean;
    refused: YoutubeUploadRefusal | null;
    videoId: string | null;
  }>;
  /**
   * The things that happen AFTER the video exists: the thumbnail and the
   * first comment.
   *
   * They belong to the run that CREATED the video. A run that inherits a
   * receipt does not repeat them, because a first comment posted twice is a
   * duplicate on the customer's channel and a thumbnail set twice is a
   * provider write nobody asked for.
   *
   * A failure here is never fatal: the video is already published, and the
   * public row has to be settled either way.
   */
  followUps(args: {
    post: ContinuationPost;
    videoId: string;
    accessToken: string;
  }): Promise<void>;
  /**
   * Whether this worker may write to the provider NOW.
   *
   * The lease says the worker owns the session. It does not say the post, the
   * content, the target or the media are still what the worker saw, so the
   * live state is asked about before anything is sent.
   *
   * The reason is returned rather than thrown: a stale attempt is a refusal
   * and a media file that is still being scanned is a wait.
   */
  effectAuthority(args: { sessionId: string; leaseToken: string }): Promise<{
    authorized: boolean;
    reason: string | null;
  }>;
  /**
   * Closes the post fanout for an upload whose worker died between the
   * admission and the closure.
   *
   * A destination without a result row has an UNKNOWN outcome, because the
   * platforms that are not YouTube write their row after the provider call.
   * Such a destination is terminalised with a non-retryable reason, so it is
   * never published twice, and the scope becomes complete.
   *
   * The closure waits until the worker of the attempt cannot write any more,
   * so it never freezes a scope that is about to change.
   */
  recoverFanout(args: { sessionId: string; leaseToken?: string | null }): Promise<{
    recovered: boolean;
    reason: string | null;
  }>;
  now(): number;
}

/** What the continuation ended as. */
export interface ContinuationResult {
  /** The public outcome. */
  status: "completed" | "pending" | "failed" | "refused";
  /** The stable reason code. */
  reason: YoutubeUploadReason;
  /** The video, when there is one. */
  videoId?: string;
  /** When the session may be looked at again. */
  nextCheckAt?: string;
}

/** How long this worker may hold the session. */
export const YOUTUBE_CONTINUATION_LEASE_MS = 120_000;

/** The refusal a session state becomes, as a reason code. */
export function refusalToReason(refusal: YoutubeUploadRefusal): YoutubeUploadReason {
  switch (refusal) {
    case "reconcile_required":
      return YOUTUBE_UPLOAD_REASON.reconcile;
    case "content_changed":
      return YOUTUBE_UPLOAD_REASON.superseded;
    case "lease_held":
      return YOUTUBE_UPLOAD_REASON.lease_conflict;
    case "account_not_usable":
      return YOUTUBE_UPLOAD_REASON.account_unusable;
    case "media_not_owned":
      return YOUTUBE_UPLOAD_REASON.media_unavailable;
    case "post_not_found":
      return YOUTUBE_UPLOAD_REASON.not_found;
    case "invalid_size":
      return YOUTUBE_UPLOAD_REASON.media_unavailable;
    case "session_expired":
      return YOUTUBE_UPLOAD_REASON.expired;
    case "lease_stale":
      return YOUTUBE_UPLOAD_REASON.lease_conflict;
    case "stale_attempt":
      return YOUTUBE_UPLOAD_REASON.stale_attempt;
    case "post_superseded":
      return YOUTUBE_UPLOAD_REASON.superseded;
    case "too_many_continuations":
      return YOUTUBE_UPLOAD_REASON.reconcile;
    case "no_public_row":
      return YOUTUBE_UPLOAD_REASON.not_found;
    case "target_not_authorized":
      return YOUTUBE_UPLOAD_REASON.account_unusable;
    default:
      return YOUTUBE_UPLOAD_REASON.unknown;
  }
}

function sameAttemptTimestamp(actual: string | null, expected: string): boolean {
  if (!actual) return false;
  const actualMillis = Date.parse(actual);
  if (!Number.isFinite(actualMillis) || actualMillis !== Date.parse(expected)) return false;

  // Postgres timestamps can distinguish attempts within one JavaScript millisecond.
  const subMillisecond = (value: string) =>
    (value.match(/\.(\d+)(?:Z|[+-]\d{2}(?::?\d{2})?)$/i)?.[1] ?? "").slice(3).replace(/0+$/, "");
  return subMillisecond(actual) === subMillisecond(expected);
}

/**
 * Carries one YouTube upload on.
 *
 * The order of the checks is the order of the questions: is there a post, is
 * it still on the attempt this upload belongs to, is the account one the post
 * selected and still usable, is the media still the one the upload started
 * with. Only then is anything sent to the provider.
 */
export async function continueYoutubeUpload(
  ports: YoutubeContinuationPorts,
  request: YoutubeContinuationRequest,
): Promise<ContinuationResult> {
  const post = await ports.loadPost(request.postId);
  if (!post) return refused(YOUTUBE_UPLOAD_REASON.not_found);

  // The post must still be the one that is being worked on. A post that was
  // cancelled, or that was settled by another attempt, is not.
  if (post.status !== "processing") return refused(YOUTUBE_UPLOAD_REASON.superseded);

  // The attempt must be the one the dispatch named. The dispatch carries the
  // attempt the session was claimed for, and a post that moved on to a newer
  // attempt is a post whose content may have changed.
  if (request.attemptStartedAt && !sameAttemptTimestamp(post.processingStartedAt, request.attemptStartedAt)) {
    return refused(YOUTUBE_UPLOAD_REASON.stale_attempt);
  }

  const claimed = await ports.claimSession(
    request.sessionId,
    request.leaseToken,
    YOUTUBE_CONTINUATION_LEASE_MS,
  );
  if (claimed.refused || !claimed.record) {
    return refused(refusalToReason(claimed.refused ?? "session_not_found"));
  }
  const session = claimed.record;

  // The session must belong to the post that was dispatched.
  if (session.postId !== post.id) return refused(YOUTUBE_UPLOAD_REASON.not_found);

  // The attempt fence, checked on the session itself. A session that belongs
  // to an older attempt is never carried on.
  if (session.attemptStartedAt && !sameAttemptTimestamp(post.processingStartedAt, session.attemptStartedAt)) {
    return refused(YOUTUBE_UPLOAD_REASON.stale_attempt);
  }

  // ───────────────────────────────────────────────────────────────────────
  // The receipt-only recovery.
  //
  // The video exists. It is projected onto the public row and the post is
  // settled. No media is read, no provider is called, and no other platform
  // is touched.
  //
  // The projection needs no lease: it is not a provider write, it is the
  // receipt being told about. It does need the attempt to be the current one.
  // ───────────────────────────────────────────────────────────────────────
  if (session.videoId) {
    // The fanout closure comes BEFORE the projection.
    //
    // The pending YouTube row is what keeps the generic sweeper from reading
    // the absence of a sibling row as "this destination never started". So the
    // scope has to be settled while that row is still pending: the closure
    // then knows every destination of the attempt, and the sweeper never sees
    // a gap it could mistake for a proof.
    await recoverFanoutQuietly(ports, session.id);
    const projected = await ports.projectReceipt({ sessionId: session.id });
    if (!projected.settled) {
      return refused(refusalToReason(projected.refused ?? "session_not_found"));
    }
    return { status: "completed", reason: YOUTUBE_UPLOAD_REASON.completed, videoId: session.videoId };
  }

  const account = await ports.loadAccount(session.socialAccountId);
  if (!isUsableAccount(account, post)) {
    return refused(YOUTUBE_UPLOAD_REASON.account_unusable);
  }

  if (!session.sessionUri) {
    // The session was admitted but the provider session was never opened.
    //
    // The batch claim only hands out such a session when no byte ever
    // reached the provider, so no video can exist and the upload opens a
    // session and starts. A session that DID write bytes and then lost its
    // URI could have a video nobody has a receipt for, so it is left for a
    // human instead of being started again.
    if (session.bytesSent > 0 || session.videoMayExist) {
      return refused(YOUTUBE_UPLOAD_REASON.reconcile);
    }
  }

  // The account must still be a target of the post.
  //
  // The claim already refuses a session whose account the post no longer
  // targets. This is the second half of that rule: the account has to be one
  // the RUN resolved, which is not always the same set as the post's stored
  // selection, because a run may have been given an explicit account.
  const targets = session.targetAccountIds.length > 0
    ? session.targetAccountIds
    : post.selectedAccountIds;
  if (!targets.includes(session.socialAccountId)) {
    // The post no longer selects this account. Sending would publish to an
    // account the customer took out of the post.
    return refused(YOUTUBE_UPLOAD_REASON.account_unusable);
  }

  // Only a YouTube upload is resumed. The session names the platform it
  // writes to, and nothing else is ever carried on by this worker.
  if (session.resolvedPlatform !== null && session.resolvedPlatform !== "youtube") {
    return refused(YOUTUBE_UPLOAD_REASON.session_not_open);
  }

  const media = await loadMatchingMedia(ports, session, post);
  if (!media.media) {
    // A file that is still being scanned waits: the upload continues when the
    // scan is done. Anything else is permanent for this attempt.
    if (media.reason === YOUTUBE_UPLOAD_REASON.resumable) {
      return {
        status: "pending",
        reason: YOUTUBE_UPLOAD_REASON.resumable,
        nextCheckAt: new Date(ports.now() + YOUTUBE_CONTINUATION_MIN_DELAY_MS).toISOString(),
      };
    }
    return refused(media.reason ?? YOUTUBE_UPLOAD_REASON.media_unavailable);
  }

  const { leaseToken } = request;
  const { accessToken } = account;

  // The live state is asked about BEFORE anything is sent.
  //
  // Everything above this line read the world once. Between that read and the
  // write, the customer may have changed the title, the privacy or the
  // account, or the media may have been replaced or rejected by a scan. The
  // lease only says this worker owns the session; it says nothing about any
  // of that.
  const authority = await ports.effectAuthority({ sessionId: session.id, leaseToken });
  if (!authority.authorized) {
    const reason = effectAuthorityReason(authority.reason);
    if (reason === YOUTUBE_UPLOAD_REASON.resumable) {
      return {
        status: "pending",
        reason: YOUTUBE_UPLOAD_REASON.resumable,
        nextCheckAt: new Date(ports.now() + YOUTUBE_CONTINUATION_MIN_DELAY_MS).toISOString(),
      };
    }
    return refused(reason);
  }

  const source = await ports.createSource({ media: media.media });
  const outcome = await ports.runUpload({
    record: session,
    leaseToken,
    accessToken,
    source,
    totalBytes: session.totalBytes,
    deadlineMs: ports.now() + YOUTUBE_CONTINUATION_LEASE_MS,
  });

  return await interpretOutcome({ ports, request, session, outcome, post, accessToken });
}

/** The continuation stops here, and says why. */
function refused(reason: YoutubeUploadReason): ContinuationResult {
  return { status: "refused", reason };
}

/**
 * Whether the account may still publish.
 *
 * It has to be one the post selected, it has to belong to the post owner, and
 * it has to be usable. A receipt-only recovery does NOT need a usable account:
 * nothing is sent to the provider when the video already exists. SENDING is
 * what needs the account.
 */
function isUsableAccount(
  candidate: ContinuationAccount | null,
  post: ContinuationPost,
): candidate is ContinuationAccount & { accessToken: string } {
  return candidate !== null &&
    candidate.userId === post.userId &&
    candidate.platform === "youtube" &&
    candidate.isActive &&
    !candidate.needsReauth &&
    typeof candidate.accessToken === "string" &&
    candidate.accessToken.length > 0;
}

/**
 * The media file the upload started with, if it is still the one the post
 * names.
 *
 * The file must still be named by the post, still belong to the owner, still
 * be the same version, and still be SENDABLE. The sendability rule is the
 * shared one, so a file that is pending a security scan waits and a file that
 * was rejected is permanent: a resumed upload refuses exactly what every
 * other send path refuses.
 */
async function loadMatchingMedia(
  ports: YoutubeContinuationPorts,
  session: YoutubeUploadSessionRecord,
  post: ContinuationPost,
): Promise<{ media: ContinuationMedia | null; reason: YoutubeUploadReason | null }> {
  if (!session.mediaFileId || !post.mediaFileIds.includes(session.mediaFileId)) {
    return { media: null, reason: YOUTUBE_UPLOAD_REASON.media_unavailable };
  }
  const media = await ports.loadMedia(session.mediaFileId);
  if (!media || media.userId !== post.userId) {
    return { media: null, reason: YOUTUBE_UPLOAD_REASON.media_unavailable };
  }
  if (session.mediaObjectVersion !== null && media.currentObjectVersion !== session.mediaObjectVersion) {
    // The file was replaced. The bytes of the upload belong to the old
    // version, and the old version is not what the post names any more.
    return { media: null, reason: YOUTUBE_UPLOAD_REASON.media_unavailable };
  }
  const sendable = mediaSendability({ scanState: media.scanState });
  if (!sendable.ok) {
    return { media: null, reason: mediaSendabilityReason(sendable.code) };
  }
  return { media, reason: null };
}

/**
 * Why a file that may not be sent stops the upload.
 *
 * A file that is still being scanned is a wait, not a failure: the scan will
 * finish on its own and the upload can continue afterwards. A file the scan
 * rejected is permanent for this attempt.
 */
function mediaSendabilityReason(code: string): YoutubeUploadReason {
  return code === "media_pending"
    ? YOUTUBE_UPLOAD_REASON.resumable
    : YOUTUBE_UPLOAD_REASON.media_unavailable;
}

/**
 * Turns the outcome of one upload attempt into the public result.
 *
 * A completed upload settles the row as a success. A resumable one leaves the
 * row pending and the post processing, and says when the session may be
 * looked at again.
 *
 * A worker that LOST ITS LEASE writes nothing at all. The worker that took
 * over may already have written the video, so a stale worker settling the row
 * would publish a result the upload does not have. The row is left to the
 * worker that owns it.
 *
 * Everything else settles the row as failed, so the post rolls up and the
 * customer is told the truth.
 */
async function interpretOutcome(args: {
  ports: YoutubeContinuationPorts;
  request: YoutubeContinuationRequest;
  session: YoutubeUploadSessionRecord;
  outcome: ResumableUploadOutcome;
  post: ContinuationPost;
  accessToken: string;
}): Promise<ContinuationResult> {
  const { ports, request, session, outcome, post, accessToken } = args;
  const { leaseToken } = request;

  if (outcome.kind === "completed") {
    // The follow-ups belong to the run that CREATED the video. They happen
    // BEFORE the settlement, so a worker that dies here leaves them done
    // rather than done twice: the worker that inherits the receipt does not
    // repeat them.
    //
    // A follow-up that fails is not fatal. The video is already live, and the
    // public row has to be settled either way.
    try {
      await ports.followUps({ post, videoId: outcome.videoId, accessToken });
    } catch (error) {
      console.warn(
        `[youtube] the follow-ups for video ${outcome.videoId} did not finish:`,
        error instanceof Error ? error.message : String(error),
      );
    }

    // The fanout closure comes BEFORE the settlement.
    //
    // The pending YouTube row is what keeps the generic sweeper from reading
    // the absence of a sibling row as "this destination never started". So the
    // scope has to be settled while that row is still pending: the closure
    // then knows every destination of the attempt, and the sweeper never sees
    // a gap it could mistake for a proof.
    await recoverFanoutQuietly(ports, session.id);

    const settled = await ports.settleUpload({
      sessionId: session.id,
      leaseToken,
      status: "success",
      videoId: outcome.videoId,
      errorMessage: null,
      responseData: { youtube_video_id: outcome.videoId, youtube_upload_source: "continuation" },
    });
    if (!settled.settled) {
      // The lease is gone. Nothing is settled: the worker that owns the
      // session now decides what happens to the row.
      return { status: "refused", reason: YOUTUBE_UPLOAD_REASON.lease_conflict };
    }
    return { status: "completed", reason: YOUTUBE_UPLOAD_REASON.completed, videoId: outcome.videoId };
  }

  if (outcome.kind === "resumable") {
    // The upload continues.
    //
    // The public row stays pending, the post stays processing, and the session
    // says when it may be looked at again.
    //
    // NOTHING IS WRITTEN HERE. The upload already recorded the confirmed
    // offset and the time of the next look while it was running, and those
    // records are the authoritative ones. Writing them again from a snapshot
    // would put the older values back over the newer ones, and would clear
    // the uncertainty that a video may already exist.
    const delay = outcome.nextCheckAtMs ?? ports.now() + 60_000;
    return {
      status: "pending",
      reason: YOUTUBE_UPLOAD_REASON.resumable,
      nextCheckAt: new Date(delay).toISOString(),
    };
  }

  if (outcome.kind === "abandoned") {
    // The lease was lost. This worker writes nothing: the worker that took
    // over owns the session and its outcome.
    return { status: "refused", reason: YOUTUBE_UPLOAD_REASON.lease_conflict };
  }

  const reason = outcome.kind === "unsent"
    ? YOUTUBE_UPLOAD_REASON.unsent
    : outcome.kind === "reconcile"
    ? outcome.reason
    : outcome.reason;

  // The fanout closure comes BEFORE the settlement, for the same reason as
  // above: the pending YouTube row is what keeps the generic sweeper from
  // reading the absence of a sibling row as a proof that the sibling never
  // started.
  await recoverFanoutQuietly(ports, session.id);

  const settled = await ports.settleUpload({
    sessionId: session.id,
    leaseToken,
    status: "failed",
    videoId: null,
    errorMessage: reason,
    responseData: { youtube_upload_reason: reason },
  });
  if (!settled.settled) {
    // The lease is gone, so the outcome is not recorded here. The worker that
    // owns the session now decides what happens to the row.
    return { status: "refused", reason: YOUTUBE_UPLOAD_REASON.lease_conflict };
  }

  return { status: "failed", reason };
}

/**
 * Drives the fanout closure for a settled upload.
 *
 * The upload may have been the only thing this post was doing, and the worker
 * that died between the admission and the closure left the notification
 * candidate open. The closure is derived from the database: it closes the
 * scope when it is complete, and it terminalises a destination whose outcome
 * is unknown with a reason that is not a retry offer.
 *
 * It runs BEFORE the public row is settled, because the pending YouTube row
 * is what keeps the generic sweeper from reading the absence of a sibling row
 * as a proof that the sibling never started.
 *
 * A failure here is never fatal: the video is already published, or the
 * failure is already recorded, and the post is settled either way. The
 * candidate stays in whatever state the closure left it, and the next
 * reconciliation sees it.
 */
async function recoverFanoutQuietly(
  ports: YoutubeContinuationPorts,
  sessionId: string,
): Promise<void> {
  try {
    const recovered = await ports.recoverFanout({ sessionId });
    if (!recovered.recovered) {
      console.warn(
        `[youtube] the fanout of session ${sessionId} was not closed:`,
        recovered.reason ?? "unknown reason",
      );
    }
  } catch (error) {
    console.warn(
      `[youtube] the fanout of session ${sessionId} could not be closed:`,
      error instanceof Error ? error.message : String(error),
    );
  }
}
