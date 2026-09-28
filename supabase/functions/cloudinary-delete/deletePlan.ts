export type CloudinaryResourceType = "image" | "video" | "raw";

export interface OwnedMediaRow {
  id: string;
  user_id: string;
  file_type: string;
  cloudinary_public_id?: string | null;
}

export interface ProviderDeleteRow {
  id: string;
  media_file_id: string;
  provider: string;
  object_key: string;
}

export interface IdDeleteResult {
  id: string;
  status: "deleted" | "failed" | "refused";
  error?: string;
}

export function cloudinaryResourceTypeFor(fileType: string): CloudinaryResourceType {
  if (fileType === "video") return "video";
  if (fileType === "image" || fileType === "gif") return "image";
  return "raw";
}

export function authorisedPublicIds(
  requested: string[],
  rows: OwnedMediaRow[],
): { allowed: { publicId: string; resourceType: CloudinaryResourceType; mediaFileId: string }[]; refused: string[] } {
  const byPublicId = new Map<string, OwnedMediaRow>();
  for (const row of rows) {
    if (row.cloudinary_public_id && !byPublicId.has(row.cloudinary_public_id)) {
      byPublicId.set(row.cloudinary_public_id, row);
    }
  }
  const allowed: { publicId: string; resourceType: CloudinaryResourceType; mediaFileId: string }[] = [];
  const refused: string[] = [];
  for (const publicId of requested) {
    const row = byPublicId.get(publicId);
    if (!row) {
      refused.push(publicId);
      continue;
    }
    allowed.push({
      publicId,
      resourceType: cloudinaryResourceTypeFor(row.file_type),
      mediaFileId: row.id,
    });
  }
  return { allowed, refused };
}

/**
 * Delete each requested id only when the caller owns the row (the caller
 * passes already-scoped rows) and every provider object is destroyed and
 * marked deleted. A row with no provider record is not deleted.
 */
export async function deleteAuthorisedMediaFiles(args: {
  requestedIds: string[];
  rows: OwnedMediaRow[];
  providers: ProviderDeleteRow[];
  destroyOpeninary: (objectKey: string) => Promise<{ success: boolean; error?: string }>;
  destroyCloudinary: (objectKey: string, resourceType: CloudinaryResourceType) => Promise<{ success: boolean; error?: string }>;
  markDeleted: (providerRowId: string) => Promise<{ error?: string }>;
}): Promise<{ results: IdDeleteResult[]; deletedMediaFileIds: string[]; failedMediaFileIds: string[]; errors: string[] }> {
  const rowsById = new Map(args.rows.map((row) => [row.id, row]));
  const results: IdDeleteResult[] = [];
  const errors: string[] = [];

  for (const mediaFileId of args.requestedIds) {
    const row = rowsById.get(mediaFileId);
    if (!row) {
      results.push({ id: mediaFileId, status: "refused", error: "Not allowed" });
      continue;
    }
    const providerRows = args.providers.filter((provider) => provider.media_file_id === mediaFileId);
    if (providerRows.length === 0) {
      results.push({ id: mediaFileId, status: "failed", error: "No stored object for this file" });
      errors.push(`${mediaFileId}: no provider record`);
      continue;
    }

    let failure: string | null = null;
    for (const provider of providerRows) {
      const removed = provider.provider === "cloudinary"
        ? await args.destroyCloudinary(provider.object_key, cloudinaryResourceTypeFor(row.file_type))
        : provider.provider === "openinary"
          ? await args.destroyOpeninary(provider.object_key)
          : { success: false, error: `unsupported provider ${provider.provider}` };
      if (!removed.success) {
        failure = removed.error || "delete failed";
        errors.push(`${provider.provider}: ${failure}`);
        break;
      }
      const marked = await args.markDeleted(provider.id);
      if (marked.error) {
        failure = marked.error;
        errors.push(`${provider.provider} status: ${marked.error}`);
        break;
      }
    }
    results.push(failure
      ? { id: mediaFileId, status: "failed", error: failure }
      : { id: mediaFileId, status: "deleted" });
  }

  return {
    results,
    deletedMediaFileIds: results.filter((result) => result.status === "deleted").map((result) => result.id),
    failedMediaFileIds: results.filter((result) => result.status !== "deleted").map((result) => result.id),
    errors,
  };
}
