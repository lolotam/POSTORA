/**
 * The things that happen AFTER the video exists.
 *
 * The rules they keep are the ones that keep a worker from hanging and a
 * customer's channel from getting a duplicate:
 *
 *   * every request is bounded by what is left of the worker, because a
 *     follow-up that never ends would take the outcome with it;
 *   * the budget is asked for EVERY follow-up, so the second one is skipped
 *     when the worker has already run out of time;
 *   * the first comment is posted once and never retried: a first comment
 *     posted twice is a duplicate on the customer's channel;
 *   * neither follow-up can fail the publish.
 */

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  runYoutubeFollowUps,
  type YoutubeFollowUpDeps,
} from "./youtubeUploadFollowUps.ts";

const VIDEO_ID = "abcdefghijk";
const THUMBNAIL_URL = "https://cdn.example.com/thumbnail.jpg";

interface Call {
  url: string;
  method: string;
  /** Whether the request carried a deadline. */
  bounded: boolean;
  body?: Record<string, unknown>;
}

/** A fake outside world that records what it was asked to do. */
function world(
  options: {
    budgetMs?: number | (() => number);
    fetchImpl?: typeof fetch;
    /** The status the provider answers with. */
    respond?: (url: string) => number;
    download?: (url: string, timeoutMs: number) => Promise<{ blob: Blob; mimeType: string }>;
  } = {},
) {
  const calls: Call[] = [];
  const downloads: Array<{ url: string; timeoutMs: number }> = [];
  let budgetCalls = 0;

  const deps: YoutubeFollowUpDeps = {
    canWrite: () => Promise.resolve(true),
    fetchImpl: options.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      calls.push({
        url,
        method: init?.method ?? "GET",
        bounded: init?.signal instanceof AbortSignal,
        ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) as Record<string, unknown> } : {}),
      });
      return Promise.resolve(new Response("{}", { status: options.respond ? options.respond(url) : 200 }));
    }),
    downloadThumbnail(url, timeoutMs) {
      downloads.push({ url, timeoutMs });
      if (options.download) return options.download(url, timeoutMs);
      return Promise.resolve({ blob: new Blob(["bytes"]), mimeType: "image/jpeg" });
    },
    budgetMs() {
      budgetCalls += 1;
      if (typeof options.budgetMs === "function") return options.budgetMs();
      return options.budgetMs ?? 5_000;
    },
  };

  return { calls, downloads, deps, budgetCalls: () => budgetCalls };
}

// ───────────────────────────────────────────────────────────────────────────
// The thumbnail
// ───────────────────────────────────────────────────────────────────────────

Deno.test("the thumbnail is read and sent to the provider", async () => {
  const w = world();
  await runYoutubeFollowUps(
    { videoId: VIDEO_ID, channelId: "UCfixturechannel000000001", accessToken: "token-1", thumbnailUrl: THUMBNAIL_URL, firstComment: null },
    w.deps,
  );

  assertEquals(w.downloads.length, 1);
  assertEquals(w.downloads[0].url, THUMBNAIL_URL);
  assertEquals(w.calls.length, 1);
  assertEquals(w.calls[0].method, "POST");
  assertEquals(w.calls[0].url.includes(VIDEO_ID), true);
});

Deno.test("the thumbnail read is bounded by the time the worker has left", async () => {
  const w = world({ budgetMs: 2_500 });
  await runYoutubeFollowUps(
    { videoId: VIDEO_ID, channelId: "UCfixturechannel000000001", accessToken: "token-1", thumbnailUrl: THUMBNAIL_URL, firstComment: null },
    w.deps,
  );

  // The deadline covers the headers AND the body, so the whole read is inside
  // it: the caller is told how long the read may take.
  assertEquals(w.downloads[0].timeoutMs, 2_500);
});

Deno.test("the provider request carries a deadline of its own", async () => {
  const w = world();
  await runYoutubeFollowUps(
    { videoId: VIDEO_ID, channelId: "UCfixturechannel000000001", accessToken: "token-1", thumbnailUrl: THUMBNAIL_URL, firstComment: null },
    w.deps,
  );

  assertEquals(w.calls[0].bounded, true);
});

Deno.test("a thumbnail that cannot be read does not stop the comment", async () => {
  const w = world({
    download: () => Promise.reject(new Error("the media host did not answer")),
  });
  await runYoutubeFollowUps(
    { videoId: VIDEO_ID, channelId: "UCfixturechannel000000001", accessToken: "token-1", thumbnailUrl: THUMBNAIL_URL, firstComment: "Hello" },
    w.deps,
  );

  // The thumbnail is gone, the comment is still posted: the video is live and
  // the publish cannot fail over a thumbnail.
  assertEquals(w.calls.length, 1);
  assertEquals(w.calls[0].url.includes("commentThreads"), true);
});

