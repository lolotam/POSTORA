import { describe, expect, it, vi } from "vitest";
import { batchOriginalName, renameBatchFile } from "../batchRename";

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: () => { throw new Error("batch rename test must inject its table"); } },
}));

type UpdateCall = { id: string; values: Record<string, unknown> };

function recordingTable(metadata: unknown) {
  const updates: UpdateCall[] = [];
  const db = {
    from() {
      return {
        select() {
          return {
            eq() {
              return {
                single: () => Promise.resolve({ data: { metadata }, error: null }),
              };
            },
          };
        },
        update(values: Record<string, unknown>) {
          return {
            eq(_column: string, id: string) {
              updates.push({ id, values });
              return Promise.resolve({ error: null });
            },
          };
        },
      };
    },
  };
  return { db, updates };
}

describe("batch rename", () => {
  it("updates original_filename for an openinary row and leaves file_path unchanged", async () => {
    const { db, updates } = recordingTable({ original_filename: "shot.png", width: 10 });
    await renameBatchFile({
      id: "file-1",
      file_path: "https://cdn.example/t/postora.cloud/shot.png",
      storage_bucket: "openinary",
      metadata: { original_filename: "shot.png" },
    }, "image-001.png", db);

    expect(updates).toEqual([{
      id: "file-1",
      values: { metadata: { original_filename: "image-001.png", width: 10 } },
    }]);
    expect(JSON.stringify(updates)).not.toContain("file_path");
  });

  it("updates file_path for a media-bucket row", async () => {
    const { db, updates } = recordingTable(null);
    await renameBatchFile({
      id: "file-2",
      file_path: "folder/old.png",
      storage_bucket: "media",
    }, "image-001.png", db);

    expect(updates).toEqual([{
      id: "file-2",
      values: { file_path: "folder/image-001.png" },
    }]);
  });

  it("previews the stored original filename when metadata has one", () => {
    expect(batchOriginalName({
      file_path: "https://cdn.example/t/postora.cloud/abc.png",
      metadata: { original_filename: "holiday.png" },
    })).toBe("holiday.png");
  });
});
