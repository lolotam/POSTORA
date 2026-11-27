export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

interface NormalizedCue {
  startSeconds: number;
  startMs: number;
  endMs: number;
  text: string;
}

const OUTLINE_INITIAL_WINDOW_SEC = 30;
const OUTLINE_MAX_WINDOW_SEC = 600;
const OUTLINE_INITIAL_LINE_LIMIT = 160;
const OUTLINE_MIN_LINE_LIMIT = 24;
const OUTLINE_DEFAULT_MAX_CHARS = 8000;

function sanitizeCueText(rawText: string): string {
  return rawText
    .replace(/\0/g, "")
    .replace(/-->/g, "→")
    .replace(/[\r\n\t ]+/g, " ")
    .trim();
}

function sanitizeVttCueText(rawText: string): string {
  const cleaned = sanitizeCueText(rawText);
  if (cleaned.length === 0) return "";
  return cleaned
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function sanitizeOutlineText(rawText: string): string {
  return rawText
    .replace(/[\0<>]/g, "")
    .replace(/[\r\n\t ]+/g, " ")
    .trim();
}

function normalizeCues(
  segments: TranscriptSegment[],
  textSanitizer: (rawText: string) => string,
): NormalizedCue[] {
  if (!Array.isArray(segments) || segments.length === 0) return [];

  const valid: Array<{ start: number; end: number; text: string }> = [];
  for (const segment of segments) {
    if (!segment || typeof segment !== "object") continue;
    const { start, end, text } = segment;
    if (
      typeof start !== "number" ||
      typeof end !== "number" ||
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      start < 0 ||
      start >= end ||
      typeof text !== "string"
    ) {
      continue;
    }
    const cleaned = textSanitizer(text);
    if (cleaned.length === 0) continue;
    valid.push({ start, end, text: cleaned });
  }

  if (valid.length === 0) return [];

  valid.sort((a, b) => a.start - b.start || a.end - b.end);

  const cues: NormalizedCue[] = [];
  let prevStartMs = 0;

  for (const item of valid) {
    const rawStartMs = Math.max(0, Math.round(item.start * 1000));
    const startMs = Math.max(prevStartMs, rawStartMs);
    const rawEndMs = Math.round(item.end * 1000);
    const endMs = Math.max(startMs + 1, rawEndMs);

    cues.push({
      startSeconds: item.start,
      startMs,
      endMs,
      text: item.text,
    });
    prevStartMs = startMs;
  }

  return cues;
}

function formatCaptionTimestamp(ms: number, separator: "," | "."): string {
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1000);
  const millis = ms % 1000;

  const hh = String(hours).padStart(2, "0");
  const mm = String(minutes).padStart(2, "0");
  const ss = String(seconds).padStart(2, "0");
  const mmm = String(millis).padStart(3, "0");

  return `${hh}:${mm}:${ss}${separator}${mmm}`;
}

export function segmentsToSrt(segments: TranscriptSegment[]): string {
  const cues = normalizeCues(segments, sanitizeCueText);
  if (cues.length === 0) return "";

  return cues
    .map((cue, index) => {
      const start = formatCaptionTimestamp(cue.startMs, ",");
      const end = formatCaptionTimestamp(cue.endMs, ",");
      return `${index + 1}\n${start} --> ${end}\n${cue.text}`;
    })
    .join("\n\n");
}

export function segmentsToVtt(segments: TranscriptSegment[]): string {
  const cues = normalizeCues(segments, sanitizeVttCueText);
  if (cues.length === 0) return "";

  const body = cues
    .map((cue) => {
      const start = formatCaptionTimestamp(cue.startMs, ".");
      const end = formatCaptionTimestamp(cue.endMs, ".");
      return `${start} --> ${end}\n${cue.text}`;
    })
    .join("\n\n");

  return `WEBVTT\n\n${body}`;
}

