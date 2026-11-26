export interface YouTubeChapter {
  startSeconds: number;
  title: string;
}

const TIMESTAMP_AT_LINE_START = /^\s*(\d+):([0-5]\d)(?::([0-5]\d))?(?![:\d])(?:\s+(?:[-–—]\s*)?|\s*[-–—]\s*|\s*$)(.*)$/;
const ZERO_TIMESTAMP_AT_LINE_START = /^\s*(?:0:00|00:00|0:00:00|00:00:00)(?:\s|[-–—]|$)/;
const TIMESTAMP_ANYWHERE = /(^|[^\d:])(\d+):([0-5]\d)(?::([0-5]\d))?(?![\d:])/g;

function timestampSeconds(minutesOrHours: string, minutesOrSeconds: string, seconds?: string): number {
  if (seconds !== undefined) {
    return Number(minutesOrHours) * 3600 + Number(minutesOrSeconds) * 60 + Number(seconds);
  }
  return Number(minutesOrHours) * 60 + Number(minutesOrSeconds);
}

function chapterTextFromJson(text: string): string {
  const cleaned = text.replace(/```(?:json)?\s*/gi, "").replace(/```/g, "").trim();
  if (!cleaned.startsWith("{") && !cleaned.startsWith("[")) return text;
  try {
    const parsed: unknown = JSON.parse(cleaned);
    if (Array.isArray(parsed)) return parsed.filter((item): item is string => typeof item === "string").join("\n");
    if (!parsed || typeof parsed !== "object") return text;
    const record = parsed as Record<string, unknown>;
    for (const key of ["chapters", "suggestions"]) {
      const value = record[key];
      if (typeof value === "string") return value;
      if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string").join("\n");
    }
  } catch {
    return text;
  }
  return text;
}

export function parseChapterLines(text: string): YouTubeChapter[] | null {
  const chapters: YouTubeChapter[] = [];
  for (const line of chapterTextFromJson(text).split(/\r?\n/)) {
    const match = TIMESTAMP_AT_LINE_START.exec(line);
    if (!match) continue;
    chapters.push({
      startSeconds: timestampSeconds(match[1], match[2], match[3]),
      title: match[4].trim(),
    });
  }
  return chapters.length > 0 ? chapters : null;
}

export function extractInputTimestamps(text: string): Set<number> {
  const timestamps = new Set<number>();
  for (const match of text.matchAll(TIMESTAMP_ANYWHERE)) {
    timestamps.add(timestampSeconds(match[2], match[3], match[4]));
  }
  return timestamps;
}

export function validateChapters(chapters: YouTubeChapter[], durationSeconds: number | null): { ok: true } | { ok: false; reason: "too_few" | "first_not_zero" | "not_ascending" | "too_short" | "beyond_duration" | "bad_title" } {
  if (chapters.length < 3) return { ok: false, reason: "too_few" };
  if (chapters[0].startSeconds !== 0) return { ok: false, reason: "first_not_zero" };
  for (let index = 0; index < chapters.length; index += 1) {
    const start = chapters[index].startSeconds;
    if (!Number.isInteger(start) || start < 0 || (index > 0 && start <= chapters[index - 1].startSeconds)) {
      return { ok: false, reason: "not_ascending" };
    }
  }
  for (const chapter of chapters) {
    const title = chapter.title.trim();
    if (title.length < 1 || title.length > 100 || /[\r\n<>]/.test(chapter.title)) {
      return { ok: false, reason: "bad_title" };
    }
  }
  if (durationSeconds !== null && chapters.some((chapter) => chapter.startSeconds >= durationSeconds)) {
    return { ok: false, reason: "beyond_duration" };
  }
  for (let index = 1; index < chapters.length; index += 1) {
    if (chapters[index].startSeconds - chapters[index - 1].startSeconds < 10) {
      return { ok: false, reason: "too_short" };
    }
  }
  if (durationSeconds !== null && durationSeconds - chapters[chapters.length - 1].startSeconds < 10) {
    return { ok: false, reason: "too_short" };
  }
  return { ok: true };
}

function formatTimestamp(seconds: number, includeHours: boolean): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = seconds % 60;
  if (includeHours) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`;
  }
  return `${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`;
}

export function formatChapters(chapters: YouTubeChapter[]): string {
  const includeHours = chapters.some((chapter) => chapter.startSeconds >= 3600);
  return chapters.map((chapter) => `${formatTimestamp(chapter.startSeconds, includeHours)} ${chapter.title.trim()}`).join("\n");
}

export function upsertChaptersBlock(description: string, block: string, maxLength = 5000): { ok: true; value: string } | { ok: false; reason: "too_long" } {
  const lines = description.split(/\r?\n/);
  let value = "";
  let replaced = false;

  for (let start = 0; start < lines.length && !replaced; start += 1) {
    if (!ZERO_TIMESTAMP_AT_LINE_START.test(lines[start])) continue;
    let end = start + 1;
    while (end < lines.length && TIMESTAMP_AT_LINE_START.test(lines[end])) end += 1;
    if (end - start < 3) continue;

    const prefix = lines.slice(0, start).join("\n").trimEnd();
    const suffix = lines.slice(end).join("\n").trimStart();
    value = [prefix, block.trim(), suffix].filter((part) => part.length > 0).join("\n\n");
    replaced = true;
  }

  if (!replaced) {
    value = description.trim().length > 0 ? `${description.trimEnd()}\n\n${block.trim()}` : block.trim();
  }
  return value.length > maxLength ? { ok: false, reason: "too_long" } : { ok: true, value };
}
