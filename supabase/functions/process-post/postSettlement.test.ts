import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildWebhookResults,
  type PlatformRow,
  type PostReader,
  readPostOutcome,
  summarizeRows,
  unreadableOutcomeLog,
  unrecordedStoryLog,
  writeLogRow,
} from "./postSettlement.ts";

const FALLBACK = {
  results: [{ platform: "instagram", status: "failed", error_message: "gave up" }],
  hasSuccess: false,
  hasFailed: true,
};
const noSleep = () => Promise.resolve();

const STORY: PlatformRow = { platform: "instagram", status: "success", platform_post_url: "https://ig/story", error_message: null };
const REEL: PlatformRow = { platform: "instagram", status: "failed", platform_post_url: null, error_message: "gave up" };
const THREADS: PlatformRow = { platform: "threads", status: "success", platform_post_url: "https://threads/p", error_message: null };
const PENDING: PlatformRow = { platform: "threads", status: "pending", platform_post_url: null, error_message: null };

type Answer<T> = { data: T | null; error: { message: string } | null } | Error;

/** A reader whose reads answer from a queue (the last answer repeats), counting each read. */
function reader(post: Answer<{ status: string }>[], rows: Answer<PlatformRow[]>[]) {
  const calls = { post: 0, rows: 0 };
  const next = <T>(queue: Answer<T>[], key: "post" | "rows") => {
    calls[key]++;
    const answer = queue.length > 1 ? queue.shift()! : queue[0];
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
  };
  const postReader: PostReader = {
    postStatus: () => next(post, "post"),
    platformRows: () => next(rows, "rows"),
  };
  return { reader: postReader, calls };
}
const ok = <T>(data: T) => ({ data, error: null });
const failed = (message: string) => ({ data: null, error: { message } });

Deno.test("every row of the post is reported, so an Instagram story and reel both appear", () => {
  assertEquals(summarizeRows([STORY, REEL, THREADS]), {
    results: [
      { platform: "instagram", status: "success", platform_post_url: "https://ig/story" },
      { platform: "instagram", status: "failed", error_message: "gave up" },
      { platform: "threads", status: "success", platform_post_url: "https://threads/p" },
    ],
    hasSuccess: true,
    hasFailed: true,
  });
});

Deno.test("a terminal post reports all of its rows, not only the account that was resumed", async () => {
  const { reader: r } = reader([ok({ status: "completed" })], [ok([THREADS, STORY, REEL])]);
  const outcome = await readPostOutcome(r, "post-1", FALLBACK, noSleep);
  assertEquals(outcome.kind, "terminal");
  if (outcome.kind !== "terminal") return;
  assertEquals(outcome.status, "completed");
  assertEquals(outcome.results.length, 3);
  assertEquals(outcome.hasFailed, true);
  assertEquals(outcome.degraded, null);
});

Deno.test("a post that is still processing is in progress, whatever its rows say", async () => {
  const { reader: r } = reader([ok({ status: "processing" })], [ok([STORY, PENDING])]);
  assertEquals(await readPostOutcome(r, "post-1", FALLBACK, noSleep), { kind: "in_progress" });
});

Deno.test("a failed read is retried once before anything is concluded", async () => {
  const { reader: r, calls } = reader([failed("statement timeout"), ok({ status: "failed" })], [ok([REEL])]);
  const outcome = await readPostOutcome(r, "post-1", FALLBACK, noSleep);
  assertEquals(outcome.kind, "terminal");
  assertEquals(calls.post, 2);
});

Deno.test("a read that throws is treated like one that errors", async () => {
  const { reader: r } = reader([new TypeError("connection reset"), ok({ status: "completed" })], [ok([STORY])]);
  assertEquals((await readPostOutcome(r, "post-1", FALLBACK, noSleep)).kind, "terminal");
});

Deno.test("with the post row unreadable, the rows decide: no pending row means terminal, derived like the sweeper", async () => {
  const withSuccess = reader([failed("timeout")], [ok([STORY, REEL])]);
  const completed = await readPostOutcome(withSuccess.reader, "post-1", FALLBACK, noSleep);
  assertEquals(completed.kind === "terminal" && completed.status, "completed");
  assertEquals(completed.kind === "terminal" && completed.degraded?.includes("post status unreadable"), true);

  const onlyFailures = reader([failed("timeout")], [ok([REEL])]);
  const failedPost = await readPostOutcome(onlyFailures.reader, "post-1", FALLBACK, noSleep);
  assertEquals(failedPost.kind === "terminal" && failedPost.status, "failed");
  assertEquals(withSuccess.calls.post, 2);
});

Deno.test("with the post row unreadable and a row still pending, the post is not finished", async () => {
  const { reader: r } = reader([failed("timeout")], [ok([STORY, PENDING])]);
  assertEquals(await readPostOutcome(r, "post-1", FALLBACK, noSleep), { kind: "in_progress" });
});

Deno.test("a terminal post whose rows cannot be read reports this run's account and says so", async () => {
  const { reader: r } = reader([ok({ status: "failed" })], [failed("timeout")]);
  const outcome = await readPostOutcome(r, "post-1", FALLBACK, noSleep);
  assertEquals(outcome.kind, "terminal");
  if (outcome.kind !== "terminal") return;
  assertEquals(outcome.results, FALLBACK.results);
  assertEquals(outcome.degraded?.includes("platform rows unreadable"), true);
});

