/**
 * The durable session store.
 *
 * Three things are proved here.
 *
 * The first is the NAMED ARGUMENT CONTRACT. PostgREST sends the named
 * arguments of a function as JSON, and a function that is asked for an
 * argument it does not have is a function that does not exist. The lease is
 * the argument that was wrong: the functions take `p_lease_ms`, a number of
 * milliseconds, and the adapter has to send exactly that name.
 *
 * The second is the ADMISSION. The private session and the public pending row
 * are created together, before any provider work. There is no moment where a
 * post has a pending row that no continuation can claim.
 *
 * The third is the RULES the store keeps, proved without a database: one
 * owner per session, offsets that only grow, an uncertainty that never
 * clears, a receipt that is kept, a settlement that only the owner may
 * write, and a continuation claim that hands out a token and not the session
 * URI.
 */

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  createInMemoryYoutubeUploadSessionStore,
  createSupabaseYoutubeUploadSessionStore,
  readRefusal,
} from "./youtubeUploadSession.ts";

/** A Supabase client that records the calls it was given. */
function recordingClient(responses: Record<string, unknown> = {}) {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const client = {
    rpc(fn: string, args: Record<string, unknown>) {
      calls.push({ fn, args });
      const response = responses[fn];
      // The envelope is EXPLICIT: a refusal says so in the envelope, and a
      // payload that happens to carry an "error" field of its own is DATA.
      // The session the claim returns has an "error" field, and a stub that
      // reads it as a refusal swallows the very payload it was given.
      if (response && typeof response === "object" && "data" in response && "error" in response) {
        const envelope = response as { data: unknown; error: unknown };
        return Promise.resolve({ data: envelope.data, error: envelope.error });
      }
      return Promise.resolve({ data: response ?? null, error: null });
    },
  };
  return { client, calls };
}

const SESSION_ID = "11111111-1111-1111-1111-111111111111";
const POST_ID = "22222222-2222-2222-2222-222222222222";
const ACCOUNT_ID = "33333333-3333-3333-3333-333333333333";
const LEASE = "44444444-4444-4444-4444-444444444444";
const PUBLIC_ROW_ID = "55555555-5555-5555-5555-555555555555";
const OWNER_ID = "66666666-6666-6666-6666-666666666666";

/** The session the database hands back. */
function sessionPayload(overrides: Record<string, unknown> = {}) {
  return {
    id: SESSION_ID,
    post_id: POST_ID,
    social_account_id: ACCOUNT_ID,
    state: "open",
    session_uri: null,
    confirmed_bytes: 0,
    bytes_sent: 0,
    video_may_exist: false,
    total_bytes: 100,
    video_id: null,
    // The claim payload carries an error field of its own: it is the
    // session's own error, and it is DATA, not a refusal.
    error: null,
    attempt_started_at: "2026-11-18T00:00:00.000Z",
    next_check_at: null,
    last_outcome: null,
    platform_post_id: PUBLIC_ROW_ID,
    media_file_id: null,
    media_object_version: null,
    continuation_count: 0,
    resolved_platform: "youtube",
    target_account_ids: [ACCOUNT_ID],
    ...overrides,
  };
}

Deno.test("the lease is sent as a number of milliseconds", async () => {
  const { client, calls } = recordingClient({
    claim_youtube_upload_session: sessionPayload({
      session_uri: "https://www.googleapis.com/upload?upload_id=secret",
    }),
  });
  const store = createSupabaseYoutubeUploadSessionStore(client);
  const claimed = await store.claim({ sessionId: SESSION_ID, leaseToken: LEASE, leaseMs: 180_000 });

  const call = calls.find((entry) => entry.fn === "claim_youtube_upload_session");
  assert(call !== undefined);
  // The name is the one the function has. A different name is a missing
  // function at run time, not a different argument.
  assertEquals(call.args.p_lease_ms, 180_000);
  assertEquals("p_lease" in call.args, false);
  assertEquals(call.args.p_session_id, SESSION_ID);
  assertEquals(call.args.p_lease_token, LEASE);
  // The payload came back: a stub that reads the session's own error field as
  // a refusal would swallow the very payload it was given.
  assertEquals(claimed.refused, null);
  assertEquals(claimed.record?.id, SESSION_ID);
  assertEquals(claimed.record?.state, "open");
});

Deno.test("the continuation claim is sent as a number of milliseconds", async () => {
  const { client, calls } = recordingClient({ claim_youtube_upload_sessions: [] });
  const store = createSupabaseYoutubeUploadSessionStore(client);
  await store.claimContinuations({ limit: 5, leaseMs: 180_000 });

  const call = calls.find((entry) => entry.fn === "claim_youtube_upload_sessions");
  assert(call !== undefined);
  assertEquals(call.args.p_lease_ms, 180_000);
  assertEquals("p_lease" in call.args, false);
  assertEquals(call.args.p_limit, 5);
});

Deno.test("the checkpoint carries the continuation schedule", async () => {
  const { client, calls } = recordingClient({ checkpoint_youtube_upload_session: true });
  const store = createSupabaseYoutubeUploadSessionStore(client);
  await store.checkpoint({
    sessionId: SESSION_ID,
    leaseToken: LEASE,
    confirmedBytes: 100,
    bytesSent: 200,
    videoMayExist: true,
    nextCheckAt: "2026-11-18T00:05:00.000Z",
    lastOutcome: "youtube_upload_resumable",
  });

  const call = calls.find((entry) => entry.fn === "checkpoint_youtube_upload_session");
  assert(call !== undefined);
  assertEquals(call.args.p_next_check_at, "2026-11-18T00:05:00.000Z");
  assertEquals(call.args.p_last_outcome, "youtube_upload_resumable");
  assertEquals(call.args.p_video_may_exist, true);
});

Deno.test("the checkpoint tells a cleared schedule apart from an unchanged one", async () => {
  const { client, calls } = recordingClient({ checkpoint_youtube_upload_session: true });
  const store = createSupabaseYoutubeUploadSessionStore(client);

  // A time moves the schedule.
  await store.checkpoint({
    sessionId: SESSION_ID,
    leaseToken: LEASE,
    confirmedBytes: 100,
    bytesSent: 200,
    nextCheckAt: "2026-11-18T00:05:00.000Z",
  });
  // A cleared schedule empties it.
  await store.checkpoint({
    sessionId: SESSION_ID,
    leaseToken: LEASE,
    confirmedBytes: 100,
    bytesSent: 200,
    nextCheckAt: null,
  });

  const checkpoints = calls.filter((entry) => entry.fn === "checkpoint_youtube_upload_session");
  assertEquals(checkpoints.length, 2);
  assertEquals(checkpoints[0].args.p_next_check_at, "2026-11-18T00:05:00.000Z");
  assertEquals(checkpoints[0].args.p_clear_next_check, false);
  // The flag keeps "cleared" apart from "not given": a schedule that is not
  // given has to stay where it was, and a schedule that is cleared has to go.
  assertEquals(checkpoints[1].args.p_next_check_at, null);
  assertEquals(checkpoints[1].args.p_clear_next_check, true);
});

