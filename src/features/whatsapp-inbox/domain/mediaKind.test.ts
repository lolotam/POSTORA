import { describe, expect, it } from "vitest";
import { resolveMediaKind } from "./mediaKind";

describe("resolveMediaKind", () => {
  it("passes image/video/audio through", () => {
    expect(resolveMediaKind({ kind: "image", name: null, mime_type: null })).toBe("image");
    expect(resolveMediaKind({ kind: "video", name: null, mime_type: null })).toBe("video");
    expect(resolveMediaKind({ kind: "audio", name: null, mime_type: null })).toBe("audio");
  });

  it("detects pdf by resolved mime, then stored mime, then name", () => {
    expect(resolveMediaKind({ kind: "document", name: "a.zip", mime_type: null }, "application/pdf")).toBe("pdf");
    expect(resolveMediaKind({ kind: "document", name: "a.pdf", mime_type: null }, "application/zip")).toBe("document");
    expect(resolveMediaKind({ kind: "document", name: null, mime_type: "application/pdf; charset=x" })).toBe("pdf");
    expect(resolveMediaKind({ kind: "document", name: "Receipt.PDF", mime_type: null })).toBe("pdf");
    expect(resolveMediaKind({ kind: "document", name: "a.docx", mime_type: null })).toBe("document");
  });
});
