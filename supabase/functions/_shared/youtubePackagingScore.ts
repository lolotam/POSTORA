export interface PackagingScore {
  overall_score: number; // integer 0..100, computed, never taken from the model
  breakdown: {
    hook: number;
    clarity: number;
    mobile_length: number;
    thumbnail_synergy: number | null;
  };
  strengths: string[]; // 0..3, each 1..140 characters
  fixes: string[]; // 0..3, each 1..140 characters
  better_titles: [string, string, string];
}

export type PackagingValidationFailureReason =
  | "bad_shape"
  | "bad_score"
  | "bad_title"
  | "bad_text";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isScoreInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 100;
}

function stripControlCharacters(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 31 || (code >= 127 && code <= 159)) {
      continue;
    }
    out += value[i];
  }
  return out;
}

function validateShortTextItems(items: unknown[]): string[] | null {
  if (items.length > 3) return null;
  const result: string[] = [];
  for (const item of items) {
    if (typeof item !== "string") return null;
    const cleaned = stripControlCharacters(item).trim();
    if (cleaned.length < 1 || cleaned.length > 140 || cleaned.includes("<") || cleaned.includes(">")) {
      return null;
    }
    result.push(cleaned);
  }
  return result;
}

export function scoreMobileLength(title: string): number {
  const trimmed = title.trim();
  if (trimmed.length === 0) return 0;
  if (trimmed.length <= 60) return 100;
  if (trimmed.length >= 100) return 0;
  return Math.round(((100 - trimmed.length) * 100) / 40);
}

export function validatePackagingModelOutput(
  raw: unknown,
  input: { title: string; hasThumbnailText: boolean },
):
  | { ok: true; value: PackagingScore }
  | { ok: false; reason: PackagingValidationFailureReason } {
  if (!isPlainObject(raw)) {
    return { ok: false, reason: "bad_shape" };
  }

  let breakdownSource: Record<string, unknown> = raw;
  if (raw.breakdown !== undefined) {
    if (!isPlainObject(raw.breakdown)) {
      return { ok: false, reason: "bad_shape" };
    }
    breakdownSource = raw.breakdown;
  }

  if (
    !Array.isArray(raw.strengths) ||
    !Array.isArray(raw.fixes) ||
    !Array.isArray(raw.better_titles)
  ) {
    return { ok: false, reason: "bad_shape" };
  }

  const hook = breakdownSource.hook !== undefined ? breakdownSource.hook : raw.hook;
  const clarity = breakdownSource.clarity !== undefined ? breakdownSource.clarity : raw.clarity;
  const rawSynergy =
    breakdownSource.thumbnail_synergy !== undefined
      ? breakdownSource.thumbnail_synergy
      : raw.thumbnail_synergy;

  if (!isScoreInteger(hook) || !isScoreInteger(clarity)) {
    return { ok: false, reason: "bad_score" };
  }

  let thumbnail_synergy: number | null = null;
  if (input.hasThumbnailText) {
    if (!isScoreInteger(rawSynergy)) {
      return { ok: false, reason: "bad_score" };
    }
    thumbnail_synergy = rawSynergy;
  }

  const strengths = validateShortTextItems(raw.strengths);
  const fixes = validateShortTextItems(raw.fixes);
  if (!strengths || !fixes) {
    return { ok: false, reason: "bad_text" };
  }

  if (raw.better_titles.length !== 3) {
    return { ok: false, reason: "bad_title" };
  }

  const inputTitleNorm = input.title.trim().toLowerCase();
  const inputTitleCleanedNorm = stripControlCharacters(input.title).trim().toLowerCase();
  const seenTitles = new Set<string>();
  const betterTitles: string[] = [];

  for (const item of raw.better_titles) {
    if (typeof item !== "string") {
      return { ok: false, reason: "bad_title" };
    }
    if (
      item.includes("\r") ||
      item.includes("\n") ||
      item.includes("\u2028") ||
      item.includes("\u2029") ||
      item.includes("<") ||
      item.includes(">")
    ) {
      return { ok: false, reason: "bad_title" };
    }
    const cleaned = stripControlCharacters(item).trim();
    if (cleaned.length < 1 || cleaned.length > 100 || cleaned.includes("<") || cleaned.includes(">")) {
      return { ok: false, reason: "bad_title" };
    }
    const normalized = cleaned.toLowerCase();
    if (
      normalized === inputTitleNorm ||
      normalized === inputTitleCleanedNorm ||
      seenTitles.has(normalized)
    ) {
      return { ok: false, reason: "bad_title" };
    }
    seenTitles.add(normalized);
    betterTitles.push(cleaned);
  }

  const mobile_length = scoreMobileLength(input.title);
  const overall_score =
    thumbnail_synergy !== null
      ? Math.round((hook * 35 + clarity * 30 + mobile_length * 15 + thumbnail_synergy * 20) / 100)
      : Math.round((hook * 35 + clarity * 30 + mobile_length * 15) / 80);

  return {
    ok: true,
    value: {
      overall_score,
      breakdown: {
        hook,
        clarity,
        mobile_length,
        thumbnail_synergy,
      },
      strengths,
      fixes,
      better_titles: [betterTitles[0], betterTitles[1], betterTitles[2]],
    },
  };
}
