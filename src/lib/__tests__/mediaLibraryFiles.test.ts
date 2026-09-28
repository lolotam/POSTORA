import { describe, expect, it } from "vitest";
import { deleteLibraryFiles, idsConfirmedDeleted, partitionStoredMedia } from "@/lib/mediaDelete";
import { isPostableLibraryFile } from "@/lib/mediaTypes";
import { libraryFilePublicUrl } from "@/pages/media-library/utils";

describe("library public urls", () => {
  it("uses an Openinary https file_path instead of a storage url", () => {
    const url = "https://openinary.example/t/postora.cloud/a.pdf";
    expect(libraryFilePublicUrl(
      { file_path: url, storage_bucket: "openinary" },
      () => "https://storage.example/object/public/media/a.pdf",
    )).toBe(url);
  });
});

describe("post picker", () => {
  it("refuses a document", () => {
    expect(isPostableLibraryFile({
      file_type: "document",
      file_path: "brief.pdf",
      metadata: { original_filename: "brief.pdf", kind: "document" },
    })).toBe(false);
  });
});

describe("media delete confirmation", () => {
  it("batches provider ids and removes only confirmed rows", async () => {
    const invoked: string[][] = [];
    const removed: string[][] = [];
    const outcome = await deleteLibraryFiles([
      { id: "open-1", file_path: "https://openinary.example/a", storage_bucket: "openinary" },
      { id: "open-2", file_path: "https://openinary.example/b", storage_bucket: "cloudinary" },
      { id: "local", file_path: "user/a.png", storage_bucket: "media" },
    ], {
      removeStorage: async (paths) => { removed.push(paths); return null; },
      invokeDelete: async (ids) => {
        invoked.push(ids);
        return { data: { deletedMediaFileIds: ["open-1"] }, error: null };
      },
      deleteRows: async () => {},
    });
    expect(invoked).toEqual([["open-1", "open-2"]]);
    expect(removed).toEqual([["user/a.png"]]);
    expect(outcome.removeIds.sort()).toEqual(["local", "open-1"]);
    expect(outcome.failedIds).toEqual(["open-2"]);
  });

  it("keeps provider rows when the delete call fails", () => {
    const outcome = idsConfirmedDeleted({
      storageIds: [],
      storageFailed: false,
      providerIds: ["a"],
      invokeFailed: true,
      deletedMediaFileIds: null,
    });
    expect(outcome.removeIds).toEqual([]);
    expect(partitionStoredMedia([{ id: "m", file_path: "p", storage_bucket: "media" }]).storage).toHaveLength(1);
  });
});
