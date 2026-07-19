interface MediaFileReference {
  id: string;
}

export function getMissingMediaFileIds(
  mediaFileIds: string[],
  mediaFiles: MediaFileReference[],
): string[] {
  const availableIds = new Set(mediaFiles.map((file) => file.id));
  return mediaFileIds.filter((mediaFileId) => !availableIds.has(mediaFileId));
}