Deno.test("the admission is asked for with the attempt and the resolved targets", async () => {
  const { client, calls } = recordingClient({
    admit_youtube_upload: { session: sessionPayload(), platform_post_id: PUBLIC_ROW_ID },
  });
  const store = createSupabaseYoutubeUploadSessionStore(client);
  await store.admit({
    postId: POST_ID,
    socialAccountId: ACCOUNT_ID,
    mediaFileId: null,
    mediaObjectVersion: null,
    mediaSize: 100,
    totalBytes: 100,
    uploadBody: { snippet: { title: "A video" } },
    expectedContent: { caption: "A video" },
    userId: OWNER_ID,
    attemptStartedAt: "2026-11-18T00:00:00.000Z",
    targetAccountIds: [ACCOUNT_ID],
  });

  const call = calls.find((entry) => entry.fn === "admit_youtube_upload");
  assert(call !== undefined);
  assertEquals(call.args.p_attempt_started_at, "2026-11-18T00:00:00.000Z");
  assertEquals(call.args.p_target_account_ids, [ACCOUNT_ID]);
  // The public row is created BY the admission, so its id is not an argument.
  assertEquals("p_platform_post_id" in call.args, false);
});

Deno.test("the admission is asked for with the live media version", async () => {
  const { client, calls } = recordingClient({
    admit_youtube_upload: { session: sessionPayload(), platform_post_id: PUBLIC_ROW_ID },
  });
  const store = createSupabaseYoutubeUploadSessionStore(client);
  await store.admit({
    postId: POST_ID,
    socialAccountId: ACCOUNT_ID,
    mediaFileId: "77777777-7777-7777-7777-777777777777",
    mediaObjectVersion: 7,
    mediaSize: 100,
    totalBytes: 100,
    uploadBody: { snippet: { title: "A video" } },
    expectedContent: { caption: "A video" },
    userId: OWNER_ID,
    attemptStartedAt: "2026-11-18T00:00:00.000Z",
    targetAccountIds: [ACCOUNT_ID],
  });

  const call = calls.find((entry) => entry.fn === "admit_youtube_upload");
  assert(call !== undefined);
  // The version of the file the caller read. A file that was replaced in the
  // meantime is refused, so the bytes the worker holds are the bytes the
  // session records.
  assertEquals(call.args.p_expected_media_version, 7);
});

Deno.test("the admission is asked for with the query settings of the request", async () => {
  const { client, calls } = recordingClient({
    admit_youtube_upload: { session: sessionPayload(), platform_post_id: PUBLIC_ROW_ID },
  });
  const store = createSupabaseYoutubeUploadSessionStore(client);
  await store.admit({
    ...admitInput,
    uploadSettings: { part: "snippet,status", notifySubscribers: false },
  });

  const call = calls.find((entry) => entry.fn === "admit_youtube_upload");
  assert(call !== undefined);
  // The settings travel with the session, so a worker that opens the provider
  // session later makes the SAME request: the same parts, and the same
  // subscriber notification.
  assertEquals(call.args.p_upload_settings, { part: "snippet,status", notifySubscribers: false });
});

Deno.test("the stored settings come back with the session", async () => {
  const { client } = recordingClient({
    admit_youtube_upload: {
      session: sessionPayload({
        upload_settings: { part: "snippet,status,recordingDetails", notifySubscribers: false },
      }),
      platform_post_id: PUBLIC_ROW_ID,
    },
  });
  const store = createSupabaseYoutubeUploadSessionStore(client);
  const result = await store.admit(admitInput);

  assertEquals(result.record?.uploadSettings, {
    part: "snippet,status,recordingDetails",
    notifySubscribers: false,
  });
});

Deno.test("the declared video type travels with the admission", async () => {
  // The continuation sends the remaining chunks with the type the FIRST upload
  // declared. A `.mov` whose stored type is null is declared from the media
  // response, so the type has to survive the round trip: a continuation that
  // falls back to video/mp4 sends the rest of a `.mov` as an mp4.
  const { client } = recordingClient({
    admit_youtube_upload: {
      session: sessionPayload({
        upload_settings: {
          part: "snippet,status",
          notifySubscribers: false,
          mimeType: "video/quicktime",
        },
      }),
      platform_post_id: PUBLIC_ROW_ID,
    },
  });
  const store = createSupabaseYoutubeUploadSessionStore(client);
  const result = await store.admit(admitInput);

  assertEquals(result.record?.uploadSettings.mimeType, "video/quicktime");
});

Deno.test("a session without settings is read as the request its body describes", async () => {
  const { client } = recordingClient({
    admit_youtube_upload: {
      session: sessionPayload({ upload_body: { snippet: { title: "A video" } } }),
      platform_post_id: PUBLIC_ROW_ID,
    },
  });
  const store = createSupabaseYoutubeUploadSessionStore(client);
  const result = await store.admit(admitInput);

  // A session that carries no settings of its own still has to make a request,
  // and it makes the one its body describes.
  assertEquals(result.record?.uploadSettings, { part: "snippet", notifySubscribers: true });
});

Deno.test("the admission hands back the public row it created", async () => {  const { client } = recordingClient({
    admit_youtube_upload: { session: sessionPayload(), platform_post_id: PUBLIC_ROW_ID },
  });
  const store = createSupabaseYoutubeUploadSessionStore(client);
  const result = await store.admit({
    postId: POST_ID,
    socialAccountId: ACCOUNT_ID,
    mediaFileId: null,
    mediaObjectVersion: null,
    mediaSize: 100,
    totalBytes: 100,
    uploadBody: {},
    expectedContent: null,
    userId: OWNER_ID,
    attemptStartedAt: null,
    targetAccountIds: [],
  });
  assertEquals(result.refused, null);
  assertEquals(result.platformPostId, PUBLIC_ROW_ID);
  assertEquals(result.record?.resolvedPlatform, "youtube");
  assertEquals(result.record?.targetAccountIds, [ACCOUNT_ID]);
});

