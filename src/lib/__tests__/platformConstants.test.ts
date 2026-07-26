import { describe, it, expect } from "vitest";
import {
  allPlatforms,
  availablePlatforms,
  isPlatformType,
  platformCharLimits,
  platformWarnings,
  TIKTOK_PHOTO_WARNING,
  MEDIA_REQUIRED_PLATFORMS,
  youtubeCategories,
  tiktokPrivacyOptions,
  
  twitterReplyOptions,
} from "../platformConstants";

describe("platformConstants", () => {
  describe("allPlatforms", () => {
    it("should include all expected platforms", () => {
      const platformNames = allPlatforms.map((p) => p.platform);
      expect(platformNames).toContain("tiktok");
      expect(platformNames).toContain("instagram");
      expect(platformNames).toContain("facebook");
      expect(platformNames).toContain("youtube");
      expect(platformNames).toContain("twitter");
      expect(platformNames).toContain("linkedin");
      expect(platformNames).toContain("pinterest");
    });

    it("should have proper structure for each platform", () => {
      allPlatforms.forEach((platform) => {
        expect(platform).toHaveProperty("platform");
        expect(platform).toHaveProperty("name");
        expect(platform).toHaveProperty("available");
        expect(typeof platform.name).toBe("string");
        expect(typeof platform.available).toBe("boolean");
      });
    });
  });

  describe("availablePlatforms", () => {
    it("should only contain available platforms", () => {
      availablePlatforms.forEach((platform) => {
        expect(platform.available).toBe(true);
      });
    });

    it("should be a subset of allPlatforms", () => {
      expect(availablePlatforms.length).toBeLessThanOrEqual(allPlatforms.length);
    });
  });

  describe("isPlatformType", () => {
    it("should return true for core platforms", () => {
      expect(isPlatformType("facebook")).toBe(true);
      expect(isPlatformType("instagram")).toBe(true);
      expect(isPlatformType("tiktok")).toBe(true);
      expect(isPlatformType("twitter")).toBe(true);
      expect(isPlatformType("linkedin")).toBe(true);
      expect(isPlatformType("pinterest")).toBe(true);
      expect(isPlatformType("youtube")).toBe(true);
    });

    it("recognises the platforms that were once merely 'extended'", () => {
      // Threads and Bluesky are first-class platforms now — ExtendedPlatform is a
      // straight alias of Platform, they ship in allPlatforms with available: true,
      // and they have char limits. This assertion previously expected false, which
      // stopped being true when Threads posting shipped.
      expect(isPlatformType("threads")).toBe(true);
      expect(isPlatformType("bluesky")).toBe(true);
    });
  });

  describe("platformCharLimits", () => {
    it("should have limits for all core platforms", () => {
      expect(platformCharLimits.instagram).toBe(2200);
      expect(platformCharLimits.facebook).toBe(63206);
      expect(platformCharLimits.tiktok).toBe(4000);
      expect(platformCharLimits.twitter).toBe(280);
      expect(platformCharLimits.linkedin).toBe(3000);
      expect(platformCharLimits.pinterest).toBe(500);
      expect(platformCharLimits.youtube).toBe(5000);
    });

    it("should have positive number limits", () => {
      Object.values(platformCharLimits).forEach((limit) => {
        expect(limit).toBeGreaterThan(0);
        expect(Number.isInteger(limit)).toBe(true);
      });
    });
  });

  describe("MEDIA_REQUIRED_PLATFORMS", () => {
    it("should include platforms that require media", () => {
      expect(MEDIA_REQUIRED_PLATFORMS).toContain("instagram");
      expect(MEDIA_REQUIRED_PLATFORMS).toContain("tiktok");
      expect(MEDIA_REQUIRED_PLATFORMS).toContain("pinterest");
      expect(MEDIA_REQUIRED_PLATFORMS).toContain("youtube");
    });

    it("should not include text-only capable platforms", () => {
      expect(MEDIA_REQUIRED_PLATFORMS).not.toContain("twitter");
      expect(MEDIA_REQUIRED_PLATFORMS).not.toContain("facebook");
      expect(MEDIA_REQUIRED_PLATFORMS).not.toContain("linkedin");
    });
  });

  describe("platformWarnings", () => {
    it("should have warning for Pinterest", () => {
      expect(platformWarnings.pinterest).toBeDefined();
      expect(platformWarnings.pinterest?.title).toBeDefined();
      expect(platformWarnings.pinterest?.message).toBeDefined();
    });
  });

  describe("TIKTOK_PHOTO_WARNING", () => {
    it("should have title and message", () => {
      expect(TIKTOK_PHOTO_WARNING.title).toBeDefined();
      expect(TIKTOK_PHOTO_WARNING.message).toBeDefined();
      expect(typeof TIKTOK_PHOTO_WARNING.title).toBe("string");
      expect(typeof TIKTOK_PHOTO_WARNING.message).toBe("string");
    });
  });

  describe("youtubeCategories", () => {
    it("should have multiple categories", () => {
      expect(youtubeCategories.length).toBeGreaterThan(10);
    });

    it("should have proper structure", () => {
      youtubeCategories.forEach((category) => {
        expect(category).toHaveProperty("id");
        expect(category).toHaveProperty("name");
        expect(typeof category.id).toBe("string");
        expect(typeof category.name).toBe("string");
      });
    });

    it("should include common categories", () => {
      const names = youtubeCategories.map((c) => c.name);
      expect(names).toContain("Music");
      expect(names).toContain("Gaming");
      expect(names).toContain("Education");
    });
  });

  describe("tiktokPrivacyOptions", () => {
    it("should have expected privacy levels", () => {
      const values = tiktokPrivacyOptions.map((o) => o.value);
      expect(values).toContain("PUBLIC_TO_EVERYONE");
      expect(values).toContain("SELF_ONLY");
    });

    it("should have proper structure", () => {
      tiktokPrivacyOptions.forEach((option) => {
        expect(option).toHaveProperty("value");
        expect(option).toHaveProperty("label");
      });
    });
  });


  describe("twitterReplyOptions", () => {
    it("should have expected reply settings", () => {
      const values = twitterReplyOptions.map((o) => o.value);
      expect(values).toContain("everyone");
      expect(values).toContain("following");
      expect(values).toContain("mentioned");
    });
  });
});
