/**
 * Per-account media rules for scheduled WhatsApp messages (PR C plan).
 *
 * "Type" means the extension-level allow-list in mediaTypes.ts; codec
 * compatibility is not validated here — an incompatible codec surfaces as a
 * recorded send failure from the provider.
 */

import { MEDIA_TYPES } from "./mediaTypes";

export type ScheduledMediaType = "image" | "video" | "document" | "audio";

/** WhatsApp Cloud API size ceilings (image 5 MB; the 10 MiB storage cap keeps the rest unreachable). */
export const CLOUD_SIZE_LIMITS_MB: Record<ScheduledMediaType, number> = {
  image: 5,
  video: 16,
  audio: 16,
  document: 100,
};

/** Extensions Meta sends natively even on QR accounts; everything else goes as a document. */
const QR_NATIVE: Record<"image" | "video" | "audio", ReadonlySet<string>> = {
  image: new Set(["jpg", "jpeg", "png", "gif", "webp"]),
  video: new Set(["mp4"]),
  audio: new Set(["mp3", "ogg"]),
};

export function cloudAccount(connectionMode: string | null | undefined): boolean {
  return connectionMode === "cloud_api" || connectionMode === "coexistence";
}

/**
 * Message type a stored file maps to for the given account kind, or null when
 * a Cloud account must refuse the extension. On QR accounts every extension
 * (or none) is sendable — unknown ones become documents.
 */
export function scheduledMessageType(extension: string, cloud: boolean): ScheduledMediaType | null {
  if (cloud) {
    const entry = extension ? MEDIA_TYPES[extension] : undefined;
    if (!entry?.whatsappCloud) return null;
    return entry.kind === "archive" ? "document" : entry.kind;
  }
  if (QR_NATIVE.image.has(extension)) return "image";
  if (QR_NATIVE.video.has(extension)) return "video";
  if (QR_NATIVE.audio.has(extension)) return "audio";
  return "document";
}

export function exceedsCloudSizeLimit(type: ScheduledMediaType, bytes: number | null | undefined): boolean {
  if (bytes == null) return false;
  return bytes > CLOUD_SIZE_LIMITS_MB[type] * 1024 * 1024;
}
