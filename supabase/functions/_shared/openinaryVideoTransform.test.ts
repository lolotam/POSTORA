import { assertEquals, assertThrows } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  cloudinaryCompressTransformation,
  cloudinaryCropTransformation,
  cloudinaryTranscodeTransformation,
  evenDimension,
  MAX_TARGET_DIMENSION,
  OpeninaryVideoError,
  parseDimensions,
  planCompress,
  planCrop,
  planTranscode,
  qualityTier,
} from "./openinaryVideoTransform.ts";

const FHD = { width: 1920, height: 1080 };

function refusal(fn: () => unknown, code: string): OpeninaryVideoError {
  const error = assertThrows(fn, OpeninaryVideoError);
  assertEquals(error.code, code);
  return error;
}

Deno.test("a centred 9:16 box on a 16:9 video crops to the box's own pixels in one cover step", () => {
  // MediaCropper: full height, width (9/16)/(16/9)*100 = 31.640625 %, x centred.
  const plan = planCrop({ x: 34.1796875, y: 0, width: 31.640625, height: 100, targetWidth: 540, targetHeight: 960 }, FHD);
  // 31.640625 % of 1920 = 607.5 -> 608; cover-scaling 1920x1080 to 608x1080 leaves scale 1.
  assertEquals(plan.segment, "w_608,h_1080,c_fill,q_60,f_mp4");
  assertEquals(plan.output, { width: 608, height: 1080 });
});

Deno.test("a centred crop smaller than its target is upscaled to the target in the same step", () => {
  const plan = planCrop({ x: 34.1796875, y: 0, width: 31.640625, height: 100, targetWidth: 1080, targetHeight: 1920 }, FHD);
  assertEquals(plan.segment, "w_1080,h_1920,c_fill,q_60,f_mp4");
});

Deno.test("a crop already as large as the target keeps its own size (Cloudinary only scaled up)", () => {
  const plan = planCrop({ x: 34.1796875, y: 0, width: 31.640625, height: 100, targetWidth: 540, targetHeight: 960 }, FHD);
  assertEquals(plan.output, { width: 608, height: 1080 });
});

Deno.test("a centred full-width box on a tall video crops the height", () => {
  const plan = planCrop({ x: 0, y: 21.875, width: 100, height: 56.25 }, { width: 1080, height: 1920 });
  // 56.25 % of 1920 = 1080
  assertEquals(plan.segment, "w_1080,h_1080,c_fill,q_60,f_mp4");
});

Deno.test("the full frame is a plain re-encode at the source size", () => {
  assertEquals(planCrop({ x: 0, y: 0, width: 100, height: 100 }, FHD).segment, "w_1920,h_1080,c_fill,q_60,f_mp4");
});

Deno.test("a narrow vertical crop with no target is auto-upscaled to 720 wide like before", () => {
  const plan = planCrop({ x: 34.1796875, y: 0, width: 31.640625, height: 100 }, { width: 1280, height: 720 });
  // box = 405 x 720 (ratio 0.5625 < 0.7, width < 720) -> 720 x 1280
  assertEquals(plan.output, { width: 720, height: 1280 });
  assertEquals(plan.segment, "w_720,h_1280,c_fill,q_60,f_mp4");
});

Deno.test("a box dragged off centre is refused, not approximated", () => {
  const error = refusal(() => planCrop({ x: 0, y: 0, width: 31.640625, height: 100 }, FHD), "UNSUPPORTED_CROP_REGION");
  assertEquals(error.status, 422);
});

Deno.test("a box that spans neither the full width nor the full height is refused", () => {
  refusal(() => planCrop({ x: 25, y: 25, width: 50, height: 50 }, FHD), "UNSUPPORTED_CROP_REGION");
});

Deno.test("a box a hair off centre still counts as centred", () => {
  // 0.2 % of the frame width off: inside the 0.5 % tolerance
  const plan = planCrop({ x: 34.38, y: 0, width: 31.640625, height: 100, targetWidth: 540, targetHeight: 960 }, FHD);
  assertEquals(plan.output, { width: 608, height: 1080 });
});

