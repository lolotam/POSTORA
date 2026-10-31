import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.89.0";
import {
  dropRecordedStory,
  newStoryLedger,
  readUnrecordedStory,
  recordCarriedStory,
  recordedStoryResults,
  recordLiveStory,
  recordPublishedStory,
  recordWithOneRetry,
  storyOnReelRowData,
  UNRECORDED_STORY_KEY,
} from "./instagramStory.ts";

type RpcCall = { fn: string; args: Record<string, unknown> };
type RpcAnswer = { data?: unknown; error: { message: string } | null } | Error;

/** A client whose rpc() answers each call with the next of `answers` (the last one repeats). */
function rpcClient(...answers: RpcAnswer[]) {
  const calls: RpcCall[] = [];
  const client = {
    rpc: (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args });
      const answer = answers[Math.min(calls.length, answers.length) - 1] ?? { data: null, error: null };
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
    },
  } as unknown as SupabaseClient;
  return { client, calls };
}
const ok = { data: { platform_post_id: "row-1", recorded: true }, error: null };
const failed = (message: string) => ({ data: null, error: { message } });
const noSleep = () => Promise.resolve();

const ACCOUNT = { id: "acct-1", platform_username: "shop", account_metadata: { account_type: "facebook_linked" } };
const STORY = { id: "story-9", url: "https://www.instagram.com/stories/shop/9/" };

Deno.test("the published story is recorded in one call that looks for its row and inserts it", async () => {
  const { client, calls } = rpcClient(ok);
  const error = await recordPublishedStory(client, { postId: "post-1", account: ACCOUNT, story: STORY });

  assertEquals(error, null);
  assertEquals(calls, [{
    fn: "record_published_story",
    args: {
      p_post_id: "post-1",
      p_social_account_id: "acct-1",
      p_story_id: "story-9",
      p_story_url: "https://www.instagram.com/stories/shop/9/",
      p_response_data: { account_username: "shop", account_metadata: { account_type: "facebook_linked" } },
    },
  }]);
});

Deno.test("a story the database already has is a success, not an error", async () => {
  const { client } = rpcClient({ data: { platform_post_id: "row-1", recorded: false }, error: null });
  assertEquals(await recordPublishedStory(client, { postId: "post-1", account: ACCOUNT, story: STORY }), null);
});

Deno.test("an answer without a row is an error, so a carried story is not dropped", async () => {
  const { client } = rpcClient({ data: { platform_post_id: null, recorded: false }, error: null });
  assertEquals(await recordPublishedStory(client, { postId: "p", account: ACCOUNT, story: STORY }), "record_published_story answered no row");
});

Deno.test("an rpc error or a throw is returned, not thrown: the story is live either way", async () => {
  assertEquals(await recordPublishedStory(rpcClient(failed("rpc failed")).client, { postId: "p", account: ACCOUNT, story: STORY }), "rpc failed");
  assertEquals(
    await recordPublishedStory(rpcClient(new Error("connection reset")).client, { postId: "p", account: ACCOUNT, story: STORY }),
    "connection reset",
  );
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
  const flakyDb = rpcClient(failed("rpc failed"), ok);
  assertEquals(await recordLiveStory(flakyDb.client, { postId: "p", account: ACCOUNT, story: STORY }, flaky, noSleep), null);
  assertEquals(flaky, { live: [STORY], recorded: [STORY] });
  assertEquals(flakyDb.calls.length, 2);

  // The write failed even after the retry: the story is still out there, so the roll-up counts
  // it, but it is not recorded, so the carry on the pending row must keep it.
  const down = newStoryLedger();
  const error = await recordLiveStory(rpcClient(failed("rpc failed")).client, { postId: "p", account: ACCOUNT, story: STORY }, down, noSleep);
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

Deno.test("a carried story is recorded before its reel is given up, from the data on the pending row", async () => {
  const { client, calls } = rpcClient(ok);
  const rowData = { [UNRECORDED_STORY_KEY]: STORY, account_username: "shop", account_metadata: { a: 1 }, deferred: {} };
  const result = await recordCarriedStory(client, { postId: "post-1", socialAccountId: "acct-1", rowData }, noSleep);
  assertEquals(result, { recorded: [STORY], error: null });
  assertEquals(calls.length, 1);
  assertEquals(calls[0].args.p_story_id, "story-9");
  assertEquals(calls[0].args.p_social_account_id, "acct-1");
  assertEquals(calls[0].args.p_response_data, { account_username: "shop", account_metadata: { a: 1 } });
});

Deno.test("a carried story that still cannot be recorded is an error, so the caller does not settle the reel", async () => {
  const { client, calls } = rpcClient(failed("rpc failed"));
  const result = await recordCarriedStory(client, { postId: "post-1", socialAccountId: "acct-1", rowData: { [UNRECORDED_STORY_KEY]: STORY } }, noSleep);
  assertEquals(result, { recorded: [], error: "rpc failed" });
  assertEquals(calls.length, 2); // tried once more
});

Deno.test("nothing carried is nothing to do: no call is made", async () => {
  const { client, calls } = rpcClient(ok);
  assertEquals(await recordCarriedStory(client, { postId: "p", socialAccountId: "a", rowData: { deferred: {} } }, noSleep), { recorded: [], error: null });
  assertEquals(await recordCarriedStory(client, { postId: "p", socialAccountId: "a", rowData: null }, noSleep), { recorded: [], error: null });
  assertEquals(calls, []);
});

Deno.test("a reel row settled as the account's live story drops the deferral and the carry, keeps the account details", () => {
  const data = storyOnReelRowData({
    deferred: { kind: "ig_reel" },
    unrecorded_story: { id: "s1", url: "https://ig/s1" },
    account_username: "me",
    account_metadata: { page: 1 },
  });
  assertEquals(data, { account_username: "me", account_metadata: { page: 1 }, story_recorded_on_reel_row: true });
  assertEquals(storyOnReelRowData(null), { story_recorded_on_reel_row: true });
});
