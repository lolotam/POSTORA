import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  MEDIA_DECODED_BYTE_CAP,
  MEDIA_TYPES,
  directUploadByteCap,
  formatUploadLimit,
  maxUploadBytesFor,
  needsDirectUpload,
  dedupeEligible,
  isPostableLibraryFile,
  matchesLibraryFilter,
  mediaTypeForFileName,
  mediaTypeForMime,
  originalBasename,
  extensionOfName,
} from "./mediaTypes.ts";

Deno.test("frontend and edge allow-lists are the same file text", async () => {
  const edge = await Deno.readTextFile(new URL("./mediaTypes.ts", import.meta.url));
  const browser = await Deno.readTextFile(new URL("../../../src/lib/mediaTypes.ts", import.meta.url));
  assertEquals(edge, browser);
});

Deno.test("refuses excluded and unknown extensions, case-insensitively", () => {
  for (const name of ["run.EXE", "page.HTML", "page.htm", "note.XML", "clip.AVI", "payload.bin"]) {
    assertEquals(mediaTypeForFileName(name), null, name);
  }
  assertEquals(mediaTypeForFileName("ANIM.GIF")?.storedFileType, "image");
  assertEquals(mediaTypeForFileName("ANIM.GIF")?.mime, "image/gif");
  assertEquals(mediaTypeForFileName("x.CSV")?.mime, "text/csv");
  assertEquals(mediaTypeForFileName("x.CSV")?.storedFileType, "document");
});

Deno.test("every kind is capped at 10 MiB and gif is stored as an image", () => {
  for (const entry of Object.values(MEDIA_TYPES)) {
    assertEquals(entry.maxBytes, MEDIA_DECODED_BYTE_CAP);
  }
  assertEquals(mediaTypeForMime("image/gif")?.entry.storedFileType, "image");
  assertEquals(dedupeEligible("document"), false);
  assertEquals(dedupeEligible("audio"), false);
  assertEquals(dedupeEligible("archive"), false);
  assertEquals(dedupeEligible("image"), true);
});

Deno.test("the post picker refuses a document", () => {
  assertEquals(isPostableLibraryFile({ file_type: "document", file_path: "notes.pdf", metadata: { kind: "document", original_filename: "notes.pdf" } }), false);
  assertEquals(isPostableLibraryFile({ file_type: "document", file_path: "pack.zip", metadata: { kind: "archive", original_filename: "pack.zip" } }), false);
  assertEquals(isPostableLibraryFile({ file_type: "audio", file_path: "voice.mp3" }), false);
  assertEquals(isPostableLibraryFile({ file_type: "image", file_path: "photo.jpg" }), true);
  assertEquals(matchesLibraryFilter({ file_type: "document", file_path: "pack.zip", metadata: { kind: "archive" } }, "archive"), true);
  assertEquals(matchesLibraryFilter({ file_type: "document", file_path: "notes.pdf", metadata: { original_filename: "notes.pdf" } }, "document"), true);
});

Deno.test("a local file name keeps '#' and '?', while a URL drops its query and fragment", () => {
  assertEquals(originalBasename("photo#1.jpg"), "photo#1.jpg");
  assertEquals(extensionOfName("photo#1.jpg"), "jpg");
  assertEquals(originalBasename("https://cdn.example/a/pic.png?token=1#x"), "pic.png");
});

Deno.test("only images (20 MB) and video (500 MB) have a direct upload cap", () => {
  const MB = 1024 * 1024;
  assertEquals(directUploadByteCap("image"), 20 * MB);
  assertEquals(directUploadByteCap("video"), 500 * MB);
  for (const kind of ["audio", "document", "archive"] as const) {
    assertEquals(directUploadByteCap(kind), null, kind);
    assertEquals(maxUploadBytesFor(kind), MEDIA_DECODED_BYTE_CAP, kind);
  }
  assertEquals(maxUploadBytesFor("video"), 500 * MB);
  assertEquals(formatUploadLimit(500 * MB), "500 MB");
});

Deno.test("files up to 10 MB keep the edge path; larger images and video go direct", () => {
  const MB = 1024 * 1024;
  assertEquals(needsDirectUpload("video", MEDIA_DECODED_BYTE_CAP), false);
  assertEquals(needsDirectUpload("video", MEDIA_DECODED_BYTE_CAP + 1), true);
  assertEquals(needsDirectUpload("video", 500 * MB + 1), false);
  assertEquals(needsDirectUpload("image", 20 * MB), true);
  assertEquals(needsDirectUpload("document", 11 * MB), false);
});
