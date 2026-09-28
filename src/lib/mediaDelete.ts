export interface StoredMediaRef {
  id: string;
  file_path: string;
  storage_bucket: string | null;
}

export interface ProviderDeleteResponse {
  deletedMediaFileIds?: string[];
  failedMediaFileIds?: string[];
  success?: boolean;
}

export function partitionStoredMedia(files: StoredMediaRef[]): { storage: StoredMediaRef[]; provider: StoredMediaRef[] } {
  return {
    storage: files.filter((file) => file.storage_bucket === "media" || file.storage_bucket === "supabase"),
    provider: files.filter((file) => file.storage_bucket !== "media" && file.storage_bucket !== "supabase"),
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

export async function deleteLibraryFiles(
  files: StoredMediaRef[],
  deps: {
    removeStorage: (paths: string[]) => Promise<unknown>;
    invokeDelete: (ids: string[]) => Promise<{ data: ProviderDeleteResponse | null; error: unknown }>;
    deleteRows: (ids: string[]) => Promise<void>;
  },
): Promise<{ removeIds: string[]; failedIds: string[] }> {
  const { storage, provider } = partitionStoredMedia(files);
  let storageFailed = false;
  if (storage.length > 0) {
    try {
      const storageError = await deps.removeStorage(storage.map((file) => file.file_path));
      storageFailed = !!storageError;
    } catch {
      storageFailed = true;
    }
  }

  let invokeFailed = false;
  let deletedMediaFileIds: string[] | null = provider.length > 0 ? null : [];
  if (provider.length > 0) {
    try {
      const result = await deps.invokeDelete(provider.map((file) => file.id));
      if (result.error || !result.data) invokeFailed = true;
      else deletedMediaFileIds = result.data.deletedMediaFileIds ?? [];
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
  if (outcome.removeIds.length > 0) await deps.deleteRows(outcome.removeIds);
  return outcome;
}
