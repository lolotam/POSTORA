import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { encodeOpeninaryPath, extensionForContentType, openinaryTarget, shouldAdoptOpeninaryFile } from "./openinary.ts";

Deno.test("derives deterministic target under postora.cloud", () => assertEquals(openinaryTarget("users/u/photo", "postora.cloud"), { folder:"postora.cloud/users/u", baseName:"photo" }));
Deno.test("derives extension from content type", () => { assertEquals(extensionForContentType("image/jpeg; charset=binary"), "jpg"); assertEquals(extensionForContentType("application/octet-stream"), null); });
Deno.test("encodes each path segment", () => assertEquals(encodeOpeninaryPath("postora.cloud/a/probe (1).png"), "postora.cloud/a/probe%20(1).png"));
Deno.test("collision text identifies drift", () => assertStringIncludes("Openinary stored x instead of requested y (collision rename)", "collision rename"));
Deno.test("adopts only the exact path with the expected byte count", () => {
  assertEquals(shouldAdoptOpeninaryFile({ name:"a.png", path:"f/a.png", size:12 }, "f/a.png", 12), true);
  assertEquals(shouldAdoptOpeninaryFile({ name:"a.png", path:"f/a (1).png", size:12 }, "f/a.png", 12), false);
  assertEquals(shouldAdoptOpeninaryFile({ name:"a.png", path:"f/a.png", size:11 }, "f/a.png", 12), false);
});