Deno.test("a refusal is read from the sqlstate", () => {
  assertEquals(readRefusal({ code: "YUS07" }), "lease_held");
  assertEquals(readRefusal({ code: "YUS11" }), "stale_attempt");
  assertEquals(readRefusal({ code: "YUS14" }), "no_public_row");
  assertEquals(readRefusal({ code: "YUS15" }), "target_not_authorized");
  assertEquals(readRefusal({ code: "YUS16" }), "channel_may_have_published");
  assertEquals(readRefusal({ code: "P0001" }), null);
  assertEquals(readRefusal(null), null);
});

Deno.test("a raised refusal becomes a reason the caller can branch on", async () => {
  const { client } = recordingClient({
    claim_youtube_upload_session: { data: null, error: { code: "YUS07", message: "another worker owns the session" } },
  });
  const store = createSupabaseYoutubeUploadSessionStore(client);
  const result = await store.claim({ sessionId: SESSION_ID, leaseToken: LEASE, leaseMs: 1000 });
  assertEquals(result.refused, "lease_held");
  assertEquals(result.record, null);
});

Deno.test("a session that needs a human comes back as a refusal", async () => {
  const { client } = recordingClient({
    admit_youtube_upload: { session: { id: SESSION_ID, state: "reconcile" } },
  });
  const store = createSupabaseYoutubeUploadSessionStore(client);
  const result = await store.admit({
    postId: POST_ID,
    socialAccountId: ACCOUNT_ID,
    mediaFileId: null,
    mediaObjectVersion: null,
    mediaSize: 100,
    totalBytes: 100,
    uploadBody: {},
    expectedContent: null,
    userId: OWNER_ID,
    attemptStartedAt: null,
    targetAccountIds: [],
  });
  assertEquals(result.refused, "reconcile_required");
});

Deno.test("the settlement is asked for with the lease that owns it", async () => {
  const { client, calls } = recordingClient({
    settle_youtube_upload_session: { settled: true },
  });
  const store = createSupabaseYoutubeUploadSessionStore(client);
  const result = await store.settle({
    sessionId: SESSION_ID,
    leaseToken: LEASE,
    status: "success",
    videoId: "abcdefghijk",
    errorMessage: null,
    responseData: { youtube_video_id: "abcdefghijk" },
  });
  assertEquals(result.settled, true);

  const call = calls.find((entry) => entry.fn === "settle_youtube_upload_session");
  assert(call !== undefined);
  assertEquals(call.args.p_lease_token, LEASE);
  assertEquals(call.args.p_status, "success");
  assertEquals(call.args.p_video_id, "abcdefghijk");
});

Deno.test("a refused settlement is not a success", async () => {
  const { client } = recordingClient({
    settle_youtube_upload_session: { data: null, error: { code: "YUS09", message: "the lease is stale" } },
  });
  const store = createSupabaseYoutubeUploadSessionStore(client);
  const result = await store.settle({
    sessionId: SESSION_ID,
    leaseToken: LEASE,
    status: "success",
    videoId: "abcdefghijk",
  });
  assertEquals(result.settled, false);
  assertEquals(result.refused, "lease_stale");
});

Deno.test("the receipt is projected without a lease", async () => {
  const { client, calls } = recordingClient({
    project_youtube_upload_receipt: { settled: true, video_id: "abcdefghijk" },
  });
  const store = createSupabaseYoutubeUploadSessionStore(client);
  const result = await store.projectReceipt({ sessionId: SESSION_ID });
  assertEquals(result.settled, true);
  assertEquals(result.videoId, "abcdefghijk");

  const call = calls.find((entry) => entry.fn === "project_youtube_upload_receipt");
  assert(call !== undefined);
  assertEquals(call.args.p_session_id, SESSION_ID);
  // A projection is not a provider write, so it asks for no lease.
  assertEquals("p_lease_token" in call.args, false);
});

// ───────────────────────────────────────────────────────────────────────────
// The rules the store keeps
// ───────────────────────────────────────────────────────────────────────────

function openStore() {
  return createInMemoryYoutubeUploadSessionStore();
}

const admitInput = {
  postId: POST_ID,
  socialAccountId: ACCOUNT_ID,
  mediaFileId: null,
  mediaObjectVersion: null,
  mediaSize: 100,
  totalBytes: 100,
  uploadBody: { snippet: { title: "A video" } },
  // The post content the upload body was built from. The store compares it
  // with the live post under the post's lock, so a body that was built from a
  // stale read is refused instead of being blessed.
  expectedContent: { caption: "A video" },
  userId: OWNER_ID,
  attemptStartedAt: "2026-11-18T00:00:00.000Z",
  targetAccountIds: [ACCOUNT_ID],
};

Deno.test("the admission creates the session and the public row together", async () => {
  const store = openStore();
  const admitted = await store.admit(admitInput);
  assert(admitted.record !== null);
  assert(admitted.platformPostId !== null);
  assertEquals(admitted.refused, null);
  assertEquals(admitted.record.id.length > 0, true);
  // There is no window where one exists without the other.
  assertEquals(admitted.platformPostId.length > 0, true);
  assertEquals(admitted.record.platformPostId, admitted.platformPostId);
});

Deno.test("one session serves one post and one account", async () => {
  const store = openStore();
  const first = await store.admit(admitInput);
  const second = await store.admit(admitInput);
  assertEquals(first.record?.id, second.record?.id);
  assertEquals(store.sessions.size, 1);
});

Deno.test("the settings of the request travel with the session", async () => {
  const store = openStore();
  const admitted = await store.admit({
    ...admitInput,
    uploadSettings: { part: "snippet,status", notifySubscribers: false },
  });

  // A worker that opens the provider session later reads these settings, so it
  // makes the request that was approved: the same parts, and the same
  // subscriber notification.
  assertEquals(admitted.record?.uploadSettings, { part: "snippet,status", notifySubscribers: false });
});

Deno.test("a session admitted without settings is read as the request its body describes", async () => {
  const store = openStore();
  const admitted = await store.admit(admitInput);

  assertEquals(admitted.record?.uploadSettings, { part: "snippet", notifySubscribers: true });
});

Deno.test("another owner cannot ask for the same session", async () => {
  const store = openStore();
  await store.admit(admitInput);
  const other = await store.admit({ ...admitInput, userId: "77777777-7777-7777-7777-777777777777" });
  assertEquals(other.refused, "post_not_found");
});

Deno.test("a post that changed while the upload was in flight is refused", async () => {
  const store = openStore();
  await store.admit(admitInput);
  const changed = await store.admit({ ...admitInput, uploadBody: { snippet: { title: "Another video" } } });
  assertEquals(changed.refused, "content_changed");
});

