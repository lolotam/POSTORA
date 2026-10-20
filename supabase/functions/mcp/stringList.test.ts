import { assertEquals } from "jsr:@std/assert@1";
import { normalizeListFields, toStringList } from "./stringList.ts";

Deno.test("toStringList keeps arrays, trimming strings and dropping empty ones", () => {
  assertEquals(toStringList(["  facebook  ", "", "instagram", "   ", 42, null]), [
    "facebook",
    "instagram",
    42,
    null,
  ]);
});

Deno.test("toStringList parses JSON-array text", () => {
  assertEquals(toStringList('["uuid-1","uuid-2"]'), ["uuid-1", "uuid-2"]);
  assertEquals(toStringList('  ["uuid-1"]  '), ["uuid-1"]);
});

Deno.test("toStringList keeps invalid JSON text unchanged", () => {
  assertEquals(toStringList("[not json"), "[not json");
  assertEquals(toStringList("[1, 2"), "[1, 2");
});

Deno.test("toStringList splits comma-separated text", () => {
  assertEquals(toStringList("facebook, instagram"), ["facebook", "instagram"]);
  assertEquals(toStringList("facebook,,instagram,"), ["facebook", "instagram"]);
});

Deno.test("toStringList turns a single value into a one-item list", () => {
  assertEquals(toStringList("facebook"), ["facebook"]);
  assertEquals(toStringList("  facebook  "), ["facebook"]);
});

Deno.test("toStringList turns empty text into an empty list", () => {
  assertEquals(toStringList(""), []);
  assertEquals(toStringList("   "), []);
});

Deno.test("toStringList leaves values that are not text unchanged", () => {
  assertEquals(toStringList(undefined), undefined);
  assertEquals(toStringList(null), null);
  assertEquals(toStringList(7), 7);
});

Deno.test("normalizeListFields converts only the known list fields", () => {
  const args: Record<string, unknown> = {
    caption: "hello world",
    platforms: "facebook, instagram",
    account_ids: '["acc-1"]',
    media_file_ids: ["media-1"],
    media_urls: "https://example.com/a.png, https://example.com/b.png",
    youtube_tags: "tag",
  };

  const normalized = normalizeListFields(args);

  assertEquals(normalized.platforms, ["facebook", "instagram"]);
  assertEquals(normalized.account_ids, ["acc-1"]);
  assertEquals(normalized.media_file_ids, ["media-1"]);
  assertEquals(normalized.media_urls, [
    "https://example.com/a.png",
    "https://example.com/b.png",
  ]);
  assertEquals(normalized.youtube_tags, ["tag"]);

  // Non-list fields are untouched, missing keys are not added, and the
  // original arguments are not mutated.
  assertEquals(normalized.caption, "hello world");
  assertEquals("instagram_user_tags" in normalized, false);
  assertEquals("scheduled_at" in normalized, false);
  assertEquals(Object.keys(normalized).sort(), Object.keys(args).sort());
  assertEquals(args.platforms, "facebook, instagram");
});

Deno.test("normalizeListFields keeps a comma inside a media URL", () => {
  const normalized = normalizeListFields({
    media_urls: "https://host/image/c_fill,w_300/a.jpg",
  });

  assertEquals(normalized.media_urls, [
    "https://host/image/c_fill,w_300/a.jpg",
  ]);
});

Deno.test("normalizeListFields splits media URLs only before the next URL", () => {
  const normalized = normalizeListFields({
    media_urls: "https://a.com/x,y.jpg, https://b.com/z.png",
  });

  assertEquals(normalized.media_urls, [
    "https://a.com/x,y.jpg",
    "https://b.com/z.png",
  ]);
});

Deno.test("normalizeListFields drops empty entries between media URLs", () => {
  const normalized = normalizeListFields({
    media_urls: "https://a.com/a.png,,https://b.com/b.png",
  });

  assertEquals(normalized.media_urls, [
    "https://a.com/a.png",
    "https://b.com/b.png",
  ]);
});

Deno.test("normalizeListFields drops empty entries and trailing commas", () => {
  const normalized = normalizeListFields({
    media_urls: "https://a.com/a.png, , https://b.com/b.png,,",
  });

  assertEquals(normalized.media_urls, [
    "https://a.com/a.png",
    "https://b.com/b.png",
  ]);
});

Deno.test("normalizeListFields splits media URLs regardless of scheme case", () => {
  const normalized = normalizeListFields({
    media_urls: "https://a.com/1.jpg,HTTPS://b.com/2.jpg",
  });

  assertEquals(normalized.media_urls, [
    "https://a.com/1.jpg",
    "HTTPS://b.com/2.jpg",
  ]);
});

Deno.test("normalizeListFields still splits comma-separated platforms", () => {
  const normalized = normalizeListFields({
    platforms: "facebook, instagram",
  });

  assertEquals(normalized.platforms, ["facebook", "instagram"]);
});
