import { describe, expect, it } from "vitest";
import { chunkRanges, combinedProgress, contentRangeHeader } from "../domain/chunks";

describe("chunkRanges", () => {
  it("covers the file in order with a short last chunk", () => {
    expect(chunkRanges(45, 20)).toEqual([
      { start: 0, end: 20 },
      { start: 20, end: 40 },
      { start: 40, end: 45 },
    ]);
  });

  it("is one range for a file no bigger than a chunk, and none for an empty file", () => {
    expect(chunkRanges(20, 20)).toEqual([{ start: 0, end: 20 }]);
    expect(chunkRanges(0, 20)).toEqual([]);
  });
});

describe("contentRangeHeader", () => {
  it("uses an inclusive end the way Cloudinary expects", () => {
    expect(contentRangeHeader({ start: 20, end: 40 }, 45)).toBe("bytes 20-39/45");
  });
});

describe("combinedProgress", () => {
  it("splits the bar evenly between providers uploaded one after another", () => {
    expect(combinedProgress([0.5, 0])).toBe(25);
    expect(combinedProgress([1, 0.5])).toBe(75);
    expect(combinedProgress([1])).toBe(100);
    expect(combinedProgress([2, -1])).toBe(50);
    expect(combinedProgress([])).toBe(0);
  });
});
