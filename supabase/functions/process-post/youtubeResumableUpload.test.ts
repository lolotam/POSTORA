/**
 * The native YouTube resumable upload, proved against a fake provider.
 *
 * WHY A FAKE PROVIDER
 * -------------------
 * The whole point of this phase is that a provider answer and a provider
 * silence mean very different things, and that the difference decides
 * whether the customer's channel ends up with one video or two. Those
 * answers cannot be provoked against the live API on purpose, so the
 * provider here is a script: it holds bytes, it can lose an acknowledgement,
 * it can expire, and it can answer something the protocol does not allow.
 *
 * The provider is a fake HTTP endpoint, not a mock of the code: the upload
 * talks to it with real `Content-Range` headers, real bodies and real
 * statuses.
 */

import {
  assert,
  assertEquals,
  assertNotEquals,
  assertRejects,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

import {
  classifyProviderStatus,
  createYoutubeResumableSession,
  isAllowedProviderUploadUri,
  isValidYoutubeVideoId,
  parseContentRange,
  parseProviderRange,
  planUploadChunks,
  redactResumableCredentials,
  runResumableVideoUpload,
  type ProviderUploadStatus,
  type ResumableUploadOutcome,
  type UploadByteSource,
  type YoutubeUploadSessionRecord,
} from "./youtubeResumableUpload.ts";
import {
  createInMemoryYoutubeUploadSessionStore,
  readRefusal,
} from "./youtubeUploadSession.ts";

const PROVIDER_HOST = "provider.test";
const SESSION_URI = `https://${PROVIDER_HOST}/upload/youtube/v3/videos?uploadType=resumable&upload_id=secret-value`;
const VIDEO_ID = "dQw4w9WgXcQ";

/** One scripted answer from the fake provider. */
type FakeStep =
  /** The provider stored the bytes but the acknowledgement never arrived. */
  | { kind: "lose_ack" }
  /** The provider stored nothing and the acknowledgement never arrived. */
  | { kind: "lose_ack_without_storing" }
  /** The provider answered with a server error. */
  | { kind: "server_error" }
  /** The session is gone. */
  | { kind: "expired" }
  /** The provider answered with a range the protocol does not allow. */
  | { kind: "bad_range"; range: string }
  /** The provider answered as if the upload was already finished. */
  | { kind: "already_finished" }
  /** The provider pointed somewhere else. */
  | { kind: "redirect"; location: string }
  /** The provider answered with a body that names no video. */
  | { kind: "accepted_without_id" };

interface FakeCall {
  method: string;
  url: string;
  contentRange: string | null;
  contentLength: string | null;
  authorization: string | null;
  bodyBytes: number;
}

/**
 * The byte range of a write request.
 *
 * The header names the range and the total of the file, so the total is taken
 * off before the ends are read.
 */
function parseWriteRange(contentRange: string | null): { start: number; end: number } {
  const [, range] = contentRange?.split(" ") ?? [];
  const [start, end] = (range ?? "0-0").split("/")[0].split("-").map(Number);
  return { start, end };
}

/**
 * A fake YouTube upload endpoint.
 *
 * It holds the bytes it was given, creates the video when the last byte
 * lands, and can be told to lose an acknowledgement, expire, or answer
 * something the protocol does not allow.
 */
function fakeProvider(options: { total: number; videoId?: string; always?: FakeStep } = { total: 0 }) {
  const total = options.total;
  const videoId = options.videoId ?? VIDEO_ID;
  const calls: FakeCall[] = [];
  const script: FakeStep[] = [];
  let held = 0;
  let finished = false;
  let nextRangeHeader: string | null | undefined;

  function answer308(): Response {
    const headers = new Headers();
    if (held > 0) headers.set("Range", `bytes=0-${held - 1}`);
    return new Response(null, { status: 308, headers });
  }

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers as HeadersInit);
    const contentRange = headers.get("content-range");
    calls.push({
      method: String(init?.method ?? "GET"),
      url: String(input),
      contentRange,
      contentLength: headers.get("content-length"),
      authorization: headers.get("authorization"),
      bodyBytes: typeof init?.body === "string" ? init.body.length : Number(init?.body ?? 0),
    });

    const step = script.shift() ?? options.always;

    if (step?.kind === "lose_ack" || step?.kind === "lose_ack_without_storing") {
      if (step.kind === "lose_ack") {
        const range = parseWriteRange(contentRange);
        held = Math.max(held, range.end + 1);
        if (held >= total) finished = true;
      }
      throw new TypeError("The connection was closed before the answer arrived.");
    }
    if (step?.kind === "server_error") {
      return new Response(JSON.stringify({ error: { message: "backend" } }), { status: 503 });
    }
    if (step?.kind === "expired") {
      return new Response(JSON.stringify({ error: { message: "gone" } }), { status: 404 });
    }
    if (step?.kind === "bad_range") {
      return new Response(null, { status: 308, headers: { Range: step.range } });
    }
    if (step?.kind === "redirect") {
      return new Response(null, { status: 302, headers: { Location: step.location } });
    }
    if (step?.kind === "accepted_without_id") {
      return new Response(JSON.stringify({ kind: "youtube#video" }), { status: 201 });
    }
    if (step?.kind === "already_finished") {
      return new Response(JSON.stringify({ id: videoId }), { status: 201 });
    }

    // A status probe: `Content-Range: bytes */TOTAL`.
    if (contentRange?.startsWith("bytes */")) {
      if (finished) return new Response(JSON.stringify({ id: videoId }), { status: 201 });
      if (nextRangeHeader !== undefined && nextRangeHeader !== null) {
        const headers = new Headers();
        if (nextRangeHeader) headers.set("Range", nextRangeHeader);
        return new Response(null, { status: 308, headers });
      }
      return answer308();
    }

    const range = parseWriteRange(contentRange);
    held = Math.max(held, range.end + 1);
    if (held >= total) {
      finished = true;
      return new Response(JSON.stringify({ id: videoId }), { status: 201 });
    }
    return answer308();
  }) as unknown as typeof fetch;

  return {
    calls,
    fetchImpl,
    script,
    /** What the provider holds, in bytes. */
    held: () => held,
    /** Whether the provider turned the bytes into a video. */
    finished: () => finished,
    /** The next status probe answers with this range header. */
    answerProbesWith(range: string | null) {
      nextRangeHeader = range;
    },
  };
}

