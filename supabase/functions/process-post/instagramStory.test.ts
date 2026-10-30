import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { recordPublishedStory } from "./instagramStory.ts";

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
