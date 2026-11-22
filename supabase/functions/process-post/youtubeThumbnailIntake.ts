/**
 * Owner-bound admission for the thumbnail a published video will receive.
 *
 * A media id is not a URL: it is resolved through the same authorized media
 * resolver as the video, against the post owner and the post's workspace
 * targets, before anything is signed or downloaded. The pre-existing external
 * HTTPS URL contract stays a separate, explicitly validated path.
 */

import { loadMediaProviderRows, resolveMediaUrl, cdnReadPreferenceOrder } from "./mediaDelivery.ts";
import type { MediaFile } from "./mediaDelivery.ts";
import { isApprovedMediaUrl } from "./youtubeUploadPolicy.ts";
import { mediaSendability } from "../_shared/partnerMediaStore.ts";

export type ThumbnailIntakeResult =
  | { ok: true; url: string; source: "owned_media" | "external_url" }
  | {
      ok: false;
      reason:
        | "not_owned"
        | "unavailable"
        | "origin_not_approved"
        /** The owner-bound read failed. Distinct from an absent or refused row. */
        | "read_error"
        /** The named file is not an image and cannot be a YouTube thumbnail. */
        | "not_image";
    };

/** A read failure is kept apart from "there is no such owned row". */
export type OwnedThumbnailLookup =
  | { ok: true; row: MediaFile | null }
  | { ok: false; reason: "read_error" };

export interface YoutubeThumbnailIntakePorts {
  supabase: Parameters<typeof loadMediaProviderRows>[0];
  loadOwnedMedia(id: string, ownerId: string): Promise<OwnedThumbnailLookup>;
  allowedWorkspaceIds: ReadonlySet<string>;
  mediaHosts: Set<string>;
}

export function isExternalThumbnailUrl(value: unknown): value is string {
  return typeof value === "string" && /^https:\/\//i.test(value);
}

export function thumbnailSourceOf(metadata: object | null | undefined):
  | { kind: "owned"; id: string }
  | { kind: "external"; url: string }
  | null {
  const values = (metadata ?? {}) as Record<string, unknown>;
  const id = values.youtube_thumbnail_media_id;
  if (typeof id === "string" && id.length > 0) return { kind: "owned", id };
  const url = values.youtube_thumbnail_url;
  if (isExternalThumbnailUrl(url)) return { kind: "external", url };
  return null;
}

/** Only a real image row may be signed and fetched for thumbnails.set. */
export function isImageMedia(row: MediaFile): boolean {
  if (row.file_type === "image") return true;
  const mime = typeof row.mime_type === "string" ? row.mime_type.toLowerCase() : "";
  return mime.startsWith("image/") && !mime.includes("svg");
}

export async function resolveYoutubeThumbnail(
  ports: YoutubeThumbnailIntakePorts,
  ownerId: string,
  metadata: object | null | undefined,
): Promise<ThumbnailIntakeResult> {
  const source = thumbnailSourceOf(metadata);
  if (!source) return { ok: false, reason: "unavailable" };

  if (source.kind === "external") {
    if (!isApprovedMediaUrl(source.url, ports.mediaHosts)) {
      return { ok: false, reason: "origin_not_approved" };
    }
    return { ok: true, url: source.url, source: "external_url" };
  }

  const lookup = await ports.loadOwnedMedia(source.id, ownerId);
  if (!lookup.ok) return { ok: false, reason: "read_error" };
  const row = lookup.row;
  if (!row || row.user_id !== ownerId) return { ok: false, reason: "not_owned" };

  // The shared sendability rule and the image-type check both run BEFORE any
  // provider row is read and before any signature is made. A blocked fixture
  // therefore produces no signing call and no fetch.
  const sendability = mediaSendability({ scanState: (row as { scan_state?: string | null }).scan_state ?? "available" });
  if (!sendability.ok) return { ok: false, reason: "unavailable" };
  if (!isImageMedia(row)) return { ok: false, reason: "not_image" };

  const providerRows = await loadMediaProviderRows(ports.supabase, [row]);
  const preferenceOrder = await cdnReadPreferenceOrder(ports.supabase);
  try {
    const url = await resolveMediaUrl(ports.supabase, row, providerRows, {
      preferenceOrder,
      ownerUserId: ownerId,
      allowedWorkspaceIds: ports.allowedWorkspaceIds,
      approvedHosts: ports.mediaHosts,
    });
    return url ? { ok: true, url, source: "owned_media" } : { ok: false, reason: "unavailable" };
  } catch {
    // A crafted row or an unreadable provider is refused without leaking its
    // path or signed URL into any error the caller can surface.
    return { ok: false, reason: "not_owned" };
  }
}