/** The bytes of a video, held in memory for the test. */
function fakeSource(size: number): UploadByteSource {
  const bytes = new Uint8Array(size);
  for (let index = 0; index < size; index += 1) bytes[index] = index % 251;
  return {
    size,
    async read(start: number, end: number): Promise<ArrayBuffer> {
      return bytes.slice(start, end + 1).buffer as ArrayBuffer;
    },
  };
}

/** The chunk size the tests use: one 256 KiB granule, so the plan is short. */
const TEST_CHUNK_BYTES = 256 * 1024;

interface Harness {
  provider: ReturnType<typeof fakeProvider>;
  store: ReturnType<typeof createInMemoryYoutubeUploadSessionStore>;
  source: UploadByteSource;
  run: (options?: {
    session?: Partial<YoutubeUploadSessionRecord>;
    leaseToken?: string;
    deadlineMs?: number;
  }) => Promise<ResumableUploadOutcome>;
  sessionId: string;
}

async function harness(size: number, options: { videoId?: string } = {}): Promise<Harness> {
  const provider = fakeProvider({ total: size, videoId: options.videoId });
  const store = createInMemoryYoutubeUploadSessionStore();
  const source = fakeSource(size);

  const opened = await store.begin({
    postId: "post-1",
    socialAccountId: "account-1",
    platformPostId: null,
    mediaFileId: "media-1",
    mediaObjectVersion: 1,
    mediaSize: size,
    totalBytes: size,
    uploadBody: { snippet: { title: "A video" } },
    userId: "user-1",
  });
  assert(opened.record);
  const sessionId = opened.record.id;
  const leaseToken = "lease-1";
  await store.claim({ sessionId, leaseToken, leaseMs: 60_000 });

  return {
    provider,
    store,
    source,
    sessionId,
    run: async (runOptions = {}) => {
      const record = { ...opened.record!, ...runOptions.session } as YoutubeUploadSessionRecord;
      return await runResumableVideoUpload({
        fetchImpl: provider.fetchImpl,
        store,
        session: record,
        leaseToken: runOptions.leaseToken ?? leaseToken,
        accessToken: "fixture-token",
        source,
        totalBytes: size,
        mimeType: "video/mp4",
        deadlineMs: runOptions.deadlineMs ?? Date.now() + 60_000,
        now: () => Date.now(),
        sleep: async () => {},
        allowedHosts: [PROVIDER_HOST],
        chunkBytes: TEST_CHUNK_BYTES,
        uploadUrl: `https://${PROVIDER_HOST}/upload/youtube/v3/videos?uploadType=resumable`,
        uploadBody: { snippet: { title: "A video" } },
      });
    },
  };
}

