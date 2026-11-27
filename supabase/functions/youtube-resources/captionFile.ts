export const CAPTION_CONTENT_MAX_BYTES = 512 * 1024;
export const CAPTION_LANGUAGE_PATTERN = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,2}$/;
export const CAPTION_NAME_MAX_LENGTH = 150;

export type CaptionFormat = "srt" | "vtt";

export type CaptionValidationResult =
  | { ok: true; byteLength: number; cueCount: number }
  | { ok: false; reason: "caption_invalid" };

const UTF8_ENCODER = new TextEncoder();

const SRT_TIMING_RE = /^(\d{2,}):(\d{2}):(\d{2}),(\d{3}) --> (\d{2,}):(\d{2}):(\d{2}),(\d{3})$/;
const VTT_TIMING_RE =
  /^(?:(\d{2,}):)?(\d{2}):(\d{2})\.(\d{3}) --> (?:(\d{2,}):)?(\d{2}):(\d{2})\.(\d{3})(?:[ \t].*)?$/;
const VTT_HEADER_RE = /^WEBVTT(?:[ \t].*)?$/;

/** Measures exact UTF-8 byte length without logging or copying the content. */
export function measureUtf8Bytes(content: string): number {
  return UTF8_ENCODER.encode(content).byteLength;
}

function toMs(hoursRaw: string | undefined, minutesRaw: string, secondsRaw: string, msRaw: string): number | null {
  const hours = hoursRaw !== undefined ? Number(hoursRaw) : 0;
  const minutes = Number(minutesRaw);
  const seconds = Number(secondsRaw);
  const ms = Number(msRaw);
  if (
    !Number.isInteger(hours) ||
    !Number.isInteger(minutes) ||
    !Number.isInteger(seconds) ||
    !Number.isInteger(ms) ||
    minutes >= 60 ||
    seconds >= 60 ||
    ms >= 1000
  ) {
    return null;
  }
  return ((hours * 60 + minutes) * 60 + seconds) * 1000 + ms;
}

function parseSrtBlocks(normalized: string): number | null {
  const trimmed = normalized.replace(/^\n+|\n+$/g, "");
  if (trimmed.length === 0) return null;
  const blocks = trimmed.split(/\n(?:[ \t]*\n)+/);
  let prevStartMs = -1;
  let cueCount = 0;

  for (const block of blocks) {
    const lines = block.split("\n");
    if (lines.length < 3) return null;
    if (!/^[1-9]\d*$/.test(lines[0].trim())) return null;

    const timingMatch = SRT_TIMING_RE.exec(lines[1].trim());
    if (!timingMatch) return null;

    const startMs = toMs(timingMatch[1], timingMatch[2], timingMatch[3], timingMatch[4]);
    const endMs = toMs(timingMatch[5], timingMatch[6], timingMatch[7], timingMatch[8]);
    if (startMs === null || endMs === null || endMs <= startMs || startMs < prevStartMs) {
      return null;
    }

    const hasText = lines.slice(2).some((line) => line.trim().length > 0);
    if (!hasText) return null;

    prevStartMs = startMs;
    cueCount += 1;
  }

  return cueCount >= 1 ? cueCount : null;
}

function isVttNonCueBlock(firstLine: string): boolean {
  return (
    firstLine === "NOTE" ||
    firstLine.startsWith("NOTE ") ||
    firstLine.startsWith("NOTE\t") ||
    firstLine === "STYLE" ||
    firstLine.startsWith("STYLE ") ||
    firstLine.startsWith("STYLE\t") ||
    firstLine === "REGION" ||
    firstLine.startsWith("REGION ") ||
    firstLine.startsWith("REGION\t")
  );
}

function parseVttBlocks(normalized: string): number | null {
  const trimmedEnd = normalized.replace(/\n+$/g, "");
  const blocks = trimmedEnd.split(/\n(?:[ \t]*\n)+/);
  if (blocks.length < 2) return null;

  const headerLines = blocks[0].split("\n");
  if (!VTT_HEADER_RE.test(headerLines[0])) return null;

  let prevStartMs = -1;
  let cueCount = 0;

  for (let i = 1; i < blocks.length; i += 1) {
    const block = blocks[i];
    if (block.trim().length === 0) continue;

    const lines = block.split("\n");
    const firstTrimmed = lines[0].trim();
    if (isVttNonCueBlock(firstTrimmed)) continue;

    let timingIndex = 0;
    if (!lines[0].includes("-->")) {
      if (lines.length < 3) return null;
      timingIndex = 1;
    } else if (lines.length < 2) {
      return null;
    }

    const timingMatch = VTT_TIMING_RE.exec(lines[timingIndex].trim());
    if (!timingMatch) return null;

    const startMs = toMs(timingMatch[1], timingMatch[2], timingMatch[3], timingMatch[4]);
    const endMs = toMs(timingMatch[5], timingMatch[6], timingMatch[7], timingMatch[8]);
    if (startMs === null || endMs === null || endMs <= startMs || startMs < prevStartMs) {
      return null;
    }

    const hasText = lines.slice(timingIndex + 1).some((line) => line.trim().length > 0);
    if (!hasText) return null;

    prevStartMs = startMs;
    cueCount += 1;
  }

  return cueCount >= 1 ? cueCount : null;
}

/**
 * Validates caption upload metadata and SRT/VTT content using exact UTF-8 byte
 * bounds without logging the caption text.
 */
export function validateCaptionUploadInput(input: {
  language: string;
  name: string;
  format: CaptionFormat;
  content: string;
}): CaptionValidationResult {
  if (typeof input.language !== "string" || !CAPTION_LANGUAGE_PATTERN.test(input.language)) {
    return { ok: false, reason: "caption_invalid" };
  }
  if (
    typeof input.name !== "string" ||
    input.name.length > CAPTION_NAME_MAX_LENGTH ||
    /[\r\n\0]/.test(input.name)
  ) {
    return { ok: false, reason: "caption_invalid" };
  }
  if (input.format !== "srt" && input.format !== "vtt") {
    return { ok: false, reason: "caption_invalid" };
  }
  if (typeof input.content !== "string" || input.content.includes("\0")) {
    return { ok: false, reason: "caption_invalid" };
  }

  const byteLength = measureUtf8Bytes(input.content);
  if (byteLength === 0 || byteLength > CAPTION_CONTENT_MAX_BYTES) {
    return { ok: false, reason: "caption_invalid" };
  }

  const strippedBom = input.content.startsWith("\uFEFF") ? input.content.slice(1) : input.content;
  const normalized = strippedBom.replace(/\r\n?/g, "\n");
  const cueCount = input.format === "srt" ? parseSrtBlocks(normalized) : parseVttBlocks(normalized);
  if (cueCount === null) {
    return { ok: false, reason: "caption_invalid" };
  }

  return { ok: true, byteLength, cueCount };
}
