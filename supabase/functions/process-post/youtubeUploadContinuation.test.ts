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
 *   * sending needs an account the post selected, that belongs to the post
 *     owner, and that is usable;
 *   * sending needs a media file the post still names, that belongs to the
 *     owner, and that is still the version the upload started with.
 *
 * The distinction between settling a receipt and sending bytes is the one
 * that matters most: settling is safe even when the account can no longer
 * publish, and sending is not.
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
  settled: Array<{ status: string; providerPostId: string | null; errorMessage: string | null }>;
  schedules: Array<{ nextCheckAt: string; lastOutcome: string }>;
}

interface WorldOptions {
  post?: Partial<ContinuationPost>;
  account?: Partial<ContinuationAccount>;
  media?: Partial<ContinuationMedia>;
  session?: Partial<YoutubeUploadSessionRecord>;
  outcome?: ResumableUploadOutcome;
  claimRefused?: YoutubeUploadRefusal | null;
}

function world(options: WorldOptions = {}): World {
  const post: ContinuationPost = {
    id: POST_ID,
    userId: USER_ID,
    status: "processing",
    processingStartedAt: ATTEMPT,
    selectedAccountIds: [ACCOUNT_ID],
    mediaFileIds: [MEDIA_ID],
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
    ...options.session,
  };

  const world: World = {
    mediaReads: 0,
    uploads: 0,
    settled: [],
    schedules: [],
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
      settlePlatformPost(args) {
        world.settled.push({
          status: args.status,
          providerPostId: args.providerPostId,
          errorMessage: args.errorMessage,
        });
        return Promise.resolve();
      },
      scheduleNextCheck(args) {
        world.schedules.push({ nextCheckAt: args.nextCheckAt, lastOutcome: args.lastOutcome });
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

Deno.test("a receipt that is already stored settles the row without touching the provider", async () => {
  const w = world({ session: { state: "uploaded", videoId: VIDEO_ID } });
  const result = await continueYoutubeUpload(w.ports, request);

  assertEquals(result.status, "completed");
  assertEquals(result.videoId, VIDEO_ID);
  // No media was read and the provider was never called.
  assertEquals(w.mediaReads, 0);
  assertEquals(w.uploads, 0);
  assertEquals(w.settled.length, 1);
  assertEquals(w.settled[0].status, "success");
  assertEquals(w.settled[0].providerPostId, VIDEO_ID);
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

Deno.test("an account that belongs to another owner is refused", async () => {
  const w = world({ account: { userId: "someone-else" } });
  const result = await continueYoutubeUpload(w.ports, request);
  assertEquals(result.status, "refused");
  assertEquals(result.reason, YOUTUBE_UPLOAD_REASON.account_unusable);
  assertEquals(w.uploads, 0);
});

Deno.test("an account that needs to be reconnected is refused", async () => {
  const w = world({ account: { needsReauth: true } });
  const result = await continueYoutubeUpload(w.ports, request);
  assertEquals(result.status, "refused");
  assertEquals(result.reason, YOUTUBE_UPLOAD_REASON.account_unusable);
  assertEquals(w.uploads, 0);
});

Deno.test("an account the post does not select is refused", async () => {
  const w = world({ post: { selectedAccountIds: [] } });
  const result = await continueYoutubeUpload(w.ports, request);
  assertEquals(result.status, "refused");
  assertEquals(result.reason, YOUTUBE_UPLOAD_REASON.account_unusable);
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
  assertEquals(w.settled[0].providerPostId, VIDEO_ID);
});

Deno.test("an upload that continues leaves the row pending and schedules the next look", async () => {
  const w = world({
    outcome: { kind: "resumable", confirmedBytes: 50, reason: YOUTUBE_UPLOAD_REASON.resumable },
  });
  const result = await continueYoutubeUpload(w.ports, request);
  assertEquals(result.status, "pending");
  assertEquals(w.settled.length, 0);
  assertEquals(w.schedules.length, 1);
  assertEquals(w.schedules[0].lastOutcome, YOUTUBE_UPLOAD_REASON.resumable);
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

Deno.test("a claim that another worker holds is refused", async () => {
  const w = world({ claimRefused: "lease_held" });
  const result = await continueYoutubeUpload(w.ports, request);
  assertEquals(result.status, "refused");
  assertEquals(result.reason, YOUTUBE_UPLOAD_REASON.lease_conflict);
  assertEquals(w.uploads, 0);
});

Deno.test("a session with no provider session is not continued", async () => {
  const w = world({ session: { sessionUri: null } });
  const result = await continueYoutubeUpload(w.ports, request);
  assertEquals(result.status, "refused");
  assertEquals(result.reason, YOUTUBE_UPLOAD_REASON.session_not_open);
  assertEquals(w.uploads, 0);
});