// ---------------------------------------------------------------------------
// The range header.
// ---------------------------------------------------------------------------

Deno.test("a range of zero to 999999 is a million bytes, because both ends count", () => {
  assertEquals(parseProviderRange("bytes=0-999999"), 1_000_000);
});

Deno.test("a resume incomplete with no range header means the provider holds nothing", () => {
  assertEquals(parseProviderRange(null), 0);
  assertEquals(parseProviderRange(undefined), 0);
  assertEquals(parseProviderRange(""), 0);
});

Deno.test("a range the protocol does not allow is refused rather than guessed at", () => {
  assertEquals(parseProviderRange("bytes=10-5"), null);
  assertEquals(parseProviderRange("bytes=-5"), null);
  assertEquals(parseProviderRange("bytes=abc-def"), null);
  assertEquals(parseProviderRange("0-999999"), null);
  assertEquals(parseProviderRange("bytes=0-999999, 2000-3000"), null);
});

Deno.test("a content range that does not fit the file is refused", () => {
  assertEquals(parseContentRange("bytes 0-99/100"), { start: 0, end: 99, total: 100 });
  assertEquals(parseContentRange("bytes 0-100/100"), null);
  assertEquals(parseContentRange("bytes 0-99/0"), null);
  assertEquals(parseContentRange("bytes */100"), null);
});

// ---------------------------------------------------------------------------
// The chunk plan.
// ---------------------------------------------------------------------------

Deno.test("the chunk plan gives every chunk but the last the same size", () => {
  const chunks = planUploadChunks(TEST_CHUNK_BYTES * 2 + 1000, TEST_CHUNK_BYTES);

  assertEquals(chunks.length, 3);
  assertEquals(chunks[0], { start: 0, end: TEST_CHUNK_BYTES - 1, size: TEST_CHUNK_BYTES });
  assertEquals(chunks[1].start, TEST_CHUNK_BYTES);
  assertEquals(chunks[2].size, 1000);
});

Deno.test("a chunk size that is not a multiple of 256 KiB is refused", () => {
  let threw = false;
  try {
    planUploadChunks(1000, 1000);
  } catch {
    threw = true;
  }
  assert(threw, "a chunk size that is not a multiple of 256 KiB must be refused");
});

Deno.test("a video with no bytes has no plan", () => {
  let threw = false;
  try {
    planUploadChunks(0);
  } catch {
    threw = true;
  }
  assert(threw, "an empty video must be refused");
});

// ---------------------------------------------------------------------------
// The provider host policy.
// ---------------------------------------------------------------------------

Deno.test("only a reviewed https host may be written to", () => {
  assert(isAllowedProviderUploadUri(SESSION_URI, [PROVIDER_HOST]));
  assert(!isAllowedProviderUploadUri(`http://${PROVIDER_HOST}/x`, [PROVIDER_HOST]));
  assert(!isAllowedProviderUploadUri(`https://elsewhere.test/x`, [PROVIDER_HOST]));
  assert(!isAllowedProviderUploadUri(`https://${PROVIDER_HOST}.evil.test/x`, [PROVIDER_HOST]));
  assert(!isAllowedProviderUploadUri(`https://user:pass@${PROVIDER_HOST}/x`, [PROVIDER_HOST]));
  assert(!isAllowedProviderUploadUri(null, [PROVIDER_HOST]));
});

Deno.test("the credential is taken out of any text that may carry it", () => {
  const redacted = redactResumableCredentials(
    `the provider refused ${SESSION_URI}`,
  );

  assert(!redacted.includes("secret-value"));
  assertStringIncludes(redacted, "upload_id=***");
});

Deno.test("the credential is taken out of any text that may carry it", () => {
  const redacted = redactResumableCredentials(
    "the provider refused https://provider.test/upload?upload_id=secret-value&part=snippet",
  );

  assert(!redacted.includes("secret-value"));
  assertStringIncludes(redacted, "upload_id=***");
});

