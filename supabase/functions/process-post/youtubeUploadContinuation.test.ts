/**
 * The worker that carries a YouTube upload on.
 *
 * The rules it keeps are the ones that keep a second video off the
 * customer's channel, and they are checked here in the order they matter:
 *
 *   * the post must still be the one that is being worked on, and it must
 *     still be on the attempt the upload belongs to;
 *   * a receipt that is already stored is projected onto the public row
 *     WITHOUT reading any media and WITHOUT calling the provider;
 *   * sending needs an account the run resolved, that belongs to the post
 *     owner, and that is usable;
 *   * sending needs a media file the post still names, that belongs to the
 *     owner, and that is still the version the upload started with.
 *
 * The distinction between settling a receipt and sending bytes is the one
 * that matters most: settling is safe even when the account can no longer
 * publish, and sending is not.
 *
 * And the rule that matters most of all: a worker that LOST ITS LEASE
 * writes nothing. The worker that took over may already have written the
 * video.
 */

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  continueYoutubeUpload,
  scopeStateOf,
  YOUTUBE_LEASE_END_MARGIN_MS,
  type ContinuationAccount,
  type ContinuationMedia,
  type ContinuationPost,
  type YoutubeContinuationPorts,
} from "./youtubeUploadContinuation.ts";
import type {
  ResumableUploadOutcome,
  UploadByteSource,
  YoutubeUploadRefusal,
  YoutubeUploadSessionRecord,
} from "./youtubeResumableUpload.ts";
import { YOUTUBE_UPLOAD_REASON } from "./youtubeUploadPolicy.ts";

const POST_ID = "post-1";
const ACCOUNT_ID = "account-1";
const OTHER_ACCOUNT_ID = "account-2";
const USER_ID = "user-1";
const MEDIA_ID = "media-1";
const PLATFORM_POST_ID = "platform-post-1";
const ATTEMPT = "2026-11-18T00:00:00.000Z";
const VIDEO_ID = "abcdefghijk";
/** The clock this world runs on. */
const NOW_MS = 1_700_000_000_000;

/** What the fake outside world was asked to do. */
interface World {
  ports: YoutubeContinuationPorts;
  mediaReads: number;
  /** The owner filters the continuation asked the media query to apply. */
  mediaOwnerFilters: string[];
  uploads: number;
  /** The terminal outcomes the worker tried to record. */
  settled: Array<{
    status: string;
    videoId: string | null;
    errorMessage: string | null;
    responseData: Record<string, unknown>;
  }>;
  /** The receipts the worker projected. */
  projected: string[];
  /** The videos the worker did the follow-ups for. */
  followUps: string[];
  /** How often the fanout closure was driven. */
  fanoutRecoveries: string[];
  /** The lease tokens the fanout closure was given. */
  recoveryLeaseTokens: Array<string | null>;
  /** The types of video the uploads were declared with. */
  uploadMimeTypes: Array<string | null>;
  /** The deadlines the uploads were given. */
  uploadDeadlines: number[];
  /** The order the worker did the things that touch the public row. */
  timeline: string[];
  /** How often the live state was asked about. */
  authorityChecks: number;
}

interface WorldOptions {
  post?: Partial<ContinuationPost>;
  account?: Partial<ContinuationAccount>;
  media?: Partial<ContinuationMedia>;
  session?: Partial<YoutubeUploadSessionRecord>;
  outcome?: ResumableUploadOutcome;
  claimRefused?: YoutubeUploadRefusal | null;
  /** The refusal the store answers a settlement with. */
  settleRefused?: YoutubeUploadRefusal | null;
  /** The refusal the store answers a projection with. */
  projectRefused?: YoutubeUploadRefusal | null;
  /** The verdict the store answers the write-authority question with. */
  authority?:
    | { authorized: boolean; reason: string | null }
    /**
     * The verdicts of several checks, in order.
     *
     * The live state is asked about more than once: before the bytes are
     * written, and again before the follow-ups. A list answers each question
     * with its own verdict, and the last one answers every question after it.
     */
    | Array<{ authorized: boolean; reason: string | null }>;
  /** What the upload attempt does when it runs. */
  runUpload?: (args: { source: UploadByteSource }) => Promise<ResumableUploadOutcome>;
  /** The answer the store gives the fanout closure. */
  fanout?: { recovered: boolean; reason: string | null };
}

