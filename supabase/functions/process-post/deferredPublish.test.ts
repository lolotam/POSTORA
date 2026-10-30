import { assertEquals, assertInstanceOf } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { CHECK_ONCE_DEADLINE, pollContainer } from "../_shared/metaContainerStatus.ts";
import {
  abandonReason,
  bufferAfterFinishedMs,
  ContainerStillProcessing,
  DEFERRAL_GIVE_UP_MS,
  FIRST_RUN_POLL_BUDGET_MS,
  giveUpMessage,
  isPastGiveUp,
  newDeferral,
  nextDeferral,
  ownContainerDeadline,
  STORY_RECOVERY_GRACE_MS,
  storyRecoveryExhausted,
  pollDeadline,
  readDeferral,
  recordStillProcessing,
  unfinishedError,
} from "./deferredPublish.ts";

const NOW = new Date("2026-10-29T12:00:00.000Z");

Deno.test("a new deferral is checked in a minute and given up after thirty", () => {
  const deferral = newDeferral("ig_reel", "c-1", NOW);
  assertEquals(deferral, {
    kind: "ig_reel",
    container_id: "c-1",
    attempts: 0,
    first_deferred_at: "2026-10-29T12:00:00.000Z",
    give_up_at: "2026-10-29T12:30:00.000Z",
    next_check_at: "2026-10-29T12:01:00.000Z",
  });
});

Deno.test("each further check counts an attempt and drops the lease", () => {
  const later = new Date("2026-10-29T12:05:00.000Z");
  const next = nextDeferral({ ...newDeferral("threads", "c-2", NOW), claimed_until: "2026-10-29T12:08:00.000Z" }, later);
  assertEquals(next.attempts, 1);
  assertEquals(next.next_check_at, "2026-10-29T12:06:00.000Z");
  assertEquals(next.claimed_until, null);
  assertEquals(next.give_up_at, "2026-10-29T12:30:00.000Z");
});

Deno.test("the deadline is passed at give_up_at, not before", () => {
  const deferral = newDeferral("ig_business_reel", "c-3", NOW);
  assertEquals(isPastGiveUp(deferral, new Date(NOW.getTime() + DEFERRAL_GIVE_UP_MS - 1)), false);
  assertEquals(isPastGiveUp(deferral, new Date(NOW.getTime() + DEFERRAL_GIVE_UP_MS)), true);
  assertEquals(giveUpMessage("threads"), "Threads did not finish processing the video within 30 minutes. Safe to retry.");
});

Deno.test("a resumed run is abandoned past its deadline or once the post has changed", () => {
  const deferral = newDeferral("ig_reel", "c-5", NOW);
  const inTime = new Date(NOW.getTime() + DEFERRAL_GIVE_UP_MS - 1);
  assertEquals(abandonReason(deferral, "processing", inTime), null);
  assertEquals(abandonReason(deferral, "processing", new Date(NOW.getTime() + DEFERRAL_GIVE_UP_MS)), giveUpMessage("ig_reel"));
  assertEquals(abandonReason(deferral, "failed", inTime), "The post was changed while the video was processing. Safe to retry.");
});

Deno.test("a resumed run checks once; a first run waits within its budget", () => {
  assertEquals(pollDeadline(1_000, true), 0);
  assertEquals(pollDeadline(1_000, false), 1_000 + FIRST_RUN_POLL_BUDGET_MS);
});

Deno.test("a container this run creates and finishes gets a real bound even on a resumed run", () => {
  // The resumed run's own deadline is check-once; the mirror story container has no later check,
  // so it gets the budget a first run would have, counted from when this request began.
  assertEquals(ownContainerDeadline(pollDeadline(1_000, true), 1_000), 1_000 + FIRST_RUN_POLL_BUDGET_MS);
  // A first run keeps its deadline, so the mirror never outlasts the worker.
  const first = pollDeadline(1_000, false);
  assertEquals(ownContainerDeadline(first, 1_000), first);
  assertEquals(ownContainerDeadline(Infinity, 1_000), Infinity);
});

Deno.test("an abandon may retry an unrecordable story only for the grace window past give-up", () => {
  const deferral = newDeferral("ig_reel", "c1", new Date(0));
  const giveUp = Date.parse(deferral.give_up_at);
  assertEquals(storyRecoveryExhausted(deferral, new Date(giveUp)), false);
  assertEquals(storyRecoveryExhausted(deferral, new Date(giveUp + STORY_RECOVERY_GRACE_MS - 1)), false);
  assertEquals(storyRecoveryExhausted(deferral, new Date(giveUp + STORY_RECOVERY_GRACE_MS)), true);
});

