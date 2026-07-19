import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { getMissingMediaFileIds } from "./post-media.ts";

Deno.test("getMissingMediaFileIds returns post media that no longer exists", () => {
  const missingIds = getMissingMediaFileIds(
    ["first-image", "second-image", "third-image"],
    [{ id: "first-image" }, { id: "third-image" }],
  );

  assertEquals(missingIds, ["second-image"]);
});