function world(options: WorldOptions = {}): World {
  const post: ContinuationPost = {
    id: POST_ID,
    userId: USER_ID,
    status: "processing",
    processingStartedAt: ATTEMPT,
    selectedAccountIds: [ACCOUNT_ID],
    mediaFileIds: [MEDIA_ID],
    thumbnailUrl: null,
    firstComment: null,
    metadata: {
      youtube_made_for_kids: false,
      youtube_contains_synthetic_media: false,
      youtube_declaration_proof: { version: 3, made_for_kids: false, contains_synthetic_media: false, source: "form" },
    },
    ...options.post,
  };
  const account: ContinuationAccount = {
    id: ACCOUNT_ID,
    userId: USER_ID,
    channelId: "UCfixturechannel000000001",
    platform: "youtube",
    isActive: true,
    accessToken: "token-1",
    needsReauth: false,
    ...options.account,
  };
  const media: ContinuationMedia = {
    id: MEDIA_ID,
    userId: USER_ID,
    currentObjectVersion: 1,
    fileSize: 100,
    filePath: "postora/user/video.mp4",
    storageBucket: "postora",
    workspaceId: null,
    mimeType: "video/mp4",
    scanState: "available",
    ...options.media,
  };
  const session: YoutubeUploadSessionRecord = {
    id: "session-1",
    postId: POST_ID,
    socialAccountId: ACCOUNT_ID,
    state: "open",
    sessionUri: "https://www.googleapis.com/upload?upload_id=secret",
    confirmedBytes: 0,
    bytesSent: 0,
    videoMayExist: false,
    totalBytes: 100,
    videoId: null,
    sessionExpiresAt: null,
    // The lease the claim granted, ending a hundred and twenty seconds after
    // the clock this world runs on.
    leaseExpiresAt: new Date(NOW_MS + 120_000).toISOString(),
    attemptStartedAt: ATTEMPT,
    nextCheckAt: null,
    lastOutcome: null,
    platformPostId: PLATFORM_POST_ID,
    mediaFileId: MEDIA_ID,
    mediaObjectVersion: 1,
    continuationCount: 0,
    uploadBody: { snippet: { title: "A video" } },
    uploadSettings: { part: "snippet,status", notifySubscribers: false },
    resolvedPlatform: "youtube",
    targetAccountIds: [ACCOUNT_ID],
    ...options.session,
  };

  const world: World = {
    mediaReads: 0,
    mediaOwnerFilters: [],
    uploads: 0,
    settled: [],
    projected: [],
    followUps: [],
    fanoutRecoveries: [],
    recoveryLeaseTokens: [],
    uploadMimeTypes: [],
    uploadDeadlines: [],
    timeline: [],
    authorityChecks: 0,
    ports: {
      loadPost() {
        return Promise.resolve(post);
      },
      loadAccount() {
        return Promise.resolve(account);
      },
      loadMedia(_mediaFileId, expectedOwnerId) {
        world.mediaOwnerFilters.push(expectedOwnerId);
        return Promise.resolve(media);
      },
      claimSession() {
        if (options.claimRefused) {
          return Promise.resolve({ record: null, refused: options.claimRefused });
        }
        return Promise.resolve({ record: session, refused: null });
      },
      createSource() {
        world.mediaReads += 1;
        const source: UploadByteSource = {
          size: 100,
          read() {
            return Promise.resolve(new ArrayBuffer(1));
          },
        };
        return Promise.resolve(source);
      },
      runUpload(args) {
        world.uploads += 1;
        world.uploadMimeTypes.push(args.mimeType ?? null);
        world.uploadDeadlines.push(args.deadlineMs);
        if (options.runUpload) return options.runUpload(args);
        return Promise.resolve(options.outcome ?? { kind: "completed", videoId: VIDEO_ID });
      },
      settleUpload(args) {
        if (options.settleRefused) {
          return Promise.resolve({ settled: false, refused: options.settleRefused });
        }
        world.timeline.push("settle");
        world.settled.push({
          status: args.status,
          videoId: args.videoId ?? null,
          errorMessage: args.errorMessage ?? null,
          responseData: args.responseData ?? {},
        });
        return Promise.resolve({ settled: true, refused: null });
      },
      projectReceipt(args) {
        if (options.projectRefused) {
          return Promise.resolve({ settled: false, refused: options.projectRefused, videoId: null });
        }
        world.timeline.push("project");
        world.projected.push(args.sessionId);
        return Promise.resolve({ settled: true, refused: null, videoId: session.videoId });
      },
      followUps(args) {
        world.followUps.push(args.videoId);
        return Promise.resolve();
      },
      effectAuthority() {
        world.authorityChecks += 1;
        const verdicts = options.authority;
        if (Array.isArray(verdicts)) {
          const verdict = verdicts[Math.min(world.authorityChecks - 1, verdicts.length - 1)];
          return Promise.resolve(verdict);
        }
        return Promise.resolve(verdicts ?? { authorized: true, reason: null });
      },
      recoverFanout(args) {
        world.timeline.push("recover");
        world.fanoutRecoveries.push(args.sessionId);
        world.recoveryLeaseTokens.push(args.leaseToken ?? null);
        return Promise.resolve(options.fanout ?? { recovered: true, reason: null });
      },
      now: () => NOW_MS,
    },
  };
  return world;
}

const request = {
  postId: POST_ID,
  sessionId: "session-1",
  leaseToken: "lease-1",
  attemptStartedAt: ATTEMPT,
};

Deno.test("equivalent timestamp encodings carry the same upload attempt", async () => {
  const postAttempt = "2026-11-18T02:00:00.1234+00:00";
  const dispatchAttempt = "2026-11-18T05:00:00.123400+03:00";
  const w = world({ post: { processingStartedAt: postAttempt }, session: { attemptStartedAt: "2026-11-18T02:00:00.123400Z" } });
  await continueYoutubeUpload(w.ports, { ...request, attemptStartedAt: dispatchAttempt });
  assertEquals(w.uploads, 1);
});

Deno.test("attempts a microsecond apart cannot continue each other's uploads", async () => {
  const w = world({
    post: { processingStartedAt: "2026-11-18T02:00:00.123400+00:00" },
    session: { attemptStartedAt: "2026-11-18T02:00:00.123401Z" },
  });
  const result = await continueYoutubeUpload(w.ports, { ...request, attemptStartedAt: "2026-11-18T02:00:00.123400Z" });
  assertEquals(result.reason, YOUTUBE_UPLOAD_REASON.stale_attempt);
  assertEquals(w.uploads, 0);
});

Deno.test("a receipt that is already stored settles the row without touching the provider", async () => {
  const w = world({ session: { state: "uploaded", videoId: VIDEO_ID } });
  const result = await continueYoutubeUpload(w.ports, request);

  assertEquals(result.status, "completed");
  assertEquals(result.videoId, VIDEO_ID);
  // No media was read and the provider was never called.
  assertEquals(w.mediaReads, 0);
  assertEquals(w.uploads, 0);
  // The receipt is PROJECTED, not settled again: the projection is the one
  // path that does not need a lease.
  assertEquals(w.projected.length, 1);
  assertEquals(w.projected[0], "session-1");
  assertEquals(w.settled.length, 0);
});

Deno.test("a receipt settles the row even when the account can no longer publish", async () => {
  const w = world({
    session: { state: "uploaded", videoId: VIDEO_ID },
    account: { needsReauth: true, accessToken: null },
  });
  const result = await continueYoutubeUpload(w.ports, request);
  assertEquals(result.status, "completed");
  assertEquals(w.uploads, 0);
});

Deno.test("a receipt that cannot be projected is refused", async () => {
  const w = world({
    session: { state: "uploaded", videoId: VIDEO_ID },
    projectRefused: "no_public_row",
  });
  const result = await continueYoutubeUpload(w.ports, request);
  assertEquals(result.status, "refused");
  assertEquals(result.reason, YOUTUBE_UPLOAD_REASON.not_found);
  assertEquals(w.uploads, 0);
});

