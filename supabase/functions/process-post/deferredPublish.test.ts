import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  abandonReason,
  ContainerStillProcessing,
  DEFERRAL_GIVE_UP_MS,
  FIRST_RUN_POLL_BUDGET_MS,
  giveUpMessage,
  isPastGiveUp,
  newDeferral,
  nextDeferral,
  pollDeadline,
  readDeferral,
  recordStillProcessing,
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
    from: () => ({
      insert: (values: unknown) => {
        writes.push({ op: "insert", values, filters: [] });
        return Promise.resolve({ error: error ? { message: error } : null });
      },
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

Deno.test("a first run records a pending row carrying the deferral", async () => {
  const { db, writes } = fakeDb();
  const result = await recordStillProcessing(db, noSettle, { postId: "post-1", account: ACCOUNT, signal: SIGNAL, resume: null, resumeResponseData: null }, NOW);
  assertEquals(result, { gaveUp: false, error: null });
  assertEquals(writes[0].op, "insert");
  const row = writes[0].values as Record<string, unknown>;
  assertEquals([row.post_id, row.social_account_id, row.platform, row.status], ["post-1", "acct-1", "instagram", "pending"]);
  assertEquals((row.response_data as Record<string, unknown>).deferred, newDeferral("ig_reel", "c-9", NOW));
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
