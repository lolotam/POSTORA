import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { relayUploadTarget } from "./mediaRelay.ts";

Deno.test("the relay never invents .bin or another unknown suffix", () => {
  assertEquals(relayUploadTarget("https://cdn.example/files/photo.png?x=1").fileName, "photo.png");
  const sniffed = relayUploadTarget("https://cdn.example/download", "application/pdf");
  assertEquals(sniffed, { fileName: "download.pdf", fileType: "document" });
  const unknown = relayUploadTarget("payload.bin", "image/png");
  assertEquals(unknown.fileName, "payload.png");
  assertEquals(unknown.fileName.endsWith(".bin"), false);
  const bare = relayUploadTarget("clip.bin", null);
  assertEquals(bare.fileName.includes("."), false);
  assertEquals(relayUploadTarget("", "video/mp4", "abc").fileName, "abc.mp4");
});