Deno.test("a post that is no longer processing is refused", async () => {
  const w = world({ post: { status: "completed" } });
  const result = await continueYoutubeUpload(w.ports, request);
  assertEquals(result.status, "refused");
  assertEquals(result.reason, YOUTUBE_UPLOAD_REASON.superseded);
  assertEquals(w.uploads, 0);
  assertEquals(w.settled.length, 0);
});

Deno.test("an older attempt is refused", async () => {
  const w = world({ post: { processingStartedAt: "2026-11-18T01:00:00.000Z" } });
  const result = await continueYoutubeUpload(w.ports, request);
  assertEquals(result.status, "refused");
  assertEquals(result.reason, YOUTUBE_UPLOAD_REASON.stale_attempt);
  assertEquals(w.uploads, 0);
});

Deno.test("a session that belongs to an older attempt is refused", async () => {
  const w = world({ session: { attemptStartedAt: "2026-11-18T01:00:00.000Z" } });
  const result = await continueYoutubeUpload(w.ports, request);
  assertEquals(result.status, "refused");
  assertEquals(result.reason, YOUTUBE_UPLOAD_REASON.stale_attempt);
});

Deno.test("a dispatch without an attempt is refused", async () => {
  // The fence is the attempt, and a fence that cannot be compared does not
  // hold. The route refuses such a dispatch before it gets here; this is the
  // second line.
  const w = world();
  const result = await continueYoutubeUpload(w.ports, { ...request, attemptStartedAt: null });
  assertEquals(result.status, "refused");
  assertEquals(result.reason, YOUTUBE_UPLOAD_REASON.stale_attempt);
  assertEquals(w.uploads, 0);
  assertEquals(w.settled.length, 0);
});

Deno.test("a session that carries no attempt is refused", async () => {
  // The session's own fence has to hold too, and it cannot hold what it
  // cannot compare.
  const w = world({ session: { attemptStartedAt: null } });
  const result = await continueYoutubeUpload(w.ports, request);
  assertEquals(result.status, "refused");
  assertEquals(result.reason, YOUTUBE_UPLOAD_REASON.stale_attempt);
  assertEquals(w.uploads, 0);
  assertEquals(w.settled.length, 0);
});

Deno.test("a session that is not there is refused as not found", async () => {
  // There is no session to continue, so nothing will ever be sent. The caller
  // is told the session is not there, not that the outcome is unknown.
  const w = world({ claimRefused: "session_not_found" });
  const result = await continueYoutubeUpload(w.ports, request);
  assertEquals(result.status, "refused");
  assertEquals(result.reason, YOUTUBE_UPLOAD_REASON.not_found);
  assertEquals(w.uploads, 0);
});

Deno.test("an account that was disconnected is refused", async () => {
  // The session keeps its evidence, because a video may exist, but there is no
  // account to carry the upload on to and no credential to send.
  const w = world({ session: { socialAccountId: null } });
  const result = await continueYoutubeUpload(w.ports, request);
  assertEquals(result.status, "refused");
  assertEquals(result.reason, YOUTUBE_UPLOAD_REASON.account_disconnected);
  assertEquals(w.uploads, 0);
  assertEquals(w.settled.length, 0);
});

Deno.test("the type of the video reaches the upload", async () => {
  // The chunks of a resumed upload are declared with the type of the video,
  // so the continuation declares the type the first upload declared. A MOV or
  // a WebM that is resumed as an MP4 is refused by the provider.
  const w = world({ media: { mimeType: "video/quicktime" } });
  await continueYoutubeUpload(w.ports, request);
  assertEquals(w.uploadMimeTypes, ["video/quicktime"]);
});

Deno.test("a resumed upload declares the type the first attempt declared", async () => {
  // The media library may know no type at all by the time the upload
  // continues. The type the session was admitted with is the one the chunks
  // are declared with, so the provider is not told the video changed shape
  // halfway through.
  const w = world({
    media: { mimeType: null },
    session: {
      uploadSettings: { part: "snippet,status", notifySubscribers: false, mimeType: "video/quicktime" },
    },
  });
  await continueYoutubeUpload(w.ports, request);
  assertEquals(w.uploadMimeTypes, ["video/quicktime"]);
});

Deno.test("the upload deadline is the lease the claim granted", async () => {
  // The lease ends at an instant the DATABASE decided, before the slow calls
  // ran. A deadline of "now plus the lease length" would grant a whole second
  // lease after those calls, so this worker could still be writing to the
  // provider after its lease had expired -- and a reconciler that took the
  // session over would be writing at the same time.
  const w = world();
  await continueYoutubeUpload(w.ports, request);
  assertEquals(w.uploadDeadlines, [NOW_MS + 120_000 - YOUTUBE_LEASE_END_MARGIN_MS]);
});

Deno.test("a session with no lease to read is given no time to write", async () => {
  // A lease that cannot be read is a lease that cannot be shown to be live,
  // so the worker is given no time at all: the upload runner stops before it
  // writes a byte, and the next worker -- which reads the lease the same way
  // -- tries again.
  const w = world({ session: { leaseExpiresAt: null } });
  await continueYoutubeUpload(w.ports, request);
  assertEquals(w.uploadDeadlines, [NOW_MS]);
});

Deno.test("the live state is asked about again once the media is open", async () => {
  // Opening the media reaches the media host, so it takes seconds. The world
  // may change while it does: the customer may cancel the post, remove the
  // target, or replace the media. The first check says the world was right
  // when it was read; this one says it is right NOW.
  const w = world({
    authority: [
      { authorized: true, reason: null },
      { authorized: false, reason: "post_not_processing" },
    ],
    runUpload(args) {
      return args.source.read(0, 1).then(() => ({ kind: "completed", videoId: VIDEO_ID }));
    },
  });
  const result = await continueYoutubeUpload(w.ports, request);
  assertEquals(w.authorityChecks, 2);
  // The upload ended without a write, so nothing reached the provider, and
  // the attempt stops here rather than waiting for another worker to find the
  // same thing.
  assertEquals(result.status, "failed");
  assertEquals(result.reason, YOUTUBE_UPLOAD_REASON.superseded);
  assertEquals(w.settled.length, 1);
});

