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
  /** ready | pending | failed | deleted. `failed` was never stored; `deleted` is already gone. */
  status: string;
}

/**
 * `removed`: the provider confirmed the object is gone (including "not found").
 * `provider_disabled`: the provider says the whole account is disabled, so the object is
 * unreachable for everyone and there is nothing left to delete.
 */
export interface DestroyResult {
  success: boolean;
  error?: string;
  reason?: "removed" | "provider_disabled";
}

/** Cloudinary answers a disabled cloud with 401 "cloud_name is disabled". Env-less config is not this. */
export function isDisabledCloudResponse(status: number, message: string | undefined): boolean {
  return status === 401 && /disabled/i.test(message ?? "");
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
  destroyOpeninary: (objectKey: string) => Promise<DestroyResult>;
  destroyCloudinary: (objectKey: string, resourceType: CloudinaryResourceType) => Promise<DestroyResult>;
  markDeleted: (providerRowId: string, reason: string) => Promise<{ error?: string }>;
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
    const allProviderRows = args.providers.filter((provider) => provider.media_file_id === mediaFileId);
    if (allProviderRows.length === 0) {
      results.push(await deleteLegacyCloudinary(row, args.destroyCloudinary, errors));
      continue;
    }
    // A failed provider row never stored an object and a deleted one is already gone.
    const providerRows = allProviderRows.filter((provider) => provider.status !== "failed" && provider.status !== "deleted");

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
      const marked = await args.markDeleted(provider.id, removed.reason === "provider_disabled" ? "provider_disabled" : "user delete");
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

/** A row that predates media_file_providers: its only object reference is cloudinary_public_id. */
async function deleteLegacyCloudinary(
  row: OwnedMediaRow,
  destroyCloudinary: (objectKey: string, resourceType: CloudinaryResourceType) => Promise<DestroyResult>,
  errors: string[],
): Promise<IdDeleteResult> {
  if (!row.cloudinary_public_id) {
    errors.push(`${row.id}: no provider record`);
    return { id: row.id, status: "failed", error: "No stored object for this file" };
  }
  const removed = await destroyCloudinary(row.cloudinary_public_id, cloudinaryResourceTypeFor(row.file_type));
  if (removed.success) return { id: row.id, status: "deleted" };
  errors.push(`cloudinary: ${removed.error || "delete failed"}`);
  return { id: row.id, status: "failed", error: removed.error || "delete failed" };
}
