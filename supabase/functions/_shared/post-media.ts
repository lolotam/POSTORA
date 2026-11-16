interface MediaFileReference {
  id: string;
}

/** An IN query returns rows in database order, not the post's chosen order. */
export function orderPostMediaFiles<T extends MediaFileReference>(
  mediaFileIds: readonly string[],
  mediaFiles: readonly T[],
): T[] {
  const byId = new Map(mediaFiles.map(file => [file.id, file]));
  return mediaFileIds.flatMap(id => {
    const file = byId.get(id);
    return file ? [file] : [];
  });
}

export function getMissingMediaFileIds(
  mediaFileIds: string[],
  mediaFiles: MediaFileReference[],
): string[] {
  const availableIds = new Set(mediaFiles.map((file) => file.id));
  return mediaFileIds.filter((mediaFileId) => !availableIds.has(mediaFileId));
}
