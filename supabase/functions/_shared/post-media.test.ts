import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { getMissingMediaFileIds, orderPostMediaFiles } from "./post-media.ts";

Deno.test("getMissingMediaFileIds returns post media that no longer exists", () => {
  const missingIds = getMissingMediaFileIds(
    ["first-image", "second-image", "third-image"],
    [{ id: "first-image" }, { id: "third-image" }],
  );

  assertEquals(missingIds, ["second-image"]);
});

Deno.test("post media follows the saved carousel order instead of database row order", () => {
  const rows = [
    { id: "third", url: "third.jpg" },
    { id: "first", url: "first.jpg" },
    { id: "second", url: "second.jpg" },
  ];
  assertEquals(orderPostMediaFiles(["first", "second", "third"], rows).map(row => row.url),
    ["first.jpg", "second.jpg", "third.jpg"]);
  assertEquals(rows.map(row => row.id), ["third", "first", "second"]);
});

Deno.test("reordering media preserves requested repetitions and does not hide missing references", () => {
  const ids = ["second", "missing", "first", "second"];
  const ordered = orderPostMediaFiles(ids, [{ id: "first" }, { id: "second" }, { id: "unrelated" }]);
  assertEquals(ordered.map(row => row.id), ["second", "first", "second"]);
  assertEquals(getMissingMediaFileIds(ids, ordered), ["missing"]);
  assertEquals(orderPostMediaFiles([], [{ id: "unrelated" }]), []);
});
