import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.89.0";
import {
  dropRecordedStory,
  findRecordedStory,
  newStoryLedger,
  readUnrecordedStory,
  recordCarriedStory,
  recordedStoryResults,
  recordLiveStory,
  recordPublishedStory,
  recordWithOneRetry,
  UNRECORDED_STORY_KEY,
} from "./instagramStory.ts";

/** A platform_posts table that answers the story lookup with `rows`, or fails it. */
function clientWithRows(rows: { id: string }[], failure?: string) {
  const filters: Record<string, unknown> = {};
  const query = {
    eq: (column: string, value: unknown) => {
      filters[column] = value;
      return query;
    },
    limit: () => Promise.resolve(failure ? { data: null, error: { message: failure } } : { data: rows, error: null }),
  };
  const client = {
    from: (table: string) => {
      filters.table = table;
      return { select: () => query };
    },
  } as unknown as SupabaseClient;
  return { client, filters };
}
const noSleep = () => Promise.resolve();
const NO_ROWS = clientWithRows([]).client;

const ACCOUNT = { id: "acct-1", platform_username: "shop", account_metadata: { account_type: "facebook_linked" } };
const STORY = { id: "story-9", url: "https://www.instagram.com/stories/shop/9/" };

Deno.test("the published story is recorded as its own successful row, tagged as a story", async () => {
  const calls: unknown[] = [];
  const error = await recordPublishedStory(NO_ROWS, (_db, args) => {
    calls.push(args);
    return Promise.resolve({ id: "row-1", error: null });
  }, { postId: "post-1", account: ACCOUNT, story: STORY });

  assertEquals(error, null);
  assertEquals(calls, [{
    platformPostId: null,
    postId: "post-1",
    socialAccountId: "acct-1",
    platform: "instagram",
    status: "success",
    providerPostId: "story-9",
    providerPostUrl: "https://www.instagram.com/stories/shop/9/",
    responseData: {
      ig_post_subtype: "story",
      account_username: "shop",
      account_metadata: { account_type: "facebook_linked" },
    },
  }]);
});

Deno.test("a story already recorded is not inserted again, whoever asks", async () => {
  const { client, filters } = clientWithRows([{ id: "row-1" }]);
  let settles = 0;
  const error = await recordPublishedStory(client, () => {
    settles++;
    return Promise.resolve({ id: "row-2", error: null });
  }, { postId: "post-1", account: ACCOUNT, story: STORY });
  assertEquals(error, null);
  assertEquals(settles, 0);
  // Looked up by this post, this account and the story's own media id.
  assertEquals(filters, { table: "platform_posts", post_id: "post-1", social_account_id: "acct-1", platform_post_id: "story-9" });
});

Deno.test("a lookup that fails is an error, not 'none found': nothing is inserted", async () => {
  let settles = 0;
  const error = await recordPublishedStory(clientWithRows([], "statement timeout").client, () => {
    settles++;
    return Promise.resolve({ id: "row-2", error: null });
  }, { postId: "post-1", account: ACCOUNT, story: STORY });
  assertEquals(error, "could not check whether the story is already recorded: statement timeout");
  assertEquals(settles, 0);
  assertEquals(await findRecordedStory(clientWithRows([], "boom").client, { postId: "p", socialAccountId: "a", storyId: "s" }), { recorded: false, error: "boom" });
  assertEquals(await findRecordedStory(clientWithRows([]).client, { postId: "p", socialAccountId: "a", storyId: "s" }), { recorded: false, error: null });
});

Deno.test("a retry after a write that actually landed does not duplicate the row", async () => {
  // First settle times out on the client side but the row is written; the retry finds it.
  const rows: { id: string }[] = [];
  const client = {
    from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ eq: () => ({ limit: () => Promise.resolve({ data: [...rows], error: null }) }) }) }) }) }),
  } as unknown as SupabaseClient;
  let inserts = 0;
  const settle = () => {
    inserts++;
    rows.push({ id: `row-${inserts}` });
    return Promise.resolve({ id: null, error: "connection reset" });
  };
  const ledger = newStoryLedger();
  assertEquals(await recordLiveStory(client, settle, { postId: "p", account: ACCOUNT, story: STORY }, ledger, noSleep), null);
  assertEquals(inserts, 1);
  assertEquals(ledger, { live: [STORY], recorded: [STORY] });
});

Deno.test("it never settles the reel's pending row: the story row is always new", async () => {
  let platformPostId: string | null | undefined = "unset";
  await recordPublishedStory(NO_ROWS, (_db, args) => {
    platformPostId = args.platformPostId;
    return Promise.resolve({ id: "row-1", error: null });
  }, { postId: "post-1", account: ACCOUNT, story: STORY });
  assertEquals(platformPostId, null);
});

Deno.test("a recording that fails is tried once more, and only once", async () => {
  let calls = 0;
  assertEquals(await recordWithOneRetry(() => { calls++; return Promise.resolve(calls === 1 ? "boom" : null); }, noSleep), null);
  assertEquals(calls, 2);

  calls = 0;
  assertEquals(await recordWithOneRetry(() => { calls++; return Promise.resolve("still down"); }, noSleep), "still down");
  assertEquals(calls, 2);

  calls = 0;
  assertEquals(await recordWithOneRetry(() => { calls++; return Promise.resolve(null); }, noSleep), null);
  assertEquals(calls, 1);
});

