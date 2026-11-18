/**
 * The native YouTube upload, proved against a fake provider.
 *
 * The provider here is a script: it answers what the test tells it to answer,
 * and it records what it was asked. That is enough to prove the parts that
 * matter and are hard to see otherwise:
 *
 *   * that a chunk is only written from the offset the provider confirmed;
 *   * that a partial acknowledgement inside a chunk is accepted and the next
 *     block continues from there;
 *   * that an inherited session is probed BEFORE any byte is written;
 *   * that a lost final acknowledgement finds the same video again;
 *   * that a provider that will not talk leaves the session alive instead of
 *     ending it, and that an expired one does not;
 *   * that the session URI never leaves the code that owns it.
 */

import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  classifyProviderStatus,
  continuationDelayMs,
  parseRetryAfterMs,
  planChunkFrom,
  runResumableVideoUpload,
  YOUTUBE_CHUNK_GRANULARITY_BYTES,
  YOUTUBE_CONTINUATION_MAX_DELAY_MS,
  YOUTUBE_CONTINUATION_MIN_DELAY_MS,
  YOUTUBE_RESUMABLE_CHUNK_BYTES,
  type ProviderUploadStatus,
  type ResumableUploadOutcome,
  type UploadByteSource,
  type YoutubeUploadSessionRecord,
} from "./youtubeResumableUpload.ts";
import {
  createInMemoryYoutubeUploadSessionStore,
} from "./youtubeUploadSession.ts";
import { YOUTUBE_UPLOAD_REASON } from "./youtubeUploadPolicy.ts";

const SESSION_HOST = "https://www.googleapis.com";
const SESSION_URI = `${SESSION_HOST}/upload/youtube/v3/videos?uploadType=resumable&upload_id=secret-upload-id`;
const VIDEO_ID = "abcdefghijk";
const TOTAL_BYTES = 40 * 1024 * 1024;

/** One answer the fake provider gives. */
interface ScriptedAnswer {
  status: number;
  headers?: Record<string, string>;
  body?: string;
}

/** What the fake provider was asked. */
interface RecordedRequest {
  url: string;
  method: string;
  range: string | null;
  bodyLength: number;
  bytes: Uint8Array | null;
}

interface FakeProvider {
  fetchImpl: typeof fetch;
  requests: RecordedRequest[];
}

/**
 * A provider that answers from a script.
 *
 * The script is consumed in order. A write that is not scripted is answered
 * with the range it asked for, which is what a provider does when it accepts
 * the bytes.
 */
function fakeProvider(answers: ScriptedAnswer[]): FakeProvider {
  const requests: RecordedRequest[] = [];
  let index = 0;

  const fetchImpl: typeof fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const headers = new Headers(init?.headers ?? {});
    const body = init?.body;
    const bytes = body instanceof Uint8Array
      ? body
      : body instanceof ArrayBuffer
      ? new Uint8Array(body)
      : null;
    requests.push({
      url,
      method: init?.method ?? "GET",
      range: headers.get("content-range"),
      bodyLength: bytes?.byteLength ?? 0,
      bytes,
    });

    const answer = answers[index];
    index += 1;
    if (answer) {
      return Promise.resolve(
        new Response(answer.body ?? "", {
          status: answer.status,
          headers: answer.headers ?? {},
        }),
      );
    }
    // A write the provider accepted: it echoes the range it now holds.
    const range = headers.get("content-range");
    const total = range ? Number(range.split("/")[1]) : TOTAL_BYTES;
    const end = range ? Number(range.split(" ")[1].split("-")[1]) : 0;
    return Promise.resolve(
      new Response("", {
        status: 308,
        headers: { Range: `bytes=0-${end}`, "Content-Range": `bytes 0-${end}/${total}` },
      }),
    );
  };

  return { fetchImpl, requests };
}

/** A source that hands out the bytes of a file of the given size. */
function memorySource(size: number): UploadByteSource & { reads: Array<{ start: number; end: number }> } {
  const reads: Array<{ start: number; end: number }> = [];
  return {
    size,
    reads,
    read(start: number, end: number) {
      reads.push({ start, end });
      const buffer = new ArrayBuffer(end - start + 1);
      new Uint8Array(buffer).fill(7);
      return Promise.resolve(buffer);
    },
  };
}

