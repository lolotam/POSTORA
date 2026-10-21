// Deletes the media files of a post, server-side.
//
// This mirrors src/lib/mediaDelete.ts and the dashboard's deleteMediaFiles
// (src/hooks/history/historyUtils.ts) exactly. The frontend code cannot be
// imported by an edge function, so the two copies have to be kept in step: a
// change to the partition, to the confirmation rule or to the provider call
// belongs in the other copy as well.
//
// The difference from the dashboard is the scope: the dashboard deletes the
// media of a post the browser can already see, and this one deletes the media
// of a post an agent tool asked to delete. The read and the row delete are
// therefore scoped to the owner, because this function runs with the service
// role and RLS is not the boundary.

import { fetchWithTimeout } from "../_shared/request-timeout.ts";

export interface StoredMediaRef {
  id: string;
  file_path: string;
  storage_bucket: string | null;
}

export interface PostMediaDeleteDeps {
  // deno-lint-ignore no-explicit-any
  supabase: any;
  fetcher: typeof fetch;
  supabaseUrl: string;
  serviceRoleKey: string;
}

export interface PostMediaDeleteOutcome {
  /** The ids whose files are gone and whose rows were removed. */
  removedIds: string[];
  /** The ids that are still there. */
  failedIds: string[];
}

// The deadline for one call to the provider delete service.
const PROVIDER_TIMEOUT_MS = 15_000;

/** The buckets whose files live in the Supabase storage, and not at a provider. */
export function partitionStoredMedia(
  files: StoredMediaRef[],
): { storage: StoredMediaRef[]; provider: StoredMediaRef[] } {
  return {
    storage: files.filter((file) =>
      file.storage_bucket === "media" || file.storage_bucket === "supabase"
    ),
    provider: files.filter((file) =>
      file.storage_bucket !== "media" && file.storage_bucket !== "supabase"
    ),
  };
}

/** Rows are removed only when storage removal or the provider delete confirmed them. */
export function idsConfirmedDeleted(input: {
  storageIds: string[];
  storageFailed: boolean;
  providerIds: string[];
  invokeFailed: boolean;
  deletedMediaFileIds: string[] | null;
}): { removeIds: string[]; failedIds: string[] } {
  const removeIds: string[] = [];
  const failedIds: string[] = [];
  if (input.storageFailed) failedIds.push(...input.storageIds);
  else removeIds.push(...input.storageIds);
  if (input.invokeFailed || input.deletedMediaFileIds === null) {
    failedIds.push(...input.providerIds);
  } else {
    const deleted = new Set(input.deletedMediaFileIds);
    for (const id of input.providerIds) {
      if (deleted.has(id)) removeIds.push(id);
      else failedIds.push(id);
    }
  }
  return { removeIds, failedIds };
}

/**
 * Delete the media files of one post.
 *
 * The caller is the owner of the post, and only the caller's own files are
 * touched: the read and the row delete both carry the owner, so a file of
 * another account is never read and never removed.
 *
 * The function never throws: a media delete that fails is reported in the
 * answer, and it never undoes the delete of the post itself.
 */
export async function deletePostMedia(
  deps: PostMediaDeleteDeps,
  request: { userId: string; mediaFileIds: string[] },
): Promise<PostMediaDeleteOutcome> {
  const mediaFileIds = Array.isArray(request.mediaFileIds) ? request.mediaFileIds : [];
  if (mediaFileIds.length === 0) return { removedIds: [], failedIds: [] };

  try {
    return await deletePostMediaFiles(deps, request.userId, mediaFileIds);
  } catch (thrown) {
    console.error(
      `[n8n-api] posts/delete: deleting the media of the post failed: ${
        thrown instanceof Error ? thrown.name : "unknown"
      }`,
    );
    // Nothing is known to be gone, so every file is reported as still there.
    return { removedIds: [], failedIds: [...mediaFileIds] };
  }
}

async function deletePostMediaFiles(
  deps: PostMediaDeleteDeps,
  userId: string,
  mediaFileIds: string[],
): Promise<PostMediaDeleteOutcome> {
  const { data: mediaFiles, error: readError } = await deps.supabase
    .from("media_files")
    .select("id, file_path, storage_bucket")
    .in("id", mediaFileIds)
    .eq("user_id", userId);

  if (readError) {
    console.error(
      `[n8n-api] posts/delete: reading the media files of the post failed: ${readError.message}`,
    );
    // Nothing is deleted: a read that failed cannot say which files may go.
    return { removedIds: [], failedIds: [...mediaFileIds] };
  }

  const files = (mediaFiles ?? []) as StoredMediaRef[];
  if (files.length === 0) return { removedIds: [], failedIds: [] };

  const { storage, provider } = partitionStoredMedia(files);

  let storageFailed = false;
  if (storage.length > 0) {
    try {
      const { error: storageError } = await deps.supabase.storage
        .from("media")
        .remove(storage.map((file) => file.file_path));
      storageFailed = !!storageError;
      if (storageError) {
        console.error(
          `[n8n-api] posts/delete: removing the stored media of the post failed: ${storageError.message}`,
        );
      }
    } catch {
      storageFailed = true;
    }
  }

  let invokeFailed = false;
  let deletedMediaFileIds: string[] | null = provider.length > 0 ? null : [];
  if (provider.length > 0) {
    try {
      const response = await fetchWithTimeout(
        `${deps.supabaseUrl}/functions/v1/cloudinary-delete`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${deps.serviceRoleKey}`,
          },
          body: JSON.stringify({
            mediaFileIds: provider.map((file) => file.id),
            // The service acts for this user: it is called with the service
            // role, so the owner travels in the body.
            user_id: userId,
          }),
        },
        PROVIDER_TIMEOUT_MS,
        deps.fetcher,
      );
      if (!response.ok) {
        invokeFailed = true;
        console.error(
          `[n8n-api] posts/delete: the media delete service answered ${response.status}`,
        );
      } else {
        const body: unknown = await response.json().catch(() => null);
        // A body that is not JSON is a failed read, not an empty result: the
        // files that were not named as deleted are still there.
        if (typeof body !== "object" || body === null) {
          invokeFailed = true;
        } else {
          const deleted = (body as { deletedMediaFileIds?: unknown }).deletedMediaFileIds;
          deletedMediaFileIds = Array.isArray(deleted)
            ? deleted.filter((id): id is string => typeof id === "string")
            : [];
        }
      }
    } catch {
      invokeFailed = true;
    }
  }

  const outcome = idsConfirmedDeleted({
    storageIds: storage.map((file) => file.id),
    storageFailed,
    providerIds: provider.map((file) => file.id),
    invokeFailed,
    deletedMediaFileIds,
  });

  if (outcome.removeIds.length > 0) {
    const { error: deleteError } = await deps.supabase
      .from("media_files")
      .delete()
      .in("id", outcome.removeIds)
      .eq("user_id", userId);
    if (deleteError) {
      console.error(
        `[n8n-api] posts/delete: deleting the media rows of the post failed: ${deleteError.message}`,
      );
      // The rows are still there: the library still lists files whose object is
      // gone, so they are reported as failed and not as removed.
      return {
        removedIds: [],
        failedIds: [...outcome.failedIds, ...outcome.removeIds],
      };
    }
  }

  return { removedIds: outcome.removeIds, failedIds: outcome.failedIds };
}
