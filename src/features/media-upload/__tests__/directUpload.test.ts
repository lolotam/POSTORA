import { describe, expect, it, vi } from "vitest";
import { uploadLargeMedia, type DirectUploadDeps } from "../infrastructure/directUpload";
import type { PostForm } from "../infrastructure/transport";

vi.mock("@/integrations/supabase/client", () => ({ supabase: { functions: { invoke: vi.fn() } } }));

const OPENINARY_TARGET = {
  provider: "openinary",
  url: "https://openinary.example/api/upload",
  fileField: "files",
  fields: { folder: "postora.cloud/media/u/2026-10-29", signature: "sig", expires: "123", names: "postora_x_1.mp4" },
};

const CLOUDINARY_TARGET = {
  provider: "cloudinary",
  url: "https://api.cloudinary.com/v1_1/demo/video/upload",
  fileField: "file",
  chunkSize: 20,
  fields: { api_key: "k", timestamp: "1", signature: "s", folder: "media/u/2026-10-29", public_id: "postora_x_1", overwrite: "false" },
};

const CLOUDINARY_DONE = { public_id: "media/u/2026-10-29/postora_x_1", version: 7, signature: "abc", secure_url: "https://res.cloudinary.com/x.mp4", bytes: 45 };
const STORED_PATH = "postora.cloud/media/u/2026-10-29/postora_x_1.mp4";

function video(bytes = 45): File {
  return new File([new Uint8Array(bytes)], "clip.mp4", { type: "video/mp4" });
}

function deps(targets: unknown[], postForm: PostForm, complete: unknown = { success: true, url: "https://o.example/x.mp4", mediaFileId: "media-1" }) {
  const invoke = vi.fn(async (body: Record<string, unknown>) =>
    body.action === "start"
      ? { data: { success: true, session: "token", targets }, error: null }
      : { data: complete, error: null });
  return { invoke, postForm } satisfies DirectUploadDeps;
}

describe("uploadLargeMedia", () => {
  it("posts the file to Openinary with the signed fields, then completes with the stored path", async () => {
    const postForm = vi.fn<PostForm>(async (_url, _form, { onProgress }) => {
      onProgress?.(1);
      return { status: 200, body: { success: true, files: [{ path: STORED_PATH }] } };
    });
    const d = deps([OPENINARY_TARGET], postForm);
    const progress: number[] = [];

    const result = await uploadLargeMedia(video(), (p) => progress.push(p), d);

    expect(result.mediaFileId).toBe("media-1");
    const [url, form] = postForm.mock.calls[0];
    expect(url).toBe(OPENINARY_TARGET.url);
    expect(form.get("signature")).toBe("sig");
    expect(form.get("names")).toBe("postora_x_1.mp4");
    expect(form.get("files")).toBeInstanceOf(File);
    expect(d.invoke).toHaveBeenLastCalledWith({ action: "complete", session: "token", results: { openinary: { path: STORED_PATH } }, failures: {} });
    expect(progress.at(-1)).toBe(100);
  });

  it("sends Cloudinary chunks with one upload id and inclusive Content-Range headers", async () => {
    const headers: Record<string, string>[] = [];
    const postForm = vi.fn<PostForm>(async (_url, form, options) => {
      headers.push(options.headers ?? {});
      const end = Number((options.headers?.["Content-Range"] ?? "").split("-")[1]?.split("/")[0]);
      expect((form.get("file") as Blob).size).toBe(end === 44 ? 5 : 20);
      return { status: 200, body: end === 44 ? CLOUDINARY_DONE : { done: false } };
    });
    const d = deps([CLOUDINARY_TARGET], postForm);

    await uploadLargeMedia(video(), undefined, d);

    expect(headers.map((h) => h["Content-Range"])).toEqual(["bytes 0-19/45", "bytes 20-39/45", "bytes 40-44/45"]);
    expect(new Set(headers.map((h) => h["X-Unique-Upload-Id"])).size).toBe(1);
    expect(d.invoke).toHaveBeenLastCalledWith(expect.objectContaining({ results: { cloudinary: CLOUDINARY_DONE } }));
  });

  it("resends a chunk that hit a server error instead of failing the whole upload", async () => {
    let calls = 0;
    const postForm = vi.fn<PostForm>(async () => {
      calls += 1;
      return calls === 1 ? { status: 502, body: null } : { status: 200, body: CLOUDINARY_DONE };
    });
    await uploadLargeMedia(video(20), undefined, deps([CLOUDINARY_TARGET], postForm));
    expect(calls).toBe(2);
  });

  it("keeps the copy that landed and reports the provider that refused", async () => {
    const postForm = vi.fn<PostForm>(async (url) =>
      url.startsWith("https://openinary")
        ? { status: 400, body: { success: false, errors: [{ error: "File size exceeds limit of 50MB" }] } }
        : { status: 200, body: CLOUDINARY_DONE });
    const d = deps([OPENINARY_TARGET, CLOUDINARY_TARGET], postForm);

    await uploadLargeMedia(video(20), undefined, d);

    expect(d.invoke).toHaveBeenLastCalledWith(expect.objectContaining({
      results: { cloudinary: CLOUDINARY_DONE },
      failures: { openinary: "openinary refused the upload: File size exceeds limit of 50MB" },
    }));
  });

  it("uploads to every provider at the same time and reports their mean progress", async () => {
    const releases: (() => void)[] = [];
    const reporters: ((fraction: number) => void)[] = [];
    const postForm = vi.fn<PostForm>((url, _form, { onProgress }) => new Promise((resolve) => {
      reporters.push((fraction) => onProgress?.(fraction));
      releases.push(() => resolve(url.startsWith("https://openinary")
        ? { status: 200, body: { success: true, files: [{ path: STORED_PATH }] } }
        : { status: 200, body: CLOUDINARY_DONE }));
    }));
    const d = deps([OPENINARY_TARGET, { ...CLOUDINARY_TARGET, chunkSize: 100 }], postForm);
    const progress: number[] = [];

    const upload = uploadLargeMedia(video(20), (p) => progress.push(p), d);
    await vi.waitFor(() => expect(postForm).toHaveBeenCalledTimes(2));
    reporters[0](1);
    reporters[1](0.5);
    expect(progress.at(-1)).toBe(75);
    releases.forEach((release) => release());
    await upload;

    expect(d.invoke).toHaveBeenLastCalledWith(expect.objectContaining({
      results: { openinary: { path: STORED_PATH }, cloudinary: CLOUDINARY_DONE },
    }));
  });

  it("does not call complete when no provider took the file", async () => {
    const postForm = vi.fn<PostForm>(async () => ({ status: 413, body: "Request Entity Too Large" }));
    const d = deps([OPENINARY_TARGET], postForm);

    await expect(uploadLargeMedia(video(), undefined, d)).rejects.toThrow("larger than the server accepts");
    expect(d.invoke).toHaveBeenCalledTimes(1);
  });

  it("shows the server's reason when start is refused", async () => {
    const invoke = vi.fn(async () => ({
      data: null,
      error: Object.assign(new Error("Edge Function returned a non-2xx status code"), {
        context: new Response(JSON.stringify({ success: false, error: "File exceeds the 500 MB limit" }), { status: 413 }),
      }),
    }));
    await expect(uploadLargeMedia(video(), undefined, { invoke, postForm: vi.fn() })).rejects.toThrow("File exceeds the 500 MB limit");
  });
});