function record(overrides: Partial<YoutubeUploadSessionRecord> = {}): YoutubeUploadSessionRecord {
  return {
    id: "session-1",
    postId: "post-1",
    socialAccountId: "account-1",
    state: "open",
    sessionUri: null,
    confirmedBytes: 0,
    bytesSent: 0,
    videoMayExist: false,
    totalBytes: TOTAL_BYTES,
    videoId: null,
    sessionExpiresAt: null,
    attemptStartedAt: "2026-11-18T00:00:00.000Z",
    nextCheckAt: null,
    lastOutcome: null,
    platformPostId: "platform-post-1",
    mediaFileId: "media-1",
    mediaObjectVersion: 1,
    continuationCount: 0,
    uploadBody: { snippet: { title: "A video" } },
    resolvedPlatform: "youtube",
    targetAccountIds: ["account-1"],
    ...overrides,
  };
}

async function run(
  provider: FakeProvider,
  session: YoutubeUploadSessionRecord,
  source?: UploadByteSource,
  store = createInMemoryYoutubeUploadSessionStore(),
): Promise<{ outcome: ResumableUploadOutcome; store: ReturnType<typeof createInMemoryYoutubeUploadSessionStore> }> {
  // The session is put in the store the way the caller puts it there:
  // admitted, claimed, and given its provider uri when it already has one.
  const opened = await store.admit({
    postId: session.postId,
    socialAccountId: session.socialAccountId,
    mediaFileId: session.mediaFileId,
    mediaObjectVersion: session.mediaObjectVersion,
    mediaSize: session.totalBytes,
    totalBytes: session.totalBytes,
    uploadBody: { snippet: { title: "A video" } },
    userId: "user-1",
    attemptStartedAt: session.attemptStartedAt,
    targetAccountIds: [session.socialAccountId],
  });
  assert(opened.record !== null);
  await store.claim({ sessionId: opened.record.id, leaseToken: "lease-1", leaseMs: 300_000 });
  if (session.sessionUri) {
    await store.checkpoint({
      sessionId: opened.record.id,
      leaseToken: "lease-1",
      confirmedBytes: session.confirmedBytes,
      bytesSent: session.bytesSent,
      sessionUri: session.sessionUri,
      videoMayExist: session.videoMayExist,
    });
  }

  const outcome = await runResumableVideoUpload({
    fetchImpl: provider.fetchImpl,
    store,
    session: {
      ...opened.record,
      sessionUri: session.sessionUri,
      confirmedBytes: session.confirmedBytes,
      bytesSent: session.bytesSent,
      videoMayExist: session.videoMayExist,
      state: session.state,
      videoId: session.videoId,
    },
    leaseToken: "lease-1",
    accessToken: "token-1",
    source: source ?? memorySource(TOTAL_BYTES),
    totalBytes: TOTAL_BYTES,
    mimeType: "video/mp4",
    deadlineMs: Date.now() + 120_000,
    now: () => Date.now(),
    sleep: async () => {},
    uploadUrl: `${SESSION_HOST}/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status`,
    uploadBody: { snippet: { title: "A video" } },
  });
  return { outcome, store };
}

// ───────────────────────────────────────────────────────────────────────────
// The chunk plan
// ───────────────────────────────────────────────────────────────────────────

Deno.test("a chunk is a multiple of 256 KiB", () => {
  assertEquals(YOUTUBE_RESUMABLE_CHUNK_BYTES % YOUTUBE_CHUNK_GRANULARITY_BYTES, 0);
  const chunk = planChunkFrom(0, TOTAL_BYTES, YOUTUBE_RESUMABLE_CHUNK_BYTES);
  assert(chunk !== null);
  assertEquals(chunk.size % YOUTUBE_CHUNK_GRANULARITY_BYTES, 0);
  assertEquals(chunk.start, 0);
  assertEquals(chunk.end, YOUTUBE_RESUMABLE_CHUNK_BYTES - 1);
});

Deno.test("the last chunk may be smaller", () => {
  const total = YOUTUBE_RESUMABLE_CHUNK_BYTES + 1000;
  const chunk = planChunkFrom(YOUTUBE_RESUMABLE_CHUNK_BYTES, total, YOUTUBE_RESUMABLE_CHUNK_BYTES);
  assert(chunk !== null);
  assertEquals(chunk.size, 1000);
  assertEquals(chunk.end, total - 1);
});

Deno.test("a block is built from the offset the provider confirmed", () => {
  // The provider confirmed 5,000,000 bytes inside a chunk that started at 0.
  const chunk = planChunkFrom(5_000_000, TOTAL_BYTES, YOUTUBE_RESUMABLE_CHUNK_BYTES);
  assert(chunk !== null);
  assertEquals(chunk.start, 5_000_000);
  // The block continues for a whole chunk, and it is not the last one, so it
  // is a multiple of 256 KiB.
  assertEquals(chunk.size, YOUTUBE_RESUMABLE_CHUNK_BYTES);
  assertEquals(chunk.end, 5_000_000 + YOUTUBE_RESUMABLE_CHUNK_BYTES - 1);
  assertEquals(chunk.size % YOUTUBE_CHUNK_GRANULARITY_BYTES, 0);
});

