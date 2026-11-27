import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  DIRECT_THUMBNAIL_MIMES,
  isAdmissibleThumbnailStorageLocation,
  isDirectThumbnailMime,
  sniffThumbnailType,
  THUMBNAIL_MAX_BYTES,
  verifyDirectThumbnailBytes,
} from "./thumbnailMedia.ts";

const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const WEBP_BYTES = new TextEncoder().encode("RIFF\x24\x00\x00\x00WEBPVP8 ");

Deno.test("DIRECT_THUMBNAIL_MIMES allows only JPEG and PNG", () => {
  assertEquals(DIRECT_THUMBNAIL_MIMES, ["image/jpeg", "image/png"]);
  assertEquals(isDirectThumbnailMime("image/jpeg"), true);
  assertEquals(isDirectThumbnailMime("IMAGE/PNG; charset=binary"), true);
  assertEquals(isDirectThumbnailMime("image/webp"), false);
  assertEquals(isDirectThumbnailMime("image/gif"), false);
  assertEquals(isDirectThumbnailMime(null), false);
});

Deno.test("sniffThumbnailType detects JPEG and PNG and rejects WebP or truncated bytes", () => {
  assertEquals(sniffThumbnailType(JPEG_BYTES), "image/jpeg");
  assertEquals(sniffThumbnailType(PNG_BYTES), "image/png");
  assertEquals(sniffThumbnailType(WEBP_BYTES), null);
  assertEquals(sniffThumbnailType(new Uint8Array(0)), null);
  assertEquals(sniffThumbnailType(new Uint8Array([0xff, 0xd8])), null);
  assertEquals(sniffThumbnailType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a])), null);
});

Deno.test("verifyDirectThumbnailBytes accepts matching JPEG and PNG within 2 MiB", () => {
  assertEquals(verifyDirectThumbnailBytes(JPEG_BYTES, "image/jpeg"), {
    ok: true,
    mimeType: "image/jpeg",
  });
  assertEquals(verifyDirectThumbnailBytes(PNG_BYTES, "IMAGE/PNG; charset=utf-8"), {
    ok: true,
    mimeType: "image/png",
  });

  const exactLimit = new Uint8Array(THUMBNAIL_MAX_BYTES);
  exactLimit.set(JPEG_BYTES);
  assertEquals(verifyDirectThumbnailBytes(exactLimit, "image/jpeg"), {
    ok: true,
    mimeType: "image/jpeg",
  });
});

Deno.test("verifyDirectThumbnailBytes rejects owned image/webp, mismatched magic bytes, empty, and >2 MiB", () => {
  assertEquals(verifyDirectThumbnailBytes(WEBP_BYTES, "image/webp"), {
    ok: false,
    reason: "media_not_usable",
  });
  assertEquals(verifyDirectThumbnailBytes(WEBP_BYTES, "image/jpeg"), {
    ok: false,
    reason: "media_not_usable",
  });
  assertEquals(verifyDirectThumbnailBytes(PNG_BYTES, "image/jpeg"), {
    ok: false,
    reason: "media_not_usable",
  });
  assertEquals(verifyDirectThumbnailBytes(JPEG_BYTES, "image/png"), {
    ok: false,
    reason: "media_not_usable",
  });
  assertEquals(verifyDirectThumbnailBytes(new Uint8Array(0), "image/jpeg"), {
    ok: false,
    reason: "media_not_usable",
  });

  const oversized = new Uint8Array(THUMBNAIL_MAX_BYTES + 1);
  oversized.set(JPEG_BYTES);
  assertEquals(verifyDirectThumbnailBytes(oversized, "image/jpeg"), {
    ok: false,
    reason: "media_not_usable",
  });
});

Deno.test("isAdmissibleThumbnailStorageLocation allows only owned paths inside media/supabase buckets and rejects foreign prefixes, traversal, or CDN buckets", () => {
  const owner = "0ee00001-0000-4000-8000-000000000001";
  const victim = "0ee00001-0000-4000-8000-000000000002";

  assertEquals(isAdmissibleThumbnailStorageLocation("media", `${owner}/thumb.jpg`, owner), true);
  assertEquals(isAdmissibleThumbnailStorageLocation("supabase", `${owner}/folder/thumb.png`, owner), true);

  assertEquals(isAdmissibleThumbnailStorageLocation("cloudinary", `${owner}/thumb.jpg`, owner), false);
  assertEquals(isAdmissibleThumbnailStorageLocation("openinary", `${owner}/thumb.jpg`, owner), false);
  assertEquals(isAdmissibleThumbnailStorageLocation("partner-media", `${owner}/thumb.jpg`, owner), false);
  assertEquals(isAdmissibleThumbnailStorageLocation("avatars", `${owner}/thumb.jpg`, owner), false);
  assertEquals(isAdmissibleThumbnailStorageLocation("media", `${victim}/thumb.jpg`, owner), false);
  assertEquals(isAdmissibleThumbnailStorageLocation("media", `${owner}/../${victim}/thumb.jpg`, owner), false);
  assertEquals(isAdmissibleThumbnailStorageLocation("media", `${owner}/%2e%2e/${victim}/thumb.jpg`, owner), false);
  assertEquals(isAdmissibleThumbnailStorageLocation("media", `${owner}\\thumb.jpg`, owner), false);
  assertEquals(isAdmissibleThumbnailStorageLocation("media", `https://cdn.example.com/${owner}/thumb.jpg`, owner), false);
});