Deno.test("when neither read works the outcome is unknown, never not-finished", async () => {
  const { reader: r, calls } = reader([failed("timeout")], [failed("timeout")]);
  const outcome = await readPostOutcome(r, "post-1", FALLBACK, noSleep);
  assertEquals(outcome.kind, "unknown");
  assertEquals(calls, { post: 2, rows: 2 });
});

Deno.test("an unreadable post with no rows at all is unknown rather than failed", async () => {
  const { reader: r } = reader([failed("timeout")], [ok([])]);
  assertEquals((await readPostOutcome(r, "post-1", FALLBACK, noSleep)).kind, "unknown");
});

Deno.test("the unreadable-outcome log row is an error naming the post and the row, with no secrets", () => {
  const row = unreadableOutcomeLog("user-1", "post-1", "pp-1", "post: timeout");
  assertEquals(row.level, "error");
  assertEquals(row.source, "process-post");
  assertEquals(row.user_id, "user-1");
  assertEquals(row.metadata, { post_id: "post-1", platform_post_id: "pp-1", error: "post: timeout" });
});

Deno.test("refusing to give up a reel over an unrecorded story writes an error log row naming the post and the row", () => {
  const row = unrecordedStoryLog("user-1", "post-1", "pp-1", "rpc failed");
  assertEquals(row.level, "error");
  assertEquals(row.source, "process-post");
  assertEquals(row.user_id, "user-1");
  assertEquals(row.metadata, { post_id: "post-1", platform_post_id: "pp-1", error: "rpc failed" });
});

Deno.test("when the abandoned reel's carried story is recorded, the degraded fallback reports it as a success", async () => {
  // finishDeferredPost passes the failed reel plus the story it just recorded as `fallback`.
  const fallback = {
    results: [
      { platform: "instagram", status: "failed", error_message: "gave up" },
      { platform: "instagram", status: "success", platform_post_url: "https://ig/story" },
    ],
    hasSuccess: true,
    hasFailed: true,
  };
  const outcome = await readPostOutcome(
    { postStatus: () => Promise.resolve({ data: { status: "completed" }, error: null }), platformRows: () => Promise.resolve({ data: null, error: { message: "timeout" } }) },
    "post-1",
    fallback,
    noSleep,
  );
  assertEquals(outcome.kind, "terminal");
  if (outcome.kind === "terminal") {
    assertEquals(outcome.results, fallback.results);
    assertEquals(outcome.hasSuccess, true);
  }
});

Deno.test("a log write that returns an error, or throws, is reported rather than taken for success", async () => {
  const dbReturning = (result: () => Promise<{ error: { message: string } | null }>) => ({ from: () => ({ insert: result }) });
  assertEquals(await writeLogRow(dbReturning(() => Promise.resolve({ error: null })), { a: 1 }), null);
  assertEquals(await writeLogRow(dbReturning(() => Promise.resolve({ error: { message: "permission denied" } })), { a: 1 }), "permission denied");
  assertEquals(await writeLogRow(dbReturning(() => Promise.reject(new Error("connection reset"))), { a: 1 }), "connection reset");
});

Deno.test("a live story is not overwritten by a failed reel in the legacy per-platform map", () => {
  const { platform_results } = buildWebhookResults(summarizeRows([STORY, REEL, THREADS]).results);
  assertEquals(platform_results.instagram, { status: "success", post_url: "https://ig/story" });
  assertEquals(platform_results.threads, { status: "success", post_url: "https://threads/p" });
  // The same answer whichever order the rows arrive in.
  assertEquals(buildWebhookResults(summarizeRows([REEL, STORY]).results).platform_results.instagram.status, "success");
});

Deno.test("a platform with only failures stays failed, and a pending row outranks a failure", () => {
  assertEquals(buildWebhookResults(summarizeRows([REEL]).results).platform_results.instagram, { status: "failed", post_url: null });
  const pendingAndFailed = buildWebhookResults(summarizeRows([REEL, { ...PENDING, platform: "instagram" }]).results);
  assertEquals(pendingAndFailed.platform_results.instagram.status, "pending");
});

Deno.test("the additive list carries every row, story and reel apart, with their errors", () => {
  const { platform_results_list } = buildWebhookResults(summarizeRows([STORY, REEL]).results);
  assertEquals(platform_results_list, [
    { platform: "instagram", status: "success", post_url: "https://ig/story", error_message: null },
    { platform: "instagram", status: "failed", post_url: null, error_message: "gave up" },
  ]);
});

Deno.test("the legacy map keeps its exact shape for existing consumers (platform -> {status, post_url})", () => {
  const { platform_results } = buildWebhookResults([{ platform: "facebook", status: "success", platform_post_url: "https://fb/1" }]);
  assertEquals(Object.keys(platform_results.facebook).sort(), ["post_url", "status"]);
});

Deno.test("a reel row holding the account's live story reports the story and the given-up reel", () => {
  const row = { platform: "instagram", status: "success", platform_post_url: "https://ig/story", error_message: "gave up", story_on_reel: true };
  assertEquals(summarizeRows([row]), {
    results: [
      { platform: "instagram", status: "success", platform_post_url: "https://ig/story" },
      { platform: "instagram", status: "failed", error_message: "gave up" },
    ],
    hasSuccess: true,
    hasFailed: true,
  });
});