// ---------------------------------------------------------------------------
// The classification of one answer.
// ---------------------------------------------------------------------------

Deno.test("a created video is a receipt, and a receipt without a video id is not one", () => {
  const accepted = classifyProviderStatus({
    status: 201,
    rangeHeader: null,
    bodyText: JSON.stringify({ id: VIDEO_ID }),
    totalBytes: 10,
    previousConfirmedBytes: 0,
  });
  assertEquals(accepted, { kind: "accepted", videoId: VIDEO_ID });

  const nameless = classifyProviderStatus({
    status: 201,
    rangeHeader: null,
    bodyText: JSON.stringify({ kind: "youtube#video" }),
    totalBytes: 10,
    previousConfirmedBytes: 0,
  });
  assertEquals(nameless.kind, "unknown");
});

Deno.test("a provider that holds fewer bytes than it confirmed is not believed", () => {
  const status = classifyProviderStatus({
    status: 308,
    rangeHeader: "bytes=0-9",
    bodyText: "",
    totalBytes: 100,
    previousConfirmedBytes: 50,
  });

  assertEquals(status.kind, "unknown");
});

Deno.test("a provider that holds more bytes than the video has is not believed", () => {
  const status = classifyProviderStatus({
    status: 308,
    rangeHeader: "bytes=0-500",
    bodyText: "",
    totalBytes: 100,
    previousConfirmedBytes: 0,
  });

  assertEquals(status.kind, "unknown");
});

Deno.test("a video id is eleven characters of the url safe alphabet", () => {
  assert(isValidYoutubeVideoId(VIDEO_ID));
  assert(!isValidYoutubeVideoId("short"));
  assert(!isValidYoutubeVideoId(""));
  assert(!isValidYoutubeVideoId("has spaces in it"));
  assert(!isValidYoutubeVideoId(null));
});

// ---------------------------------------------------------------------------
// The upload against the fake provider.
// ---------------------------------------------------------------------------

Deno.test("a video is uploaded in bounded chunks and the receipt is kept", async () => {
  const size = TEST_CHUNK_BYTES * 2 + 10;
  const h = await harness(size);

  const outcome = await h.run({ session: { sessionUri: SESSION_URI, totalBytes: size } });

  assertEquals(outcome, { kind: "completed", videoId: VIDEO_ID });
  assertEquals(h.provider.calls.length, 3);
  assertEquals(h.provider.calls[0].contentRange, `bytes 0-${TEST_CHUNK_BYTES - 1}/${size}`);
  assertEquals(h.provider.calls[0].contentLength, String(TEST_CHUNK_BYTES));
  assertEquals(h.provider.calls[2].contentRange, `bytes ${TEST_CHUNK_BYTES * 2}-${size - 1}/${size}`);
  assertEquals(h.provider.calls[0].authorization, "Bearer fixture-token");
  assertEquals(h.provider.finished(), true);
});

Deno.test("a receipt that already exists is used instead of an upload", async () => {
  const size = TEST_CHUNK_BYTES;
  const h = await harness(size);

  const outcome = await h.run({
    session: { sessionUri: SESSION_URI, videoId: VIDEO_ID, totalBytes: size, state: "uploaded" },
  });

  assertEquals(outcome, { kind: "completed", videoId: VIDEO_ID });
  assertEquals(h.provider.calls.length, 0, "no provider call may be made when the receipt exists");
});

Deno.test("a status probe that finds nothing says the provider holds nothing", async () => {
  const size = TEST_CHUNK_BYTES * 2;
  const h = await harness(size);
  // The first write is lost, and the provider kept nothing.
  h.provider.script.push({ kind: "lose_ack_without_storing" });
  h.provider.answerProbesWith(null);

  const outcome = await h.run({ session: { sessionUri: SESSION_URI, totalBytes: size } });

  // The provider holds nothing, so the upload starts again from the first
  // byte and finishes.
  assertEquals(outcome, { kind: "completed", videoId: VIDEO_ID });
  const probe = h.provider.calls.find((call) => call.contentRange?.startsWith("bytes */"));
  assert(probe, "the status of the upload must be asked for after an ambiguous write");
  assertEquals(probe.contentRange, `bytes */${size}`);
  assertEquals(probe.contentLength, "0");
});

