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
   */
  | { kind: "unknown"; reason: string };

/** What the whole upload attempt ended as. */
export type ResumableUploadOutcome =
  /** The video exists and this is its id. */
  | { kind: "completed"; videoId: string }
  /** The upload can continue later, in this session, from `confirmedBytes`. */
  | { kind: "resumable"; confirmedBytes: number; reason: string }
  /** Nothing was ever written, so no video exists and a fresh attempt is safe. */
  | { kind: "unsent"; reason: string }
  /** The provider may hold a video nobody has a receipt for. A human decides. */
  | { kind: "reconcile"; reason: string }
  /** The upload failed for good. `retryable` says whether a fresh attempt is safe. */
  | { kind: "failed"; message: string; retryable: boolean }
  /** Another worker owns the session. This worker must not write anything. */
  | { kind: "abandoned"; reason: string };

/** The durable state of one upload, as the store keeps it. */
export interface YoutubeUploadSessionRecord {
  id: string;
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
  | "invalid_size";

/** The durable store the upload keeps its state in. */
export interface YoutubeUploadSessionStore {
  /**
   * The session for this post and account, opened or reopened as the store's
   * rules allow. `refused` explains a refusal; the caller must not write
   * anything when it is set.
   */
  begin(input: BeginUploadSession): Promise<{ record: YoutubeUploadSessionRecord | null; refused: YoutubeUploadRefusal | null }>;
  /** Takes the session for one worker. `refused` is set when another worker owns it. */
  claim(input: ClaimUploadSession): Promise<{ record: YoutubeUploadSessionRecord | null; refused: YoutubeUploadRefusal | null }>;
  /** Records confirmed progress and, when the session was just opened, the session URI. */
  checkpoint(input: CheckpointUploadSession): Promise<boolean>;
  /** Records the receipt. The receipt is kept: it is what stops a duplicate video. */
  complete(input: CompleteUploadSession): Promise<boolean>;
  /** Records a terminal state that is not a receipt. */
  release(input: ReleaseUploadSession): Promise<boolean>;
}

export interface BeginUploadSession {
  postId: string;
  socialAccountId: string;
  platformPostId: string | null;
  mediaFileId: string | null;
  mediaObjectVersion: number | null;
  mediaSize: number;
  totalBytes: number;
  /** The video resource that was sent to the provider. */
  uploadBody: Record<string, unknown>;
  userId: string;
}

export interface ClaimUploadSession {
  sessionId: string;
  leaseToken: string;
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
   */
  read(start: number, end: number): Promise<ArrayBuffer>;
}

/** Everything the upload needs from the outside world. */
export interface ResumableUploadDeps {
  fetchImpl: typeof fetch;
  store: YoutubeUploadSessionStore;
  session: YoutubeUploadSessionRecord;
  leaseToken: string;
  accessToken: string;
  source: UploadByteSource;
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
  if (trimmed === "") return 0;
  const match = /^bytes=(\d+)-(\d+)$/.exec(trimmed);
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return null;
  if (start < 0 || end < start) return null;
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
 * Removes the credential out of arbitrary text.
 *
 * A provider error can echo the request it refused, and the request carries
 * the session URI. The `upload_id` is what makes that URI a credential, so
 * it is the part that is taken out. The rest of the message is kept, because
 * it is what tells the customer what went wrong.
 */
export function redactResumableCredentials(text: string): string {
  return text.replace(/(upload_id=)[^&\s"'<>]+/gi, "$1***");
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
 * The writes one file is split into.
 *
 * Every chunk but the last carries exactly `chunkBytes`, and `chunkBytes` is a
 * multiple of 256 KiB, which is what the provider asks for. The last chunk
 * carries whatever is left.
 */
export function planUploadChunks(totalBytes: number, chunkBytes: number = YOUTUBE_RESUMABLE_CHUNK_BYTES): UploadChunk[] {
  if (!Number.isSafeInteger(totalBytes) || totalBytes <= 0) {
    throw new Error("The video has no bytes to upload.");
  }
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes <= 0) {
    throw new Error("The upload chunk size is not usable.");
  }
  if (chunkBytes % YOUTUBE_CHUNK_GRANULARITY_BYTES !== 0) {
    throw new Error("The upload chunk size must be a multiple of 256 KiB.");
  }
  const chunks: UploadChunk[] = [];
  let offset = 0;
  while (offset < totalBytes) {
    const size = Math.min(chunkBytes, totalBytes - offset);
    chunks.push({ start: offset, end: offset + size - 1, size });
    offset += size;
  }
  return chunks;
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
 * What one provider answer means.
 *
 * The classification is deliberately strict. An answer that does not fit the
 * protocol is `unknown`, never `accepted` and never `resumable`: the video
 * may exist, and a video that may exist is never uploaded again.
 */
export function classifyProviderStatus(input: ProviderStatusInput): ProviderUploadStatus {
  const { status, totalBytes } = input;

  if (status >= 200 && status < 300) {
    const videoId = readVideoIdFromBody(input.bodyText);
    if (videoId) return { kind: "accepted", videoId };
    // The provider says it is done but names no video. The video may exist.
    return { kind: "unknown", reason: "The provider accepted the upload without a usable video id." };
  }

  if (status === 308) {
    const confirmed = parseProviderRange(input.rangeHeader);
    if (confirmed === null) {
      return { kind: "unknown", reason: "The provider sent a range this upload cannot parse." };
    }
    if (confirmed > totalBytes) {
      return { kind: "unknown", reason: "The provider reported more bytes than the video has." };
    }
    if (confirmed < input.previousConfirmedBytes) {
      // The provider now holds fewer bytes than it confirmed earlier. One of
      // the two records is wrong, and a resume from either could write a
      // block the provider will refuse. Nothing more is written.
      return { kind: "unknown", reason: "The provider reported fewer bytes than were already confirmed." };
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
    return { kind: "unknown", reason: `The provider answered ${status}.` };
  }

  if (status >= 500) {
    return { kind: "unknown", reason: `The provider answered ${status}.` };
  }

  if (status >= 400) {
    return { kind: "rejected", status, message: "The provider refused the upload." };
  }

  return { kind: "unknown", reason: `The provider answered ${status}.` };
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
): Promise<ProviderUploadStatus> {
  const bodyText = response.status >= 200 && response.status < 300 ? await readBodyText(response) : "";
  return classifyProviderStatus({
    status: response.status,
    rangeHeader: response.headers.get("range"),
    bodyText,
    totalBytes,
    previousConfirmedBytes,
  });
}

/**
 * A provider request that never answered.
 *
 * The request may or may not have been stored, so this is an ambiguous write
 * and the status has to be asked for.
 */
function ambiguousWrite(reason: string): ProviderUploadStatus {
  return { kind: "unknown", reason };
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
 * Runs one native YouTube upload to a conclusion.
 *
 * The function never opens a session by itself: the store owns that decision,
 * because only the durable record can say whether a video may already exist
 * and whether a receipt is already there. What this owns is the writing: the
 * chunk plan, the status probe after an answer that did not move the offset
 * forward, and the refusal to write again once the provider may hold a
 * video.
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
 * Ends the upload and keeps the session in the state the reason implies.
 *
 * `expired` means the provider session is gone and no video can exist, so a
 * fresh attempt is safe. `failed` means the provider will not take the bytes
 * and no video exists either. `reconcile` means the provider may already have
 * made a video and only a human may decide.
 */
async function giveUp(
  context: UploadContext,
  state: "expired" | "reconcile" | "failed",
  reason: string,
): Promise<ResumableUploadOutcome> {
  await context.store.release({
    sessionId: context.sessionId,
    leaseToken: context.leaseToken,
    state,
    error: reason,
  });
  if (state === "reconcile") return { kind: "reconcile", reason };
  if (state === "expired") return { kind: "unsent", reason };
  return { kind: "failed", message: reason, retryable: true };
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
    return { kind: "abandoned", reason: "The receipt could not be stored." };
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
): Promise<AnswerResolution> {
  if (status.kind === "accepted") {
    return { kind: "outcome", outcome: await keepReceipt(context, status.videoId) };
  }

  if (status.kind === "rejected") {
    // A permanent refusal stores nothing, so no video exists -- unless the
    // last chunk may already have been written, which the durable flag says.
    const outcome = await giveUp(context, videoMayExist ? "reconcile" : "failed", status.message);
    return { kind: "outcome", outcome };
  }

  if (status.kind === "expired") {
    // The provider session is gone. Whether it turned the bytes into a video
    // depends on whether the last chunk was ever written: the flag says so,
    // and it is durable, so a worker that died mid-write is covered too.
    const reason = videoMayExist
      ? "The session expired after the last chunk may have been written."
      : "The session expired before the last chunk was written.";
    const outcome = await giveUp(context, videoMayExist ? "reconcile" : "expired", reason);
    return { kind: "outcome", outcome };
  }

  if (status.kind === "resumable" && status.confirmedBytes > offset) {
    return { kind: "offset", confirmedBytes: status.confirmedBytes, videoMayExist };
  }

  // The answer either left the offset where it was or did not answer at all.
  // The status is asked for, because a write that went unanswered may or may
  // not have been stored.
  const probed = await probeStatus(context, offset);

  if (probed.kind === "accepted") {
    // The provider had already finished the upload. This is the lost final
    // acknowledgement, and the receipt is still there to be read.
    return { kind: "outcome", outcome: await keepReceipt(context, probed.videoId) };
  }

  if (probed.kind === "rejected") {
    const outcome = await giveUp(context, videoMayExist ? "reconcile" : "failed", probed.message);
    return { kind: "outcome", outcome };
  }

  if (probed.kind === "expired") {
    const reason = videoMayExist
      ? "The session expired while the write was unconfirmed."
      : "The session expired before the last chunk was written.";
    const outcome = await giveUp(context, videoMayExist ? "reconcile" : "expired", reason);
    return { kind: "outcome", outcome };
  }

  if (probed.kind === "resumable") {
    return { kind: "offset", confirmedBytes: probed.confirmedBytes, videoMayExist };
  }

  // The provider would not say what happened. When the last chunk may already
  // have been written, a blind retry could write the same bytes into a video
  // that already exists, so a human decides. When it may not have been, no
  // video exists and a fresh attempt is safe.
  const outcome = await giveUp(context, videoMayExist ? "reconcile" : "failed", probed.reason);
  return { kind: "outcome", outcome };
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

  // A receipt that already exists is the answer. Nothing is uploaded again.
  if (session.videoId) {
    return { kind: "completed", videoId: session.videoId };
  }
  if (session.state === "uploaded") {
    return { kind: "reconcile", reason: "The upload is recorded as accepted but carries no receipt." };
  }
  if (session.state === "reconcile") {
    return { kind: "reconcile", reason: "The upload needs manual reconciliation." };
  }
  if (session.state === "failed") {
    return { kind: "failed", message: "The upload was already given up.", retryable: true };
  }

  let sessionUri = session.sessionUri;
  const confirmedBytes = Math.min(session.confirmedBytes, totalBytes);
  let bytesSent = Math.min(session.bytesSent, totalBytes);
  let videoMayExist = session.videoMayExist;

  if (!sessionUri) {
    // Nothing was ever written (the store only reopens a session it proved
    // is empty), so a fresh session cannot duplicate a video.
    if (bytesSent > 0) {
      return { kind: "reconcile", reason: "The upload has no session but bytes were written before." };
    }
    const opened = await openProviderSession(deps, totalBytes, mimeType, allowedHosts);
    if (opened.kind === "outcome") return opened.outcome;
    sessionUri = opened.sessionUri;
  }

  if (!isAllowedProviderUploadUri(sessionUri, allowedHosts)) {
    // The session URI is not one this worker may write to. Writing anyway
    // would send the OAuth token somewhere it does not belong.
    const context = buildContext(deps, session.id, sessionUri, totalBytes, mimeType, deadlineMs, now, sleep);
    return await giveUp(context, "reconcile", "The session uri was refused by the provider host policy.");
  }

  let chunks: UploadChunk[];
  try {
    chunks = planUploadChunks(totalBytes, deps.chunkBytes ?? YOUTUBE_RESUMABLE_CHUNK_BYTES);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await store.release({ sessionId: session.id, leaseToken, state: "failed", error: message });
    return { kind: "failed", message, retryable: false };
  }

  const context = buildContext(deps, session.id, sessionUri, totalBytes, mimeType, deadlineMs, now, sleep);

  /** The offset the next write starts at, taken from the provider's own answer. */
  let offset = confirmedBytes;
  /** How many answers in a row left the offset where it was. */
  let stalls = 0;

  while (offset < totalBytes) {
    if (now() >= deadlineMs) {
      return { kind: "resumable", confirmedBytes: offset, reason: "The worker ran out of time." };
    }

    const chunk = chunks.find((candidate) => candidate.start === offset);
    if (!chunk) {
      // The provider confirmed an offset that is not on the chunk plan. The
      // plan is a multiple of the chunk size, so this can only mean the two
      // disagree about the file.
      return await giveUp(context, "reconcile", "The confirmed offset is not on the upload plan.");
    }

    const bytes = await readChunkBytes(source, chunk);
    if (bytes === null) {
      return { kind: "resumable", confirmedBytes: offset, reason: "The video bytes could not be read." };
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
      return { kind: "abandoned", reason: "Another worker owns this upload." };
    }
    bytesSent = Math.max(bytesSent, chunk.end + 1);

    const status = await writeChunk(context, chunk, bytes, offset);
    const resolution = await resolveProviderAnswer(context, status, offset, videoMayExist);
    if (resolution.kind === "outcome") return resolution.outcome;

    // The provider says how much it holds. While it says it is short of the
    // whole file, no video can exist, so the flag is cleared.
    videoMayExist = resolution.videoMayExist && resolution.confirmedBytes >= totalBytes;
    if (resolution.confirmedBytes > offset) {
      stalls = 0;
    } else {
      stalls += 1;
      if (stalls >= 2) {
        return await giveUp(context, "reconcile", "The provider did not accept the bytes.");
      }
    }

    const advanced = await store.checkpoint({
      sessionId: session.id,
      leaseToken,
      confirmedBytes: resolution.confirmedBytes,
      bytesSent,
      videoMayExist,
    });
    if (!advanced) return { kind: "abandoned", reason: "Another worker owns this upload." };
    offset = resolution.confirmedBytes;
  }

  // Every byte is confirmed, but no receipt was read: the provider finished
  // the upload and the answer was lost. The status is asked for once more,
  // because that is where the receipt is.
  const final = await probeStatus(context, totalBytes);
  if (final.kind === "accepted") {
    return await keepReceipt(context, final.videoId);
  }
  if (final.kind === "resumable") {
    // The provider says it holds fewer bytes than were confirmed. The two
    // records disagree, so nothing more is written.
    return await giveUp(context, "reconcile", "The provider reported fewer bytes than were confirmed.");
  }
  return await giveUp(
    context,
    videoMayExist ? "reconcile" : "failed",
    "The upload finished but the provider did not return a receipt.",
  );
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
    const reason = error instanceof Error ? error.message : String(error);
    return { kind: "outcome", outcome: { kind: "failed", message: reason, retryable: true } };
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
    return { kind: "outcome", outcome: { kind: "abandoned", reason: "Another worker owns this upload." } };
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
): Promise<ArrayBuffer | null> {
  let bytes: ArrayBuffer;
  try {
    bytes = await source.read(chunk.start, chunk.end);
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
    const reason = error instanceof Error ? error.message : String(error);
    return ambiguousWrite(`The provider did not answer the write: ${reason}`);
  }

  if (response.status >= 300 && response.status < 400 && response.status !== 308) {
    // A redirect is not followed. The session URI stays where it was.
    return ambiguousWrite("The provider answered with a redirect, which is not followed.");
  }

  return readProviderStatus(response, context.totalBytes, previousConfirmedBytes);
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
): Promise<ProviderUploadStatus> {
  let lastReason = "The provider did not answer the status request.";

  for (let attempt = 0; attempt < YOUTUBE_MAX_PROBE_ATTEMPTS; attempt += 1) {
    if (context.now() >= context.deadlineMs) {
      return { kind: "unknown", reason: "The worker ran out of time while the status was being asked for." };
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
      const reason = error instanceof Error ? error.message : String(error);
      lastReason = `The provider did not answer the status request: ${reason}`;
      if (attempt + 1 < YOUTUBE_MAX_PROBE_ATTEMPTS) await context.sleep(YOUTUBE_PROBE_BACKOFF_MS);
      continue;
    }

    if (response.status >= 300 && response.status < 400 && response.status !== 308) {
      lastReason = "The provider answered the status request with a redirect, which is not followed.";
      if (attempt + 1 < YOUTUBE_MAX_PROBE_ATTEMPTS) await context.sleep(YOUTUBE_PROBE_BACKOFF_MS);
      continue;
    }

    const status = await readProviderStatus(response, context.totalBytes, previousConfirmedBytes);
    // A `rejected` status is an answer: the session is not usable.
    if (status.kind !== "unknown") return status;
    lastReason = status.reason;
    if (attempt + 1 < YOUTUBE_MAX_PROBE_ATTEMPTS) await context.sleep(YOUTUBE_PROBE_BACKOFF_MS);
  }

  return { kind: "unknown", reason: lastReason };
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
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`The provider did not answer the session request: ${reason}`);
  }

  if (response.status >= 300 && response.status < 400) {
    // A redirect is not followed: the OAuth token would travel with it.
    throw new Error("The provider answered the session request with a redirect, which is not followed.");
  }

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(
      redactResumableCredentials(uploadFailureMessage(response.status, errorData, response.statusText)),
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
