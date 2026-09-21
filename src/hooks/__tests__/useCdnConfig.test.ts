import { describe, expect, it } from "vitest";
import { DEFAULT_CDN_STORAGE_CONFIG } from "../useCdnConfig";

describe("useCdnConfig", () => {
  // This default is what the app uses when the `cdn_storage` setting is missing
  // or unreadable, so it decides where media goes on a bad day. It named
  // Cloudinary until 2026-09-21: that account is disabled and answers 401, so a
  // transient settings error silently reinstated a provider the admin had
  // turned off and marked it required, which failed every upload as partial.
  it("falls back to Openinary, never to the retired Cloudinary account", () => {
    expect(DEFAULT_CDN_STORAGE_CONFIG).toEqual({
      write_policy: { providers: ["openinary"], required: ["openinary"] },
      read_preference: "openinary",
    });
  });
});
