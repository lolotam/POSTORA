import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { validateCaptionUploadInput } from "../youtube-resources/captionFile.ts";
import {
  extractInputTimestamps,
  parseChapterLines,
  validateChapters,
} from "./youtubeChapters.ts";
import {
  segmentsToSrt,
  segmentsToTimedOutline,
  segmentsToVtt,
  type TranscriptSegment,
} from "./youtubeTranscriptFormats.ts";

Deno.test("segmentsToSrt and segmentsToVtt return empty string on empty or invalid input", () => {
  assertEquals(segmentsToSrt([]), "");
  assertEquals(segmentsToVtt([]), "");
  assertEquals(
    segmentsToSrt([
      { start: -1, end: 2, text: "negative start" },
      { start: 3, end: 3, text: "zero length" },
      { start: 5, end: 4, text: "reversed" },
      { start: 1, end: 2, text: "   \0  " },
    ]),
    "",
  );
  assertEquals(
    segmentsToVtt([
      { start: NaN, end: 2, text: "nan" },
      { start: 0, end: Infinity, text: "inf" },
    ]),
    "",
  );
});

Deno.test("segmentsToSrt orders cues, rolls over hours, and strips NUL and arrow tokens", () => {
  const segments: TranscriptSegment[] = [
    { start: 3661.25, end: 3665.5, text: "Later cue --> with arrow\nand newline" },
    { start: 0, end: 2.05, text: "First\0 cue\r\nline two" },
  ];

  const srt = segmentsToSrt(segments);
  assertEquals(
    srt,
    [
      "1",
      "00:00:00,000 --> 00:00:02,050",
      "First cue line two",
      "",
      "2",
      "01:01:01,250 --> 01:01:05,500",
      "Later cue → with arrow and newline",
    ].join("\n"),
  );
  assert(!srt.includes("\r"));
  assert(!srt.includes("\0"));
});

Deno.test("segmentsToVtt formats WEBVTT cues with hour rollover and sanitized text", () => {
  const segments: TranscriptSegment[] = [
    { start: 1.5, end: 4.75, text: "Intro --> welcome\0" },
    { start: 7200, end: 7205.125, text: "Two hours in" },
  ];

  const vtt = segmentsToVtt(segments);
  assertEquals(
    vtt,
    [
      "WEBVTT",
      "",
      "00:00:01.500 --> 00:00:04.750",
      "Intro → welcome",
      "",
      "02:00:00.000 --> 02:00:05.125",
      "Two hours in",
    ].join("\n"),
  );
});

Deno.test("segmentsToSrt and segmentsToVtt round-trip through validateCaptionUploadInput for English and Arabic", () => {
  const englishSegments: TranscriptSegment[] = [
    { start: 0, end: 3.2, text: "Welcome to our deep dive on YouTube publishing." },
    { start: 3.2, end: 8.45, text: "Next --> we cover chapters, captions, and playlists." },
    { start: 3600, end: 3604.1, text: "One hour wrap-up and summary." },
  ];

  const srtEn = segmentsToSrt(englishSegments);
  const vttEn = segmentsToVtt(englishSegments);

  const srtEnCheck = validateCaptionUploadInput({
    language: "en",
    name: "English",
    format: "srt",
    content: srtEn,
  });
  const vttEnCheck = validateCaptionUploadInput({
    language: "en",
    name: "English",
    format: "vtt",
    content: vttEn,
  });

  assert(srtEnCheck.ok);
  assertEquals(srtEnCheck.cueCount, 3);
  assert(vttEnCheck.ok);
  assertEquals(vttEnCheck.cueCount, 3);

  const arabicSegments: TranscriptSegment[] = [
    { start: 0.4, end: 4.0, text: "مرحباً بكم في شرح ميزات يوتيوب الجديدة." },
    { start: 4.0, end: 9.5, text: "سنتحدث اليوم عن الفصول والترجمة التلقائية --> بالتفصيل." },
  ];

  const srtAr = segmentsToSrt(arabicSegments);
  const vttAr = segmentsToVtt(arabicSegments);

  const srtArCheck = validateCaptionUploadInput({
    language: "ar",
    name: "العربية",
    format: "srt",
    content: srtAr,
  });
  const vttArCheck = validateCaptionUploadInput({
    language: "ar",
    name: "العربية",
    format: "vtt",
    content: vttAr,
  });

  assert(srtArCheck.ok);
  assertEquals(srtArCheck.cueCount, 2);
  assert(vttArCheck.ok);
  assertEquals(vttArCheck.cueCount, 2);
});