Deno.test("only a well-formed deferral is read off a row", () => {
  const deferral = newDeferral("ig_reel", "c-4", NOW);
  assertEquals(readDeferral({ deferred: deferral, account_username: "x" }), deferral);
  assertEquals(readDeferral({ tiktok_publish_id: "p" }), null);
  assertEquals(readDeferral({ deferred: { kind: "ig_reel" } }), null);
  assertEquals(readDeferral(null), null);
});

function fakeDb(error: string | null = null) {
  const writes: { op: string; values: unknown; filters: [string, unknown][] }[] = [];
  const db = {
    rpc: (fn: string, args: unknown) => {
      writes.push({ op: `rpc:${fn}`, values: args, filters: [] });
      return Promise.resolve({ error: error ? { message: error } : null });
    },
    from: () => ({
      update: (values: unknown) => {
        const write = { op: "update", values, filters: [] as [string, unknown][] };
        writes.push(write);
        const chain = {
          eq: (column: string, value: unknown) => {
            write.filters.push([column, value]);
            return write.filters.length === 2 ? Promise.resolve({ error: error ? { message: error } : null }) : chain;
          },
        };
        return chain;
      },
    }),
  };
  return { db, writes };
}

const ACCOUNT = { id: "acct-1", platform: "instagram", platform_username: "shop" };
const SIGNAL = new ContainerStillProcessing("ig_reel", "c-9");
const noSettle = () => Promise.reject(new Error("settle must not be called"));

Deno.test("a first run records its pending row through the tenancy-checking SQL function", async () => {
  const { db, writes } = fakeDb();
  const result = await recordStillProcessing(db, noSettle, { postId: "post-1", account: ACCOUNT, signal: SIGNAL, resume: null, resumeResponseData: null }, NOW);
  assertEquals(result, { gaveUp: false, error: null });
  assertEquals(writes.length, 1);
  assertEquals(writes[0].op, "rpc:record_deferred_platform_post");
  const args = writes[0].values as { p_post_id: string; p_social_account_id: string; p_response_data: Record<string, unknown> };
  assertEquals([args.p_post_id, args.p_social_account_id], ["post-1", "acct-1"]);
  assertEquals(args.p_response_data.deferred, newDeferral("ig_reel", "c-9", NOW));
  assertEquals(args.p_response_data.account_username, "shop");
});

Deno.test("a story the first run could not record travels on the pending row", async () => {
  const { db, writes } = fakeDb();
  const signal = new ContainerStillProcessing("ig_reel", "c-9");
  signal.unrecordedStory = { id: "story-1", url: "https://ig/s/1" };
  await recordStillProcessing(db, noSettle, { postId: "post-1", account: ACCOUNT, signal, resume: null, resumeResponseData: null }, NOW);
  const data = (writes[0].values as { p_response_data: Record<string, unknown> }).p_response_data;
  assertEquals(data.unrecorded_story, { id: "story-1", url: "https://ig/s/1" });
});

Deno.test("with no story to carry the pending row has no story field", async () => {
  const { db, writes } = fakeDb();
  await recordStillProcessing(db, noSettle, { postId: "post-1", account: ACCOUNT, signal: SIGNAL, resume: null, resumeResponseData: null }, NOW);
  assertEquals("unrecorded_story" in (writes[0].values as { p_response_data: object }).p_response_data, false);
});

Deno.test("a cross-tenant refusal from the SQL function is an error, never a recorded row", async () => {
  const { db } = fakeDb("record_deferred_platform_post: account a does not belong to the owner of post p (cross-tenant pairing refused)");
  const result = await recordStillProcessing(db, noSettle, { postId: "post-1", account: ACCOUNT, signal: SIGNAL, resume: null, resumeResponseData: null }, NOW);
  assertEquals(result.gaveUp, false);
  assertEquals(result.error?.includes("cross-tenant pairing refused"), true);
});

