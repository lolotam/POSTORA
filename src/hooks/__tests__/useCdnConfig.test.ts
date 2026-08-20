import { describe, expect, it } from "vitest";
import { DEFAULT_CDN_STORAGE_CONFIG } from "../useCdnConfig";

describe("useCdnConfig", () => {
  it("defines the Cloudinary-only compatibility default", () => {
    expect(DEFAULT_CDN_STORAGE_CONFIG).toEqual({
      write_policy: { providers: ["cloudinary"], required: ["cloudinary"] },
      read_preference: "cloudinary",
    });
  });
});
