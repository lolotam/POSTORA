import { describe, it, expect } from "vitest";
import { getMediaThumbnailUrl, resolveMediaPublicUrl, transformMediaUrl } from "../mediaUrl";

/**
 * Regression coverage for the broken-media-link incident (2026-06-20):
 * editing a scheduled post rebuilt Cloudinary URLs from `storage_bucket`
 * (the literal "cloudinary") + `cloudinary_public_id`, producing 404s.
 * The real cloud name, version segment, and extension live ONLY in the
 * `secure_url` already stored in `file_path`, which we now return verbatim.
 */
describe("resolveMediaPublicUrl", () => {
  it("uses provider rows authoritatively for the current version", () => {
    const row = { file_path: "legacy.png", current_object_version: 2 };
    expect(resolveMediaPublicUrl(row, undefined, [{ object_version: 2, provider: "openinary", status: "ready", delivery_url: "https://cdn/x.png" }], { read_preference: "openinary" })).toBe("https://cdn/x.png");
    expect(resolveMediaPublicUrl(row, undefined, [{ object_version: 2, provider: "openinary", status: "failed" }], { read_preference: "openinary" })).toBe("");
    expect(resolveMediaPublicUrl(row, undefined, [{ object_version: 2, provider: "openinary", status: "deleted", delivery_url: "https://cdn/deleted" }], { read_preference: "openinary" })).toBe("");
  });
  it("falls back to file_path only when no current-version rows exist", () => {
    const row = { file_path: "legacy.png", current_object_version: 3 };
    expect(resolveMediaPublicUrl(row, undefined, [], {})).toBe("legacy.png");
    expect(resolveMediaPublicUrl(row, undefined, [{ object_version: 2, provider: "openinary", status: "ready", delivery_url: "https://cdn/old" }], {})).toBe("legacy.png");
  });
  // A caller that forgets to SELECT current_object_version must not silently get
  // legacy behaviour: comparing version-1 rows against `undefined` would match
  // nothing and serve file_path, which is wrong after a rename or a delete. Both
  // sides default to 1, the column's DB default.
  it("treats a missing object_version as version 1 on both sides", () => {
    const rowWithoutVersion = { file_path: "legacy.png" };
    expect(
      resolveMediaPublicUrl(
        rowWithoutVersion,
        undefined,
        [{ provider: "openinary", status: "ready", delivery_url: "https://cdn/v1.png" }],
        { read_preference: "openinary" },
      ),
    ).toBe("https://cdn/v1.png");
    // ...and an authoritative delete on that same implicit version still wins.
    expect(
      resolveMediaPublicUrl(
        rowWithoutVersion,
        undefined,
        [{ object_version: 1, provider: "cloudinary", status: "deleted", delivery_url: "https://cdn/gone" }],
        { read_preference: "cloudinary" },
      ),
    ).toBe("");
  });
  describe("Cloudinary rows return file_path verbatim", () => {
    // Regression (Rule 6): each row is a real production record shape.
    // Before the fix these produced
    //   https://res.cloudinary.com/cloudinary/image/upload/<public_id>  (wrong cloud, no version, no ext)
    // and for video used /image/upload/ instead of /video/upload/.
    it.each([
      [
        "image",
        {
          file_path:
            "https://res.cloudinary.com/dur1soa8n/image/upload/v1781951136/media/user/2026-06-20/postora-logo.png",
          storage_bucket: "cloudinary",
          cloudinary_public_id: "media/user/2026-06-20/postora-logo",
        },
      ],
      [
        "video",
        {
          file_path:
            "https://res.cloudinary.com/dur1soa8n/video/upload/v1781356757/media/user/2026-06-13/clip.mp4",
          storage_bucket: "cloudinary",
          cloudinary_public_id: "media/user/2026-06-13/clip",
        },
      ],
      [
        "image detected by URL even when bucket is missing",
        {
          file_path:
            "https://res.cloudinary.com/dur1soa8n/image/upload/v1781133761/media/user/photo.jpg",
          storage_bucket: null,
          cloudinary_public_id: "media/user/photo",
        },
      ],
    ])("returns the full secure_url for a %s row without rebuilding it", (_label, row) => {
      const result = resolveMediaPublicUrl(row);

      // Returns file_path exactly — never reconstructed.
      expect(result).toBe(row.file_path);
      // Must carry the real cloud name, version segment, and extension
      // (all three were missing in the buggy rebuild).
      expect(result).toContain("/dur1soa8n/");
      expect(result).toMatch(/\/v\d+\//);
      expect(result).toMatch(/\.(png|jpg|mp4)$/i);
    });
  });

  describe("Supabase Storage paths go through the injected resolver", () => {
    it("resolves an object path using storage_bucket and falls back to 'media'", () => {
      const seen: Array<{ bucket: string; path: string }> = [];
      const resolver = (bucket: string, path: string) => {
        seen.push({ bucket, path });
        return `https://example.supabase.co/storage/v1/object/public/${bucket}/${path}`;
      };

      // Explicit bucket
      const explicit = resolveMediaPublicUrl(
        { file_path: "uploads/img.png", storage_bucket: "user-media" },
        resolver,
      );
      expect(explicit).toBe(
        "https://example.supabase.co/storage/v1/object/public/user-media/uploads/img.png",
      );

      // Missing bucket -> default "media"
      const defaulted = resolveMediaPublicUrl({ file_path: "uploads/img.png" }, resolver);
      expect(defaulted).toBe(
        "https://example.supabase.co/storage/v1/object/public/media/uploads/img.png",
      );
      expect(seen[1].bucket).toBe("media");
    });

    it("returns the raw path when no resolver is provided", () => {
      const result = resolveMediaPublicUrl({ file_path: "uploads/img.png" });
      expect(result).toBe("uploads/img.png");
    });
  });

  describe("null guards", () => {
    it("returns empty string when file_path is null and no resolver applies", () => {
      expect(resolveMediaPublicUrl({ file_path: null })).toBe("");
    });

    it("treats a full non-Cloudinary http URL as already resolved", () => {
      const external = "https://cdn.example.com/some-other-cdn/asset.jpg";
      expect(resolveMediaPublicUrl({ file_path: external })).toBe(external);
    });
  });
});

/**
 * Delivery-time transforms. Absorbed from the former `src/lib/cdn.ts` facade,
 * which built thumbnail URLs nothing ever rendered; `mediaUrl.ts` is now the
 * sole resolver so there is one place a rendition can be requested.
 */
describe("transformMediaUrl", () => {
  const thumb = { width: 300, format: "auto" } as const;

  it("returns the URL untouched when there is nothing to ask for", () => {
    const url = "https://res.cloudinary.com/dur1soa8n/image/upload/v1/a.png";
    expect(transformMediaUrl(url)).toBe(url);
    expect(transformMediaUrl(url, {})).toBe(url);
    expect(transformMediaUrl("", thumb)).toBe("");
  });

  // One table per delivery grammar: same call shape, different provider, so the
  // interesting content is the input/expected pair rather than five test bodies.
  it.each([
    [
      "inserts the transform after Cloudinary's /upload/ segment",
      "https://res.cloudinary.com/dur1soa8n/image/upload/v1781951136/media/logo.png",
      "https://res.cloudinary.com/dur1soa8n/image/upload/w_300,f_auto/v1781951136/media/logo.png",
    ],
    [
      // Transcoding a video to serve a still costs far more than the poster
      // frame the browser already fetches, so video renditions are never rewritten.
      "leaves a Cloudinary video rendition alone",
      "https://res.cloudinary.com/dur1soa8n/video/upload/v1781356757/media/clip.mp4",
      "https://res.cloudinary.com/dur1soa8n/video/upload/v1781356757/media/clip.mp4",
    ],
    [
      "replaces an existing Openinary transform segment rather than stacking onto it",
      "https://cdn.example.com/t/q_auto,f_auto/postora.cloud/logo2.png",
      "https://cdn.example.com/t/w_300,f_auto/postora.cloud/logo2.png",
    ],
    [
      "adds a transform segment to an Openinary URL that has none",
      "https://cdn.example.com/t/postora.cloud/logo2.png",
      "https://cdn.example.com/t/w_300,f_auto/postora.cloud/logo2.png",
    ],
    [
      // Supabase Storage object URLs have no transform grammar; silently
      // mangling one would 404 the image rather than shrink it.
      "passes through a provider with no transform grammar",
      "https://example.supabase.co/storage/v1/object/public/media/uploads/img.png",
      "https://example.supabase.co/storage/v1/object/public/media/uploads/img.png",
    ],
  ])("%s", (_label, input, expected) => {
    expect(transformMediaUrl(input, thumb)).toBe(expected);
  });

  it("stays idempotent when a transformed URL is transformed again", () => {
    expect(transformMediaUrl(transformMediaUrl("https://cdn.example.com/t/w_20/a/b.png", thumb), thumb)).toBe(
      "https://cdn.example.com/t/w_300,f_auto/a/b.png",
    );
  });

  it("builds a square thumbnail rendition", () => {
    expect(getMediaThumbnailUrl("https://cdn.example.com/t/postora.cloud/a.png", 80)).toBe(
      "https://cdn.example.com/t/w_80,c_fill,q_auto,f_auto/postora.cloud/a.png",
    );
  });

  it("applies the transform to the URL the resolver selected", () => {
    expect(
      resolveMediaPublicUrl(
        { file_path: "legacy.png" },
        undefined,
        [{ provider: "openinary", status: "ready", delivery_url: "https://cdn.example.com/t/a/b.png" }],
        { read_preference: "openinary" },
        thumb,
      ),
    ).toBe("https://cdn.example.com/t/w_300,f_auto/a/b.png");
  });

  it("leaves every existing call site unchanged when no transform is passed", () => {
    const row = { file_path: "https://res.cloudinary.com/dur1soa8n/image/upload/v1/a.png", storage_bucket: "cloudinary" };
    expect(resolveMediaPublicUrl(row)).toBe(row.file_path);
  });
});
