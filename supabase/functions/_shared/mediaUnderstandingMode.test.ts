import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  MEDIA_UNDERSTANDING_MODES,
  resolveMediaUnderstandingMode,
} from "./mediaUnderstandingMode.ts";

Deno.test("an account that never chose reads as off", () => {
  // Money is spent per inbound item, so the absence of a choice is not consent.
  assertEquals(resolveMediaUnderstandingMode(null), "off");
  assertEquals(resolveMediaUnderstandingMode(undefined), "off");
  assertEquals(resolveMediaUnderstandingMode({}), "off");
  assertEquals(resolveMediaUnderstandingMode({ other_key: "audio" }), "off");
});

Deno.test("every declared mode survives a round trip", () => {
  for (const mode of MEDIA_UNDERSTANDING_MODES) {
    assertEquals(resolveMediaUnderstandingMode({ media_understanding: mode }), mode);
  }
});

Deno.test("an unrecognised stored value falls back to off rather than throwing", () => {
  // A typo in the column must not start spending money, and must not break the
  // inbox either -- this runs on every inbound message.
  assertEquals(resolveMediaUnderstandingMode({ media_understanding: "audio+video" }), "off");
  assertEquals(resolveMediaUnderstandingMode({ media_understanding: true }), "off");
  assertEquals(resolveMediaUnderstandingMode({ media_understanding: 1 }), "off");
  assertEquals(resolveMediaUnderstandingMode({ media_understanding: "" }), "off");
});

Deno.test("a non-object metadata value cannot crash the resolver", () => {
  assertEquals(resolveMediaUnderstandingMode("audio"), "off");
  assertEquals(resolveMediaUnderstandingMode(42), "off");
});
