/**
 * Library side of video processing: find where a user's video lives, name the derived object,
 * and record it the way an Openinary upload is recorded (media_files row with
 * `storage_bucket: "openinary"` plus a ready media_file_providers row).
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { referenceObjectPath } from "./mediaDeletePlan.ts";
import { isMediaQuotaMessage, mediaQuotaHumanMessage } from "./mediaQuotaError.ts";
import type { OpeninaryConfig } from "./openinary.ts";
import { type Dimensions, OpeninaryVideoError, parseDimensions } from "./openinaryVideoTransform.ts";

export interface VideoMediaRow {
  id: string;
  user_id: string;
  file_path: string | null;
  file_type: string | null;
  file_size: number | null;
  storage_bucket: string | null;
  cloudinary_public_id: string | null;
  platforms: string[] | null;
  social_account_ids: string[] | null;
  metadata: Record<string, unknown> | null;
}

export interface ProviderRow {
  provider: string;
  object_key: string;
  status: string;
  delivery_url: string | null;
  object_version: number | null;
}

export type VideoSource =
  | { kind: "openinary"; path: string }
  | { kind: "cloudinary"; publicId: string; deliveryUrl: string | null };

/** A daily-quota refusal raised by the media_files insert trigger. */
export class MediaQuotaRefusal extends Error {
  constructor(raw: string) {
    super(mediaQuotaHumanMessage(raw));
    this.name = "MediaQuotaRefusal";
  }
}

const ROW_COLUMNS = "id, user_id, file_path, file_type, file_size, storage_bucket, cloudinary_public_id, platforms, social_account_ids, metadata";

/** Owner-scoped: someone else's row and a missing row look the same. */
export async function loadOwnedVideo(db: SupabaseClient, mediaFileId: string, userId: string): Promise<{ row: VideoMediaRow; providers: ProviderRow[] }> {
  const { data: row, error } = await db.from("media_files").select(ROW_COLUMNS).eq("id", mediaFileId).eq("user_id", userId).maybeSingle();
  if (error || !row) throw new OpeninaryVideoError("MEDIA_NOT_FOUND", "Media file not found.");
  if (row.file_type !== "video") throw new OpeninaryVideoError("INVALID_REQUEST", "Only video files can be processed.");
  const { data: providers } = await db
    .from("media_file_providers")
    .select("provider, object_key, status, delivery_url, object_version")
    .eq("media_file_id", mediaFileId);
  return { row: row as VideoMediaRow, providers: (providers ?? []) as ProviderRow[] };
}

/** Storage paths come from rows a user can write: never let one climb out of `/t/`. */
export function isSafeObjectPath(path: string): boolean {
  if (!path || path.length > 1024) return false;
  return path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== ".." && !/[\\\0\r\n]/.test(segment));
}

