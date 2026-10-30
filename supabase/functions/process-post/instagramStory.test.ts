import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  dropRecordedStory,
  readUnrecordedStory,
  recordedStoryResults,
  recordLiveStory,
  recordPublishedStory,
  recordWithOneRetry,
  UNRECORDED_STORY_KEY,
} from "./instagramStory.ts";

const ACCOUNT = { id: "acct-1", platform_username: "shop", account_metadata: { account_type: "facebook_linked" } };
const STORY = { id: "story-9", url: "https://www.instagram.com/stories/shop/9/" };

Deno.test("the published story is recorded as its own successful row, tagged as a story", async () => {
  const calls: unknown[] = [];
  const error = await recordPublishedStory({}, (_db, args) => {
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

Deno.test("it never settles the reel's pending row: the story row is always new", async () => {
  let platformPostId: string | null | undefined = "unset";
  await recordPublishedStory({}, (_db, args) => {
    platformPostId = args.platformPostId;
    return Promise.resolve({ id: "row-1", error: null });
  }, { postId: "post-1", account: ACCOUNT, story: STORY });
  assertEquals(platformPostId, null);
});

const noSleep = () => Promise.resolve();

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

Deno.test("a story is counted as live only once its row is written, after a retry if need be", async () => {
  const live: { id: string; url: string }[] = [];
  let settles = 0;
  const flaky = () => Promise.resolve(++settles === 1 ? { id: null, error: "rpc failed" } : { id: "row-1", error: null });
  assertEquals(await recordLiveStory({}, flaky, { postId: "p", account: ACCOUNT, story: STORY }, live, noSleep), null);
  assertEquals(live, [STORY]);
  assertEquals(settles, 2);

  const down: { id: string; url: string }[] = [];
  const error = await recordLiveStory({}, () => Promise.resolve({ id: null, error: "rpc failed" }), { postId: "p", account: ACCOUNT, story: STORY }, down, noSleep);
  assertEquals(error, "rpc failed");
  assertEquals(down, []);
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
    await recordPublishedStory({}, () => Promise.resolve({ id: null, error: "rpc failed" }), { postId: "p", account: ACCOUNT, story: STORY }),
    "rpc failed",
  );
  assertEquals(
    await recordPublishedStory({}, () => Promise.reject(new Error("connection reset")), { postId: "p", account: ACCOUNT, story: STORY }),
    "connection reset",
  );
});
