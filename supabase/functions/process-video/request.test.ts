import { assertEquals, assertThrows } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { OpeninaryVideoError } from "../_shared/openinaryVideoTransform.ts";
import { parseProcessVideoRequest } from "./request.ts";

function invalid(body: unknown): string {
  const error = assertThrows(() => parseProcessVideoRequest(body), OpeninaryVideoError);
  assertEquals(error.code, "INVALID_REQUEST");
  assertEquals(error.status, 400);
  return error.message;
}

Deno.test("the crop request MediaCropper sends is accepted", () => {
  const parsed = parseProcessVideoRequest({
    media_file_id: "m1",
    user_id: "u1",
    operation: "crop",
    crop: { x: 34.18, y: 0, width: 31.64, height: 100, targetWidth: 1080, targetHeight: 1920 },
    source_dimensions: { width: 1920, height: 1080 },
  });
  assertEquals(parsed.crop?.targetWidth, 1080);
  assertEquals(parsed.source_dimensions, { width: 1920, height: 1080 });
});

Deno.test("a crop without target resolution (undefined fields are dropped by JSON) is accepted", () => {
  const parsed = parseProcessVideoRequest({ media_file_id: "m1", operation: "crop", crop: { x: 0, y: 0, width: 100, height: 100 } });
  assertEquals(parsed.crop?.targetWidth, undefined);
});

Deno.test("the compress request VideoCompressor sends is accepted, including a null size target", () => {
  const percent = parseProcessVideoRequest({ media_file_id: "m1", user_id: "u1", operation: "compress", compress: { quality: 60, maxSizeMB: null } });
  assertEquals(percent.compress?.maxSizeMB, undefined);
  const sized = parseProcessVideoRequest({ media_file_id: "m1", operation: "compress", compress: { quality: 40, maxSizeMB: 8 } });
  assertEquals(sized.compress?.maxSizeMB, 8);
});

Deno.test("get_metadata needs no settings", () => {
  assertEquals(parseProcessVideoRequest({ media_file_id: "m1", operation: "get_metadata" }).operation, "get_metadata");
});

Deno.test("malformed requests are an invalid request that names the field", () => {
  assertEquals(invalid(null).startsWith("Invalid request"), true);
  assertEquals(invalid({ operation: "crop", crop: { x: 0, y: 0, width: 1, height: 1 } }).includes("media_file_id"), true);
  assertEquals(invalid({ media_file_id: "m1", operation: "rotate" }).includes("operation"), true);
  assertEquals(invalid({ media_file_id: "m1", operation: "crop" }).includes("crop"), true);
  assertEquals(invalid({ media_file_id: "m1", operation: "compress" }).includes("compress"), true);
  assertEquals(invalid({ media_file_id: "m1", operation: "crop", crop: { x: "0", y: 0, width: 1, height: 1 } }).includes("crop.x"), true);
});
