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

export type ThumbnailIntakeResult =
  | { ok: true; url: string; source: "owned_media" | "external_url" }
  | { ok: false; reason: "not_owned" | "unavailable" | "origin_not_approved" };

export interface YoutubeThumbnailIntakePorts {
  supabase: Parameters<typeof loadMediaProviderRows>[0];
  loadOwnedMedia(id: string, ownerId: string): Promise<MediaFile | null>;
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

  const row = await ports.loadOwnedMedia(source.id, ownerId);
  if (!row || row.user_id !== ownerId) return { ok: false, reason: "not_owned" };
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