Deno.test("a lost acknowledgement after a partial write resumes from the confirmed offset", async () => {
  const size = TEST_CHUNK_BYTES * 3;
  const h = await harness(size);
  // The provider stored the first chunk but the acknowledgement was lost.
  h.provider.script.push({ kind: "lose_ack" });

  const outcome = await h.run({ session: { sessionUri: SESSION_URI, totalBytes: size } });

  assertEquals(outcome, { kind: "completed", videoId: VIDEO_ID });
  // The second write starts where the provider said it had bytes, not at the
  // beginning.
  const writes = h.provider.calls.filter((call) => !call.contentRange?.startsWith("bytes */"));
  assertEquals(writes[1].contentRange, `bytes ${TEST_CHUNK_BYTES}-${TEST_CHUNK_BYTES * 2 - 1}/${size}`);
});

Deno.test("a lost final acknowledgement is recovered from the provider instead of a second video", async () => {
  const size = TEST_CHUNK_BYTES;
  const h = await harness(size);
  // The provider finished the upload, but the answer never arrived.
  h.provider.script.push({ kind: "lose_ack" });

  const outcome = await h.run({ session: { sessionUri: SESSION_URI, totalBytes: size } });

  assertEquals(outcome, { kind: "completed", videoId: VIDEO_ID });
  // The video was created once. The status probe found the receipt.
  assertEquals(h.provider.finished(), true);
  const probe = h.provider.calls.find((call) => call.contentRange?.startsWith("bytes */"));
  assert(probe, "the status must be asked for after the final write went unanswered");
});

Deno.test("a provider that answers a redirect is not followed", async () => {
  // Two chunks, so the last one is never written: the upload cannot have
  // created a video, and the only question is whether the redirect was
  // followed.
  const size = TEST_CHUNK_BYTES * 2;
  const h = await harness(size);
  h.provider.script.push({ kind: "redirect", location: "https://elsewhere.test/steal" });
  h.provider.script.push({ kind: "redirect", location: "https://elsewhere.test/steal" });
  h.provider.script.push({ kind: "redirect", location: "https://elsewhere.test/steal" });
  h.provider.script.push({ kind: "redirect", location: "https://elsewhere.test/steal" });

  const outcome = await h.run({ session: { sessionUri: SESSION_URI, totalBytes: size } });

  assert(
    h.provider.calls.every((call) => call.url === SESSION_URI),
    "no request may be sent to the redirect target",
  );
  assertEquals(h.provider.finished(), false, "no video may be created");
  assertNotEquals(outcome.kind, "completed");
});

Deno.test("a session that expires after the last chunk may have been written is left for a human", async () => {
  // One chunk: the write that expires is the write that creates the video.
  const size = TEST_CHUNK_BYTES;
  const h = await harness(size);
  h.provider.script.push({ kind: "expired" });

  const outcome = await h.run({ session: { sessionUri: SESSION_URI, totalBytes: size } });

  assertEquals(outcome.kind, "reconcile");
  assertEquals(h.provider.finished(), false);
});

Deno.test("a session that expires before the last chunk was written may start again", async () => {
  const size = TEST_CHUNK_BYTES * 2;
  const h = await harness(size);
  // The session expired while the first chunk was in flight. The last chunk
  // was never written, so the provider never got the chance to create a
  // video and a fresh session cannot duplicate one.
  h.provider.script.push({ kind: "expired" });

  const outcome = await h.run({ session: { sessionUri: SESSION_URI, totalBytes: size } });

  assertEquals(outcome.kind, "unsent");
  assertEquals(h.provider.finished(), false);
});

Deno.test("a range the protocol does not allow is never resumed from", async () => {
  const size = TEST_CHUNK_BYTES * 2;
  const h = await harness(size);
  h.provider.script.push({ kind: "bad_range", range: "bytes=10-5" });
  h.provider.answerProbesWith("bytes=10-5");

  const outcome = await h.run({ session: { sessionUri: SESSION_URI, totalBytes: size } });

  // The provider will not say what it holds, so the upload cannot continue
  // in this session. The last chunk was never written, so no video exists
  // and starting again is safe.
  assertEquals(outcome.kind, "failed");
  assertEquals(h.provider.finished(), false);
});