function formatOutlineTimestamp(seconds: number, includeHours: boolean): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = seconds % 60;
  if (includeHours) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`;
  }
  return `${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`;
}

function truncateAtWordBoundary(text: string, maxLen: number): string {
  if (maxLen <= 0) return "";
  if (text.length <= maxLen) return text;
  const slice = text.slice(0, maxLen);
  if (text[maxLen] === " ") return slice.trimEnd();
  const lastSpace = slice.lastIndexOf(" ");
  if (lastSpace > 0) return slice.slice(0, lastSpace).trimEnd();
  return slice.trimEnd();
}

interface OutlineWindow {
  startSeconds: number;
  text: string;
}

function buildOutlineWindows(
  cues: NormalizedCue[],
  windowSec: number,
  perLineLimit: number,
): OutlineWindow[] {
  const rawWindows: Array<{ startSeconds: number; parts: string[] }> = [];

  for (const cue of cues) {
    const flooredStart = Math.max(0, Math.floor(cue.startSeconds));
    if (rawWindows.length === 0) {
      rawWindows.push({ startSeconds: 0, parts: [cue.text] });
      continue;
    }

    const current = rawWindows[rawWindows.length - 1];
    if (flooredStart - current.startSeconds >= windowSec && flooredStart > current.startSeconds) {
      rawWindows.push({ startSeconds: flooredStart, parts: [cue.text] });
    } else {
      current.parts.push(cue.text);
    }
  }

  return rawWindows
    .map((win) => ({
      startSeconds: win.startSeconds,
      text: truncateAtWordBoundary(win.parts.join(" "), perLineLimit),
    }))
    .filter((win) => win.text.length > 0);
}

function formatOutlineWindows(windows: OutlineWindow[]): string {
  if (windows.length === 0) return "";
  const includeHours = windows.some((win) => win.startSeconds >= 3600);
  return windows
    .map((win) => `${formatOutlineTimestamp(win.startSeconds, includeHours)} ${win.text}`)
    .join("\n");
}

export function segmentsToTimedOutline(
  segments: TranscriptSegment[],
  maxChars = OUTLINE_DEFAULT_MAX_CHARS,
): string {
  if (typeof maxChars !== "number" || !Number.isFinite(maxChars) || maxChars <= 0) {
    return "";
  }
  const hardCap = Math.floor(maxChars);
  if (hardCap <= 0) return "";

  const cues = normalizeCues(segments, sanitizeOutlineText);
  if (cues.length === 0) return "";

  let windowSec = OUTLINE_INITIAL_WINDOW_SEC;
  let perLineLimit = OUTLINE_INITIAL_LINE_LIMIT;
  let windows = buildOutlineWindows(cues, windowSec, perLineLimit);
  let outline = formatOutlineWindows(windows);

  while (outline.length > hardCap && windowSec < OUTLINE_MAX_WINDOW_SEC) {
    windowSec = Math.min(OUTLINE_MAX_WINDOW_SEC, windowSec * 2);
    windows = buildOutlineWindows(cues, windowSec, perLineLimit);
    outline = formatOutlineWindows(windows);
  }

  while (outline.length > hardCap && perLineLimit > OUTLINE_MIN_LINE_LIMIT) {
    perLineLimit = Math.max(OUTLINE_MIN_LINE_LIMIT, Math.floor(perLineLimit / 2));
    windows = buildOutlineWindows(cues, windowSec, perLineLimit);
    outline = formatOutlineWindows(windows);
  }

  if (outline.length <= hardCap) {
    return outline;
  }

  const kept: OutlineWindow[] = [];
  for (const win of windows) {
    const candidate = formatOutlineWindows([...kept, win]);
    if (candidate.length <= hardCap) {
      kept.push(win);
    } else {
      break;
    }
  }

  if (kept.length > 0) {
    return formatOutlineWindows(kept);
  }

  const firstLine = formatOutlineWindows([windows[0]]);
  return firstLine.slice(0, hardCap).trimEnd();
}
