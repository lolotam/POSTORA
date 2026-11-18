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
    { videoId: VIDEO_ID, accessToken: "token-1", thumbnailUrl: THUMBNAIL_URL, firstComment: null },
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
    { videoId: VIDEO_ID, accessToken: "token-1", thumbnailUrl: THUMBNAIL_URL, firstComment: null },
    w.deps,
  );

  // The deadline covers the headers AND the body, so the whole read is inside
  // it: the caller is told how long the read may take.
  assertEquals(w.downloads[0].timeoutMs, 2_500);
});

Deno.test("the provider request carries a deadline of its own", async () => {
  const w = world();
  await runYoutubeFollowUps(
    { videoId: VIDEO_ID, accessToken: "token-1", thumbnailUrl: THUMBNAIL_URL, firstComment: null },
    w.deps,
  );

  assertEquals(w.calls[0].bounded, true);
});

Deno.test("a thumbnail that cannot be read does not stop the comment", async () => {
  const w = world({
    download: () => Promise.reject(new Error("the media host did not answer")),
  });
  await runYoutubeFollowUps(
    { videoId: VIDEO_ID, accessToken: "token-1", thumbnailUrl: THUMBNAIL_URL, firstComment: "Hello" },
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
    { videoId: VIDEO_ID, accessToken: "token-1", thumbnailUrl: THUMBNAIL_URL, firstComment: "Hello" },
    w.deps,
  );

  assertEquals(w.calls.length, 2);
  assertEquals(w.calls[1].url.includes("commentThreads"), true);
});

// ───────────────────────────────────────────────────────────────────────────
// The first comment
// ───────────────────────────────────────────────────────────────────────────

Deno.test("the first comment is posted once", async () => {
  const w = world();
  await runYoutubeFollowUps(
    { videoId: VIDEO_ID, accessToken: "token-1", thumbnailUrl: null, firstComment: "Hello" },
    w.deps,
  );

  assertEquals(w.calls.length, 1);
  assertEquals(w.calls[0].url.includes("commentThreads"), true);
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
    { videoId: VIDEO_ID, accessToken: "token-1", thumbnailUrl: null, firstComment: "Hello" },
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
    { videoId: VIDEO_ID, accessToken: "token-1", thumbnailUrl: THUMBNAIL_URL, firstComment: "Hello" },
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
    { videoId: VIDEO_ID, accessToken: "token-1", thumbnailUrl: THUMBNAIL_URL, firstComment: "Hello" },
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
    { videoId: VIDEO_ID, accessToken: "token-1", thumbnailUrl: THUMBNAIL_URL, firstComment: null },
    w.deps,
  );
  assertEquals(w.downloads.length, 1);
  assertEquals(w.calls.length, 0);
});

Deno.test("authority lost during a thumbnail download prevents both provider writes", async () => {
  const w = world({});
  w.deps.canWrite = () => Promise.resolve(w.downloads.length === 0);
  await runYoutubeFollowUps({
    videoId: VIDEO_ID, accessToken: "fixture", thumbnailUrl: THUMBNAIL_URL, firstComment: "Hello",
  }, w.deps);
  assertEquals(w.downloads.length, 1);
  assertEquals(w.calls.length, 0);
});
