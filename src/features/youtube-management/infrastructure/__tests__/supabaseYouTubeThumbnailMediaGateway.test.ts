import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => {
  const state = {
    listResult: { data: [] as unknown, error: null as unknown },
    insertResult: { data: null as unknown, error: null as unknown },
    lookupResult: { data: null as unknown, error: null as unknown },
    session: { user: { id: "user-1" } } as { user: { id: string } | null },
    uploadError: null as unknown,
    uploads: [] as Array<{ bucket: string; path: string; options: unknown }>,
    removals: [] as Array<{ bucket: string; paths: string[] }>,
    insertedRows: [] as Array<Record<string, unknown>>,
  };

  function createBuilder() {
    const chain: Record<string, unknown> = {};
    chain.select = () => chain;
    chain.eq = () => chain;
    chain.in = () => chain;
    chain.order = () => chain;
    chain.limit = () => chain;
    chain.insert = (values: Record<string, unknown>) => {
      state.insertedRows.push(values);
      return chain;
    };
    chain.single = async () => state.insertResult;
    chain.maybeSingle = async () => state.lookupResult;
    chain.then = (
      resolve: (value: unknown) => unknown,
      reject?: (reason: unknown) => unknown,
    ) => Promise.resolve(state.listResult).then(resolve, reject);
    return chain;
  }

  return {
    state,
    supabase: {
      from: () => createBuilder(),
      storage: {
        from: (bucket: string) => ({
          upload: async (path: string, blob: Blob, options: unknown) => {
            state.uploads.push({ bucket, path, options });
            return { error: state.uploadError };
          },
          remove: async (paths: string[]) => {
            state.removals.push({ bucket, paths });
            return { error: null };
          },
          getPublicUrl: (path: string) => ({ data: { publicUrl: `https://storage.test/${bucket}/${path}` } }),
        }),
      },
      auth: {
        getSession: async () => ({ data: { session: state.session }, error: null }),
      },
    },
  };
});

vi.mock("@/integrations/supabase/client", () => ({ supabase: fake.supabase }));

import { SupabaseYouTubeThumbnailMediaGateway } from "../supabaseYouTubeThumbnailMediaGateway";

const FIXED_UUID = "11111111-2222-4333-8444-555555555555";
const JPEG_HEAD = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);

function jpegBlob(bytes = 64): Blob {
  return new File([JPEG_HEAD, new Uint8Array(bytes)], "cover.jpg", { type: "image/jpeg" });
}

beforeEach(() => {
  fake.state.listResult = { data: [], error: null };
  fake.state.insertResult = { data: null, error: null };
  fake.state.lookupResult = { data: null, error: null };
  fake.state.session = { user: { id: "user-1" } };
  fake.state.uploadError = null;
  fake.state.uploads = [];
  fake.state.removals = [];
  fake.state.insertedRows = [];
  Object.defineProperty(globalThis.crypto, "randomUUID", { value: () => FIXED_UUID, configurable: true });
});

describe("listing the creator's own images", () => {
  it("resolves a preview URL for every row it returns", async () => {
    fake.state.listResult = {
      data: [
        {
          id: "media-1",
          file_path: "user-1/cover.jpg",
          mime_type: "image/jpeg",
          file_type: "image",
          file_size: 120_000,
          storage_bucket: "media",
          metadata: { original_filename: "cover.jpg" },
        },
      ],
      error: null,
    };

    const candidates = await new SupabaseYouTubeThumbnailMediaGateway().listOwnedImages({ userId: "user-1" });

    expect(candidates).toEqual([{
      id: "media-1",
      file_name: "cover.jpg",
      mime_type: "image/jpeg",
      file_type: "image",
      file_size: 120_000,
      preview_url: "https://storage.test/media/user-1/cover.jpg",
    }]);
  });

  it("leaves the preview empty for a row without a file", async () => {
    fake.state.listResult = {
      data: [{
        id: "media-2",
        file_path: null,
        mime_type: "image/png",
        file_type: "image",
        file_size: null,
        storage_bucket: "media",
        metadata: null,
      }],
      error: null,
    };

    const candidates = await new SupabaseYouTubeThumbnailMediaGateway().listOwnedImages({ userId: "user-1" });

    expect(candidates[0].preview_url).toBeNull();
  });
});