Deno.test("a retried upload that never sent a byte is started again", async () => {
  const store = openStore();
  const opened = await store.admit(admitInput);
  const sessionId = opened.record!.id;
  await store.claim({ sessionId, leaseToken: "lease-a", leaseMs: 60_000 });
  // The provider refused the upload and the worker gave up. No byte ever
  // reached the provider, so a second attempt cannot create a second video.
  //
  // The worker settles the outcome before it lets go: the settlement is
  // fenced to the owner of the lease, and it is what releases the lease. A
  // session that a worker still owns is never started again.
  const settled = await store.settle({
    sessionId,
    leaseToken: "lease-a",
    status: "failed",
    errorMessage: "the provider refused the upload",
  });
  assertEquals(settled.settled, true);
  assertEquals(store.sessions.get(sessionId)?.state, "failed");

  // The customer retries the post. The retry changes publish_requested_at, so
  // the content of the previous attempt no longer matches the live post.
  const retried = await store.admit({
    ...admitInput,
    expectedContent: { caption: "A video", publish_requested_at: "2026-11-19T00:00:00.000Z" },
    attemptStartedAt: "2026-11-19T00:00:00.000Z",
  });
  assertEquals(retried.refused, null);
  assertEquals(retried.record?.state, "open");
  // The upload starts from the beginning, with no provider session.
  assertEquals(retried.record?.sessionUri, null);
  assertEquals(retried.record?.confirmedBytes, 0);
  assertEquals(retried.record?.attemptStartedAt, "2026-11-19T00:00:00.000Z");
});

Deno.test("a retry with a new version of the same file is rebound to that version", async () => {
  const store = openStore();
  const opened = await store.admit({ ...admitInput, mediaFileId: "media-1", mediaObjectVersion: 1 });
  const sessionId = opened.record!.id;
  await store.claim({ sessionId, leaseToken: "lease-a", leaseMs: 60_000 });
  await store.settle({
    sessionId,
    leaseToken: "lease-a",
    status: "failed",
    errorMessage: "the provider refused the upload",
  });
  assertEquals(store.sessions.get(sessionId)?.state, "failed");

  // The customer replaced the file under the same name, so the file the post
  // names did not change but the content version did. The session still points
  // at the version that is gone, so it is rebound to the version the file
  // carries now.
  const retried = await store.admit({
    ...admitInput,
    mediaFileId: "media-1",
    mediaObjectVersion: 2,
    expectedContent: { caption: "A video", publish_requested_at: "2026-11-19T00:00:00.000Z" },
    attemptStartedAt: "2026-11-19T00:00:00.000Z",
  });
  assertEquals(retried.refused, null);
  assertEquals(retried.record?.state, "open");
  // The session follows the version the worker proved it read, and it starts
  // from the beginning: nothing of the old version ever reached the provider.
  assertEquals(retried.record?.mediaObjectVersion, 2);
  assertEquals(retried.record?.confirmedBytes, 0);
});

Deno.test("a rebind that names no version is refused", async () => {
  const store = openStore();
  const opened = await store.admit({ ...admitInput, mediaFileId: "media-1", mediaObjectVersion: 1 });
  const sessionId = opened.record!.id;
  await store.claim({ sessionId, leaseToken: "lease-a", leaseMs: 60_000 });
  await store.settle({
    sessionId,
    leaseToken: "lease-a",
    status: "failed",
    errorMessage: "the provider refused the upload",
  });

  // The customer replaced the file under the same name, and the worker names
  // no version. The rebind may not pin a version that nobody proved it read.
  const retried = await store.admit({
    ...admitInput,
    mediaFileId: "media-1",
    mediaObjectVersion: null,
    expectedContent: { caption: "A video", publish_requested_at: "2026-11-19T00:00:00.000Z" },
    attemptStartedAt: "2026-11-19T00:00:00.000Z",
  });
  assertEquals(retried.refused, "media_not_owned");
  // The refusal pins nothing: the session is left exactly as it was.
  assertEquals(store.sessions.get(sessionId)?.mediaObjectVersion, 1);
  assertEquals(store.sessions.get(sessionId)?.state, "failed");
});

Deno.test("a session that a worker still owns is not started again", async () => {
  const store = openStore();
  const opened = await store.admit(admitInput);
  const sessionId = opened.record!.id;
  await store.claim({ sessionId, leaseToken: "lease-a", leaseMs: 60_000 });
  // The worker gave up and released the session, but it still owns the lease:
  // it is about to settle the public row with it.
  await store.release({ sessionId, leaseToken: "lease-a", state: "failed" });

  // The customer retries the post. The session is NOT started again: a
  // restart under the worker that owns it would settle the new attempt with
  // the old outcome, and the lease stays with its owner.
  const retried = await store.admit({
    ...admitInput,
    expectedContent: { caption: "A video", publish_requested_at: "2026-11-19T00:00:00.000Z" },
    attemptStartedAt: "2026-11-19T00:00:00.000Z",
  });
  assertEquals(retried.refused, "content_changed");
  assertEquals(store.sessions.get(sessionId)?.state, "failed");
  assertEquals(store.sessions.get(sessionId)?.leaseToken, "lease-a");

  // The lease is the only thing that keeps the session closed. Once it is
  // gone, the retry is admitted again.
  const expired = await store.claim({ sessionId, leaseToken: "lease-a", leaseMs: 0 });
  assertEquals(expired.refused, null);
});

Deno.test("a session that another worker owns keeps its attempt", async () => {
  const store = openStore();
  const opened = await store.admit(admitInput);
  const sessionId = opened.record!.id;
  await store.claim({ sessionId, leaseToken: "lease-a", leaseMs: 60_000 });
  await store.release({ sessionId, leaseToken: "lease-a", state: "failed" });

  // A second worker asks for the same post while the first one still owns the
  // session. Nothing refuses it: the content is the same, so the session is
  // simply left alone.
  const asked = await store.admit({
    ...admitInput,
    attemptStartedAt: "2026-11-19T00:00:00.000Z",
  });
  assertEquals(asked.refused, null);
  assertEquals(asked.record?.state, "failed");

  // The session keeps the attempt of the worker that owns it. An attempt that
  // took it over would be settled with the outcome of the old one, and the
  // owner is about to settle it.
  assertEquals(asked.record?.attemptStartedAt, "2026-11-18T00:00:00.000Z");

  // And the claim refuses it: the lease is the only thing that keeps the
  // session closed, and it belongs to the other worker.
  const claimed = await store.claim({ sessionId, leaseToken: "lease-b", leaseMs: 60_000 });
  assertEquals(claimed.refused, "lease_held");
});