Deno.test("a provider that answers without a video id is never treated as finished", async () => {
  const size = TEST_CHUNK_BYTES;
  const h = await harness(size);
  h.provider.script.push({ kind: "accepted_without_id" });
  h.provider.script.push({ kind: "accepted_without_id" });
  h.provider.script.push({ kind: "accepted_without_id" });
  h.provider.script.push({ kind: "accepted_without_id" });

  const outcome = await h.run({ session: { sessionUri: SESSION_URI, totalBytes: size } });

  assertNotEquals(outcome.kind, "completed");
});

Deno.test("a worker that runs out of time leaves the upload resumable", async () => {
  const size = TEST_CHUNK_BYTES * 3;
  const h = await harness(size);

  const outcome = await h.run({
    session: { sessionUri: SESSION_URI, totalBytes: size },
    deadlineMs: Date.now() - 1,
  });

  assertEquals(outcome.kind, "resumable");
  assertEquals(h.provider.finished(), false);
});

Deno.test("a session that is not on a reviewed host is never written to", async () => {
  const size = TEST_CHUNK_BYTES;
  const h = await harness(size);

  const outcome = await h.run({
    session: { sessionUri: "https://elsewhere.test/upload?upload_id=secret", totalBytes: size },
  });

  assertEquals(outcome.kind, "reconcile");
  assertEquals(h.provider.calls.length, 0, "no request may leave for an unreviewed host");
});

// ---------------------------------------------------------------------------
// The durable store.
// ---------------------------------------------------------------------------

Deno.test("two workers cannot own the same session", async () => {
  const store = createInMemoryYoutubeUploadSessionStore();
  const opened = await store.begin({
    postId: "post-1",
    socialAccountId: "account-1",
    platformPostId: null,
    mediaFileId: null,
    mediaObjectVersion: null,
    mediaSize: 10,
    totalBytes: 10,
    uploadBody: { snippet: { title: "A video" } },
    userId: "user-1",
  });
  assert(opened.record);

  const first = await store.claim({ sessionId: opened.record.id, leaseToken: "worker-a", leaseMs: 60_000 });
  assert(!first.refused);

  const second = await store.claim({ sessionId: opened.record.id, leaseToken: "worker-b", leaseMs: 60_000 });
  assertEquals(second.refused, "lease_held");
});

Deno.test("a worker whose lease expired cannot write", async () => {
  let clock = 1_000;
  const store = createInMemoryYoutubeUploadSessionStore({ now: () => clock });
  const opened = await store.begin({
    postId: "post-1",
    socialAccountId: "account-1",
    platformPostId: null,
    mediaFileId: null,
    mediaObjectVersion: null,
    mediaSize: 10,
    totalBytes: 10,
    uploadBody: { snippet: { title: "A video" } },
    userId: "user-1",
  });
  assert(opened.record);
  await store.claim({ sessionId: opened.record.id, leaseToken: "worker-a", leaseMs: 1_000 });

  clock += 2_000;
  const written = await store.checkpoint({
    sessionId: opened.record.id,
    leaseToken: "worker-a",
    confirmedBytes: 5,
    bytesSent: 5,
  });

  assertEquals(written, false, "a stale lease must not be able to write");
});

Deno.test("the confirmed offset only ever grows", async () => {
  const store = createInMemoryYoutubeUploadSessionStore();
  const opened = await store.begin({
    postId: "post-1",
    socialAccountId: "account-1",
    platformPostId: null,
    mediaFileId: null,
    mediaObjectVersion: null,
    mediaSize: 10,
    totalBytes: 10,
    uploadBody: { snippet: { title: "A video" } },
    userId: "user-1",
  });
  assert(opened.record);
  await store.claim({ sessionId: opened.record.id, leaseToken: "worker-a", leaseMs: 60_000 });
  await store.checkpoint({
    sessionId: opened.record.id,
    leaseToken: "worker-a",
    confirmedBytes: 7,
    bytesSent: 7,
  });
  await store.checkpoint({
    sessionId: opened.record.id,
    leaseToken: "worker-a",
    confirmedBytes: 3,
    bytesSent: 3,
  });

  const record = store.sessions.get(opened.record.id);
  assertEquals(record?.confirmedBytes, 7);
  assertEquals(record?.bytesSent, 7);
});