Deno.test("a media that is still being scanned waits instead of failing", async () => {
  // The scan will finish on its own, so the attempt waits rather than failing.
  const w = world({
    authority: [
      { authorized: true, reason: null },
      { authorized: false, reason: "media_pending" },
    ],
    runUpload(args) {
      return args.source.read(0, 1).then(() => ({ kind: "completed", videoId: VIDEO_ID }));
    },
  });
  const result = await continueYoutubeUpload(w.ports, request);
  assertEquals(result.status, "pending");
  assertEquals(result.reason, YOUTUBE_UPLOAD_REASON.resumable);
  assertEquals(w.settled.length, 0);
});

Deno.test("a media lookup that fails leaves the upload pending", async () => {
  // A failed read is not proof that the media is gone. Settling the row here
  // would send a recoverable upload to a human because the database was busy.
  const w = world({});
  const failing: YoutubeContinuationPorts = {
    ...w.ports,
    loadMedia() {
      return Promise.reject(new Error("the media_files query failed"));
    },
  };
  const result = await continueYoutubeUpload(failing, request);
  // The attempt waits: nothing is settled, and the row stays the evidence
  // that the upload ran.
  assertEquals(result.status, "pending");
  assertEquals(w.settled.length, 0);
  assertEquals(w.uploads, 0);
});

Deno.test("a media row without a size is judged by the object that is opened", async () => {
  // The row may not record a size. The object that is opened is then the only
  // proof of what is being sent, and it is the one that is compared with the
  // byte count the upload started with.
  const w = world({
    media: { fileSize: null },
    // The source is opened when the first byte is read, so the read has to go
    // through it for the opened object to be judged at all.
    runUpload(args) {
      return args.source.read(0, 1).then(() => ({ kind: "completed", videoId: VIDEO_ID }));
    },
  });
  const result = await continueYoutubeUpload(w.ports, request);
  assertEquals(result.status, "completed");
  assertEquals(w.uploads, 1);
  // The object was opened, and it is the size the upload started with.
  assertEquals(w.mediaReads, 1);
  assertEquals(w.mediaOwnerFilters, [USER_ID]);
});

Deno.test("an opened object of another size is refused before the first byte", async () => {
  // The media row may carry no size at all, so the OPENED object is the only
  // proof of what is being sent. An object that is not the size the upload
  // started with is not that object, and the rest of it would publish bytes
  // that do not belong to the video.
  const w = world({ media: { fileSize: null } });
  let reads = 0;
  const wrongSize: YoutubeContinuationPorts = {
    ...w.ports,
    createSource() {
      return Promise.resolve({
        size: 200,
        read() {
          reads += 1;
          return Promise.resolve(new ArrayBuffer(1));
        },
      });
    },
    // The source is opened when the first chunk is read.
    runUpload(args) {
      return args.source.read(0, 1).then(() => ({ kind: "completed", videoId: VIDEO_ID }));
    },
  };
  const result = await continueYoutubeUpload(wrongSize, request);
  assertEquals(result.status, "failed");
  assertEquals(result.reason, YOUTUBE_UPLOAD_REASON.media_unavailable);
  // The object is refused when it is opened: not one byte was read.
  assertEquals(reads, 0);
});

Deno.test("a legacy inert session without proven declarations is not uploaded", async () => {
  // The session has not sent a byte, so it is a new upload and D3 applies.
  // Booleans that were manufactured from an implicit default carry no proof.
  const w = world({
    post: {
      metadata: {
        youtube_made_for_kids: false,
        youtube_contains_synthetic_media: false,
      },
    },
  });
  const result = await continueYoutubeUpload(w.ports, request);
  assertEquals(result.status, "failed");
  assertEquals(result.reason, YOUTUBE_UPLOAD_REASON.declaration_required);
  assertEquals(w.uploads, 0);
  assertEquals(w.mediaReads, 0);
});

Deno.test("a proven declaration lets the same inert session continue", async () => {
  const w = world();
  const result = await continueYoutubeUpload(w.ports, request);
  assertEquals(result.status, "completed");
  assertEquals(w.uploads, 1);
});

Deno.test("a stored receipt is projected even when declarations were never proven", async () => {
  // The video already exists. Projecting its receipt is a fact about a video,
  // not a declaration-dependent upload, so it must not be blocked.
  const w = world({
    post: { metadata: { youtube_made_for_kids: false, youtube_contains_synthetic_media: false } },
    session: { videoId: "AbcD1234eFg" },
  });
  const result = await continueYoutubeUpload(w.ports, request);
  assertEquals(result.status, "completed");
  assertEquals(w.uploads, 0);
  assertEquals(w.mediaReads, 0);
});

// An account that cannot publish is refused in every shape it can be in.
for (const account of [
  { name: "belongs to another owner", overrides: { userId: "someone-else" } },
  { name: "needs to be reconnected", overrides: { needsReauth: true } },
  { name: "is not active", overrides: { isActive: false } },
]) {
  Deno.test(`an account that ${account.name} is refused`, async () => {
    const w = world({ account: account.overrides });
    const result = await continueYoutubeUpload(w.ports, request);
    assertEquals(result.status, "refused");
    assertEquals(result.reason, YOUTUBE_UPLOAD_REASON.account_unusable);
    assertEquals(w.uploads, 0);
  });
}

Deno.test("an account the post does not select is refused", async () => {
  // The run resolved no target of its own, so the post's stored selection is
  // the only authority, and it does not name this account.
  const w = world({ post: { selectedAccountIds: [] }, session: { targetAccountIds: [] } });
  const result = await continueYoutubeUpload(w.ports, request);
  assertEquals(result.status, "refused");
  assertEquals(result.reason, YOUTUBE_UPLOAD_REASON.account_unusable);
  assertEquals(w.uploads, 0);
});

Deno.test("an account the run resolved but the post no longer stores is still a target", async () => {
  // A run may have been given an explicit account. The post's stored
  // selection does not name it, but the session records what the run
  // resolved, and that is what the upload may be carried on to.
  const w = world({
    post: { selectedAccountIds: [] },
    session: { targetAccountIds: [ACCOUNT_ID] },
  });
  const result = await continueYoutubeUpload(w.ports, request);
  assertEquals(result.status, "completed");
  assertEquals(w.uploads, 1);
});