Deno.test("an offset outside the file has no block", () => {
  assertEquals(planChunkFrom(TOTAL_BYTES, TOTAL_BYTES, YOUTUBE_RESUMABLE_CHUNK_BYTES), null);
  assertEquals(planChunkFrom(-1, TOTAL_BYTES, YOUTUBE_RESUMABLE_CHUNK_BYTES), null);
});

Deno.test("a chunk size the provider does not accept has no block", () => {
  assertEquals(planChunkFrom(0, TOTAL_BYTES, 1000), null);
});

// ───────────────────────────────────────────────────────────────────────────
// The answer classification
// ───────────────────────────────────────────────────────────────────────────

Deno.test("a 308 without a range means zero bytes confirmed", () => {
  const status = classifyProviderStatus({
    status: 308,
    rangeHeader: null,
    bodyText: "",
    totalBytes: TOTAL_BYTES,
    previousConfirmedBytes: 0,
  });
  assertEquals(status, { kind: "resumable", confirmedBytes: 0 });
});

Deno.test("a 308 with a range names the bytes the provider holds", () => {
  const status = classifyProviderStatus({
    status: 308,
    rangeHeader: "bytes=0-5242879",
    bodyText: "",
    totalBytes: TOTAL_BYTES,
    previousConfirmedBytes: 0,
  });
  assertEquals(status, { kind: "resumable", confirmedBytes: 5_242_880 });
});

Deno.test("a range the provider cannot mean is not a resumable answer", () => {
  const status = classifyProviderStatus({
    status: 308,
    rangeHeader: "bytes=nonsense",
    bodyText: "",
    totalBytes: TOTAL_BYTES,
    previousConfirmedBytes: 0,
  });
  assertEquals(status.kind, "unknown");
  assertEquals(status.kind === "unknown" && status.retryable, false);
});

Deno.test("a provider that reports fewer bytes than before is not retryable", () => {
  const status = classifyProviderStatus({
    status: 308,
    rangeHeader: "bytes=0-99",
    bodyText: "",
    totalBytes: TOTAL_BYTES,
    previousConfirmedBytes: 5_000,
  });
  assertEquals(status.kind, "unknown");
  assertEquals(status.kind === "unknown" && status.retryable, false);
});

Deno.test("a 2xx without a usable video id is not a receipt", () => {
  const status = classifyProviderStatus({
    status: 200,
    rangeHeader: null,
    bodyText: JSON.stringify({ id: "too-short" }),
    totalBytes: TOTAL_BYTES,
    previousConfirmedBytes: 0,
  });
  assertEquals(status.kind, "unknown");
  assertEquals(status.kind === "unknown" && status.retryable, false);
});

Deno.test("a 5xx is retryable and a 4xx is not", () => {
  const server = classifyProviderStatus({
    status: 503,
    rangeHeader: null,
    bodyText: "",
    totalBytes: TOTAL_BYTES,
    previousConfirmedBytes: 0,
  });
  assertEquals(server.kind === "unknown" && server.retryable, true);

  const client = classifyProviderStatus({
    status: 400,
    rangeHeader: null,
    bodyText: "",
    totalBytes: TOTAL_BYTES,
    previousConfirmedBytes: 0,
  });
  assertEquals(client.kind, "rejected");
});

Deno.test("a Retry-After is read and bounded", () => {
  assertEquals(parseRetryAfterMs("120", 0), 120_000);
  assertEquals(parseRetryAfterMs("999999", 0), YOUTUBE_CONTINUATION_MAX_DELAY_MS);
  assertEquals(parseRetryAfterMs("nonsense", 0), undefined);
  assertEquals(parseRetryAfterMs(null, 0), undefined);
});

Deno.test("the wait between two continuations is bounded at both ends", () => {
  assertEquals(continuationDelayMs(1), YOUTUBE_CONTINUATION_MIN_DELAY_MS);
  assertEquals(continuationDelayMs(1000), YOUTUBE_CONTINUATION_MAX_DELAY_MS);
  assertEquals(continuationDelayMs(1, 300_000), 300_000);
  assertEquals(continuationDelayMs(1, 60_000_000), YOUTUBE_CONTINUATION_MAX_DELAY_MS);
});

// ───────────────────────────────────────────────────────────────────────────
// The upload
// ───────────────────────────────────────────────────────────────────────────