Deno.test("a resumed run before the deadline moves the next check out and keeps the row's data", async () => {
  const { db, writes } = fakeDb();
  const deferral = newDeferral("ig_reel", "c-9", NOW);
  const later = new Date(NOW.getTime() + 5 * 60 * 1000);
  const result = await recordStillProcessing(db, noSettle, {
    postId: "post-1", account: ACCOUNT, signal: SIGNAL,
    resume: { platformPostId: "pp-1", deferral },
    resumeResponseData: { deferred: deferral, account_username: "shop" },
  }, later);
  assertEquals(result, { gaveUp: false, error: null });
  assertEquals(writes[0].filters, [["id", "pp-1"], ["status", "pending"]]);
  const values = writes[0].values as { response_data: Record<string, unknown> };
  assertEquals(values.response_data.account_username, "shop");
  assertEquals(values.response_data.deferred, nextDeferral(deferral, later));
});

Deno.test("a resumed run past the deadline settles the row failed instead", async () => {
  const { db, writes } = fakeDb();
  const settled: unknown[] = [];
  const settle = (_db: unknown, args: unknown) => {
    settled.push(args);
    return Promise.resolve({ id: "pp-1", error: null });
  };
  const deferral = newDeferral("threads", "c-9", NOW);
  const result = await recordStillProcessing(db, settle, {
    postId: "post-1", account: { ...ACCOUNT, platform: "threads" }, signal: SIGNAL,
    resume: { platformPostId: "pp-1", deferral }, resumeResponseData: null,
  }, new Date(NOW.getTime() + DEFERRAL_GIVE_UP_MS));
  assertEquals(result, { gaveUp: true, error: null });
  assertEquals(writes.length, 0);
  assertEquals(settled, [{
    platformPostId: "pp-1", postId: "post-1", socialAccountId: "acct-1", platform: "threads",
    status: "failed", errorMessage: giveUpMessage("threads"),
  }]);
});

Deno.test("a failed write is reported, not swallowed", async () => {
  const { db } = fakeDb("permission denied");
  const result = await recordStillProcessing(db, noSettle, { postId: "post-1", account: ACCOUNT, signal: SIGNAL, resume: null, resumeResponseData: null }, NOW);
  assertEquals(result, { gaveUp: false, error: "permission denied" });
});

Deno.test("a deferrable container that runs out of time is left for the reconciler", () => {
  const error = unfinishedError({ deadlineMs: 5_000, deferKind: "ig_reel" }, "c-1", "Instagram");
  assertInstanceOf(error, ContainerStillProcessing);
  assertEquals([(error as ContainerStillProcessing).kind, (error as ContainerStillProcessing).containerId], ["ig_reel", "c-1"]);
});

Deno.test("any other container that runs out of time fails with a clear, retryable error", () => {
  for (const wait of [{ deadlineMs: 5_000 }, { deadlineMs: Number.POSITIVE_INFINITY, deferKind: "threads" as const }]) {
    const error = unfinishedError(wait, "c-2", "Threads");
    assertEquals(error instanceof ContainerStillProcessing, false);
    assertEquals(error.message, "Threads did not finish processing the media in time. Safe to retry.");
  }
});

Deno.test("a non-deferrable wait over a slow Meta ends by the deadline, then fails retryably", async () => {
  let t = 1_000_000;
  const deadlineMs = t + 35_000;
  const timeouts: number[] = [];
  const container = await pollContainer("instagram", "https://x", {
    maxAttempts: 60, intervalMs: 2000, checkFirst: true, deadlineMs, now: () => t,
    sleep: (ms) => { t += ms; return Promise.resolve(); },
    fetcher: (_url, timeoutMs) => { timeouts.push(timeoutMs); t += timeoutMs; return Promise.reject(new DOMException("timed out", "TimeoutError")); },
  });
  assertEquals(container, { state: "waiting" });
  assertEquals(t <= deadlineMs, true);
  assertEquals(unfinishedError({ deadlineMs }, "c-3", "Instagram").message, "Instagram did not finish processing the media in time. Safe to retry.");
});

Deno.test("the pause after FINISHED counts against the deadline", () => {
  assertEquals(bufferAfterFinishedMs(10_000, 1_000), 3000);
  assertEquals(bufferAfterFinishedMs(10_000, 8_500), 1500);
  assertEquals(bufferAfterFinishedMs(10_000, 10_000), 0);
  assertEquals(bufferAfterFinishedMs(10_000, 12_000), 0);
});

Deno.test("a resumed run, with a worker of its own, and a wait with no deadline keep the whole pause", () => {
  assertEquals(bufferAfterFinishedMs(CHECK_ONCE_DEADLINE, 1_000_000), 3000);
  assertEquals(bufferAfterFinishedMs(Number.POSITIVE_INFINITY, 1_000_000), 3000);
});