Deno.test("a crop whose shape does not match the upscale target is refused", () => {
  // 1:1 box asked to become 9:16
  refusal(() => planCrop({ x: 21.875, y: 0, width: 56.25, height: 100, targetWidth: 1080, targetHeight: 1920 }, FHD), "UNSUPPORTED_CROP_TARGET");
});

Deno.test("a crop cannot be sized without the source dimensions", () => {
  refusal(() => planCrop({ x: 0, y: 0, width: 100, height: 100 }, null), "SOURCE_DIMENSIONS_UNKNOWN");
});

Deno.test("malformed crop input is an invalid request", () => {
  refusal(() => planCrop({ x: NaN, y: 0, width: 100, height: 100 }, FHD), "INVALID_REQUEST");
  refusal(() => planCrop({ x: 50, y: 0, width: 100, height: 100 }, FHD), "INVALID_REQUEST");
  refusal(() => planCrop({ x: 0, y: 0, width: 100, height: 100, targetWidth: -1, targetHeight: 10 }, FHD), "INVALID_REQUEST");
});

Deno.test("small x/y percentages are percentages, not fractions", () => {
  // The old heuristic read 0.3 as 30 %; 0.3 % is simply a centred-enough full frame edge here.
  const plan = planCrop({ x: 0.3, y: 0, width: 99.5, height: 100 }, FHD);
  assertEquals(plan.output, { width: 1920, height: 1080 });
});

Deno.test("compress keeps the source resolution with even dimensions and maps the quality tier", () => {
  assertEquals(planCompress({ quality: 90 }, { width: 1921, height: 1081 }).segment, "w_1920,h_1080,c_scale,q_80,f_mp4");
  assertEquals(planCompress({ quality: 60 }, FHD).segment, "w_1920,h_1080,c_scale,q_60,f_mp4");
  assertEquals(planCompress({ quality: 20 }, FHD).segment, "w_1920,h_1080,c_scale,q_40,f_mp4");
});

Deno.test("compress without known dimensions says Openinary will cap at 720p", () => {
  const plan = planCompress({ quality: 60 }, null);
  assertEquals(plan.segment, "q_60,f_mp4");
  assertEquals(plan.warnings.length, 1);
});

Deno.test("compress rejects a non-numeric quality and a non-positive size target", () => {
  refusal(() => planCompress({ quality: "high" as unknown as number }, FHD), "INVALID_REQUEST");
  refusal(() => planCompress({ quality: 50, maxSizeMB: 0 }, FHD), "INVALID_REQUEST");
});

Deno.test("transcode presets", () => {
  assertEquals(planTranscode("tiktok").segment, "w_720,h_1280,c_fill,q_80,f_mp4");
  assertEquals(planTranscode("instagram").segment, "w_1080,h_1920,c_fill,q_80,f_mp4");
  assertEquals(planTranscode("youtube").segment, "w_1920,h_1080,c_fill,q_80,f_mp4");
  assertEquals(planTranscode(undefined).platform, "tiktok");
  refusal(() => planTranscode("myspace"), "INVALID_REQUEST");
});

Deno.test("helpers", () => {
  assertEquals(evenDimension(607.5), 606);
  assertEquals(evenDimension(1), 2);
  assertEquals(qualityTier(5), "eco");
  assertEquals(qualityTier(50), "good");
  assertEquals(qualityTier(80), "best");
  assertEquals(parseDimensions({ width: 1920.4, height: 1080 }), { width: 1920, height: 1080 });
  assertEquals(parseDimensions({ width: 0, height: 10 }), null);
  assertEquals(parseDimensions({ width: 99999, height: 10 }), null);
  assertEquals(parseDimensions("1920x1080"), null);
});

