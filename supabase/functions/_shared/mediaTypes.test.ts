import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  MEDIA_DECODED_BYTE_CAP,
  MEDIA_TYPES,
  dedupeEligible,
  isPostableLibraryFile,
  matchesLibraryFilter,
  mediaTypeForFileName,
  mediaTypeForMime,
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
