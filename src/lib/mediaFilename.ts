/**
 * One filename policy shared by the browser (ScheduleMessageDialog) and the
 * whatsapp-scheduled-sender edge function. supabase/functions/_shared/
 * mediaFilename.ts must stay byte-identical — a Deno test reads both files.
 *
 * The customer must see the original name (invoice.pdf, not postora_2026…)
 * and that name must never smuggle path separators or control/bidi
 * characters into the provider call or the database (CHECK <= 240 chars).
 */

/** C0/C1 control characters (including NUL, CR, LF) and the bidi override and isolate characters. */
// eslint-disable-next-line no-control-regex -- stripping control characters is the whole point of this pattern
const UNSAFE_CHARS = /[\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/g;

/** Matches the whatsapp_scheduled_messages.media_filename CHECK. */
const MAX_LENGTH = 240;

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function sanitizeMediaFilename(raw: string): string {
  const trimmed = (raw ?? "").trim();
  let path = trimmed;
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      path = new URL(trimmed).pathname;
    } catch {
      path = trimmed.split("?")[0].split("#")[0];
    }
  }
  // Basename before and after the single decode, so an encoded separator
  // ("a%2Fb.txt") can never survive as a path character in the result.
  let base = path.split(/[/\\]/).filter(Boolean).pop() ?? "";
  base = safeDecode(base).split(/[/\\]/).filter(Boolean).pop() ?? "";
  const cleaned = base.replace(UNSAFE_CHARS, "").trim();
  if (!cleaned || cleaned === "." || cleaned === "..") return "file";
  const chars = Array.from(cleaned);
  if (chars.length <= MAX_LENGTH) return cleaned;
  const dot = cleaned.lastIndexOf(".");
  const extension = dot > 0 && dot < cleaned.length - 1 ? Array.from(cleaned.slice(dot)) : [];
  if (extension.length >= MAX_LENGTH) return chars.slice(0, MAX_LENGTH).join("");
  return chars.slice(0, MAX_LENGTH - extension.length).join("") + extension.join("");
}