Deno.test("a receipt is kept and a release never takes it back", async () => {
  const store = createInMemoryYoutubeUploadSessionStore();
  const opened = await store.begin({
    postId: "post-1",
    socialAccountId: "account-1",
    platformPostId: null,
    mediaFileId: null,
    mediaObjectVersion: null,
    mediaSize: 10,
    totalBytes: 10,
    uploadBody: { snippet: { title: "A video" } },
    userId: "user-1",
  });
  assert(opened.record);
  await store.claim({ sessionId: opened.record.id, leaseToken: "worker-a", leaseMs: 60_000 });
  await store.complete({ sessionId: opened.record.id, leaseToken: "worker-a", videoId: VIDEO_ID });

  const released = await store.release({
    sessionId: opened.record.id,
    leaseToken: "worker-a",
    state: "failed",
    error: "late",
  });
  assertEquals(released, false);

  const record = store.sessions.get(opened.record.id);
  assertEquals(record?.state, "uploaded");
  assertEquals(record?.videoId, VIDEO_ID);
  assertEquals(record?.sessionUri, null, "the session uri is dropped once the receipt is kept");
});

Deno.test("an edited post refuses the resume", async () => {
  const store = createInMemoryYoutubeUploadSessionStore();
  const first = await store.begin({
    postId: "post-1",
    socialAccountId: "account-1",
    platformPostId: null,
    mediaFileId: null,
    mediaObjectVersion: null,
    mediaSize: 10,
    totalBytes: 10,
    uploadBody: { snippet: { title: "A video" } },
    userId: "user-1",
  });
  assert(first.record);

  const edited = await store.begin({
    postId: "post-1",
    socialAccountId: "account-1",
    platformPostId: null,
    mediaFileId: null,
    mediaObjectVersion: null,
    mediaSize: 10,
    totalBytes: 10,
    uploadBody: { snippet: { title: "A different video" } },
    userId: "user-1",
  });

  assertEquals(edited.refused, "content_changed");
});

Deno.test("an expired session is reopened when no video can exist", async () => {
  const store = createInMemoryYoutubeUploadSessionStore();
  const opened = await store.begin({
    postId: "post-1",
    socialAccountId: "account-1",
    platformPostId: null,
    mediaFileId: null,
    mediaObjectVersion: null,
    mediaSize: 10,
    totalBytes: 10,
    uploadBody: { snippet: { title: "A video" } },
    userId: "user-1",
  });
  assert(opened.record);
  await store.claim({ sessionId: opened.record.id, leaseToken: "worker-a", leaseMs: 60_000 });
  await store.checkpoint({
    sessionId: opened.record.id,
    leaseToken: "worker-a",
    confirmedBytes: 0,
    bytesSent: 0,
    sessionUri: SESSION_URI,
  });
  // The provider session is gone and the last chunk was never written, so no
  // video can exist.
  await store.release({
    sessionId: opened.record.id,
    leaseToken: "worker-a",
    state: "expired",
    error: "The session expired.",
  });

  const reopened = await store.begin({
    postId: "post-1",
    socialAccountId: "account-1",
    platformPostId: null,
    mediaFileId: null,
    mediaObjectVersion: null,
    mediaSize: 10,
    totalBytes: 10,
    uploadBody: { snippet: { title: "A video" } },
    userId: "user-1",
  });

  assert(!reopened.refused);
  assertEquals(reopened.record?.sessionUri, null);
  assertEquals(reopened.record?.bytesSent, 0);
});

Deno.test("an expired session that may already have a video is left for a human", async () => {
  const store = createInMemoryYoutubeUploadSessionStore();
  const opened = await store.begin({
    postId: "post-1",
    socialAccountId: "account-1",
    platformPostId: null,
    mediaFileId: null,
    mediaObjectVersion: null,
    mediaSize: 10,
    totalBytes: 10,
    uploadBody: { snippet: { title: "A video" } },
    userId: "user-1",
  });
  assert(opened.record);
  await store.claim({ sessionId: opened.record.id, leaseToken: "worker-a", leaseMs: 60_000 });
  // The last chunk was written and its outcome was never learned.
  await store.checkpoint({
    sessionId: opened.record.id,
    leaseToken: "worker-a",
    confirmedBytes: 10,
    bytesSent: 10,
    sessionUri: SESSION_URI,
    videoMayExist: true,
  });
  await store.release({
    sessionId: opened.record.id,
    leaseToken: "worker-a",
    state: "expired",
    error: "The session expired.",
  });

  const reopened = await store.begin({
    postId: "post-1",
    socialAccountId: "account-1",
    platformPostId: null,
    mediaFileId: null,
    mediaObjectVersion: null,
    mediaSize: 10,
    totalBytes: 10,
    uploadBody: { snippet: { title: "A video" } },
    userId: "user-1",
  });

  assertEquals(reopened.refused, "reconcile_required");
});