describe("uploading an image the creator picked on this device", () => {
  it("stores the file under the session owner's prefix and records the row", async () => {
    fake.state.insertResult = {
      data: {
        id: FIXED_UUID,
        file_path: `user-1/${FIXED_UUID}.jpg`,
        mime_type: "image/jpeg",
        file_type: "image",
        file_size: 72,
        storage_bucket: "media",
        metadata: { original_filename: "cover.jpg" },
      },
      error: null,
    };

    const candidate = await new SupabaseYouTubeThumbnailMediaGateway().uploadOwnedImage({
      blob: jpegBlob(),
      fileName: "cover.jpg",
      mimeType: "image/jpeg",
    });

    expect(fake.state.uploads).toEqual([{
      bucket: "media",
      path: `user-1/${FIXED_UUID}.jpg`,
      options: { contentType: "image/jpeg", upsert: false },
    }]);
    expect(fake.state.insertedRows[0]).toMatchObject({
      id: FIXED_UUID,
      user_id: "user-1",
      file_path: `user-1/${FIXED_UUID}.jpg`,
      file_type: "image",
      mime_type: "image/jpeg",
      storage_bucket: "media",
      metadata: { original_filename: "cover.jpg" },
    });
    expect(candidate.id).toBe(FIXED_UUID);
    expect(candidate.preview_url).toBe(`https://storage.test/media/user-1/${FIXED_UUID}.jpg`);
  });

  it("refuses a file that is not a JPEG or a PNG before it is stored", async () => {
    await expect(new SupabaseYouTubeThumbnailMediaGateway().uploadOwnedImage({
      blob: new File([new Uint8Array([0x47, 0x49, 0x46])], "sticker.gif", { type: "image/gif" }),
      fileName: "sticker.gif",
      mimeType: "image/jpeg",
    })).rejects.toThrow(/refused/);

    expect(fake.state.uploads).toHaveLength(0);
    expect(fake.state.insertedRows).toHaveLength(0);
  });

  it("refuses to write without a session", async () => {
    fake.state.session = { user: null };

    await expect(new SupabaseYouTubeThumbnailMediaGateway().uploadOwnedImage({
      blob: jpegBlob(),
      fileName: "cover.jpg",
      mimeType: "image/jpeg",
    })).rejects.toThrow(/Authentication required/);

    expect(fake.state.uploads).toHaveLength(0);
  });

  it("removes the stored object when the row was never written", async () => {
    fake.state.insertResult = { data: null, error: new Error("insert refused") };

    await expect(new SupabaseYouTubeThumbnailMediaGateway().uploadOwnedImage({
      blob: jpegBlob(),
      fileName: "cover.jpg",
      mimeType: "image/jpeg",
    })).rejects.toThrow(/insert refused/);

    expect(fake.state.removals).toEqual([{ bucket: "media", paths: [`user-1/${FIXED_UUID}.jpg`] }]);
  });

  it("keeps the stored object when the row exists and only the answer was lost", async () => {
    fake.state.insertResult = { data: null, error: new Error("connection reset") };
    fake.state.lookupResult = {
      data: {
        id: FIXED_UUID,
        file_path: `user-1/${FIXED_UUID}.jpg`,
        mime_type: "image/jpeg",
        file_type: "image",
        file_size: 72,
        storage_bucket: "media",
        metadata: { original_filename: "cover.jpg" },
      },
      error: null,
    };

    const candidate = await new SupabaseYouTubeThumbnailMediaGateway().uploadOwnedImage({
      blob: jpegBlob(),
      fileName: "cover.jpg",
      mimeType: "image/jpeg",
    });

    expect(candidate.id).toBe(FIXED_UUID);
    expect(fake.state.removals).toHaveLength(0);
  });

  it("keeps the stored object when the compensating lookup itself fails", async () => {
    fake.state.insertResult = { data: null, error: new Error("statement timeout") };
    fake.state.lookupResult = { data: null, error: new Error("lookup timeout") };

    await expect(new SupabaseYouTubeThumbnailMediaGateway().uploadOwnedImage({
      blob: jpegBlob(),
      fileName: "cover.jpg",
      mimeType: "image/jpeg",
    })).rejects.toThrow(/statement timeout/);

    expect(fake.state.removals).toHaveLength(0);
  });
});
