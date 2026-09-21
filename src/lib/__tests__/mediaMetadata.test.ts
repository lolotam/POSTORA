import { describe, expect, it } from "vitest";
import { mergeHealedDimensions } from "../mediaMetadata";

// Regression, 2026-09-21: healing used to send `{ width, height }` straight to
// PostgREST, which replaces the whole JSONB column. Opening the media Library
// destroyed `format`, `duration` and `original_filename` on 47 production rows
// across 2 accounts, so the keys the upload path writes are the ones this has to
// keep. See docs/devtools-audit.md finding F1.
describe("mergeHealedDimensions", () => {
  it("keeps every key the upload path wrote alongside the dimensions", () => {
    const existing = {
      width: null,
      height: null,
      format: "png",
      duration: null,
      original_filename: "app_logo",
    };

    expect(mergeHealedDimensions(existing, 500, 500)).toEqual({
      width: 500,
      height: 500,
      format: "png",
      duration: null,
      original_filename: "app_logo",
    });
  });

  it("keeps keys it does not know about", () => {
    expect(mergeHealedDimensions({ alt_text: "a cat" }, 8, 9)).toEqual({
      alt_text: "a cat",
      width: 8,
      height: 9,
    });
  });

  it("writes dimensions onto a row that has no metadata yet", () => {
    expect(mergeHealedDimensions(null, 1024, 768)).toEqual({ width: 1024, height: 768 });
    expect(mergeHealedDimensions(undefined, 1024, 768)).toEqual({ width: 1024, height: 768 });
  });

  it("does not mutate the metadata it was given", () => {
    const existing = { format: "jpg", width: null };
    mergeHealedDimensions(existing, 10, 20);
    expect(existing).toEqual({ format: "jpg", width: null });
  });
});
