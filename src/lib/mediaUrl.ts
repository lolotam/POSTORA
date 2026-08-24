/**
 * Resolve the public URL for a stored media-file row.
 *
 * Why this exists: when editing a scheduled post, the previous code rebuilt the
 * Cloudinary URL from `storage_bucket` + `cloudinary_public_id`. That produced
 * broken links because `storage_bucket` holds the literal string "cloudinary"
 * (NOT a cloud name) and `cloudinary_public_id` lacks the version segment and
 * file extension. The complete, correct URL is already stored in `file_path`
 * (Cloudinary's `secure_url`), so we return it verbatim.
 */

import { buildOpeninaryTransform, isOpeninaryUrl } from "./openinary";

/** Minimal view of a `media_files` row needed to resolve a URL. */
export interface MediaFileUrlRow {
  file_path: string | null | undefined;
  storage_bucket?: string | null | undefined;
  cloudinary_public_id?: string | null | undefined;
  current_object_version?: number | null | undefined;
}
export interface MediaProviderRow { object_version?: number | null; provider: string; status: string; delivery_url?: string | null }
export interface MediaUrlConfig { read_preference?: string; primaryCdn?: string; openinary?: { serverUrl?: string } }

/** CDN providers Postora can write to and read from. */
export type CdnProvider = "cloudinary" | "openinary" | "supabase";

/**
 * Shape of the `cdn_storage` app setting. Lives here rather than in a separate
 * module so the config that selects a provider and the resolver that consumes
 * it cannot drift apart.
 *
 * Declared as a type alias, not an interface: this value is written straight
 * into a `jsonb` column, and only an alias carries the implicit index signature
 * that makes it assignable to the generated `Json` type.
 */
export type CdnConfig = {
  read_preference?: CdnProvider;
  primaryCdn?: CdnProvider;
  cloudinary?: { cloudName?: string; enabled?: boolean };
  openinary?: { serverUrl?: string; folderPrefix?: string; enabled?: boolean };
};

/**
 * Delivery-time image transform. Deliberately narrower than the full
 * Cloudinary/Openinary grammars — these are the directives both CDNs express
 * identically, so one option object can drive either URL shape.
 */
export interface MediaTransformOptions {
  width?: number;
  height?: number;
  crop?: "fill" | "fit" | "thumb" | "limit";
  format?: "auto";
  quality?: string | number;
  gravity?: string;
}

/** An Openinary path segment is a transform if it is a `key_value` list. */
const OPENINARY_TRANSFORM_SEGMENT = /^[a-z]+_[^/,]+(?:,[a-z]+_[^/,]+)*$/;
/** Only `image/upload` is rewritten — see `transformMediaUrl`. */
const CLOUDINARY_IMAGE_UPLOAD = /^(https?:\/\/res\.cloudinary\.com\/[^/]+\/image\/upload)\/(.+)$/i;
const OPENINARY_DELIVERY_MARKER = "/t/";

/**
 * Rewrite an already-resolved delivery URL to request a smaller rendition.
 *
 * Handles the two URL grammars Postora delivers through:
 *  - Openinary: `https://host/t/<transforms>/<key>` — the transform segment is
 *    replaced, not appended, so repeated calls stay idempotent.
 *  - Cloudinary: `https://res.cloudinary.com/<cloud>/image/upload/<rest>` — the
 *    transform is inserted after `/upload/`, which chains ahead of any existing
 *    one.
 *
 * Every other URL — Supabase Storage objects, foreign CDNs, `video/upload`
 * renditions — is returned unchanged. Transcoding a video to serve a still is
 * far more expensive than sending the poster frame the browser already fetches,
 * and Supabase Storage object URLs have no transform grammar at all.
 *
 * `openinaryOrigin` must be the configured Openinary server URL. Without it the
 * Openinary branch is skipped entirely: `/t/` is a plausible path on any host,
 * so matching it unanchored would rewrite a foreign CDN's URL into a 404. Only
 * the Cloudinary branch is safe to detect from the URL alone, because it is
 * anchored to the `res.cloudinary.com` origin.
 */
export function transformMediaUrl(url: string, transform?: MediaTransformOptions, openinaryOrigin?: string): string {
  if (!url || !transform) return url;
  // Openinary deliberately mirrors Cloudinary's directive syntax, so one builder
  // produces the segment for both grammars.
  const segment = buildOpeninaryTransform(transform);
  if (!segment) return url;

  if (openinaryOrigin && isOpeninaryUrl(url, openinaryOrigin)) {
    const marker = url.indexOf(OPENINARY_DELIVERY_MARKER);
    const origin = url.slice(0, marker);
    const rest = url.slice(marker + OPENINARY_DELIVERY_MARKER.length);
    const slash = rest.indexOf("/");
    const firstSegment = slash === -1 ? rest : rest.slice(0, slash);
    // Drop an existing transform segment rather than stacking onto it, so
    // transforming an already-transformed URL stays idempotent.
    const hasTransform = slash !== -1 && OPENINARY_TRANSFORM_SEGMENT.test(firstSegment);
    const objectKey = hasTransform ? rest.slice(slash + 1) : rest;
    return `${origin}${OPENINARY_DELIVERY_MARKER}${segment}/${objectKey}`;
  }

  const cloudinary = url.match(CLOUDINARY_IMAGE_UPLOAD);
  if (cloudinary) {
    const [, base, rest] = cloudinary;
    return `${base}/${segment}/${rest}`;
  }

  return url;
}

