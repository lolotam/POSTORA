import { describe, expect, it } from "vitest";
import {
  collectReferences,
  isPublicHttpsUrl,
  parseDataUrl,
} from "../../../supabase/functions/_shared/image-references";

// The dialog sends objects, not strings, and uploads arrive as data URLs
// hundreds of kilobytes long. The schema declared strings capped at 500
// characters, so every request carrying a real upload was rejected with a 400
// before generation was even attempted.
describe("collectReferences", () => {
  it("keeps the type and order the dialog assigned", () => {
    const out = collectReferences(undefined, [
      { url: "https://cdn/a.png", type: "content", priority: 1 },
      { url: "https://cdn/b.png", type: "image-to-image", priority: 2 },
    ]);
    expect(out).toEqual([
      { url: "https://cdn/a.png", type: "content", priority: 1 },
      { url: "https://cdn/b.png", type: "image-to-image", priority: 2 },
    ]);
  });

  it("defaults a missing type and priority from position", () => {
    const out = collectReferences(undefined, [{ url: "https://cdn/a.png" }, { url: "https://cdn/b.png" }]);
    expect(out).toEqual([
      { url: "https://cdn/a.png", type: "style", priority: 1 },
      { url: "https://cdn/b.png", type: "style", priority: 2 },
    ]);
  });

  // The YouTube thumbnail dialog sends only this field.
  it("accepts the single-image field on its own", () => {
    expect(collectReferences("data:image/png;base64,AAA", undefined)).toEqual([
      { url: "data:image/png;base64,AAA", type: "style", priority: 1 },
    ]);
  });

  // ImageGenerator sends both, with referenceImage a copy of the first entry.
  it("ignores the single field when the array is present, rather than duplicating", () => {
    const out = collectReferences("https://cdn/a.png", [
      { url: "https://cdn/a.png", type: "style", priority: 1 },
    ]);
    expect(out).toHaveLength(1);
  });

  it("returns nothing when no reference was attached", () => {
    expect(collectReferences(undefined, undefined)).toEqual([]);
    expect(collectReferences(undefined, [])).toEqual([]);
  });
});

describe("parseDataUrl", () => {
  it("splits a base64 data URL into mime type and payload", () => {
    expect(parseDataUrl("data:image/jpeg;base64,QUJD")).toEqual({
      mimeType: "image/jpeg",
      base64: "QUJD",
    });
  });

  it("returns null for anything that is not one", () => {
    expect(parseDataUrl("https://cdn/a.png")).toBeNull();
    expect(parseDataUrl("data:image/png,notbase64")).toBeNull();
  });
});

// Reference URLs come from the request body, so fetching one unchecked would
// let a caller aim this at the internal network.
describe("isPublicHttpsUrl", () => {
  it("accepts a public https URL", () => {
    expect(isPublicHttpsUrl("https://images.pexels.com/photo.jpg")).toBe(true);
  });

  it.each([
    "http://images.pexels.com/photo.jpg",
    "https://localhost/photo.jpg",
    "https://127.0.0.1/photo.jpg",
    "https://10.0.0.5/photo.jpg",
    "https://192.168.1.10/photo.jpg",
    "https://172.16.0.1/photo.jpg",
    "https://169.254.169.254/latest/meta-data/",
    "https://[::1]/photo.jpg",
    "file:///etc/passwd",
    "not a url",
  ])("rejects %s", (url) => {
    expect(isPublicHttpsUrl(url)).toBe(false);
  });

  // 172.32 is outside the private block and must not be caught by the prefix.
  it("does not reject a public address that merely starts with 172", () => {
    expect(isPublicHttpsUrl("https://172.32.0.1/photo.jpg")).toBe(true);
  });

  // A trailing dot is the absolute-FQDN spelling and resolves identically, so
  // a check written against "localhost" has to fold it in first.
  it.each([
    "https://localhost./photo.jpg",
    "https://LOCALHOST/photo.jpg",
    "https://something.localhost/photo.jpg",
    "https://127.0.0.1./photo.jpg",
  ])("rejects the alternate spelling %s", (url) => {
    expect(isPublicHttpsUrl(url)).toBe(false);
  });

  // Ranges beyond the obvious ones that still reach internal services.
  it.each([
    "https://0.0.0.0/photo.jpg",
    "https://100.64.0.1/photo.jpg",
    "https://224.0.0.1/photo.jpg",
    "https://[fd00::1]/photo.jpg",
    "https://[fe80::1]/photo.jpg",
    "https://[::ffff:169.254.169.254]/photo.jpg",
  ])("rejects %s", (url) => {
    expect(isPublicHttpsUrl(url)).toBe(false);
  });

  it("still accepts ordinary public hosts and addresses", () => {
    expect(isPublicHttpsUrl("https://8.8.8.8/photo.jpg")).toBe(true);
    expect(isPublicHttpsUrl("https://res.cloudinary.com/demo/a.png")).toBe(true);
    expect(isPublicHttpsUrl("https://api.postora.cloud/storage/v1/object/sign/media/a.png?token=x")).toBe(true);
  });
});
