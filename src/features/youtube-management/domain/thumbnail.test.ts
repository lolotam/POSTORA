import { describe, expect, it } from "vitest";
import { THUMBNAIL_MAX_BYTES as SERVER_THUMBNAIL_MAX_BYTES } from "../../../../supabase/functions/youtube-resources/thumbnailMedia";
import {
  THUMBNAIL_MAX_BYTES,
  checkThumbnailFile,
  sniffThumbnailType,
} from "./thumbnail";

const JPEG_HEAD = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
const PNG_HEAD = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const WEBP_HEAD = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]);
const GIF_HEAD = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);

describe("the thumbnail size ceiling", () => {
  it("is the same 2 MiB the server enforces", () => {
    expect(THUMBNAIL_MAX_BYTES).toBe(2 * 1024 * 1024);
    expect(THUMBNAIL_MAX_BYTES).toBe(SERVER_THUMBNAIL_MAX_BYTES);
  });
});

describe("sniffThumbnailType", () => {
  it("recognises a JPEG and a PNG by their leading bytes", () => {
    expect(sniffThumbnailType(JPEG_HEAD)).toBe("image/jpeg");
    expect(sniffThumbnailType(PNG_HEAD)).toBe("image/png");
  });

  it("refuses a WebP, a GIF and an empty head", () => {
    expect(sniffThumbnailType(WEBP_HEAD)).toBeNull();
    expect(sniffThumbnailType(GIF_HEAD)).toBeNull();
    expect(sniffThumbnailType(new Uint8Array(0))).toBeNull();
  });
});

describe("checkThumbnailFile", () => {
  it("accepts a JPEG and a PNG whose declared type matches their bytes", () => {
    expect(checkThumbnailFile({ declaredType: "image/jpeg", size: 1000, head: JPEG_HEAD }))
      .toEqual({ ok: true, mimeType: "image/jpeg" });
    expect(checkThumbnailFile({ declaredType: "image/png", size: 1000, head: PNG_HEAD }))
      .toEqual({ ok: true, mimeType: "image/png" });
  });

  it("accepts a file that declares no type at all", () => {
    expect(checkThumbnailFile({ declaredType: "", size: 1000, head: JPEG_HEAD }))
      .toEqual({ ok: true, mimeType: "image/jpeg" });
  });

  it("reads 'image/jpg' and the MIME parameters a browser adds", () => {
    expect(checkThumbnailFile({ declaredType: "IMAGE/JPG", size: 1000, head: JPEG_HEAD }))
      .toEqual({ ok: true, mimeType: "image/jpeg" });
    expect(checkThumbnailFile({ declaredType: "image/jpeg; charset=binary", size: 1000, head: JPEG_HEAD }))
      .toEqual({ ok: true, mimeType: "image/jpeg" });
  });

  it("refuses a declared type YouTube does not accept", () => {
    expect(checkThumbnailFile({ declaredType: "image/webp", size: 1000, head: WEBP_HEAD }))
      .toEqual({ ok: false, reason: "not_jpeg_png" });
    expect(checkThumbnailFile({ declaredType: "image/gif", size: 1000, head: GIF_HEAD }))
      .toEqual({ ok: false, reason: "not_jpeg_png" });
    expect(checkThumbnailFile({ declaredType: "application/pdf", size: 1000, head: JPEG_HEAD }))
      .toEqual({ ok: false, reason: "not_jpeg_png" });
  });

  it("refuses bytes that are neither a JPEG nor a PNG", () => {
    expect(checkThumbnailFile({ declaredType: "", size: 1000, head: WEBP_HEAD }))
      .toEqual({ ok: false, reason: "not_jpeg_png" });
  });

  it("calls a PNG labelled JPEG a mismatch, not an unsupported type", () => {
    expect(checkThumbnailFile({ declaredType: "image/jpeg", size: 1000, head: PNG_HEAD }))
      .toEqual({ ok: false, reason: "type_mismatch" });
  });

  it("accepts exactly 2 MiB and refuses one byte more", () => {
    expect(checkThumbnailFile({ declaredType: "image/jpeg", size: 2_097_152, head: JPEG_HEAD }))
      .toEqual({ ok: true, mimeType: "image/jpeg" });
    expect(checkThumbnailFile({ declaredType: "image/jpeg", size: 2_097_153, head: JPEG_HEAD }))
      .toEqual({ ok: false, reason: "too_large" });
  });

  it("refuses an empty file", () => {
    expect(checkThumbnailFile({ declaredType: "image/jpeg", size: 0, head: JPEG_HEAD }))
      .toEqual({ ok: false, reason: "too_large" });
  });
});
