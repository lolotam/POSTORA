const EXTENSION_BY_MEDIA_TYPE: Record<string, string> = {
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

/** The extension for the provider's media type; an unknown or absent type keeps the modality default. */
function fileExtension(modality: string, mediaType: string | null | undefined): string {
  const essence = mediaType?.split(";")[0].trim().toLowerCase() ?? "";
  return EXTENSION_BY_MEDIA_TYPE[essence] ?? (modality === "video" ? "mp4" : "png");
}

export function archiveBody(
  job: { id: string; provider: string; modality: string },
  snap: { outputUrl: string | null; outputBase64?: string | null; outputMediaType?: string | null },
): Record<string, string> {
  const source: Record<string, string> = snap.outputBase64 ? { fileData: snap.outputBase64 } : { externalUrl: snap.outputUrl ?? "" };
  const ext = fileExtension(job.modality, snap.outputMediaType);
  return { ...source, fileName: `${job.provider}-${job.id}.${ext}`, fileType: job.modality };
}