Deno.test("segmentsToTimedOutline always starts at 00:00 and strips angle brackets", () => {
  const segments: TranscriptSegment[] = [
    { start: 2.8, end: 6.0, text: "Opening <script> remarks & welcome" },
    { start: 12.1, end: 18.0, text: "Still in the first thirty-second window" },
    { start: 35.4, end: 42.0, text: "Main product walkthrough starts here" },
    { start: 75.9, end: 82.0, text: "Closing summary and next steps" },
  ];

  const outline = segmentsToTimedOutline(segments);
  const lines = outline.split("\n");
  assertEquals(lines.length, 3);
  assert(lines[0].startsWith("00:00 "));
  assert(!outline.includes("<"));
  assert(!outline.includes(">"));
  assertEquals(
    lines,
    [
      "00:00 Opening script remarks & welcome Still in the first thirty-second window",
      "00:35 Main product walkthrough starts here",
      "01:15 Closing summary and next steps",
    ],
  );
});

Deno.test("segmentsToTimedOutline fits a 3-hour continuous speech fixture within 8000 characters", () => {
  const threeHoursSegments: TranscriptSegment[] = [];
  for (let i = 0; i < 3600; i += 1) {
    const start = i * 3;
    threeHoursSegments.push({
      start,
      end: start + 2.8,
      text: `Segment ${i + 1} explains workflow configuration, timing verification, and creator publishing controls in detail.`,
    });
  }

  const outline = segmentsToTimedOutline(threeHoursSegments);
  assert(outline.length > 0);
  assert(outline.length <= 8000, `Expected outline <= 8000 chars, got ${outline.length}`);
  assert(outline.startsWith("0:00:00 "));
});

Deno.test("segmentsToTimedOutline respects small custom maxChars hard cap and non-positive maxChars", () => {
  const segments: TranscriptSegment[] = [
    { start: 1, end: 5, text: "First segment with several words to test truncation behavior." },
    { start: 40, end: 45, text: "Second window segment text." },
    { start: 90, end: 95, text: "Third window segment text." },
  ];

  assertEquals(segmentsToTimedOutline(segments, 0), "");
  assertEquals(segmentsToTimedOutline(segments, -10), "");
  assertEquals(segmentsToTimedOutline([], 8000), "");

  const capped = segmentsToTimedOutline(segments, 40);
  assert(capped.length > 0);
  assert(capped.length <= 40);
  assert(capped.startsWith("00:00"));
});

Deno.test("chapters drawn from segmentsToTimedOutline pass parseChapterLines, timestamp subset check, and validateChapters", () => {
  const segments: TranscriptSegment[] = [
    { start: 1.9, end: 10.0, text: "Welcome and overview of the release" },
    { start: 42.3, end: 55.0, text: "Configuring connected channel permissions" },
    { start: 95.8, end: 110.0, text: "Reviewing analytics and final checklist" },
  ];

  const outline = segmentsToTimedOutline(segments);
  const inputTimestamps = extractInputTimestamps(outline);
  assert(inputTimestamps.has(0));
  assert(inputTimestamps.has(42));
  assert(inputTimestamps.has(95));

  const parsedFromOutline = parseChapterLines(outline);
  assert(parsedFromOutline);
  assertEquals(
    parsedFromOutline.every((ch) => inputTimestamps.has(ch.startSeconds)),
    true,
  );
  assertEquals(validateChapters(parsedFromOutline, 150), { ok: true });
});