Deno.test("an account the run resolved to something else is refused", async () => {
  const w = world({
    post: { selectedAccountIds: [ACCOUNT_ID] },
    session: { targetAccountIds: [OTHER_ACCOUNT_ID] },
  });
  const result = await continueYoutubeUpload(w.ports, request);
  assertEquals(result.status, "refused");
  assertEquals(result.reason, YOUTUBE_UPLOAD_REASON.account_unusable);
  assertEquals(w.uploads, 0);
});

Deno.test("a session that belongs to another platform is refused", async () => {
  const w = world({ session: { resolvedPlatform: "instagram" } });
  const result = await continueYoutubeUpload(w.ports, request);
  assertEquals(result.status, "refused");
  assertEquals(result.reason, YOUTUBE_UPLOAD_REASON.session_not_open);
  assertEquals(w.uploads, 0);
});

Deno.test("a media file the post does not name is refused", async () => {
  const w = world({ post: { mediaFileIds: [] } });
  const result = await continueYoutubeUpload(w.ports, request);
  assertEquals(result.status, "failed");
  assertEquals(result.reason, YOUTUBE_UPLOAD_REASON.media_unavailable);
  assertEquals(w.uploads, 0);
  // The row is settled: the row was admitted before the provider was
  // contacted, so it exists, and a row that stays pending for ever is a
  // publication the customer never sees finish.
  assertEquals(w.settled.length, 1);
  assertEquals(w.settled[0].status, "failed");
  assertEquals(w.settled[0].errorMessage, YOUTUBE_UPLOAD_REASON.media_unavailable);
});

Deno.test("a media file that belongs to another owner is refused", async () => {
  const w = world({ media: { userId: "someone-else" } });
  const result = await continueYoutubeUpload(w.ports, request);
  assertEquals(result.status, "failed");
  assertEquals(result.reason, YOUTUBE_UPLOAD_REASON.media_unavailable);
  assertEquals(w.settled.length, 1);
});

Deno.test("a media file that was replaced is refused", async () => {
  const w = world({ media: { currentObjectVersion: 2 } });
  const result = await continueYoutubeUpload(w.ports, request);
  assertEquals(result.status, "failed");
  assertEquals(result.reason, YOUTUBE_UPLOAD_REASON.media_unavailable);
  assertEquals(w.uploads, 0);
  assertEquals(w.settled.length, 1);
});

Deno.test("a media file of another size is refused", async () => {
  // The upload resumes at an offset that was established for one object. A
  // file of another size is not that object, and sending the rest of it would
  // publish bytes that do not belong to the video.
  const w = world({ media: { fileSize: 200 } });
  const result = await continueYoutubeUpload(w.ports, request);
  assertEquals(result.status, "failed");
  assertEquals(result.reason, YOUTUBE_UPLOAD_REASON.media_unavailable);
  assertEquals(w.uploads, 0);
  assertEquals(w.settled.length, 1);
});

Deno.test("a session that carries no media version is refused", async () => {
  // The fence has to hold, and it cannot hold what it cannot compare.
  const w = world({ session: { mediaObjectVersion: null } });
  const result = await continueYoutubeUpload(w.ports, request);
  assertEquals(result.status, "failed");
  assertEquals(result.reason, YOUTUBE_UPLOAD_REASON.media_unavailable);
  assertEquals(w.uploads, 0);
  assertEquals(w.settled.length, 1);
});

Deno.test("a media file that carries no version is refused", async () => {
  const w = world({ media: { currentObjectVersion: null } });
  const result = await continueYoutubeUpload(w.ports, request);
  assertEquals(result.status, "failed");
  assertEquals(result.reason, YOUTUBE_UPLOAD_REASON.media_unavailable);
  assertEquals(w.uploads, 0);
  assertEquals(w.settled.length, 1);
});

Deno.test("a finished upload settles the public row", async () => {
  const w = world({ outcome: { kind: "completed", videoId: VIDEO_ID } });
  const result = await continueYoutubeUpload(w.ports, request);
  assertEquals(result.status, "completed");
  assertEquals(result.videoId, VIDEO_ID);
  assertEquals(w.uploads, 1);
  assertEquals(w.settled.length, 1);
  assertEquals(w.settled[0].status, "success");
  assertEquals(w.settled[0].videoId, VIDEO_ID);
});

Deno.test("an upload that continues leaves the row pending and writes nothing", async () => {
  const w = world({
    outcome: {
      kind: "resumable",
      confirmedBytes: 50,
      reason: YOUTUBE_UPLOAD_REASON.resumable,
      nextCheckAtMs: 1_700_000_060_000,
    },
  });
  const result = await continueYoutubeUpload(w.ports, request);
  assertEquals(result.status, "pending");
  // The upload already recorded the confirmed offset and the next look
  // under the lease. Writing them again from a snapshot would put older
  // values over newer ones.
  assertEquals(w.settled.length, 0);
  assertEquals(w.projected.length, 0);
});

Deno.test("an upload that needs a human settles the row as failed", async () => {
  const w = world({
    outcome: { kind: "reconcile", reason: YOUTUBE_UPLOAD_REASON.expired, detail: "the session expired" },
  });
  const result = await continueYoutubeUpload(w.ports, request);
  assertEquals(result.status, "failed");
  assertEquals(result.reason, YOUTUBE_UPLOAD_REASON.expired);
  assertEquals(w.settled.length, 1);
  assertEquals(w.settled[0].status, "failed");
  assertEquals(w.settled[0].errorMessage, YOUTUBE_UPLOAD_REASON.expired);
});

Deno.test("a worker that lost its lease writes nothing", async () => {
  const w = world({ outcome: { kind: "abandoned", reason: YOUTUBE_UPLOAD_REASON.lease_conflict } });
  const result = await continueYoutubeUpload(w.ports, request);
  assertEquals(result.status, "refused");
  assertEquals(result.reason, YOUTUBE_UPLOAD_REASON.lease_conflict);
  // The worker that took over owns the outcome now.
  assertEquals(w.settled.length, 0);
  assertEquals(w.projected.length, 0);
});

