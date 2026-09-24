export function archiveBody(
  job: { id: string; provider: string; modality: string },
  snap: { outputUrl: string | null; outputBase64?: string | null },
): Record<string, string> {
  const source: Record<string, string> = snap.outputBase64 ? { fileData: snap.outputBase64 } : { externalUrl: snap.outputUrl ?? "" };
  return { ...source, fileName: `${job.provider}-${job.id}.${job.modality === "video" ? "mp4" : "png"}`, fileType: job.modality };
}
