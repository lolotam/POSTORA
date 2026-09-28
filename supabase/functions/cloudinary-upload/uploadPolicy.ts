import {
  MEDIA_DECODED_BYTE_CAP,
  MEDIA_JSON_BODY_BYTE_CAP,
  MEDIA_TYPES,
  dedupeEligible,
  extensionOfName,
  isExcludedExtension,
  mediaTypeForMime,
  originalBasename,
  type MediaKind,
  type MediaTypeEntry,
} from "../_shared/mediaTypes.ts";
import { extensionForBytes, extensionForContentType } from "../_shared/openinary.ts";

export { MEDIA_DECODED_BYTE_CAP, MEDIA_JSON_BODY_BYTE_CAP };

const ACCEPTED_FILE_TYPES = new Set(["image", "video", "gif", "raw", "document", "audio"]);

export function isAdvertisedBodyTooLarge(contentLength: string | null, maxBytes = MEDIA_JSON_BODY_BYTE_CAP): boolean {
  const advertised = Number(contentLength || "");
  return Number.isFinite(advertised) && advertised > maxBytes;
}

export class BodyTooLargeError extends Error {
  constructor() {
    super("Upload body exceeds the 14 MB limit");
    this.name = "BodyTooLargeError";
  }
}

export interface ResolvedUpload {
  ext: string;
  entry: MediaTypeEntry;
  originalFilename: string;
}

export type UploadResolution =
  | { ok: true; upload: ResolvedUpload }
  | { ok: false; error: string; extension: string };

/** Read the JSON body, aborting once the byte cap is passed and before JSON.parse. */
export async function readJsonBodyCapped(req: Request, maxBytes = MEDIA_JSON_BODY_BYTE_CAP): Promise<unknown> {
  const reader = req.body?.getReader();
  if (!reader) {
    const text = await req.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes) throw new BodyTooLargeError();
    return JSON.parse(text);
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value?.byteLength) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      try { await reader.cancel(); } catch { /* the cap already failed the request */ }
      throw new BodyTooLargeError();
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(merged));
}

export function estimateBase64DecodedBytes(fileData: string): number {
  const payload = fileData.includes(",") ? fileData.split(",")[1] : fileData;
  const cleaned = payload.replace(/\s/g, "");
  const padding = cleaned.endsWith("==") ? 2 : cleaned.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((cleaned.length * 3) / 4) - padding);
}

export function isAcceptedFileType(fileType: string): boolean {
  return ACCEPTED_FILE_TYPES.has(fileType);
}

function legacyExtension(fileType: string): string | null {
  if (fileType === "gif") return "gif";
  if (fileType === "video") return "mp4";
  if (fileType === "image") return "jpg";
  return null;
}

function entryForExtension(extension: string): MediaTypeEntry | null {
  if (!extension || isExcludedExtension(extension)) return null;
  return MEDIA_TYPES[extension] ?? null;
}

/**
 * Classify an upload. An explicit extension wins. A missing extension is
 * resolved from sniffed bytes, then the content type, then the legacy
 * image/gif/video fallback so extensionless callers keep working.
 */
export function resolveUpload(input: {
  fileName: string;
  fileType: string;
  bytes?: Uint8Array | null;
  contentType?: string | null;
}): UploadResolution {
  const originalFilename = originalBasename(input.fileName);
  const explicit = extensionOfName(originalFilename);
  if (explicit) {
    if (isExcludedExtension(explicit) || !MEDIA_TYPES[explicit]) {
      return { ok: false, extension: explicit, error: `This file type is not allowed (.${explicit})` };
    }
    return { ok: true, upload: { ext: explicit, entry: MEDIA_TYPES[explicit], originalFilename } };
  }

  const sniffed = input.bytes ? extensionForBytes(input.bytes) : null;
  const fromBytes = sniffed ? entryForExtension(sniffed) : null;
  if (fromBytes && sniffed) {
    return { ok: true, upload: { ext: sniffed, entry: fromBytes, originalFilename } };
  }

  const fromHeader = extensionForContentType(input.contentType ?? null);
  const headerEntry = fromHeader ? entryForExtension(fromHeader) : null;
  if (headerEntry && fromHeader) {
    return { ok: true, upload: { ext: fromHeader, entry: headerEntry, originalFilename } };
  }

  const fromMime = mediaTypeForMime(input.contentType);
  if (fromMime) {
    return { ok: true, upload: { ext: fromMime.ext, entry: fromMime.entry, originalFilename } };
  }

  const fallback = legacyExtension(input.fileType);
  const fallbackEntry = fallback ? MEDIA_TYPES[fallback] : null;
  if (fallback && fallbackEntry) {
    return { ok: true, upload: { ext: fallback, entry: fallbackEntry, originalFilename } };
  }

  return { ok: false, extension: "", error: "This file type is not allowed" };
}

export function limitProvidersForKind(kind: MediaKind, attempted: string[], required: string[]): { attempted: string[]; required: string[] } {
  if (kind === "image" || kind === "video") {
    return { attempted: [...attempted], required: [...required] };
  }
  return {
    attempted: attempted.filter((provider) => provider === "openinary"),
    required: required.filter((provider) => provider === "openinary"),
  };
}

export function matchingDuplicateId(
  kind: MediaKind,
  size: number | null,
  candidates: { id: string; file_size: number | null }[],
): string | null {
  if (!dedupeEligible(kind) || size === null) return null;
  return candidates.find((candidate) => candidate.file_size === size)?.id ?? null;
}
