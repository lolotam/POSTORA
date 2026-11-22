import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { resolveYouTubeVideoTitle } from "./youtubeVideoTitle.ts";

Deno.test("blank title falls back to the provider caption contract", () => {
  assertEquals(resolveYouTubeVideoTitle({ title: "", caption: "A caption from the post" }), "A caption from the post");
  assertEquals(resolveYouTubeVideoTitle({ title: null, caption: "x".repeat(120) }).length, 100);
  assertEquals(resolveYouTubeVideoTitle({ title: "", caption: "" }), "New Video");
});

Deno.test("Shorts truncate to 90 characters and add the suffix once", () => {
  const shorts = resolveYouTubeVideoTitle({ title: "", caption: "x".repeat(120), videoType: "short" });
  assertEquals(shorts.length, 98);
  assertEquals(shorts.endsWith(" #Shorts"), true);
  assertEquals(
    resolveYouTubeVideoTitle({ title: "Already #shorts", caption: "ignored", videoType: "short" }),
    "Already #shorts",
  );
});
