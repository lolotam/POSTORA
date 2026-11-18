/**
 * The durable session store.
 *
 * Two things are proved here.
 *
 * The first is the NAMED ARGUMENT CONTRACT. PostgREST sends the named
 * arguments of a function as JSON, and a function that is asked for an
 * argument it does not have is a function that does not exist. The lease is
 * the argument that was wrong: the functions take `p_lease_ms`, a number of
 * milliseconds, and the adapter has to send exactly that name.
 *
 * The second is the RULES the store keeps, proved without a database: one
 * owner per session, offsets that only grow, a receipt that is kept, and a
 * continuation claim that hands out a token and not the session URI.
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

Deno.test("the lease is sent as a number of milliseconds", async () => {
  const { client, calls } = recordingClient({
    claim_youtube_upload_session: {
      id: SESSION_ID,
      post_id: POST_ID,
      social_account_id: ACCOUNT_ID,
      state: "open",
      session_uri: "https://www.googleapis.com/upload?upload_id=secret",
      confirmed_bytes: 0,
      bytes_sent: 0,
      video_may_exist: false,
      total_bytes: 100,
      video_id: null,
      attempt_started_at: "2026-11-18T00:00:00.000Z",
      next_check_at: null,
      last_outcome: null,
      platform_post_id: null,
      media_file_id: null,
      media_object_version: null,
      continuation_count: 0,
    },
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

Deno.test("the session is opened with the attempt and the pending row", async () => {
  const { client, calls } = recordingClient({
    begin_youtube_upload_session: {
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
      platform_post_id: null,
      media_file_id: null,
      media_object_version: null,
      continuation_count: 0,
    },
  });
  const store = createSupabaseYoutubeUploadSessionStore(client);
  await store.begin({
    postId: POST_ID,
    socialAccountId: ACCOUNT_ID,
    platformPostId: "55555555-5555-5555-5555-555555555555",
    mediaFileId: null,
    mediaObjectVersion: null,
    mediaSize: 100,
    totalBytes: 100,
    uploadBody: { snippet: { title: "A video" } },
    userId: "66666666-6666-6666-6666-666666666666",
    attemptStartedAt: "2026-11-18T00:00:00.000Z",
  });

  const call = calls.find((entry) => entry.fn === "begin_youtube_upload_session");
  assert(call !== undefined);
  assertEquals(call.args.p_attempt_started_at, "2026-11-18T00:00:00.000Z");
  assertEquals(call.args.p_platform_post_id, "55555555-5555-5555-5555-555555555555");
});

Deno.test("a refusal is read from the sqlstate", () => {
  assertEquals(readRefusal({ code: "YUS07" }), "lease_held");
  assertEquals(readRefusal({ code: "YUS11" }), "stale_attempt");
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
    begin_youtube_upload_session: { id: SESSION_ID, state: "reconcile" },
  });
  const store = createSupabaseYoutubeUploadSessionStore(client);
  const result = await store.begin({
    postId: POST_ID,
    socialAccountId: ACCOUNT_ID,
    platformPostId: null,
    mediaFileId: null,
    mediaObjectVersion: null,
    mediaSize: 100,
    totalBytes: 100,
    uploadBody: {},
    userId: "66666666-6666-6666-6666-666666666666",
    attemptStartedAt: null,
  });
  assertEquals(result.refused, "reconcile_required");
});

// ───────────────────────────────────────────────────────────────────────────
// The rules the store keeps
// ───────────────────────────────────────────────────────────────────────────

function openStore() {
  const store = createInMemoryYoutubeUploadSessionStore();
  return store;
}

const beginInput = {
  postId: POST_ID,
  socialAccountId: ACCOUNT_ID,
  platformPostId: null,
  mediaFileId: null,
  mediaObjectVersion: null,
  mediaSize: 100,
  totalBytes: 100,
  uploadBody: { snippet: { title: "A video" } },
  userId: "66666666-6666-6666-6666-666666666666",
  attemptStartedAt: "2026-11-18T00:00:00.000Z",
};

Deno.test("one session serves one post and one account", async () => {
  const store = openStore();
  const first = await store.begin(beginInput);
  const second = await store.begin(beginInput);
  assertEquals(first.record?.id, second.record?.id);
  assertEquals(store.sessions.size, 1);
});

Deno.test("another owner cannot ask for the same session", async () => {
  const store = openStore();
  await store.begin(beginInput);
  const other = await store.begin({ ...beginInput, userId: "77777777-7777-7777-7777-777777777777" });
  assertEquals(other.refused, "post_not_found");
});

Deno.test("a post that changed while the upload was in flight is refused", async () => {
  const store = openStore();
  await store.begin(beginInput);
  const changed = await store.begin({ ...beginInput, uploadBody: { snippet: { title: "Another video" } } });
  assertEquals(changed.refused, "content_changed");
});

Deno.test("only one worker owns a session at a time", async () => {
  const store = openStore();
  const opened = await store.begin(beginInput);
  const sessionId = opened.record!.id;
  const first = await store.claim({ sessionId, leaseToken: "lease-a", leaseMs: 60_000 });
  assertEquals(first.refused, null);
  const second = await store.claim({ sessionId, leaseToken: "lease-b", leaseMs: 60_000 });
  assertEquals(second.refused, "lease_held");
});

Deno.test("the owner of a session may take it again", async () => {
  const store = openStore();
  const opened = await store.begin(beginInput);
  const sessionId = opened.record!.id;
  await store.claim({ sessionId, leaseToken: "lease-a", leaseMs: 60_000 });
  const again = await store.claim({ sessionId, leaseToken: "lease-a", leaseMs: 60_000 });
  assertEquals(again.refused, null);
});

Deno.test("a worker whose lease is stale cannot write", async () => {
  let clock = 1_000;
  const store = createInMemoryYoutubeUploadSessionStore({ now: () => clock });
  const opened = await store.begin(beginInput);
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
  const opened = await store.begin(beginInput);
  const sessionId = opened.record!.id;
  await store.claim({ sessionId, leaseToken: "lease-a", leaseMs: 60_000 });
  await store.checkpoint({ sessionId, leaseToken: "lease-a", confirmedBytes: 50, bytesSent: 50 });
  await store.checkpoint({ sessionId, leaseToken: "lease-a", confirmedBytes: 10, bytesSent: 10 });
  const record = (await store.claim({ sessionId, leaseToken: "lease-a", leaseMs: 60_000 })).record;
  assertEquals(record?.confirmedBytes, 50);
});

Deno.test("the receipt is kept and the session uri is dropped with it", async () => {
  const store = openStore();
  const opened = await store.begin(beginInput);
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

Deno.test("a released session never takes back a receipt", async () => {
  const store = openStore();
  const opened = await store.begin(beginInput);
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
  const opened = await store.begin(beginInput);
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

Deno.test("a session that is not due is not claimed", async () => {
  let clock = 1_000;
  const store = createInMemoryYoutubeUploadSessionStore({ now: () => clock });
  const opened = await store.begin(beginInput);
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
  const opened = await store.begin(beginInput);
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
  const opened = await store.begin(beginInput);
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
  const opened = await store.begin(beginInput);
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
