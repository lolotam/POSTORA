/**
 * Direct thumbnail MIME and magic-byte verification for `youtube-resources`.
 *
 * Choice recorded for PR-11 Step 1: owner-scoped media lookup and direct
 * thumbnail validation are implemented locally in `youtube-resources` rather
 * than moving `process-post/youtubeThumbnailIntake.ts` to `_shared/`, because
 * `youtubeThumbnailIntake.ts` depends on `process-post`-specific `mediaDelivery`
 * / `youtubeUploadPolicy` ports and admits `image/webp` via the media pipeline.
 */

/**
 * The only MIME types accepted when `youtube-resources` sends stored bytes
 * directly to Google's `thumbnails.set` upload endpoint (which only lists JPEG
 * and PNG). Contrast with `process-post/youtubeThumbnailIntake.ts`
 * `THUMBNAIL_RASTER_MIMES`, which also admits `image/webp` because upload-time
 * intake can deliver through the media pipeline.
 */
export const DIRECT_THUMBNAIL_MIMES = ["image/jpeg", "image/png"] as const;

export type DirectThumbnailMime = (typeof DIRECT_THUMBNAIL_MIMES)[number];

/** YouTube's 2 MiB maximum thumbnail file size. */
export const THUMBNAIL_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Storage buckets holding owner-scoped object keys (`<userId>/...`) that
 * `youtube-resources` may read directly with the service role.
 * CDN buckets (`cloudinary`, `openinary`) and `partner-media` are excluded here:
 * user-writable `media_files` rows must never allow the service role to read
 * another tenant's storage prefix or an arbitrary bucket.
 */
export const DIRECT_THUMBNAIL_STORAGE_BUCKETS = ["media", "supabase"] as const;

const ALLOWED_STORAGE_BUCKET_SET = new Set<string>(DIRECT_THUMBNAIL_STORAGE_BUCKETS);

/**
 * Verifies that a storage bucket is an allowed Postora user-storage bucket and
 * that `filePath` is strictly inside `<ownerUserId>/` with no path traversal
 * (`..`, `.`, empty segments, backslashes, encoded separators, or control chars).
 */
export function isAdmissibleThumbnailStorageLocation(
  storageBucket: unknown,
  filePath: unknown,
  ownerUserId: string,
): boolean {
  if (typeof storageBucket !== "string" || !ALLOWED_STORAGE_BUCKET_SET.has(storageBucket)) {
    return false;
  }
  if (typeof filePath !== "string" || typeof ownerUserId !== "string" || ownerUserId.length === 0) {
    return false;
  }
  if (filePath.startsWith("https://") || filePath.startsWith("http://")) {
    return false;
  }
  if (!filePath.startsWith(`${ownerUserId}/`)) {
    return false;
  }
  if (/[\\]|%2e|%2f|%5c/i.test(filePath)) {
    return false;
  }
  for (let index = 0; index < filePath.length; index++) {
    if (filePath.charCodeAt(index) < 0x20) return false;
  }
  return filePath.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

function normalizeDirectThumbnailMime(value: unknown): DirectThumbnailMime | null {
  if (typeof value !== "string") return null;
  const normalized = value.toLowerCase().split(";")[0].trim();
  return normalized === "image/jpeg" || normalized === "image/png" ? normalized : null;
}

/**
 * Returns true when `value` (after case folding and stripping `;...`
 * parameters) is one of `DIRECT_THUMBNAIL_MIMES` (`image/jpeg` or `image/png`).
 */
export function isDirectThumbnailMime(value: unknown): value is DirectThumbnailMime {
  return normalizeDirectThumbnailMime(value) !== null;
}

/**
 * Inspects the leading magic bytes of `bytes` to identify JPEG or PNG.
 * Returns `null` for empty, truncated, WebP (`RIFF....WEBP`), or any other payload.
 */
export function sniffThumbnailType(bytes: Uint8Array): DirectThumbnailMime | null {
  if (bytes.byteLength >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.byteLength >= PNG_SIGNATURE.length &&
    PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)
  ) {
    return "image/png";
  }
  return null;
}

/**
 * Verifies that `bytes` is non-empty, within `THUMBNAIL_MAX_BYTES`, has an
 * allowed `declaredMime`, and has magic bytes matching that declared MIME.
 */
export function verifyDirectThumbnailBytes(
  bytes: Uint8Array,
  declaredMime: unknown,
): { ok: true; mimeType: DirectThumbnailMime } | { ok: false; reason: "media_not_usable" } {
  if (bytes.byteLength === 0 || bytes.byteLength > THUMBNAIL_MAX_BYTES) {
    return { ok: false, reason: "media_not_usable" };
  }
  const normalized = normalizeDirectThumbnailMime(declaredMime);
  if (normalized === null) {
    return { ok: false, reason: "media_not_usable" };
  }
  const sniffed = sniffThumbnailType(bytes);
  if (sniffed !== normalized) {
    return { ok: false, reason: "media_not_usable" };
  }
  return { ok: true, mimeType: sniffed };
}