Deno.test("a settlement the store refuses records no outcome", async () => {
  const w = world({
    outcome: { kind: "completed", videoId: VIDEO_ID },
    settleRefused: "lease_stale",
  });
  const result = await continueYoutubeUpload(w.ports, request);
  assertEquals(result.status, "refused");
  assertEquals(result.reason, YOUTUBE_UPLOAD_REASON.lease_conflict);
  assertEquals(w.settled.length, 0);
});

Deno.test("a claim that another worker holds is refused", async () => {
  const w = world({ claimRefused: "lease_held" });
  const result = await continueYoutubeUpload(w.ports, request);
  assertEquals(result.status, "refused");
  assertEquals(result.reason, YOUTUBE_UPLOAD_REASON.lease_conflict);
  assertEquals(w.uploads, 0);
});

// ───────────────────────────────────────────────────────────────────────────
// The uncertain marker
//
// History and the API retry selector read publish_outcome, so a result whose
// outcome is not a proof is never offered as a retry: the provider may already
// hold the video, and a blind retry could publish a second one.
//
// A proven failure carries no marker, so it stays retryable.
// ───────────────────────────────────────────────────────────────────────────

Deno.test("an outcome that is not a proof is settled with the uncertain marker", async () => {
  // Two ways of not knowing: the worker cannot tell whether the last chunk
  // landed, and the provider gave no answer at all. Both are uncertain, and
  // both have to be refused by the retry gate.
  const uncertain: ResumableUploadOutcome[] = [
    { kind: "reconcile", reason: YOUTUBE_UPLOAD_REASON.reconcile },
    { kind: "failed", reason: YOUTUBE_UPLOAD_REASON.unknown, retryable: true },
  ];
  for (const outcome of uncertain) {
    const w = world({ outcome });
    await continueYoutubeUpload(w.ports, request);
    assertEquals(w.settled.length, 1);
    assertEquals(w.settled[0].status, "failed");
    assertEquals(w.settled[0].responseData.publish_outcome, "uncertain");
  }
});

Deno.test("a proven failure is settled without the uncertain marker", async () => {
  // The upload never started: nothing reached the provider, so a retry cannot
  // create a second video.
  const unsent = world({ outcome: { kind: "unsent", reason: YOUTUBE_UPLOAD_REASON.unsent } });
  await continueYoutubeUpload(unsent.ports, request);
  assertEquals(unsent.settled.length, 1);
  assertEquals("publish_outcome" in unsent.settled[0].responseData, false);

  // The provider refused the upload: it answered, so that is a proof as well.
  const rejected = world({
    outcome: { kind: "failed", reason: YOUTUBE_UPLOAD_REASON.rejected, retryable: false },
  });
  await continueYoutubeUpload(rejected.ports, request);
  assertEquals(rejected.settled.length, 1);
  assertEquals("publish_outcome" in rejected.settled[0].responseData, false);
});

Deno.test("a session that never got a provider session is started", async () => {
  // The session was admitted but no byte ever reached the provider, so no
  // video can exist and the upload opens a session and starts.
  const w = world({ session: { sessionUri: null, bytesSent: 0, videoMayExist: false } });
  const result = await continueYoutubeUpload(w.ports, request);
  assertEquals(result.status, "completed");
  assertEquals(w.uploads, 1);
});

Deno.test("a session that lost its uri after writing is settled for a human", async () => {
  const w = world({ session: { sessionUri: null, bytesSent: 100, videoMayExist: true } });
  const result = await continueYoutubeUpload(w.ports, request);
  assertEquals(result.status, "failed");
  assertEquals(result.reason, YOUTUBE_UPLOAD_REASON.reconcile);
  assertEquals(w.uploads, 0);
  // The row is settled, so it does not stay pending for ever, and the
  // uncertain evidence is kept: the marker says that a video may exist, so
  // neither the retry gate nor the retry button offers a blind retry.
  assertEquals(w.settled.length, 1);
  assertEquals(w.settled[0].status, "failed");
  assertEquals(w.settled[0].responseData.publish_outcome, "uncertain");
});

// ───────────────────────────────────────────────────────────────────────────
// The follow-ups
//
// A thumbnail and a first comment happen AFTER the video exists. They belong
// to the run that CREATED the video: a run that inherits a receipt does not
// repeat them, because a first comment posted twice is a duplicate on the
// customer's channel.
// ───────────────────────────────────────────────────────────────────────────

Deno.test("the run that created the video does the follow-ups", async () => {
  const w = world({
    outcome: { kind: "completed", videoId: VIDEO_ID },
    post: { thumbnailUrl: "https://cdn.example.test/thumb.jpg", firstComment: "Hello" },
  });
  const result = await continueYoutubeUpload(w.ports, request);
  assertEquals(result.status, "completed");
  assertEquals(w.followUps, [VIDEO_ID]);
});

Deno.test("a run that inherits a receipt does not repeat the follow-ups", async () => {
  const w = world({
    session: { state: "uploaded", videoId: VIDEO_ID },
    post: { thumbnailUrl: "https://cdn.example.test/thumb.jpg", firstComment: "Hello" },
  });
  const result = await continueYoutubeUpload(w.ports, request);
  assertEquals(result.status, "completed");
  // The earlier run owned the follow-ups. Repeating them here could post the
  // first comment twice.
  assertEquals(w.followUps, []);
  assertEquals(w.uploads, 0);
});

Deno.test("a follow-up that fails does not stop the settlement", async () => {
  const w = world({ outcome: { kind: "completed", videoId: VIDEO_ID } });
  const failing: YoutubeContinuationPorts = {
    ...w.ports,
    followUps() {
      return Promise.reject(new Error("the comment could not be posted"));
    },
  };
  let thrown: unknown;
  try {
    await continueYoutubeUpload(failing, request);
  } catch (error) {
    thrown = error;
  }
  // The video is already live, so the row still has to be settled.
  assertEquals(thrown, undefined);
  assertEquals(w.settled.length, 1);
  assertEquals(w.settled[0].status, "success");
});

