import { assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { prepareIndependentStory } from "./independentStory.ts";

Deno.test("a Reel plus Story persists intent before removing only inline Story work", async () => {
  const post = { id: "post", user_id: "owner", metadata: { instagram_post_type: ["reel", "story", "feed"], instagram_share_to_story: true, instagram_share_to_feed: true } };
  const calls: unknown[] = [];
  const result = await prepareIndependentStory(post, "account", async (...args) => { calls.push(args); return true; });
  assertEquals(calls, [["post", "account", "owner"]]);
  assertEquals(result.metadata, { ...post.metadata, instagram_post_type: ["reel", "feed"], instagram_share_to_story: false });
  assertEquals(post.metadata.instagram_post_type, ["reel", "story", "feed"]);
});
Deno.test("missing durable intent refuses primary dispatch instead of losing the requested Story", async () => {
  const post = { id: "post", user_id: "owner", metadata: { instagram_post_type: "reel", instagram_share_to_story: true } };
  await assertRejects(() => prepareIndependentStory(post, "account", async () => false), Error, "story_intent_not_recorded");
});
Deno.test("standalone Stories and non-opted-in Reels preserve their existing publisher", async () => {
  for (const metadata of [{ instagram_post_type: "story" }, { instagram_post_type: "reel" }, { instagram_post_type: "feed", instagram_share_to_story: true }]) {
    const post = { id: "post", user_id: "owner", metadata };
    assertEquals(await prepareIndependentStory(post, "account", async () => { throw new Error("unexpected prepare"); }), post);
  }
});