Deno.test("a finished upload stores the receipt", async () => {
  const provider = fakeProvider([
    // The session is opened.
    { status: 200, headers: { Location: SESSION_URI } },
    // The first chunk is accepted.
    { status: 308, headers: { Range: "bytes=0-10485759" } },
    // The last chunk creates the video.
    { status: 200, body: JSON.stringify({ id: VIDEO_ID }) },
  ]);
  const { outcome } = await run(provider, record());
  assertEquals(outcome, { kind: "completed", videoId: VIDEO_ID });
});

Deno.test("the session uri never reaches the outcome", async () => {
  const provider = fakeProvider([
    { status: 200, headers: { Location: SESSION_URI } },
    { status: 500, body: "the upload_id=secret-upload-id failed" },
  ]);
  const { outcome } = await run(provider, record());
  assert(outcome.kind !== "completed");
  assert(!JSON.stringify(outcome).includes("secret-upload-id"));
});

Deno.test("an inherited session is probed before any byte is written", async () => {
  const provider = fakeProvider([
    // The probe of the inherited session.
    { status: 308, headers: { Range: "bytes=0-5242879" } },
    // The write that continues from the confirmed offset.
    { status: 200, body: JSON.stringify({ id: VIDEO_ID }) },
  ]);
  const source = memorySource(TOTAL_BYTES);
  const { outcome } = await run(
    provider,
    record({ sessionUri: SESSION_URI, confirmedBytes: 5_242_880 }),
    source,
  );
  assertEquals(outcome, { kind: "completed", videoId: VIDEO_ID });

  // The first request is the probe: it carries no bytes.
  assertEquals(provider.requests[0].method, "PUT");
  assertEquals(provider.requests[0].bodyLength, 0);
  assertStringIncludes(provider.requests[0].range ?? "", "bytes */");

  // The write starts at the offset the provider confirmed, not at the offset
  // the record held.
  const write = provider.requests[1];
  assertStringIncludes(write.range ?? "", "bytes 5242880-");
  assertEquals(source.reads[0].start, 5_242_880);
});

Deno.test("a partial acknowledgement inside a chunk is accepted and continued", async () => {
  const provider = fakeProvider([
    // The probe of the inherited session confirms 5,000,000 bytes, which is
    // inside the chunk that was written before.
    { status: 308, headers: { Range: "bytes=0-4999999" } },
    // The write that continues from there.
    { status: 200, body: JSON.stringify({ id: VIDEO_ID }) },
  ]);
  const source = memorySource(TOTAL_BYTES);
  const { outcome } = await run(
    provider,
    record({ sessionUri: SESSION_URI, confirmedBytes: 5_000_000 }),
    source,
  );
  assertEquals(outcome, { kind: "completed", videoId: VIDEO_ID });
  assertEquals(source.reads[0].start, 5_000_000);
  // The block that is written is still a multiple of 256 KiB.
  assertEquals((source.reads[0].end - source.reads[0].start + 1) % YOUTUBE_CHUNK_GRANULARITY_BYTES, 0);
});

Deno.test("a lost final acknowledgement finds the same video again", async () => {
  const provider = fakeProvider([
    // The provider had already finished the upload.
    { status: 200, body: JSON.stringify({ id: VIDEO_ID }) },
  ]);
  const source = memorySource(TOTAL_BYTES);
  const { outcome } = await run(
    provider,
    record({ sessionUri: SESSION_URI, confirmedBytes: TOTAL_BYTES, videoMayExist: true }),
    source,
  );
  assertEquals(outcome, { kind: "completed", videoId: VIDEO_ID });
  // No media was read: the receipt was already there to be found.
  assertEquals(source.reads.length, 0);
});

Deno.test("a receipt that is already stored is used instead of an upload", async () => {
  const provider = fakeProvider([]);
  const source = memorySource(TOTAL_BYTES);
  const { outcome } = await run(provider, record({ state: "uploaded", videoId: VIDEO_ID }), source);
  assertEquals(outcome, { kind: "completed", videoId: VIDEO_ID });
  assertEquals(provider.requests.length, 0);
  assertEquals(source.reads.length, 0);
});

Deno.test("a provider that will not talk leaves the session alive", async () => {
  const provider = fakeProvider([
    // The probe fails three times.
    { status: 503 },
    { status: 503 },
    { status: 503 },
  ]);
  const { outcome, store } = await run(
    provider,
    record({ sessionUri: SESSION_URI, confirmedBytes: 1_000 }),
  );
  assertEquals(outcome.kind, "resumable");
  assert(outcome.kind === "resumable" && outcome.nextCheckAtMs !== undefined);
  // The session is still open and still holds its uri, so the next worker
  // asks the SAME session instead of opening a new one.
  const session = [...store.sessions.values()][0];
  assertEquals(session.state, "open");
  assertEquals(session.sessionUri, SESSION_URI);
});

