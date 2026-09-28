const MAX_DISPLAY_LENGTH = 120;

function stripControls(value: string): string {
  let cleaned = "";
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code > 31 && code !== 127) cleaned += char;
  }
  return cleaned;
}

function basename(path: string): string {
  const leaf = path.split(/[/\\]/).pop() ?? "";
  try {
    return decodeURIComponent(leaf);
  } catch {
    return leaf;
  }
}

/** Strip control characters and path segments before a file name is shown. */
export function sanitizeDisplayFileName(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = stripControls(basename(raw)).replace(/\s+/g, " ").trim();
  if (!cleaned || cleaned === "." || cleaned === "..") return null;
  return cleaned.slice(0, MAX_DISPLAY_LENGTH);
}

function fileNameFromUrl(mediaUrl: string | null | undefined): string | null {
  if (!mediaUrl) return null;
  try {
    return basename(new URL(mediaUrl).pathname);
  } catch {
    const withoutQuery = mediaUrl.split("?")[0] ?? "";
    return basename(withoutQuery);
  }
}

/** Prefer the stored file name, then the URL leaf. Both go through the display sanitiser. */
export function displayMediaName(
  mediaFilename: string | null | undefined,
  mediaUrl: string | null | undefined,
): string | null {
  return sanitizeDisplayFileName(mediaFilename) ?? sanitizeDisplayFileName(fileNameFromUrl(mediaUrl));
}
