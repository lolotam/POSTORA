// deno-lint-ignore-file no-import-prefix
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { describeImageFailure } from "./imageFailure.ts";

for (const [message, code] of [
  ["All image providers failed: credits", "ai_not_configured"],
  ["missing key", "ai_not_configured"],
  ["unsupported provider", "ai_provider_unsupported"],
  ["credits", "ai_credits_exhausted"],
  ["rate limit", "ai_rate_limited"],
  ["did not return an image", "ai_no_image"],
  ["no image", "ai_no_image"],
  ["empty response", "ai_gateway_empty"],
  ["gateway", "ai_gateway_error"],
  ["Google API", "ai_gateway_error"],
  ["unexpected", "ai_error"],
]) {
  Deno.test(`failure mapping: ${message}`, () => {
    assertEquals(describeImageFailure(message).code, code);
  });
}
