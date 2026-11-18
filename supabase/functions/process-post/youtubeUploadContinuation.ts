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

import type {
  ResumableUploadOutcome,
  UploadByteSource,
  YoutubeUploadRefusal,
  YoutubeUploadSessionRecord,
} from "./youtubeResumableUpload.ts";
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
  mimeType: string | null;
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
   */
  createSource(args: { media: ContinuationMedia; videoUrl: string }): Promise<UploadByteSource>;
  /** Runs the upload against the provider. */
  runUpload(args: {
    record: YoutubeUploadSessionRecord;
    leaseToken: string;
    accessToken: string;
    source: UploadByteSource;
    totalBytes: number;
    deadlineMs: number;
  }): Promise<ResumableUploadOutcome>;
  /** Settles the public row through the publishing seam. */
  settlePlatformPost(args: {
    platformPostId: string | null;
    postId: string;
    socialAccountId: string;
    platform: string;
    status: "success" | "failed";
    providerPostId: string | null;
    providerPostUrl: string | null;
    errorMessage: string | null;
    responseData: Record<string, unknown>;
  }): Promise<void>;
  /** Schedules the next look at the session. */
  scheduleNextCheck(args: {
    sessionId: string;
    leaseToken: string;
    confirmedBytes: number;
    bytesSent: number;
    videoMayExist: boolean;
    nextCheckAt: string;
    lastOutcome: string;
  }): Promise<void>;
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
    default:
      return YOUTUBE_UPLOAD_REASON.unknown;
  }
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
  if (request.attemptStartedAt && post.processingStartedAt !== request.attemptStartedAt) {
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
  if (session.attemptStartedAt && post.processingStartedAt !== session.attemptStartedAt) {
    return refused(YOUTUBE_UPLOAD_REASON.stale_attempt);
  }

  // ───────────────────────────────────────────────────────────────────────
  // The receipt-only recovery.
  //
  // The video exists. It is projected onto the public row and the post is
  // settled. No media is read, no provider is called, and no other platform
  // is touched.
  // ───────────────────────────────────────────────────────────────────────
  if (session.videoId) {
    await settle(ports, session, post, {
      status: "success",
      providerPostId: session.videoId,
      errorMessage: null,
      responseData: { youtube_video_id: session.videoId, youtube_upload_source: "receipt_recovery" },
    });
    return { status: "completed", reason: YOUTUBE_UPLOAD_REASON.completed, videoId: session.videoId };
  }

  const account = await ports.loadAccount(session.socialAccountId);
  if (!isUsableAccount(account, post)) {
    return refused(YOUTUBE_UPLOAD_REASON.account_unusable);
  }

  if (!session.sessionUri) {
    // A continuation carries an existing session on. It never opens a new
    // one, because a new session could create a second video.
    return refused(YOUTUBE_UPLOAD_REASON.session_not_open);
  }

  if (!post.selectedAccountIds.includes(session.socialAccountId)) {
    // The post no longer selects this account. Sending would publish to an
    // account the customer took out of the post.
    return refused(YOUTUBE_UPLOAD_REASON.account_unusable);
  }

  const media = await loadMatchingMedia(ports, session, post);
  if (!media) return refused(YOUTUBE_UPLOAD_REASON.media_unavailable);

  const { leaseToken } = request;
  const { accessToken } = account;
  const source = await ports.createSource({ media, videoUrl: media.filePath });
  const outcome = await ports.runUpload({
    record: session,
    leaseToken,
    accessToken,
    source,
    totalBytes: session.totalBytes,
    deadlineMs: ports.now() + YOUTUBE_CONTINUATION_LEASE_MS,
  });

  return await interpretOutcome({ ports, request, session, post, outcome });
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
 * The file must still be named by the post, still belong to the owner, and
 * still be the same version. A replaced file is a different video.
 */
async function loadMatchingMedia(
  ports: YoutubeContinuationPorts,
  session: YoutubeUploadSessionRecord,
  post: ContinuationPost,
): Promise<ContinuationMedia | null> {
  if (!session.mediaFileId || !post.mediaFileIds.includes(session.mediaFileId)) return null;
  const media = await ports.loadMedia(session.mediaFileId);
  if (!media || media.userId !== post.userId) return null;
  if (session.mediaObjectVersion !== null && media.currentObjectVersion !== session.mediaObjectVersion) {
    // The file was replaced. The bytes of the upload belong to the old
    // version, and the old version is not what the post names any more.
    return null;
  }
  return media;
}

/** Settles the public row through the publishing seam. */
async function settle(
  ports: YoutubeContinuationPorts,
  session: YoutubeUploadSessionRecord,
  post: ContinuationPost,
  args: {
    status: "success" | "failed";
    providerPostId: string | null;
    errorMessage: string | null;
    responseData: Record<string, unknown>;
  },
): Promise<void> {
  await ports.settlePlatformPost({
    platformPostId: session.platformPostId,
    postId: post.id,
    socialAccountId: session.socialAccountId,
    platform: "youtube",
    status: args.status,
    providerPostId: args.providerPostId,
    providerPostUrl: args.providerPostId ? `https://www.youtube.com/watch?v=${args.providerPostId}` : null,
    errorMessage: args.errorMessage,
    responseData: args.responseData,
  });
}

/**
 * Turns the outcome of one upload attempt into the public result.
 *
 * A completed upload settles the row as a success. A resumable one leaves the
 * row pending and the post processing, and says when the session may be
 * looked at again. Everything else settles the row as failed, so the post
 * rolls up and the customer is told the truth.
 */
async function interpretOutcome(args: {
  ports: YoutubeContinuationPorts;
  request: YoutubeContinuationRequest;
  session: YoutubeUploadSessionRecord;
  post: ContinuationPost;
  outcome: ResumableUploadOutcome;
}): Promise<ContinuationResult> {
  const { ports, request, session, post, outcome } = args;
  const { leaseToken } = request;

  if (outcome.kind === "completed") {
    await settle(ports, session, post, {
      status: "success",
      providerPostId: outcome.videoId,
      errorMessage: null,
      responseData: { youtube_video_id: outcome.videoId, youtube_upload_source: "continuation" },
    });
    return { status: "completed", reason: YOUTUBE_UPLOAD_REASON.completed, videoId: outcome.videoId };
  }

  if (outcome.kind === "resumable") {
    // The upload continues. The public row stays pending, the post stays
    // processing, and the session says when it may be looked at again.
    const delay = outcome.nextCheckAtMs ?? ports.now() + 60_000;
    const nextCheckAt = new Date(delay).toISOString();
    await ports.scheduleNextCheck({
      sessionId: session.id,
      leaseToken,
      confirmedBytes: outcome.confirmedBytes,
      bytesSent: session.bytesSent,
      videoMayExist: session.videoMayExist,
      nextCheckAt,
      lastOutcome: YOUTUBE_UPLOAD_REASON.resumable,
    });
    return {
      status: "pending",
      reason: YOUTUBE_UPLOAD_REASON.resumable,
      nextCheckAt,
    };
  }

  const reason = outcome.kind === "unsent"
    ? YOUTUBE_UPLOAD_REASON.unsent
    : outcome.kind === "reconcile"
    ? outcome.reason
    : outcome.kind === "abandoned"
    ? YOUTUBE_UPLOAD_REASON.lease_conflict
    : outcome.reason;

  await settle(ports, session, post, {
    status: "failed",
    providerPostId: null,
    errorMessage: reason,
    responseData: { youtube_upload_reason: reason },
  });

  return { status: "failed", reason };
}
