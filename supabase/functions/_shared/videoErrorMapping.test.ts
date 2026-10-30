import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { MediaQuotaRefusal } from "./derivedVideoMedia.ts";
import { OpeninaryVideoError } from "./openinaryVideoTransform.ts";
import { mapVideoFailure } from "./videoErrorMapping.ts";

Deno.test("an expected refusal keeps its code, message and status", () => {
  const reply = mapVideoFailure(new OpeninaryVideoError("UNSUPPORTED_CROP_REGION", "Move the box to the centre."));
  assertEquals(reply.status, 422);
  assertEquals(reply.body, { success: false, error: "Move the box to the centre.", error_code: "UNSUPPORTED_CROP_REGION" });
  assertEquals(reply.logLevel, "warn");
});

Deno.test("a still-processing refusal is retryable (503)", () => {
  assertEquals(mapVideoFailure(new OpeninaryVideoError("TRANSFORM_STILL_PROCESSING", "later")).status, 503);
});

Deno.test("a quota refusal is a 429 with the shared quota code", () => {
  const reply = mapVideoFailure(new MediaQuotaRefusal("MEDIA_QUOTA_DAILY_EXCEEDED: Daily upload limit of 5 reached."));
  assertEquals(reply.status, 429);
  assertEquals(reply.body.error_code, "MEDIA_QUOTA_DAILY_EXCEEDED");
  assertEquals(reply.body.error, "Daily upload limit of 5 reached.");
});

Deno.test("an unexpected error never leaks its message to the client", () => {
  const reply = mapVideoFailure(new Error('relation "media_files" does not exist at /srv/app.ts:12'));
  assertEquals(reply.status, 500);
  assertEquals(reply.logLevel, "error");
  assert(!reply.body.error.includes("media_files"));
  assertEquals(reply.body.error_code, "PROCESSING_ERROR");
});
