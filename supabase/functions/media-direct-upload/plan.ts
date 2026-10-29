/**
 * Pure decisions for a browser-direct upload: is this file allowed, how big may
 * it be, and which providers take it. No I/O, so every rule here is unit-tested.
 */

import { directUploadByteCap, formatUploadLimit, type MediaTypeEntry } from "../_shared/mediaTypes.ts";
import { limitProvidersForKind, resolveUpload } from "../cloudinary-upload/uploadPolicy.ts";
import { orderWriteProviders, type CdnPolicy } from "../cloudinary-upload/providerPolicy.ts";

export interface DirectUploadRequest {
  fileName: string;
  size: number;
  mimeType?: string | null;
}

export type DirectUploadPlan =
  | {
    ok: true;
    ext: string;
    entry: MediaTypeEntry;
    originalFilename: string;
    providers: string[];
    required: string[];
  }
  | { ok: false; status: 400 | 413 | 503; error: string; reason: string };

export function planDirectUpload(
  request: DirectUploadRequest,
  policy: CdnPolicy,
  usable: { cloudinary: boolean; openinaryConfigured: boolean },
): DirectUploadPlan {
  const legacyType = request.mimeType?.startsWith("video/") ? "video" : "image";
  const resolved = resolveUpload({ fileName: request.fileName, fileType: legacyType, contentType: request.mimeType });
  if (!resolved.ok) return { ok: false, status: 400, error: resolved.error, reason: "type" };

  const { entry, ext, originalFilename } = resolved.upload;
  const cap = directUploadByteCap(entry.kind);
  if (cap === null) {
    return { ok: false, status: 400, error: "Only images and videos can be uploaded over 10 MB", reason: "kind" };
  }
  if (!Number.isSafeInteger(request.size) || request.size <= 0) {
    return { ok: false, status: 400, error: "Invalid file size", reason: "size" };
  }
  if (request.size > cap) {
    return { ok: false, status: 413, error: `File exceeds the ${formatUploadLimit(cap)} limit`, reason: "kind_cap" };
  }

  const ordered = orderWriteProviders(policy, usable);
  const limited = limitProvidersForKind(entry.kind, ordered, policy.required);
  if (limited.attempted.length === 0) {
    return { ok: false, status: 503, error: "Storage temporarily unavailable", reason: "no_provider" };
  }
  return { ok: true, ext, entry, originalFilename, providers: limited.attempted, required: limited.required };
}

/** Exact Openinary path a presigned upload must have produced. */
export function expectedOpeninaryPath(openinary: { folder: string; fileName: string }): string {
  return `${openinary.folder}/${openinary.fileName}`;
}

/**
 * Cloudinary returns `public_id` with the folder in fixed-folder accounts and
 * without it in dynamic-folder accounts, so only the base name is pinned.
 */
export function cloudinaryPublicIdMatches(returned: string, expectedBaseName: string): boolean {
  return returned === expectedBaseName || returned.endsWith(`/${expectedBaseName}`);
}