Deno.test("cloudinary fallback strings keep the old eager transformations", () => {
  assertEquals(cloudinaryCompressTransformation({ quality: 60 }), "vc_h264,q_auto:good,f_mp4");
  assertEquals(cloudinaryCompressTransformation({ quality: 90, maxSizeMB: 8 }), "vc_h264,br_500k,q_auto:best,f_mp4");
  assertEquals(cloudinaryCompressTransformation({ quality: 30, maxSizeMB: 20 }), "vc_h264,br_1000k,q_auto:eco,f_mp4");
  assertEquals(cloudinaryCompressTransformation({ quality: 30, maxSizeMB: 40 }), "vc_h264,br_2000k,q_auto:eco,f_mp4");
  assertEquals(cloudinaryCompressTransformation({ quality: 30, maxSizeMB: 60 }), "vc_h264,q_auto:eco,f_mp4");
  assertEquals(
    cloudinaryCropTransformation({ x: 25, y: 0, width: 50, height: 100, targetWidth: 1080, targetHeight: 1920 }, FHD),
    "c_crop,x_480,y_0,w_960,h_1080/c_scale,w_1080,h_1920/vc_h264,q_auto:good,f_mp4",
  );
  assertEquals(
    cloudinaryCropTransformation({ x: 25, y: 0, width: 50, height: 100 }, null),
    "c_crop,fl_relative,x_0.25,y_0,w_0.5,h_1/vc_h264,q_auto:good,f_mp4",
  );
  assertEquals(cloudinaryTranscodeTransformation("youtube"), "c_fill,w_1920,h_1080,ar_16:9,g_center/vc_h264,q_auto:best,f_mp4");
  assertEquals(cloudinaryTranscodeTransformation("tiktok"), "c_fill,w_720,h_1280,ar_9:16,g_center/vc_h264,q_auto:best,f_mp4");
});

Deno.test("crop target sizes must be whole numbers within the bound", () => {
  const box = { x: 34.1796875, y: 0, width: 31.640625, height: 100 };
  refusal(() => planCrop({ ...box, targetWidth: 1080.5, targetHeight: 1920 }, FHD), "INVALID_REQUEST");
  refusal(() => planCrop({ ...box, targetWidth: 1080, targetHeight: 100_000 }, FHD), "INVALID_REQUEST");
  refusal(() => planCrop({ ...box, targetWidth: MAX_TARGET_DIMENSION + 1, targetHeight: 1920 }, FHD), "INVALID_REQUEST");
  refusal(() => planCrop({ ...box, targetWidth: 0, targetHeight: 1920 }, FHD), "INVALID_REQUEST");
  refusal(() => cloudinaryCropTransformation({ ...box, targetWidth: 1e9, targetHeight: 1e9 }, FHD), "INVALID_REQUEST");
  // the bound itself is allowed
  assertEquals(planCrop({ ...box, targetWidth: 2304, targetHeight: MAX_TARGET_DIMENSION }, FHD).output?.height, MAX_TARGET_DIMENSION);
});

Deno.test("inherited object keys are not transcode presets", () => {
  for (const key of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"]) {
    refusal(() => planTranscode(key), "INVALID_REQUEST");
  }
});

Deno.test("a crop target needs both its width and its height", () => {
  const box = { x: 34.1796875, y: 0, width: 31.640625, height: 100 };
  refusal(() => planCrop({ ...box, targetWidth: 1080 }, FHD), "INVALID_REQUEST");
  refusal(() => planCrop({ ...box, targetHeight: 1920 }, FHD), "INVALID_REQUEST");
  refusal(() => cloudinaryCropTransformation({ ...box, targetWidth: 1080 }, FHD), "INVALID_REQUEST");
});

Deno.test("a sliver of a crop is refused instead of upscaled to an absurd or infinite size", () => {
  // 0.01 % of 1920 rounds to 0 pixels wide: the auto-upscale used to divide by zero
  refusal(() => planCrop({ x: 49.995, y: 0, width: 0.01, height: 100 }, FHD), "INVALID_REQUEST");
  refusal(() => cloudinaryCropTransformation({ x: 49.995, y: 0, width: 0.01, height: 100 }, FHD), "INVALID_REQUEST");
  // 20 px wide on a 4320 px tall source would upscale to 720 x 155520
  refusal(() => planCrop({ x: 49.87, y: 0, width: 0.26, height: 100 }, { width: 7680, height: 4320 }), "INVALID_REQUEST");
  // an untouched 8K full frame keeps its own size
  assertEquals(planCrop({ x: 0, y: 0, width: 100, height: 100 }, { width: 7680, height: 4320 }).output, { width: 7680, height: 4320 });
});