Deno.test("a provider that refuses the thumbnail does not stop the comment", async () => {
  const w = world({
    respond: (url) => (url.includes("thumbnails") ? 500 : 200),
  });
  await runYoutubeFollowUps(
    { videoId: VIDEO_ID, channelId: "UCfixturechannel000000001", accessToken: "token-1", thumbnailUrl: THUMBNAIL_URL, firstComment: "Hello" },
    w.deps,
  );

  assertEquals(w.calls.length, 2);
  assertEquals(w.calls[1].url.includes("commentThreads"), true);
});

// ───────────────────────────────────────────────────────────────────────────
// The first comment
// ───────────────────────────────────────────────────────────────────────────

Deno.test("the first comment is posted once with its bound channel", async () => {
  const w = world();
  await runYoutubeFollowUps(
    { videoId: VIDEO_ID, channelId: "UCfixturechannel000000001", accessToken: "token-1", thumbnailUrl: null, firstComment: "Hello" },
    w.deps,
  );

  assertEquals(w.calls.length, 1);
  assertEquals(w.calls[0].url.includes("commentThreads"), true);
  const snippet = (w.calls[0].body?.snippet ?? {}) as Record<string, unknown>;
  assertEquals(snippet.videoId, VIDEO_ID);
  assertEquals(snippet.channelId, "UCfixturechannel000000001");
});

Deno.test("a comment that times out is not posted again", async () => {
  let attempts = 0;
  const w = world({
    fetchImpl: (() => {
      attempts += 1;
      return Promise.reject(new Error("The operation was aborted"));
    }) as typeof fetch,
  });

  // The call must not throw: the video is already live and the row has to be
  // settled either way.
  await runYoutubeFollowUps(
    { videoId: VIDEO_ID, channelId: "UCfixturechannel000000001", accessToken: "token-1", thumbnailUrl: null, firstComment: "Hello" },
    w.deps,
  );

  // One attempt, and no second one: a first comment posted twice is a
  // duplicate on the customer's channel, and a timeout says nothing about
  // whether the first one arrived.
  assertEquals(attempts, 1);
});

// ───────────────────────────────────────────────────────────────────────────
// The budget
// ───────────────────────────────────────────────────────────────────────────

Deno.test("a follow-up is skipped when the worker has no time left", async () => {
  const w = world({ budgetMs: 0 });
  await runYoutubeFollowUps(
    { videoId: VIDEO_ID, channelId: "UCfixturechannel000000001", accessToken: "token-1", thumbnailUrl: THUMBNAIL_URL, firstComment: "Hello" },
    w.deps,
  );

  assertEquals(w.downloads.length, 0);
  assertEquals(w.calls.length, 0);
});

Deno.test("the second follow-up is skipped when the first one used the budget up", async () => {
  const w = world({
    budgetMs: () => (w.budgetCalls() <= 2 ? 1_000 : 0),
  });
  await runYoutubeFollowUps(
    { videoId: VIDEO_ID, channelId: "UCfixturechannel000000001", accessToken: "token-1", thumbnailUrl: THUMBNAIL_URL, firstComment: "Hello" },
    w.deps,
  );

  assertEquals(w.downloads.length, 1);
  assertEquals(w.calls.length, 1);
  assertEquals(w.calls[0].url.includes("thumbnails"), true);
});

Deno.test("a thumbnail download that consumes the deadline sends no provider write", async () => {
  const w = world({
    budgetMs: () => (w.budgetCalls() === 1 ? 1_000 : 0),
  });
  await runYoutubeFollowUps(
    { videoId: VIDEO_ID, channelId: "UCfixturechannel000000001", accessToken: "token-1", thumbnailUrl: THUMBNAIL_URL, firstComment: null },
    w.deps,
  );
  assertEquals(w.downloads.length, 1);
  assertEquals(w.calls.length, 0);
});

