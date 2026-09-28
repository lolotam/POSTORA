import { assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  BodyTooLargeError,
  estimateBase64DecodedBytes,
  isAdvertisedBodyTooLarge,
  limitProvidersForKind,
  matchingDuplicateId,
  readJsonBodyCapped,
  resolveUpload,
} from "./uploadPolicy.ts";
import { MEDIA_DECODED_BYTE_CAP, MEDIA_JSON_BODY_BYTE_CAP } from "../_shared/mediaTypes.ts";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);

Deno.test("an extensionless upload resolves from sniffed bytes", () => {
  const resolved = resolveUpload({ fileName: "app_favicon", fileType: "image", bytes: PNG });
  assertEquals(resolved.ok, true);
  if (resolved.ok) {
    assertEquals(resolved.upload.ext, "png");
    assertEquals(resolved.upload.entry.mime, "image/png");
    assertEquals(resolved.upload.entry.storedFileType, "image");
  }
});

Deno.test("an excluded or unsupported extension is rejected", () => {
  assertEquals(resolveUpload({ fileName: "virus.exe", fileType: "raw" }).ok, false);
  assertEquals(resolveUpload({ fileName: "page.html", fileType: "raw" }).ok, false);
  assertEquals(resolveUpload({ fileName: "clip.avi", fileType: "video" }).ok, false);
  const csv = resolveUpload({ fileName: "x.csv", fileType: "raw" });
  assertEquals(csv.ok && csv.upload.entry.storedFileType, "document");
  assertEquals(csv.ok && csv.upload.entry.mime, "text/csv");
  const gif = resolveUpload({ fileName: "a.GIF", fileType: "gif" });
  assertEquals(gif.ok && gif.upload.entry.storedFileType, "image");
  assertEquals(gif.ok && gif.upload.entry.mime, "image/gif");
});

Deno.test("a URL query is stripped before the file is classified", () => {
  const resolved = resolveUpload({ fileName: "https://cdn.example/files/تقرير.pdf?token=secret", fileType: "document" });
  assertEquals(resolved.ok, true);
  if (resolved.ok) {
    assertEquals(resolved.upload.ext, "pdf");
    assertEquals(resolved.upload.originalFilename, "تقرير.pdf");
  }
});

Deno.test("two same-size documents are not treated as one upload", () => {
  const candidates = [{ id: "a", file_size: 100 }, { id: "b", file_size: 100 }];
  assertEquals(matchingDuplicateId("document", 100, candidates), null);
  assertEquals(matchingDuplicateId("audio", 100, candidates), null);
  assertEquals(matchingDuplicateId("archive", 100, candidates), null);
  assertEquals(matchingDuplicateId("image", 100, candidates), "a");
});

Deno.test("documents are sent only to Openinary", () => {
  assertEquals(limitProvidersForKind("document", ["openinary", "cloudinary"], ["openinary", "cloudinary"]), {
    attempted: ["openinary"],
    required: ["openinary"],
  });
  assertEquals(limitProvidersForKind("image", ["openinary", "cloudinary"], ["cloudinary"]).attempted, ["openinary", "cloudinary"]);
});

Deno.test("an oversized body is rejected before JSON.parse", async () => {
  assertEquals(isAdvertisedBodyTooLarge(String(MEDIA_JSON_BODY_BYTE_CAP + 1)), true);
  assertEquals(isAdvertisedBodyTooLarge(String(MEDIA_JSON_BODY_BYTE_CAP)), false);
  const req = new Request("http://local/upload", {
    method: "POST",
    body: "{this is not json",
    headers: { "content-type": "application/json" },
  });
  await assertRejects(() => readJsonBodyCapped(req, 8), BodyTooLargeError);
  assertEquals(estimateBase64DecodedBytes("data:application/pdf;base64," + "A".repeat(20)), 15);
  assertEquals(MEDIA_DECODED_BYTE_CAP, 10 * 1024 * 1024);
});

Deno.test("dotted names without a real extension fall through to byte sniffing instead of being refused", () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  for (const fileName of ["IMG_2026.09_bg-removed", "Screenshot 2026.09.28", "photo.v2_enhanced-sharpen"]) {
    const resolved = resolveUpload({ fileName, fileType: "image", bytes: png });
    assertEquals(resolved.ok, true, fileName);
    if (resolved.ok) assertEquals(resolved.upload.ext, "png", fileName);
  }
  const exe = resolveUpload({ fileName: "setup.exe", fileType: "raw" });
  assertEquals(exe.ok, false);
  const sevenZip = resolveUpload({ fileName: "backup.7z", fileType: "raw" });
  assertEquals(sevenZip.ok, true);
});