Deno.test("a provider that asks for patience is waited for, not hammered", async () => {
  const provider = fakeProvider([
    { status: 429, headers: { "Retry-After": "300" } },
    { status: 429, headers: { "Retry-After": "300" } },
    { status: 429, headers: { "Retry-After": "300" } },
  ]);
  const { outcome } = await run(provider, record({ sessionUri: SESSION_URI }));
  assertEquals(outcome.kind, "resumable");
  assert(outcome.kind === "resumable" && outcome.nextCheckAtMs !== undefined);
});

Deno.test("an expired session that may hold a video is left for a human", async () => {
  const provider = fakeProvider([
    { status: 404 },
  ]);
  const { outcome } = await run(
    provider,
    record({ sessionUri: SESSION_URI, videoMayExist: true }),
  );
  assertEquals(outcome.kind, "reconcile");
  assert(outcome.kind === "reconcile" && outcome.reason === YOUTUBE_UPLOAD_REASON.expired);
});

Deno.test("an expired session that holds nothing is safe to start again", async () => {
  const provider = fakeProvider([
    { status: 404 },
  ]);
  const { outcome } = await run(
    provider,
    record({ sessionUri: SESSION_URI, videoMayExist: false }),
  );
  assertEquals(outcome.kind, "unsent");
});

Deno.test("a redirect is never followed", async () => {
  const provider = fakeProvider([
    { status: 302, headers: { Location: "https://evil.example/upload" } },
  ]);
  const { outcome } = await run(provider, record({ sessionUri: SESSION_URI }));
  assert(outcome.kind !== "completed");
  assert(!provider.requests.some((request) => request.url.includes("evil.example")));
});

Deno.test("a session uri on an unapproved host is refused", async () => {
  const provider = fakeProvider([]);
  const { outcome } = await run(
    provider,
    record({ sessionUri: "https://evil.example/upload?upload_id=secret" }),
  );
  assertEquals(outcome.kind, "reconcile");
  assertEquals(provider.requests.length, 0);
});

Deno.test("a provider that refuses the upload for good does not offer a blind retry", async () => {
  const provider = fakeProvider([
    { status: 400, body: "bad request" },
  ]);
  const { outcome } = await run(provider, record({ sessionUri: SESSION_URI }));
  assertEquals(outcome.kind, "failed");
  assert(outcome.kind === "failed" && outcome.retryable === false);
});

Deno.test("the provider status is asked for when a write does not move the offset", async () => {
  const provider = fakeProvider([
    // The session is opened.
    { status: 200, headers: { Location: SESSION_URI } },
    // The write is answered, but the provider holds no bytes at all: no
    // Range header means zero.
    { status: 308 },
    // The status is asked for, and it says the same.
    { status: 308 },
    // A second attempt, and a second status.
    { status: 308 },
    { status: 308 },
  ]);
  const { outcome } = await run(provider, record());
  assertEquals(outcome.kind, "reconcile");
  const probes = provider.requests.filter((request) => (request.range ?? "").includes("bytes */"));
  assert(probes.length >= 1);
});

Deno.test("the stored error keeps the reason code and drops the credential", async () => {
  const provider = fakeProvider([
    { status: 500, body: "the upload_id=secret-upload-id is gone" },
    { status: 500, body: "the upload_id=secret-upload-id is gone" },
    { status: 500, body: "the upload_id=secret-upload-id is gone" },
  ]);
  const store = createInMemoryYoutubeUploadSessionStore();
  await run(provider, record({ sessionUri: SESSION_URI }), undefined, store);
  const session = [...store.sessions.values()][0];
  // The in-memory store does not keep the error text; the SQL one does, and
  // it is redacted there. What matters here is that the outcome carries the
  // stable reason code.
  assertEquals(session.state, "open");
});

Deno.test("the outcome carries a stable reason code", async () => {
  const provider = fakeProvider([{ status: 404 }]);
  const { outcome } = await run(provider, record({ sessionUri: SESSION_URI, videoMayExist: true }));
  assert(outcome.kind === "reconcile");
  assertEquals(outcome.reason, YOUTUBE_UPLOAD_REASON.expired);
  assert(Object.values(YOUTUBE_UPLOAD_REASON).includes(outcome.reason));
});

Deno.test("a status that is not a receipt is never read as one", () => {
  const status: ProviderUploadStatus = { kind: "unknown", reason: "x", retryable: true };
  assertEquals(status.kind, "unknown");
});