Deno.test("follow-up outcomes are returned as observed, never inferred from the request", async () => {
  const w = world();
  const results = await runYoutubeFollowUps({
    videoId: VIDEO_ID, channelId: "UCfixturechannel000000001", accessToken: "token-1",
    thumbnailUrl: THUMBNAIL_URL, firstComment: "Hello",
  }, w.deps);
  assertEquals(results.thumbnail.state, "applied");
  assertEquals(results.first_comment.state, "applied");

  const skipped = await runYoutubeFollowUps({
    videoId: VIDEO_ID, channelId: "UCfixturechannel000000001", accessToken: "token-1",
    thumbnailUrl: THUMBNAIL_URL, firstComment: null,
  }, world({ budgetMs: 0 }).deps);
  assertEquals(skipped.thumbnail, { state: "skipped", reason: "no_time" });
  assertEquals(skipped.first_comment, { state: "not_requested", reason: null });
});

Deno.test("authority lost during a thumbnail download prevents both provider writes", async () => {
  const w = world({});
  w.deps.canWrite = () => Promise.resolve(w.downloads.length === 0);
  await runYoutubeFollowUps({
    videoId: VIDEO_ID, channelId: "UCfixturechannel000000001", accessToken: "fixture", thumbnailUrl: THUMBNAIL_URL, firstComment: "Hello",
  }, w.deps);
  assertEquals(w.downloads.length, 1);
  assertEquals(w.calls.length, 0);
});

// ───────────────────────────────────────────────────────────────────────────
// The playlist insert
// ───────────────────────────────────────────────────────────────────────────

const PLAYLIST_ID = "PLfixtureplaylist001";
const CHANNEL_ID = "UCfixturechannel000000001";

function playlistWorld(options: {
  budgetMs?: number | (() => number);
  canWrite?: () => Promise<boolean>;
  debitWriteBudget?: () => Promise<boolean>;
  precheck?: { status: number; body: unknown } | "throw";
  insert?: { status: number; body?: unknown } | "throw";
} = {}) {
  const calls: Call[] = [];
  let budgetDebits = 0;
  let precheckCalls = 0;
  let insertCalls = 0;

  const deps: YoutubeFollowUpDeps = {
    canWrite: options.canWrite ?? (() => Promise.resolve(true)),
    downloadThumbnail: () => Promise.resolve({ blob: new Blob(["bytes"]), mimeType: "image/jpeg" }),
    budgetMs: () => (typeof options.budgetMs === "function"
      ? options.budgetMs()
      : options.budgetMs ?? 5_000),
    debitWriteBudget: async () => {
      budgetDebits += 1;
      return options.debitWriteBudget ? await options.debitWriteBudget() : true;
    },
    fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";
      calls.push({
        url,
        method,
        bounded: init?.signal instanceof AbortSignal,
        ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) as Record<string, unknown> } : {}),
      });
      if (url.includes("/playlists?")) {
        precheckCalls += 1;
        if (options.precheck === "throw") return Promise.reject(new Error("precheck timeout"));
        const p = options.precheck ?? {
          status: 200,
          body: { items: [{ id: PLAYLIST_ID, snippet: { channelId: CHANNEL_ID } }] },
        };
        return Promise.resolve(Response.json(p.body, { status: p.status }));
      }
      if (url.includes("/playlistItems?")) {
        insertCalls += 1;
        if (options.insert === "throw") return Promise.reject(new Error("insert timeout"));
        const ins = options.insert ?? { status: 200, body: { id: "PLI_1" } };
        return Promise.resolve(Response.json(ins.body ?? {}, { status: ins.status }));
      }
      return Promise.resolve(new Response("{}", { status: 200 }));
    },
  };

  return { calls, deps, counts: () => ({ budgetDebits, precheckCalls, insertCalls }) };
}

Deno.test("playlist follow-up runs after thumbnail and first_comment, verifies ownership, debits budget, and inserts once", async () => {
  const w = playlistWorld();
  const results = await runYoutubeFollowUps({
    videoId: VIDEO_ID,
    channelId: CHANNEL_ID,
    accessToken: "token-1",
    thumbnailUrl: THUMBNAIL_URL,
    firstComment: "Hello",
    playlistId: PLAYLIST_ID,
  }, w.deps);

  assertEquals(results.thumbnail, { state: "applied", reason: null });
  assertEquals(results.first_comment, { state: "applied", reason: null });
  assertEquals(results.playlist, { state: "applied", reason: null });
  assertEquals(w.counts(), { budgetDebits: 1, precheckCalls: 1, insertCalls: 1 });
  assertEquals(w.calls.map((c) => c.method), ["POST", "POST", "GET", "POST"]);
  assertEquals(w.calls[3].body, {
    snippet: { playlistId: PLAYLIST_ID, resourceId: { kind: "youtube#video", videoId: VIDEO_ID } },
  });
});

