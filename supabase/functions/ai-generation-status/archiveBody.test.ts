// deno-lint-ignore-file no-import-prefix
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { archiveBody } from "./archiveBody.ts";

const job = { id: "j1", provider: "vercel", modality: "video" };
Deno.test("hosted result uploads by URL", () => {
  assertEquals(archiveBody(job, { outputUrl: "https://cdn/x.mp4", outputBase64: null }),
    { externalUrl: "https://cdn/x.mp4", fileName: "vercel-j1.mp4", fileType: "video" });
});
Deno.test("inline result uploads the bytes", () => {
  assertEquals(archiveBody(job, { outputUrl: null, outputBase64: "AAAA" }),
    { fileData: "AAAA", fileName: "vercel-j1.mp4", fileType: "video" });
});
Deno.test("higgsfield images keep their png name", () => {
  assertEquals(archiveBody({ id: "j2", provider: "higgsfield", modality: "image" }, { outputUrl: "u" }).fileName, "higgsfield-j2.png");
});

// Each row is [output media type, modality, expected file extension].
const EXTENSIONS: Array<[string | null | undefined, string, string]> = [
  ["video/mp4", "video", "mp4"],
  ["video/webm", "video", "webm"],
  ["video/quicktime", "video", "mov"],
  ["image/png", "image", "png"],
  ["image/jpeg", "image", "jpg"],
  ["image/webp", "image", "webp"],
  ["VIDEO/WEBM; codecs=vp9", "video", "webm"],
  ["application/octet-stream", "video", "mp4"],
  ["application/octet-stream", "image", "png"],
  [null, "video", "mp4"],
  [undefined, "image", "png"],
];

Deno.test("the archive file extension follows the output media type", async (t) => {
  for (const [mediaType, modality, ext] of EXTENSIONS) {
    await t.step(`${mediaType} (${modality}) -> .${ext}`, () => {
      const body = archiveBody({ id: "j3", provider: "vercel", modality }, { outputUrl: "u", outputMediaType: mediaType });
      assertEquals(body.fileName, `vercel-j3.${ext}`);
    });
  }
});
