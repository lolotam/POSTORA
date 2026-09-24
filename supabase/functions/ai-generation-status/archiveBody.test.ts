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
