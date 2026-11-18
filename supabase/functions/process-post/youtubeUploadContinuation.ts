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
import { isUncertainUploadOutcome } from "./youtubeUploadOutcome.ts";

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
  /**
   * The size of the file as it is now.
   *
   * It has to be the size the upload started with: the upload resumes at an
   * offset that was established for one object, and a file of another size is
   * not that object.
   */
  fileSize: number | null;
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
   * It is only called when the upload has to WRITE, and only when the first
   * byte is asked for: a receipt-only recovery never reaches it, and neither
   * does a session whose video the provider turns out to hold already. So no
   * media is fetched for an upload that is already finished.
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
    /**
     * The type of the video, as the media library knows it.
     *
     * The chunks are declared with it, so a resumed upload has to declare the
     * type the first one declared. A MOV or a WebM that is resumed as an MP4
     * is refused by the provider, and the upload is left unresolved.
     */
    mimeType: string | null;
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

/**
 * How the scope of the attempt stands.
 *
 * The scope is the set of destinations the attempt owns. It becomes complete
 * when every one of them has a result row, and that is what lets the pending
 * evidence be removed.
 */
export type YoutubeFanoutScopeState = "closed" | "attempt_running" | "incomplete";

/** What the continuation ended as. */
export interface ContinuationResult {  /** The public outcome. */
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

/**
 * A source that opens the media only when the first byte is asked for.
 *
 * The provider is asked what it holds BEFORE the media is touched: an
 * inherited session is probed first, because the video may already exist and
 * the receipt is then worth more than the file. A media host that is down
 * cannot keep a receipt from being recovered, because the file is only
 * opened once the provider has confirmed that it needs more bytes.
 */
export function deferredUploadByteSource(
  resolve: () => Promise<UploadByteSource>,
  size: number,
): UploadByteSource {
  let opened: Promise<UploadByteSource> | null = null;
  return {
    size,
    async read(start: number, end: number, timeoutMs?: number): Promise<ArrayBuffer> {
      // The media is opened once, and every chunk reads from that one open.
      opened ??= resolve();
      const source = await opened;
      return await source.read(start, end, timeoutMs);
    },
  };
}

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
    case "session_not_found":
      // There is no session to continue. The caller is told the session is not
      // there, not that the outcome is unknown: nothing will ever be sent, so
      // the next pass has nothing to look at.
      return YOUTUBE_UPLOAD_REASON.not_found;
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
  //
  // A dispatch WITHOUT an attempt has no fence to compare, and a fence that
  // cannot be compared does not hold: the continuation is refused. The route
  // refuses such a dispatch before it gets here, so this is the second line.
  if (!request.attemptStartedAt) {
    return refused(YOUTUBE_UPLOAD_REASON.stale_attempt);
  }
  if (!sameAttemptTimestamp(post.processingStartedAt, request.attemptStartedAt)) {
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
  // to an older attempt is never carried on, and a session that carries no
  // attempt at all cannot be compared with the post's, so it is refused too:
  // the fence has to hold, and it cannot hold what it cannot compare.
  if (!session.attemptStartedAt || !sameAttemptTimestamp(post.processingStartedAt, session.attemptStartedAt)) {
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
    const recovery = await recoverFanout(ports, session.id, request.leaseToken);
    if (recovery.scopeState === "incomplete") {
      return scopeIncomplete(ports, YOUTUBE_UPLOAD_REASON.reconcile);
    }
    const projected = await ports.projectReceipt({ sessionId: session.id });
    if (!projected.settled) {
      return refused(refusalToReason(projected.refused ?? "session_not_found"));
    }
    return { status: "completed", reason: YOUTUBE_UPLOAD_REASON.completed, videoId: session.videoId };
  }

  if (!session.socialAccountId) {
    // The account was disconnected.
    //
    // The session keeps its evidence, because a video may exist, but there is
    // no account to carry the upload on to and no credential to send. The
    // session is terminal already, so nothing is written here.
    return refused(YOUTUBE_UPLOAD_REASON.account_disconnected);
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
      // The session cannot be carried on, and the provider may already hold a
      // video. The attempt ends here, and the outcome is recorded: the row
      // was admitted before the provider was contacted, so it exists, and a
      // row that stays pending for ever is a publication the customer never
      // sees finish.
      return await refusePermanently({
        ports,
        session,
        leaseToken: request.leaseToken,
        reason: YOUTUBE_UPLOAD_REASON.reconcile,
      });
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
    return await refusePermanently({
      ports,
      session,
      leaseToken: request.leaseToken,
      reason: media.reason ?? YOUTUBE_UPLOAD_REASON.media_unavailable,
    });
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

  // The media is NOT opened here.
  //
  // The provider is asked what it holds first, and the file is only opened
  // once the provider has confirmed that it needs more bytes. A receipt that
  // YouTube can return is worth more than a file that a media host may not be
  // able to serve right now: an inherited session whose video already exists
  // is settled without touching the media at all.
  //
  // The checks above still run before anything is sent, so a file that is gone,
  // replaced or still being scanned is refused before the provider is asked.
  const mediaFile = media.media;

  // The live state is asked about AGAIN once the media is open.
  //
  // Opening the media reaches the media host, so it is an awaited operation
  // that can take seconds. Between the check above and the first byte, the
  // customer may cancel or edit the post, remove the target account, or
  // replace the media. The first check says the world was right when it was
  // read; this one says it is right NOW.
  //
  // The source is opened lazily, inside the upload, so the check travels with
  // it: it runs before the first chunk is read, and therefore before the
  // first byte is written. A lost authority makes that read fail, which ends
  // the attempt WITHOUT a write, so nothing reaches the provider. The session
  // stays resumable, and the worker that looks at it again finds the refusal
  // at the check it makes before it writes anything.
  let authorityLost: YoutubeUploadReason | null = null;
  const source = deferredUploadByteSource(
    async () => {
      const opened = await ports.createSource({ media: mediaFile });
      const live = await ports.effectAuthority({ sessionId: session.id, leaseToken });
      if (!live.authorized) {
        authorityLost = effectAuthorityReason(live.reason);
        throw new Error("the live state no longer allows the upload");
      }
      return opened;
    },
    session.totalBytes,
  );

  // What an attempt does when the authority was lost while the media was
  // being opened. The upload ended without a write, so nothing reached the
  // provider, and the attempt stops here instead of waiting for another
  // worker to find the same thing.
  const stopOnLostAuthority = async (): Promise<ContinuationResult | null> =>
    await stopOnLostAuthorityAttempt({ ports, session, leaseToken, lost: authorityLost });

  let outcome: ResumableUploadOutcome;
  try {
    outcome = await ports.runUpload({
      record: session,
      leaseToken,
      accessToken,
      source,
      totalBytes: session.totalBytes,
      deadlineMs: ports.now() + YOUTUBE_CONTINUATION_LEASE_MS,
      // The type of the video, as the media library knows it. The chunks of a
      // resumed upload are declared with it, so the continuation declares the
      // type the first upload declared.
      mimeType: mediaFile.mimeType,
    });
  } catch (error) {
    // The upload threw. The read of the first chunk fails when the authority
    // was lost, so this is where that ends up.
    const stopped = await stopOnLostAuthority();
    if (stopped) return stopped;
    throw error;
  }

  const stopped = await stopOnLostAuthority();
  if (stopped) return stopped;

  return await interpretOutcome({ ports, request, session, outcome, post, accessToken });
}

/**
 * What an attempt does when the live state was lost while the media opened.
 *
 * The upload ended without a write, so nothing reached the provider. The
 * attempt stops here instead of waiting for another worker to find the same
 * thing. A media that is still being scanned is not a failure: it waits.
 */
async function stopOnLostAuthorityAttempt(args: {
  ports: YoutubeContinuationPorts;
  session: YoutubeUploadSessionRecord;
  leaseToken: string;
  /** The reason the authority was lost, or null when it was not. */
  lost: YoutubeUploadReason | null;
}): Promise<ContinuationResult | null> {
  const { ports, session, leaseToken, lost } = args;
  if (lost === null) return null;
  if (lost === YOUTUBE_UPLOAD_REASON.resumable) {
    return {
      status: "pending",
      reason: YOUTUBE_UPLOAD_REASON.resumable,
      nextCheckAt: new Date(ports.now() + YOUTUBE_CONTINUATION_MIN_DELAY_MS).toISOString(),
    };
  }
  return await refusePermanently({ ports, session, leaseToken, reason: lost });
}

/** The continuation stops here, and says why. */
function refused(reason: YoutubeUploadReason): ContinuationResult {
  return { status: "refused", reason };
}

/**
 * Records a refusal that ends the attempt.
 *
 * The public row was admitted before the provider was contacted, so it exists
 * and it belongs to this attempt. A PERMANENT refusal has to close it: a row
 * that stays pending for ever is a publication the customer never sees
 * finish, and the post keeps a worker that reclaims it again and again.
 *
 * The uncertain evidence is kept. A refusal that says the provider may already
 * hold a video carries the marker, so the retry gate and the retry button both
 * refuse to offer a blind retry, and the session becomes one a human decides.
 *
 * A refusal that is NOT permanent leaves the row alone: another worker owns
 * the session, the post moved on to a newer attempt, or the account may be
 * reconnected. The worker that owns the row decides what happens to it.
 */
async function refusePermanently(args: {
  ports: YoutubeContinuationPorts;
  session: YoutubeUploadSessionRecord;
  leaseToken: string;
  reason: YoutubeUploadReason;
}): Promise<ContinuationResult> {
  const { ports, session, leaseToken, reason } = args;
  // The marker follows the DURABLE rule, not the reason of this refusal.
  //
  // The session knows whether a video may exist: the flag is set when the
  // last chunk may have been written, and it only ever grows. A refusal that
  // happens on such a session is not a proof, so it carries the marker: the
  // retry gate and the retry button both refuse to offer a blind retry,
  // because a second attempt could publish a second video.
  //
  // The reason adds its own case: a session that lost its provider session
  // after writing bytes may hold a video the flag never learned about.
  const uncertain = reason === YOUTUBE_UPLOAD_REASON.reconcile || session.videoMayExist;
  const settled = await ports.settleUpload({
    sessionId: session.id,
    leaseToken,
    status: "failed",
    videoId: null,
    errorMessage: reason,
    responseData: {
      youtube_upload_reason: reason,
      ...(uncertain ? { publish_outcome: "uncertain" } : {}),
    },
  });
  if (!settled.settled) {
    // The lease is gone, so the outcome is not recorded here. The worker that
    // owns the session now decides what happens to the row.
    return { status: "refused", reason: YOUTUBE_UPLOAD_REASON.lease_conflict };
  }
  return { status: "failed", reason };
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
  if (session.mediaObjectVersion === null || media.currentObjectVersion === null ||
      media.currentObjectVersion !== session.mediaObjectVersion) {
    // The file was replaced. The bytes of the upload belong to the old
    // version, and the old version is not what the post names any more.
    //
    // A session that carries no version at all is refused the same way: the
    // fence has to hold, and it cannot hold what it cannot compare.
    return { media: null, reason: YOUTUBE_UPLOAD_REASON.media_unavailable };
  }
  if (media.fileSize !== null && media.fileSize !== session.totalBytes) {
    // The file is not the size the upload started with.
    //
    // The upload resumes at an offset that was established for one object. A
    // file of another size is not that object, and sending the rest of it
    // would publish bytes that do not belong to the video.
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
    //
    // The follow-ups are provider WRITES, so the live state is asked about
    // first: the lease says this worker owns the session, and it says nothing
    // about the post, the target or the content being what they were. A
    // post that was edited or cancelled while the video was being written is
    // not given a thumbnail and a comment.
    //
    // The receipt does not depend on that answer. The video exists, so it is
    // settled either way.
    const followUpAuthority = await ports.effectAuthority({ sessionId: session.id, leaseToken });
    if (followUpAuthority.authorized) {
      try {
        await ports.followUps({ post, videoId: outcome.videoId, accessToken });
      } catch (error) {
        console.warn(
          `[youtube] the follow-ups for video ${outcome.videoId} did not finish:`,
          error instanceof Error ? error.message : String(error),
        );
      }
    } else {
      console.warn(
        `[youtube] the follow-ups for video ${outcome.videoId} were skipped:`,
        followUpAuthority.reason ?? "not authorized",
      );
    }

    // The fanout closure comes BEFORE the settlement.
    //
    // The pending YouTube row is what keeps the generic sweeper from reading
    // the absence of a sibling row as "this destination never started". So the
    // scope has to be settled while that row is still pending: the closure
    // then knows every destination of the attempt, and the sweeper never sees
    // a gap it could mistake for a proof.
    const recovery = await recoverFanout(ports, session.id, leaseToken);
    if (recovery.scopeState === "incomplete") {
      // The scope is not complete and nobody will complete it, so the pending
      // row stays: it is the only thing that keeps the sweeper from reading a
      // missing destination as one that never started.
      return scopeIncomplete(ports, YOUTUBE_UPLOAD_REASON.reconcile);
    }

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

  // The marker that says the provider's answer is not a proof.
  //
  // History and the API retry selector read publish_outcome, so a result
  // whose outcome is unknown is never offered as a retry: the provider may
  // already hold the video, and a blind retry could publish a second one.
  //
  // An upload that never sent a byte is a proven failure and stays
  // retryable, and a provider that refused the upload has answered, so that
  // one is a proof as well.
  const uncertain = isUncertainUploadOutcome(outcome);

  // The fanout closure comes BEFORE the settlement, for the same reason as
  // above: the pending YouTube row is what keeps the generic sweeper from
  // reading the absence of a sibling row as a proof that the sibling never
  // started.
  const recovery = await recoverFanout(ports, session.id, leaseToken);
  if (recovery.scopeState === "incomplete") {
    return scopeIncomplete(ports, YOUTUBE_UPLOAD_REASON.reconcile);
  }

  const settled = await ports.settleUpload({
    sessionId: session.id,
    leaseToken,
    status: "failed",
    videoId: null,
    errorMessage: reason,
    responseData: {
      youtube_upload_reason: reason,
      ...(uncertain ? { publish_outcome: "uncertain" } : {}),
    },
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
 * The lease travels with it: the closure runs while this worker still owns the
 * session, and the token is what proves it. A closure without the token is
 * refused by the database, and the row would become terminal with the fanout
 * still open.
 */
async function recoverFanout(
  ports: YoutubeContinuationPorts,
  sessionId: string,
  leaseToken: string,
): Promise<{ scopeState: YoutubeFanoutScopeState; reason: string | null }> {
  try {
    const recovered = await ports.recoverFanout({ sessionId, leaseToken });
    const scopeState = scopeStateOf(recovered);
    if (scopeState === "incomplete") {
      console.warn(
        `[youtube] the fanout of session ${sessionId} was not closed:`,
        recovered.reason ?? "unknown reason",
      );
    }
    return { scopeState, reason: recovered.reason };
  } catch (error) {
    // A closure that could not be run at all leaves the scope unknown, and an
    // unknown scope is an incomplete one: the pending evidence stays.
    console.warn(
      `[youtube] the fanout of session ${sessionId} could not be closed:`,
      error instanceof Error ? error.message : String(error),
    );
    return { scopeState: "incomplete", reason: null };
  }
}

/**
 * How the scope of the attempt stands, read from the recovery's verdict.
 *
 * The recovery answers with a stable reason, and the reason says what the
 * scope is:
 *
 *   * it closed the scope -- every destination of the attempt has a result row,
 *     so the scope is complete and the pending evidence may be removed;
 *   * the attempt may still be running -- the scope is open on purpose, and
 *     the worker of the attempt is going to complete it;
 *   * anything else -- the scope could not be proven complete and nobody will
 *     complete it, so the pending row stays: it is the only thing that keeps
 *     the sweeper from reading a missing destination as one that never
 *     started.
 */
export function scopeStateOf(recovery: {
  /** Whether the closure closed the scope. */
  recovered: boolean;
  /** Why it did not, when it did not. */
  reason: string | null;
}): YoutubeFanoutScopeState {
  if (recovery.recovered) return "closed";
  if (recovery.reason === "attempt_may_still_be_running") return "attempt_running";
  return "incomplete";
}

/**
 * The answer when the scope of the attempt is not complete.
 *
 * The pending row is the protection: it is what keeps the sweeper from
 * reading a missing destination as one that never started. So the row stays
 * pending, the attempt stays open, and the next reconciliation looks again.
 */
function scopeIncomplete(
  ports: YoutubeContinuationPorts,
  reason: YoutubeUploadReason,
): ContinuationResult {
  return {
    status: "pending",
    reason,
    nextCheckAt: new Date(ports.now() + YOUTUBE_CONTINUATION_MIN_DELAY_MS).toISOString(),
  };
}