Deno.test("a live state that cannot be read does not stop the settlement", async () => {
  // The follow-ups are optional; the receipt is not. The video is already
  // live, so the row has to be settled even when the authority check could
  // not be answered.
  const w = world({ outcome: { kind: "completed", videoId: VIDEO_ID } });
  let checks = 0;
  const failing: YoutubeContinuationPorts = {
    ...w.ports,
    effectAuthority() {
      checks += 1;
      // The first question is the one before the write; the second is the one
      // before the follow-ups.
      if (checks === 1) return Promise.resolve({ authorized: true, reason: null });
      return Promise.reject(new Error("the database could not be reached"));
    },
  };
  let thrown: unknown;
  try {
    await continueYoutubeUpload(failing, request);
  } catch (error) {
    thrown = error;
  }
  assertEquals(thrown, undefined);
  // The follow-ups were skipped: an unanswerable check is not a permission,
  // so nothing was written to the provider.
  assertEquals(w.followUps, []);
  // The video is live, so the row is settled.
  assertEquals(w.settled.length, 1);
  assertEquals(w.settled[0].status, "success");
  assertEquals(w.settled[0].videoId, VIDEO_ID);
});

// ───────────────────────────────────────────────────────────────────────────
// The live write authority
//
// The lease says the worker owns the session. It does not say the post, the
// content, the target or the media are still what the worker saw. The live
// state is asked about before anything is sent.
// ───────────────────────────────────────────────────────────────────────────

Deno.test("the live state is asked about before the upload runs", async () => {
  const w = world({});
  await continueYoutubeUpload(w.ports, request);
  // The upload ran, and the refusal cases below prove that the authority was
  // asked about: without the question they would have written to the provider.
  assertEquals(w.uploads, 1);
});

// A refusal of the write is a refusal, whatever the live state says.
for (
  const refusal of [
    { name: "the title changed", reason: "content_changed", expected: YOUTUBE_UPLOAD_REASON.superseded },
    { name: "the post was cancelled", reason: "post_not_processing", expected: YOUTUBE_UPLOAD_REASON.superseded },
    { name: "the attempt was replaced", reason: "stale_attempt", expected: YOUTUBE_UPLOAD_REASON.stale_attempt },
    {
      name: "the account is no longer a target",
      reason: "target_not_authorized",
      expected: YOUTUBE_UPLOAD_REASON.account_unusable,
    },
  ]
) {
  Deno.test(`a live state that says ${refusal.name} stops the write`, async () => {
    const w = world({ authority: { authorized: false, reason: refusal.reason } });
    const result = await continueYoutubeUpload(w.ports, request);
    assertEquals(result.status, "refused");
    assertEquals(result.reason, refusal.expected);
    // Nothing was written to the provider.
    assertEquals(w.uploads, 0);
    assertEquals(w.settled.length, 0);
  });
}

// ───────────────────────────────────────────────────────────────────────────
// The media sendability rule
//
// The rule is the shared one, so a resumed upload refuses exactly what every
// other send path refuses.
// ───────────────────────────────────────────────────────────────────────────

Deno.test("a media file that is still being scanned waits", async () => {
  const w = world({ media: { scanState: "pending" } });
  const result = await continueYoutubeUpload(w.ports, request);
  assertEquals(result.status, "pending");
  assertEquals(result.reason, YOUTUBE_UPLOAD_REASON.resumable);
  // Nothing was read from the provider and nothing was written.
  assertEquals(w.uploads, 0);
  assertEquals(w.settled.length, 0);
});

Deno.test("a media file that the scan rejected is refused", async () => {
  const w = world({ media: { scanState: "rejected" } });
  const result = await continueYoutubeUpload(w.ports, request);
  assertEquals(result.status, "failed");
  assertEquals(result.reason, YOUTUBE_UPLOAD_REASON.media_unavailable);
  assertEquals(w.uploads, 0);
  // The row is settled, so the post rolls up and the customer is told the
  // truth. Nothing was sent, so the failure is a proof and stays retryable.
  assertEquals(w.settled.length, 1);
  assertEquals(w.settled[0].status, "failed");
  assertEquals("publish_outcome" in w.settled[0].responseData, false);
});

Deno.test("a refusal on a session that may hold a video keeps the uncertain marker", async () => {
  // The session knows a video may exist: the flag is set when the last chunk
  // may have been written. The refusal is permanent, but it is not a proof,
  // so the marker travels with it.
  const w = world({
    session: { videoMayExist: true, bytesSent: 100 },
    media: { currentObjectVersion: 2 },
  });
  const result = await continueYoutubeUpload(w.ports, request);
  assertEquals(result.status, "failed");
  assertEquals(w.settled.length, 1);
  assertEquals(w.settled[0].responseData.publish_outcome, "uncertain");
});

// ───────────────────────────────────────────────────────────────────────────
// The fanout closure
//
// The worker that admitted the upload may have died before it closed the post
// fanout. The continuation that settles the upload closes it too, so the post
// is not held open for ever.
// ───────────────────────────────────────────────────────────────────────────

Deno.test("a settled upload closes the fanout of its attempt", async () => {
  const w = world({ outcome: { kind: "completed", videoId: VIDEO_ID } });
  await continueYoutubeUpload(w.ports, request);
  assertEquals(w.fanoutRecoveries, ["session-1"]);
});

Deno.test("a projected receipt closes the fanout of its attempt", async () => {
  const w = world({ session: { state: "uploaded", videoId: VIDEO_ID } });
  await continueYoutubeUpload(w.ports, request);
  assertEquals(w.fanoutRecoveries, ["session-1"]);
});

Deno.test("a scope that could not be proven complete keeps the pending row", async () => {
  // The scope could not be closed and nobody will close it. The pending row
  // is the protection: it is what keeps the sweeper from reading the absence
  // of a sibling row as "this destination never started". So the row stays
  // pending and the next reconciliation looks again.
  const w = world({
    outcome: { kind: "completed", videoId: VIDEO_ID },
    fanout: { recovered: false, reason: "incomplete_scope" },
  });
  const result = await continueYoutubeUpload(w.ports, request);
  assertEquals(result.status, "pending");
  assertEquals(result.reason, YOUTUBE_UPLOAD_REASON.reconcile);
  // The evidence is not removed: the row is still there.
  assertEquals(w.settled.length, 0);
  assertEquals(w.projected.length, 0);
});