Deno.test("a session whose provider session expired under a live lease keeps its attempt", async () => {
  const store = openStore();
  const opened = await store.admit(admitInput);
  const sessionId = opened.record!.id;
  await store.claim({ sessionId, leaseToken: "lease-a", leaseMs: 60_000 });

  // The provider session is gone, and the worker that owns the session is
  // about to settle it.
  store.sessions.get(sessionId)!.sessionExpiresAt = Date.now() - 1;

  const asked = await store.admit({
    ...admitInput,
    attemptStartedAt: "2026-11-19T00:00:00.000Z",
  });
  assertEquals(asked.refused, null);
  assertEquals(asked.record?.state, "open");

  // The session is left alone, so it keeps the attempt of the worker that
  // owns it. A session that was started again would belong to the new one.
  assertEquals(asked.record?.attemptStartedAt, "2026-11-18T00:00:00.000Z");

  const claimed = await store.claim({ sessionId, leaseToken: "lease-b", leaseMs: 60_000 });
  assertEquals(claimed.refused, "lease_held");
});

Deno.test("a session that ran out of continuations is started again with a fresh count", async () => {
  const store = openStore();
  const opened = await store.admit(admitInput);
  const sessionId = opened.record!.id;
  await store.claim({ sessionId, leaseToken: "lease-a", leaseMs: 60_000 });
  const exhausted = store.sessions.get(sessionId)!;
  exhausted.continuationCount = 24;
  exhausted.nextCheckAt = Date.now() + 60_000;
  exhausted.lastOutcome = "youtube_upload_unsent";
  await store.release({ sessionId, leaseToken: "lease-a", state: "failed" });
  await store.settle({ sessionId, leaseToken: "lease-a", status: "failed", errorMessage: "the provider refused it" });

  const retried = await store.admit(admitInput);
  assertEquals(retried.refused, null);
  assertEquals(retried.record?.state, "open");
  assertEquals(retried.record?.continuationCount, 0);
  assertEquals(retried.record?.nextCheckAt, null);
  assertEquals(retried.record?.lastOutcome, null);

  // A fresh count is a claimable session: the count of the old attempt would
  // refuse every later claim for ever.
  const claimed = await store.claim({ sessionId, leaseToken: "lease-b", leaseMs: 60_000 });
  assertEquals(claimed.refused, null);
});

Deno.test("a failure that sent a byte is left for a human, not failed", async () => {
  const store = openStore();
  const opened = await store.admit(admitInput);
  const sessionId = opened.record!.id;
  await store.claim({ sessionId, leaseToken: "lease-a", leaseMs: 60_000 });
  // A byte reached the provider, so a video may exist there. The same
  // session is an uncertain one when its worker died and when it settled
  // the failure itself.
  await store.checkpoint({
    sessionId,
    leaseToken: "lease-a",
    confirmedBytes: 100,
    bytesSent: 100,
    videoMayExist: false,
  });

  const settled = await store.settle({
    sessionId,
    leaseToken: "lease-a",
    status: "failed",
    errorMessage: "the upload did not finish",
  });
  assertEquals(settled.settled, true);
  assertEquals(store.sessions.get(sessionId)?.state, "reconcile");
});

Deno.test("a receipt answers the attempt that stored it", async () => {
  const store = openStore();
  const opened = await store.admit(admitInput);
  const sessionId = opened.record!.id;
  await store.claim({ sessionId, leaseToken: "lease-a", leaseMs: 60_000 });
  await store.complete({ sessionId, leaseToken: "lease-a", videoId: "yt-video-1" });

  // The same attempt is answered with the receipt.
  const same = await store.admit(admitInput);
  assertEquals(same.refused, null);
  assertEquals(same.record?.state, "uploaded");

  // Another attempt is not: the receipt proves that the provider holds a
  // video for the attempt that stored it, and says nothing about a later one.
  const other = await store.admit({ ...admitInput, attemptStartedAt: "2026-11-19T00:00:00.000Z" });
  assertEquals(other.refused, "already_published");
  assertEquals(other.record, null);
});

Deno.test("an upload that may hold a video is never started again", async () => {
  const store = openStore();
  const opened = await store.admit(admitInput);
  const sessionId = opened.record!.id;
  await store.claim({ sessionId, leaseToken: "lease-a", leaseMs: 60_000 });
  // The last chunk may have been written, so a video may exist.
  await store.checkpoint({
    sessionId,
    leaseToken: "lease-a",
    confirmedBytes: 100,
    bytesSent: 100,
    videoMayExist: true,
  });
  await store.release({ sessionId, leaseToken: "lease-a", state: "failed" });

  // A failure that may hold a video is left for a human: a second attempt
  // could put a second video on the channel.
  const again = await store.admit(admitInput);
  assertEquals(again.refused, "reconcile_required");
  assertEquals(store.sessions.get(sessionId)?.state, "reconcile");
});

Deno.test("only one worker owns a session at a time", async () => {
  const store = openStore();
  const opened = await store.admit(admitInput);
  const sessionId = opened.record!.id;
  const first = await store.claim({ sessionId, leaseToken: "lease-a", leaseMs: 60_000 });
  assertEquals(first.refused, null);
  const second = await store.claim({ sessionId, leaseToken: "lease-b", leaseMs: 60_000 });
  assertEquals(second.refused, "lease_held");
});

Deno.test("the owner of a session may take it again", async () => {
  const store = openStore();
  const opened = await store.admit(admitInput);
  const sessionId = opened.record!.id;
  await store.claim({ sessionId, leaseToken: "lease-a", leaseMs: 60_000 });
  const again = await store.claim({ sessionId, leaseToken: "lease-a", leaseMs: 60_000 });
  assertEquals(again.refused, null);
});

Deno.test("a worker whose lease is stale cannot write", async () => {
  let clock = 1_000;
  const store = createInMemoryYoutubeUploadSessionStore({ now: () => clock });
  const opened = await store.admit(admitInput);
  const sessionId = opened.record!.id;
  await store.claim({ sessionId, leaseToken: "lease-a", leaseMs: 1_000 });
  clock += 2_000;
  const written = await store.checkpoint({
    sessionId,
    leaseToken: "lease-a",
    confirmedBytes: 10,
    bytesSent: 10,
  });
  assertEquals(written, false);
});