Deno.test("a story is live whether or not its row landed, and recorded only when it did", async () => {
  const flaky = newStoryLedger();
  let settles = 0;
  const flakySettle = () => Promise.resolve(++settles === 1 ? { id: null, error: "rpc failed" } : { id: "row-1", error: null });
  assertEquals(await recordLiveStory(NO_ROWS, flakySettle, { postId: "p", account: ACCOUNT, story: STORY }, flaky, noSleep), null);
  assertEquals(flaky, { live: [STORY], recorded: [STORY] });
  assertEquals(settles, 2);

  // The write failed even after the retry: the story is still out there, so the roll-up counts
  // it, but it is not recorded, so the carry on the pending row must keep it.
  const down = newStoryLedger();
  const error = await recordLiveStory(NO_ROWS, () => Promise.resolve({ id: null, error: "rpc failed" }), { postId: "p", account: ACCOUNT, story: STORY }, down, noSleep);
  assertEquals(error, "rpc failed");
  assertEquals(down, { live: [STORY], recorded: [] });
  const carried = { [UNRECORDED_STORY_KEY]: STORY };
  assertEquals(dropRecordedStory(carried, down.recorded), carried);
  assertEquals(recordedStoryResults(down.live), [{ platform: "instagram", status: "success", platform_post_url: STORY.url }]);
});

Deno.test("a recorded story counts as a successful Instagram result for the roll-up and the notices", () => {
  assertEquals(recordedStoryResults([STORY]), [{ platform: "instagram", status: "success", platform_post_url: STORY.url }]);
  assertEquals(recordedStoryResults([]), []);
});

Deno.test("a story that could not be recorded is read back off the pending row, and only if well-formed", () => {
  assertEquals(readUnrecordedStory({ [UNRECORDED_STORY_KEY]: STORY, deferred: {} }), STORY);
  assertEquals(readUnrecordedStory({ deferred: {} }), null);
  assertEquals(readUnrecordedStory({ [UNRECORDED_STORY_KEY]: { id: "", url: "x" } }), null);
  assertEquals(readUnrecordedStory({ [UNRECORDED_STORY_KEY]: { id: "s" } }), null);
  assertEquals(readUnrecordedStory(null), null);
});

Deno.test("once the carried story is recorded it leaves the pending row's data, so it is not recorded twice", () => {
  const data = { [UNRECORDED_STORY_KEY]: STORY, account_username: "shop", deferred: { container_id: "c" } };
  assertEquals(dropRecordedStory(data, [STORY]), { account_username: "shop", deferred: { container_id: "c" } });
  // Not recorded this run: it stays for the next one.
  assertEquals(dropRecordedStory(data, []), data);
  assertEquals(dropRecordedStory(data, [{ id: "other", url: "u" }]), data);
  assertEquals(dropRecordedStory(null, [STORY]), null);
});

Deno.test("a settle error or a throw is returned, not thrown: the story is live either way", async () => {
  assertEquals(
    await recordPublishedStory(NO_ROWS, () => Promise.resolve({ id: null, error: "rpc failed" }), { postId: "p", account: ACCOUNT, story: STORY }),
    "rpc failed",
  );
  assertEquals(
    await recordPublishedStory(NO_ROWS, () => Promise.reject(new Error("connection reset")), { postId: "p", account: ACCOUNT, story: STORY }),
    "connection reset",
  );
});

Deno.test("a carried story is recorded before its reel is given up, from the data on the pending row", async () => {
  const calls: { providerPostId?: string | null; responseData?: Record<string, unknown> | null }[] = [];
  const rowData = { [UNRECORDED_STORY_KEY]: STORY, account_username: "shop", account_metadata: { a: 1 }, deferred: {} };
  const result = await recordCarriedStory(NO_ROWS, (_db, args) => {
    calls.push(args);
    return Promise.resolve({ id: "row-1", error: null });
  }, { postId: "post-1", socialAccountId: "acct-1", rowData }, noSleep);
  assertEquals(result, { recorded: [STORY], error: null });
  assertEquals(calls.length, 1);
  assertEquals(calls[0].providerPostId, "story-9");
  assertEquals(calls[0].responseData, { ig_post_subtype: "story", account_username: "shop", account_metadata: { a: 1 } });
});

Deno.test("a carried story that still cannot be recorded is an error, so the caller does not settle the reel", async () => {
  let settles = 0;
  const result = await recordCarriedStory(NO_ROWS, () => {
    settles++;
    return Promise.resolve({ id: null, error: "rpc failed" });
  }, { postId: "post-1", socialAccountId: "acct-1", rowData: { [UNRECORDED_STORY_KEY]: STORY } }, noSleep);
  assertEquals(result, { recorded: [], error: "rpc failed" });
  assertEquals(settles, 2); // tried once more
});

Deno.test("a carried story the row already has is not written twice, and nothing carried is nothing to do", async () => {
  let settles = 0;
  const settle = () => {
    settles++;
    return Promise.resolve({ id: "row-2", error: null });
  };
  const already = clientWithRows([{ id: "row-1" }]).client;
  assertEquals(await recordCarriedStory(already, settle, { postId: "p", socialAccountId: "a", rowData: { [UNRECORDED_STORY_KEY]: STORY } }, noSleep), { recorded: [STORY], error: null });
  assertEquals(await recordCarriedStory(NO_ROWS, settle, { postId: "p", socialAccountId: "a", rowData: { deferred: {} } }, noSleep), { recorded: [], error: null });
  assertEquals(await recordCarriedStory(NO_ROWS, settle, { postId: "p", socialAccountId: "a", rowData: null }, noSleep), { recorded: [], error: null });
  assertEquals(settles, 0);
});
