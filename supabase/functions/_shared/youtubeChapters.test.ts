import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  extractInputTimestamps,
  formatChapters,
  parseChapterLines,
  upsertChaptersBlock,
  validateChapters,
  type YouTubeChapter,
} from "./youtubeChapters.ts";

const validChapters: YouTubeChapter[] = [
  { startSeconds: 0, title: "Introduction" },
  { startSeconds: 30, title: "Main topic" },
  { startSeconds: 90, title: "Conclusion" },
];

Deno.test("parseChapterLines accepts minute and hour timestamp lines", () => {
  assertEquals(parseChapterLines("00:00 Intro\n00:30 - Details\n1:02:03 Conclusion"), [
    { startSeconds: 0, title: "Intro" },
    { startSeconds: 30, title: "Details" },
    { startSeconds: 3723, title: "Conclusion" },
  ]);
});

Deno.test("parseChapterLines accepts JSON chapters and suggestions shapes", () => {
  assertEquals(parseChapterLines('{"chapters":"00:00 Intro\\n00:30 Middle\\n01:00 End"}'), [
    { startSeconds: 0, title: "Intro" },
    { startSeconds: 30, title: "Middle" },
    { startSeconds: 60, title: "End" },
  ]);
  assertEquals(parseChapterLines('```json\n{"suggestions":["00:00 Intro\\n00:30 Main topic\\n01:00 Conclusion"]}\n```'), [
    { startSeconds: 0, title: "Intro" },
    { startSeconds: 30, title: "Main topic" },
    { startSeconds: 60, title: "Conclusion" },
  ]);
  assertEquals(parseChapterLines('{"suggestions":["00:00 Intro", "00:30 Main topic", "01:00 Conclusion"]}'), [
    { startSeconds: 0, title: "Intro" },
    { startSeconds: 30, title: "Main topic" },
    { startSeconds: 60, title: "Conclusion" },
  ]);
});

Deno.test("parseChapterLines returns null without timestamp lines", () => {
  assertEquals(parseChapterLines("No chapters here"), null);
});

Deno.test("extractInputTimestamps finds all minute and hour values", () => {
  assertEquals([...extractInputTimestamps("00:00 Intro\n0:30 Topic\n1:02:03 End")].sort((a, b) => a - b), [0, 30, 3723]);
});

Deno.test("validateChapters accepts valid chapters with and without a duration", () => {
  assertEquals(validateChapters(validChapters, null), { ok: true });
  assertEquals(validateChapters(validChapters, 100), { ok: true });
});

Deno.test("validateChapters rejects too few chapters", () => {
  assertEquals(validateChapters(validChapters.slice(0, 2), null), { ok: false, reason: "too_few" });
});

Deno.test("validateChapters requires the first chapter at zero", () => {
  assertEquals(validateChapters(validChapters.map((chapter, index) => index === 0 ? { ...chapter, startSeconds: 1 } : chapter), null), { ok: false, reason: "first_not_zero" });
});

Deno.test("validateChapters requires strictly ascending starts", () => {
  assertEquals(validateChapters(validChapters.map((chapter, index) => index === 2 ? { ...chapter, startSeconds: 30 } : chapter), null), { ok: false, reason: "not_ascending" });
  assertEquals(validateChapters(validChapters.map((chapter, index) => index === 2 ? { ...chapter, startSeconds: 20 } : chapter), null), { ok: false, reason: "not_ascending" });
});

Deno.test("validateChapters requires ten seconds between chapters and after the last", () => {
  assertEquals(validateChapters(validChapters.map((chapter, index) => index === 2 ? { ...chapter, startSeconds: 39 } : chapter), null), { ok: false, reason: "too_short" });
  assertEquals(validateChapters(validChapters, 99), { ok: false, reason: "too_short" });
});

Deno.test("validateChapters rejects starts at or beyond the duration", () => {
  assertEquals(validateChapters(validChapters, 90), { ok: false, reason: "beyond_duration" });
  assertEquals(validateChapters(validChapters, 80), { ok: false, reason: "beyond_duration" });
});

Deno.test("validateChapters rejects empty, long, multiline, and markup titles", () => {
  for (const title of [" ", "x".repeat(101), "two\nlines", "<b>bad</b>"]) {
    assertEquals(validateChapters(validChapters.map((chapter, index) => index === 1 ? { ...chapter, title } : chapter), null), { ok: false, reason: "bad_title" });
  }
});

Deno.test("formatChapters uses MM:SS below one hour", () => {
  assertEquals(formatChapters(validChapters), "00:00 Introduction\n00:30 Main topic\n01:30 Conclusion");
});

Deno.test("formatChapters uses H:MM:SS for the whole block at one hour", () => {
  assertEquals(formatChapters([...validChapters, { startSeconds: 3723, title: "Later" }]), "0:00:00 Introduction\n0:00:30 Main topic\n0:01:30 Conclusion\n1:02:03 Later");
});

Deno.test("upsertChaptersBlock appends after a blank line", () => {
  assertEquals(upsertChaptersBlock("Description", "00:00 One\n00:10 Two\n00:20 Three"), {
    ok: true,
    value: "Description\n\n00:00 One\n00:10 Two\n00:20 Three",
  });
  assertEquals(upsertChaptersBlock("", "00:00 One\n00:10 Two\n00:20 Three"), {
    ok: true,
    value: "00:00 One\n00:10 Two\n00:20 Three",
  });
});

Deno.test("upsertChaptersBlock replaces an existing block and preserves surrounding text", () => {
  const description = "Before\n\n00:00 Old one\n00:10 Old two\n00:20 Old three\n\nAfter";
  assertEquals(upsertChaptersBlock(description, "00:00 New one\n00:15 New two\n00:30 New three"), {
    ok: true,
    value: "Before\n\n00:00 New one\n00:15 New two\n00:30 New three\n\nAfter",
  });
});

Deno.test("upsertChaptersBlock supports hour and zero-padded existing blocks", () => {
  const description = "Intro\n0:00:00 Old one\n0:00:10 Old two\n0:00:20 Old three\nOutro";
  const result = upsertChaptersBlock(description, "00:00 New one\n00:10 New two\n00:20 New three");
  assert(result.ok);
  assertEquals(result.value, "Intro\n\n00:00 New one\n00:10 New two\n00:20 New three\n\nOutro");
});

Deno.test("upsertChaptersBlock refuses to exceed the description limit", () => {
  assertEquals(upsertChaptersBlock("x".repeat(4990), "00:00 One\n00:10 Two\n00:20 Three"), { ok: false, reason: "too_long" });
});

Deno.test("Arabic chapter titles parse, validate, format, and insert", () => {
  const block = "00:00 المقدمة\n00:30 الموضوع الرئيسي\n01:00 الخاتمة";
  const chapters = parseChapterLines(block);
  assert(chapters);
  assertEquals(validateChapters(chapters, 90), { ok: true });
  assertEquals(formatChapters(chapters), block);
  assertEquals(upsertChaptersBlock("وصف الفيديو", block), { ok: true, value: `وصف الفيديو\n\n${block}` });
});