Deno.test("a fanout that throws keeps the pending row", async () => {
  const w = world({ outcome: { kind: "completed", videoId: VIDEO_ID } });
  const failing: YoutubeContinuationPorts = {
    ...w.ports,
    recoverFanout() {
      return Promise.reject(new Error("the database was not reachable"));
    },
  };
  const result = await continueYoutubeUpload(failing, request);
  // A closure that could not be run leaves the scope unknown, and an unknown
  // scope is an incomplete one.
  assertEquals(result.status, "pending");
  assertEquals(w.settled.length, 0);
});

Deno.test("a scope that is still running on purpose settles the row", async () => {
  // The attempt may still be running, so the scope is open on purpose and the
  // worker of the attempt is going to complete it. That is not an incomplete
  // scope: the evidence may be removed.
  const w = world({
    outcome: { kind: "completed", videoId: VIDEO_ID },
    fanout: { recovered: false, reason: "attempt_may_still_be_running" },
  });
  const result = await continueYoutubeUpload(w.ports, request);
  assertEquals(result.status, "completed");
  assertEquals(w.settled.length, 1);
});

Deno.test("the closure is given the lease token", async () => {
  // The closure runs while this worker still owns the session, and the token is
  // what proves it. A closure without the token is refused by the database,
  // and the row would become terminal with the fanout still open.
  const w = world({ outcome: { kind: "completed", videoId: VIDEO_ID } });
  await continueYoutubeUpload(w.ports, request);
  assertEquals(w.recoveryLeaseTokens, ["lease-1"]);
});

Deno.test("the scope verdict reads the reason of the closure", () => {
  assertEquals(scopeStateOf({ recovered: true, reason: null }), "closed");
  assertEquals(scopeStateOf({ recovered: false, reason: "attempt_may_still_be_running" }), "attempt_running");
  // Anything else could not be proven complete.
  assertEquals(scopeStateOf({ recovered: false, reason: "incomplete_scope" }), "incomplete");
  assertEquals(scopeStateOf({ recovered: false, reason: null }), "incomplete");
});

// The fanout closure has to come before the public row is settled, in every
// shape the worker can finish in. The pending YouTube row is what keeps the
// generic sweeper from reading the absence of a sibling row as a proof that
// the sibling never started, so the scope has to be settled while that row is
// still pending.
const ORDER_CASES: Array<{ name: string; options: WorldOptions; expected: string[] }> = [
  {
    name: "a success",
    options: { outcome: { kind: "completed", videoId: VIDEO_ID } },
    expected: ["recover", "settle"],
  },
  {
    name: "a failure",
    options: { outcome: { kind: "failed", reason: YOUTUBE_UPLOAD_REASON.rejected, retryable: false } },
    expected: ["recover", "settle"],
  },
  {
    name: "a receipt that is already stored",
    options: { session: { state: "uploaded", videoId: VIDEO_ID } },
    expected: ["recover", "project"],
  },
];

for (const outcome of ORDER_CASES) {
  Deno.test(`the fanout closure comes before the row is settled on ${outcome.name}`, async () => {
    const w = world(outcome.options);
    await continueYoutubeUpload(w.ports, request);
    assertEquals(w.timeline, outcome.expected);
  });
}

// ───────────────────────────────────────────────────────────────────────────
// The media and the receipt
//
// The provider is asked what it holds BEFORE the file is opened. A session the
// provider already finished is worth more than a file the media host may not be
// able to serve right now: a media host that answers with a 500 must not keep
// a receipt from being recovered.
// ───────────────────────────────────────────────────────────────────────────

Deno.test("the media is not opened when the provider already holds the video", async () => {
  const w = world({
    runUpload: () => Promise.resolve({ kind: "completed", videoId: VIDEO_ID }),
  });
  const result = await continueYoutubeUpload(w.ports, request);

  assertEquals(result.status, "completed");
  assertEquals(result.videoId, VIDEO_ID);
  // The provider named the video, so no byte was needed and the file was never
  // opened: a media host that cannot answer cannot stop a receipt from being
  // recovered.
  assertEquals(w.uploads, 1);
  assertEquals(w.mediaReads, 0);
});

Deno.test("the media is opened when the upload has to write", async () => {
  const w = world({
    runUpload: async (args) => {
      // The provider needs more bytes, so the file is opened.
      await args.source.read(0, 9);
      return { kind: "completed", videoId: VIDEO_ID };
    },
  });
  const result = await continueYoutubeUpload(w.ports, request);

  assertEquals(result.status, "completed");
  assertEquals(w.mediaReads, 1);
});

Deno.test("the file is opened once, however many chunks are read", async () => {
  const w = world({
    runUpload: async (args) => {
      await args.source.read(0, 9);
      await args.source.read(10, 19);
      return { kind: "completed", videoId: VIDEO_ID };
    },
  });
  await continueYoutubeUpload(w.ports, request);
  assertEquals(w.mediaReads, 1);
});

Deno.test("the follow-ups are skipped when the live state no longer allows them", async () => {
  const w = world({
    outcome: { kind: "completed", videoId: VIDEO_ID },
    post: { thumbnailUrl: "https://cdn.example.test/thumb.jpg", firstComment: "Hello" },
    // The write was allowed, and the follow-ups were not: the post changed
    // while the video was being written.
    authority: [
      { authorized: true, reason: null },
      { authorized: false, reason: "content_changed" },
    ],
  });
  const result = await continueYoutubeUpload(w.ports, request);

  assertEquals(result.status, "completed");
  assertEquals(w.followUps, []);
  // The receipt does not depend on the follow-ups: the video exists, so the row
  // is settled either way.
  assertEquals(w.settled.length, 1);
  assertEquals(w.settled[0].status, "success");
  assertEquals(w.settled[0].videoId, VIDEO_ID);
});

Deno.test("a temporarily unavailable refreshed credential leaves the session untouched", async () => {
  const w = world({ account: { accessToken: null, tokenRefreshPending: true } });
  const result = await continueYoutubeUpload(w.ports, request);
  assertEquals(result.status, "pending");
  assertEquals(result.reason, YOUTUBE_UPLOAD_REASON.resumable);
  assertEquals(w.mediaReads, 0);
  assertEquals(w.settled.length, 0);
});