Deno.test("another user's post is not this user's session", async () => {
  const store = createInMemoryYoutubeUploadSessionStore();
  const opened = await store.begin({
    postId: "post-1",
    socialAccountId: "account-1",
    platformPostId: null,
    mediaFileId: null,
    mediaObjectVersion: null,
    mediaSize: 10,
    totalBytes: 10,
    uploadBody: { snippet: { title: "A video" } },
    userId: "user-1",
  });
  assert(opened.record);

  const other = await store.begin({
    postId: "post-1",
    socialAccountId: "account-1",
    platformPostId: null,
    mediaFileId: null,
    mediaObjectVersion: null,
    mediaSize: 10,
    totalBytes: 10,
    uploadBody: { snippet: { title: "A video" } },
    userId: "user-2",
  });

  assertEquals(other.refused, "post_not_found");
});

Deno.test("a refusal is read from the store's own code, never from a message", () => {
  assertEquals(readRefusal({ code: "YUS05" }), "reconcile_required");
  assertEquals(readRefusal({ code: "YUS07" }), "lease_held");
  assertEquals(readRefusal({ code: "23505" }), null);
  assertEquals(readRefusal(new Error("boom")), null);
});

// ---------------------------------------------------------------------------
// The session handshake.
// ---------------------------------------------------------------------------

Deno.test("the session is asked for over https and the location is checked", async () => {
  const calls: FakeCall[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      method: String(init?.method ?? "GET"),
      url: String(input),
      contentRange: null,
      contentLength: null,
      authorization: new Headers(init?.headers as HeadersInit).get("authorization"),
      bodyBytes: 0,
    });
    return new Response("{}", {
      status: 200,
      headers: { Location: SESSION_URI },
    });
  }) as unknown as typeof fetch;

  const sessionUri = await createYoutubeResumableSession({
    fetchImpl,
    accessToken: "fixture-token",
    url: "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable",
    body: { snippet: { title: "A video" } },
    totalBytes: 2048,
    mimeType: "video/mp4",
    allowedHosts: [PROVIDER_HOST],
  });

  assertEquals(sessionUri, SESSION_URI);
  assertEquals(calls[0].method, "POST");
  assertEquals(calls[0].authorization, "Bearer fixture-token");
});

Deno.test("a session on a host that was not reviewed is refused", async () => {
  const fetchImpl = (async () =>
    new Response("{}", {
      status: 200,
      headers: { Location: "https://elsewhere.test/upload?upload_id=secret" },
    })) as unknown as typeof fetch;

  await assertRejects(() =>
    createYoutubeResumableSession({
      fetchImpl,
      accessToken: "fixture-token",
      url: "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable",
      body: { snippet: { title: "A video" } },
      totalBytes: 2048,
      mimeType: "video/mp4",
      allowedHosts: [PROVIDER_HOST],
    })
  );
});

Deno.test("a failed handshake keeps the provider's own message", async () => {
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ error: { message: "quota" } }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    })) as unknown as typeof fetch;

  const error = await assertRejects(() =>
    createYoutubeResumableSession({
      fetchImpl,
      accessToken: "fixture-token",
      url: "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable",
      body: { snippet: { title: "A video" } },
      totalBytes: 2048,
      mimeType: "video/mp4",
      allowedHosts: [PROVIDER_HOST],
    })
  );

  assertStringIncludes(error instanceof Error ? error.message : String(error), "permission error");
});

// ---------------------------------------------------------------------------
// The messages the customer sees.
// ---------------------------------------------------------------------------

Deno.test("a status the protocol does not know is never a success", () => {
  const status: ProviderUploadStatus = classifyProviderStatus({
    status: 418,
    rangeHeader: null,
    bodyText: "",
    totalBytes: 10,
    previousConfirmedBytes: 0,
  });

  assertEquals(status.kind, "rejected");
});