/**
 * Square thumbnail rendition of an already-resolved URL.
 *
 * `c_fill` over `c_thumb` because the grid crops with `object-cover` anyway and
 * `c_thumb` implies face detection the media library has no use for.
 */
export function getMediaThumbnailUrl(url: string, size: number, openinaryOrigin?: string): string {
  return transformMediaUrl(url, { width: size, crop: "fill", format: "auto", quality: "auto" }, openinaryOrigin);
}

/**
 * Function that turns a Supabase-Storage object path into a public URL.
 * Injected so this module stays pure and testable (no Supabase import required).
 */
export type StorageUrlResolver = (bucket: string, path: string) => string;

/**
 * Resolve a media-file row to its public URL.
 *
 * Rules, in order:
 *  1. Cloudinary rows (`storage_bucket === "cloudinary"` or the path is a
 *     `res.cloudinary.com` URL): return `file_path` verbatim — it already is
 *     the full `secure_url` (cloud name + version + extension).
 *  2. Any other full HTTP(S) URL: return it verbatim (other CDNs, legacy URLs).
 *  3. Supabase-Storage object paths: resolve via the injected resolver, using
 *     `storage_bucket` (or "media" as a fallback default).
 *
 * `transform`, when given, requests a smaller rendition of whichever URL the
 * rules above selected. Callers that already hold a resolved URL should use
 * `transformMediaUrl` / `getMediaThumbnailUrl` directly instead.
 *
 * @returns the resolved public URL, or the raw `file_path` (possibly null) when
 *          no better option is available — callers should null-check.
 *
 * Five parameters exceeds the four-argument ceiling this project's review guard
 * applies. Kept positional deliberately: the first four are load-bearing at
 * three existing call sites, and collapsing them into an options object would
 * be a breaking signature change for a resolver whose contract is covered by
 * regression tests from the 2026-06-20 broken-media-link incident.
 */
export function resolveMediaPublicUrl(
  row: MediaFileUrlRow,
  storageResolver?: StorageUrlResolver,
  providerRows?: MediaProviderRow[],
  config?: MediaUrlConfig,
  transform?: MediaTransformOptions,
): string {
  return transformMediaUrl(resolveBaseUrl(row, storageResolver, providerRows, config), transform, config?.openinary?.serverUrl);
}

/** Provider selection only — `resolveMediaPublicUrl` layers the transform on top. */
function resolveBaseUrl(
  row: MediaFileUrlRow,
  storageResolver?: StorageUrlResolver,
  providerRows?: MediaProviderRow[],
  config?: MediaUrlConfig,
): string {
  const filePath = row?.file_path;

  if (providerRows) {
    // Default both sides to 1 (the column's DB default) so a caller that forgot to
    // SELECT `current_object_version` still matches version-1 rows. Comparing against
    // a raw `undefined` would silently find nothing and fall through to the legacy
    // branch — which looks like it works and serves the wrong URL after a rename or
    // an authoritative delete.
    const currentVersion = row?.current_object_version ?? 1;
    const current = providerRows.filter((candidate) => (candidate.object_version ?? 1) === currentVersion);
    if (current.length > 0) {
      const preferred = config?.read_preference ?? config?.primaryCdn;
      const selected = current.find((candidate) => candidate.provider === preferred && candidate.status === "ready" && candidate.delivery_url)
        ?? current.find((candidate) => candidate.status === "ready" && candidate.delivery_url);
      return selected?.delivery_url ?? "";
    }
  }

  // 1. Cloudinary — file_path IS the complete secure_url.
  const isCloudinary =
    row?.storage_bucket === "cloudinary" ||
    (typeof filePath === "string" && filePath.includes("res.cloudinary.com"));
  if (isCloudinary && typeof filePath === "string") {
    return filePath;
  }

  // 2. Any other full URL.
  if (typeof filePath === "string" && /^https?:\/\//i.test(filePath)) {
    return filePath;
  }

  // 3. Supabase-Storage object path.
  const bucket = row?.storage_bucket || "media";
  if (typeof filePath === "string" && storageResolver) {
    return storageResolver(bucket, filePath);
  }

  // Nothing better available — surface the raw value for the caller to handle.
  return filePath ?? "";
}
