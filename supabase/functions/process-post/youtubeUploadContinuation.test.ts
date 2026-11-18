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

/** What the fake outside world was asked to do. */
interface World {
  ports: YoutubeContinuationPorts;
  mediaReads: number;
  uploads: number;
  /** The terminal outcomes the worker tried to record. */
  settled: Array<{ status: string; videoId: string | null; errorMessage: string | null }>;
  /** The receipts the worker projected. */
  projected: string[];
  /** The videos the worker did the follow-ups for. */
  followUps: string[];
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
    ...options.post,
  };
  const account: ContinuationAccount = {
    id: ACCOUNT_ID,
    userId: USER_ID,
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
    filePath: "postora/user/video.mp4",
    storageBucket: "postora",
    mimeType: "video/mp4",
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
    attemptStartedAt: ATTEMPT,
    nextCheckAt: null,
    lastOutcome: null,
    platformPostId: PLATFORM_POST_ID,
    mediaFileId: MEDIA_ID,
    mediaObjectVersion: 1,
    continuationCount: 0,
    uploadBody: { snippet: { title: "A video" } },
    resolvedPlatform: "youtube",
    targetAccountIds: [ACCOUNT_ID],
    ...options.session,
  };

  const world: World = {
    mediaReads: 0,
    uploads: 0,
    settled: [],
    projected: [],
    followUps: [],
    ports: {
      loadPost() {
        return Promise.resolve(post);
      },
      loadAccount() {
        return Promise.resolve(account);
      },
      loadMedia() {
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
      runUpload() {
        world.uploads += 1;
        return Promise.resolve(options.outcome ?? { kind: "completed", videoId: VIDEO_ID });
      },
      settleUpload(args) {
        if (options.settleRefused) {
          return Promise.resolve({ settled: false, refused: options.settleRefused });
        }
        world.settled.push({
          status: args.status,
          videoId: args.videoId ?? null,
          errorMessage: args.errorMessage ?? null,
        });
        return Promise.resolve({ settled: true, refused: null });
      },
      projectReceipt(args) {
        if (options.projectRefused) {
          return Promise.resolve({ settled: false, refused: options.projectRefused, videoId: null });
        }
        world.projected.push(args.sessionId);
        return Promise.resolve({ settled: true, refused: null, videoId: session.videoId });
      },
      followUps(args) {
        world.followUps.push(args.videoId);
        return Promise.resolve();
      },
      now: () => 1_700_000_000_000,
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
  assertEquals(result.status, "refused");
  assertEquals(result.reason, YOUTUBE_UPLOAD_REASON.media_unavailable);
  assertEquals(w.uploads, 0);
});

Deno.test("a media file that belongs to another owner is refused", async () => {
  const w = world({ media: { userId: "someone-else" } });
  const result = await continueYoutubeUpload(w.ports, request);
  assertEquals(result.status, "refused");
  assertEquals(result.reason, YOUTUBE_UPLOAD_REASON.media_unavailable);
});

Deno.test("a media file that was replaced is refused", async () => {
  const w = world({ media: { currentObjectVersion: 2 } });
  const result = await continueYoutubeUpload(w.ports, request);
  assertEquals(result.status, "refused");
  assertEquals(result.reason, YOUTUBE_UPLOAD_REASON.media_unavailable);
  assertEquals(w.uploads, 0);
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

Deno.test("a session that never got a provider session is started", async () => {
  // The session was admitted but no byte ever reached the provider, so no
  // video can exist and the upload opens a session and starts.
  const w = world({ session: { sessionUri: null, bytesSent: 0, videoMayExist: false } });
  const result = await continueYoutubeUpload(w.ports, request);
  assertEquals(result.status, "completed");
  assertEquals(w.uploads, 1);
});

Deno.test("a session that lost its uri after writing is left for a human", async () => {
  const w = world({ session: { sessionUri: null, bytesSent: 100, videoMayExist: true } });
  const result = await continueYoutubeUpload(w.ports, request);
  assertEquals(result.status, "refused");
  assertEquals(result.reason, YOUTUBE_UPLOAD_REASON.reconcile);
  assertEquals(w.uploads, 0);
  assertEquals(w.settled.length, 0);
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