/** `URL` collapses `..` itself, so dot segments must be looked for in the stored text. */
function hasDotSegments(reference: string): boolean {
  return reference.split(/[?#]/)[0].split("/").some((segment) => /^(\.|%2e){1,2}$/i.test(segment));
}

/**
 * Where to read the original from. Openinary first (provider row, else the path of an
 * Openinary delivery URL); Cloudinary only when that is all the row has.
 */
export function resolveVideoSource(row: VideoMediaRow, providers: ProviderRow[], config: OpeninaryConfig | null): VideoSource {
  if (config) {
    const ready = providers
      .filter((p) => p.provider === "openinary" && p.status === "ready" && p.object_key)
      .sort((a, b) => (b.object_version ?? 0) - (a.object_version ?? 0))[0];
    if (ready) {
      const path = ready.object_key.replace(/^\/+/, "");
      if (isSafeObjectPath(path)) return { kind: "openinary", path };
    }
    if (row.file_path && row.file_path.startsWith(`${config.serverUrl}/t/`) && !hasDotSegments(row.file_path)) {
      const path = referenceObjectPath(row.file_path);
      if (isSafeObjectPath(path)) return { kind: "openinary", path };
    }
  }
  if (row.cloudinary_public_id) {
    const url = row.file_path && /^https:\/\/res\.cloudinary\.com\//.test(row.file_path) ? row.file_path : null;
    return { kind: "cloudinary", publicId: row.cloudinary_public_id, deliveryUrl: url };
  }
  if (!config) throw new OpeninaryVideoError("PROVIDER_UNAVAILABLE", "Video storage is temporarily unavailable. Try again shortly.");
  throw new OpeninaryVideoError("SOURCE_NOT_AVAILABLE", "This video is not stored in a library that supports processing. Upload it again and retry.");
}

/** Dimensions recorded on the row win over a caller's claim. */
export function knownDimensions(row: VideoMediaRow, claimed: unknown): Dimensions | null {
  const meta = row.metadata ?? {};
  return parseDimensions(meta) ?? parseDimensions(meta.video_dimensions) ?? parseDimensions(claimed);
}

export interface StoredVideoMetadata { width: number; height: number; duration?: number; format?: string }

/** What the library already knows about a video. Openinary has no probe endpoint to ask. */
export function storedVideoMetadata(row: VideoMediaRow): StoredVideoMetadata | null {
  const dimensions = knownDimensions(row, null);
  if (!dimensions) return null;
  const meta = row.metadata ?? {};
  return {
    ...dimensions,
    ...(typeof meta.duration === "number" ? { duration: meta.duration } : {}),
    ...(typeof meta.format === "string" ? { format: meta.format } : {}),
  };
}

export function derivedObjectTarget(sourcePath: string, label: string, now = Date.now(), randomId: () => string = () => crypto.randomUUID().replaceAll("-", "").slice(0, 12)): { folder: string; fileName: string } {
  const slash = sourcePath.lastIndexOf("/");
  return {
    folder: slash > 0 ? sourcePath.slice(0, slash) : "",
    fileName: `postora_${label}_${Math.floor(now / 1000)}_${randomId()}.mp4`,
  };
}

export interface StoredVideo {
  provider: "openinary" | "cloudinary";
  /** Openinary path or Cloudinary public id. */
  objectKey: string;
  url: string;
  bytes: number | null;
}

export interface RecordDerivedParams {
  userId: string;
  original: VideoMediaRow;
  stored: StoredVideo;
  metadata: Record<string, unknown>;
  /** Removes the stored object again when the library refuses the row. */
  discardStored: () => Promise<void>;
}

/**
 * Insert the library row and its provider row. When the row is refused the stored object is
 * removed again (a quota refusal is the expected case), so no orphan is left behind.
 */
export async function recordDerivedVideo(adminDb: SupabaseClient, params: RecordDerivedParams): Promise<{ id: string }> {
  const { stored, original } = params;
  const { data: row, error } = await adminDb
    .from("media_files")
    .insert({
      user_id: params.userId,
      file_path: stored.url,
      file_type: "video",
      file_size: stored.bytes,
      mime_type: "video/mp4",
      storage_bucket: stored.provider,
      cloudinary_public_id: stored.provider === "cloudinary" ? stored.objectKey : null,
      platforms: original.platforms ?? [],
      social_account_ids: original.social_account_ids ?? [],
      upload_date: new Date().toISOString().slice(0, 10),
      metadata: { kind: "video", format: "mp4", ...params.metadata },
    })
    .select("id")
    .single();

  if (error || !row) {
    try { await params.discardStored(); } catch { console.error("[derived-video] cleanup after refused insert failed"); }
    if (isMediaQuotaMessage(error?.message)) throw new MediaQuotaRefusal(error?.message ?? "");
    console.error("[derived-video] media_files insert failed:", error?.message);
    throw new OpeninaryVideoError("STORE_FAILED", "Could not save the processed video to your library.");
  }

  // The library row already points at a stored object, so a lost bookkeeping row is
  // logged rather than turned into a failure the user would retry (same as media-direct-upload).
  const { error: providerError } = await adminDb.from("media_file_providers").insert({
    media_file_id: row.id,
    provider: stored.provider,
    object_version: 1,
    object_key: stored.objectKey,
    status: "ready",
    delivery_url: stored.url,
    bytes: stored.bytes,
    mime_type: "video/mp4",
  });
  if (providerError) console.error("[derived-video] media_file_providers insert failed:", providerError.message);
  return { id: row.id as string };
}
