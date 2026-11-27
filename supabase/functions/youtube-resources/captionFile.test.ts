import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  CAPTION_CONTENT_MAX_BYTES,
  CAPTION_NAME_MAX_LENGTH,
  measureUtf8Bytes,
  validateCaptionUploadInput,
} from "./captionFile.ts";

const VALID_SRT = [
  "1",
  "00:00:01,000 --> 00:00:03,500",
  "مرحبا بكم في هذا الفيديو",
  "",
  "2",
  "00:00:04,000 --> 00:00:06,250",
  "Second cue line",
].join("\n");

const VALID_VTT = [
  "WEBVTT - Sample track",
  "",
  "NOTE comment block",
  "",
  "cue-1",
  "00:01.000 --> 00:03.500 align:start",
  "مرحبا بكم",
  "",
  "00:00:04.000 --> 00:00:06.250",
  "Second cue",
].join("\n");

Deno.test("validateCaptionUploadInput accepts valid SRT and VTT with Arabic text, BOM, and CRLF", () => {
  const srtWithBomAndCrlf = `\uFEFF${VALID_SRT.replace(/\n/g, "\r\n")}`;
  const srtResult = validateCaptionUploadInput({
    language: "ar",
    name: "Arabic",
    format: "srt",
    content: srtWithBomAndCrlf,
  });
  assertEquals(srtResult, {
    ok: true,
    byteLength: measureUtf8Bytes(srtWithBomAndCrlf),
    cueCount: 2,
  });

  const vttResult = validateCaptionUploadInput({
    language: "en-US",
    name: "",
    format: "vtt",
    content: VALID_VTT,
  });
  assertEquals(vttResult, {
    ok: true,
    byteLength: measureUtf8Bytes(VALID_VTT),
    cueCount: 2,
  });
});

Deno.test("validateCaptionUploadInput rejects invalid metadata, NUL bytes, and malformed SRT/VTT", () => {
  const badInputs = [
    { language: "invalid_lang", name: "En", format: "srt" as const, content: VALID_SRT },
    { language: "en", name: "a".repeat(CAPTION_NAME_MAX_LENGTH + 1), format: "srt" as const, content: VALID_SRT },
    { language: "en", name: "Line\nBreak", format: "srt" as const, content: VALID_SRT },
    { language: "en", name: "Null\0Name", format: "srt" as const, content: VALID_SRT },
    { language: "en", name: "En", format: "srt" as const, content: `${VALID_SRT}\0` },
    { language: "en", name: "En", format: "srt" as const, content: "" },
    { language: "en", name: "En", format: "srt" as const, content: "1\n00:00:65,000 --> 00:01:00,000\nBad minute" },
    { language: "en", name: "En", format: "srt" as const, content: "1\n00:00:05,000 --> 00:00:05,000\nZero length" },
    {
      language: "en",
      name: "En",
      format: "srt" as const,
      content: "1\n00:00:05,000 --> 00:00:06,000\nFirst\n\n2\n00:00:04,000 --> 00:00:07,000\nBackwards",
    },
    { language: "en", name: "En", format: "vtt" as const, content: "00:01.000 --> 00:02.000\nMissing WEBVTT" },
    { language: "en", name: "En", format: "vtt" as const, content: "WEBVTT\n\nNOTE only" },
  ];

  for (const item of badInputs) {
    assertEquals(validateCaptionUploadInput(item), { ok: false, reason: "caption_invalid" });
  }
});

Deno.test("validateCaptionUploadInput enforces exact UTF-8 byte boundary for Arabic text", () => {
  const prefix = "1\n00:00:01,000 --> 00:00:02,000\n";
  const prefixBytes = measureUtf8Bytes(prefix);
  const remainingBytes = CAPTION_CONTENT_MAX_BYTES - prefixBytes;
  // "م" is 2 UTF-8 bytes; pad with 1 ASCII "a" when remainingBytes is odd.
  const arabicPairs = Math.floor(remainingBytes / 2);
  const oddPad = remainingBytes % 2 === 1 ? "a" : "";
  const exactLimitContent = `${prefix}${"م".repeat(arabicPairs)}${oddPad}`;

  assertEquals(measureUtf8Bytes(exactLimitContent), CAPTION_CONTENT_MAX_BYTES);
  assertEquals(
    validateCaptionUploadInput({
      language: "ar",
      name: "Arabic exact",
      format: "srt",
      content: exactLimitContent,
    }),
    { ok: true, byteLength: CAPTION_CONTENT_MAX_BYTES, cueCount: 1 },
  );

  const oneByteOver = `${exactLimitContent}a`;
  assertEquals(measureUtf8Bytes(oneByteOver), CAPTION_CONTENT_MAX_BYTES + 1);
  assertEquals(
    validateCaptionUploadInput({
      language: "ar",
      name: "Arabic over",
      format: "srt",
      content: oneByteOver,
    }),
    { ok: false, reason: "caption_invalid" },
  );

  // ~300,000 Arabic characters (~600,000 UTF-8 bytes) is under a 512K char cap but over 512 KiB.
  const largeArabic = `${prefix}${"م".repeat(300_000)}`;
  assertEquals(
    validateCaptionUploadInput({
      language: "ar",
      name: "Arabic 300k chars",
      format: "srt",
      content: largeArabic,
    }),
    { ok: false, reason: "caption_invalid" },
  );
});