Deno.test("playlist follow-up rejects malformed or foreign playlist id before debiting budget", async () => {
  const malformed = playlistWorld();
  const badIdResult = await runYoutubeFollowUps({
    videoId: VIDEO_ID,
    channelId: CHANNEL_ID,
    accessToken: "token-1",
    thumbnailUrl: null,
    firstComment: null,
    playlistId: "bad/id",
  }, malformed.deps);
  assertEquals(badIdResult.playlist, { state: "failed", reason: "not_owned" });
  assertEquals(malformed.counts(), { budgetDebits: 0, precheckCalls: 0, insertCalls: 0 });

  const foreign = playlistWorld({
    precheck: { status: 200, body: { items: [{ id: PLAYLIST_ID, snippet: { channelId: "UCother0000000000000002" } }] } },
  });
  const foreignResult = await runYoutubeFollowUps({
    videoId: VIDEO_ID,
    channelId: CHANNEL_ID,
    accessToken: "token-1",
    thumbnailUrl: null,
    firstComment: null,
    playlistId: PLAYLIST_ID,
  }, foreign.deps);
  assertEquals(foreignResult.playlist, { state: "failed", reason: "not_owned" });
  assertEquals(foreign.counts(), { budgetDebits: 0, precheckCalls: 1, insertCalls: 0 });
});

Deno.test("playlist follow-up handles budget refusal, authority loss, no_time, refused insert, and timeout", async () => {
  const quotaRefused = playlistWorld({ debitWriteBudget: () => Promise.resolve(false) });
  const r1 = await runYoutubeFollowUps({
    videoId: VIDEO_ID, channelId: CHANNEL_ID, accessToken: "t",
    thumbnailUrl: THUMBNAIL_URL, firstComment: "Hi", playlistId: PLAYLIST_ID,
  }, quotaRefused.deps);
  assertEquals(r1.thumbnail, { state: "applied", reason: null });
  assertEquals(r1.first_comment, { state: "applied", reason: null });
  assertEquals(r1.playlist, { state: "skipped", reason: "quota_budget" });
  assertEquals(quotaRefused.counts().insertCalls, 0);

  const noTime = playlistWorld({ budgetMs: 0 });
  const r2 = await runYoutubeFollowUps({
    videoId: VIDEO_ID, channelId: CHANNEL_ID, accessToken: "t",
    thumbnailUrl: null, firstComment: null, playlistId: PLAYLIST_ID,
  }, noTime.deps);
  assertEquals(r2.playlist, { state: "skipped", reason: "no_time" });

  const authLost = playlistWorld({ canWrite: () => Promise.resolve(false) });
  const r3 = await runYoutubeFollowUps({
    videoId: VIDEO_ID, channelId: CHANNEL_ID, accessToken: "t",
    thumbnailUrl: null, firstComment: null, playlistId: PLAYLIST_ID,
  }, authLost.deps);
  assertEquals(r3.playlist, { state: "skipped", reason: "authority_lost" });

  const refused = playlistWorld({ insert: { status: 403, body: { error: { message: "forbidden" } } } });
  const r4 = await runYoutubeFollowUps({
    videoId: VIDEO_ID, channelId: CHANNEL_ID, accessToken: "t",
    thumbnailUrl: null, firstComment: null, playlistId: PLAYLIST_ID,
  }, refused.deps);
  assertEquals(r4.playlist, { state: "failed", reason: "refused" });
  assertEquals(refused.counts().insertCalls, 1);

  const timedOut = playlistWorld({ insert: "throw" });
  const r5 = await runYoutubeFollowUps({
    videoId: VIDEO_ID, channelId: CHANNEL_ID, accessToken: "t",
    thumbnailUrl: null, firstComment: null, playlistId: PLAYLIST_ID,
  }, timedOut.deps);
  assertEquals(r5.playlist, { state: "unknown", reason: "answer_lost" });
  assertEquals(timedOut.counts().insertCalls, 1);

  const authThrow = playlistWorld({ canWrite: () => Promise.reject(new Error("effectAuthority failed")) });
  const r6 = await runYoutubeFollowUps({
    videoId: VIDEO_ID, channelId: CHANNEL_ID, accessToken: "t",
    thumbnailUrl: THUMBNAIL_URL, firstComment: null, playlistId: PLAYLIST_ID,
  }, authThrow.deps);
  assertEquals(r6.thumbnail, { state: "unknown", reason: "answer_lost" });
  assertEquals(r6.playlist, { state: "skipped", reason: "authority_lost" });
  assertEquals(authThrow.counts().insertCalls, 0);
});
