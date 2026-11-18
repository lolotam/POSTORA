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
      if (response && typeof response === "object" && "error" in response) {
        return Promise.resolve({ data: null, error: (response as { error: unknown }).error });
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
  await store.claim({ sessionId: SESSION_ID, leaseToken: LEASE, leaseMs: 180_000 });

  const call = calls.find((entry) => entry.fn === "claim_youtube_upload_session");
  assert(call !== undefined);
  // The name is the one the function has. A different name is a missing
  // function at run time, not a different argument.
  assertEquals(call.args.p_lease_ms, 180_000);
  assertEquals("p_lease" in call.args, false);
  assertEquals(call.args.p_session_id, SESSION_ID);
  assertEquals(call.args.p_lease_token, LEASE);
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

Deno.test("the admission hands back the public row it created", async () => {
  const { client } = recordingClient({
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
  assertEquals(readRefusal({ code: "P0001" }), null);
  assertEquals(readRefusal(null), null);
});

Deno.test("a raised refusal becomes a reason the caller can branch on", async () => {
  const { client } = recordingClient({
    claim_youtube_upload_session: { error: { code: "YUS07", message: "another worker owns the session" } },
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
    settle_youtube_upload_session: { error: { code: "YUS09", message: "the lease is stale" } },
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
  const record = (await store.claim({ sessionId, leaseToken: "lease-b", leaseMs: 60_000 })).record;
  assertEquals(record?.videoId, "abcdefghijk");
  assertEquals(record?.sessionUri, null);
  assertEquals(record?.state, "uploaded");
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
  const store = openStore();
  const opened = await store.admit(admitInput);
  const sessionId = opened.record!.id;
  await store.claim({ sessionId, leaseToken: "lease-a", leaseMs: 60_000 });
  await store.complete({ sessionId, leaseToken: "lease-a", videoId: "abcdefghijk" });
  const released = await store.release({ sessionId, leaseToken: "lease-a", state: "reconcile" });
  assertEquals(released, false);
  const record = (await store.claim({ sessionId, leaseToken: "lease-b", leaseMs: 60_000 })).record;
  assertEquals(record?.videoId, "abcdefghijk");
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