Deno.test("an offset only ever grows", async () => {
  const store = openStore();
  const opened = await store.admit(admitInput);
  const sessionId = opened.record!.id;
  await store.claim({ sessionId, leaseToken: "lease-a", leaseMs: 60_000 });
  await store.checkpoint({ sessionId, leaseToken: "lease-a", confirmedBytes: 50, bytesSent: 50 });
  await store.checkpoint({ sessionId, leaseToken: "lease-a", confirmedBytes: 10, bytesSent: 10 });
  const record = (await store.claim({ sessionId, leaseToken: "lease-a", leaseMs: 60_000 })).record;
  assertEquals(record?.confirmedBytes, 50);
});

Deno.test("the uncertainty that a video may exist never clears", async () => {
  const store = openStore();
  const opened = await store.admit(admitInput);
  const sessionId = opened.record!.id;
  await store.claim({ sessionId, leaseToken: "lease-a", leaseMs: 60_000 });
  await store.checkpoint({
    sessionId,
    leaseToken: "lease-a",
    confirmedBytes: 100,
    bytesSent: 100,
    videoMayExist: true,
  });
  // A later checkpoint that says "no video yet" cannot take it back.
  await store.checkpoint({
    sessionId,
    leaseToken: "lease-a",
    confirmedBytes: 100,
    bytesSent: 100,
    videoMayExist: false,
  });
  const record = (await store.claim({ sessionId, leaseToken: "lease-a", leaseMs: 60_000 })).record;
  assertEquals(record?.videoMayExist, true);
});

Deno.test("the receipt is kept and the session uri is dropped with it", async () => {
  const store = openStore();
  const opened = await store.admit(admitInput);
  const sessionId = opened.record!.id;
  await store.claim({ sessionId, leaseToken: "lease-a", leaseMs: 60_000 });
  await store.checkpoint({
    sessionId,
    leaseToken: "lease-a",
    confirmedBytes: 0,
    bytesSent: 0,
    sessionUri: "https://www.googleapis.com/upload?upload_id=secret",
  });
  const completed = await store.complete({ sessionId, leaseToken: "lease-a", videoId: "abcdefghijk" });
  assertEquals(completed, true);

  const record = store.sessions.get(sessionId);
  assertEquals(record?.videoId, "abcdefghijk");
  assertEquals(record?.sessionUri, null);
  assertEquals(record?.state, "uploaded");

  // The owner still holds its lease: it is the one that has to settle, and a
  // takeover would settle the same row twice.
  assertEquals(record?.leaseToken, "lease-a");
  const takeover = await store.claim({ sessionId, leaseToken: "lease-b", leaseMs: 60_000 });
  assertEquals(takeover.refused, "lease_held");
  assertEquals(takeover.record, null);
});

Deno.test("a takeover after the lease ran out inherits the receipt", async () => {
  let clock = 1_000;
  const store = createInMemoryYoutubeUploadSessionStore({ now: () => clock });
  const opened = await store.admit(admitInput);
  const sessionId = opened.record!.id;
  await store.claim({ sessionId, leaseToken: "lease-a", leaseMs: 1_000 });
  await store.checkpoint({
    sessionId,
    leaseToken: "lease-a",
    confirmedBytes: 0,
    bytesSent: 0,
    sessionUri: "https://www.googleapis.com/upload?upload_id=secret",
  });
  await store.complete({ sessionId, leaseToken: "lease-a", videoId: "abcdefghijk" });

  // The owner died before it could settle. Its lease runs out.
  clock += 2_000;

  const takeover = await store.claim({ sessionId, leaseToken: "lease-b", leaseMs: 60_000 });
  assertEquals(takeover.record?.videoId, "abcdefghijk");
  assertEquals(takeover.record?.sessionUri, null);
  assertEquals(takeover.record?.state, "uploaded");
});

Deno.test("the owner keeps its lease after the receipt so it can settle", async () => {
  const store = openStore();
  const opened = await store.admit(admitInput);
  const sessionId = opened.record!.id;
  await store.claim({ sessionId, leaseToken: "lease-a", leaseMs: 60_000 });
  await store.complete({ sessionId, leaseToken: "lease-a", videoId: "abcdefghijk" });

  const settled = await store.settle({
    sessionId,
    leaseToken: "lease-a",
    status: "success",
    videoId: "abcdefghijk",
  });
  assertEquals(settled.settled, true);
});

Deno.test("a worker that lost the lease settles nothing", async () => {
  const store = openStore();
  const opened = await store.admit(admitInput);
  const sessionId = opened.record!.id;
  await store.claim({ sessionId, leaseToken: "lease-a", leaseMs: 60_000 });

  const stale = await store.settle({
    sessionId,
    leaseToken: "lease-b",
    status: "success",
    videoId: "abcdefghijk",
  });
  assertEquals(stale.settled, false);
  assertEquals(stale.refused, "lease_stale");
});

Deno.test("a worker that lost the lease to a takeover settles nothing", async () => {
  let clock = 1_000;
  const store = createInMemoryYoutubeUploadSessionStore({ now: () => clock });
  const opened = await store.admit(admitInput);
  const sessionId = opened.record!.id;
  await store.claim({ sessionId, leaseToken: "lease-a", leaseMs: 1_000 });

  // The first worker is paused until its lease runs out.
  clock += 2_000;
  const taken = await store.claim({ sessionId, leaseToken: "lease-b", leaseMs: 60_000 });
  assertEquals(taken.refused, null);

  // The first worker wakes up and tries to settle what it believes it wrote.
  const stale = await store.settle({
    sessionId,
    leaseToken: "lease-a",
    status: "success",
    videoId: "abcdefghijk",
  });
  assertEquals(stale.settled, false);

  // And it may not write anything else either.
  const checkpoint = await store.checkpoint({
    sessionId,
    leaseToken: "lease-a",
    confirmedBytes: 100,
    bytesSent: 100,
    videoMayExist: true,
  });
  assertEquals(checkpoint, false);

  // The worker that owns the session settles it.
  const owned = await store.settle({
    sessionId,
    leaseToken: "lease-b",
    status: "success",
    videoId: "abcdefghijk",
  });
  assertEquals(owned.settled, true);
});

Deno.test("a failed settlement leaves a session that may hold a video for a human", async () => {
  const store = openStore();
  const opened = await store.admit(admitInput);
  const sessionId = opened.record!.id;
  await store.claim({ sessionId, leaseToken: "lease-a", leaseMs: 60_000 });
  await store.checkpoint({
    sessionId,
    leaseToken: "lease-a",
    confirmedBytes: 100,
    bytesSent: 100,
    videoMayExist: true,
  });
  const settled = await store.settle({
    sessionId,
    leaseToken: "lease-a",
    status: "failed",
    errorMessage: "youtube_upload_reconcile_required",
  });
  assertEquals(settled.settled, true);
  // A session that may hold a video is left for a human, and it is not
  // handed out as a continuation.
  assertEquals(store.sessions.get(sessionId)?.state, "reconcile");
  assertEquals(store.sessions.get(sessionId)?.videoId, null);
  const claims = await store.claimContinuations({ limit: 5, leaseMs: 60_000 });
  assertEquals(claims.length, 0);
});

