import { describe, expect, it } from "vitest";
import { sortRows } from "../sortRows";

describe("sortRows", () => {
  const rows = [
    { id: "a", value: 2, label: "10" },
    { id: "b", value: null, label: "2" },
    { id: "c", value: -1, label: "2" },
    { id: "d", value: Number.NaN, label: null },
  ];

  it("sorts numbers and numeric strings with stable ties", () => {
    expect(sortRows(rows, (row) => row.value, "ascending").map((row) => row.id)).toEqual(["c", "a", "b", "d"]);
    expect(sortRows(rows, (row) => row.value, "descending").map((row) => row.id)).toEqual(["a", "c", "b", "d"]);
    expect(sortRows(rows, (row) => row.label, "ascending").map((row) => row.id)).toEqual(["b", "c", "a", "d"]);
  });

  it("accepts a locale collator", () => {
    const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });
    expect(sortRows(rows, (row) => row.label, "descending", collator).map((row) => row.id)).toEqual(["a", "b", "c", "d"]);
  });
});