Deno.test("a receipt is projected onto the public row without a lease", async () => {
  const store = openStore();
  const opened = await store.admit(admitInput);
  const sessionId = opened.record!.id;
  await store.claim({ sessionId, leaseToken: "lease-a", leaseMs: 60_000 });
  await store.complete({ sessionId, leaseToken: "lease-a", videoId: "abcdefghijk" });

  const projected = await store.projectReceipt({ sessionId });
  assertEquals(projected.settled, true);
  assertEquals(projected.videoId, "abcdefghijk");
});

Deno.test("a session with no receipt cannot be projected", async () => {
  const store = openStore();
  const opened = await store.admit(admitInput);
  const projected = await store.projectReceipt({ sessionId: opened.record!.id });
  assertEquals(projected.settled, false);
  assertEquals(projected.refused, "reconcile_required");
});

Deno.test("a released session never takes back a receipt", async () => {
  let clock = 1_000;
  const store = createInMemoryYoutubeUploadSessionStore({ now: () => clock });
  const opened = await store.admit(admitInput);
  const sessionId = opened.record!.id;
  await store.claim({ sessionId, leaseToken: "lease-a", leaseMs: 1_000 });
  await store.complete({ sessionId, leaseToken: "lease-a", videoId: "abcdefghijk" });
  const released = await store.release({ sessionId, leaseToken: "lease-a", state: "reconcile" });
  assertEquals(released, false);
  // The receipt is still there, and the owner still owns the session.
  assertEquals(store.sessions.get(sessionId)?.videoId, "abcdefghijk");
  assertEquals(store.sessions.get(sessionId)?.state, "uploaded");

  clock += 2_000;
  const takeover = await store.claim({ sessionId, leaseToken: "lease-b", leaseMs: 60_000 });
  assertEquals(takeover.record?.videoId, "abcdefghijk");
});

Deno.test("the continuation claim hands out a token and not the session uri", async () => {
  // The worker that started the upload has died, so its lease is gone.
  let clock = 1_000;
  const store = createInMemoryYoutubeUploadSessionStore({ now: () => clock });
  const opened = await store.admit(admitInput);
  const sessionId = opened.record!.id;
  await store.claim({ sessionId, leaseToken: "lease-a", leaseMs: 1_000 });
  await store.checkpoint({
    sessionId,
    leaseToken: "lease-a",
    confirmedBytes: 0,
    bytesSent: 0,
    sessionUri: "https://www.googleapis.com/upload?upload_id=secret",
  });
  clock += 2_000;

  const claims = await store.claimContinuations({ limit: 5, leaseMs: 60_000 });
  assertEquals(claims.length, 1);
  assertEquals(claims[0].sessionId, sessionId);
  assertEquals(claims[0].leaseToken.length > 0, true);
  // The claim carries no session uri at all.
  assertEquals(JSON.stringify(claims).includes("secret"), false);
});

Deno.test("a session that never got a provider session is still eligible", async () => {
  const store = openStore();
  const opened = await store.admit(admitInput);
  const claims = await store.claimContinuations({ limit: 5, leaseMs: 60_000 });
  assertEquals(claims.length, 1);
  assertEquals(claims[0].sessionId, opened.record!.id);
});

Deno.test("a receipt that is waiting for the public row is still eligible", async () => {
  // The worker that stored the receipt died before it could settle the row,
  // so its lease ran out with the receipt still on the session.
  let clock = 1_000;
  const store = createInMemoryYoutubeUploadSessionStore({ now: () => clock });
  const opened = await store.admit(admitInput);
  const sessionId = opened.record!.id;
  await store.claim({ sessionId, leaseToken: "lease-a", leaseMs: 1_000 });
  await store.complete({ sessionId, leaseToken: "lease-a", videoId: "abcdefghijk" });
  clock += 2_000;

  const claims = await store.claimContinuations({ limit: 5, leaseMs: 60_000 });
  assertEquals(claims.length, 1);
  assertEquals(claims[0].state, "uploaded");
  // A receipt projection is not a provider write, so it is not a continuation.
  assertEquals(claims[0].continuationCount, 0);
});

Deno.test("a session that is not due is not claimed", async () => {
  let clock = 1_000;
  const store = createInMemoryYoutubeUploadSessionStore({ now: () => clock });
  const opened = await store.admit(admitInput);
  const sessionId = opened.record!.id;
  await store.claim({ sessionId, leaseToken: "lease-a", leaseMs: 1_000 });
  await store.checkpoint({
    sessionId,
    leaseToken: "lease-a",
    confirmedBytes: 0,
    bytesSent: 0,
    sessionUri: "https://www.googleapis.com/upload?upload_id=secret",
    nextCheckAt: new Date(clock + 600_000).toISOString(),
  });
  clock += 2_000;
  const claims = await store.claimContinuations({ limit: 5, leaseMs: 60_000 });
  assertEquals(claims.length, 0);
});

Deno.test("a session that a live lease holds is not claimed", async () => {
  const store = openStore();
  const opened = await store.admit(admitInput);
  const sessionId = opened.record!.id;
  await store.claim({ sessionId, leaseToken: "lease-a", leaseMs: 60_000 });
  await store.checkpoint({
    sessionId,
    leaseToken: "lease-a",
    confirmedBytes: 0,
    bytesSent: 0,
    sessionUri: "https://www.googleapis.com/upload?upload_id=secret",
  });
  const claims = await store.claimContinuations({ limit: 5, leaseMs: 60_000 });
  assertEquals(claims.length, 0);
});

Deno.test("two continuation claims do not hand out the same session", async () => {
  let clock = 1_000;
  const store = createInMemoryYoutubeUploadSessionStore({ now: () => clock });
  const opened = await store.admit(admitInput);
  const sessionId = opened.record!.id;
  await store.claim({ sessionId, leaseToken: "lease-a", leaseMs: 1_000 });
  await store.checkpoint({
    sessionId,
    leaseToken: "lease-a",
    confirmedBytes: 0,
    bytesSent: 0,
    sessionUri: "https://www.googleapis.com/upload?upload_id=secret",
  });
  clock += 2_000;
  const first = await store.claimContinuations({ limit: 5, leaseMs: 60_000 });
  const second = await store.claimContinuations({ limit: 5, leaseMs: 60_000 });
  assertEquals(first.length, 1);
  assertEquals(second.length, 0);
});

Deno.test("the claim token is what lets the worker take the session", async () => {
  let clock = 1_000;
  const store = createInMemoryYoutubeUploadSessionStore({ now: () => clock });
  const opened = await store.admit(admitInput);
  const sessionId = opened.record!.id;
  await store.claim({ sessionId, leaseToken: "lease-a", leaseMs: 1_000 });
  await store.checkpoint({
    sessionId,
    leaseToken: "lease-a",
    confirmedBytes: 0,
    bytesSent: 0,
    sessionUri: "https://www.googleapis.com/upload?upload_id=secret",
  });
  clock += 2_000;
  const claims = await store.claimContinuations({ limit: 5, leaseMs: 60_000 });
  const wrong = await store.claim({ sessionId, leaseToken: "other-lease", leaseMs: 60_000 });
  assertEquals(wrong.refused, "lease_held");
  const right = await store.claim({ sessionId, leaseToken: claims[0].leaseToken, leaseMs: 60_000 });
  assertEquals(right.refused, null);
});

// ───────────────────────────────────────────────────────────────────────────
// The terminal handoff
//
// The receipt is kept and the lease is kept with it: the worker that stored
// the receipt is the one that has to settle the public row, and the
// settlement is fenced on the lease it was given.
// ───────────────────────────────────────────────────────────────────────────

Deno.test("a released session keeps its lease so the owner can settle it", async () => {
  const store = openStore();
  const opened = await store.admit(admitInput);
  const sessionId = opened.record!.id;
  await store.claim({ sessionId, leaseToken: "lease-a", leaseMs: 60_000 });
  const released = await store.release({ sessionId, leaseToken: "lease-a", state: "failed" });
  assertEquals(released, true);
  assertEquals(store.sessions.get(sessionId)?.leaseToken, "lease-a");

  const settled = await store.settle({
    sessionId,
    leaseToken: "lease-a",
    status: "failed",
    errorMessage: "the provider refused the upload",
  });
  assertEquals(settled.settled, true);
  assertEquals(store.sessions.get(sessionId)?.leaseToken, null);
});

// ───────────────────────────────────────────────────────────────────────────
// The continuation cap
//
// The dispatch that brought the count to the cap is consumable by the lease
// it was handed. Everyone else is refused.
// ───────────────────────────────────────────────────────────────────────────

Deno.test("the holder of the live lease may consume the dispatch that reached the cap", async () => {
  const store = openStore();
  const opened = await store.admit(admitInput);
  const sessionId = opened.record!.id;
  await store.claim({ sessionId, leaseToken: "lease-a", leaseMs: 60_000 });
  store.sessions.get(sessionId)!.continuationCount = 24;

  const held = await store.claim({ sessionId, leaseToken: "lease-a", leaseMs: 60_000 });
  assertEquals(held.refused, null);
});

Deno.test("a claim that holds no live lease is refused at the cap", async () => {
  let clock = 1_000;
  const store = createInMemoryYoutubeUploadSessionStore({ now: () => clock });
  const opened = await store.admit(admitInput);
  const sessionId = opened.record!.id;
  await store.claim({ sessionId, leaseToken: "lease-a", leaseMs: 1_000 });
  store.sessions.get(sessionId)!.continuationCount = 24;
  clock += 2_000;

  const refused = await store.claim({ sessionId, leaseToken: "lease-b", leaseMs: 60_000 });
  assertEquals(refused.refused, "too_many_continuations");
  assertEquals(refused.record, null);
});

Deno.test("the continuation claim stops at the cap", async () => {
  // The database does not hand out a session that is at the cap: it
  // classifies it instead, because a session that keeps failing is not asked
  // for ever.
  let clock = 1_000;
  const store = createInMemoryYoutubeUploadSessionStore({ now: () => clock });
  const opened = await store.admit(admitInput);
  const sessionId = opened.record!.id;
  await store.claim({ sessionId, leaseToken: "lease-a", leaseMs: 1_000 });
  await store.checkpoint({
    sessionId,
    leaseToken: "lease-a",
    confirmedBytes: 0,
    bytesSent: 0,
    sessionUri: "https://www.googleapis.com/upload?upload_id=secret",
  });
  clock += 2_000;
  store.sessions.get(sessionId)!.continuationCount = 24;

  const claims = await store.claimContinuations({ limit: 5, leaseMs: 60_000 });
  assertEquals(claims.length, 0);
});

// ───────────────────────────────────────────────────────────────────────────
// The admission compares the caller's snapshot with the live post
// ───────────────────────────────────────────────────────────────────────────

Deno.test("an admission built from a stale snapshot is refused", async () => {
  const store = openStore();
  await store.admit(admitInput);
  const stale = await store.admit({ ...admitInput, expectedContent: { caption: "Another video" } });
  assertEquals(stale.refused, "content_changed");
  assertEquals(stale.record, null);
});

// ───────────────────────────────────────────────────────────────────────────
// The fanout closure
// ───────────────────────────────────────────────────────────────────────────

Deno.test("a settled session closes its own fanout", async () => {
  const store = openStore();
  const opened = await store.admit(admitInput);
  const sessionId = opened.record!.id;
  await store.claim({ sessionId, leaseToken: "lease-a", leaseMs: 60_000 });
  await store.complete({ sessionId, leaseToken: "lease-a", videoId: "abcdefghijk" });
  await store.settle({ sessionId, leaseToken: "lease-a", status: "success", videoId: "abcdefghijk" });

  const recovered = await store.recoverFanout({ sessionId });
  assertEquals(recovered.recovered, true);
  assertEquals(store.fanoutRecoveries.get(sessionId), 1);
});

Deno.test("a session that is neither terminal nor leased closes no fanout", async () => {
  const store = openStore();
  const opened = await store.admit(admitInput);
  const sessionId = opened.record!.id;
  await store.claim({ sessionId, leaseToken: "lease-a", leaseMs: 60_000 });

  // The owner may close it: it still holds the lease.
  const owned = await store.recoverFanout({ sessionId, leaseToken: "lease-a" });
  assertEquals(owned.recovered, true);

  // A caller that owns nothing may not.
  const stranger = await store.recoverFanout({ sessionId, leaseToken: "lease-b" });
  assertEquals(stranger.recovered, false);
  assertEquals(stranger.reason, "lease_stale");
});
